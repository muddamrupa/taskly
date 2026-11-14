#!/usr/bin/env python3
"""Taskly backend.

Dependency-free HTTP + SQLite server providing:
  - email/password registration and sign-in
  - scrypt password hashing (never stores plain text)
  - HttpOnly cookie sessions that survive refreshes
  - per-user task/history storage with server-side isolation
  - team workspaces with shared tasks, invitations, and member roles

Run:
    python server.py
Then open http://127.0.0.1:8000/

Environment variables:
    TASKLY_HOST              bind address (default 127.0.0.1)
    TASKLY_PORT              port (default 8000)
    TASKLY_DB                database path (default ./taskly.db)
    TASKLY_SECURE            "1" to mark the session cookie Secure (HTTPS only)
    TASKLY_ORIGIN            optional extra allowed Origin, e.g. https://tasks.example.com
"""

import base64
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("TASKLY_DB", os.path.join(BASE_DIR, "taskly.db"))
HOST = os.environ.get("TASKLY_HOST", "127.0.0.1")
PORT = int(os.environ.get("TASKLY_PORT", "8000"))
COOKIE_SECURE = os.environ.get("TASKLY_SECURE", "0") == "1"
EXTRA_ORIGIN = os.environ.get("TASKLY_ORIGIN", "").strip().rstrip("/")

SESSION_COOKIE = "taskly_session"
SESSION_TTL = 30 * 24 * 60 * 60  # 30 days

SCRYPT_N = 2 ** 14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 32
SCRYPT_MAXMEM = 64 * 1024 * 1024

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,100}$")

MAX_BODY = 2 * 1024 * 1024
MAX_TASKS = 5000
MAX_HISTORY = 5000
MAX_UPDATES = 500

MAX_TEAM_MEMBERS = 100
MAX_TEAMS_PER_USER = 20

PRIORITIES = {"low", "medium", "high"}

# Optional AI provider. When no key is configured (or the provider fails),
# Taskly falls back to the built-in on-device recommendation engine.
AI_API_KEY = os.environ.get("TASKLY_AI_API_KEY", "").strip()
AI_BASE_URL = os.environ.get("TASKLY_AI_BASE_URL", "https://api.openai.com/v1").strip().rstrip("/")
AI_MODEL = os.environ.get("TASKLY_AI_MODEL", "gpt-4o-mini").strip()
try:
    AI_TIMEOUT = float(os.environ.get("TASKLY_AI_TIMEOUT", "15"))
except ValueError:
    AI_TIMEOUT = 15.0
AI_DISABLED = os.environ.get("TASKLY_AI_DISABLE", "0") == "1"
AI_ENABLED = bool(AI_API_KEY) and not AI_DISABLED

AI_WINDOW_SECONDS = 60
AI_MAX_REQUESTS = 12
_ai_requests = {}
_ai_lock = threading.Lock()

AUTH_WINDOW_SECONDS = 300
AUTH_MAX_ATTEMPTS = 25
_auth_attempts = {}
_auth_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

def db_connect():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db():
    conn = db_connect()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id            TEXT PRIMARY KEY,
                email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                created_at    INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);

            CREATE TABLE IF NOT EXISTS tasks (
                user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                id          TEXT NOT NULL,
                text        TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                done        INTEGER NOT NULL DEFAULT 0,
                priority    TEXT NOT NULL DEFAULT 'medium',
                due         TEXT,
                due_time    TEXT,
                progress    INTEGER NOT NULL DEFAULT 0,
                assignee    TEXT NOT NULL DEFAULT '',
                position    INTEGER NOT NULL DEFAULT 0,
                created_at  INTEGER NOT NULL,
                PRIMARY KEY (user_id, id)
            );

            CREATE TABLE IF NOT EXISTS task_updates (
                user_id    TEXT NOT NULL,
                task_id    TEXT NOT NULL,
                id         TEXT NOT NULL,
                text       TEXT NOT NULL DEFAULT '',
                progress   INTEGER NOT NULL DEFAULT 0,
                system     INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (user_id, task_id, id),
                FOREIGN KEY (user_id, task_id)
                    REFERENCES tasks(user_id, id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS history (
                user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                id           TEXT NOT NULL,
                task_id      TEXT,
                text         TEXT NOT NULL,
                description  TEXT NOT NULL DEFAULT '',
                priority     TEXT NOT NULL DEFAULT 'medium',
                due          TEXT,
                due_time     TEXT,
                progress     INTEGER NOT NULL DEFAULT 100,
                assignee     TEXT NOT NULL DEFAULT '',
                archived     INTEGER NOT NULL DEFAULT 0,
                completed_at INTEGER NOT NULL,
                PRIMARY KEY (user_id, id)
            );

            CREATE TABLE IF NOT EXISTS history_updates (
                user_id    TEXT NOT NULL,
                history_id TEXT NOT NULL,
                id         TEXT NOT NULL,
                text       TEXT NOT NULL DEFAULT '',
                progress   INTEGER NOT NULL DEFAULT 0,
                system     INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (user_id, history_id, id),
                FOREIGN KEY (user_id, history_id)
                    REFERENCES history(user_id, id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS tasks_user_position
                ON tasks(user_id, position);
            CREATE INDEX IF NOT EXISTS history_user_completed
                ON history(user_id, completed_at DESC);

            CREATE TABLE IF NOT EXISTS teams (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS team_members (
                team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
                user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role      TEXT NOT NULL DEFAULT 'member',
                joined_at INTEGER NOT NULL,
                PRIMARY KEY (team_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS team_invites (
                id         TEXT PRIMARY KEY,
                team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
                invitee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                status     TEXT NOT NULL DEFAULT 'pending',
                created_at INTEGER NOT NULL,
                responded_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS team_tasks (
                team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
                id          TEXT NOT NULL,
                text        TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                done        INTEGER NOT NULL DEFAULT 0,
                priority    TEXT NOT NULL DEFAULT 'medium',
                due         TEXT,
                due_time    TEXT,
                progress    INTEGER NOT NULL DEFAULT 0,
                assignee    TEXT NOT NULL DEFAULT '',
                position    INTEGER NOT NULL DEFAULT 0,
                created_at  INTEGER NOT NULL,
                PRIMARY KEY (team_id, id)
            );

            CREATE TABLE IF NOT EXISTS team_task_updates (
                team_id    TEXT NOT NULL,
                task_id    TEXT NOT NULL,
                id         TEXT NOT NULL,
                text       TEXT NOT NULL DEFAULT '',
                progress   INTEGER NOT NULL DEFAULT 0,
                system     INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (team_id, task_id, id),
                FOREIGN KEY (team_id, task_id)
                    REFERENCES team_tasks(team_id, id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS team_history (
                team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
                id           TEXT NOT NULL,
                task_id      TEXT,
                text         TEXT NOT NULL,
                description  TEXT NOT NULL DEFAULT '',
                priority     TEXT NOT NULL DEFAULT 'medium',
                due          TEXT,
                due_time     TEXT,
                progress     INTEGER NOT NULL DEFAULT 100,
                assignee     TEXT NOT NULL DEFAULT '',
                archived     INTEGER NOT NULL DEFAULT 0,
                completed_at INTEGER NOT NULL,
                PRIMARY KEY (team_id, id)
            );

            CREATE TABLE IF NOT EXISTS team_history_updates (
                team_id    TEXT NOT NULL,
                history_id TEXT NOT NULL,
                id         TEXT NOT NULL,
                text       TEXT NOT NULL DEFAULT '',
                progress   INTEGER NOT NULL DEFAULT 0,
                system     INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (team_id, history_id, id),
                FOREIGN KEY (team_id, history_id)
                    REFERENCES team_history(team_id, id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS team_tasks_position
                ON team_tasks(team_id, position);
            CREATE INDEX IF NOT EXISTS team_history_completed
                ON team_history(team_id, completed_at DESC);
            CREATE INDEX IF NOT EXISTS team_invites_invitee
                ON team_invites(invitee_id, status);
            """
        )
        # Add columns introduced after the first release so existing
        # databases keep working without a manual migration.
        for table, column, definition in (
            ("tasks", "assignee", "TEXT NOT NULL DEFAULT ''"),
            ("history", "assignee", "TEXT NOT NULL DEFAULT ''"),
        ):
            columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
            if column not in columns:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Password + session helpers
# ---------------------------------------------------------------------------

def _b64encode(value):
    return base64.b64encode(value).decode("ascii")


def _b64decode(value):
    return base64.b64decode(value.encode("ascii"), validate=True)


def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=SCRYPT_DKLEN,
        maxmem=SCRYPT_MAXMEM,
    )
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64encode(salt)}${_b64encode(digest)}"


def verify_password(stored, password):
    try:
        scheme, n, r, p, salt_b64, digest_b64 = stored.split("$")
        if scheme != "scrypt":
            return False
        salt = _b64decode(salt_b64)
        expected = _b64decode(digest_b64)
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(expected),
            maxmem=SCRYPT_MAXMEM,
        )
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


# A fixed hash used to keep login timing similar for unknown accounts.
_DUMMY_HASH = hash_password("taskly-dummy-password-1")


def token_hash(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(conn, user_id):
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        (token_hash(token), user_id, now, now + SESSION_TTL),
    )
    conn.commit()
    return token


def session_user(conn, token):
    if not token:
        return None
    now = int(time.time())
    row = conn.execute(
        """
        SELECT u.id, u.email, u.created_at, s.expires_at
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?
        """,
        (token_hash(token),),
    ).fetchone()
    if not row or row["expires_at"] <= now:
        if row:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))
            conn.commit()
        return None
    return row


# ---------------------------------------------------------------------------
# Validation / sanitising
# ---------------------------------------------------------------------------

def normalize_email(value):
    return (value or "").strip().lower()


def valid_email(email):
    return bool(email) and len(email) <= 254 and bool(EMAIL_RE.match(email))


def password_error(password):
    if not isinstance(password, str):
        return "Enter a password."
    if len(password) < 8:
        return "Password must be at least 8 characters."
    if len(password) > 128:
        return "Password must be 128 characters or fewer."
    if not re.search(r"[A-Za-z]", password) or not re.search(r"\d", password):
        return "Password must include at least one letter and one number."
    return None


def clean_int(value, default=0, minimum=None, maximum=None):
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    if minimum is not None:
        number = max(minimum, number)
    if maximum is not None:
        number = min(maximum, number)
    return number


def clean_text(value, limit):
    if not isinstance(value, str):
        return ""
    return value.strip()[:limit]


def clean_due(value):
    if not isinstance(value, str) or not DATE_RE.match(value):
        return None
    try:
        time.strptime(value, "%Y-%m-%d")
    except ValueError:
        return None
    return value


def clean_time(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if TIME_RE.match(value) else None


def safe_id(value):
    if isinstance(value, str) and ID_RE.match(value):
        return value
    return secrets.token_hex(16)


def sanitize_updates(value):
    if not isinstance(value, list):
        return []
    updates = []
    for item in value[:MAX_UPDATES]:
        if not isinstance(item, dict):
            continue
        updates.append(
            {
                "id": safe_id(item.get("id")),
                "text": clean_text(item.get("text"), 500),
                "progress": clean_int(item.get("progress"), 0, 0, 100),
                "createdAt": clean_int(item.get("createdAt"), int(time.time() * 1000)),
                "system": bool(item.get("system")),
            }
        )
    updates.sort(key=lambda entry: entry["createdAt"])
    return updates


def sanitize_task(item, position):
    if not isinstance(item, dict):
        return None
    text = clean_text(item.get("text"), 200)
    if not text:
        return None
    done = bool(item.get("done"))
    priority = item.get("priority")
    progress = 100 if done else clean_int(item.get("progress"), 0, 0, 100)
    return {
        "id": safe_id(item.get("id")),
        "text": text,
        "description": clean_text(item.get("description"), 1000),
        "done": done,
        "priority": priority if priority in PRIORITIES else "medium",
        "due": clean_due(item.get("due")),
        "dueTime": clean_time(item.get("dueTime")),
        "progress": progress,
        "assignee": clean_text(item.get("assignee"), 60),
        "updates": sanitize_updates(item.get("updates")),
        "createdAt": clean_int(item.get("createdAt"), int(time.time() * 1000)),
        "position": position,
    }


def sanitize_history(item):
    if not isinstance(item, dict):
        return None
    text = clean_text(item.get("text"), 200)
    if not text:
        return None
    priority = item.get("priority")
    task_id = item.get("taskId")
    return {
        "id": safe_id(item.get("id")),
        "taskId": task_id if isinstance(task_id, str) and ID_RE.match(task_id) else None,
        "text": text,
        "description": clean_text(item.get("description"), 1000),
        "priority": priority if priority in PRIORITIES else "medium",
        "due": clean_due(item.get("due")),
        "dueTime": clean_time(item.get("dueTime")),
        "progress": clean_int(item.get("progress"), 100, 0, 100),
        "assignee": clean_text(item.get("assignee"), 60),
        "updates": sanitize_updates(item.get("updates")),
        "archived": bool(item.get("archived")),
        "completedAt": clean_int(item.get("completedAt"), int(time.time() * 1000)),
    }


# ---------------------------------------------------------------------------
# State read/write
# ---------------------------------------------------------------------------

# Each workspace stores tasks/history in its own tables, keyed by either
# user_id (personal) or team_id (team). This keeps personal and team data
# fully isolated at the schema level.
WORKSPACE_TABLES = {
    "personal": {
        "key": "user_id",
        "tasks": "tasks",
        "task_updates": "task_updates",
        "history": "history",
        "history_updates": "history_updates",
    },
    "team": {
        "key": "team_id",
        "tasks": "team_tasks",
        "task_updates": "team_task_updates",
        "history": "team_history",
        "history_updates": "team_history_updates",
    },
}


def load_state(conn, key_id, workspace="personal"):
    spec = WORKSPACE_TABLES[workspace]
    key_col = spec["key"]

    tasks = []
    task_rows = conn.execute(
        f"SELECT * FROM {spec['tasks']} WHERE {key_col} = ? ORDER BY position ASC, created_at ASC",
        (key_id,),
    ).fetchall()
    update_rows = conn.execute(
        f"SELECT * FROM {spec['task_updates']} WHERE {key_col} = ? ORDER BY created_at ASC",
        (key_id,),
    ).fetchall()
    updates_by_task = {}
    for row in update_rows:
        updates_by_task.setdefault(row["task_id"], []).append(
            {
                "id": row["id"],
                "text": row["text"],
                "progress": row["progress"],
                "createdAt": row["created_at"],
                "system": bool(row["system"]),
            }
        )

    for row in task_rows:
        tasks.append(
            {
                "id": row["id"],
                "text": row["text"],
                "description": row["description"],
                "done": bool(row["done"]),
                "priority": row["priority"],
                "due": row["due"],
                "dueTime": row["due_time"],
                "progress": row["progress"],
                "assignee": row["assignee"],
                "updates": updates_by_task.get(row["id"], []),
                "createdAt": row["created_at"],
            }
        )

    history = []
    history_rows = conn.execute(
        f"SELECT * FROM {spec['history']} WHERE {key_col} = ? ORDER BY completed_at DESC",
        (key_id,),
    ).fetchall()
    history_updates = conn.execute(
        f"SELECT * FROM {spec['history_updates']} WHERE {key_col} = ? ORDER BY created_at ASC",
        (key_id,),
    ).fetchall()
    updates_by_history = {}
    for row in history_updates:
        updates_by_history.setdefault(row["history_id"], []).append(
            {
                "id": row["id"],
                "text": row["text"],
                "progress": row["progress"],
                "createdAt": row["created_at"],
                "system": bool(row["system"]),
            }
        )

    for row in history_rows:
        history.append(
            {
                "id": row["id"],
                "taskId": row["task_id"],
                "text": row["text"],
                "description": row["description"],
                "priority": row["priority"],
                "due": row["due"],
                "dueTime": row["due_time"],
                "progress": row["progress"],
                "assignee": row["assignee"],
                "updates": updates_by_history.get(row["id"], []),
                "archived": bool(row["archived"]),
                "completedAt": row["completed_at"],
            }
        )

    return {"tasks": tasks, "history": history}


def save_state(conn, key_id, payload, workspace="personal"):
    spec = WORKSPACE_TABLES[workspace]
    key_col = spec["key"]
    raw_tasks = payload.get("tasks")
    raw_history = payload.get("history")
    if not isinstance(raw_tasks, list) or not isinstance(raw_history, list):
        raise ValueError("tasks and history must be arrays")
    if len(raw_tasks) > MAX_TASKS or len(raw_history) > MAX_HISTORY:
        raise ValueError("too many items")

    tasks = []
    for position, item in enumerate(raw_tasks):
        task = sanitize_task(item, position)
        if task:
            tasks.append(task)

    history = []
    seen_history = set()
    for item in raw_history:
        entry = sanitize_history(item)
        if not entry or entry["id"] in seen_history:
            continue
        seen_history.add(entry["id"])
        history.append(entry)

    with conn:
        conn.execute(f"DELETE FROM {spec['task_updates']} WHERE {key_col} = ?", (key_id,))
        conn.execute(f"DELETE FROM {spec['tasks']} WHERE {key_col} = ?", (key_id,))
        conn.execute(f"DELETE FROM {spec['history_updates']} WHERE {key_col} = ?", (key_id,))
        conn.execute(f"DELETE FROM {spec['history']} WHERE {key_col} = ?", (key_id,))

        for task in tasks:
            conn.execute(
                f"""
                INSERT INTO {spec['tasks']}
                    ({key_col}, id, text, description, done, priority, due,
                     due_time, progress, assignee, position, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    key_id,
                    task["id"],
                    task["text"],
                    task["description"],
                    1 if task["done"] else 0,
                    task["priority"],
                    task["due"],
                    task["dueTime"],
                    task["progress"],
                    task["assignee"],
                    task["position"],
                    task["createdAt"],
                ),
            )
            for update in task["updates"]:
                conn.execute(
                    f"""
                    INSERT OR REPLACE INTO {spec['task_updates']}
                        ({key_col}, task_id, id, text, progress, system, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        key_id,
                        task["id"],
                        update["id"],
                        update["text"],
                        update["progress"],
                        1 if update["system"] else 0,
                        update["createdAt"],
                    ),
                )

        for entry in history:
            conn.execute(
                f"""
                INSERT INTO {spec['history']}
                    ({key_col}, id, task_id, text, description, priority, due,
                     due_time, progress, assignee, archived, completed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    key_id,
                    entry["id"],
                    entry["taskId"],
                    entry["text"],
                    entry["description"],
                    entry["priority"],
                    entry["due"],
                    entry["dueTime"],
                    entry["progress"],
                    entry["assignee"],
                    1 if entry["archived"] else 0,
                    entry["completedAt"],
                ),
            )
            for update in entry["updates"]:
                conn.execute(
                    f"""
                    INSERT OR REPLACE INTO {spec['history_updates']}
                        ({key_col}, history_id, id, text, progress, system, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        key_id,
                        entry["id"],
                        update["id"],
                        update["text"],
                        update["progress"],
                        1 if update["system"] else 0,
                        update["createdAt"],
                    ),
                )

    return len(tasks), len(history)


# ---------------------------------------------------------------------------
# Team workspaces
# ---------------------------------------------------------------------------

def get_team(conn, team_id):
    if not isinstance(team_id, str) or not ID_RE.match(team_id):
        return None
    return conn.execute("SELECT * FROM teams WHERE id = ?", (team_id,)).fetchone()


def team_role(conn, team_id, user_id):
    row = conn.execute(
        "SELECT role FROM team_members WHERE team_id = ? AND user_id = ?",
        (team_id, user_id),
    ).fetchone()
    return row["role"] if row else None


def team_member_rows(conn, team_id):
    return conn.execute(
        """
        SELECT tm.user_id, tm.role, tm.joined_at, u.email
        FROM team_members tm
        JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = ?
        ORDER BY CASE tm.role WHEN 'owner' THEN 0 ELSE 1 END, tm.joined_at ASC, u.email ASC
        """,
        (team_id,),
    ).fetchall()


def member_payload(row):
    return {
        "id": row["user_id"],
        "email": row["email"],
        "role": row["role"],
        "joinedAt": row["joined_at"],
    }


def team_summary(conn, team_id):
    team = get_team(conn, team_id)
    if not team:
        return None
    members = [member_payload(row) for row in team_member_rows(conn, team_id)]
    task_count = conn.execute(
        "SELECT COUNT(*) AS count FROM team_tasks WHERE team_id = ?", (team_id,)
    ).fetchone()["count"]
    return {
        "id": team["id"],
        "name": team["name"],
        "ownerId": team["owner_id"],
        "createdAt": team["created_at"],
        "members": members,
        "taskCount": task_count,
    }


def team_pending_invites(conn, team_id):
    rows = conn.execute(
        """
        SELECT ti.id, ti.created_at, ti.invitee_id, u.email
        FROM team_invites ti
        JOIN users u ON u.id = ti.invitee_id
        WHERE ti.team_id = ? AND ti.status = 'pending'
        ORDER BY ti.created_at ASC
        """,
        (team_id,),
    ).fetchall()
    return [
        {"id": row["id"], "email": row["email"], "createdAt": row["created_at"]}
        for row in rows
    ]


def pending_invites_for(conn, user_id):
    rows = conn.execute(
        """
        SELECT ti.id, ti.created_at, ti.team_id, t.name,
               u.email AS inviter_email
        FROM team_invites ti
        JOIN teams t ON t.id = ti.team_id
        JOIN users u ON u.id = ti.invited_by
        WHERE ti.invitee_id = ? AND ti.status = 'pending'
        ORDER BY ti.created_at ASC
        """,
        (user_id,),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "teamId": row["team_id"],
            "teamName": row["name"],
            "inviterEmail": row["inviter_email"],
            "createdAt": row["created_at"],
        }
        for row in rows
    ]


def teams_overview(conn, user_id):
    rows = conn.execute(
        """
        SELECT t.id, t.name, t.owner_id, t.created_at, tm.role, tm.joined_at
        FROM teams t
        JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?
        ORDER BY tm.joined_at ASC
        """,
        (user_id,),
    ).fetchall()
    teams = []
    for row in rows:
        member_count = conn.execute(
            "SELECT COUNT(*) AS count FROM team_members WHERE team_id = ?",
            (row["id"],),
        ).fetchone()["count"]
        task_count = conn.execute(
            "SELECT COUNT(*) AS count FROM team_tasks WHERE team_id = ?",
            (row["id"],),
        ).fetchone()["count"]
        entry = {
            "id": row["id"],
            "name": row["name"],
            "ownerId": row["owner_id"],
            "role": row["role"],
            "joinedAt": row["joined_at"],
            "memberCount": member_count,
            "taskCount": task_count,
            "members": [member_payload(member) for member in team_member_rows(conn, row["id"])],
        }
        if row["role"] == "owner":
            entry["invites"] = team_pending_invites(conn, row["id"])
        teams.append(entry)
    return {"teams": teams, "invites": pending_invites_for(conn, user_id)}


def require_team_member(self, conn, user):
    """Resolve ?team=<id> to a team the user belongs to.

    Non-members (and unknown teams) get the same 404 so team existence
    is never leaked to outsiders.
    """
    team_id = self.query_param("team")
    if not team_id:
        return None
    team = get_team(conn, team_id)
    if not team or not team_role(conn, team_id, user["id"]):
        raise ApiError(404, "Team not found.", "TEAM_NOT_FOUND")
    return team


# ---------------------------------------------------------------------------
# Optional AI recommendations
# ---------------------------------------------------------------------------

SUGGESTION_CATEGORIES = {"prioritize", "followup", "subtask", "urgent", "workload"}
SUGGESTION_ACTIONS = {"add", "update", "focus"}
MAX_SUGGESTIONS = 12

AI_SYSTEM_PROMPT = (
    "You are Taskly's planning assistant. Analyze the user's tasks, deadlines, "
    "progress, and team workload, then return practical recommendations. "
    "Respond with JSON only, using a single key named 'suggestions'."
)


def parse_due_datetime(task):
    due = task.get("due")
    if not due:
        return None
    try:
        moment = datetime.strptime(due, "%Y-%m-%d")
    except (TypeError, ValueError):
        return None
    due_time = clean_time(task.get("dueTime"))
    if due_time:
        hour, minute = (int(part) for part in due_time.split(":"))
        moment = moment.replace(hour=hour, minute=minute)
    else:
        moment = moment.replace(hour=23, minute=59)
    return moment


def task_age_days(task, now):
    try:
        created_at = datetime.fromtimestamp(int(task.get("createdAt")) / 1000)
    except (TypeError, ValueError, OSError):
        return 0.0
    return max(0.0, (now - created_at).total_seconds() / 86400)


def last_update_age_days(task, now):
    updates = task.get("updates") or []
    newest = 0
    for update in updates:
        try:
            newest = max(newest, int(update.get("createdAt") or 0))
        except (TypeError, ValueError):
            continue
    if not newest:
        return None
    try:
        return max(0.0, (now - datetime.fromtimestamp(newest / 1000)).total_seconds() / 86400)
    except OSError:
        return None


def task_score(task, now):
    score = {"high": 3.0, "medium": 2.0, "low": 1.0}.get(task.get("priority"), 2.0)
    score += (100 - clean_int(task.get("progress"), 0, 0, 100)) / 40.0
    due = parse_due_datetime(task)
    if due:
        hours = (due - now).total_seconds() / 3600
        if hours < 0:
            score += 6
        elif hours <= 24:
            score += 4
        elif hours <= 72:
            score += 2
        elif hours <= 168:
            score += 1
    return score


def due_phrase(task, now):
    due = parse_due_datetime(task)
    if not due:
        return "no deadline"
    delta = due - now
    if delta.total_seconds() < 0:
        if delta.total_seconds() > -86400:
            return "overdue since earlier today"
        days = max(1, abs(delta.days))
        return f"overdue by {days} day{'s' if days != 1 else ''}"
    hours = delta.total_seconds() / 3600
    if hours <= 24:
        return "due within 24 hours"
    days = max(1, round(hours / 24))
    return f"due in {days} day{'s' if days != 1 else ''}"


def make_suggestion(
    category,
    action,
    title,
    reason,
    task_id=None,
    priority="medium",
    due=None,
    due_time=None,
    assignee="",
    changes=None,
):
    changes = changes if isinstance(changes, dict) else {}
    clean_changes = {}
    if changes.get("priority") in PRIORITIES:
        clean_changes["priority"] = changes["priority"]
    if isinstance(changes.get("assignee"), str):
        clean_changes["assignee"] = clean_text(changes.get("assignee"), 60)
    if clean_due(changes.get("due")):
        clean_changes["due"] = clean_due(changes.get("due"))
    if clean_time(changes.get("dueTime")):
        clean_changes["dueTime"] = clean_time(changes.get("dueTime"))

    return {
        "id": "sug_" + secrets.token_hex(8),
        "category": category,
        "action": action,
        "title": clean_text(title, 200),
        "reason": clean_text(reason, 400),
        "taskId": task_id if isinstance(task_id, str) and ID_RE.match(task_id) else None,
        "priority": priority if priority in PRIORITIES else "medium",
        "due": clean_due(due),
        "dueTime": clean_time(due_time),
        "assignee": clean_text(assignee, 60),
        "changes": clean_changes,
    }


def local_suggestions(tasks, now=None):
    """Deterministic, dependency-free recommendations.

    This always works, even with no AI provider configured or reachable.
    """
    now = now or datetime.now()
    active = [task for task in tasks if not task.get("done")]
    active.sort(key=lambda task: task_score(task, now), reverse=True)
    suggestions = []
    used = set()

    def category_count(category):
        return sum(1 for item in suggestions if item["category"] == category)

    # 1. Tasks that need immediate attention.
    for task in active:
        if task["id"] in used:
            continue
        due = parse_due_datetime(task)
        if not due:
            continue
        hours = (due - now).total_seconds() / 3600
        if hours >= 0 and hours > 24:
            continue

        should_raise = task.get("priority") != "high"
        assignee_note = f"; assigned to {task['assignee']}" if task.get("assignee") else ""
        suggestions.append(
            make_suggestion(
                "urgent",
                "update" if should_raise else "focus",
                task["text"],
                f"{due_phrase(task, now).capitalize()}; {task.get('progress', 0)}% complete"
                f"{assignee_note}.",
                task_id=task["id"],
                priority="high",
                changes={"priority": "high"} if should_raise else {},
            )
        )
        used.add(task["id"])
        if category_count("urgent") >= 3:
            break

    # 2. Important tasks that should be prioritized.
    for task in active:
        if task["id"] in used or task.get("priority") == "high":
            continue
        if task_score(task, now) < 4.0:
            continue
        suggestions.append(
            make_suggestion(
                "prioritize",
                "update",
                task["text"],
                f"High impact: {due_phrase(task, now)}, {task.get('progress', 0)}% complete, "
                f"{task.get('priority', 'medium')} priority. Raising it to high makes it stand out.",
                task_id=task["id"],
                priority="high",
                changes={"priority": "high"},
            )
        )
        used.add(task["id"])
        if category_count("prioritize") >= 3:
            break

    # 3. Follow-up actions for stalled tasks.
    for task in active:
        age = task_age_days(task, now)
        update_age = last_update_age_days(task, now)
        stalled = age >= 3 and (update_age is None or update_age >= 3)
        if not stalled or task.get("progress", 0) >= 100:
            continue

        if update_age is None:
            reason = f"No updates since it was created {int(age)} days ago"
        else:
            reason = f"No progress update in {int(update_age)} days"
        suggestions.append(
            make_suggestion(
                "followup",
                "add",
                f"Follow up: {task['text']}",
                f"{reason}; currently {task.get('progress', 0)}% complete. "
                "Check in with the owner and agree on the next step.",
                priority="medium",
                due=(now + timedelta(days=1)).strftime("%Y-%m-%d"),
                assignee=task.get("assignee", ""),
            )
        )
        if category_count("followup") >= 2:
            break

    # 4. Smaller subtasks for large or complex tasks.
    complex_tasks = [
        task
        for task in active
        if (
            task.get("priority") == "high"
            or len(task.get("description", "")) >= 80
            or len(task.get("text", "")) >= 55
        )
        and task.get("progress", 0) < 80
    ][:2]

    for task in complex_tasks:
        progress = clean_int(task.get("progress"), 0, 0, 100)
        if progress < 34:
            steps = [
                ("Plan the first step", "Outline the approach and define what done looks like."),
                ("Start the first milestone", "Block time and complete the first concrete piece."),
            ]
        elif progress < 67:
            steps = [
                ("Complete the next milestone", "Keep momentum on the largest remaining piece."),
                ("Review progress so far", "Check the work against the goal and adjust the plan."),
            ]
        else:
            steps = [("Finalize and review", "Polish the remaining work and verify the result.")]

        due_base = parse_due_datetime(task)
        for index, (label, hint) in enumerate(steps):
            if due_base:
                span = max(1, (due_base - now).days)
                due_date = (now + timedelta(days=max(0, span - len(steps) + index))).strftime("%Y-%m-%d")
            else:
                due_date = (now + timedelta(days=index + 1)).strftime("%Y-%m-%d")
            suggestions.append(
                make_suggestion(
                    "subtask",
                    "add",
                    f"{label}: {task['text']}",
                    f"Suggested step for a task at {progress}% progress. {hint}",
                    priority=task.get("priority", "medium"),
                    due=due_date,
                    assignee=task.get("assignee", ""),
                )
            )
            if category_count("subtask") >= 4:
                break
        if category_count("subtask") >= 4:
            break

    # 5. Recommendations to distribute team workloads.
    loads = {}
    for task in active:
        name = clean_text(task.get("assignee"), 60)
        if not name:
            continue
        entry = loads.setdefault(name, {"active": 0, "overdue": 0, "high": 0})
        entry["active"] += 1
        due = parse_due_datetime(task)
        if due and due < now:
            entry["overdue"] += 1
        if task.get("priority") == "high":
            entry["high"] += 1

    def load_weight(item):
        _name, stats = item
        return stats["active"] + stats["overdue"] * 2 + stats["high"]

    if len(loads) >= 2:
        overloaded_name, overloaded = max(loads.items(), key=load_weight)
        lightest_name, lightest = min(loads.items(), key=load_weight)
        if overloaded["active"] - lightest["active"] >= 2 and overloaded["active"] >= 3:
            movable = [
                task
                for task in active
                if clean_text(task.get("assignee"), 60) == overloaded_name
                and task["id"] not in used
                and task.get("priority") != "high"
            ]
            if movable:
                task = sorted(
                    movable,
                    key=lambda item: item.get("priority") == "medium",
                    reverse=True,
                )[0]
                overdue_note = (
                    f" ({overloaded['overdue']} overdue)" if overloaded["overdue"] else ""
                )
                suggestions.append(
                    make_suggestion(
                        "workload",
                        "update",
                        task["text"],
                        f"{overloaded_name} has {overloaded['active']} active tasks{overdue_note}, "
                        f"while {lightest_name} has {lightest['active']}. "
                        "Reassigning this task balances the team.",
                        task_id=task["id"],
                        changes={"assignee": lightest_name},
                    )
                )
                used.add(task["id"])

    unassigned = [task for task in active if not clean_text(task.get("assignee"), 60)]
    if unassigned and loads:
        lightest_name = min(loads.items(), key=lambda item: item[1]["active"])[0]
        task = unassigned[0]
        if task["id"] not in used:
            suggestions.append(
                make_suggestion(
                    "workload",
                    "update",
                    task["text"],
                    f"This task has no owner and {lightest_name} has the lightest load. "
                    "Assigning it keeps the workload visible.",
                    task_id=task["id"],
                    changes={"assignee": lightest_name},
                )
            )
            used.add(task["id"])
    elif len(unassigned) >= 3 and not loads:
        suggestions.append(
            make_suggestion(
                "workload",
                "add",
                "Assign owners to unassigned tasks",
                f"{len(unassigned)} active tasks have no assignee, so workload can't be balanced. "
                "Assign each task to a team member.",
                priority="medium",
                due=now.strftime("%Y-%m-%d"),
            )
        )

    order = {"urgent": 0, "prioritize": 1, "followup": 2, "subtask": 3, "workload": 4}
    suggestions.sort(key=lambda item: order.get(item["category"], 9))
    return suggestions[:MAX_SUGGESTIONS]


def build_ai_summary(tasks, now):
    active = [task for task in tasks if not task.get("done")]
    members = {}
    rows = []
    for task in active[:80]:
        due = parse_due_datetime(task)
        days = round((due - now).total_seconds() / 86400, 1) if due else None
        rows.append(
            {
                "id": task["id"],
                "title": task["text"],
                "description": task.get("description", "")[:300],
                "priority": task.get("priority"),
                "due": task.get("due"),
                "dueTime": task.get("dueTime"),
                "progress": task.get("progress", 0),
                "assignee": task.get("assignee", ""),
                "overdue": bool(due and due < now),
                "daysUntilDue": days,
            }
        )
        name = clean_text(task.get("assignee"), 60)
        if name:
            entry = members.setdefault(name, {"active": 0, "overdue": 0, "high": 0})
            entry["active"] += 1
            if due and due < now:
                entry["overdue"] += 1
            if task.get("priority") == "high":
                entry["high"] += 1

    return {"today": now.strftime("%Y-%m-%d"), "tasks": rows, "members": members}


def parse_ai_json(content):
    content = (content or "").strip()
    if content.startswith("```"):
        content = re.sub(r"^```[A-Za-z]*\s*", "", content)
        content = re.sub(r"\s*```$", "", content)
    return json.loads(content)


def sanitize_suggestions(raw, tasks):
    valid_ids = {task["id"] for task in tasks if not task.get("done")}
    cleaned = []
    for item in raw[:MAX_SUGGESTIONS]:
        if not isinstance(item, dict):
            continue
        category = item.get("category")
        action = item.get("action")
        if category not in SUGGESTION_CATEGORIES or action not in SUGGESTION_ACTIONS:
            continue

        task_id = item.get("taskId")
        if action in ("update", "focus"):
            if not isinstance(task_id, str) or task_id not in valid_ids:
                continue
        else:
            task_id = None

        suggestion = make_suggestion(
            category,
            action,
            item.get("title"),
            item.get("reason"),
            task_id=task_id,
            priority=item.get("priority"),
            due=item.get("due"),
            due_time=item.get("dueTime"),
            assignee=item.get("assignee"),
            changes=item.get("changes"),
        )
        if not suggestion["title"] or not suggestion["reason"]:
            continue
        if action == "update" and not suggestion["changes"]:
            continue
        cleaned.append(suggestion)
    return cleaned


def ai_suggestions(tasks):
    now = datetime.now()
    summary = build_ai_summary(tasks, now)
    user_prompt = (
        "Analyze these tasks and return recommendations. Use JSON with one key, "
        "'suggestions', containing an array. Each item must have: "
        "category (urgent|prioritize|followup|subtask|workload), "
        "action (add|update|focus), title (string, max 200 chars), "
        "reason (string, max 400 chars), taskId (an existing task id for update/focus, else null), "
        "priority (low|medium|high), due (YYYY-MM-DD or null), dueTime (HH:MM or null), "
        "assignee (string or empty), and changes (for update: priority, assignee, due, or dueTime; otherwise {}). "
        "For add suggestions, title is the new task. For update suggestions, changes must contain at least one field. "
        "For focus suggestions, taskId is required. Never invent task ids. Return at most 12 suggestions. "
        "Cover important tasks to prioritize, follow-up actions, smaller subtasks for large tasks, "
        "tasks needing immediate attention, and balanced team workloads.\n\n"
        + json.dumps(summary, ensure_ascii=False)
    )
    body = {
        "model": AI_MODEL,
        "messages": [
            {"role": "system", "content": AI_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }
    request = urllib.request.Request(
        f"{AI_BASE_URL}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {AI_API_KEY}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=AI_TIMEOUT) as response:
        data = json.loads(response.read().decode("utf-8"))
    content = data["choices"][0]["message"]["content"]
    parsed = parse_ai_json(content)
    raw = parsed.get("suggestions") if isinstance(parsed, dict) else parsed
    if not isinstance(raw, list):
        return []
    return sanitize_suggestions(raw, tasks)


def recommend(tasks):
    notice = ""
    if AI_ENABLED:
        try:
            suggestions = ai_suggestions(tasks)
            if suggestions:
                return {
                    "source": "ai",
                    "aiEnabled": True,
                    "suggestions": suggestions,
                    "notice": "",
                }
            notice = "The AI service returned no usable suggestions, so on-device analysis was used."
        except Exception:
            notice = "The AI service is unavailable right now, so on-device analysis was used."

    return {
        "source": "local",
        "aiEnabled": AI_ENABLED,
        "suggestions": local_suggestions(tasks),
        "notice": notice,
    }


def check_ai_rate_limit(user_id):
    now = time.time()
    with _ai_lock:
        stamps = [stamp for stamp in _ai_requests.get(user_id, []) if now - stamp < AI_WINDOW_SECONDS]
        if len(stamps) >= AI_MAX_REQUESTS:
            _ai_requests[user_id] = stamps
            raise ApiError(429, "Too many suggestion requests. Please wait a minute and try again.")
        stamps.append(now)
        _ai_requests[user_id] = stamps


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class ApiError(Exception):
    def __init__(self, status, message, code=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code


def user_payload(row):
    return {
        "id": row["id"],
        "email": row["email"],
        "createdAt": row["created_at"],
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "Taskly/1.0"
    protocol_version = "HTTP/1.1"

    # ----- response helpers -------------------------------------------------

    def _common_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        if getattr(self, "close_connection", False):
            self.send_header("Connection", "close")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self'; font-src 'self'; "
            "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        )

    def send_json(self, status, payload, extra_headers=None):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self._common_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for header, value in (extra_headers or []):
            self.send_header(header, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_error_json(self, status, message, code=None):
        payload = {"error": message}
        if code:
            payload["code"] = code
        self.send_json(status, payload)

    def send_static(self, filename, content_type):
        path = os.path.join(BASE_DIR, filename)
        try:
            with open(path, "rb") as handle:
                body = handle.read()
        except OSError:
            self.send_error_json(404, "Not found")
            return
        self.send_response(200)
        self._common_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_session_cookie(self, token):
        value = (
            f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; "
            f"Max-Age={SESSION_TTL}"
        )
        if COOKIE_SECURE:
            value += "; Secure"
        self.send_header("Set-Cookie", value)

    def clear_session_cookie(self):
        value = f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
        if COOKIE_SECURE:
            value += "; Secure"
        self.send_header("Set-Cookie", value)

    # ----- request helpers --------------------------------------------------

    def read_cookie_token(self):
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        cookie = SimpleCookie()
        try:
            cookie.load(raw)
        except Exception:
            return None
        morsel = cookie.get(SESSION_COOKIE)
        return morsel.value if morsel else None

    def query_param(self, name):
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        values = query.get(name, [])
        return values[0] if values else None

    def read_json(self):
        length_header = self.headers.get("Content-Length")
        if not length_header:
            raise ApiError(400, "Request body required.")
        try:
            length = int(length_header)
        except ValueError:
            self.close_connection = True
            raise ApiError(400, "Invalid request body.")
        if length <= 0:
            raise ApiError(400, "Request body required.")
        if length > MAX_BODY:
            self.close_connection = True
            raise ApiError(413, "Request body is too large.")
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(400, "Invalid JSON body.")
        if not isinstance(payload, dict):
            raise ApiError(400, "Invalid JSON body.")
        return payload

    def check_origin(self):
        origin = self.headers.get("Origin")
        if not origin:
            return
        origin = origin.rstrip("/")
        host = self.headers.get("Host", "")
        allowed = {f"http://{host}", f"https://{host}", "http://localhost", "http://127.0.0.1"}
        if EXTRA_ORIGIN:
            allowed.add(EXTRA_ORIGIN)
        if origin not in allowed:
            raise ApiError(403, "Cross-origin request blocked.")

    def check_rate_limit(self):
        client = self.client_address[0] if self.client_address else "unknown"
        now = time.time()
        with _auth_lock:
            attempts = _auth_attempts.get(client, [])
            attempts = [stamp for stamp in attempts if now - stamp < AUTH_WINDOW_SECONDS]
            if len(attempts) >= AUTH_MAX_ATTEMPTS:
                _auth_attempts[client] = attempts
                raise ApiError(429, "Too many attempts. Please wait a few minutes and try again.")
            attempts.append(now)
            _auth_attempts[client] = attempts

    def reset_rate_limit(self):
        client = self.client_address[0] if self.client_address else "unknown"
        with _auth_lock:
            _auth_attempts.pop(client, None)

    def require_session(self, conn):
        user = session_user(conn, self.read_cookie_token())
        if not user:
            raise ApiError(401, "Please sign in to continue.", "UNAUTHENTICATED")
        return user

    # ----- routing ----------------------------------------------------------

    def do_GET(self):
        self.handle_request("GET")

    def do_HEAD(self):
        self.handle_request("HEAD")

    def do_POST(self):
        self.handle_request("POST")

    def do_PUT(self):
        self.handle_request("PUT")

    def do_DELETE(self):
        self.handle_request("DELETE")

    def do_OPTIONS(self):
        self.send_response(204)
        self._common_headers()
        self.send_header("Allow", "GET, HEAD, POST, PUT, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def handle_request(self, method):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path.startswith("/api/"):
                self.handle_api(method, path)
            elif method in ("GET", "HEAD"):
                self.handle_static(path)
            else:
                raise ApiError(405, "Method not allowed.")
        except ApiError as error:
            # Any error response may have left the request body unread, which
            # would desynchronise a keep-alive connection. Close it instead.
            self.close_connection = True
            if error.status == 401:
                self.send_json(
                    401,
                    {"error": error.message, "code": error.code or "UNAUTHENTICATED"},
                    extra_headers=[("Set-Cookie", self._expired_cookie())],
                )
            else:
                self.send_error_json(error.status, error.message, error.code)
        except Exception:
            # Never leak internals to the client.
            import traceback
            traceback.print_exc()
            self.close_connection = True
            self.send_error_json(500, "Something went wrong. Please try again.")

    @staticmethod
    def _expired_cookie():
        value = f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
        if COOKIE_SECURE:
            value += "; Secure"
        return value

    def handle_static(self, path):
        if path in ("/", "/index.html"):
            self.send_static("index.html", "text/html; charset=utf-8")
            return
        files = {
            "/styles.css": ("styles.css", "text/css; charset=utf-8"),
            "/app.js": ("app.js", "text/javascript; charset=utf-8"),
            "/theme-init.js": ("theme-init.js", "text/javascript; charset=utf-8"),
        }
        if path in files:
            filename, content_type = files[path]
            self.send_static(filename, content_type)
            return
        self.send_error_json(404, "Not found")

    def handle_api(self, method, path):
        if path == "/api/auth/status" and method == "GET":
            self.auth_status()
            return
        if path == "/api/auth/register" and method == "POST":
            self.auth_register()
            return
        if path == "/api/auth/login" and method == "POST":
            self.auth_login()
            return
        if path == "/api/auth/logout" and method == "POST":
            self.auth_logout()
            return
        if path == "/api/auth/session" and method == "GET":
            self.auth_session()
            return
        if path == "/api/state":
            if method == "GET":
                self.state_get()
                return
            if method == "PUT":
                self.state_put()
                return
        if path == "/api/ai/status" and method == "GET":
            self.ai_status()
            return
        if path == "/api/ai/suggest" and method == "POST":
            self.ai_suggest()
            return
        if path == "/api/teams" and method == "GET":
            self.teams_list()
            return
        if path == "/api/teams" and method == "POST":
            self.team_create()
            return
        if path == "/api/teams/invite" and method == "POST":
            self.team_invite()
            return
        if path == "/api/teams/invites/accept" and method == "POST":
            self.invite_accept()
            return
        if path == "/api/teams/invites/decline" and method == "POST":
            self.invite_decline()
            return
        if path == "/api/teams/invites/revoke" and method == "POST":
            self.invite_revoke()
            return
        if path == "/api/teams/members/remove" and method == "POST":
            self.team_remove_member()
            return
        raise ApiError(404, "Not found")

    # ----- API endpoints ----------------------------------------------------

    def auth_status(self):
        conn = db_connect()
        try:
            row = conn.execute("SELECT COUNT(*) AS count FROM users").fetchone()
            self.send_json(200, {"hasAccounts": bool(row["count"])})
        finally:
            conn.close()

    def auth_register(self):
        self.check_origin()
        self.check_rate_limit()
        payload = self.read_json()
        email = normalize_email(payload.get("email"))
        password = payload.get("password")

        if not valid_email(email):
            raise ApiError(400, "Enter a valid email address, like you@example.com.", "INVALID_EMAIL")
        problem = password_error(password)
        if problem:
            raise ApiError(400, problem, "INVALID_PASSWORD")

        conn = db_connect()
        try:
            existing = conn.execute(
                "SELECT id FROM users WHERE email = ? COLLATE NOCASE", (email,)
            ).fetchone()
            if existing:
                raise ApiError(
                    409,
                    "An account with this email already exists. Try signing in instead.",
                    "EMAIL_TAKEN",
                )

            user_id = secrets.token_hex(16)
            created_at = int(time.time() * 1000)
            password_hash = hash_password(password)
            try:
                conn.execute(
                    "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
                    (user_id, email, password_hash, created_at),
                )
                conn.commit()
            except sqlite3.IntegrityError:
                raise ApiError(
                    409,
                    "An account with this email already exists. Try signing in instead.",
                    "EMAIL_TAKEN",
                )

            token = create_session(conn, user_id)
            user = {"id": user_id, "email": email, "createdAt": created_at}
            self.reset_rate_limit()
            body = json.dumps({"user": user}, separators=(",", ":")).encode("utf-8")
            self.send_response(201)
            self._common_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_session_cookie(token)
            self.end_headers()
            self.wfile.write(body)
        finally:
            conn.close()

    def auth_login(self):
        self.check_origin()
        self.check_rate_limit()
        payload = self.read_json()
        email = normalize_email(payload.get("email"))
        password = payload.get("password")

        if not valid_email(email) or not isinstance(password, str):
            raise ApiError(401, "Email or password is incorrect.")

        conn = db_connect()
        try:
            row = conn.execute(
                "SELECT id, email, password_hash, created_at FROM users WHERE email = ? COLLATE NOCASE",
                (email,),
            ).fetchone()

            stored_hash = row["password_hash"] if row else _DUMMY_HASH
            valid = verify_password(stored_hash, password)
            if not row or not valid:
                raise ApiError(401, "Email or password is incorrect.")

            token = create_session(conn, row["id"])
            user = user_payload(row)
            self.reset_rate_limit()
            body = json.dumps({"user": user}, separators=(",", ":")).encode("utf-8")
            self.send_response(200)
            self._common_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_session_cookie(token)
            self.end_headers()
            self.wfile.write(body)
        finally:
            conn.close()

    def auth_logout(self):
        self.check_origin()
        token = self.read_cookie_token()
        conn = db_connect()
        try:
            if token:
                conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))
                conn.commit()
            body = b'{"ok":true}'
            self.send_response(200)
            self._common_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.clear_session_cookie()
            self.end_headers()
            self.wfile.write(body)
        finally:
            conn.close()

    def auth_session(self):
        conn = db_connect()
        try:
            user = self.require_session(conn)
            self.send_json(200, {"user": user_payload(user)})
        finally:
            conn.close()

    def state_get(self):
        conn = db_connect()
        try:
            user = self.require_session(conn)
            team = require_team_member(self, conn, user)
            if team:
                state = load_state(conn, team["id"], "team")
            else:
                state = load_state(conn, user["id"], "personal")
            self.send_json(200, state)
        finally:
            conn.close()

    def state_put(self):
        self.check_origin()
        content_type = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if content_type != "application/json":
            raise ApiError(415, "Content-Type must be application/json.")
        payload = self.read_json()
        conn = db_connect()
        try:
            user = self.require_session(conn)
            team = require_team_member(self, conn, user)
            if team:
                try:
                    task_count, history_count = save_state(conn, team["id"], payload, "team")
                except ValueError as error:
                    raise ApiError(400, str(error))
            else:
                try:
                    task_count, history_count = save_state(conn, user["id"], payload, "personal")
                except ValueError as error:
                    raise ApiError(400, str(error))
            self.send_json(200, {"ok": True, "tasks": task_count, "history": history_count})
        finally:
            conn.close()

    def ai_status(self):
        self.send_json(
            200,
            {
                "enabled": AI_ENABLED,
                "mode": "ai" if AI_ENABLED else "local",
            },
        )

    def ai_suggest(self):
        self.check_origin()
        conn = db_connect()
        try:
            user = self.require_session(conn)
            self.read_json()
            check_ai_rate_limit(user["id"])
            team = require_team_member(self, conn, user)
            if team:
                state = load_state(conn, team["id"], "team")
            else:
                state = load_state(conn, user["id"], "personal")
            self.send_json(200, recommend(state["tasks"]))
        finally:
            conn.close()

    # ----- team workspaces --------------------------------------------------

    def teams_list(self):
        conn = db_connect()
        try:
            user = self.require_session(conn)
            overview = teams_overview(conn, user["id"])
            self.send_json(200, {"user": user_payload(user), **overview})
        finally:
            conn.close()

    def team_create(self):
        self.check_origin()
        payload = self.read_json()
        conn = db_connect()
        try:
            user = self.require_session(conn)
            name = clean_text(payload.get("name"), 60)
            if not name:
                raise ApiError(400, "Enter a team name.", "INVALID_NAME")

            owned = conn.execute(
                """
                SELECT COUNT(*) AS count FROM teams t
                JOIN team_members tm ON tm.team_id = t.id
                WHERE tm.user_id = ? AND tm.role = 'owner'
                """,
                (user["id"],),
            ).fetchone()["count"]
            if owned >= MAX_TEAMS_PER_USER:
                raise ApiError(409, "You already own the maximum number of teams.", "TEAM_LIMIT")

            team_id = secrets.token_hex(16)
            now = int(time.time() * 1000)
            with conn:
                conn.execute(
                    "INSERT INTO teams (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)",
                    (team_id, name, user["id"], now),
                )
                conn.execute(
                    """
                    INSERT INTO team_members (team_id, user_id, role, joined_at)
                    VALUES (?, ?, 'owner', ?)
                    """,
                    (team_id, user["id"], now),
                )
            summary = team_summary(conn, team_id)
            self.send_json(201, {"team": summary})
        finally:
            conn.close()

    def team_invite(self):
        self.check_origin()
        payload = self.read_json()
        conn = db_connect()
        try:
            user = self.require_session(conn)
            team = require_team_member(self, conn, user)
            if not team:
                raise ApiError(400, "A team id is required.", "TEAM_REQUIRED")
            if team_role(conn, team["id"], user["id"]) != "owner":
                raise ApiError(403, "Only the team owner can invite members.", "NOT_OWNER")

            email = normalize_email(payload.get("email"))
            if not valid_email(email):
                raise ApiError(400, "Enter a valid email address.", "INVALID_EMAIL")

            invitee = conn.execute(
                "SELECT id, email FROM users WHERE email = ? COLLATE NOCASE", (email,)
            ).fetchone()
            if not invitee:
                raise ApiError(
                    404,
                    "No registered account uses this email address.",
                    "UNKNOWN_USER",
                )
            if invitee["id"] == user["id"]:
                raise ApiError(400, "You are already a member of this team.", "ALREADY_MEMBER")
            if team_role(conn, team["id"], invitee["id"]):
                raise ApiError(409, "This user is already a team member.", "ALREADY_MEMBER")

            member_count = conn.execute(
                "SELECT COUNT(*) AS count FROM team_members WHERE team_id = ?",
                (team["id"],),
            ).fetchone()["count"]
            pending_count = conn.execute(
                "SELECT COUNT(*) AS count FROM team_invites WHERE team_id = ? AND status = 'pending'",
                (team["id"],),
            ).fetchone()["count"]
            if member_count + pending_count >= MAX_TEAM_MEMBERS:
                raise ApiError(409, "This team is full.", "TEAM_FULL")

            existing = conn.execute(
                """
                SELECT id FROM team_invites
                WHERE team_id = ? AND invitee_id = ? AND status = 'pending'
                """,
                (team["id"], invitee["id"]),
            ).fetchone()
            if existing:
                raise ApiError(409, "An invitation for this user is already pending.", "INVITE_PENDING")

            invite_id = secrets.token_hex(16)
            now = int(time.time() * 1000)
            with conn:
                conn.execute(
                    """
                    INSERT INTO team_invites (id, team_id, invitee_id, invited_by, status, created_at)
                    VALUES (?, ?, ?, ?, 'pending', ?)
                    """,
                    (invite_id, team["id"], invitee["id"], user["id"], now),
                )
            invites = team_pending_invites(conn, team["id"])
            self.send_json(201, {"ok": True, "invites": invites})
        finally:
            conn.close()

    def _invite_for_response(self, conn, invite_id, user_id):
        """Load a pending invite that belongs to this user (invitee or owner)."""
        row = conn.execute(
            """
            SELECT ti.*, t.owner_id AS team_owner
            FROM team_invites ti
            JOIN teams t ON t.id = ti.team_id
            WHERE ti.id = ?
            """,
            (invite_id,),
        ).fetchone()
        if not row:
            raise ApiError(404, "Invitation not found.", "INVITE_NOT_FOUND")
        if row["status"] != "pending":
            raise ApiError(409, "This invitation was already handled.", "INVITE_HANDLED")
        if user_id not in (row["invitee_id"], row["team_owner"]):
            raise ApiError(404, "Invitation not found.", "INVITE_NOT_FOUND")
        return row

    def invite_accept(self):
        self.check_origin()
        payload = self.read_json()
        conn = db_connect()
        try:
            user = self.require_session(conn)
            row = self._invite_for_response(conn, payload.get("id"), user["id"])
            if row["invitee_id"] != user["id"]:
                raise ApiError(403, "Only the invitee can accept this invitation.", "NOT_INVITEE")
            member_count = conn.execute(
                "SELECT COUNT(*) AS count FROM team_members WHERE team_id = ?",
                (row["team_id"],),
            ).fetchone()["count"]
            if member_count >= MAX_TEAM_MEMBERS:
                raise ApiError(409, "This team is full.", "TEAM_FULL")
            now = int(time.time() * 1000)
            with conn:
                conn.execute(
                    "UPDATE team_invites SET status = 'accepted', responded_at = ? WHERE id = ?",
                    (now, row["id"]),
                )
                conn.execute(
                    "INSERT OR IGNORE INTO team_members (team_id, user_id, role, joined_at) "
                    "VALUES (?, ?, 'member', ?)",
                    (row["team_id"], user["id"], now),
                )
            team = team_summary(conn, row["team_id"])
            self.send_json(200, {"ok": True, "team": team})
        finally:
            conn.close()

    def invite_decline(self):
        self.check_origin()
        payload = self.read_json()
        conn = db_connect()
        try:
            user = self.require_session(conn)
            row = self._invite_for_response(conn, payload.get("id"), user["id"])
            if row["invitee_id"] != user["id"]:
                raise ApiError(403, "Only the invitee can decline this invitation.", "NOT_INVITEE")
            now = int(time.time() * 1000)
            with conn:
                conn.execute(
                    "UPDATE team_invites SET status = 'declined', responded_at = ? WHERE id = ?",
                    (now, row["id"]),
                )
            self.send_json(200, {"ok": True})
        finally:
            conn.close()

    def invite_revoke(self):
        self.check_origin()
        payload = self.read_json()
        conn = db_connect()
        try:
            user = self.require_session(conn)
            row = self._invite_for_response(conn, payload.get("id"), user["id"])
            if row["invited_by"] != user["id"]:
                raise ApiError(403, "Only the team owner can revoke this invitation.", "NOT_OWNER")
            now = int(time.time() * 1000)
            with conn:
                conn.execute(
                    "UPDATE team_invites SET status = 'revoked', responded_at = ? WHERE id = ?",
                    (now, row["id"]),
                )
            invites = team_pending_invites(conn, row["team_id"])
            self.send_json(200, {"ok": True, "invites": invites})
        finally:
            conn.close()

    def team_remove_member(self):
        self.check_origin()
        payload = self.read_json()
        conn = db_connect()
        try:
            user = self.require_session(conn)
            team = require_team_member(self, conn, user)
            if not team:
                raise ApiError(400, "A team id is required.", "TEAM_REQUIRED")
            if team_role(conn, team["id"], user["id"]) != "owner":
                raise ApiError(403, "Only the team owner can remove members.", "NOT_OWNER")

            member_id = payload.get("userId")
            if not isinstance(member_id, str) or not ID_RE.match(member_id):
                raise ApiError(400, "A valid member id is required.", "INVALID_USER")
            if member_id == team["owner_id"]:
                raise ApiError(400, "The team owner cannot be removed.", "OWNER_IMMUTABLE")
            if not team_role(conn, team["id"], member_id):
                raise ApiError(404, "That user is not a team member.", "NOT_MEMBER")

            with conn:
                conn.execute(
                    "DELETE FROM team_members WHERE team_id = ? AND user_id = ?",
                    (team["id"], member_id),
                )
            summary = team_summary(conn, team["id"])
            self.send_json(200, {"ok": True, "team": summary})
        finally:
            conn.close()

    # ----- logging ----------------------------------------------------------

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    display_host = "127.0.0.1" if HOST in ("0.0.0.0", "::") else HOST
    print(f"Taskly running at http://{display_host}:{PORT}/")
    print(f"Database: {DB_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Taskly.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

# Taskly — To-Do List

A clean, single-page to-do app with real server-side accounts, persistent per-user tasks, and a completion history. Vanilla HTML, CSS, and JavaScript on the client; a dependency-free Python + SQLite backend.

> This project has no React/Vite/TypeScript build step. Accounts, passwords, sessions, tasks, and history live in a SQLite database on the server. The browser only stores a session cookie plus a few UI preferences.

## Features

- **Email + password accounts** with a persistent session
  - Sign up, sign in, and sign out
  - Email format and password strength are validated on both the client and the server
  - Duplicate emails are rejected (case-insensitive)
  - Passwords are hashed with scrypt and never stored or transmitted as plain text
  - Sessions use an HttpOnly cookie and survive browser refreshes
  - Each account has its own tasks, history, and filter
- **Add tasks** with a target date, an optional specific deadline time, priority (Low / Medium / High), and an assignee
- **Restore completed tasks** — completed tasks show a Restore button that reopens them at their pre-completion progress (or their last checkpoint for older entries), so an accidental completion costs nothing
  - The pre-completion progress is stored server-side, so restores work even after closing and reopening the browser
  - Restore is also available from the completion history, and simply unchecking a task returns it to its earlier progress
- **Task details panel** — open any task to see its title, description, deadline (date + time), priority, assignee, creation time, current completion percentage, and a live progress bar
  - Edit the title, description, deadline date/time, priority, assignee, and progress in one place
  - Add timestamped checkpoint/comment updates with a progress percentage
  - See the complete checkpoint history, including updates added after the task is completed
  - Delete the task directly from the panel
- **Edit task details** — change the title inline, or expand a task to update its target date, deadline time, and priority
- **Complete tasks** with a custom animated checkbox
- **Archive tasks** without completing them, or remove completed tasks from the list while keeping their history
- **Delete**, and **drag to reorder** tasks
- **Automatic categories** — every task is labelled **Pending**, **Overdue**, or **Completed**
  - The category summary and **Overdue** filter update as deadlines pass
- **Progress tracking** — an overall 0–100% completion bar and a per-task progress slider
  - Saving a checkpoint or moving the slider updates the percentage shown in the task list immediately
- **Checkpoint updates** — add timestamped comments and progress percentages to any task, including completed tasks
  - Updates are preserved in history, with the task's text, description, schedule, priority, and progress
- **Filters** for All, Active, Overdue, Done, and History
- **Automatic history** — every task you check off is archived with a completion timestamp
  - Shows a **Completed late** badge when a task is finished after its deadline
  - Time-aware lateness: minutes/hours for tasks with a deadline time, days for date-only tasks
  - Manually archived tasks appear as **Archived** and can be restored
  - View, restore, or remove individual history entries
  - "Clear completed" removes finished tasks from the list but keeps their history
  - "Clear history" uses a two-click confirmation
- **Progress bar** with completion percentage
- **Optional AI recommendations** — open **Suggest** to review planning suggestions based on your tasks, deadlines, progress, and team workload
  - Highlights tasks that need immediate attention or should be prioritized
  - Suggests follow-up actions and smaller subtasks for large tasks
  - Recommends reassigning work when one assignee is overloaded
  - Nothing changes until you accept a suggestion; **Accept all** applies the actionable ones at once
  - Uses a configured AI provider when available and falls back to a built-in on-device analysis engine otherwise, so the feature never blocks normal use
- **Team workspaces** — a second, shared workspace next to your private tasks
  - A **sidebar** switches between **My Tasks** (private) and **Team Tasks** (shared); personal and team data live in separate database tables, so nothing can leak between them
  - Create any number of team workspaces; the creator automatically becomes the **Owner**
  - The Owner invites existing Taskly accounts by email — unregistered addresses are rejected
  - Invitations are linked to account IDs, not just email strings; invitees accept or decline from the sidebar
  - Members and their roles (Owner / Member) are shown to everyone on the team
  - The Owner manages membership: invite, revoke pending invitations, and remove members (the owner cannot be removed)
  - Non-members get no team data — unknown or inaccessible teams return the same `404` so team existence is never leaked
  - Team changes sync automatically: members poll for updates every 25 seconds and the team roster refreshes every 60 seconds
- **Light / dark theme** — labeled **Light / Dark** picker in the sidebar plus a one-click sun/moon toggle in the header and sign-in card
  - Remembers your choice and respects your system preference until you pick one; the saved theme applies before the first paint, so there's no flash on load
- **Keyboard friendly** — press `/` anywhere to jump to the new-task field, `Enter` to save an edit, `Esc` to cancel
- Tasks and history save to the server automatically; the header shows when changes are saved

## Run it

Requires **Python 3.9+** (tested with Python 3.14). There are no third-party packages to install.

```powershell
python server.py
```

Then open <http://127.0.0.1:8000/>.

The first run creates `taskly.db` in the project folder. Stop the server with `Ctrl+C`.

### Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `TASKLY_HOST` | `127.0.0.1` | Bind address |
| `TASKLY_PORT` | `8000` | HTTP port |
| `TASKLY_DB` | `./taskly.db` | SQLite database file |
| `TASKLY_SECURE` | `0` | Set to `1` to mark the session cookie `Secure` (use behind HTTPS) |
| `TASKLY_ORIGIN` | — | Extra allowed `Origin`, e.g. `https://tasks.example.com` |
| `TASKLY_AI_API_KEY` | — | Optional API key for an OpenAI-compatible provider. Leave empty to use the built-in recommendation engine |
| `TASKLY_AI_BASE_URL` | `https://api.openai.com/v1` | Base URL of the AI provider's API |
| `TASKLY_AI_MODEL` | `gpt-4o-mini` | Model name sent to the provider |
| `TASKLY_AI_TIMEOUT` | `15` | Request timeout in seconds |
| `TASKLY_AI_DISABLE` | `0` | Set to `1` to force the built-in engine even if a key is configured |

### AI recommendations (optional)

Suggestions are generated on the server and are always scoped to the signed-in user. When `TASKLY_AI_API_KEY` is set, the server asks an OpenAI-compatible chat-completions endpoint for structured JSON recommendations. If the key is missing, `TASKLY_AI_DISABLE=1` is set, the provider times out, or the response cannot be used, the server automatically falls back to a deterministic built-in engine that analyzes the same tasks locally.

The response includes `source` (`"ai"` or `"local"`), `aiEnabled`, an optional `notice` explaining a fallback, and a `suggestions` array. Suggestion categories are `urgent`, `prioritize`, `followup`, `subtask`, and `workload`; actions are `add` (new task), `update` (change priority, assignee, or deadline), and `focus` (review an existing task). The client only changes tasks after the user accepts a suggestion.

Example:

```powershell
$env:TASKLY_AI_API_KEY = "sk-..."
$env:TASKLY_AI_MODEL = "gpt-4o-mini"
python server.py
```

Do not open `index.html` directly from disk. The app must be served by `server.py` so the API and session cookie are available on the same origin.

## Security model

- **Passwords** — hashed with `hashlib.scrypt` (`N=2^14, r=8, p=1`) and a random 16-byte salt. The database stores only the scrypt parameters, salt, and derived key. Plain-text passwords are never written to disk or returned by the API.
- **Sessions** — a 256-bit random token is stored in an `HttpOnly`, `SameSite=Lax`, `Max-Age=30 days` cookie. Only a SHA-256 hash of the token is stored in SQLite. Logging out deletes the session server-side and clears the cookie.
- **Isolation** — every task and history row is keyed by `(user_id, id)`, and every API query filters by the authenticated session's user ID. Team data lives in separate `team_*` tables keyed by `(team_id, id)` and is only served to team members. The server ignores any ownership fields the client sends.
- **Access control** — `GET /api/state`, `PUT /api/state`, and `POST /api/ai/suggest` return `401` without a valid session, so task data cannot be read, written, or analyzed by unauthenticated requests. Team endpoints require membership: non-members and unknown team ids get the same `404`, and only the Owner can invite, revoke, or remove members.
- **Registration** — emails are normalized to lowercase and uniqueness is enforced by the database, so the same address cannot register twice.
- **Abuse limits** — auth endpoints have a per-IP rate limit, suggestion requests have a per-user limit of 12 per minute, request bodies are capped at 2 MB, and state payloads are size/count limited.
- **Browser hardening** — responses send `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Permissions-Policy` headers. State writes require a JSON `Content-Type` and a same-origin `Origin` header when one is present.

For production, put the server behind HTTPS and set `TASKLY_SECURE=1`.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/auth/status` | Whether any account exists yet |
| `POST` | `/api/auth/register` | Create an account (`email`, `password`) |
| `POST` | `/api/auth/login` | Sign in (`email`, `password`) |
| `POST` | `/api/auth/logout` | Delete the current session |
| `GET` | `/api/auth/session` | Current user, or `401` |
| `GET` | `/api/state` | The signed-in user's `{ tasks, history }` (add `?team=<id>` for a team workspace) |
| `PUT` | `/api/state` | Replace the signed-in user's `{ tasks, history }` (add `?team=<id>` for a team workspace) |
| `GET` | `/api/ai/status` | Whether an external AI provider is configured (`enabled`, `mode`) |
| `POST` | `/api/ai/suggest` | Analyze the active workspace's tasks and return `{ source, aiEnabled, notice, suggestions }` (`?team=<id>` for team tasks) |
| `GET` | `/api/teams` | Teams the user belongs to plus pending invitations received |
| `POST` | `/api/teams` | Create a team (`name`); creator becomes Owner |
| `POST` | `/api/teams/invite?team=<id>` | Owner invites a registered user by `email` |
| `POST` | `/api/teams/invites/accept` | Invitee accepts (`id`) |
| `POST` | `/api/teams/invites/decline` | Invitee declines (`id`) |
| `POST` | `/api/teams/invites/revoke` | Owner revokes a pending invitation (`id`) |
| `POST` | `/api/teams/members/remove?team=<id>` | Owner removes a member (`userId`; cannot remove the owner) |

`POST /api/ai/suggest` requires a JSON body (send `{}`), a valid session, and is rate-limited to 12 requests per minute per user. All `/api/teams*` endpoints require a session; team state, invites, and member data are only readable by team members — anyone else (or an unknown team id) receives the same `404 TEAM_NOT_FOUND`.

## Data

SQLite tables:

| Table | Contents |
| --- | --- |
| `users` | Account ID, email, scrypt password hash, creation time |
| `sessions` | SHA-256 token hash, user ID, expiry |
| `tasks` | Per-user tasks (text, description, priority, deadline, progress, assignee, position) |
| `task_updates` | Per-user checkpoint updates for tasks |
| `history` | Per-user completed/archived entries, including assignee |
| `history_updates` | Per-user checkpoint updates for history entries |
| `teams` | Team workspaces (name, owner) |
| `team_members` | Membership rows (team, user, role `owner`/`member`, joined time) |
| `team_invites` | Invitations (team, invitee, inviter, status `pending`/`accepted`/`declined`/`revoked`) |
| `team_tasks` / `team_task_updates` / `team_history` / `team_history_updates` | Team-scoped mirrors of the personal task tables, keyed by `(team_id, id)` |

Browser storage is limited to non-sensitive UI preferences:

| Key | Contents |
| --- | --- |
| `taskly:theme` | `light` or `dark` |
| `taskly:<userId>:filter` | Last selected filter for that account |
| `taskly:<userId>:workspace` | Last workspace: `personal` or `team:<id>` |
| `taskly:last-email` | Last email used, for convenience |

Task records store a `description`, `progress` (0–100), an optional `assignee`, and an `updates` array of timestamped comments/checkpoints. History records include `description`, `progress`, `assignee`, `updates`, and an `archived` flag so archived work stays restorable.

## Migrating from the old browser-only version

Earlier versions stored accounts and tasks in `localStorage`. That data is **not** migrated automatically, because a shared browser cannot prove which local profile owns which tasks. If you want to keep old tasks:

1. Start the server and create a new account.
2. Add the old tasks again, or import them manually with a small script using the old `taskly:<userId>:tasks` JSON.

The old `taskly:users` and `taskly:session` keys are no longer read and can be deleted.

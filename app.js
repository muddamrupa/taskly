/* ---------------------------------------------------------
   Taskly — app logic
   Accounts, tasks, and completion history live on the Taskly
   server (SQLite). The browser only keeps the session cookie,
   the chosen theme, and the last email used.
   --------------------------------------------------------- */

(() => {
  "use strict";

  const THEME_KEY = "taskly:theme";
  const FILTER_KEY = "taskly:filter";
  const LAST_EMAIL_KEY = "taskly:last-email";
  const SAVE_DELAY = 250;

  const PRIORITIES = { low: "Low", medium: "Medium", high: "High" };

  const els = {
    authView: document.getElementById("authView"),
    appView: document.getElementById("appView"),
    authForm: document.getElementById("authForm"),
    authEmail: document.getElementById("authEmail"),
    authPassword: document.getElementById("authPassword"),
    authConfirm: document.getElementById("authConfirm"),
    confirmField: document.getElementById("confirmField"),
    passwordToggle: document.getElementById("passwordToggle"),
    authError: document.getElementById("authError"),
    authSubmit: document.getElementById("authSubmit"),
    authSubtitle: document.getElementById("authSubtitle"),
    authTabs: Array.from(document.querySelectorAll(".auth-tab")),
    tabSignin: document.getElementById("tabSignin"),
    tabSignup: document.getElementById("tabSignup"),
    saveStatus: document.getElementById("saveStatus"),
    userMenuBtn: document.getElementById("userMenuBtn"),
    userMenu: document.getElementById("userMenu"),
    userEmail: document.getElementById("userEmail"),
    userSince: document.getElementById("userSince"),
    userAvatar: document.getElementById("userAvatar"),
    userAvatarLarge: document.getElementById("userAvatarLarge"),
    signOutBtn: document.getElementById("signOutBtn"),
    form: document.getElementById("addForm"),
    input: document.getElementById("newTask"),
    due: document.getElementById("dueDate"),
    dueTime: document.getElementById("dueTime"),
    priority: document.getElementById("priority"),
    list: document.getElementById("taskList"),
    historySection: document.getElementById("historySection"),
    historyList: document.getElementById("historyList"),
    empty: document.getElementById("emptyState"),
    emptyTitle: document.getElementById("emptyTitle"),
    emptyText: document.getElementById("emptyText"),
    filters: Array.from(document.querySelectorAll(".filter-btn")),
    clear: document.getElementById("clearCompleted"),
    countAll: document.getElementById("countAll"),
    countActive: document.getElementById("countActive"),
    countOverdue: document.getElementById("countOverdue"),
    countCompleted: document.getElementById("countCompleted"),
    countHistory: document.getElementById("countHistory"),
    summaryPending: document.getElementById("summaryPending"),
    summaryOverdue: document.getElementById("summaryOverdue"),
    summaryCompleted: document.getElementById("summaryCompleted"),
    progressTrack: document.getElementById("progressTrack"),
    progressBar: document.getElementById("progressBar"),
    progressLabel: document.getElementById("progressLabel"),
    dateLine: document.getElementById("dateLine"),
    themeToggles: Array.from(document.querySelectorAll("[data-theme-toggle]")),
    template: document.getElementById("taskTemplate"),
    historyTemplate: document.getElementById("historyTemplate"),
    suggestionTemplate: document.getElementById("suggestionTemplate"),
    aiSuggestBtn: document.getElementById("aiSuggestBtn"),
    aiPanel: document.getElementById("aiPanel"),
    aiList: document.getElementById("aiList"),
    aiPanelStatus: document.getElementById("aiPanelStatus"),
    aiPanelNote: document.getElementById("aiPanelNote"),
    aiSourceBadge: document.getElementById("aiSourceBadge"),
    aiAcceptAll: document.getElementById("aiAcceptAll"),
    aiCloseBtn: document.getElementById("aiCloseBtn"),
    aiRefreshBtn: document.getElementById("aiRefreshBtn"),
    aiEmpty: document.getElementById("aiEmpty"),
    assigneeOptions: document.getElementById("assigneeOptions"),
    navPersonal: document.getElementById("navPersonal"),
    navTeam: document.getElementById("navTeam"),
    sidePersonalCount: document.getElementById("sidePersonalCount"),
    sideTeamCount: document.getElementById("sideTeamCount"),
    sideTeamList: document.getElementById("sideTeamList"),
    sideHint: document.getElementById("sideHint"),
    newTeamBtn: document.getElementById("newTeamBtn"),
    sideInvitesSection: document.getElementById("sideInvitesSection"),
    sideInviteList: document.getElementById("sideInviteList"),
    teamBar: document.getElementById("teamBar"),
    teamBarName: document.getElementById("teamBarName"),
    teamBarMeta: document.getElementById("teamBarMeta"),
    teamDetailsToggle: document.getElementById("teamDetailsToggle"),
    teamDetailsPanel: document.getElementById("teamDetailsPanel"),
    teamMemberList: document.getElementById("teamMemberList"),
    teamInviteForm: document.getElementById("teamInviteForm"),
    teamInviteEmail: document.getElementById("teamInviteEmail"),
    teamPendingWrap: document.getElementById("teamPendingWrap"),
    teamPendingList: document.getElementById("teamPendingList"),
    teamError: document.getElementById("teamError"),
    teamSetup: document.getElementById("teamSetup"),
    teamCreateForm: document.getElementById("teamCreateForm"),
    teamNameInput: document.getElementById("teamNameInput"),
    teamSetupError: document.getElementById("teamSetupError"),
    teamSetupInvites: document.getElementById("teamSetupInvites"),
    setupInviteList: document.getElementById("setupInviteList"),
    taskArea: document.getElementById("taskArea"),
    teamMemberTemplate: document.getElementById("teamMemberTemplate"),
    teamPendingTemplate: document.getElementById("teamPendingTemplate"),
    sideInviteTemplate: document.getElementById("sideInviteTemplate"),
    themeLight: document.getElementById("themeLight"),
    themeDark: document.getElementById("themeDark"),
  };

  /** @type {Array<{id: string, text: string, description: string, done: boolean, priority: string, due: string|null, dueTime: string|null, progress: number, updates: Array<{id: string, text: string, progress: number, createdAt: number, system: boolean}>, createdAt: number}>} */
  let tasks = [];
  /** @type {Array<{id: string, taskId: string|null, text: string, description: string, priority: string, due: string|null, dueTime: string|null, progress: number, updates: Array<{id: string, text: string, progress: number, createdAt: number, system: boolean}>, archived: boolean, completedAt: number}>} */
  let history = [];
  /** @type {{id: string, email: string, createdAt: number}|null} */
  let currentUser = null;
  let hasAccounts = false;
  let filter = "all";
  let authMode = "signin";
  let authBusy = false;
  let editingId = null;
  let expandedTaskId = null;
  let draggedId = null;
  let clearHistoryArmed = false;
  let clearHistoryTimer = null;
  let lastScheduleSignature = "";
  /** @type {Array<object>} */
  let suggestions = [];
  let aiBusy = false;
  let aiLoaded = false;
  let aiSource = "local";
  let aiNotice = "";

  /** @type {"personal"|"team"} Which workspace the task data represents. */
  let workspace = "personal";
  /** @type {string|null} Active team id while workspace === "team". */
  let activeTeamId = null;
  /** @type {Array<object>} Teams the user belongs to (server overview). */
  let teams = [];
  /** @type {Array<object>} Pending invitations received by the user. */
  let pendingInvites = [];
  /** Guards loads/saves against switching workspaces mid-flight. */
  let loadedWorkspaceKey = null;
  let teamPollTimer = null;
  let teamsRefreshTimer = null;

  const tabId = uid();
  const syncChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("taskly:sync") : null;
  let saveTimer = null;
  let saveRetryTimer = null;
  let saveInFlight = false;
  let saveQueued = false;
  let stateDirty = false;

  /* ---------------- Storage ---------------- */

  function uid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `t_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function clampProgress(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(100, Math.round(number)));
  }

  function normalizeUpdates(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        id: typeof item.id === "string" && item.id ? item.id : uid(),
        text: typeof item.text === "string" ? item.text.trim().slice(0, 500) : "",
        progress: clampProgress(item.progress),
        createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
        system: Boolean(item.system),
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  function cloneUpdates(value) {
    return normalizeUpdates(value).map((item) => ({ ...item }));
  }

  /**
   * UI preferences are namespaced per account. Task and history data
   * lives on the server, never in localStorage.
   */
  function scopedKey(name) {
    return currentUser ? `taskly:${currentUser.id}:${name}` : `taskly:${name}`;
  }

  /* ---------------- Workspaces ---------------- */

  function workspaceKey() {
    if (workspace === "team" && activeTeamId) return `team:${activeTeamId}`;
    return "personal";
  }

  function stateEndpoint() {
    return workspace === "team" && activeTeamId
      ? `/api/state?team=${encodeURIComponent(activeTeamId)}`
      : "/api/state";
  }

  function aiEndpoint() {
    return workspace === "team" && activeTeamId
      ? `/api/ai/suggest?team=${encodeURIComponent(activeTeamId)}`
      : "/api/ai/suggest";
  }

  function activeTeam() {
    return teams.find((team) => team.id === activeTeamId) || null;
  }

  function loadWorkspacePref() {
    try {
      return localStorage.getItem(workspacePrefKey()) || "personal";
    } catch (_) {
      return "personal";
    }
  }

  function persistWorkspacePref() {
    try {
      localStorage.setItem(workspacePrefKey(), workspaceKey());
    } catch (_) {
      /* ignore */
    }
  }

  function workspacePrefKey() {
    return currentUser ? `taskly:${currentUser.id}:workspace` : "taskly:workspace";
  }

  function setTeamError(message) {
    const target =
      workspace === "team" && activeTeamId ? els.teamError : els.teamSetupError;
    if (!target) return;
    if (!message) {
      target.hidden = true;
      target.textContent = "";
      return;
    }
    target.textContent = message;
    target.hidden = false;
  }

  function normalizeTasks(data) {
    try {
      if (!Array.isArray(data)) return [];
      return data
        .filter((item) => item && typeof item.text === "string" && item.text.trim())
        .map((item) => {
          const done = Boolean(item.done);
          return {
            id: typeof item.id === "string" && item.id ? item.id : uid(),
            text: item.text.trim().slice(0, 200),
            description: typeof item.description === "string" ? item.description.trim().slice(0, 1000) : "",
            done,
            priority: Object.prototype.hasOwnProperty.call(PRIORITIES, item.priority) ? item.priority : "medium",
            due: typeof item.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.due) ? item.due : null,
            dueTime: normalizeTime(item.dueTime),
            progress:
              item.progress === undefined || item.progress === null
                ? done
                  ? 100
                  : 0
                : clampProgress(item.progress),
            assignee: typeof item.assignee === "string" ? item.assignee.trim().slice(0, 60) : "",
            restorableProgress:
              Number.isFinite(item.restorableProgress) &&
              item.restorableProgress >= 0 &&
              item.restorableProgress <= 100
                ? Math.round(item.restorableProgress)
                : null,
            updates: normalizeUpdates(item.updates),
            createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
          };
        });
    } catch (_) {
      return [];
    }
  }

  function saveTasks() {
    scheduleStateSave();
  }

  function normalizeHistory(data) {
    try {
      if (!Array.isArray(data)) return [];
      return data
        .filter((item) => item && typeof item.text === "string" && item.text.trim())
        .map((item) => ({
          id: typeof item.id === "string" && item.id ? item.id : uid(),
          taskId: typeof item.taskId === "string" ? item.taskId : null,
          text: item.text.trim().slice(0, 200),
          description: typeof item.description === "string" ? item.description.trim().slice(0, 1000) : "",
          priority: Object.prototype.hasOwnProperty.call(PRIORITIES, item.priority) ? item.priority : "medium",
          due: typeof item.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.due) ? item.due : null,
          dueTime: normalizeTime(item.dueTime),
          progress:
            item.progress === undefined || item.progress === null
              ? 100
              : clampProgress(item.progress),
          assignee: typeof item.assignee === "string" ? item.assignee.trim().slice(0, 60) : "",
          updates: normalizeUpdates(item.updates),
          archived: Boolean(item.archived),
          completedAt: Number.isFinite(item.completedAt) ? item.completedAt : Date.now(),
        }));
    } catch (_) {
      return [];
    }
  }

  function saveHistory() {
    scheduleStateSave();
  }

  /* ---------------- Server API ---------------- */

  class ApiError extends Error {
    constructor(status, message, code) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code || null;
    }
  }

  async function apiRequest(path, options = {}) {
    const method = options.method || "GET";
    const hasBody = options.body !== undefined;
    let response;

    try {
      response = await fetch(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers: hasBody
          ? { Accept: "application/json", "Content-Type": "application/json" }
          : { Accept: "application/json" },
        body: hasBody ? JSON.stringify(options.body) : undefined,
      });
    } catch (_) {
      throw new ApiError(0, "Can't reach the Taskly server. Make sure it is running, then try again.");
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch (_) {
      payload = null;
    }

    if (!response.ok) {
      const message =
        payload && typeof payload.error === "string"
          ? payload.error
          : `Request failed (${response.status}).`;
      throw new ApiError(response.status, message, payload && payload.code);
    }

    return payload || {};
  }

  function setSaveStatus(state, message) {
    if (!els.saveStatus) return;
    if (!state) {
      els.saveStatus.hidden = true;
      els.saveStatus.textContent = "";
      delete els.saveStatus.dataset.state;
      return;
    }
    els.saveStatus.hidden = false;
    els.saveStatus.dataset.state = state;
    els.saveStatus.textContent = message;
  }

  function scheduleStateSave() {
    if (!currentUser) return;
    stateDirty = true;
    if (saveTimer) return;
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void flushState();
    }, SAVE_DELAY);
  }

  async function flushState() {
    if (!currentUser) return;
    if (saveInFlight) {
      saveQueued = true;
      return;
    }

    if (saveRetryTimer) {
      window.clearTimeout(saveRetryTimer);
      saveRetryTimer = null;
    }
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }

    saveInFlight = true;
    saveQueued = false;
    const userId = currentUser.id;
    const wsKey = workspaceKey();
    const endpoint = stateEndpoint();
    setSaveStatus("saving", "Saving…");
    let failed = false;

    try {
      await apiRequest(endpoint, { method: "PUT", body: { tasks, history } });
      if (currentUser && currentUser.id === userId && workspaceKey() === wsKey) {
        stateDirty = saveQueued;
        setSaveStatus("saved", "All changes saved");
        broadcastStateChange();
      }
    } catch (error) {
      if (error.status === 401) {
        handleSessionLost();
        return;
      }
      if (error.status === 404 && wsKey.startsWith("team:") && workspaceKey() === wsKey) {
        void handleTeamLost(error.message);
        return;
      }
      failed = true;
      saveQueued = false;
      stateDirty = true;
      setSaveStatus("error", error.message || "Couldn't save your changes.");
      saveRetryTimer = window.setTimeout(() => {
        saveRetryTimer = null;
        if (currentUser && workspaceKey() === wsKey) {
          saveQueued = true;
          void flushState();
        }
      }, 5000);
    } finally {
      saveInFlight = false;
      if (!failed && saveQueued && currentUser && currentUser.id === userId) {
        void flushState();
      }
    }
  }

  async function settleSaves() {
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
      stateDirty = true;
    }
    // Wait for any in-flight save so workspace switches never race a PUT.
    let guard = 0;
    while (saveInFlight && guard < 100) {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      guard += 1;
    }
    if (stateDirty && currentUser) await flushState();
  }

  function flushOnExit() {
    if (!currentUser || !stateDirty) return;
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      fetch(stateEndpoint(), {
        method: "PUT",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tasks, history }),
      });
    } catch (_) {
      /* ignore */
    }
  }

  function broadcastStateChange() {
    if (!syncChannel) return;
    try {
      syncChannel.postMessage({ type: "state", tabId });
    } catch (_) {
      /* ignore */
    }
  }

  function broadcastTeamsChange() {
    if (!syncChannel) return;
    try {
      syncChannel.postMessage({ type: "teams", tabId });
    } catch (_) {
      /* ignore */
    }
  }

  async function refreshStateFromServer() {
    if (!currentUser) return;
    const wsKey = workspaceKey();
    try {
      const state = await apiRequest(stateEndpoint());
      if (!currentUser || workspaceKey() !== wsKey) return;
      applyState(state);
      reconcileHistory();
      render();
    } catch (error) {
      if (error.status === 401) handleSessionLost();
      else if (error.status === 404 && wsKey.startsWith("team:")) void handleTeamLost(error.message);
    }
  }

  async function switchWorkspace(next, teamId = null) {
    if (!currentUser) return;
    const target = next === "team" ? "team" : "personal";
    const targetTeamId = target === "team" ? teamId || null : null;
    if (target === workspace && String(targetTeamId) === String(activeTeamId)) return;

    // Close anything tied to the old workspace.
    if (!els.aiPanel.hidden) setAiPanelOpen(false);
    expandedTaskId = null;
    editingId = null;
    draggedId = null;
    suggestions = [];
    aiLoaded = false;
    aiSource = "local";
    aiNotice = "";
    setAiStatus("");
    renderAiPanel();
    disarmClearHistory();
    if (saveRetryTimer) {
      window.clearTimeout(saveRetryTimer);
      saveRetryTimer = null;
    }

    await settleSaves();

    workspace = target;
    activeTeamId = targetTeamId;
    tasks = [];
    history = [];
    loadedWorkspaceKey = null;
    stateDirty = false;
    saveQueued = false;
    lastScheduleSignature = "";
    persistWorkspacePref();
    setSaveStatus(null);
    updateWorkspaceChrome();
    render();

    await loadWorkspaceState();
  }

  async function loadWorkspaceState() {
    if (!currentUser) return;
    if (workspace === "team" && !activeTeamId) return; // setup view, nothing to load
    const wsKey = workspaceKey();
    const endpoint = stateEndpoint();
    try {
      const state = await apiRequest(endpoint);
      // Ignore the response if the user kept navigating meanwhile.
      if (!currentUser || workspaceKey() !== wsKey) return;
      applyState(state);
      loadedWorkspaceKey = wsKey;
      reconcileHistory();
      stateDirty = false;
      saveQueued = false;
      setSaveStatus(null);
      lastScheduleSignature = "";
      render();
      updateWorkspaceChrome();
    } catch (error) {
      if (!currentUser || workspaceKey() !== wsKey) return;
      if (error.status === 401) {
        handleSessionLost();
        return;
      }
      if (error.status === 404 && wsKey.startsWith("team:")) {
        void handleTeamLost(error.message);
        return;
      }
      setSaveStatus("error", error.message || "Couldn't load this workspace.");
    }
  }

  async function handleTeamLost(message) {
    if (!currentUser) return;
    if (saveRetryTimer) {
      window.clearTimeout(saveRetryTimer);
      saveRetryTimer = null;
    }
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    teams = teams.filter((team) => team.id !== activeTeamId);
    workspace = "personal";
    activeTeamId = null;
    tasks = [];
    history = [];
    loadedWorkspaceKey = null;
    stateDirty = false;
    saveQueued = false;
    lastScheduleSignature = "";
    persistWorkspacePref();
    setSaveStatus("error", message || "This team is no longer available.");
    updateWorkspaceChrome();
    render();
    await refreshTeams();
    await loadWorkspaceState();
  }

  async function refreshTeams() {
    if (!currentUser) return;
    try {
      const data = await apiRequest("/api/teams");
      if (!currentUser) return;
      teams = Array.isArray(data.teams) ? data.teams : [];
      pendingInvites = Array.isArray(data.invites) ? data.invites : [];
      if (
        workspace === "team" &&
        activeTeamId &&
        !teams.some((team) => team.id === activeTeamId)
      ) {
        await handleTeamLost("You no longer have access to this team.");
        return;
      }
      renderSidebar();
      updateWorkspaceChrome();
    } catch (error) {
      if (error.status === 401) handleSessionLost();
      /* Team list problems are non-fatal; try again on the next poll. */
    }
  }

  function startWorkspacePolling() {
    stopWorkspacePolling();
    teamPollTimer = window.setInterval(() => {
      if (!currentUser || document.visibilityState !== "visible") return;
      if (workspace === "team" && !activeTeamId) return;
      if (editingId || expandedTaskId || saveTimer || saveInFlight || stateDirty) return;
      void pollWorkspaceState();
    }, 25000);
    teamsRefreshTimer = window.setInterval(() => {
      if (!currentUser || document.visibilityState !== "visible") return;
      void refreshTeams();
    }, 60000);
  }

  function stopWorkspacePolling() {
    if (teamPollTimer) {
      window.clearInterval(teamPollTimer);
      teamPollTimer = null;
    }
    if (teamsRefreshTimer) {
      window.clearInterval(teamsRefreshTimer);
      teamsRefreshTimer = null;
    }
  }

  async function pollWorkspaceState() {
    if (!currentUser) return;
    const wsKey = workspaceKey();
    try {
      const state = await apiRequest(stateEndpoint());
      if (!currentUser || workspaceKey() !== wsKey) return;
      if (stateDirty || editingId || expandedTaskId) return;
      applyState(state);
      reconcileHistory();
      lastScheduleSignature = "";
      render();
      updateWorkspaceChrome();
    } catch (error) {
      if (error.status === 401) handleSessionLost();
      else if (error.status === 404 && wsKey.startsWith("team:")) void handleTeamLost(error.message);
    }
  }

  /* ---------------- Team workspace UI & actions ---------------- */

  function buildInviteItems() {
    const fragment = document.createDocumentFragment();
    for (const invite of pendingInvites) {
      const node = els.sideInviteTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.id = invite.id;
      node.querySelector(".side-invite-team").textContent = invite.teamName || "A team";
      node.querySelector(".side-invite-from").textContent = invite.inviterEmail
        ? `Invited by ${invite.inviterEmail}`
        : "You were invited";
      fragment.appendChild(node);
    }
    return fragment;
  }

  function renderSidebar() {
    const teamFragment = document.createDocumentFragment();
    for (const team of teams) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "side-link side-team-link";
      button.dataset.teamId = team.id;
      button.title = team.name;
      if (workspace === "team" && team.id === activeTeamId) {
        button.classList.add("active");
        button.setAttribute("aria-current", "true");
      } else {
        button.removeAttribute("aria-current");
      }

      const name = document.createElement("span");
      name.className = "side-team-name";
      name.textContent = team.name;

      const badge = document.createElement("span");
      badge.className = "side-count";
      badge.textContent = String(team.taskCount || 0);
      badge.title = `${team.taskCount || 0} team tasks`;

      const role = document.createElement("span");
      role.className = "side-team-role";
      role.textContent = team.role === "owner" ? "Owner" : "Member";
      role.title = team.role === "owner" ? "You own this team" : "Member";

      button.append(name, badge, role);
      item.appendChild(button);
      teamFragment.appendChild(item);
    }
    els.sideTeamList.replaceChildren(teamFragment);
    els.sideHint.hidden = teams.length > 0;

    const inviteFragment = buildInviteItems();
    els.sideInviteList.replaceChildren(inviteFragment);
    els.sideInvitesSection.hidden = pendingInvites.length === 0;
    els.teamSetupInvites.hidden = pendingInvites.length === 0;
    els.setupInviteList.replaceChildren(buildInviteItems());
  }

  function renderTeamDetails(team) {
    if (!team || !Array.isArray(team.members)) return;

    const isOwner = team.ownerId === (currentUser && currentUser.id);
    const memberFragment = document.createDocumentFragment();
    for (const member of team.members) {
      const node = els.teamMemberTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.userId = member.id;
      const initial = (member.email.charAt(0) || "?").toUpperCase();
      const avatar = node.querySelector(".team-member-avatar");
      avatar.textContent = initial;
      avatar.title = member.email;
      node.querySelector(".team-member-email").textContent = member.email;
      const role = node.querySelector(".team-member-role");
      role.textContent = member.role === "owner" ? "Owner" : "Member";
      node.querySelector(".owner-chip").hidden = member.role !== "owner";

      const removeBtn = node.querySelector(".member-remove-btn");
      if (isOwner && member.id !== team.ownerId) {
        removeBtn.hidden = false;
        removeBtn.setAttribute("aria-label", `Remove ${member.email} from team`);
      } else {
        removeBtn.hidden = true;
      }
      memberFragment.appendChild(node);
    }
    els.teamMemberList.replaceChildren(memberFragment);

    const invites = Array.isArray(team.invites) ? team.invites : [];
    els.teamPendingWrap.hidden = !isOwner || invites.length === 0;
    const pendingFragment = document.createDocumentFragment();
    for (const invite of invites) {
      const node = els.teamPendingTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.id = invite.id;
      node.querySelector(".team-pending-email").textContent = invite.email || "";
      pendingFragment.appendChild(node);
    }
    els.teamPendingList.replaceChildren(pendingFragment);
  }

  function updateWorkspaceChrome() {
    const inTeam = workspace === "team" && Boolean(activeTeamId);
    const team = activeTeam();

    els.navPersonal.classList.toggle("active", workspace === "personal");
    els.navPersonal.setAttribute("aria-pressed", String(workspace === "personal"));
    els.navTeam.classList.toggle("active", workspace === "team");
    els.navTeam.setAttribute("aria-pressed", String(workspace === "team"));

    els.teamBar.hidden = !inTeam;
    els.teamSetup.hidden = !(workspace === "team" && !activeTeamId);
    els.taskArea.hidden = workspace === "team" && !activeTeamId;

    if (inTeam && team) {
      els.teamBarName.textContent = team.name;
      const memberCount = Array.isArray(team.members) ? team.members.length : team.memberCount || 0;
      els.teamBarMeta.textContent = `${memberCount} member${memberCount === 1 ? "" : "s"}`;
      renderTeamDetails(team);
    }

    renderSidebar();
    updateCounts();
  }

  async function createTeam(event) {
    event.preventDefault();
    if (!currentUser) return;
    const name = els.teamNameInput.value.trim().slice(0, 60);
    if (!name) {
      els.teamNameInput.focus();
      return;
    }
    try {
      const data = await apiRequest("/api/teams", { method: "POST", body: { name } });
      els.teamNameInput.value = "";
      setTeamError("");
      broadcastTeamsChange();
      await refreshTeams();
      if (data.team && data.team.id) await switchWorkspace("team", data.team.id);
    } catch (error) {
      if (error.status === 401) handleSessionLost();
      else setTeamError(error.message || "Couldn't create the team.");
    }
  }

  async function inviteMember(event) {
    event.preventDefault();
    if (!currentUser || workspace !== "team" || !activeTeamId) return;
    const email = els.teamInviteEmail.value.trim().toLowerCase();
    if (!email) {
      els.teamInviteEmail.focus();
      return;
    }
    try {
      await apiRequest(`/api/teams/invite?team=${encodeURIComponent(activeTeamId)}`, {
        method: "POST",
        body: { email },
      });
      els.teamInviteEmail.value = "";
      setTeamError("");
      broadcastTeamsChange();
      await refreshTeams();
    } catch (error) {
      if (error.status === 401) handleSessionLost();
      else setTeamError(error.message || "Couldn't send the invitation.");
    }
  }

  async function acceptInvite(inviteId) {
    if (!currentUser || !inviteId) return;
    try {
      const data = await apiRequest("/api/teams/invites/accept", {
        method: "POST",
        body: { id: inviteId },
      });
      broadcastTeamsChange();
      await refreshTeams();
      if (data.team && data.team.id) await switchWorkspace("team", data.team.id);
    } catch (error) {
      if (error.status === 401) handleSessionLost();
      else {
        await refreshTeams();
        setTeamError(error.message || "Couldn't accept the invitation.");
      }
    }
  }

  async function declineInvite(inviteId) {
    if (!currentUser || !inviteId) return;
    try {
      await apiRequest("/api/teams/invites/decline", {
        method: "POST",
        body: { id: inviteId },
      });
      broadcastTeamsChange();
      await refreshTeams();
    } catch (error) {
      if (error.status === 401) handleSessionLost();
      else await refreshTeams();
    }
  }

  async function revokeInvite(inviteId) {
    if (!currentUser || !inviteId) return;
    try {
      await apiRequest("/api/teams/invites/revoke", {
        method: "POST",
        body: { id: inviteId },
      });
      broadcastTeamsChange();
      await refreshTeams();
    } catch (error) {
      if (error.status === 401) handleSessionLost();
      else setTeamError(error.message || "Couldn't revoke the invitation.");
    }
  }

  async function removeMember(memberId) {
    if (!currentUser || workspace !== "team" || !activeTeamId || !memberId) return;
    try {
      await apiRequest(`/api/teams/members/remove?team=${encodeURIComponent(activeTeamId)}`, {
        method: "POST",
        body: { userId: memberId },
      });
      broadcastTeamsChange();
      await refreshTeams();
    } catch (error) {
      if (error.status === 401) handleSessionLost();
      else setTeamError(error.message || "Couldn't remove the member.");
    }
  }

  function toggleTeamDetailsPanel(open) {
    const show = open === undefined ? els.teamDetailsPanel.hidden : Boolean(open);
    els.teamDetailsPanel.hidden = !show;
    els.teamDetailsToggle.setAttribute("aria-expanded", String(show));
  }

  function archiveTask(task) {
    if (!task || history.some((entry) => entry.taskId === task.id)) return;
    history.push({
      id: uid(),
      taskId: task.id,
      text: task.text,
      description: task.description || "",
      assignee: task.assignee || "",
      priority: task.priority,
      due: task.due,
      dueTime: task.dueTime || null,
      progress: clampProgress(task.progress),
      updates: cloneUpdates(task.updates),
      archived: false,
      completedAt: Date.now(),
    });
    saveHistory();
  }

  function syncHistoryForTask(task) {
    const entry = history.find((item) => item.taskId === task.id);
    if (!entry) return;
    entry.text = task.text;
    entry.description = task.description || "";
    entry.assignee = task.assignee || "";
    entry.priority = task.priority;
    entry.due = task.due;
    entry.dueTime = task.dueTime || null;
    entry.progress = clampProgress(task.progress);
    entry.updates = cloneUpdates(task.updates);
    saveHistory();
  }

  function archiveTaskManually(taskId) {
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return;

    const completionEntry = history.find((entry) => entry.taskId === task.id);
    if (task.done && completionEntry) {
      tasks = tasks.filter((item) => item.id !== task.id);
      if (expandedTaskId === task.id) expandedTaskId = null;
      saveTasks();
      render();
      return;
    }

    history = history.filter((entry) => entry.taskId !== task.id);
    history.push({
      id: uid(),
      taskId: task.id,
      text: task.text,
      description: task.description || "",
      assignee: task.assignee || "",
      priority: task.priority,
      due: task.due,
      dueTime: task.dueTime || null,
      progress: clampProgress(task.progress),
      updates: cloneUpdates(task.updates),
      archived: true,
      completedAt: Date.now(),
    });

    tasks = tasks.filter((item) => item.id !== task.id);
    if (expandedTaskId === task.id) expandedTaskId = null;

    saveHistory();
    saveTasks();
    render();
  }

  function unarchiveTask(taskId) {
    const next = history.filter((entry) => entry.taskId !== taskId);
    if (next.length !== history.length) {
      history = next;
      saveHistory();
    }
  }

  /**
   * Keeps the archive consistent with the task list: history entries for
   * tasks that are no longer completed are dropped. History for deleted
   * tasks stays forever.
   */
  function reconcileHistory() {
    const activeTaskIds = new Set(tasks.filter((task) => !task.done).map((task) => task.id));
    const previousLength = history.length;

    history = history.filter((entry) => !entry.taskId || !activeTaskIds.has(entry.taskId));

    if (history.length !== previousLength) saveHistory();
  }

  function loadFilter() {
    try {
      const value = localStorage.getItem(scopedKey("filter"));
      return ["all", "active", "overdue", "completed", "history"].includes(value) ? value : "all";
    } catch (_) {
      return "all";
    }
  }

  /* ---------------- Accounts & sessions ---------------- */

  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function normalizeEmail(value) {
    return value.trim().toLowerCase();
  }

  function passwordProblem(password) {
    if (password.length < 8) return "Password must be at least 8 characters.";
    if (password.length > 128) return "Password must be 128 characters or fewer.";
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      return "Password must include at least one letter and one number.";
    }
    return null;
  }

  function getLastEmail() {
    try {
      return localStorage.getItem(LAST_EMAIL_KEY) || "";
    } catch (_) {
      return "";
    }
  }

  function rememberEmail(email) {
    try {
      localStorage.setItem(LAST_EMAIL_KEY, email);
    } catch (_) {
      /* ignore */
    }
  }

  function setAuthError(message) {
    if (!message) {
      els.authError.hidden = true;
      els.authError.textContent = "";
      return;
    }
    els.authError.textContent = message;
    els.authError.hidden = false;
  }

  function setAuthBusy(busy) {
    authBusy = busy;
    els.authSubmit.disabled = busy;

    if (busy) {
      els.authSubmit.textContent = authMode === "signup" ? "Creating account…" : "Signing in…";
    } else {
      els.authSubmit.textContent = authMode === "signup" ? "Create account" : "Sign in";
    }

    els.authForm.setAttribute("aria-busy", String(busy));
  }

  function resetPasswordVisibility() {
    els.authPassword.type = "password";
    els.passwordToggle.classList.remove("revealed");
    els.passwordToggle.setAttribute("aria-pressed", "false");
    els.passwordToggle.setAttribute("aria-label", "Show password");
  }

  function setAuthMode(mode) {
    authMode = mode === "signup" ? "signup" : "signin";
    const isSignup = authMode === "signup";

    els.tabSignin.classList.toggle("active", !isSignup);
    els.tabSignin.setAttribute("aria-selected", String(!isSignup));
    els.tabSignup.classList.toggle("active", isSignup);
    els.tabSignup.setAttribute("aria-selected", String(isSignup));

    els.confirmField.hidden = !isSignup;
    els.authPassword.autocomplete = isSignup ? "new-password" : "current-password";
    els.authConfirm.autocomplete = "new-password";
    els.authSubtitle.textContent = isSignup
      ? "Create an account to keep your tasks together."
      : "Sign in to pick up where you left off.";

    els.authPassword.value = "";
    els.authConfirm.value = "";
    resetPasswordVisibility();
    setAuthBusy(false);
    setAuthError("");
  }

  async function createAccount(email, password) {
    setAuthBusy(true);
    try {
      const data = await apiRequest("/api/auth/register", {
        method: "POST",
        body: { email, password },
      });
      await completeSignIn(data.user, email);
    } catch (error) {
      setAuthError(error.message || "Couldn't create your account. Please try again.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function signIn(email, password) {
    setAuthBusy(true);
    try {
      const data = await apiRequest("/api/auth/login", {
        method: "POST",
        body: { email, password },
      });
      await completeSignIn(data.user, email);
    } catch (error) {
      setAuthError(error.message || "Couldn't sign you in. Please try again.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function completeSignIn(user, email) {
    if (!user || typeof user.id !== "string") {
      throw new ApiError(500, "The server returned an invalid account.");
    }
    hasAccounts = true;
    rememberEmail(email || user.email);
    const state = await apiRequest("/api/state");
    enterApp(user, state);
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    if (authBusy) return;

    setAuthError("");

    const email = normalizeEmail(els.authEmail.value);
    const password = els.authPassword.value;

    if (!email) {
      setAuthError("Enter your email address.");
      els.authEmail.focus();
      return;
    }

    if (!EMAIL_PATTERN.test(email)) {
      setAuthError("Enter a valid email address, like you@example.com.");
      els.authEmail.focus();
      return;
    }

    if (!password) {
      setAuthError("Enter your password.");
      els.authPassword.focus();
      return;
    }

    if (authMode === "signup") {
      const problem = passwordProblem(password);
      if (problem) {
        setAuthError(problem);
        els.authPassword.focus();
        return;
      }
      if (!els.authConfirm.value) {
        setAuthError("Confirm your password.");
        els.authConfirm.focus();
        return;
      }
      if (password !== els.authConfirm.value) {
        setAuthError("Passwords do not match.");
        els.authConfirm.focus();
        return;
      }
      await createAccount(email, password);
      return;
    }

    await signIn(email, password);
  }

  function updateUserChrome() {
    if (!currentUser) return;
    const initial = (currentUser.email.charAt(0) || "?").toUpperCase();
    els.userAvatar.textContent = initial;
    els.userAvatarLarge.textContent = initial;
    els.userEmail.textContent = currentUser.email;
    els.userEmail.title = currentUser.email;
    els.userMenuBtn.setAttribute("aria-label", `Account menu for ${currentUser.email}`);
    els.userMenuBtn.title = currentUser.email;

    if (Number.isFinite(currentUser.createdAt)) {
      const joined = new Date(currentUser.createdAt).toLocaleDateString(undefined, {
        month: "short",
        year: "numeric",
      });
      els.userSince.textContent = `Member since ${joined}`;
    } else {
      els.userSince.textContent = "Signed in";
    }
  }

  function openUserMenu(open) {
    els.userMenu.hidden = !open;
    els.userMenuBtn.setAttribute("aria-expanded", String(open));
  }

  function closeUserMenu() {
    openUserMenu(false);
  }

  function applyState(state) {
    tasks = normalizeTasks(state && state.tasks);
    history = normalizeHistory(state && state.history);
  }

  async function enterApp(user, state) {
    currentUser = user;
    applyState(state);
    filter = loadFilter();
    reconcileHistory();
    setSaveStatus(null);

    teams = [];
    pendingInvites = [];
    loadedWorkspaceKey = null;
    const pref = loadWorkspacePref();
    if (pref.startsWith("team:")) {
      workspace = "team";
      activeTeamId = pref.slice(5) || null;
    } else {
      workspace = "personal";
      activeTeamId = null;
    }

    updateUserChrome();
    els.authView.hidden = true;
    els.appView.hidden = false;
    els.authForm.reset();
    resetPasswordVisibility();
    setAuthError("");
    closeUserMenu();
    render();
    updateWorkspaceChrome();
    startWorkspacePolling();

    // Teams are fetched asynchronously; if the saved team is gone, the
    // app falls back to the personal workspace automatically.
    void refreshTeams();
    if (workspace === "team" && activeTeamId) {
      void loadWorkspaceState();
    } else if (workspace === "team") {
      // No team selected — drop the personal data so nothing leaks across.
      tasks = [];
      history = [];
      loadedWorkspaceKey = null;
      render();
      updateWorkspaceChrome();
    }

    window.setTimeout(() => {
      if (!els.appView.hidden && !els.taskArea.hidden) els.input.focus();
    }, 30);
  }

  function showAuth(message) {
    els.authView.hidden = false;
    els.appView.hidden = true;
    setAuthMode(hasAccounts ? "signin" : "signup");

    const lastEmail = getLastEmail();
    if (lastEmail) els.authEmail.value = lastEmail;

    setAuthError(message || "");
    window.setTimeout(() => {
      if (!els.authView.hidden) els.authEmail.focus();
    }, 30);
  }

  function resetAppState() {
    closeUserMenu();
    currentUser = null;
    tasks = [];
    history = [];
    filter = "all";
    editingId = null;
    expandedTaskId = null;
    stateDirty = false;
    saveQueued = false;
    suggestions = [];
    aiBusy = false;
    aiLoaded = false;
    aiSource = "local";
    aiNotice = "";
    workspace = "personal";
    activeTeamId = null;
    teams = [];
    pendingInvites = [];
    loadedWorkspaceKey = null;
    stopWorkspacePolling();
    if (els.teamDetailsPanel) els.teamDetailsPanel.hidden = true;
    if (els.teamDetailsToggle) els.teamDetailsToggle.setAttribute("aria-expanded", "false");
    if (els.aiPanel) {
      setAiPanelOpen(false);
      setAiStatus("");
      renderAiPanel();
    }
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (saveRetryTimer) {
      window.clearTimeout(saveRetryTimer);
      saveRetryTimer = null;
    }
    setSaveStatus(null);
    disarmClearHistory();
  }

  async function signOut(email) {
    const fallbackEmail = email || (currentUser ? currentUser.email : "");
    try {
      await apiRequest("/api/auth/logout", { method: "POST" });
    } catch (_) {
      /* Clear locally even if the network request fails. */
    }

    resetAppState();

    els.appView.hidden = true;
    els.authView.hidden = false;
    els.authForm.reset();
    resetPasswordVisibility();
    setAuthMode("signin");
    setAuthError("");
    if (fallbackEmail) els.authEmail.value = fallbackEmail;

    window.setTimeout(() => {
      if (!els.authView.hidden) els.authEmail.focus();
    }, 30);
  }

  function handleSessionLost() {
    if (!currentUser) return;
    const email = currentUser.email;
    resetAppState();

    els.appView.hidden = true;
    els.authView.hidden = false;
    els.authForm.reset();
    resetPasswordVisibility();
    setAuthMode("signin");
    setAuthError("Your session expired. Please sign in again.");
    if (email) els.authEmail.value = email;
  }

  async function boot() {
    applyTheme(document.documentElement.dataset.theme || "light", false);

    try {
      const status = await apiRequest("/api/auth/status");
      hasAccounts = Boolean(status.hasAccounts);
    } catch (error) {
      showAuth(error.message);
      return;
    }

    let user = null;
    try {
      const session = await apiRequest("/api/auth/session");
      user = session.user || null;
    } catch (error) {
      if (error.status !== 401) {
        showAuth(error.message);
        return;
      }
    }

    if (!user) {
      showAuth();
      return;
    }

    try {
      const state = await apiRequest("/api/state");
      enterApp(user, state);
    } catch (error) {
      showAuth(error.status === 401 ? "" : error.message);
    }
  }

  /* ---------------- Rendering ---------------- */

  function parseDue(value) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function normalizeTime(value) {
    if (typeof value !== "string") return null;
    const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(value.trim());
    return match ? `${match[1]}:${match[2]}` : null;
  }

  function parseDueTime(value) {
    const normalized = normalizeTime(value);
    if (!normalized) return null;
    const [hours, minutes] = normalized.split(":").map(Number);
    return { hours, minutes };
  }

  function formatTimeLabel(value) {
    const parsed = parseDueTime(value);
    if (!parsed) return "";
    const date = new Date();
    date.setHours(parsed.hours, parsed.minutes, 0, 0);
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function dueDeadline(due, dueTime) {
    const date = parseDue(due);
    const parsed = parseDueTime(dueTime);
    if (parsed) date.setHours(parsed.hours, parsed.minutes, 0, 0);
    else date.setHours(23, 59, 59, 999);
    return date;
  }

  function formatDeadlineTitle(due, dueTime) {
    const date = parseDue(due);
    const parsed = parseDueTime(dueTime);
    const dateOptions = { weekday: "long", year: "numeric", month: "long", day: "numeric" };
    if (!parsed) return date.toLocaleDateString(undefined, dateOptions);
    return dueDeadline(due, dueTime).toLocaleString(undefined, {
      ...dateOptions,
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function toDateInputValue(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function formatDue(value, valueTime) {
    const today = startOfDay(new Date());
    const date = parseDue(value);
    const diff = Math.round((date - today) / 86400000);

    let label;
    if (diff === 0) label = "Today";
    else if (diff === 1) label = "Tomorrow";
    else if (diff === -1) label = "Yesterday";
    else {
      const sameYear = date.getFullYear() === today.getFullYear();
      label = date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        ...(sameYear ? {} : { year: "numeric" }),
      });
    }

    const time = formatTimeLabel(valueTime);
    const deadline = dueDeadline(value, valueTime);
    const overdue = deadline.getTime() < Date.now();

    return { label, diff, time, overdue, today: diff === 0 };
  }

  function completedLateInfo(due, dueTime, completedAt) {
    if (!due || !Number.isFinite(completedAt)) return null;

    const completed = new Date(completedAt);
    const hasTime = Boolean(parseDueTime(dueTime));
    const deadline = dueDeadline(due, dueTime);
    if (completed.getTime() <= deadline.getTime()) return null;

    if (!hasTime) {
      const completedDay = startOfDay(completed);
      const dueDay = parseDue(due);
      const days = Math.max(1, Math.round((completedDay - dueDay) / 86400000));
      return days === 1
        ? "Completed 1 day after the due date"
        : `Completed ${days} days after the due date`;
    }

    const minutes = Math.max(1, Math.round((completed.getTime() - deadline.getTime()) / 60000));
    if (minutes < 60) {
      return minutes === 1
        ? "Completed 1 minute after the deadline"
        : `Completed ${minutes} minutes after the deadline`;
    }

    const hours = Math.round(minutes / 60);
    if (hours < 24) {
      return hours === 1
        ? "Completed 1 hour after the deadline"
        : `Completed ${hours} hours after the deadline`;
    }

    const days = Math.round(hours / 24);
    return days === 1
      ? "Completed 1 day after the deadline"
      : `Completed ${days} days after the deadline`;
  }

  function isTaskOverdue(task) {
    if (!task || task.done || !task.due) return false;
    return dueDeadline(task.due, task.dueTime).getTime() < Date.now();
  }

  function taskStatus(task) {
    if (task.done) return "completed";
    if (isTaskOverdue(task)) return "overdue";
    return "pending";
  }

  function categoryCounts() {
    const counts = { pending: 0, overdue: 0, completed: 0 };
    for (const task of tasks) counts[taskStatus(task)] += 1;
    return counts;
  }

  function buildUpdateItem(update) {
    const item = document.createElement("li");
    item.className = "update-item";

    const head = document.createElement("div");
    head.className = "update-head";

    const time = document.createElement("time");
    time.className = "update-time";
    time.dateTime = new Date(update.createdAt).toISOString();
    time.textContent = formatCompletedAt(update.createdAt);

    const badge = document.createElement("span");
    badge.className = "chip update-progress-chip";
    badge.textContent = `${clampProgress(update.progress)}%`;

    head.append(time, badge);

    const body = document.createElement("p");
    body.className = "update-note";
    body.textContent = update.text || (update.system ? "Task completed" : "Checkpoint update");

    item.append(head, body);
    return item;
  }

  function renderUpdateList(list, updates) {
    list.replaceChildren();
    for (const update of updates) list.appendChild(buildUpdateItem(update));
    return updates.length;
  }

  function buildTask(task) {
    const node = els.template.content.firstElementChild.cloneNode(true);
    const isExpanded = expandedTaskId === task.id;
    node.dataset.id = task.id;
    node.classList.toggle("done", task.done);
    node.classList.toggle("expanded", isExpanded);
    node.draggable = !isExpanded;

    const checkbox = node.querySelector(".task-check");
    checkbox.checked = task.done;
    checkbox.setAttribute("aria-label", task.done ? "Mark task as not done" : "Mark task as done");

    const restoreBtn = node.querySelector(".task-restore-btn");
    if (restoreBtn) {
      restoreBtn.title = task.done
        ? `Restore task to ${clampProgress(task.restorableProgress ?? lastCheckpointProgress(task))}% and reopen it`
        : "Restore task";
      restoreBtn.setAttribute("aria-label", restoreBtn.title);
    }

    const text = node.querySelector(".task-text");
    text.textContent = task.text;
    text.title = "Double-click to edit";

    const status = taskStatus(task);
    const statusChip = node.querySelector(".status-chip");
    statusChip.hidden = false;
    statusChip.dataset.status = status;
    statusChip.textContent = status === "completed" ? "Completed" : status === "overdue" ? "Overdue" : "Pending";

    const dueChip = node.querySelector(".due-chip");
    if (task.due) {
      const info = formatDue(task.due, task.dueTime);
      const label = info.time ? `${info.label}, ${info.time}` : info.label;
      dueChip.hidden = false;
      dueChip.textContent = info.overdue && !task.done ? `Overdue · ${label}` : label;
      dueChip.title = formatDeadlineTitle(task.due, task.dueTime);
      dueChip.classList.toggle("overdue", info.overdue && !task.done);
      dueChip.classList.toggle("today", info.today && !task.done && !info.overdue);
    }

    const progressChip = node.querySelector(".progress-chip");
    progressChip.hidden = false;
    progressChip.textContent = `${clampProgress(task.progress)}%`;
    progressChip.title = `Task progress: ${clampProgress(task.progress)}%`;

    const priorityChip = node.querySelector(".priority-chip");
    priorityChip.textContent = PRIORITIES[task.priority];
    priorityChip.dataset.priority = task.priority;

    const assigneeChip = node.querySelector(".assignee-chip");
    if (task.assignee) {
      assigneeChip.hidden = false;
      assigneeChip.textContent = task.assignee;
      assigneeChip.title = `Assigned to ${task.assignee}`;
    }

    const lateChip = node.querySelector(".late-chip");
    if (task.done && task.due) {
      const archived = history.find((entry) => entry.taskId === task.id);
      const lateInfo = archived
        ? completedLateInfo(
            archived.due || task.due,
            archived.dueTime || task.dueTime,
            archived.completedAt,
          )
        : null;

      if (lateInfo) {
        lateChip.hidden = false;
        lateChip.textContent = "Completed late";
        lateChip.title = lateInfo;
      }
    }

    const updatesBtn = node.querySelector(".updates-btn");
    updatesBtn.setAttribute("aria-expanded", String(isExpanded));
    updatesBtn.title = task.updates.length
      ? `Updates & progress (${task.updates.length})`
      : "Updates & progress";
    updatesBtn.classList.toggle("has-updates", task.updates.length > 0);

    const detail = node.querySelector(".task-detail");
    detail.hidden = !isExpanded;

    if (isExpanded) {
      const detailTitle = detail.querySelector(".detail-title");
      const detailDescription = detail.querySelector(".detail-description");
      const detailStatus = detail.querySelector(".detail-status-chip");
      const detailDeadline = detail.querySelector(".detail-deadline");
      const detailPriority = detail.querySelector(".detail-priority-label");
      const detailAssignee = detail.querySelector(".detail-assignee-label");
      const detailCreated = detail.querySelector(".detail-created");
      const bar = detail.querySelector(".detail-progress-bar");
      const barFill = detail.querySelector(".detail-progress-fill");
      const percent = detail.querySelector(".detail-percent");
      const titleInput = detail.querySelector(".detail-title-input");
      const descriptionInput = detail.querySelector(".detail-description-input");
      const dueInput = detail.querySelector(".detail-due");
      const timeInput = detail.querySelector(".detail-time");
      const priorityInput = detail.querySelector(".detail-priority");
      const assigneeInput = detail.querySelector(".detail-assignee");
      const range = detail.querySelector(".detail-range");
      const progressValue = detail.querySelector(".detail-progress-value");
      const updateProgress = detail.querySelector(".update-progress");
      const updateList = detail.querySelector(".update-list");
      const updateCount = detail.querySelector(".update-count");
      const updateEmpty = detail.querySelector(".update-empty");

      detailTitle.textContent = task.text;

      if (task.description) {
        detailDescription.textContent = task.description;
        detailDescription.classList.remove("is-empty");
      } else {
        detailDescription.textContent = "No description yet — add one below.";
        detailDescription.classList.add("is-empty");
      }

      detailStatus.dataset.status = status;
      detailStatus.textContent =
        status === "completed" ? "Completed" : status === "overdue" ? "Overdue" : "Pending";

      detailDeadline.textContent = task.due
        ? formatDeadlineTitle(task.due, task.dueTime)
        : "No deadline set";
      detailDeadline.classList.toggle("is-empty", !task.due);

      detailPriority.textContent = PRIORITIES[task.priority];
      detailPriority.dataset.priority = task.priority;

      detailAssignee.textContent = task.assignee || "Unassigned";
      detailAssignee.classList.toggle("is-empty", !task.assignee);

      detailCreated.textContent = formatCompletedAt(task.createdAt);

      const value = clampProgress(task.progress);
      percent.textContent = `${value}%`;
      barFill.style.width = `${value}%`;
      bar.setAttribute("aria-valuenow", String(value));
      bar.setAttribute("aria-valuetext", `${value}% complete`);
      bar.classList.toggle("is-complete", value === 100);

      titleInput.value = task.text;
      descriptionInput.value = task.description || "";
      dueInput.value = task.due || "";
      timeInput.value = task.dueTime || "";
      priorityInput.value = task.priority;
      assigneeInput.value = task.assignee || "";

      range.value = String(value);
      progressValue.textContent = `${value}%`;
      range.disabled = task.done;

      updateProgress.value = String(task.done ? 100 : value);
      updateProgress.disabled = task.done;

      const count = renderUpdateList(updateList, task.updates);
      updateCount.textContent = count ? `(${count})` : "";
      updateEmpty.hidden = count > 0;
    }

    return node;
  }

  function visibleTasks() {
    if (filter === "active") return tasks.filter((task) => !task.done);
    if (filter === "overdue") return tasks.filter(isTaskOverdue);
    if (filter === "completed") return tasks.filter((task) => task.done);
    return tasks;
  }

  function scheduleSignature() {
    const day = new Date().toDateString();
    return `${day}|${tasks.map((task) => `${task.id}:${taskStatus(task)}`).join(",")}`;
  }

  function refreshScheduleState() {
    if (!currentUser || els.appView.hidden || els.taskArea.hidden || editingId || expandedTaskId) return;
    const active = document.activeElement;
    if (
      active &&
      typeof active.closest === "function" &&
      (active.closest(".task-detail") || active.closest(".history-updates"))
    ) {
      return;
    }
    if (scheduleSignature() !== lastScheduleSignature) render();
  }

  function updateAssigneeOptions() {
    if (!els.assigneeOptions) return;
    const names = new Set();
    for (const task of tasks) if (task.assignee) names.add(task.assignee);
    for (const entry of history) if (entry.assignee) names.add(entry.assignee);
    if (workspace === "team" && activeTeamId) {
      const team = activeTeam();
      if (team && Array.isArray(team.members)) {
        for (const member of team.members) if (member.email) names.add(member.email);
      }
    }

    const fragment = document.createDocumentFragment();
    for (const name of Array.from(names).sort((a, b) => a.localeCompare(b))) {
      const option = document.createElement("option");
      option.value = name;
      fragment.appendChild(option);
    }
    els.assigneeOptions.replaceChildren(fragment);
  }

  function render() {
    if (expandedTaskId && !tasks.some((task) => task.id === expandedTaskId)) {
      expandedTaskId = null;
    }

    const isHistoryView = filter === "history";
    const visible = visibleTasks();

    if (isHistoryView) {
      els.list.replaceChildren();
      els.list.hidden = true;
      els.historySection.hidden = false;
      renderHistory();
    } else {
      els.historySection.hidden = true;
      els.historyList.replaceChildren();

      const fragment = document.createDocumentFragment();
      for (const task of visible) fragment.appendChild(buildTask(task));
      els.list.replaceChildren(fragment);
      els.list.hidden = visible.length === 0;
    }

    const isEmpty = isHistoryView ? history.length === 0 : visible.length === 0;
    els.empty.hidden = !isEmpty;

    updateCounts();
    updateEmptyCopy();
    updateFilterButtons();
    updateAssigneeOptions();
    lastScheduleSignature = scheduleSignature();
  }

  function formatCompletedAt(timestamp) {
    const date = new Date(timestamp);
    const today = startOfDay(new Date());
    const day = startOfDay(date);
    const diff = Math.round((today - day) / 86400000);
    const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

    if (diff === 0) return `today at ${time}`;
    if (diff === 1) return `yesterday at ${time}`;

    const sameYear = date.getFullYear() === today.getFullYear();
    const label = date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
    });
    return `${label} at ${time}`;
  }

  function buildHistoryItem(entry) {
    const node = els.historyTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = entry.id;

    node.querySelector(".history-text").textContent = entry.text;
    node.querySelector(".history-when").textContent = entry.archived
      ? `Archived ${formatCompletedAt(entry.completedAt)}`
      : `Completed ${formatCompletedAt(entry.completedAt)}`;

    const statusChip = node.querySelector(".status-chip");
    statusChip.hidden = false;
    statusChip.dataset.status = entry.archived ? "archived" : "completed";
    statusChip.textContent = entry.archived ? "Archived" : "Completed";

    const progressChip = node.querySelector(".progress-chip");
    progressChip.hidden = false;
    progressChip.textContent = `${clampProgress(entry.progress)}%`;
    progressChip.title = `Progress when archived: ${clampProgress(entry.progress)}%`;

    const priorityChip = node.querySelector(".priority-chip");
    priorityChip.textContent = PRIORITIES[entry.priority];
    priorityChip.dataset.priority = entry.priority;

    const assigneeChip = node.querySelector(".assignee-chip");
    if (entry.assignee) {
      assigneeChip.hidden = false;
      assigneeChip.textContent = entry.assignee;
      assigneeChip.title = `Assigned to ${entry.assignee}`;
    }

    const lateChip = node.querySelector(".late-chip");
    const lateInfo = entry.archived
      ? null
      : completedLateInfo(entry.due, entry.dueTime, entry.completedAt);
    if (lateInfo) {
      lateChip.hidden = false;
      lateChip.textContent = "Completed late";
      lateChip.title = lateInfo;
    }

    const dueChip = node.querySelector(".due-chip");
    if (entry.due) {
      const date = parseDue(entry.due);
      const sameYear = date.getFullYear() === new Date().getFullYear();
      const time = formatTimeLabel(entry.dueTime);
      dueChip.hidden = false;
      dueChip.textContent = `Due ${date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        ...(sameYear ? {} : { year: "numeric" }),
      })}${time ? `, ${time}` : ""}`;
      dueChip.title = formatDeadlineTitle(entry.due, entry.dueTime);
    }

    const updates = node.querySelector(".history-updates");
    if (entry.updates.length) {
      const count = renderUpdateList(updates.querySelector(".update-list"), entry.updates);
      updates.querySelector(".history-update-count").textContent = `(${count})`;
      updates.hidden = false;
    }

    return node;
  }

  function renderHistory() {
    const sorted = history.slice().sort((a, b) => b.completedAt - a.completedAt);
    const fragment = document.createDocumentFragment();
    for (const entry of sorted) fragment.appendChild(buildHistoryItem(entry));
    els.historyList.replaceChildren(fragment);
  }

  function updateCounts() {
    const total = tasks.length;
    const counts = categoryCounts();
    const completed = counts.completed;
    const active = total - completed;
    const percent = total === 0 ? 0 : Math.round((completed / total) * 100);

    els.countAll.textContent = total;
    els.countActive.textContent = active;
    els.countOverdue.textContent = counts.overdue;
    els.countCompleted.textContent = completed;
    els.countHistory.textContent = history.length;

    els.summaryPending.textContent = counts.pending;
    els.summaryOverdue.textContent = counts.overdue;
    els.summaryCompleted.textContent = counts.completed;

    els.progressBar.style.width = `${percent}%`;
    els.progressTrack.setAttribute("aria-valuenow", String(percent));
    els.progressTrack.setAttribute("aria-valuetext", `${percent}% complete`);
    els.progressLabel.textContent = total === 0 ? "No tasks yet" : `${completed} of ${total} done · ${percent}%`;

    const activeCount = total - completed;
    els.sidePersonalCount.textContent = workspace === "personal" ? String(activeCount) : "";
    els.sideTeamCount.textContent = workspace === "team" && activeTeamId ? String(activeCount) : "";

    if (workspace === "team" && activeTeamId) {
      const team = activeTeam();
      if (team && els.teamBarMeta) {
        const memberCount = Array.isArray(team.members) ? team.members.length : team.memberCount || 0;
        els.teamBarMeta.textContent = `${memberCount} member${memberCount === 1 ? "" : "s"}`;
      }
    }

    updateClearButton();
  }

  function updateClearButton() {
    if (filter === "history") {
      els.clear.textContent = clearHistoryArmed ? "Confirm clear?" : "Clear history";
      els.clear.disabled = history.length === 0;
      els.clear.classList.toggle("armed", clearHistoryArmed);
    } else {
      els.clear.textContent = "Clear completed";
      els.clear.disabled = !tasks.some((task) => task.done);
      els.clear.classList.remove("armed");
    }
  }

  function updateEmptyCopy() {
    const copy = {
      all: ["Your list is clear", "Add your first task above — every big thing starts small."],
      active: ["All caught up", "No active tasks right now. Take a breath, you've earned it."],
      overdue: ["Nothing overdue", "Every task is either finished or still within its deadline."],
      completed: ["Nothing completed yet", "Check off a task and it will land here."],
      history: ["No history yet", "Tasks you complete are archived here automatically, with a timestamp."],
    };
    const [title, text] = copy[filter] || copy.all;
    els.emptyTitle.textContent = title;
    els.emptyText.textContent = text;
  }

  function updateFilterButtons() {
    for (const button of els.filters) {
      const isActive = button.dataset.filter === filter;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    }
  }

  /* ---------------- Task actions ---------------- */

  function addTask(event) {
    event.preventDefault();

    const text = els.input.value.trim();
    if (!text) {
      els.input.focus();
      return;
    }

    const dueTime = normalizeTime(els.dueTime.value);
    const due = els.due.value || (dueTime ? toDateInputValue(new Date()) : null);

    tasks.push({
      id: uid(),
      text: text.slice(0, 200),
      description: "",
      assignee: "",
      done: false,
      priority: Object.prototype.hasOwnProperty.call(PRIORITIES, els.priority.value) ? els.priority.value : "medium",
      due,
      dueTime,
      progress: 0,
      updates: [],
      createdAt: Date.now(),
    });

    saveTasks();
    els.form.reset();
    els.priority.value = "medium";

    // Make the new task visible even if the user was browsing Done/History/Overdue.
    if (filter === "completed" || filter === "history" || filter === "overdue") {
      filter = "all";
      disarmClearHistory();
      persistFilter();
    }

    els.input.focus();
    render();
  }

  function toggleTask(id, done) {
    const task = tasks.find((item) => item.id === id);
    if (!task) return;
    task.done = done;
    if (done) {
      // Remember where the task was so Restore can undo the completion.
      task.restorableProgress = task.progress;
      task.progress = 100;
      archiveTask(task);
    } else {
      // Un-completing (or restoring) returns the task to its pre-completion
      // progress instead of leaving it stuck at 100%.
      const fallback = lastCheckpointProgress(task);
      task.progress =
        task.restorableProgress === null || task.restorableProgress === undefined
          ? fallback
          : task.restorableProgress;
      task.restorableProgress = null;
      unarchiveTask(task.id);
    }
    saveTasks();
    render();
  }

  function lastCheckpointProgress(task) {
    const updates = Array.isArray(task.updates) ? task.updates : [];
    for (let index = updates.length - 1; index >= 0; index -= 1) {
      const value = Number(updates[index].progress);
      if (Number.isFinite(value)) return clampProgress(value);
    }
    return 0;
  }

  function restoreCompletedTask(id) {
    const task = tasks.find((item) => item.id === id);
    if (!task || !task.done) return;
    toggleTask(id, false);
  }

  function deleteTask(id) {
    const node = findNode(id);
    const finalize = () => {
      tasks = tasks.filter((task) => task.id !== id);
      if (expandedTaskId === id) expandedTaskId = null;
      saveTasks();
      render();
    };

    if (!node) return finalize();
    node.classList.add("removing");
    window.setTimeout(finalize, 170);
  }

  function toggleTaskDetails(id) {
    expandedTaskId = expandedTaskId === id ? null : id;
    render();
  }

  function saveTaskDetails(taskId, form) {
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return;

    const titleInput = form.querySelector(".detail-title-input");
    const descriptionInput = form.querySelector(".detail-description-input");
    const dueInput = form.querySelector(".detail-due");
    const timeInput = form.querySelector(".detail-time");
    const priorityInput = form.querySelector(".detail-priority");
    const assigneeInput = form.querySelector(".detail-assignee");
    const range = form.querySelector(".detail-range");

    const title = titleInput.value.trim();
    if (title) task.text = title.slice(0, 200);
    task.description = descriptionInput.value.trim().slice(0, 1000);
    task.assignee = assigneeInput ? assigneeInput.value.trim().slice(0, 60) : "";

    let due = dueInput.value || null;
    const dueTime = normalizeTime(timeInput.value);
    if (dueTime && !due) due = toDateInputValue(new Date());

    task.due = due;
    task.dueTime = due ? dueTime : null;
    task.priority = Object.prototype.hasOwnProperty.call(PRIORITIES, priorityInput.value)
      ? priorityInput.value
      : "medium";

    if (!task.done && range) task.progress = clampProgress(range.value);

    saveTasks();
    syncHistoryForTask(task);
    render();
  }

  function updateTaskProgress(taskId, value) {
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return;
    task.progress = task.done ? 100 : clampProgress(value);
    saveTasks();
    syncHistoryForTask(task);

    const node = findNode(task.id);
    if (!node) {
      render();
      return;
    }

    const chip = node.querySelector(".progress-chip");
    if (chip) {
      chip.textContent = `${task.progress}%`;
      chip.title = `Task progress: ${task.progress}%`;
    }
    const output = node.querySelector(".detail-progress-value");
    if (output) output.textContent = `${task.progress}%`;

    const percent = node.querySelector(".detail-percent");
    if (percent) percent.textContent = `${task.progress}%`;

    const bar = node.querySelector(".detail-progress-bar");
    const fill = node.querySelector(".detail-progress-fill");
    if (bar && fill) {
      fill.style.width = `${task.progress}%`;
      bar.setAttribute("aria-valuenow", String(task.progress));
      bar.setAttribute("aria-valuetext", `${task.progress}% complete`);
      bar.classList.toggle("is-complete", task.progress === 100);
    }
  }

  function addTaskUpdate(taskId, form) {
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return;

    const textarea = form.querySelector(".update-text");
    const progressInput = form.querySelector(".update-progress");
    const text = textarea.value.trim().slice(0, 500);
    const progress = task.done ? 100 : clampProgress(progressInput.value);

    if (!text && progress === clampProgress(task.progress)) {
      textarea.focus();
      return;
    }

    task.updates.push({
      id: uid(),
      text,
      progress,
      createdAt: Date.now(),
      system: false,
    });
    task.progress = progress;

    saveTasks();
    syncHistoryForTask(task);
    render();
  }

  function clearCompleted() {
    if (!tasks.some((task) => task.done)) return;
    tasks = tasks.filter((task) => !task.done);
    saveTasks();
    render();
  }

  function clearHistory() {
    if (!history.length) return;
    history = [];
    saveHistory();
    render();
  }

  function disarmClearHistory() {
    clearHistoryArmed = false;
    window.clearTimeout(clearHistoryTimer);
    clearHistoryTimer = null;
  }

  function handleClearClick() {
    if (filter !== "history") {
      clearCompleted();
      return;
    }

    if (!history.length) return;

    if (!clearHistoryArmed) {
      clearHistoryArmed = true;
      updateClearButton();
      window.clearTimeout(clearHistoryTimer);
      clearHistoryTimer = window.setTimeout(() => {
        clearHistoryArmed = false;
        updateClearButton();
      }, 3500);
      return;
    }

    disarmClearHistory();
    clearHistory();
  }

  function removeHistoryEntry(id) {
    const node = els.historyList.querySelector(`.history-item[data-id="${CSS.escape(id)}"]`);
    const finalize = () => {
      history = history.filter((entry) => entry.id !== id);
      saveHistory();
      render();
    };

    if (!node) return finalize();
    node.classList.add("removing");
    window.setTimeout(finalize, 170);
  }

  function restoreHistoryEntry(id) {
    const entry = history.find((item) => item.id === id);
    if (!entry) return;

    history = history.filter((item) => item.id !== id);
    saveHistory();

    // The history entry itself records 100% (it was complete); the task
    // should come back at the progress from its last checkpoint instead.
    const restoreProgress = lastCheckpointProgress({
      updates: Array.isArray(entry.updates) ? entry.updates : [],
    });

    const existing = entry.taskId ? tasks.find((task) => task.id === entry.taskId) : null;

    if (existing) {
      existing.done = false;
      existing.description = entry.description || existing.description || "";
      existing.assignee = entry.assignee || existing.assignee || "";
      existing.due = entry.due;
      existing.dueTime = entry.dueTime || null;
      existing.progress = restoreProgress;
      existing.restorableProgress = null;
      if (!existing.updates.length) existing.updates = cloneUpdates(entry.updates);
    } else {
      tasks.push({
        id: uid(),
        text: entry.text,
        description: entry.description || "",
        assignee: entry.assignee || "",
        done: false,
        priority: entry.priority,
        due: entry.due,
        dueTime: entry.dueTime || null,
        progress: restoreProgress,
        restorableProgress: null,
        updates: cloneUpdates(entry.updates),
        createdAt: Date.now(),
      });
    }
    saveTasks();

    filter = "active";
    persistFilter();
    render();
  }

  function persistFilter() {
    try {
      localStorage.setItem(scopedKey("filter"), filter);
    } catch (_) {
      /* ignore */
    }
  }

  function findNode(id) {
    return els.list.querySelector(`.task[data-id="${CSS.escape(id)}"]`);
  }

  function startEdit(id) {
    if (editingId) return;

    const task = tasks.find((item) => item.id === id);
    const node = findNode(id);
    if (!task || !node) return;

    editingId = id;
    node.classList.add("editing");
    node.draggable = false;

    const textEl = node.querySelector(".task-text");
    const input = document.createElement("input");
    input.className = "edit-input";
    input.type = "text";
    input.maxLength = 200;
    input.value = task.text;
    input.setAttribute("aria-label", "Edit task title");
    textEl.replaceWith(input);

    input.focus();
    input.select();

    let finished = false;
    const finish = (commit) => {
      if (finished) return;
      finished = true;

      const value = input.value.trim();
      if (commit && value && value !== task.text) {
        task.text = value.slice(0, 200);
        saveTasks();
        syncHistoryForTask(task);
      }

      editingId = null;
      render();
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });

    input.addEventListener("blur", () => finish(true));
  }

  function reorderTasks(fromId, targetId, insertAfter) {
    const fromIndex = tasks.findIndex((task) => task.id === fromId);
    if (fromIndex === -1) return;

    const [moved] = tasks.splice(fromIndex, 1);
    let toIndex = tasks.findIndex((task) => task.id === targetId);
    if (toIndex === -1) {
      tasks.splice(fromIndex, 0, moved);
      return;
    }
    if (insertAfter) toIndex += 1;

    tasks.splice(toIndex, 0, moved);
    saveTasks();
    render();
  }

  function clearDragState() {
    draggedId = null;
    els.list.querySelectorAll(".dragging, .drag-over").forEach((node) => {
      node.classList.remove("dragging", "drag-over");
    });
  }

  /* ---------------- Theme ---------------- */

  function applyTheme(theme, persist = true) {
    document.documentElement.dataset.theme = theme;

    for (const button of els.themeToggles) {
      button.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
    }

    updateThemePicker();

    if (persist) {
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch (_) {
        /* ignore */
      }
    }
  }

  function updateThemePicker() {
    if (!els.themeLight || !els.themeDark) return;
    const theme = document.documentElement.dataset.theme;
    const isDark = theme === "dark";
    els.themeLight.setAttribute("aria-pressed", String(!isDark));
    els.themeDark.setAttribute("aria-pressed", String(isDark));
    els.themeLight.classList.toggle("active", !isDark);
    els.themeDark.classList.toggle("active", isDark);
  }

  /* ---------------- AI suggestions ---------------- */

  const AI_CATEGORY_LABELS = {
    urgent: "Needs attention",
    prioritize: "Prioritize",
    followup: "Follow-up",
    subtask: "Subtask",
    workload: "Workload",
  };

  const AI_ACTION_LABELS = {
    add: "Adds task",
    update: "Updates task",
    focus: "Review task",
  };

  function normalizeSuggestion(item) {
    if (!item || typeof item !== "object") return null;
    if (!Object.prototype.hasOwnProperty.call(AI_CATEGORY_LABELS, item.category)) return null;
    if (!Object.prototype.hasOwnProperty.call(AI_ACTION_LABELS, item.action)) return null;
    if (typeof item.title !== "string" || !item.title.trim()) return null;
    if (typeof item.reason !== "string" || !item.reason.trim()) return null;

    const priority = Object.prototype.hasOwnProperty.call(PRIORITIES, item.priority)
      ? item.priority
      : "medium";

    return {
      id: typeof item.id === "string" && item.id ? item.id : uid(),
      category: item.category,
      action: item.action,
      title: item.title.trim().slice(0, 200),
      reason: item.reason.trim().slice(0, 400),
      taskId: typeof item.taskId === "string" ? item.taskId : null,
      priority,
      due: typeof item.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.due) ? item.due : null,
      dueTime: normalizeTime(item.dueTime),
      assignee: typeof item.assignee === "string" ? item.assignee.trim().slice(0, 60) : "",
      changes: item.changes && typeof item.changes === "object" ? item.changes : {},
    };
  }

  function buildSuggestionItem(suggestion) {
    const node = els.suggestionTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = suggestion.id;

    const category = node.querySelector(".ai-category");
    category.textContent = AI_CATEGORY_LABELS[suggestion.category] || "Suggestion";
    category.dataset.category = suggestion.category;

    const action = node.querySelector(".ai-action");
    action.textContent = AI_ACTION_LABELS[suggestion.action] || "Suggestion";
    action.dataset.action = suggestion.action;

    node.querySelector(".ai-item-title").textContent = suggestion.title;
    node.querySelector(".ai-item-reason").textContent = suggestion.reason;

    const bits = [];
    if (suggestion.priority) bits.push(`${PRIORITIES[suggestion.priority] || "Medium"} priority`);
    if (suggestion.due) {
      const info = formatDue(suggestion.due, suggestion.dueTime);
      bits.push(`Due ${info.time ? `${info.label}, ${info.time}` : info.label}`);
    }
    if (suggestion.assignee) bits.push(`Assignee: ${suggestion.assignee}`);

    const target = suggestion.taskId ? tasks.find((task) => task.id === suggestion.taskId) : null;
    if (target) bits.push(`Task: ${target.text}`);

    node.querySelector(".ai-item-meta").textContent = bits.join(" · ");

    const accept = node.querySelector(".ai-accept");
    accept.textContent = suggestion.action === "focus" ? "Show task" : "Accept";
    accept.setAttribute("aria-label", `${accept.textContent}: ${suggestion.title}`);

    const dismiss = node.querySelector(".ai-dismiss");
    dismiss.setAttribute("aria-label", `Dismiss suggestion: ${suggestion.title}`);

    return node;
  }

  function renderAiPanel() {
    if (!els.aiList) return;

    els.aiSourceBadge.textContent =
      aiSource === "ai" ? "AI suggestions" : "On-device suggestions";
    els.aiSourceBadge.dataset.source = aiSource;

    if (aiNotice) {
      els.aiPanelNote.hidden = false;
      els.aiPanelNote.textContent = aiNotice;
    } else {
      els.aiPanelNote.hidden = true;
      els.aiPanelNote.textContent = "";
    }

    const fragment = document.createDocumentFragment();
    for (const suggestion of suggestions) {
      fragment.appendChild(buildSuggestionItem(suggestion));
    }
    els.aiList.replaceChildren(fragment);
    els.aiList.hidden = suggestions.length === 0;

    els.aiEmpty.hidden = aiBusy || !aiLoaded || suggestions.length > 0;
    els.aiAcceptAll.disabled = aiBusy || suggestions.length === 0;
    els.aiRefreshBtn.disabled = aiBusy;
  }

  function setAiPanelOpen(open) {
    els.aiPanel.hidden = !open;
    els.aiSuggestBtn.setAttribute("aria-expanded", String(open));
  }

  function setAiStatus(message) {
    els.aiPanelStatus.textContent = message || "";
    els.aiPanelStatus.hidden = !message;
  }

  async function loadSuggestions(force) {
    if (!currentUser || aiBusy) return;
    if (aiLoaded && !force) {
      setAiPanelOpen(true);
      return;
    }

    const userId = currentUser.id;
    const wsKey = workspaceKey();
    aiBusy = true;
    setAiPanelOpen(true);
    setAiStatus("Analyzing your tasks and workload…");
    renderAiPanel();

    try {
      // Make sure the server analyzes what is on screen right now.
      await flushState();
      if (!currentUser || workspaceKey() !== wsKey) return;
      const data = await apiRequest(aiEndpoint(), { method: "POST", body: {} });
      if (!currentUser || currentUser.id !== userId || workspaceKey() !== wsKey) return;

      const list = Array.isArray(data.suggestions) ? data.suggestions : [];
      suggestions = list.map(normalizeSuggestion).filter(Boolean);
      aiSource = data.source === "ai" ? "ai" : "local";
      aiNotice = typeof data.notice === "string" ? data.notice : "";
      aiLoaded = true;
    } catch (error) {
      if (!currentUser || currentUser.id !== userId || workspaceKey() !== wsKey) return;
      if (error.status === 401) {
        handleSessionLost();
        return;
      }
      if (error.status === 404 && wsKey.startsWith("team:")) {
        void handleTeamLost(error.message);
        return;
      }
      suggestions = [];
      aiLoaded = true;
      aiNotice = error.message || "Couldn't analyze your tasks right now.";
    } finally {
      if (currentUser && currentUser.id === userId && workspaceKey() === wsKey) {
        aiBusy = false;
        setAiStatus("");
        renderAiPanel();
      }
    }
  }

  function applySuggestion(suggestion) {
    if (suggestion.action === "add") {
      const task = {
        id: uid(),
        text: suggestion.title.slice(0, 200),
        description: "",
        assignee: suggestion.assignee || "",
        done: false,
        priority: suggestion.priority,
        due: suggestion.due,
        dueTime: suggestion.due ? suggestion.dueTime : null,
        progress: 0,
        updates: [],
        createdAt: Date.now(),
      };
      tasks.push(task);
      saveTasks();
      return { type: "add", task };
    }

    const task = tasks.find((item) => item.id === suggestion.taskId);
    if (!task) return null;

    if (suggestion.action === "update") {
      const changes = suggestion.changes || {};
      let changed = false;

      if (Object.prototype.hasOwnProperty.call(PRIORITIES, changes.priority)) {
        task.priority = changes.priority;
        changed = true;
      }
      if (typeof changes.assignee === "string") {
        task.assignee = changes.assignee.trim().slice(0, 60);
        changed = true;
      }
      if (typeof changes.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(changes.due)) {
        task.due = changes.due;
        changed = true;
      }
      if (typeof changes.dueTime === "string") {
        const time = normalizeTime(changes.dueTime);
        if (time) {
          task.dueTime = time;
          if (!task.due) task.due = toDateInputValue(new Date());
          changed = true;
        }
      }
      if (!task.due) task.dueTime = null;
      if (!changed) return null;

      saveTasks();
      syncHistoryForTask(task);
      return { type: "update", task };
    }

    if (suggestion.action === "focus") return { type: "focus", task };
    return null;
  }

  function dismissSuggestion(id) {
    suggestions = suggestions.filter((item) => item.id !== id);
    renderAiPanel();
  }

  function acceptSuggestion(id) {
    const suggestion = suggestions.find((item) => item.id === id);
    if (!suggestion) return;

    const result = applySuggestion(suggestion);
    if (!result) {
      dismissSuggestion(id);
      return;
    }

    suggestions = suggestions.filter((item) => item.id !== id);

    if (result.type === "focus") {
      filter = "all";
      persistFilter();
      expandedTaskId = result.task.id;
    } else {
      filter = "all";
      persistFilter();
    }

    render();
    renderAiPanel();

    if (result.type === "focus") {
      const node = findNode(result.task.id);
      if (node) {
        node.scrollIntoView({ block: "center", behavior: "smooth" });
        const button = node.querySelector(".updates-btn");
        if (button) button.focus({ preventScroll: true });
      }
    }
  }

  function acceptAllSuggestions() {
    if (!suggestions.length) return;

    let applied = 0;
    for (const suggestion of suggestions.slice()) {
      if (suggestion.action === "focus") continue;
      if (applySuggestion(suggestion)) applied += 1;
    }

    // Focus suggestions are just review links, so accepting all clears them too.
    suggestions = [];

    if (applied) {
      filter = "all";
      persistFilter();
      render();
    }
    renderAiPanel();
  }

  /* ---------------- Events ---------------- */

  function setFilter(next) {
    filter = next;
    disarmClearHistory();
    persistFilter();
    render();
  }

  els.authForm.addEventListener("submit", handleAuthSubmit);

  els.authTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      if (authBusy) return;
      setAuthMode(tab.dataset.authMode);
    });
  });

  els.passwordToggle.addEventListener("click", () => {
    const revealed = els.authPassword.type === "password";
    els.authPassword.type = revealed ? "text" : "password";
    els.passwordToggle.classList.toggle("revealed", revealed);
    els.passwordToggle.setAttribute("aria-pressed", String(revealed));
    els.passwordToggle.setAttribute("aria-label", revealed ? "Hide password" : "Show password");
    els.authPassword.focus();
  });

  els.userMenuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    openUserMenu(els.userMenu.hidden);
  });

  els.signOutBtn.addEventListener("click", () => {
    const email = currentUser ? currentUser.email : "";
    signOut(email);
  });

  document.addEventListener("click", (event) => {
    if (els.userMenu.hidden) return;
    if (els.userMenu.contains(event.target) || els.userMenuBtn.contains(event.target)) return;
    closeUserMenu();
  });

  /* Workspace navigation */

  els.navPersonal.addEventListener("click", () => {
    void switchWorkspace("personal");
  });

  els.navTeam.addEventListener("click", () => {
    if (workspace === "team") return;
    const target = activeTeamId || (teams.length ? teams[0].id : null);
    void switchWorkspace("team", target);
  });

  els.sideTeamList.addEventListener("click", (event) => {
    const button = event.target.closest(".side-team-link");
    if (!button) return;
    void switchWorkspace("team", button.dataset.teamId);
  });

  els.newTeamBtn.addEventListener("click", () => {
    const open = async () => {
      if (workspace !== "team" || activeTeamId !== null) {
        await switchWorkspace("team", null);
      }
      if (!els.teamSetup.hidden) els.teamNameInput.focus();
    };
    void open();
  });

  els.teamCreateForm.addEventListener("submit", createTeam);
  els.teamInviteForm.addEventListener("submit", inviteMember);

  els.teamDetailsToggle.addEventListener("click", () => {
    toggleTeamDetailsPanel();
  });

  els.teamMemberList.addEventListener("click", (event) => {
    const button = event.target.closest(".member-remove-btn");
    if (!button) return;
    const item = button.closest(".team-member-item");
    if (!item || !item.dataset.userId) return;
    void removeMember(item.dataset.userId);
  });

  els.teamPendingList.addEventListener("click", (event) => {
    const button = event.target.closest(".pending-revoke-btn");
    if (!button) return;
    const item = button.closest(".team-pending-item");
    if (!item || !item.dataset.id) return;
    void revokeInvite(item.dataset.id);
  });

  for (const list of [els.sideInviteList, els.setupInviteList]) {
    list.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      const item = button.closest(".side-invite-item");
      if (!item || !item.dataset.id) return;
      if (button.classList.contains("invite-accept-btn")) void acceptInvite(item.dataset.id);
      else if (button.classList.contains("invite-decline-btn")) void declineInvite(item.dataset.id);
    });
  }

  els.form.addEventListener("submit", addTask);

  els.aiSuggestBtn.addEventListener("click", () => {
    if (!els.aiPanel.hidden) {
      setAiPanelOpen(false);
      return;
    }
    void loadSuggestions(false);
  });

  els.aiCloseBtn.addEventListener("click", () => {
    setAiPanelOpen(false);
    els.aiSuggestBtn.focus();
  });

  els.aiRefreshBtn.addEventListener("click", () => {
    void loadSuggestions(true);
  });

  els.aiAcceptAll.addEventListener("click", acceptAllSuggestions);

  els.aiList.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const item = button.closest(".ai-item");
    if (!item) return;

    if (button.classList.contains("ai-accept")) acceptSuggestion(item.dataset.id);
    else if (button.classList.contains("ai-dismiss")) dismissSuggestion(item.dataset.id);
  });

  els.dueTime.addEventListener("change", () => {
    if (els.dueTime.value && !els.due.value) {
      els.due.value = toDateInputValue(new Date());
    }
  });

  els.due.addEventListener("change", () => {
    if (!els.due.value) els.dueTime.value = "";
  });

  els.filters.forEach((button) => {
    button.addEventListener("click", () => setFilter(button.dataset.filter));
  });

  els.clear.addEventListener("click", handleClearClick);

  els.themeToggles.forEach((button) => {
    button.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(next);
    });
  });

  els.themeLight.addEventListener("click", () => applyTheme("light"));
  els.themeDark.addEventListener("click", () => applyTheme("dark"));

  els.list.addEventListener("change", (event) => {
    const checkbox = event.target.closest(".task-check");
    if (checkbox) {
      const node = checkbox.closest(".task");
      if (node) toggleTask(node.dataset.id, checkbox.checked);
      return;
    }

    const range = event.target.closest(".detail-range");
    if (range) {
      const node = range.closest(".task");
      if (node) updateTaskProgress(node.dataset.id, range.value);
      return;
    }

    const dueInput = event.target.closest(".detail-due");
    if (dueInput) {
      const form = dueInput.closest(".detail-form");
      if (form && !dueInput.value) form.querySelector(".detail-time").value = "";
      return;
    }

    const timeInput = event.target.closest(".detail-time");
    if (timeInput) {
      const form = timeInput.closest(".detail-form");
      if (form && timeInput.value && !form.querySelector(".detail-due").value) {
        form.querySelector(".detail-due").value = toDateInputValue(new Date());
      }
    }
  });

  els.list.addEventListener("input", (event) => {
    const range = event.target.closest(".detail-range");
    if (!range) return;
    const node = range.closest(".task");
    const wrap = range.closest(".detail-progress");
    if (wrap) wrap.querySelector(".detail-progress-value").textContent = `${range.value}%`;
    if (!node) return;
    const percent = node.querySelector(".detail-percent");
    if (percent) percent.textContent = `${range.value}%`;
    const fill = node.querySelector(".detail-progress-fill");
    if (fill) fill.style.width = `${range.value}%`;
    const bar = node.querySelector(".detail-progress-bar");
    if (bar) bar.setAttribute("aria-valuenow", String(range.value));
  });

  els.list.addEventListener("submit", (event) => {
    const form = event.target;
    if (!form.classList.contains("detail-form") && !form.classList.contains("update-form")) return;
    event.preventDefault();

    const node = form.closest(".task");
    if (!node) return;

    if (form.classList.contains("detail-form")) saveTaskDetails(node.dataset.id, form);
    else addTaskUpdate(node.dataset.id, form);
  });

  els.list.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const node = button.closest(".task");
    if (!node) return;

    if (button.classList.contains("delete-btn")) deleteTask(node.dataset.id);
    else if (button.classList.contains("edit-btn")) startEdit(node.dataset.id);
    else if (button.classList.contains("updates-btn")) toggleTaskDetails(node.dataset.id);
    else if (button.classList.contains("archive-btn")) archiveTaskManually(node.dataset.id);
    else if (button.classList.contains("task-restore-btn")) restoreCompletedTask(node.dataset.id);
  });

  els.list.addEventListener("dblclick", (event) => {
    const text = event.target.closest(".task-text");
    if (!text) return;
    const node = text.closest(".task");
    if (node) startEdit(node.dataset.id);
  });

  els.historyList.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const node = button.closest(".history-item");
    if (!node) return;

    if (button.classList.contains("restore-btn")) restoreHistoryEntry(node.dataset.id);
    else if (button.classList.contains("delete-btn")) removeHistoryEntry(node.dataset.id);
  });

  /* Drag to reorder */

  els.list.addEventListener("dragstart", (event) => {
    const node = event.target.closest(".task");
    if (!node || editingId || event.target.closest(".task-detail")) {
      event.preventDefault();
      return;
    }
    draggedId = node.dataset.id;
    node.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    try {
      event.dataTransfer.setData("text/plain", draggedId);
    } catch (_) {
      /* ignore */
    }
  });

  els.list.addEventListener("dragover", (event) => {
    if (!draggedId) return;
    const node = event.target.closest(".task");
    if (!node || node.dataset.id === draggedId) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    els.list.querySelectorAll(".drag-over").forEach((el) => {
      if (el !== node) el.classList.remove("drag-over");
    });
    node.classList.add("drag-over");
  });

  els.list.addEventListener("dragleave", (event) => {
    const node = event.target.closest(".task");
    if (node && !node.contains(event.relatedTarget)) node.classList.remove("drag-over");
  });

  els.list.addEventListener("drop", (event) => {
    if (!draggedId) return;
    event.preventDefault();

    const node = event.target.closest(".task");
    if (!node || node.dataset.id === draggedId) {
      clearDragState();
      return;
    }

    const rect = node.getBoundingClientRect();
    const insertAfter = event.clientY > rect.top + rect.height / 2;
    const fromId = draggedId;
    const targetId = node.dataset.id;

    clearDragState();
    reorderTasks(fromId, targetId, insertAfter);
  });

  els.list.addEventListener("dragend", clearDragState);

  /* Keyboard shortcut: "/" jumps to the composer */

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.userMenu.hidden) {
      closeUserMenu();
      els.userMenuBtn.focus();
      return;
    }

    if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
    if (els.appView.hidden || els.taskArea.hidden) return;
    const active = document.activeElement;
    if (
      active &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.tagName === "SELECT" ||
        active.isContentEditable)
    ) {
      return;
    }
    event.preventDefault();
    els.input.focus();
  });

  /* Keep multiple open tabs in sync */

  window.addEventListener("storage", (event) => {
    if (!currentUser) return;
    if (event.key === scopedKey("filter")) {
      filter = loadFilter();
      render();
    }
  });

  if (syncChannel) {
    syncChannel.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || data.tabId === tabId) return;
      if (data.type === "teams") {
        void refreshTeams();
        return;
      }
      if (data.type === "state") {
        if (!currentUser || editingId || saveTimer || saveInFlight) return;
        void refreshStateFromServer();
      }
    });
  }

  window.addEventListener("pagehide", flushOnExit);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushOnExit();
  });

  /* React to OS theme changes when the user hasn't picked a theme */

  const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");
  const onSystemThemeChange = (event) => {
    let saved = null;
    try {
      saved = localStorage.getItem(THEME_KEY);
    } catch (_) {
      /* ignore */
    }
    if (!saved) applyTheme(event.matches ? "dark" : "light", false);
  };
  if (typeof darkMedia.addEventListener === "function") {
    darkMedia.addEventListener("change", onSystemThemeChange);
  }

  /* ---------------- Init ---------------- */

  els.dateLine.textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  window.setInterval(refreshScheduleState, 30000);

  boot();
})();

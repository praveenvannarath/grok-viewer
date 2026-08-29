(() => {
  const STORAGE_KEY = "grokViewerVideos";
  const VIEW_MODE_KEY = "grokViewerViewMode";
  const SETTINGS_KEY = "grokViewerSettings";
  const DOWNLOADED_KEY = "grokViewerDownloaded";
  const API_URL = "/rest/media/post/list";
  const DELETE_URL = "/rest/media/post/delete";
  const LIKE_URL = "/rest/media/post/like";
  const UNLIKE_URL = "/rest/media/post/unlike";
  const POST_GET_URL = "/rest/media/post/get";
  const REGEN_CONVERSATION_URL = "/rest/app-chat/conversations/new";
  const LIMIT = 40;
  // The grid loads from /rest/assets: one flat, strictly newest-first stream covering
  // every post -- both Imagine conversation media and legacy liked posts -- with the
  // conversation id inline on each asset, so tiles group without a follow-up request.
  const ASSET_URL = "/rest/assets";
  const ASSETS_PAGE_SIZE = 60;
  const ASSETS_WORKSPACE = "WORKSPACE_KIND_IMAGINE_ALL";
  const GRID_TILES_PER_PAGE = 40;
  const SOURCE = "MEDIA_POST_SOURCE_LIKED";
  const REGEN_COOLDOWN_MS = 15000;
  const REGEN_MAX_CONCURRENT = 2;
  const REGEN_LOG_LIMIT = 80;
  const REGEN_DEBUG_ENABLED = false;
  const REGEN_MICRO_LOG_ENABLED = true;
  const DEBUG_SCOPE = "viewer-embed";
  const DEBUG_LIMIT = 200;

  const getDebugStore = () => {
    if (!Array.isArray(window.__grokViewerDebugLog)) {
      window.__grokViewerDebugLog = [];
    }
    return window.__grokViewerDebugLog;
  };

  const pushDebug = (level, message, meta) => {
    const entry = {
      ts: new Date().toISOString(),
      scope: DEBUG_SCOPE,
      level,
      message,
      href: location.href,
      meta: meta || null
    };
    const store = getDebugStore();
    store.push(entry);
    if (store.length > DEBUG_LIMIT) store.splice(0, store.length - DEBUG_LIMIT);
    const logger = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    logger(`[GV][${DEBUG_SCOPE}] ${message}`, meta || "");
  };

  const debug = (message, meta) => pushDebug("log", message, meta);
  const debugWarn = (message, meta) => pushDebug("warn", message, meta);
  const debugError = (message, meta) => pushDebug("error", message, meta);

  window.__grokViewerDebugGetLogs = () => getDebugStore().slice();
  debug("script loaded", { pathname: location.pathname, search: location.search, hash: location.hash });

  const isSavedPath = location.pathname.includes("/imagine/saved");
  if (!isSavedPath) {
    debugWarn("skip bootstrap: pathname mismatch", { pathname: location.pathname });
    return;
  }

  const params = new URLSearchParams(location.search);
  const hashQuery = String(location.hash || "").replace(/^#/, "");
  const hashParams = hashQuery && hashQuery.includes("=")
    ? new URLSearchParams(hashQuery.replace(/^\?/, ""))
    : new URLSearchParams("");
  const hasViewerParam = params.has("grokViewer") || hashParams.has("grokViewer");
  if (!hasViewerParam) {
    return;
  }
  if (window.__grokViewerEmbedLoaded) {
    debugWarn("skip bootstrap: already loaded");
    return;
  }
  window.__grokViewerEmbedLoaded = true;
  debug("bootstrap accepted");

  window.addEventListener(
    "error",
    (event) => {
      debugError("window error", {
        message: event && event.message ? event.message : "",
        source: event && event.filename ? event.filename : "",
        line: event && event.lineno ? event.lineno : 0,
        column: event && event.colno ? event.colno : 0
      });
    },
    true
  );
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event && Object.prototype.hasOwnProperty.call(event, "reason") ? event.reason : "";
    debugError("unhandled rejection", { reason: String(reason && reason.message ? reason.message : reason) });
  });

  const showFatalDebugOverlay = (message) => {
    if (document.getElementById("gv-debug-fatal")) return;
    const el = document.createElement("div");
    el.id = "gv-debug-fatal";
    el.style.cssText =
      "position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;background:#1b1111;color:#ffb4b4;border:1px solid #4a1f1f;border-radius:10px;padding:12px;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;";
    el.textContent = `[GV DEBUG] ${message}`;
    (document.body || document.documentElement).appendChild(el);
  };

  const createModeState = () => ({
    cursor: null,
    exhausted: false,
    pageCache: new Map(),
    pageCursors: [null],
    seen: new Set(),
    totalLoaded: 0,
    maxPageLoaded: -1
  });

  const DEFAULT_SETTINGS = {
    downloadMode: "ask_each",
    folderPath: "",
    askEachFolderPath: "",
    bulkTarget: 32,
    autoRefreshAlways: false,
    fastBulk: true,
    downloadSettingsGuideDone: false,
    skipIntroModal: false,
    skipNestedGuide: false,
    nestedGuideShown: false,
    skipNormalGuide: false,
    normalGuideShown: false
  };

  const state = {
    items: [],
    videoItems: [],
    imageItems: [],
    mode: "videos",
    viewMode: "normal",
    selectedIndex: 0,
    busy: false,
    logsOpen: false,
    lastUpdatedAt: 0,
    knownUrls: new Set(),
    autoAdvance: false,
    autoAdvanceAll: false,
    thumbAutoplay: false,
    variantPreviewAutoplay: true,
    sortOrder: "desc",
    selectedPostIds: new Set(),
    renderToken: 0,
    pageSize: 38,
    pageByMode: { videos: 0, images: 0 },
    pageLoading: false,
    settings: { ...DEFAULT_SETTINGS },
    downloadedLookup: { videos: new Set(), images: new Set() },
    groupOrder: new Map(),
    groupLatest: new Map(),
    deleteAllRunning: { videos: false, images: false },
    assets: {
      exhausted: false,
      pageCache: new Map(),
      pageTokens: [null],
      seen: new Set(),
      totalLoaded: 0
    },
    modeState: {
      videos: createModeState(),
      images: createModeState()
    }
  };
  const THUMB_LOW_QUALITY_THRESHOLD = 50;

  const hdMetaByPostId = new Map();
  const hdProbeInFlight = new Set();
  const hdProbeQueued = new Set();
  const hdProbeQueue = [];
  const postGroupAlias = new Map();
  let hdProbeRunning = 0;
  const HD_PROBE_MAX = 2;

  const isDeleteAllRunning = (mode) =>
    Boolean(mode && state.deleteAllRunning && state.deleteAllRunning[mode]);

  const isAnyDeleteAllRunning = () => isDeleteAllRunning("videos") || isDeleteAllRunning("images");

  const isBusyFromDeleteOnly = () => Boolean(state.busy && isAnyDeleteAllRunning() && !state.pageLoading);

  const beginDeleteAllRun = (mode) => {
    if (!mode || !state.deleteAllRunning) return;
    state.deleteAllRunning[mode] = true;
    state.busy = true;
  };

  const endDeleteAllRun = (mode) => {
    if (!mode || !state.deleteAllRunning) return;
    state.deleteAllRunning[mode] = false;
    if (!isAnyDeleteAllRunning()) {
      state.busy = false;
    }
  };

  let lastUserKey = "";
  let chosenFolderHandle = null;
  const HANDLE_DB_NAME = "grokViewerHandles";
  const HANDLE_STORE = "folder";
  const HANDLE_KEY = "chosenFolder";
  const openHandleDB = () =>
    new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(HANDLE_DB_NAME, 1);
        req.onupgradeneeded = () => {
          try {
            req.result.createObjectStore(HANDLE_STORE);
          } catch (error) {}
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("idb-open-failed"));
      } catch (error) {
        reject(error);
      }
    });
  const saveFolderHandle = async (handle) => {
    if (!handle) return;
    try {
      const db = await openHandleDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(HANDLE_STORE, "readwrite");
        tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("idb-tx-failed"));
      });
      db.close();
    } catch (error) {}
  };
  const loadFolderHandle = async () => {
    try {
      const db = await openHandleDB();
      const handle = await new Promise((resolve, reject) => {
        const tx = db.transaction(HANDLE_STORE, "readonly");
        const req = tx.objectStore(HANDLE_STORE).get(HANDLE_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error || new Error("idb-get-failed"));
      });
      db.close();
      return handle || null;
    } catch (error) {
      return null;
    }
  };
  const clearFolderHandle = async () => {
    try {
      const db = await openHandleDB();
      await new Promise((resolve) => {
        const tx = db.transaction(HANDLE_STORE, "readwrite");
        tx.objectStore(HANDLE_STORE).delete(HANDLE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
      db.close();
    } catch (error) {}
  };
  const supportsFolderHandles = () => typeof window.showDirectoryPicker === "function";

  const getCookie = (name) => {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length < 2) return "";
    return parts.pop().split(";").shift() || "";
  };

  const getUserKey = () => {
    return getCookie("x-userid") || getCookie("x-anonuserid") || "";
  };

  const ensureUserScope = () =>
    new Promise((resolve) => {
      const currentKey = getUserKey();
      if (!currentKey || currentKey === lastUserKey) {
        resolve(false);
        return;
      }
      chrome.storage.local.get("grokViewerUserId", (data) => {
        const stored = data && data.grokViewerUserId ? data.grokViewerUserId : "";
        const changed = stored && stored !== currentKey;
        chrome.storage.local.set({ grokViewerUserId: currentKey }, () => {
          lastUserKey = currentKey;
          if (changed) {
            chrome.storage.local.remove(DOWNLOADED_KEY, () => {});
            resetAllModes();
            updateItems();
          }
          resolve(changed);
        });
      });
    });

  const loadSettings = () =>
    new Promise((resolve) => {
      chrome.storage.local.get(SETTINGS_KEY, (data) => {
        const stored = data && data[SETTINGS_KEY] ? data[SETTINGS_KEY] : {};
        state.settings = { ...DEFAULT_SETTINGS, ...(stored || {}) };
        state.settings.folderPath = sanitizeFolderPath(state.settings.folderPath || "");
        state.settings.askEachFolderPath = sanitizeFolderPath(state.settings.askEachFolderPath || "");
        state.settings.bulkTarget = getBulkTarget();
        resolve(state.settings);
      });
    });

  const persistSettings = () => {
    chrome.storage.local.set({ [SETTINGS_KEY]: state.settings }, () => {});
  };

  const getDownloadedStore = () =>
    new Promise((resolve) => {
      chrome.storage.local.get(DOWNLOADED_KEY, (data) => {
        const stored = data && data[DOWNLOADED_KEY] ? data[DOWNLOADED_KEY] : {};
        if (!stored.videos) stored.videos = {};
        if (!stored.images) stored.images = {};
        resolve(stored);
      });
    });

  const loadDownloadedLookup = async () => {
    const store = await getDownloadedStore();
    state.downloadedLookup = {
      videos: new Set(Object.keys(store.videos || {})),
      images: new Set(Object.keys(store.images || {}))
    };
  };

  const recordDownloadedItems = (mode, items) => {
    if (!items || !items.length) return;
    const keys = items
      .map((item) => (mode === "images" ? getImageKey(item) : getItemKey(item)))
      .filter(Boolean);
    if (!keys.length) return;
    const lookup = state.downloadedLookup && state.downloadedLookup[mode] ? state.downloadedLookup[mode] : null;
    if (lookup) keys.forEach((key) => lookup.add(key));
    chrome.storage.local.get(DOWNLOADED_KEY, (data) => {
      const stored = data && data[DOWNLOADED_KEY] ? data[DOWNLOADED_KEY] : {};
      const bucket = stored[mode] || {};
      keys.forEach((key) => {
        bucket[key] = Date.now();
      });
      stored[mode] = bucket;
      chrome.storage.local.set({ [DOWNLOADED_KEY]: stored }, () => {});
    });
  };

  const sanitizeFolderPath = (value) => {
    if (!value) return "";
    const cleaned = String(value)
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/{2,}/g, "/")
      .replace(/\.\./g, "")
      .replace(/[^a-zA-Z0-9/_-]/g, "");
    return cleaned.replace(/\/+$/, "");
  };

  const sanitizeFolderSegment = (value) => {
    if (!value) return "";
    return String(value)
      .trim()
      .replace(/[\\/]+/g, "_")
      .replace(/\.\./g, "")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 120);
  };

  const getDownloadMode = () => {
    const mode = state.settings && state.settings.downloadMode ? state.settings.downloadMode : "ask_each";
    if (mode === "ask_each" || mode === "folder_once" || mode === "default_auto") return mode;
    return "ask_each";
  };

  const getBulkTarget = () => {
    const target = Number(state.settings && state.settings.bulkTarget ? state.settings.bulkTarget : 32);
    if (target === 64 || target === 120 || target === 500) return target;
    return 32;
  };

  const getAskEachFolderPath = () =>
    sanitizeFolderPath(state.settings && state.settings.askEachFolderPath ? state.settings.askEachFolderPath : "");

  const applyFolderPrefix = (filename, folderPath) => {
    const cleanFilename = String(filename || "").replace(/^\/+/, "");
    if (!cleanFilename || !folderPath) return cleanFilename;
    if (cleanFilename.startsWith(`${folderPath}/`)) return cleanFilename;
    if (cleanFilename.includes("/")) return cleanFilename;
    return `${folderPath}/${cleanFilename}`;
  };

  const resolveDownloadFilename = (filename) => {
    const mode = getDownloadMode();
    if (mode === "folder_once") {
      const folderPath = sanitizeFolderPath(state.settings && state.settings.folderPath ? state.settings.folderPath : "");
      return applyFolderPrefix(filename, folderPath);
    }
    if (mode === "ask_each") {
      return applyFolderPrefix(filename, getAskEachFolderPath());
    }
    return filename;
  };

  const resolvePostFolderPrefix = () => {
    const mode = getDownloadMode();
    if (mode === "folder_once") {
      return sanitizeFolderPath(state.settings && state.settings.folderPath ? state.settings.folderPath : "");
    }
    if (mode === "ask_each") {
      return getAskEachFolderPath();
    }
    return "";
  };

  const resolveSaveAs = () => {
    const mode = getDownloadMode();
    if (mode === "ask_each") return true;
    return false;
  };

  const ensureFolderModeReady = async () => {
    if (getDownloadMode() !== "folder_once") return true;
    if (supportsFolderHandles() && !chosenFolderHandle) {
      const restored = await loadFolderHandle();
      if (restored) {
        chosenFolderHandle = restored;
        resetFolderProbeCache();
      }
    }
    if (!supportsFolderHandles()) {
      const existingPath = sanitizeFolderPath(state.settings && state.settings.folderPath ? state.settings.folderPath : "");
      if (existingPath) return true;
      const pickedLegacy = await pickFolderWithDialog();
      if (!pickedLegacy) return false;
      state.settings.folderPath = sanitizeFolderPath(pickedLegacy.path || "Grok-Viewer");
      state.settings.downloadMode = "folder_once";
      persistSettings();
      updateSettingsUI();
      return true;
    }
    if (chosenFolderHandle) {
      try {
        if (typeof chosenFolderHandle.queryPermission === "function") {
          let permission = await chosenFolderHandle.queryPermission({ mode: "readwrite" });
          if (permission !== "granted" && typeof chosenFolderHandle.requestPermission === "function") {
            permission = await chosenFolderHandle.requestPermission({ mode: "readwrite" });
          }
          if (permission !== "granted") return false;
        }
        return true;
      } catch (error) {}
    }
    const existing = sanitizeFolderPath(state.settings && state.settings.folderPath ? state.settings.folderPath : "");
    if (existing) return true;
    const picked = await pickFolderWithDialog();
    if (!picked) return false;
    chosenFolderHandle = picked.handle || null;
    resetFolderProbeCache();
    if (chosenFolderHandle) saveFolderHandle(chosenFolderHandle);
    state.settings.folderPath = sanitizeFolderPath(picked.path || "Grok-Viewer");
    state.settings.downloadMode = "folder_once";
    persistSettings();
    updateSettingsUI();
    return true;
  };

  const pickFolderWithDialog = async () => {
    if (supportsFolderHandles()) {
      try {
        if (window.showDirectoryPicker) {
          const handle = await window.showDirectoryPicker({ mode: "readwrite" });
          const picked = sanitizeFolderPath(handle && handle.name ? handle.name : "");
          if (picked) return { path: picked, handle };
        }
      } catch (error) {}
    }
    try {
      const picked = await new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.setAttribute("webkitdirectory", "true");
        input.setAttribute("directory", "true");
        input.multiple = true;
        input.style.display = "none";
        let resolved = false;
        const cleanup = () => {
          if (input.parentNode) input.parentNode.removeChild(input);
        };
        const finish = (value) => {
          if (resolved) return;
          resolved = true;
          cleanup();
          resolve(value);
        };
        input.onchange = () => {
          const entries = input.webkitEntries && input.webkitEntries.length ? input.webkitEntries : null;
          let folder = "";
          if (entries && entries[0]) {
            const fullPath = String(entries[0].fullPath || "");
            folder = fullPath ? fullPath.replace(/^\/+/, "").split("/")[0] : entries[0].name || "";
          }
          if (!folder) {
            const file = input.files && input.files[0] ? input.files[0] : null;
            const rel = file && file.webkitRelativePath ? String(file.webkitRelativePath) : "";
            folder = rel ? rel.split("/")[0] : "";
          }
          const cleaned = sanitizeFolderPath(folder);
          finish(cleaned ? { path: cleaned, handle: null } : null);
        };
        input.oncancel = () => finish(null);
        (document.body || document.documentElement).appendChild(input);
        input.click();
        setTimeout(() => finish(null), 45000);
      });
      return picked;
    } catch (error) {
      return null;
    }
  };

  const getFolderDisplayValue = () => {
    const folderPath = sanitizeFolderPath(state.settings && state.settings.folderPath ? state.settings.folderPath : "");
    if (!folderPath) return "";
    const tail = folderPath.split("/").filter(Boolean).pop() || folderPath;
    return `${folderPath}/${tail}`;
  };

  const pickFolderAndEnableMode = async (forcePick) => {
    const existing = sanitizeFolderPath(state.settings.folderPath || "");
    if (!supportsFolderHandles() && !forcePick && existing) {
      state.settings.downloadMode = "folder_once";
      persistSettings();
      updateSettingsUI();
      return true;
    }
    if (!forcePick && existing && chosenFolderHandle) {
      state.settings.downloadMode = "folder_once";
      persistSettings();
      updateSettingsUI();
      return true;
    }
    const picked = await pickFolderWithDialog();
    if (!picked) {
      if (!supportsFolderHandles()) {
        if (!existing) return false;
        state.settings.folderPath = existing;
        state.settings.downloadMode = "folder_once";
        persistSettings();
        updateSettingsUI();
        return true;
      }
      if (!existing || !chosenFolderHandle) return false;
      state.settings.downloadMode = "folder_once";
      persistSettings();
      updateSettingsUI();
      return true;
    }
    chosenFolderHandle = picked.handle || null;
    resetFolderProbeCache();
    if (chosenFolderHandle) saveFolderHandle(chosenFolderHandle);
    const folderPath = sanitizeFolderPath(picked.path || existing || "Grok-Viewer");
    state.settings.folderPath = folderPath || "Grok-Viewer";
    state.settings.downloadMode = "folder_once";
    persistSettings();
    updateSettingsUI();
    return true;
  };

  const getLeafFilename = (filename) => {
    const clean = String(filename || "")
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .pop();
    return clean || `grok-file-${Date.now()}`;
  };

  const splitNameExt = (filename) => {
    const leaf = getLeafFilename(filename);
    const idx = leaf.lastIndexOf(".");
    if (idx <= 0 || idx === leaf.length - 1) return { base: leaf, ext: "" };
    return { base: leaf.slice(0, idx), ext: leaf.slice(idx) };
  };

  const getUniqueLeafName = async (handle, filename) => {
    const { base, ext } = splitNameExt(filename);
    let candidate = `${base}${ext}`;
    let index = 1;
    while (index < 5000) {
      try {
        await handle.getFileHandle(candidate, { create: false });
        candidate = `${base} (${index})${ext}`;
        index += 1;
      } catch (error) {
        return candidate;
      }
    }
    return `${base}-${Date.now()}${ext}`;
  };

  const writeBlobToChosenFolder = async (blob, filename) => {
    const ready = await ensureFolderModeReady();
    if (!ready) return { ok: false, error: "folder-not-ready" };
    if (!chosenFolderHandle) return { ok: false, error: "no-handle" };
    try {
      const normalized = String(filename || "").replace(/\\/g, "/").replace(/^\/+/, "");
      const parts = normalized.split("/").filter(Boolean);
      const leafRaw = parts.pop() || `grok-file-${Date.now()}`;
      let dir = chosenFolderHandle;
      const dirSegments = [];
      for (let i = 0; i < parts.length; i += 1) {
        const safeSeg = sanitizeFolderSegment(parts[i]);
        if (!safeSeg) continue;
        dir = await dir.getDirectoryHandle(safeSeg, { create: true });
        dirSegments.push(safeSeg);
      }
      const leaf = await getUniqueLeafName(dir, leafRaw);
      const fileHandle = await dir.getFileHandle(leaf, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      const prefix = dirSegments.join("/");
      return { ok: true, filename: prefix ? `${prefix}/${leaf}` : leaf, local: true };
    } catch (error) {
      return { ok: false, error: String(error || "write-failed") };
    }
  };

  let logTimer = null;
  const logLines = [];
  const MAX_LOGS = 200;

  const formatTime = (date) =>
    `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(
      date.getSeconds()
    ).padStart(2, "0")}`;

  const addLog = () => {};

  const regenMicroLog = (...args) => {
    if (!REGEN_MICRO_LOG_ENABLED) return;
    try {
      console.log("[GV-REGEN]", ...args);
    } catch (error) {}
  };

  const addBulkDebug = () => {};

  const fetchPage = async (cursor) => {
    const body = {
      limit: LIMIT,
      filter: { source: SOURCE }
    };
    if (cursor) body.cursor = cursor;
    try {
      return await fetchJsonWithRetry(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body)
      });
    } catch (error) {
      const match = /HTTP (\d+)/.exec(String((error && error.message) || ""));
      autoRefreshLastFetchStatus = match ? Number(match[1]) : -1;
      throw error;
    }
  };

  // Bulk walks (every conversation, then a /responses call per conversation) run into
  // Grok's rate limiter. Keep one shared cooldown so a 429 anywhere pauses every later
  // request instead of each caller hammering on independently, and honour Retry-After.
  let apiCooldownUntil = 0;
  const RATE_LIMIT_BASE_MS = 2000;
  const RATE_LIMIT_MAX_MS = 30000;

  const waitForApiCooldown = async () => {
    const now = Date.now();
    if (apiCooldownUntil > now) await sleep(apiCooldownUntil - now);
  };

  const noteRateLimit = (response, attempt) => {
    let waitMs = Math.min(RATE_LIMIT_BASE_MS * Math.pow(2, attempt), RATE_LIMIT_MAX_MS);
    try {
      const header = response && response.headers ? response.headers.get("retry-after") : "";
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds > 0) {
        waitMs = Math.min(seconds * 1000, RATE_LIMIT_MAX_MS);
      }
    } catch (error) {}
    apiCooldownUntil = Date.now() + waitMs;
    return waitMs;
  };

  const fetchJsonWithRetry = async (url, init, attempts = 6) => {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await waitForApiCooldown();
      let response;
      try {
        response = await fetch(url, init);
      } catch (networkError) {
        lastError = networkError;
        await sleep(Math.min(RATE_LIMIT_BASE_MS * Math.pow(2, attempt), RATE_LIMIT_MAX_MS));
        continue;
      }
      if (response.status === 429) {
        const waitMs = noteRateLimit(response, attempt);
        lastError = new Error("HTTP 429");
        setStatus(`Rate limited by Grok; waiting ${Math.round(waitMs / 1000)}s...`);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }
    throw lastError || new Error("request failed");
  };

  const fetchAssetsPage = async (pageToken) => {
    const params = new URLSearchParams({
      pageSize: String(ASSETS_PAGE_SIZE),
      orderBy: "ORDER_BY_CREATE_TIME",
      workspaceKind: ASSETS_WORKSPACE
    });
    if (pageToken) params.set("pageToken", pageToken);
    try {
      return await fetchJsonWithRetry(`${ASSET_URL}?${params.toString()}`, {
        method: "GET",
        credentials: "include"
      });
    } catch (error) {
      const match = /HTTP (\d+)/.exec(String((error && error.message) || ""));
      autoRefreshLastFetchStatus = match ? Number(match[1]) : -1;
      throw error;
    }
  };

  const isUnavailableUrlValue = (value) => {
    const text = String(value || "").trim().toLowerCase();
    if (!text) return true;
    if (text === "-" || text === "n/a" || text === "na") return true;
    if (text === "null" || text === "undefined" || text === "none") return true;
    return /^not[\s_-]*available$/.test(text);
  };

  const normalizeUrl = (url) => {
    const raw = typeof url === "string" ? url.trim() : "";
    if (isUnavailableUrlValue(raw)) return "";
    if (raw.startsWith("http")) return raw;
    if (raw.startsWith("users/") || raw.startsWith("/users/")) {
      const trimmed = raw.replace(/^\//, "");
      return `https://assets.grok.com/${trimmed}`;
    }
    if (raw.startsWith("/imagine-public/")) {
      return `https://imagine-public.x.ai${raw}`;
    }
    if (raw.startsWith("imagine-public/")) {
      return `https://imagine-public.x.ai/${raw}`;
    }
    try {
      const resolved = new URL(raw, window.location.href).toString();
      if (/(?:\/|%2f)(?:not%20available|undefined|null)(?:\/|$|\?|#)/i.test(resolved)) {
        return "";
      }
      return resolved;
    } catch (error) {
      return "";
    }
  };

  const shouldForceLowQualityThumbs = () => {
    const mode = state && state.mode === "images" ? "images" : "videos";
    const modeState = state && state.modeState ? state.modeState[mode] : null;
    const totalLoaded = Number((modeState && modeState.totalLoaded) || 0);
    const listCount =
      mode === "images"
        ? Number((state && state.imageItems && state.imageItems.length) || 0)
        : Number((state && state.videoItems && state.videoItems.length) || 0);
    const visibleCount = Number((state && state.items && state.items.length) || 0);
    return Math.max(totalLoaded, listCount, visibleCount) > THUMB_LOW_QUALITY_THRESHOLD;
  };

  const optimizeThumbUrl = (url, options = {}) => {
    if (!url) return "";
    try {
      const parsed = new URL(url, window.location.href);
      const host = (parsed.hostname || "").toLowerCase();
      if (!host.includes("assets.grok.com") && !host.includes("imagine-public.x.ai")) return parsed.toString();
      const pathname = (parsed.pathname || "").toLowerCase();
      const isVideoPath = pathname.endsWith(".mp4") || pathname.includes("generated_video.mp4");
      if (!parsed.searchParams.has("cache")) parsed.searchParams.set("cache", "1");
      if (isVideoPath) {
        parsed.searchParams.delete("w");
        parsed.searchParams.delete("q");
        parsed.searchParams.delete("dpr");
      } else {
        const forceLow = Boolean((options && options.forceLow) || shouldForceLowQualityThumbs());
        const imageGridLow = Boolean(options && options.imageGridLow);
        if (forceLow) {
          parsed.searchParams.set("w", "44");
          parsed.searchParams.set("q", "3");
        } else {
          parsed.searchParams.set("w", imageGridLow ? "112" : "176");
          parsed.searchParams.set("q", imageGridLow ? "6" : "9");
        }
        parsed.searchParams.set("dpr", "1");
      }
      return parsed.toString();
    } catch (error) {
      return url;
    }
  };

  const buildIcon = (path, alt) => {
    const img = document.createElement("img");
    img.src = chrome.runtime.getURL(path);
    img.alt = alt || "";
    img.draggable = false;
    return img;
  };

  const isMp4 = (url, mimeType) => {
    if (mimeType === "video/mp4") return true;
    return (url || "").toLowerCase().includes(".mp4");
  };

  const isImage = (url, mimeType) => {
    if (mimeType && mimeType.startsWith("image/")) return true;
    const base = (url || "").split(/[?#]/)[0].toLowerCase();
    return base.endsWith(".jpg") || base.endsWith(".jpeg") || base.endsWith(".png") || base.endsWith(".webp");
  };

  const isGridMode = () => state.viewMode === "grid";

  const getCreatedAtValue = (post) =>
    (post &&
      (post.createTime ||
        post.createdAt ||
        post.created_at ||
        post.updateTime ||
        post.updatedAt ||
        post.updated_at ||
        post.favoritedAt ||
        post.favorited_at ||
        post.likedAt ||
        post.liked_at ||
        post.timestamp ||
        post.time ||
        "")) ||
    "";

  const toPositiveSize = (value) => {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return 0;
    return Math.round(num);
  };

  const parseOrientationHint = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1;
    const text = String(value).trim().toLowerCase();
    if (!text) return null;
    if (text.includes("portrait") || text.includes("vertical")) return true;
    if (text.includes("landscape") || text.includes("horizontal")) return false;
    const ratioMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*[:x/]\s*([0-9]+(?:\.[0-9]+)?)/);
    if (ratioMatch) {
      const a = Number(ratioMatch[1]);
      const b = Number(ratioMatch[2]);
      if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) return b > a;
    }
    const ratioNum = Number(text);
    if (Number.isFinite(ratioNum) && ratioNum > 0) return ratioNum < 1;
    return null;
  };

  const extractMediaDimensions = (post) => {
    if (!post) return { width: 0, height: 0 };
    const candidates = [
      [post.mediaWidth, post.mediaHeight],
      [post.width, post.height],
      [post.videoWidth, post.videoHeight],
      [post.imageWidth, post.imageHeight],
      [post.pixelWidth, post.pixelHeight],
      [post.displayWidth, post.displayHeight],
      [post.thumbWidth, post.thumbHeight],
      [post.thumbnailWidth, post.thumbnailHeight],
      [post.previewWidth, post.previewHeight],
      [post.hdWidth, post.hdHeight],
      [post.media && post.media.width, post.media && post.media.height],
      [post.dimensions && post.dimensions.width, post.dimensions && post.dimensions.height],
      [post.size && post.size.width, post.size && post.size.height],
      [post.metadata && post.metadata.width, post.metadata && post.metadata.height],
      [post.mediaMetadata && post.mediaMetadata.width, post.mediaMetadata && post.mediaMetadata.height]
    ];
    for (let i = 0; i < candidates.length; i += 1) {
      const pair = candidates[i];
      const width = toPositiveSize(pair[0]);
      const height = toPositiveSize(pair[1]);
      if (width && height) return { width, height };
    }
    return { width: 0, height: 0 };
  };

  const extractIsPortrait = (post, width, height) => {
    if (width && height) return height > width;
    const hints = [
      post && post.orientation,
      post && post.aspect,
      post && post.aspectRatio,
      post && post.mediaAspectRatio,
      post && post.ratio
    ];
    for (let i = 0; i < hints.length; i += 1) {
      const parsed = parseOrientationHint(hints[i]);
      if (parsed !== null) return parsed;
    }
    return null;
  };

  const gcdInt = (a, b) => {
    let x = Math.abs(Math.trunc(Number(a) || 0));
    let y = Math.abs(Math.trunc(Number(b) || 0));
    while (y) {
      const next = x % y;
      x = y;
      y = next;
    }
    return x || 1;
  };

  const normalizeAspectRatioText = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const ratioMatch = raw.match(/([0-9]+(?:\.[0-9]+)?)\s*[:x/]\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (ratioMatch) {
      const left = Number(ratioMatch[1]);
      const right = Number(ratioMatch[2]);
      if (Number.isFinite(left) && Number.isFinite(right) && left > 0 && right > 0) {
        const normLeft = Math.round(left * 1000);
        const normRight = Math.round(right * 1000);
        const div = gcdInt(normLeft, normRight);
        return `${Math.round(normLeft / div)}:${Math.round(normRight / div)}`;
      }
    }
    return "";
  };

  const pickAspectRatioFromDimensions = (width, height) => {
    const w = toPositiveSize(width);
    const h = toPositiveSize(height);
    if (!w || !h) return "2:3";
    const ratio = w / h;
    const candidates = [
      { label: "1:1", value: 1 },
      { label: "2:3", value: 2 / 3 },
      { label: "3:2", value: 3 / 2 },
      { label: "9:16", value: 9 / 16 },
      { label: "16:9", value: 16 / 9 },
      { label: "4:5", value: 4 / 5 },
      { label: "5:4", value: 5 / 4 }
    ];
    let best = candidates[0];
    let bestDiff = Math.abs(ratio - best.value);
    for (let i = 1; i < candidates.length; i += 1) {
      const diff = Math.abs(ratio - candidates[i].value);
      if (diff < bestDiff) {
        best = candidates[i];
        bestDiff = diff;
      }
    }
    return best.label;
  };

  const extractResolutionPair = (post) => {
    if (!post) return { width: 0, height: 0 };
    const fromResolution = post.resolution || {};
    const width = toPositiveSize(fromResolution.width || post.width || 0);
    const height = toPositiveSize(fromResolution.height || post.height || 0);
    return { width, height };
  };

  const parseResolutionHeightFromName = (value) => {
    const text = String(value || "").trim().toLowerCase();
    if (!text) return null;
    const match = text.match(/(\d{3,4})\s*p\b/);
    if (!match) return null;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

  const isHdResolutionMeta = (resolutionName, width, height) => {
    const namedHeight = parseResolutionHeightFromName(resolutionName);
    if (namedHeight !== null) return namedHeight >= 720;
    const w = toPositiveSize(width);
    const h = toPositiveSize(height);
    if (!w && !h) return false;
    return Math.max(w, h) >= 780;
  };

  const hasHdResolutionSignal = (item) => {
    if (!item) return false;
    if (item.isHD === true || item.isHD === false) return true;
    const namedHeight = parseResolutionHeightFromName(item.resolutionName);
    if (namedHeight !== null) return true;
    const w = toPositiveSize(item.resolutionWidth || 0);
    const h = toPositiveSize(item.resolutionHeight || 0);
    return Boolean(w || h);
  };

  const isHdVideoItem = (item) => {
    if (!item) return false;
    if (hasHdUrlCandidate(item)) return true;
    const postId = String((item && item.postId) || "").trim();
    if (item.isHD === true) return true;
    if (item.isHD === false && hasHdResolutionSignal(item)) return false;
    const cached = postId ? hdMetaByPostId.get(postId) : null;
    if (cached && cached.hasSignal) return cached.isHD === true;
    const width = toPositiveSize(item.resolutionWidth || 0);
    const height = toPositiveSize(item.resolutionHeight || 0);
    if (!parseResolutionHeightFromName(item.resolutionName) && !width && !height) return false;
    return isHdResolutionMeta(item.resolutionName, width, height);
  };

  const isHdUrl = (url) => /(?:_hd\.mp4)(?:$|[?#])/i.test(String(url || ""));

  const hasHdUrlCandidate = (item) => {
    if (!item) return false;
    const hdUrl = normalizeUrl(String(item.hdMediaUrl || ""));
    const mediaUrl = normalizeUrl(String(item.mediaUrl || item.url || ""));
    return isHdUrl(hdUrl) || isHdUrl(mediaUrl);
  };

  const getPostPromptText = (post) => {
    if (!post) return "";
    const raw =
      post.originalPrompt ||
      post.prompt ||
      post.promptText ||
      post.promptMessage ||
      post.promptUserMessage ||
      post.userPrompt ||
      post.generationPrompt ||
      (post.prompt && post.prompt.text) ||
      (post.prompt && post.prompt.content) ||
      post.textPrompt ||
      "";
    return typeof raw === "string" ? raw.trim() : raw ? String(raw).trim() : "";
  };

  const buildItem = (post, parentPostId, parentImageUrl, parentPrompt) => {
    if (!post) return null;
    const hdMediaUrl = normalizeUrl(post.hdMediaUrl || "");
    const mediaUrl = normalizeUrl(post.mediaUrl || "");
    const playbackUrl = isMp4(mediaUrl, post.mimeType) ? mediaUrl : hdMediaUrl;
    if (!isMp4(playbackUrl, post.mimeType)) return null;
    const sourceImageUrl = normalizeUrl(
      parentImageUrl ||
        post.sourceImageUrl ||
        post.parentImageUrl ||
        (post.originalPost && post.originalPost.mediaUrl) ||
        ""
    );
    const poster = optimizeThumbUrl(normalizeUrl(post.thumbnailImageUrl || post.previewImageUrl || sourceImageUrl || ""));
    const promptCandidateRaw =
      post.originalPrompt ||
      post.prompt ||
      post.promptText ||
      post.promptMessage ||
      post.promptUserMessage ||
      post.userPrompt ||
      post.generationPrompt ||
      (post.prompt && post.prompt.text) ||
      (post.prompt && post.prompt.content) ||
      post.textPrompt ||
      parentPrompt ||
      "";
    const promptCandidate =
      typeof promptCandidateRaw === "string" ? promptCandidateRaw.trim() : promptCandidateRaw ? String(promptCandidateRaw) : "";
    const explicitHasPrompt =
      post.hasPrompt === true ||
      post.canRepeat === true ||
      post.repeatable === true ||
      post.hasUserPrompt === true ||
      post.promptAvailable === true ||
      post.promptPresent === true;
    const explicitNoPrompt =
      post.hasPrompt === false ||
      post.canRepeat === false ||
      post.repeatable === false ||
      post.hasUserPrompt === false ||
      post.promptAvailable === false ||
      post.promptPresent === false;
    const looksLikeImagePrompt = /imagine-public\.x\.ai\/imagine-public\/images\//i.test(promptCandidate || "");
    const hasPrompt = explicitHasPrompt
      ? true
      : explicitNoPrompt
      ? false
      : looksLikeImagePrompt
      ? false
      : promptCandidate
      ? true
      : post.parentPostId || post.originalPostId || post.parentPost
      ? false
      : null;
    const dimensions = extractMediaDimensions(post);
    const targetResolution = extractResolutionPair(post);
    const resolutionName = String(post.resolutionName || "").trim();
    const resolutionWidth = targetResolution.width;
    const resolutionHeight = targetResolution.height;
    const hasResolutionSignal =
      parseResolutionHeightFromName(resolutionName) !== null || Boolean(resolutionWidth || resolutionHeight);
    const hasHdAsset = isHdUrl(hdMediaUrl);
    const isPortrait = extractIsPortrait(post, dimensions.width, dimensions.height);
    return {
      id: post.id || playbackUrl,
      url: playbackUrl,
      mediaUrl: playbackUrl,
      playbackUrl,
      hdMediaUrl: isMp4(hdMediaUrl, post.mimeType) ? hdMediaUrl : "",
      poster,
      postId: post.id || "",
      originalPostId: post.originalPostId || "",
      parentPostId: post.parentPostId || parentPostId || post.originalPostId || "",
      sourceImageUrl,
      promptText: looksLikeImagePrompt ? "" : promptCandidate,
      hasPrompt,
      createdAt: getCreatedAtValue(post),
      mimeType: post.mimeType || "",
      resolutionName,
      resolutionWidth,
      resolutionHeight,
      isHD: hasHdAsset ? true : hasResolutionSignal ? isHdResolutionMeta(resolutionName, resolutionWidth, resolutionHeight) : null,
      mediaWidth: dimensions.width,
      mediaHeight: dimensions.height,
      isPortrait
    };
  };

  const buildImageItem = (post, parentPostId) => {
    if (!post) return null;
    const rawUrl = post.mediaUrl || "";
    if (!isImage(rawUrl, post.mimeType)) return null;
    const url = normalizeUrl(rawUrl);
    if (!isImage(url, post.mimeType)) return null;
    const promptCandidateRaw =
      post.originalPrompt ||
      post.prompt ||
      post.promptText ||
      post.promptMessage ||
      post.promptUserMessage ||
      post.userPrompt ||
      post.generationPrompt ||
      (post.prompt && post.prompt.text) ||
      (post.prompt && post.prompt.content) ||
      post.textPrompt ||
      "";
    const promptCandidate =
      typeof promptCandidateRaw === "string" ? promptCandidateRaw.trim() : promptCandidateRaw ? String(promptCandidateRaw) : "";
    const childVideoIds = [];
    (post.childPosts || []).forEach((child) => {
      if (!child) return;
      const childUrl = child.hdMediaUrl || child.mediaUrl || "";
      if (child.id && (isMp4(childUrl, child.mimeType) || child.mediaType === "MEDIA_POST_TYPE_VIDEO")) {
        childVideoIds.push(child.id);
      }
    });
    (post.videos || []).forEach((video) => {
      if (!video) return;
      const videoUrl = video.hdMediaUrl || video.mediaUrl || "";
      if (video.id && (isMp4(videoUrl, video.mimeType) || video.mediaType === "MEDIA_POST_TYPE_VIDEO")) {
        childVideoIds.push(video.id);
      }
    });
    const dimensions = extractMediaDimensions(post);
    const isPortrait = extractIsPortrait(post, dimensions.width, dimensions.height);
    return {
      id: post.id || url,
      url,
      poster: optimizeThumbUrl(url),
      postId: post.id || "",
      originalPostId: post.originalPostId || "",
      parentPostId: post.parentPostId || post.originalPostId || parentPostId || "",
      createdAt: getCreatedAtValue(post),
      promptText: promptCandidate,
      childVideoIds,
      mediaWidth: dimensions.width,
      mediaHeight: dimensions.height,
      isPortrait
    };
  };

  // Turn a v2 asset descriptor (conversation latestAssetMetadata, or a response's
  // fileAttachmentAssetMetadata entry) into the same item shape the rest of the viewer
  // consumes. `key` is a bare "users/..." path that normalizeUrl already resolves.
  const buildItemFromAsset = (asset, conversationId, order) => {
    if (!asset || asset.isDeleted) return null;
    const key = String(asset.key || "");
    const url = normalizeUrl(key);
    if (!url) return null;
    const mimeType = String(asset.mimeType || "");
    const isVideo = isMp4(url, mimeType) || mimeType.startsWith("video/");
    if (!isVideo && !isImage(url, mimeType)) return null;
    const assetId = normalizeId(asset.assetId) || url;
    const aux = (asset && asset.auxKeys) || {};
    const previewKey = aux["preview-image"] || aux["original-image"] || "";
    const gen = (asset && asset.mediaGenInput) || {};
    const genLeaf = gen.imageToVideo || gen.textToVideo || gen.textToImage || gen.imageToImage || {};
    const promptText = String(genLeaf.prompt || "").trim();
    const width = toPositiveSize(asset.width);
    const height = toPositiveSize(asset.height);
    const base = {
      id: assetId,
      postId: normalizeId(asset.assetId),
      createdAt: asset.createTime || asset.updateTime || "",
      promptText,
      mimeType,
      originalPostId: "",
      parentPostId: normalizeId(conversationId),
      rootPostId: normalizeId(conversationId),
      postOrder: order,
      mediaWidth: width,
      mediaHeight: height,
      isPortrait: width && height ? height > width : null
    };
    if (isVideo) {
      return {
        ...base,
        kind: "video",
        url,
        mediaUrl: url,
        playbackUrl: url,
        hdMediaUrl: "",
        poster: previewKey ? optimizeThumbUrl(normalizeUrl(previewKey)) : "",
        sourceImageUrl: previewKey ? normalizeUrl(previewKey) : "",
        resolutionName: String(genLeaf.resolutionName || ""),
        resolutionWidth: 0,
        resolutionHeight: 0,
        isHD: null
      };
    }
    return {
      ...base,
      kind: "image",
      url,
      poster: optimizeThumbUrl(url),
      childVideoIds: []
    };
  };

  // The asset list carries its conversation inline, so a flat page of assets groups
  // into tiles with no follow-up request. Assets with no conversation (a handful) fall
  // back to standing alone under their own id.
  const resolveAssetConversationId = (asset) =>
    normalizeId(
      (asset && (asset.sourceConversationId || asset.currentConversationId ||
        asset.rootAssetSourceConversationId)) || ""
    );

  const extractAssetItems = (assets, orderBase = 0) => {
    const items = [];
    (assets || []).forEach((asset, index) => {
      if (!asset || asset.isDeleted) return;
      const conversationId = resolveAssetConversationId(asset) || normalizeId(asset.assetId);
      if (!conversationId) return;
      const item = buildItemFromAsset(asset, conversationId, orderBase + index);
      if (item) items.push(item);
    });
    return items;
  };

  const extractItems = (posts, orderBase = 0) => {
    const videos = [];
    const images = [];
    (posts || []).forEach((post, postIndex) => {
      const videoStart = videos.length;
      const imageStart = images.length;
      const imageItem = buildImageItem(post);
      if (imageItem) images.push(imageItem);
      const mainItem = buildItem(post);
      if (mainItem) videos.push(mainItem);
      const parentImageUrl = post && post.mediaUrl ? post.mediaUrl : "";
      const parentPrompt = post && (post.originalPrompt || post.prompt) ? post.originalPrompt || post.prompt : "";
      (post.videos || []).forEach((video) => {
        const videoItem = buildItem(video, post.id || "", parentImageUrl, parentPrompt);
        if (videoItem) videos.push(videoItem);
        const childImage = buildImageItem(video, post.id || "");
        if (childImage) images.push(childImage);
      });
      (post.childPosts || []).forEach((child) => {
        const childItem = buildItem(child, post.id || "", parentImageUrl, parentPrompt);
        if (childItem) videos.push(childItem);
        // Child posts can be images too; buildItem only handles videos, so a child
        // image would be dropped otherwise (only the top-level image is captured).
        const childImage = buildImageItem(child, post.id || "");
        if (childImage) images.push(childImage);
      });
      if (post && post.originalPost) {
        const original = post.originalPost;
        const originalImageUrl = original && original.mediaUrl ? original.mediaUrl : parentImageUrl;
        const originalPrompt =
          original && (original.originalPrompt || original.prompt)
            ? original.originalPrompt || original.prompt
            : parentPrompt;
        const originalImageItem = buildImageItem(original, post.id || "");
        if (originalImageItem) images.push(originalImageItem);
        (original.videos || []).forEach((video) => {
          const videoItem = buildItem(video, original.id || "", originalImageUrl, originalPrompt);
          if (videoItem) videos.push(videoItem);
          const childImage = buildImageItem(video, original.id || "");
          if (childImage) images.push(childImage);
        });
        (original.childPosts || []).forEach((child) => {
          const childItem = buildItem(child, original.id || "", originalImageUrl, originalPrompt);
          if (childItem) videos.push(childItem);
          const childImage = buildImageItem(child, original.id || "");
          if (childImage) images.push(childImage);
        });
      }
      // Tag everything this post produced with the post it belongs to and that post's
      // position in the API stream. The grid groups by these so it can mirror Grok's
      // own saved view -- one tile per top-level post, in the order the API returns
      // them -- instead of re-clustering and re-sorting by timestamp.
      const rootPostId = normalizeId(post && post.id);
      const postOrder = orderBase + postIndex;
      for (let i = videoStart; i < videos.length; i += 1) {
        videos[i].rootPostId = rootPostId;
        videos[i].postOrder = postOrder;
      }
      for (let i = imageStart; i < images.length; i += 1) {
        images[i].rootPostId = rootPostId;
        images[i].postOrder = postOrder;
      }
    });
    return { videos, images };
  };

  const stripUrlForKey = (url) => {
    if (!url || typeof url !== "string") return "";
    const base = url.split(/[?#]/)[0].toLowerCase();
    return base;
  };

  const extractMp4Id = (url) => {
    if (!url) return "";
    const clean = stripUrlForKey(url);
    let match = clean.match(/\/generated\/([0-9a-f-]{36})\/generated_video\.mp4$/i);
    if (match) return match[1];
    match = clean.match(/\/share-videos\/([0-9a-f-]{36})\.mp4$/i);
    if (match) return match[1];
    match = clean.match(/\/([0-9a-f-]{36})\.mp4$/i);
    return match ? match[1] : "";
  };

  const extractImageId = (url) => {
    if (!url) return "";
    const match = url.match(/imagine-public\/images\/([0-9a-f-]{36})\.(?:jpg|jpeg|png|webp)/i);
    return match ? match[1] : "";
  };

  const getVideoDedupKeys = (item) => {
    if (!item) return [];
    const keys = new Set();
    const postId = String(item.postId || "").trim();
    if (postId) keys.add(`post:${postId}`);
    const urlCandidates = [
      item.url,
      item.playbackUrl,
      item.mediaUrl,
      item.hdMediaUrl
    ]
      .map((value) => normalizeUrl(value || ""))
      .filter(Boolean);
    urlCandidates.forEach((candidate) => {
      const urlKey = stripUrlForKey(candidate);
      if (urlKey) keys.add(`url:${urlKey}`);
      const mp4Id = extractMp4Id(candidate);
      if (mp4Id) keys.add(`mp4:${mp4Id}`);
    });
    if (!keys.size) {
      const sourceKey = extractImageId(normalizeUrl(item.sourceImageUrl || item.poster || ""));
      if (sourceKey) keys.add(`src:${sourceKey}`);
    }
    return Array.from(keys);
  };

  const getItemKey = (item) => {
    const keys = getVideoDedupKeys(item);
    return keys[0] || "";
  };

  const getRawPlaybackSources = (item) => {
    if (!item) return [];
    const rawCandidates = [item.playbackUrl, item.mediaUrl, item.url, item.hdMediaUrl]
      .map((url) => normalizeUrl(url || ""))
      .filter((url) => isMp4(url, item.mimeType));
    if (!rawCandidates.length) return [];
    return Array.from(new Set(rawCandidates));
  };

  const ensurePlayableVideoItem = (item) => {
    if (!item) return false;
    const rawSources = getRawPlaybackSources(item);
    if (!rawSources.length) return false;
    const primary = rawSources[0];
    const normalizedUrl = normalizeUrl(item.url || "");
    const normalizedPlayback = normalizeUrl(item.playbackUrl || "");
    const normalizedMedia = normalizeUrl(item.mediaUrl || "");
    if (!isMp4(normalizedUrl, item.mimeType)) item.url = primary;
    if (!isMp4(normalizedPlayback, item.mimeType)) item.playbackUrl = primary;
    if (!isMp4(normalizedMedia, item.mimeType)) item.mediaUrl = primary;
    return true;
  };

  const resolveActiveItem = (item) => {
    if (!item) return null;
    if (item.variants && item.variants.length) {
      const index = Number.isFinite(item.activeIndex) ? item.activeIndex : 0;
      return item.variants[index] || item.variants[0] || item;
    }
    return item;
  };

  // Whether the media currently shown in the lightbox is an image. Mirrors the
  // isImages check in loadPlayer so controls target the right element even for a
  // mixed video+image group where state.mode (the active tab) may not match.
  const activeLightboxIsImage = () => {
    const group = state.items[state.selectedIndex];
    const item = resolveActiveItem(group) || group;
    if (!item) return state.mode === "images";
    const kind = item.kind || (state.mode === "images" ? "image" : "video");
    return kind === "image" && !!item.url && isImage(item.url, item.mimeType);
  };

  const isLandscapeMediaItem = (item) => {
    if (!item) return false;
    const width = toPositiveSize(item.mediaWidth);
    const height = toPositiveSize(item.mediaHeight);
    if (width && height) return width >= height;
    if (item.isPortrait === true) return false;
    if (item.isPortrait === false) return true;
    return false;
  };

  const getPlaybackCandidates = (item) => {
    if (!item) return [];
    const uniqueRaw = getRawPlaybackSources(item);
    if (!uniqueRaw.length) return [];
    const optimized = uniqueRaw.map((url) => optimizeThumbUrl(url));
    return Array.from(new Set(optimized.concat(uniqueRaw))).filter((url) => isMp4(url, item.mimeType));
  };

  const getThumbPreviewVideoUrl = (item) => {
    if (!item) return "";
    const candidates = getPlaybackCandidates(item);
    if (candidates.length) return candidates[0];
    const fallback = [item.url, item.playbackUrl, item.mediaUrl, item.hdMediaUrl]
      .map((url) => normalizeUrl(url || ""))
      .find((url) => isMp4(url, item.mimeType));
    return fallback || "";
  };

  let mediaPreconnectReady = false;
  const ensureMediaPreconnect = () => {
    if (mediaPreconnectReady) return;
    mediaPreconnectReady = true;
    const hosts = ["https://assets.grok.com", "https://imagine-public.x.ai", "https://grok.com"];
    hosts.forEach((host) => {
      if (document.head && document.head.querySelector(`link[data-gv-preconnect='${host}']`)) return;
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = host;
      link.crossOrigin = "anonymous";
      link.setAttribute("data-gv-preconnect", host);
      if (document.head) document.head.appendChild(link);
    });
  };

  const prewarmVideoSlots = [];
  let prewarmHostEl = null;
  const ensurePrewarmHost = () => {
    if (prewarmHostEl && prewarmHostEl.isConnected) return prewarmHostEl;
    const host = document.createElement("div");
    host.id = "gv-prewarm-host";
    host.style.cssText =
      "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;z-index:-1;";
    (document.body || document.documentElement).appendChild(host);
    prewarmHostEl = host;
    return prewarmHostEl;
  };
  const getPrewarmVideoSlot = (index) => {
    if (prewarmVideoSlots[index]) return prewarmVideoSlots[index];
    const el = document.createElement("video");
    el.muted = true;
    el.playsInline = true;
    el.preload = "auto";
    el.autoplay = false;
    el.loop = false;
    el.style.display = "none";
    const host = ensurePrewarmHost();
    if (host) host.appendChild(el);
    prewarmVideoSlots[index] = el;
    return el;
  };

  const prewarmPlaybackSource = (slotIndex, sourceUrl) => {
    const el = getPrewarmVideoSlot(slotIndex);
    if (!el || !sourceUrl) return;
    if (el.dataset.src === sourceUrl) return;
    el.dataset.src = sourceUrl;
    try {
      el.src = sourceUrl;
      el.load();
    } catch (error) {}
  };

  const prewarmAroundCurrentSelection = () => {
    if (!lightboxEl || !lightboxEl.classList.contains("open")) return;
    if (state.mode === "images" || !state.items.length) return;
    ensureMediaPreconnect();
    ensurePrewarmHost();
    const total = state.items.length;
    const indexes = [state.selectedIndex, (state.selectedIndex + 1) % total, (state.selectedIndex - 1 + total) % total];
    const seen = new Set();
    let slotIndex = 0;
    const enqueueSource = (candidateItem) => {
      const source = getPlaybackCandidates(candidateItem)[0] || "";
      if (!source || seen.has(source)) return;
      seen.add(source);
      prewarmPlaybackSource(slotIndex, source);
      slotIndex += 1;
    };
    for (let i = 0; i < indexes.length; i += 1) {
      const group = state.items[indexes[i]];
      const active = resolveActiveItem(group);
      enqueueSource(active);
      if (i === 0 && group && group.variants && group.variants.length > 1) {
        const current = Number.isFinite(group.activeIndex) ? group.activeIndex : 0;
        const nextVariant = group.variants[(current + 1) % group.variants.length];
        enqueueSource(nextVariant);
      }
      if (slotIndex >= 5) break;
    }
  };

  const resolveVariantPreview = (variant, group) => {
    const imageCandidates = [
      variant && variant.poster,
      variant && variant.sourceImageUrl,
      group && group.sourceImageUrl
    ];
    for (let i = 0; i < imageCandidates.length; i += 1) {
      const candidate = optimizeThumbUrl(normalizeUrl(imageCandidates[i] || ""));
      if (!candidate) continue;
      if (!isMp4(candidate, variant && variant.mimeType)) {
        return { url: candidate, useVideo: false };
      }
    }
    const videoCandidate = optimizeThumbUrl(
      normalizeUrl(
        (variant && (variant.playbackUrl || variant.mediaUrl || variant.url || variant.hdMediaUrl)) || ""
      )
    );
    if (!videoCandidate) return { url: "", useVideo: false };
    return { url: videoCandidate, useVideo: isMp4(videoCandidate, variant && variant.mimeType) };
  };

  const flattenGroups = (items) => {
    const flat = [];
    (items || []).forEach((item) => {
      if (item && item.variants && item.variants.length) {
        flat.push(...item.variants);
      } else if (item) {
        flat.push(item);
      }
    });
    return flat;
  };

  const normalizeId = (value) => String(value || "").trim();

  const rememberGroupAlias = (postId, groupId) => {
    const postKey = normalizeId(postId);
    const groupKey = normalizeId(groupId);
    if (!postKey || !groupKey) return;
    postGroupAlias.set(postKey, groupKey);
  };

  const resolveGroupKeyFromItem = (item, byPostId) => {
    if (!item) return "";
    const postId = normalizeId(item.postId);
    if (postId) {
      const aliased = normalizeId(postGroupAlias.get(postId));
      if (aliased) return aliased;
    }
    const originalId = normalizeId(item.originalPostId);
    if (originalId) return originalId;
    const byId = byPostId instanceof Map ? byPostId : new Map();
    const sourceImageId = extractImageId(
      normalizeUrl(String(item.sourceImageUrl || item.poster || "").trim())
    );
    if (sourceImageId) return sourceImageId;
    let parentId = normalizeId(item.parentPostId);
    let fallbackId = parentId || postId;
    const seen = new Set();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parentAliased = normalizeId(postGroupAlias.get(parentId));
      if (parentAliased) return parentAliased;
      const parentItem = byId.get(parentId);
      if (!parentItem) {
        fallbackId = parentId;
        break;
      }
      const parentOriginalId = normalizeId(parentItem.originalPostId);
      if (parentOriginalId) return parentOriginalId;
      const parentParentId = normalizeId(parentItem.parentPostId);
      const parentPostId = normalizeId(parentItem.postId);
      fallbackId = parentPostId || parentParentId || fallbackId;
      if (!parentParentId || parentParentId === parentId) break;
      parentId = parentParentId;
    }
    if (fallbackId) return fallbackId;
    return postId || getItemKey(item);
  };

  const getGroupKey = (item, byPostId) => resolveGroupKeyFromItem(item, byPostId);

  const mergeGridGroupsByRelations = (groups) => {
    const source = Array.isArray(groups) ? groups.filter(Boolean) : [];
    if (source.length <= 1) return source;
    const groupIds = source.map((entry) => normalizeId(entry && entry.groupId)).filter(Boolean);
    if (groupIds.length <= 1) return source;
    const groupIdSet = new Set(groupIds);
    const parentMap = new Map();
    groupIds.forEach((id) => parentMap.set(id, id));
    const find = (id) => {
      let root = id;
      while (parentMap.get(root) && parentMap.get(root) !== root) {
        root = parentMap.get(root);
      }
      let node = id;
      while (parentMap.get(node) && parentMap.get(node) !== node) {
        const next = parentMap.get(node);
        parentMap.set(node, root);
        node = next;
      }
      return root;
    };
    const unite = (a, b) => {
      const left = normalizeId(a);
      const right = normalizeId(b);
      if (!left || !right || !parentMap.has(left) || !parentMap.has(right)) return;
      const ra = find(left);
      const rb = find(right);
      if (!ra || !rb || ra === rb) return;
      parentMap.set(rb, ra);
    };

    const postIdToGroup = new Map();
    source.forEach((group) => {
      const gid = normalizeId(group && group.groupId);
      (group && Array.isArray(group.items) ? group.items : []).forEach((item) => {
        const pid = normalizeId(item && item.postId);
        if (!pid || postIdToGroup.has(pid)) return;
        postIdToGroup.set(pid, gid);
      });
    });

    source.forEach((group) => {
      const gid = normalizeId(group && group.groupId);
      if (!gid) return;
      const owner = postIdToGroup.get(gid);
      if (owner && owner !== gid) unite(gid, owner);
      const items = group && Array.isArray(group.items) ? group.items : [];
      items.forEach((item) => {
        if (!item) return;
        const itemPostId = normalizeId(item.postId);
        const aliasedItemGroup = normalizeId(postGroupAlias.get(itemPostId));
        if (aliasedItemGroup && aliasedItemGroup !== gid) unite(gid, aliasedItemGroup);
        const links = [item.parentPostId, item.originalPostId];
        for (let i = 0; i < links.length; i += 1) {
          const linkedId = normalizeId(links[i]);
          if (!linkedId) continue;
          const linkedOwner = postIdToGroup.get(linkedId);
          if (linkedOwner && linkedOwner !== gid) unite(gid, linkedOwner);
          const aliasedLinked = normalizeId(postGroupAlias.get(linkedId));
          if (aliasedLinked && aliasedLinked !== gid) unite(gid, aliasedLinked);
          if (groupIdSet.has(linkedId) && linkedId !== gid) unite(gid, linkedId);
        }
        const sourceImageId = extractImageId(
          normalizeUrl(String(item.sourceImageUrl || item.poster || "").trim())
        );
        if (sourceImageId) {
          const imageOwner = postIdToGroup.get(sourceImageId);
          if (imageOwner && imageOwner !== gid) unite(gid, imageOwner);
          if (groupIdSet.has(sourceImageId) && sourceImageId !== gid) unite(gid, sourceImageId);
        }
      });
    });

    const buckets = new Map();
    source.forEach((group) => {
      const gid = normalizeId(group && group.groupId);
      const root = gid ? find(gid) : gid;
      if (!buckets.has(root)) {
        buckets.set(root, { groupIds: new Set(), items: [] });
      }
      const bucket = buckets.get(root);
      if (gid) bucket.groupIds.add(gid);
      (group && Array.isArray(group.items) ? group.items : []).forEach((item) => {
        if (item) bucket.items.push(item);
      });
    });

    const merged = [];
    buckets.forEach((bucket) => {
      const sample = (bucket.items || []).find((it) => it);
      const dedupedItems =
        sample && sample.kind === "image"
          ? dedupeImageItems(bucket.items || [])
          : dedupeItems(bucket.items || []);
      const candidateIds = Array.from(bucket.groupIds || []);
      let chosen = normalizeId(candidateIds[0] || "");
      let bestScore = -1;
      candidateIds.forEach((candidateId) => {
        const cid = normalizeId(candidateId);
        if (!cid) return;
        let score = 0;
        dedupedItems.forEach((item) => {
          const postId = normalizeId(item && item.postId);
          const parentId = normalizeId(item && item.parentPostId);
          const originalId = normalizeId(item && item.originalPostId);
          const sourceImageId = extractImageId(
            normalizeUrl(String((item && (item.sourceImageUrl || item.poster)) || "").trim())
          );
          if (postId === cid) score += 2;
          if (parentId === cid) score += 5;
          if (originalId === cid) score += 7;
          if (sourceImageId && sourceImageId === cid) score += 8;
        });
        if (score > bestScore) {
          bestScore = score;
          chosen = cid;
        }
      });
      merged.push({
        groupId: chosen || normalizeId((dedupedItems[0] && dedupedItems[0].originalPostId) || ""),
        items: dedupedItems
      });
    });
    return merged;
  };

  const setsIntersect = (left, right) => {
    if (!left || !right || !left.size || !right.size) return false;
    const [small, large] = left.size <= right.size ? [left, right] : [right, left];
    for (const value of small) {
      if (large.has(value)) return true;
    }
    return false;
  };

  const buildGroupMergeSignatures = (group) => {
    const postIds = new Set();
    const mediaKeys = new Set();
    const items = group && Array.isArray(group.items) ? group.items : [];
    items.forEach((item) => {
      if (!item) return;
      const postId = normalizeId(item.postId);
      if (postId) postIds.add(postId);
      const keys = getVideoDedupKeys(item);
      keys.forEach((key) => {
        if (!key) return;
        if (key.startsWith("post:")) {
          const pid = normalizeId(key.slice(5));
          if (pid) postIds.add(pid);
          return;
        }
        mediaKeys.add(key);
      });
    });
    return { postIds, mediaKeys };
  };

  const mergeOverlappingGridGroups = (groups) => {
    const dedupForGroup = (items) => {
      const arr = items || [];
      const sample = arr.find((it) => it);
      const isImage = sample && sample.kind === "image";
      return isImage ? dedupeImageItems(arr) : dedupeItems(arr);
    };
    const merged = (Array.isArray(groups) ? groups : [])
      .filter((group) => group && Array.isArray(group.items) && group.items.length)
      .map((group) => ({
        groupId: normalizeId(group.groupId) || normalizeId((group.items[0] && group.items[0].postId) || ""),
        items: dedupForGroup(group.items || [])
      }));
    if (merged.length <= 1) return merged;
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < merged.length && !changed; i += 1) {
        const left = merged[i];
        const leftSig = buildGroupMergeSignatures(left);
        for (let j = i + 1; j < merged.length; j += 1) {
          const right = merged[j];
          const rightSig = buildGroupMergeSignatures(right);
          const overlap =
            setsIntersect(leftSig.postIds, rightSig.postIds) ||
            setsIntersect(leftSig.mediaKeys, rightSig.mediaKeys);
          if (!overlap) continue;
          left.items = dedupForGroup((left.items || []).concat(right.items || []));
          if (!left.groupId) left.groupId = right.groupId;
          merged.splice(j, 1);
          changed = true;
          break;
        }
      }
    }
    return merged;
  };

  const groupItems = (items) => {
    const byPostId = new Map();
    (items || []).forEach((item) => {
      if (state.mode === "videos" && !ensurePlayableVideoItem(item)) return;
      const postId = normalizeId(item && item.postId);
      if (!postId || byPostId.has(postId)) return;
      byPostId.set(postId, item);
    });
    const map = new Map();
    (items || []).forEach((item) => {
      if (!item) return;
      if (state.mode === "videos" && !ensurePlayableVideoItem(item)) return;
      const key = getGroupKey(item, byPostId);
      if (!key) return;
      const group = map.get(key) || { groupId: key, items: [] };
      group.items.push(item);
      map.set(key, group);
    });
    const mergedGroups = mergeOverlappingGridGroups(mergeGridGroupsByRelations(Array.from(map.values())));
    const groups = [];
    mergedGroups.forEach((group) => {
      const direction = state.sortOrder === "asc" ? 1 : -1;
      const sourceItems =
        state.mode === "videos"
          ? (group.items || []).filter((entry) => ensurePlayableVideoItem(entry))
          : (group.items || []);
      const sorted = sourceItems.slice().sort((a, b) => (toTime(a.createdAt) - toTime(b.createdAt)) * direction);
      if (!sorted.length) return;
      const primary = sorted[0] || group.items[0];
      const latestTime = toTime(primary && primary.createdAt);
      const sortKey = direction === "asc" ? latestTime : -latestTime;
      state.groupOrder.set(group.groupId, sortKey || 0);
      state.groupLatest.set(group.groupId, latestTime);
      const grouped = {
        ...primary,
        groupId: group.groupId,
        variants: sorted,
        activeIndex: 0,
        isGroup: sorted.length > 1,
        groupCount: sorted.length,
        groupSortKey: state.groupOrder.get(group.groupId) || 0
      };
      sorted.forEach((variant) => {
        rememberGroupAlias(variant && variant.postId, group.groupId);
      });
      rememberGroupAlias(grouped.postId, group.groupId);
      groups.push(grouped);
    });
    return groups.sort((a, b) => (a.groupSortKey || 0) - (b.groupSortKey || 0));
  };

  const buildKeySet = (items) => {
    const set = new Set();
    (items || []).forEach((item) => {
      const key = getItemKey(item);
      if (key) set.add(key);
    });
    return set;
  };

  const mergeItemDetails = (base, extra) => {
    const merged = { ...base };
    const mergedPrimary = normalizeUrl(merged.playbackUrl || merged.mediaUrl || merged.url || "");
    const extraPrimary = normalizeUrl(extra.playbackUrl || extra.mediaUrl || extra.url || "");
    const mergedHasPlayable = isMp4(mergedPrimary, merged.mimeType);
    const extraHasPlayable = isMp4(extraPrimary, extra.mimeType);
    const extraUrl = normalizeUrl(extra.url || "");
    if (!merged.url && extraUrl) merged.url = extraUrl;
    if (!merged.hdMediaUrl && extra.hdMediaUrl) merged.hdMediaUrl = extra.hdMediaUrl;
    if (!merged.mediaUrl && extra.mediaUrl) merged.mediaUrl = extra.mediaUrl;
    if (!merged.playbackUrl && extra.playbackUrl) merged.playbackUrl = extra.playbackUrl;
    if (!mergedHasPlayable && extraHasPlayable) {
      if (extraUrl) merged.url = extraUrl;
      if (extra.mediaUrl) merged.mediaUrl = normalizeUrl(extra.mediaUrl);
      if (extra.playbackUrl) merged.playbackUrl = normalizeUrl(extra.playbackUrl);
      if (extra.hdMediaUrl) merged.hdMediaUrl = normalizeUrl(extra.hdMediaUrl);
    }
    if (!merged.mimeType && extra.mimeType) merged.mimeType = extra.mimeType;
    if (!merged.sourceImageUrl && extra.sourceImageUrl) merged.sourceImageUrl = extra.sourceImageUrl;
    if (!merged.promptText && extra.promptText) merged.promptText = extra.promptText;
    if (!merged.parentPostId && extra.parentPostId) merged.parentPostId = extra.parentPostId;
    if (merged.hasPrompt === null || merged.hasPrompt === undefined) {
      if (extra.hasPrompt !== null && extra.hasPrompt !== undefined) merged.hasPrompt = extra.hasPrompt;
    }
    if ((!merged.mediaWidth || !merged.mediaHeight) && extra.mediaWidth && extra.mediaHeight) {
      merged.mediaWidth = extra.mediaWidth;
      merged.mediaHeight = extra.mediaHeight;
    }
    const mergedResHeight = parseResolutionHeightFromName(merged.resolutionName);
    const extraResHeight = parseResolutionHeightFromName(extra.resolutionName);
    if (
      (!merged.resolutionName && extra.resolutionName) ||
      (extraResHeight !== null && (mergedResHeight === null || extraResHeight > mergedResHeight))
    ) {
      merged.resolutionName = extra.resolutionName;
    }
    const mergedResMax = Math.max(toPositiveSize(merged.resolutionWidth), toPositiveSize(merged.resolutionHeight));
    const extraResMax = Math.max(toPositiveSize(extra.resolutionWidth), toPositiveSize(extra.resolutionHeight));
    if (
      ((!merged.resolutionWidth || !merged.resolutionHeight) && extra.resolutionWidth && extra.resolutionHeight) ||
      (extraResMax > mergedResMax && extra.resolutionWidth && extra.resolutionHeight)
    ) {
      merged.resolutionWidth = extra.resolutionWidth;
      merged.resolutionHeight = extra.resolutionHeight;
    }
    const mergedHasHdAsset = hasHdUrlCandidate(merged);
    const resolvedIsHD = isHdResolutionMeta(merged.resolutionName, merged.resolutionWidth, merged.resolutionHeight);
    const hasResolvedSignal =
      parseResolutionHeightFromName(merged.resolutionName) !== null ||
      Boolean(toPositiveSize(merged.resolutionWidth) || toPositiveSize(merged.resolutionHeight));
    merged.isHD = mergedHasHdAsset ? true : hasResolvedSignal ? resolvedIsHD : merged.isHD;
    if (merged.isPortrait === null || merged.isPortrait === undefined) {
      if (extra.isPortrait !== null && extra.isPortrait !== undefined) merged.isPortrait = extra.isPortrait;
    }
    return merged;
  };

  const pickBetterItem = (current, next) => {
    if (!current) return next;
    if (!next) return current;
    const currentHasUrl = Boolean(current.url);
    const nextHasUrl = Boolean(next.url);
    if (currentHasUrl !== nextHasUrl) {
      const primary = nextHasUrl ? next : current;
      const secondary = nextHasUrl ? current : next;
      return mergeItemDetails(primary, secondary);
    }
    const currentTime = current.createdAt ? Date.parse(current.createdAt) : 0;
    const nextTime = next.createdAt ? Date.parse(next.createdAt) : 0;
    if (nextTime !== currentTime) {
      const primary = nextTime > currentTime ? next : current;
      const secondary = nextTime > currentTime ? current : next;
      return mergeItemDetails(primary, secondary);
    }
    if (!current.poster && next.poster) return mergeItemDetails(next, current);
    if (!current.parentPostId && next.parentPostId) return mergeItemDetails(next, current);
    return mergeItemDetails(current, next);
  };

  const dedupeItems = (items) => {
    const canonical = new Map();
    const aliasToCanonical = new Map();
    (items || []).forEach((item) => {
      if (!item) return;
      if (!ensurePlayableVideoItem(item)) return;
      const keys = getVideoDedupKeys(item);
      if (!keys.length) return;
      const roots = [];
      keys.forEach((key) => {
        const root = aliasToCanonical.get(key);
        if (root && !roots.includes(root)) roots.push(root);
      });
      const primaryRoot = roots[0] || keys[0];
      let merged = pickBetterItem(canonical.get(primaryRoot), item);
      for (let i = 1; i < roots.length; i += 1) {
        const root = roots[i];
        if (!root || root === primaryRoot) continue;
        merged = pickBetterItem(merged, canonical.get(root));
        canonical.delete(root);
        aliasToCanonical.forEach((mappedRoot, aliasKey) => {
          if (mappedRoot === root) aliasToCanonical.set(aliasKey, primaryRoot);
        });
      }
      canonical.set(primaryRoot, merged);
      keys.forEach((key) => aliasToCanonical.set(key, primaryRoot));
    });
    return Array.from(canonical.values()).sort((a, b) => {
      const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
      const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
      return tb - ta;
    });
  };

  const dedupeImageItems = (items) => {
    const map = new Map();
    (items || []).forEach((item) => {
      if (!item) return;
      const key = item.postId ? `post:${item.postId}` : item.url ? `url:${stripUrlForKey(item.url)}` : "";
      if (!key) return;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, item);
        return;
      }
      const ta = existing.createdAt ? Date.parse(existing.createdAt) : 0;
      const tb = item.createdAt ? Date.parse(item.createdAt) : 0;
      map.set(key, tb > ta ? item : existing);
    });
    return Array.from(map.values()).sort((a, b) => {
      const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
      const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
      return tb - ta;
    });
  };

  const fetchAll = async () => {
    let cursor = undefined;
    let allVideos = [];
    let allImages = [];
    const seen = new Set();
    let safety = 0;
    while (true) {
      const data = await fetchPage(cursor);
      const posts = data && data.posts ? data.posts : [];
      const extracted = extractItems(posts);
      allVideos = allVideos.concat(extracted.videos || []);
      allImages = allImages.concat(extracted.images || []);
      const nextCursor = data && data.nextCursor ? data.nextCursor : undefined;
      if (!nextCursor) break;
      if (seen.has(nextCursor)) break;
      seen.add(nextCursor);
      cursor = nextCursor;
      safety += 1;
      if (safety > 200) break;
    }
    return { videos: allVideos, images: allImages };
  };

  const prunePageCache = (mode, currentPage) => {
    if (isGridMode()) return;
    const modeState = getModeState(mode);
    let removed = false;
    modeState.pageCache.forEach((value, key) => {
      if (key < currentPage - 1 || key > currentPage + 1) {
        modeState.pageCache.delete(key);
        removed = true;
      }
    });
    if (!removed) return;
    const rebuilt = new Set();
    modeState.pageCache.forEach((pageItems) => {
      (pageItems || []).forEach((item) => {
        if (mode === "images") {
          const key = getImageKey(item);
          if (key) rebuilt.add(key);
          return;
        }
        const keys = getVideoDedupKeys(item);
        keys.forEach((key) => {
          if (key) rebuilt.add(key);
        });
      });
    });
    modeState.seen = rebuilt;
  };

  const fetchAndCacheAssetsPage = async (pageIndex) => {
    const store = state.assets;
    const token = store.pageTokens[pageIndex] || null;
    const data = await fetchAssetsPage(token || undefined);
    const assets = data && Array.isArray(data.assets) ? data.assets : [];
    const items = [];
    extractAssetItems(assets, pageIndex * ASSETS_PAGE_SIZE).forEach((item) => {
      const minItem = item.kind === "image" ? minimizeImageItem(item) : minimizeVideoItem(item);
      if (!minItem) return;
      if (minItem.kind === "video" && !ensurePlayableVideoItem(minItem)) return;
      const key = normalizeId(minItem.postId);
      if (!key || store.seen.has(key)) return;
      store.seen.add(key);
      items.push(minItem);
    });
    store.pageCache.set(pageIndex, items);
    store.totalLoaded += items.length;
    const nextToken = data && data.nextPageToken ? data.nextPageToken : null;
    if (nextToken && store.pageTokens[pageIndex + 1] === undefined) {
      store.pageTokens[pageIndex + 1] = nextToken;
    }
    if (!nextToken || !assets.length) store.exhausted = true;
    invalidateGroupsMemo();
  };

  const fetchAndCachePage = async (mode, pageIndex) => {
    const modeState = getModeState(mode);
    const cursor = modeState.pageCursors[pageIndex] || null;
    const data = await fetchPage(cursor || undefined);
    const posts = data && data.posts ? data.posts : [];
    const extracted = extractItems(posts, pageIndex * LIMIT);
    const rawItems = mode === "images" ? extracted.images || [] : extracted.videos || [];
    const deduped = mode === "images" ? dedupeImageItems(rawItems) : dedupeItems(rawItems);
    const items = [];
    deduped.forEach((item) => {
      const minItem = mode === "images" ? minimizeImageItem(item) : minimizeVideoItem(item);
      if (!minItem) return;
      if (mode === "videos" && !ensurePlayableVideoItem(minItem)) return;
      const keys = mode === "images" ? [getImageKey(minItem)] : getVideoDedupKeys(minItem);
      const filteredKeys = keys.filter(Boolean);
      if (!filteredKeys.length) return;
      if (filteredKeys.some((key) => modeState.seen.has(key))) return;
      filteredKeys.forEach((key) => modeState.seen.add(key));
      items.push(minItem);
    });
    modeState.pageCache.set(pageIndex, items);
    modeState.totalLoaded += items.length;
    if (pageIndex > modeState.maxPageLoaded) modeState.maxPageLoaded = pageIndex;
    const nextCursor = data && data.nextCursor ? data.nextCursor : null;
    if (nextCursor && modeState.pageCursors[pageIndex + 1] === undefined) {
      modeState.pageCursors[pageIndex + 1] = nextCursor;
    }
    if (!nextCursor) modeState.exhausted = true;
    invalidateGroupsMemo(mode);
  };

  const ensurePageData = async (_mode, pageIndex, options = {}) => {
    const silent = !!(options && options.silent);
    if (state.pageLoading) return;
    state.pageLoading = true;
    flushPendingDeletes();
    const videoState = getModeState("videos");
    const imageState = getModeState("images");
    const fetchOneIfPossible = async (mode) => {
      const ms = getModeState(mode);
      if (ms.exhausted) return false;
      const fetchIndex = ms.pageCursors.length - 1;
      await fetchAndCachePage(mode, fetchIndex);
      return true;
    };
    try {
      if (!silent) setStatus("Loading page...");
      if (isGridMode()) {
        const requiredGroups = (pageIndex + 1) * GRID_TILES_PER_PAGE;
        let safety = 0;
        const everythingExhausted = () => state.assets.exhausted;
        while (!everythingExhausted() && safety < 500) {
          if (computeAllUnifiedItems().length >= requiredGroups) break;
          await fetchAndCacheAssetsPage(state.assets.pageTokens.length - 1);
          safety += 1;
        }
        const totalGroups = computeAllUnifiedItems().length;
        const lastUIPage = Math.max(0, Math.ceil(totalGroups / GRID_TILES_PER_PAGE) - 1);
        const bothExhausted = everythingExhausted();
        const safePage = bothExhausted
          ? Math.max(0, Math.min(pageIndex, lastUIPage))
          : pageIndex;
        state.pageByMode.videos = safePage;
        state.pageByMode.images = safePage;
        updateItems();
        return;
      }
      const ensureNonGrid = async (mode) => {
        const ms = getModeState(mode);
        if (!ms.pageCache.has(pageIndex)) {
          if (ms.pageCursors[pageIndex] !== undefined) {
            await fetchAndCachePage(mode, pageIndex);
          } else {
            while (ms.pageCursors.length <= pageIndex && !ms.exhausted) {
              const fetchIndex = ms.pageCursors.length - 1;
              await fetchAndCachePage(mode, fetchIndex);
            }
            if (ms.pageCursors[pageIndex] !== undefined && !ms.pageCache.has(pageIndex)) {
              await fetchAndCachePage(mode, pageIndex);
            }
          }
        }
      };
      await Promise.all([ensureNonGrid("videos"), ensureNonGrid("images")]);
      const maxLoaded = Math.max(videoState.maxPageLoaded, imageState.maxPageLoaded);
      const bothExhausted = videoState.exhausted && imageState.exhausted;
      const safePage = bothExhausted
        ? Math.max(0, Math.min(pageIndex, maxLoaded))
        : pageIndex;
      prunePageCache("videos", safePage);
      prunePageCache("images", safePage);
      state.pageByMode.videos = safePage;
      state.pageByMode.images = safePage;
      updateItems();
    } catch (error) {
      if (!silent) setStatus("Page load failed.");
    } finally {
      state.pageLoading = false;
      if (!silent) setReadyStatus();
    }
  };

  const goToLastPage = async () => {
    if (state.pageLoading) return;
    state.pageLoading = true;
    const videoState = getModeState("videos");
    const imageState = getModeState("images");
    try {
      setStatus("Loading last page...");
      const gridView = isGridMode();
      const exhaustOne = async (mode) => {
        const ms = getModeState(mode);
        while (!ms.exhausted) {
          const fetchIndex = ms.pageCursors.length - 1;
          await fetchAndCachePage(mode, fetchIndex);
          if (!gridView) prunePageCache(mode, ms.maxPageLoaded);
        }
      };
      if (gridView) {
        let assetSafety = 0;
        while (!state.assets.exhausted && assetSafety < 2000) {
          await fetchAndCacheAssetsPage(state.assets.pageTokens.length - 1);
          assetSafety += 1;
        }
      } else {
        await Promise.all([exhaustOne("videos"), exhaustOne("images")]);
      }
      let lastPage;
      if (gridView) {
        const totalGroups = computeAllUnifiedItems().length;
        lastPage = Math.max(0, Math.ceil(totalGroups / GRID_TILES_PER_PAGE) - 1);
      } else {
        lastPage = Math.max(0, Math.max(videoState.maxPageLoaded, imageState.maxPageLoaded));
        prunePageCache("videos", lastPage);
        prunePageCache("images", lastPage);
      }
      state.pageByMode.videos = lastPage;
      state.pageByMode.images = lastPage;
      updateItems();
    } catch (error) {
      setStatus("Page load failed.");
    } finally {
      state.pageLoading = false;
      setReadyStatus();
    }
  };

  const getModeState = (mode) => state.modeState[mode];

  const getImageKey = (item) => {
    if (!item) return "";
    if (item.postId) return `post:${item.postId}`;
    if (item.url) return `url:${stripUrlForKey(item.url)}`;
    return "";
  };

  const minimizeVideoItem = (item) =>
    item
      ? {
          kind: "video",
          id: item.id,
          url: item.url,
          mediaUrl: item.mediaUrl,
          playbackUrl: item.playbackUrl,
          poster: item.poster,
          sourceImageUrl: item.sourceImageUrl,
          postId: item.postId,
          createdAt: item.createdAt,
          promptText: item.promptText || "",
          hdMediaUrl: item.hdMediaUrl,
          mimeType: item.mimeType,
          resolutionName: item.resolutionName,
          resolutionWidth: item.resolutionWidth,
          resolutionHeight: item.resolutionHeight,
          isHD: item.isHD,
          originalPostId: item.originalPostId,
          parentPostId: item.parentPostId,
          mediaWidth: item.mediaWidth,
          mediaHeight: item.mediaHeight,
          isPortrait: item.isPortrait,
          rootPostId: item.rootPostId || "",
          postOrder: item.postOrder
        }
      : null;

  const minimizeImageItem = (item) =>
    item
      ? {
          kind: "image",
          id: item.id,
          url: item.url,
          poster: item.poster,
          postId: item.postId,
          createdAt: item.createdAt,
          promptText: item.promptText || "",
          mimeType: item.mimeType,
          originalPostId: item.originalPostId,
          parentPostId: item.parentPostId,
          childVideoIds: item.childVideoIds || [],
          mediaWidth: item.mediaWidth,
          mediaHeight: item.mediaHeight,
          isPortrait: item.isPortrait,
          rootPostId: item.rootPostId || "",
          postOrder: item.postOrder
        }
      : null;

  const getCachedItems = (mode) => {
    const modeState = getModeState(mode);
    let cacheChanged = false;
    const rebuiltSeen = new Set();
    let rebuiltTotal = 0;
    let rebuiltMaxPageLoaded = -1;
    const items = [];
    Array.from(modeState.pageCache.keys())
      .sort((a, b) => a - b)
      .forEach((key) => {
        const pageItems = modeState.pageCache.get(key) || [];
        if (mode === "videos") {
          const filtered = [];
          for (let i = 0; i < pageItems.length; i += 1) {
            const entry = pageItems[i];
            if (!entry) {
              cacheChanged = true;
              continue;
            }
            if (!ensurePlayableVideoItem(entry)) {
              cacheChanged = true;
              continue;
            }
            filtered.push(entry);
            const keys = getVideoDedupKeys(entry);
            keys.forEach((dedupeKey) => {
              if (dedupeKey) rebuiltSeen.add(dedupeKey);
            });
          }
          if (filtered.length !== pageItems.length) {
            modeState.pageCache.set(key, filtered);
          }
          if (filtered.length) rebuiltMaxPageLoaded = Math.max(rebuiltMaxPageLoaded, key);
          rebuiltTotal += filtered.length;
          items.push(...filtered);
          return;
        }
        const filteredImages = pageItems.filter(Boolean);
        if (filteredImages.length !== pageItems.length) {
          modeState.pageCache.set(key, filteredImages);
          cacheChanged = true;
        }
        if (filteredImages.length) rebuiltMaxPageLoaded = Math.max(rebuiltMaxPageLoaded, key);
        rebuiltTotal += filteredImages.length;
        items.push(...filteredImages);
      });
    if (cacheChanged) {
      modeState.totalLoaded = rebuiltTotal;
      if (mode === "videos") modeState.seen = rebuiltSeen;
      modeState.maxPageLoaded = rebuiltMaxPageLoaded;
      invalidateGroupsMemo(mode);
    }
    return items;
  };

  const resetModeState = (mode) => {
    const modeState = getModeState(mode);
    modeState.cursor = null;
    modeState.exhausted = false;
    modeState.pageCache.clear();
    modeState.pageCursors = [null];
    modeState.seen = new Set();
    modeState.totalLoaded = 0;
    modeState.maxPageLoaded = -1;
    state.pageByMode[mode] = 0;
    invalidateGroupsMemo(mode);
  };

  const resetAssetsState = () => {
    state.assets.exhausted = false;
    state.assets.pageCache.clear();
    state.assets.pageTokens = [null];
    state.assets.seen = new Set();
    state.assets.totalLoaded = 0;
  };

  const resetAllModes = () => {
    resetModeState("videos");
    resetModeState("images");
    resetAssetsState();
    state.items = [];
    state.videoItems = [];
    state.imageItems = [];
    state.groupOrder = new Map();
    state.groupLatest = new Map();
  };

  const toTime = (value) => {
    if (value === null || value === undefined) return 0;
    if (typeof value === "number" && Number.isFinite(value)) {
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return 0;
      const num = Number(trimmed);
      if (Number.isFinite(num)) return num < 1e12 ? num * 1000 : num;
      const parsed = Date.parse(trimmed);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const sortByCreatedAt = (items) => {
    const direction = state.sortOrder === "asc" ? 1 : -1;
    return (items || [])
      .slice()
      .sort((a, b) => (toTime(a.createdAt) - toTime(b.createdAt)) * direction);
  };

  const computeAllGroupsForMode = (mode) => {
    const stamp = groupsMemoStamp[mode];
    if (groupsMemoFor[mode] === stamp && groupsMemoResult[mode]) {
      return groupsMemoResult[mode];
    }
    const modeState = getModeState(mode);
    const raw = [];
    Array.from(modeState.pageCache.keys())
      .sort((a, b) => a - b)
      .forEach((key) => {
        const pageItems = modeState.pageCache.get(key) || [];
        for (let i = 0; i < pageItems.length; i += 1) {
          if (pageItems[i]) raw.push(pageItems[i]);
        }
      });
    const items = mode === "images" ? dedupeImageItems(raw) : dedupeItems(raw);
    const sorted = sortByCreatedAt(items);
    const playable = mode === "videos"
      ? sorted.filter((entry) => ensurePlayableVideoItem(entry))
      : sorted;
    const savedMode = state.mode;
    state.mode = mode;
    try {
      const result = groupItems(playable);
      groupsMemoResult[mode] = result;
      groupsMemoFor[mode] = stamp;
      return result;
    } finally {
      state.mode = savedMode;
    }
  };

  // Grok's own saved view renders one tile per top-level post returned by
  // /rest/media/post/list, in the exact order the API returns them, with that post's
  // videos and child images nested under the parent image. The API orders posts by
  // cluster recency, not by parent createTime, so re-sorting client-side by timestamp
  // scatters recent media instead of surfacing it. Mirror the API: group by the post an
  // item was extracted from, order by position in the stream, lead with the parent image.
  const buildPostOrderedGridGroups = () => {
    const buckets = new Map();
    // One source only. Legacy post ids and asset ids are the same values, so reading
    // the legacy caches too would surface the same media under two different roots.
    const caches = [state.assets.pageCache];
    caches.forEach((cache) => {
      cache.forEach((pageItems) => {
        (pageItems || []).forEach((entry) => {
          if (!entry) return;
          const root = normalizeId(entry.rootPostId) || normalizeId(entry.postId);
          if (!root) return;
          let bucket = buckets.get(root);
          if (!bucket) {
            bucket = { rootPostId: root, order: Number.MAX_SAFE_INTEGER, videos: [], images: [] };
            buckets.set(root, bucket);
          }
          const order = Number(entry.postOrder);
          if (Number.isFinite(order) && order < bucket.order) bucket.order = order;
          if (entry.kind === "image") bucket.images.push(entry);
          else bucket.videos.push(entry);
        });
      });
    });
    const ordered = Array.from(buckets.values()).sort((a, b) => a.order - b.order);
    if (state.sortOrder === "asc") ordered.reverse();
    const groups = [];
    ordered.forEach((bucket) => {
      const videos = dedupeItems(bucket.videos).filter((entry) => ensurePlayableVideoItem(entry));
      const images = dedupeImageItems(bucket.images);
      // The parent image is the top-level post itself, so its own id is the bucket root.
      const parentImage = images.find((img) => normalizeId(img && img.postId) === bucket.rootPostId) || null;
      const rest = images
        .filter((img) => img !== parentImage)
        .concat(videos)
        .sort((a, b) => toTime(a && a.createdAt) - toTime(b && b.createdAt));
      // Legacy posts lead with their parent image. Conversation buckets have no such
      // member (their root is a conversation id, not a post id), so they lead with the
      // newest asset -- what Grok puts on the tile, and stable before and after lazy
      // hydration adds the older assets. The variant strip re-sorts chronologically for
      // display either way, so this only decides the thumbnail.
      const variants = parentImage ? [parentImage].concat(rest) : rest.slice().reverse();
      if (!variants.length) return;
      const primary = variants[0];
      const latest = variants.reduce((max, entry) => Math.max(max, toTime(entry && entry.createdAt)), 0);
      const merged = {
        ...primary,
        groupId: bucket.rootPostId,
        variants,
        activeIndex: 0,
        isGroup: variants.length > 1,
        groupCount: variants.length,
        groupSortKey: bucket.order,
        groupLatestTime: latest
      };
      state.groupOrder.set(bucket.rootPostId, bucket.order);
      state.groupLatest.set(bucket.rootPostId, latest);
      variants.forEach((variant) => rememberGroupAlias(variant && variant.postId, bucket.rootPostId));
      rememberGroupAlias(merged.postId, bucket.rootPostId);
      groups.push(merged);
    });
    return groups;
  };

  let unifiedItemsMemo = { key: "", result: null };
  const computeAllUnifiedItems = () => {
    const key = `${groupsMemoStamp.videos}:${groupsMemoStamp.images}:${state.sortOrder}`;
    if (unifiedItemsMemo.result && unifiedItemsMemo.key === key) {
      return unifiedItemsMemo.result;
    }
    const result = buildPostOrderedGridGroups();
    unifiedItemsMemo = { key, result };
    return result;
  };

  const computeCurrentItems = () => {
    if (isGridMode()) {
      const merged = computeAllUnifiedItems();
      const uiPage = clampPage(state.mode);
      const start = uiPage * GRID_TILES_PER_PAGE;
      return merged.slice(start, start + GRID_TILES_PER_PAGE);
    }
    const page = clampPage(state.mode);
    const videoState = getModeState("videos");
    const imageState = getModeState("images");
    const videosPage = videoState.pageCache.get(page) || [];
    const imagesPage = imageState.pageCache.get(page) || [];
    const videosD = dedupeItems(videosPage).filter((entry) => ensurePlayableVideoItem(entry));
    const imagesD = dedupeImageItems(imagesPage);
    return sortByCreatedAt([...videosD, ...imagesD]);
  };

  const isItemDownloaded = (mode, item) => {
    if (!item) return false;
    const key = mode === "images" ? getImageKey(item) : getItemKey(item);
    if (!key) return false;
    const lookup = state.downloadedLookup && state.downloadedLookup[mode] ? state.downloadedLookup[mode] : null;
    return Boolean(lookup && lookup.has(key));
  };

  const getPageCount = (mode) => {
    const videoState = getModeState("videos");
    const imageState = getModeState("images");
    const bothExhausted = videoState.exhausted && imageState.exhausted;
    if (isGridMode()) {
      const totalGroups = computeAllUnifiedItems().length;
      const pages = Math.max(1, Math.ceil(totalGroups / GRID_TILES_PER_PAGE));
      return state.assets.exhausted ? pages : pages + 1;
    }
    const maxLoaded = Math.max(videoState.maxPageLoaded, imageState.maxPageLoaded);
    const base = Math.max(1, maxLoaded + 1);
    if (maxLoaded < 0) return 1;
    if (bothExhausted) return base;
    return base + 1;
  };

  const clampPage = (mode) => {
    const current = state.pageByMode[mode] || 0;
    let next = Math.max(0, current);
    const videoState = getModeState("videos");
    const imageState = getModeState("images");
    if (videoState.exhausted && imageState.exhausted) {
      const pageCount = getPageCount(mode);
      next = Math.min(pageCount - 1, next);
    }
    state.pageByMode.videos = next;
    state.pageByMode.images = next;
    return next;
  };

  const updatePager = () => {
    if (!prevPageBtn || !nextPageBtn || !pageInfoEl) return;
    const pageCount = getPageCount(state.mode);
    const page = clampPage(state.mode);
    const modeState = getModeState(state.mode);
    prevPageBtn.disabled = page <= 0;
    if (firstPageBtn) firstPageBtn.disabled = page <= 0;
    nextPageBtn.disabled = page >= pageCount - 1;
    if (lastPageBtn) lastPageBtn.disabled = pageCount <= 1 || (modeState.exhausted && page >= pageCount - 1);
    pageInfoEl.textContent = `Page ${page + 1} / ${pageCount}`;
    if (pageJumpBtn) pageJumpBtn.disabled = pageCount <= 1;
    if (downloadAllBtn) downloadAllBtn.textContent = "Download All";
  };

  const updateItems = () => {
    state.videoItems = getCachedItems("videos");
    state.imageItems = getCachedItems("images");
    clampPage("videos");
    clampPage("images");
    state.items = computeCurrentItems();
    state.lastUpdatedAt = Date.now();
    renderGrid();
    updateCount();
    updatePager();
  };

  const refresh = async (options = {}) => {
    const silent = !!(options && options.silent);
    const includeOtherMode = !!(options && options.includeOtherMode);
    if (state.busy) return;
    state.busy = true;
    if (!silent) setStatus("Refreshing saved...");
    addLog(silent ? "Auto refresh requested" : "Refresh requested");
    try {
      await ensureUserScope();
      const targetMode = state.mode;
      const targetPage = Math.max(0, state.pageByMode[targetMode] || 0);
      const otherMode = targetMode === "videos" ? "images" : "videos";
      const otherPage = Math.max(0, state.pageByMode[otherMode] || 0);
      resetAllModes();
      await ensurePageData(targetMode, targetPage, { silent });
      if (includeOtherMode) {
        await ensurePageData(otherMode, otherPage, { silent: true });
      }
      chrome.storage.local.set({ [STORAGE_KEY]: { items: state.videoItems, updatedAt: Date.now() } }, () => {});
      addLog(silent ? "Auto refresh completed" : "Refresh completed");
      setReadyStatus();
    } catch (error) {
      addLog(`Refresh failed: ${error.message}`);
      if (!silent) {
        setStatus("Refresh failed.");
      } else {
        setReadyStatus();
      }
    } finally {
      state.busy = false;
      updateActionButtons();
    }
  };

  const refetchApiPageInPlace = async (mode, pageIdx) => {
    const modeState = getModeState(mode);
    const cursor = modeState.pageCursors[pageIdx] || null;
    const data = await fetchPage(cursor || undefined);
    const posts = data && data.posts ? data.posts : [];
    const extracted = extractItems(posts, pageIdx * LIMIT);
    const rawItems = mode === "images" ? extracted.images || [] : extracted.videos || [];
    const deduped = mode === "images" ? dedupeImageItems(rawItems) : dedupeItems(rawItems);
    const fresh = [];
    deduped.forEach((item) => {
      const minItem = mode === "images" ? minimizeImageItem(item) : minimizeVideoItem(item);
      if (!minItem) return;
      if (mode === "videos" && !ensurePlayableVideoItem(minItem)) return;
      fresh.push(minItem);
    });
    modeState.pageCache.set(pageIdx, fresh);
    const nextCursor = data && data.nextCursor ? data.nextCursor : null;
    if (nextCursor && modeState.pageCursors[pageIdx + 1] === undefined) {
      modeState.pageCursors[pageIdx + 1] = nextCursor;
    }
  };

  const rebuildModeSeenAndTotal = (mode) => {
    const modeState = getModeState(mode);
    const rebuiltSeen = new Set();
    let rebuiltTotal = 0;
    modeState.pageCache.forEach((pageItems) => {
      (pageItems || []).forEach((entry) => {
        if (!entry) return;
        rebuiltTotal += 1;
        if (mode === "videos") {
          const keys = getVideoDedupKeys(entry);
          keys.forEach((key) => {
            if (key) rebuiltSeen.add(key);
          });
        } else {
          const key = getImageKey(entry);
          if (key) rebuiltSeen.add(key);
        }
      });
    });
    modeState.seen = rebuiltSeen;
    modeState.totalLoaded = rebuiltTotal;
  };

  const refreshCurrentPage = async () => {
    if (state.busy) return;
    state.busy = true;
    setStatus("Refreshing page...");
    addLog("Refresh current page requested");
    flushPendingDeletes();
    try {
      await ensureUserScope();
      const mode = state.mode;
      const modeState = getModeState(mode);
      const visibleItems = state.items || [];
      const visiblePostIds = new Set();
      visibleItems.forEach((entry) => {
        if (!entry) return;
        const variants = Array.isArray(entry.variants) && entry.variants.length
          ? entry.variants
          : [entry];
        variants.forEach((v) => {
          const pid = v && v.postId ? String(v.postId) : "";
          if (pid) visiblePostIds.add(pid);
        });
      });
      const pagesToRefresh = [];
      modeState.pageCache.forEach((pageItems, key) => {
        const items = pageItems || [];
        for (let i = 0; i < items.length; i += 1) {
          const pid = items[i] && items[i].postId ? String(items[i].postId) : "";
          if (pid && visiblePostIds.has(pid)) {
            pagesToRefresh.push(key);
            return;
          }
        }
      });
      if (!pagesToRefresh.length) {
        pagesToRefresh.push(state.pageByMode[mode] || 0);
      }
      pagesToRefresh.sort((a, b) => a - b);
      for (let i = 0; i < pagesToRefresh.length; i += 1) {
        try {
          await refetchApiPageInPlace(mode, pagesToRefresh[i]);
        } catch (error) {
          addLog(`Page ${pagesToRefresh[i]} refresh failed: ${error.message}`);
        }
      }
      rebuildModeSeenAndTotal(mode);
      invalidateGroupsMemo(mode);
      chrome.storage.local.set(
        { [STORAGE_KEY]: { items: state.videoItems, updatedAt: Date.now() } },
        () => {}
      );
      updateItems();
      addLog("Refresh current page done");
      setReadyStatus();
    } catch (error) {
      addLog(`Refresh current page failed: ${error.message}`);
      setStatus("Refresh failed.");
    } finally {
      state.busy = false;
      updateActionButtons();
    }
  };

  const AUTO_REFRESH_BASE_MS = 5000;
  const AUTO_REFRESH_MAX_MS = 60000;
  const AUTO_REFRESH_MAX_FAILURES = 10;

  const isAutoRefreshBackoffStatus = (status) => {
    const code = Number(status || 0);
    if (code === -1) return true;
    if (code === 408 || code === 425 || code === 429) return true;
    return code >= 500;
  };

  const computeAutoRefreshDelay = () => {
    if (autoRefreshFailures <= 0) return AUTO_REFRESH_BASE_MS;
    const exp = AUTO_REFRESH_BASE_MS * Math.pow(2, autoRefreshFailures);
    const capped = Math.min(AUTO_REFRESH_MAX_MS, exp);
    const jitter = 0.5 + Math.random() * 0.5;
    return Math.max(AUTO_REFRESH_BASE_MS, Math.round(capped * jitter));
  };

  const stopAutoRefreshLoop = () => {
    if (!autoRefreshTimer) return;
    clearTimeout(autoRefreshTimer);
    autoRefreshTimer = null;
  };

  const scheduleNextAutoRefresh = (delayOverride) => {
    stopAutoRefreshLoop();
    if (!state.settings || !state.settings.autoRefreshAlways) return;
    const delay = typeof delayOverride === "number" ? delayOverride : computeAutoRefreshDelay();
    autoRefreshTimer = setTimeout(runAutoRefreshTick, delay);
  };

  const runAutoRefreshTick = async () => {
    autoRefreshTimer = null;
    if (!state.settings || !state.settings.autoRefreshAlways) return;
    if (state.busy || state.pageLoading) {
      scheduleNextAutoRefresh(AUTO_REFRESH_BASE_MS);
      return;
    }
    autoRefreshLastFetchStatus = 0;
    try {
      await refresh({ silent: true, includeOtherMode: true });
    } finally {
      const status = autoRefreshLastFetchStatus;
      if (isAutoRefreshBackoffStatus(status)) {
        autoRefreshFailures = Math.min(autoRefreshFailures + 1, AUTO_REFRESH_MAX_FAILURES);
        addLog(`Auto refresh backoff: status=${status} failures=${autoRefreshFailures}`);
      } else {
        autoRefreshFailures = 0;
      }
      scheduleNextAutoRefresh();
    }
  };

  const updateAutoRefreshLoop = () => {
    stopAutoRefreshLoop();
    autoRefreshFailures = 0;
    if (!state.settings || !state.settings.autoRefreshAlways) return;
    scheduleNextAutoRefresh(AUTO_REFRESH_BASE_MS);
  };

  const sendToFavorites = (payload) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "grokViewerProxyToTab", payload }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false });
      });
    });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Captured from grok.com itself 2026-08-23: v2 media is removed with a plain
  // DELETE /rest/assets/{assetId} (200, no body). The legacy POST
  // /rest/media/post/delete answers 404 "Media post not found" for the same id.
  const deleteAssetById = async (assetId) => {
    const id = normalizeId(assetId);
    if (!id) return { ok: false };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await waitForApiCooldown();
      let response;
      try {
        response = await fetch(`${ASSET_URL}/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "include"
        });
      } catch (error) {
        await sleep(Math.min(RATE_LIMIT_BASE_MS * Math.pow(2, attempt), RATE_LIMIT_MAX_MS));
        continue;
      }
      if (response.status === 429) {
        noteRateLimit(response, attempt);
        continue;
      }
      return { ok: response.ok, status: response.status };
    }
    return { ok: false, status: 0 };
  };

  const deletePostDirect = async (postId) => {
    if (!postId) return { ok: false };
    if (isAssetStreamId(postId)) {
      const viaAsset = await deleteAssetById(postId);
      if (viaAsset.ok) return viaAsset;
      // Legacy media appears in the asset list under the same id, but may still only be
      // removable through the old endpoint. Fall back rather than assume either way.
      if (viaAsset.status !== 404 && viaAsset.status !== 400) return viaAsset;
    }
    const response = await fetch(DELETE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ id: postId })
    });
    return { ok: response.ok, status: response.status };
  };

  const deletePost = async (postId) => {
    if (!postId) return { ok: false };
    let direct = null;
    try {
      direct = await deletePostDirect(postId);
      if (direct && direct.ok) return direct;
    } catch (error) {
      // ignore and fallback
    }
    // The favorites fallback speaks the legacy endpoint, which 404s on v2 assets.
    if (isAssetStreamId(postId)) return direct || { ok: false };
    const result = await sendToFavorites({ action: "grokViewerDeleteOne", postId });
    if (!result || !result.ok || !result.response) {
      return { ok: false };
    }
    return { ok: Boolean(result.response.ok), status: result.response.status };
  };

  const collectImageDeleteTargetsFromPosts = (posts, imageIds, childVideoIds) => {
    const addChildVideoIds = (post) => {
      if (!post) return;
      (post.childPosts || []).forEach((child) => {
        if (!child || !child.id) return;
        const childUrl = child.hdMediaUrl || child.mediaUrl || "";
        if (isMp4(childUrl, child.mimeType) || child.mediaType === "MEDIA_POST_TYPE_VIDEO") {
          childVideoIds.add(child.id);
        }
      });
      (post.videos || []).forEach((video) => {
        if (!video || !video.id) return;
        const videoUrl = video.hdMediaUrl || video.mediaUrl || "";
        if (isMp4(videoUrl, video.mimeType) || video.mediaType === "MEDIA_POST_TYPE_VIDEO") {
          childVideoIds.add(video.id);
        }
      });
    };
    const addImagePost = (post) => {
      if (!post || !post.id) return;
      const mediaUrl = normalizeUrl(post.mediaUrl || "");
      if (!isImage(mediaUrl, post.mimeType)) return;
      imageIds.add(post.id);
      addChildVideoIds(post);
    };
    (posts || []).forEach((post) => {
      if (!post) return;
      addImagePost(post);
      if (post.originalPost) addImagePost(post.originalPost);
    });
  };

  const collectAllImageDeleteTargets = async (shouldCancel) => {
    let cursor = undefined;
    const seen = new Set();
    const imageIds = new Set();
    const childVideoIds = new Set();
    let safety = 0;
    while (true) {
      if (shouldCancel && shouldCancel()) {
        return { canceled: true, imageIds: [], childVideoIds: [] };
      }
      const data = await fetchPage(cursor);
      const posts = data && data.posts ? data.posts : [];
      collectImageDeleteTargetsFromPosts(posts, imageIds, childVideoIds);
      const nextCursor = data && data.nextCursor ? data.nextCursor : undefined;
      if (!nextCursor || seen.has(nextCursor)) break;
      seen.add(nextCursor);
      cursor = nextCursor;
      safety += 1;
      if (safety > 260) break;
    }
    return {
      canceled: false,
      imageIds: Array.from(imageIds),
      childVideoIds: Array.from(childVideoIds)
    };
  };

  const runPool = async (items, concurrency, worker, shouldCancel) => {
    const queue = Array.isArray(items) ? items : [];
    const workersCount = Math.max(1, Math.min(Number(concurrency) || 1, queue.length || 1));
    let nextIndex = 0;
    const runOne = async () => {
      while (nextIndex < queue.length) {
        if (shouldCancel && shouldCancel()) return;
        const currentIndex = nextIndex;
        nextIndex += 1;
        const next = queue[currentIndex];
        if (!next) continue;
        await worker(next);
      }
    };
    const workers = [];
    for (let i = 0; i < workersCount; i += 1) {
      workers.push(runOne());
    }
    await Promise.all(workers);
  };

  const isDeleteAlreadyGoneStatus = (status) => {
    const code = Number(status || 0);
    return code === 404 || code === 410;
  };

  const isRetryableDeleteStatus = (status) => {
    const code = Number(status || 0);
    if (!code) return true;
    if (code === 408 || code === 409 || code === 425 || code === 429) return true;
    return code >= 500;
  };

  // Every loaded item, across the legacy per-mode caches AND the v2 conversation cache.
  // Collectors that walked only the mode caches silently missed all conversation media.
  const forEachLoadedEntry = (visit) => {
    const caches = [
      state.assets.pageCache,
      getModeState("videos").pageCache,
      getModeState("images").pageCache
    ];
    caches.forEach((cache) => {
      cache.forEach((pageItems) => {
        (pageItems || []).forEach((entry) => {
          if (entry) visit(entry);
        });
      });
    });
  };

  const collectCascadingPostIds = (rootPostIds) => {
    const allEntries = [];
    forEachLoadedEntry((entry) => allEntries.push(entry));
    const byId = new Map();
    allEntries.forEach((entry) => {
      const pid = normalizeId(entry.postId);
      if (pid && !byId.has(pid)) byId.set(pid, entry);
    });
    const result = new Set();
    const queue = [];
    const pushMaybe = (id) => {
      const norm = normalizeId(id);
      if (norm && !result.has(String(norm))) queue.push(String(norm));
    };
    (rootPostIds || []).forEach((id) => pushMaybe(id));
    while (queue.length) {
      const pid = queue.pop();
      if (!pid || result.has(pid)) continue;
      result.add(pid);
      const entry = byId.get(pid);
      if (!entry) continue;
      pushMaybe(entry.originalPostId);
      pushMaybe(entry.parentPostId);
      const childVideoIds = Array.isArray(entry.childVideoIds) ? entry.childVideoIds : [];
      childVideoIds.forEach((cid) => pushMaybe(cid));
      for (let i = 0; i < allEntries.length; i += 1) {
        const other = allEntries[i];
        if (!other) continue;
        const op = normalizeId(other.parentPostId);
        const oo = normalizeId(other.originalPostId);
        if (op === pid || oo === pid) pushMaybe(other.postId);
      }
    }
    return result;
  };

  const deletePostWithRetry = async (postId, maxRetries) => {
    const retries = Math.max(0, Number(maxRetries) || 0);
    let attempt = 0;
    while (attempt <= retries) {
      let result = null;
      try {
        result = await deletePost(postId);
      } catch (error) {
        result = { ok: false, status: 0 };
      }
      if (result && (result.ok || isDeleteAlreadyGoneStatus(result.status))) {
        return { ok: true, status: result.status || 200 };
      }
      if (attempt >= retries || !isRetryableDeleteStatus(result && result.status)) {
        return { ok: false, status: result ? result.status : 0 };
      }
      attempt += 1;
      await sleep(110 * attempt);
    }
    return { ok: false, status: 0 };
  };

  const likePostDirect = async (postId) => {
    if (!postId) return { ok: false };
    const response = await fetch(LIKE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ id: postId })
    });
    return { ok: response.ok, status: response.status };
  };

  const likePost = async (postId) => {
    if (!postId) return { ok: false };
    try {
      const direct = await likePostDirect(postId);
      return direct;
    } catch (error) {
      return { ok: false };
    }
  };

  const unlikePostDirect = async (postId) => {
    if (!postId) return { ok: false };
    const response = await fetch(UNLIKE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ id: postId })
    });
    return { ok: response.ok, status: response.status };
  };

  const unlikePost = async (postId) => {
    if (!postId) return { ok: false };
    try {
      const direct = await unlikePostDirect(postId);
      if (direct.ok) return direct;
    } catch (error) {
      return { ok: false };
    }
    return { ok: false };
  };

  const clearRemovedVideoPostState = (postIds) => {
    const removedIds = new Set(
      Array.from(postIds || [])
        .map((id) => normalizeId(id))
        .filter(Boolean)
    );
    if (!removedIds.size) return;
    removedIds.forEach((id) => {
      postGroupAlias.delete(id);
      newGenerationHighlightIds.delete(id);
      hydratedNewVideoPosts.delete(id);
      regenState.jobs.delete(id);
    });
    Array.from(postGroupAlias.entries()).forEach(([postId, groupId]) => {
      const postKey = normalizeId(postId);
      const groupKey = normalizeId(groupId);
      if (removedIds.has(postKey) || removedIds.has(groupKey)) {
        postGroupAlias.delete(postId);
      }
    });
    Array.from(variantHydrationInFlight).forEach((key) => {
      const entry = String(key || "");
      for (const id of removedIds) {
        if (entry.includes(id)) {
          variantHydrationInFlight.delete(key);
          break;
        }
      }
    });
    Array.from(variantHydrationTouched.keys()).forEach((key) => {
      const entry = String(key || "");
      for (const id of removedIds) {
        if (entry.includes(id)) {
          variantHydrationTouched.delete(key);
          break;
        }
      }
    });
  };

  const removeVideoPostFromCache = (postId) => {
    const targetId = normalizeId(postId);
    if (!targetId) return false;
    const modeState = getModeState("videos");
    let changed = false;
    modeState.pageCache.forEach((pageItems, key) => {
      const filtered = (pageItems || []).filter((entry) => normalizeId(entry && entry.postId) !== targetId);
      if (filtered.length !== (pageItems || []).length) {
        modeState.pageCache.set(key, filtered);
        changed = true;
      }
    });
    if (!changed) return false;
    const rebuiltSeen = new Set();
    let rebuiltTotal = 0;
    let rebuiltMaxPageLoaded = -1;
    modeState.pageCache.forEach((pageItems, pageKey) => {
      const list = pageItems || [];
      if (list.length) rebuiltMaxPageLoaded = Math.max(rebuiltMaxPageLoaded, pageKey);
      list.forEach((entry) => {
        if (!entry || !ensurePlayableVideoItem(entry)) return;
        rebuiltTotal += 1;
        const keys = getVideoDedupKeys(entry);
        keys.forEach((dedupeKey) => {
          if (dedupeKey) rebuiltSeen.add(dedupeKey);
        });
      });
    });
    modeState.totalLoaded = rebuiltTotal;
    modeState.seen = rebuiltSeen;
    modeState.maxPageLoaded = rebuiltMaxPageLoaded;
    invalidateGroupsMemo("videos");
    clearRemovedVideoPostState([targetId]);
    return true;
  };

  const quarantineBrokenVideoPost = (postId) => {
    const targetId = normalizeId(postId);
    if (!targetId) return;
    if (brokenThumbPostIds.has(targetId)) return;
    brokenThumbPostIds.add(targetId);
    setTimeout(() => {
      const changed = removeVideoPostFromCache(targetId);
      if (changed) {
        const lightboxOpenNow = Boolean(lightboxEl && lightboxEl.classList.contains("open"));
        if (lightboxOpenNow) {
          const active = resolveActiveItem(state.items[state.selectedIndex]);
          const activeId = normalizeId(active && active.postId);
          if (activeId === targetId) closeLightbox();
        }
        updateItems();
        updateActionButtons();
      }
      brokenThumbPostIds.delete(targetId);
    }, 0);
  };

  const deleteItem = async (item) => {
    const targetItem = resolveActiveItem(item);
    if (!targetItem || !targetItem.postId || state.busy) return;
    if (!window.confirm("Delete this post and all related posts (original + variants + children)?")) return;
    playActionAudio("delete");
    state.busy = true;
    updateActionButtons();
    const isImages = state.mode === "images" && targetItem.url && isImage(targetItem.url, targetItem.mimeType);
    const ids = Array.from(collectDeleteTargetIds([targetItem.postId]));
    if (!ids.length) {
      state.busy = false;
      updateActionButtons();
      return;
    }
    const total = ids.length;
    const totalSafe = Math.max(1, total);
    let processed = 0;
    let successCount = 0;
    const failed = [];
    setStatus(total === 1 ? "Deleting post..." : `Deleting ${total} posts...`);
    showDeleteProgress(`Deleting 0/${total}`, 0);
    await runPool(
      ids,
      Math.min(6, Math.max(3, Number(navigator.hardwareConcurrency) || 4)),
      async (postId) => {
        const result = await deletePostWithRetry(postId, 2);
        processed += 1;
        if (result && result.ok) {
          successCount += 1;
          animateThumbRemoval(postId);
        } else {
          failed.push(postId);
        }
        showDeleteProgress(`Deleting ${processed}/${total}`, processed / totalSafe);
      }
    );
    const removedIds = new Set(ids.filter((id) => !failed.includes(id)));
    if (removedIds.size) {
      removedIds.forEach((id) => {
        const norm = normalizeId(id);
        if (norm) pendingDeleteMarkers.add(String(norm));
      });
      invalidateGroupsMemo();
    }
    const lightboxOpenNow = Boolean(lightboxEl && lightboxEl.classList.contains("open"));
    if (lightboxOpenNow) {
      updateItems();
      if (!state.items.length) {
        closeLightbox();
      } else {
        state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, state.items.length - 1));
        loadPlayer();
      }
    } else {
      applyBlurToMarkedThumbs();
    }
    state.busy = false;
    if (failed.length) {
      setStatus(`Failed ${failed.length} deletion${failed.length === 1 ? "" : "s"}.`);
      showToast("Some deletions failed.", "error");
    } else if (successCount > 0) {
      setStatus(
        successCount === 1
          ? isImages ? "Image deleted." : "Video deleted."
          : `${successCount} posts deleted.`
      );
      showDeleteDone("Deleted");
    } else {
      setStatus("No posts deleted.");
    }
    hideDownloadProgress(0);
    updateActionButtons();
  };

  const deleteOne = async () => {
    const item = state.items[state.selectedIndex];
    if (!item) return;
    deleteItem(item);
  };

  const deleteWholeCompilation = async (groupArg) => {
    if (!isGridMode() || state.mode !== "videos") return;
    const group = groupArg || state.items[state.selectedIndex];
    if (!group || !Array.isArray(group.variants) || group.variants.length <= 1) return;
    if (state.busy) return;
    if (!window.confirm("Delete the whole compilation (and its original post + children)?")) return;
    playActionAudio("delete");
    state.busy = true;
    updateActionButtons();
    const variantIds = (group.variants || [])
      .map((variant) => String((variant && variant.postId) || "").trim())
      .filter(Boolean);
    const ids = Array.from(collectCascadingPostIds(variantIds));
    if (!ids.length) {
      state.busy = false;
      updateActionButtons();
      return;
    }
    const total = ids.length;
    const totalSafe = Math.max(1, total);
    let processed = 0;
    let successCount = 0;
    const failed = [];
    setStatus("Deleting compilation...");
    showDeleteProgress(`Deleting compilation 0/${total}`, 0);
    await runPool(
      ids,
      Math.min(6, Math.max(3, Number(navigator.hardwareConcurrency) || 4)),
      async (postId) => {
        const result = await deletePostWithRetry(postId, 2);
        processed += 1;
        if (result && result.ok) {
          successCount += 1;
          animateThumbRemoval(postId);
        } else {
          failed.push(postId);
        }
        showDeleteProgress(`Deleting compilation ${processed}/${total}`, processed / totalSafe);
      }
    );

    const removedIds = new Set(ids.filter((id) => !failed.includes(id)));
    if (removedIds.size) {
      removedIds.forEach((id) => {
        const norm = normalizeId(id);
        if (norm) pendingDeleteMarkers.add(String(norm));
      });
      invalidateGroupsMemo("videos");
    }

    const lightboxOpenNow = Boolean(lightboxEl && lightboxEl.classList.contains("open"));
    if (lightboxOpenNow) {
      updateItems();
      if (!state.items.length) {
        closeLightbox();
      } else {
        state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, state.items.length - 1));
        loadPlayer();
      }
    } else {
      applyBlurToMarkedThumbs();
    }
    state.busy = false;
    if (failed.length) {
      setStatus(`Failed ${failed.length} deletions.`);
      showToast("Some deletions failed.", "error");
    } else if (successCount > 0) {
      setStatus("Compilation deleted.");
      showDeleteDone("Compilation removed");
    } else {
      setStatus("No videos deleted.");
    }
    hideDownloadProgress(0);
    updateActionButtons();
  };

  const deleteAll = async () => {
    if (state.mode === "images") {
      if (isDeleteAllRunning("images")) return;
      if (state.busy && !isBusyFromDeleteOnly()) return;
      if (!window.confirm("Do you want to delete all images?")) return;
      beginDeleteAllRun("images");
      updateActionButtons();
      setStatus("Deleting all images...");
      const cpu = Math.max(2, Number(navigator.hardwareConcurrency) || 6);
      const childSyncConcurrency = Math.min(8, Math.max(3, Math.floor(cpu * 0.7)));
      const deleteConcurrency = Math.min(10, Math.max(4, Math.floor(cpu * 0.85)));
      let processedCount = 0;
      let successCount = 0;
      showDeleteProgress("Deleting images 0/0", 0);
      setProgressCancelableAction("delete-images");
      let failed = [];
      let canceledByUser = false;
      const isCanceled = () => isProgressCancelRequested("delete-images");
      let targets = { canceled: false, imageIds: [], childVideoIds: [] };
      try {
        targets = await collectAllImageDeleteTargets(isCanceled);
      } catch (error) {
        endDeleteAllRun("images");
        setStatus("Delete images failed.");
        showToast("Delete images failed.", "error");
        hideDownloadProgress(0);
        updateActionButtons();
        return;
      }
      if (targets.canceled) canceledByUser = true;
      const toDelete = targets && targets.imageIds ? targets.imageIds : [];
      const childIds = targets && targets.childVideoIds ? targets.childVideoIds : [];
      const totalCount = toDelete.length;
      const totalSafe = Math.max(1, totalCount);
      showDeleteProgress(`Deleting images 0/${totalCount}`, 0);
      if (!canceledByUser && childIds.length) {
        await runPool(
          childIds,
          childSyncConcurrency,
          async (childId) => {
            if (!childId || isCanceled()) return;
            let res = null;
            try {
              res = await likePost(childId);
            } catch (error) {
              res = { ok: false, status: 0 };
            }
            if (!res || !res.ok) {
              const statusCode = Number((res && res.status) || 0);
              const ignoredBecauseParallel = isDeleteAllRunning("videos");
              const ignoredAlreadyGone = statusCode === 404 || statusCode === 410;
              if (!ignoredBecauseParallel && !ignoredAlreadyGone) {
                await sleep(30);
              }
            }
          },
          isCanceled
        );
        if (isCanceled()) canceledByUser = true;
      }
      if (!canceledByUser && toDelete.length) {
        await runPool(
          toDelete,
          deleteConcurrency,
          async (postId) => {
            if (!postId || isCanceled()) return;
            const result = await deletePostWithRetry(postId, 2);
            processedCount += 1;
            if (result && result.ok) {
              successCount += 1;
              animateThumbRemoval(postId);
            } else {
              failed.push(postId);
            }
            showDeleteProgress(`Deleting images ${processedCount}/${totalCount}`, processedCount / totalSafe);
          },
          isCanceled
        );
        if (isCanceled()) canceledByUser = true;
      }
      if (!canceledByUser && failed.length) {
        const retryIds = failed.slice();
        failed = [];
        await runPool(
          retryIds,
          Math.max(2, Math.min(6, Math.floor(deleteConcurrency / 2))),
          async (postId) => {
            if (!postId || isCanceled()) return;
            const result = await deletePostWithRetry(postId, 1);
            if (result && result.ok) {
              successCount += 1;
              animateThumbRemoval(postId);
              return;
            }
            failed.push(postId);
          },
          isCanceled
        );
        if (isCanceled()) canceledByUser = true;
      }
      if (canceledByUser) {
        endDeleteAllRun("images");
        setStatus("Deletion stopped.");
        showToast("Deletion stopped.");
        hideDownloadProgress(0);
        updateActionButtons();
        return;
      }
      if (toDelete.length) {
        updateItems();
      }
      endDeleteAllRun("images");
      setStatus(
        failed.length
          ? `Failed ${failed.length} deletions.`
          : toDelete.length
          ? "All deletions requested."
          : "No images to delete."
      );
      if (failed.length) {
        showToast("Some deletions failed.", "error");
        hideDownloadProgress(0);
      } else if (toDelete.length || successCount) {
        showDeleteDone("All your images have been removed");
      } else {
        hideDownloadProgress(0);
      }
      failed.forEach((id) => setThumbStatus(id, "failed", "Failed"));
      if (!failed.length) {
        if (!isAnyDeleteAllRunning()) {
          setStatus("Refreshing saved...");
          setTimeout(() => {
            refresh({ silent: true, includeOtherMode: true });
          }, 700);
          return;
        }
        pendingRefreshAfterDelete = true;
      }
      updateActionButtons();
      return;
    }
    return deleteAllVideos();
  };

  // Delete every video under all posts, regardless of the active tab, leaving all
  // images untouched (only video post ids are collected and deleted).
  const deleteAllVideos = async () => {
    if (isDeleteAllRunning("videos")) return;
    if (state.busy && !isBusyFromDeleteOnly()) return;
    if (!window.confirm("Delete all videos under every post? Your images will be kept.")) return;
    beginDeleteAllRun("videos");
    updateActionButtons();
    setStatus("Deleting all videos...");
    // Enumerate from the asset stream: it covers every post, legacy and conversation
    // alike, where the legacy list stops at the v2 rollout and would silently skip
    // everything newer.
    const totalIds = new Set();
    const allIds = [];
    let safety = 0;
    while (!state.assets.exhausted && safety < 2000) {
      await fetchAndCacheAssetsPage(state.assets.pageTokens.length - 1);
      safety += 1;
      setStatus(`Finding videos... ${state.assets.totalLoaded} items scanned`);
    }
    state.assets.pageCache.forEach((pageItems) => {
      (pageItems || []).forEach((entry) => {
        if (!entry || entry.kind === "image") return;
        const id = normalizeId(entry.postId);
        if (!id || totalIds.has(id)) return;
        totalIds.add(id);
        allIds.push(id);
      });
    });
    if (!allIds.length) {
      endDeleteAllRun("videos");
      setStatus("No videos found.");
      showToast("No videos found.", "info");
      updateActionButtons();
      return;
    }
    setStatus(`Deleting ${allIds.length} videos...`);
    const totalCount = Math.max(1, totalIds.size);
    let deletedCount = 0;
    showDeleteProgress(`Deleting videos ${deletedCount}/${totalCount}`, 0);
    const failed = [];
    for (let i = 0; i < allIds.length; i += 1) {
      const id = allIds[i];
      setThumbStatus(id, "deleting", "Deleting...");
      const result = await deletePost(id);
      if (!result.ok) {
        failed.push(id);
      } else {
        animateThumbRemoval(id);
      }
      deletedCount += 1;
      showDeleteProgress(`Deleting videos ${deletedCount}/${totalCount}`, deletedCount / totalCount);
      await sleep(180);
    }
    resetModeState("videos");
    await ensurePageData("videos", 0);
    endDeleteAllRun("videos");
    setStatus(failed.length ? `Failed ${failed.length} deletions.` : "All deletions requested.");
    if (failed.length) {
      showToast("Some deletions failed.", "error");
      hideDownloadProgress(0);
    } else {
      showDeleteDone("All your videos have been removed");
    }
    failed.forEach((id) => setThumbStatus(id, "failed", "Failed"));
    if (!isAnyDeleteAllRunning() && pendingRefreshAfterDelete) {
      pendingRefreshAfterDelete = false;
      setStatus("Refreshing saved...");
      setTimeout(() => {
        refresh({ silent: true, includeOtherMode: true });
      }, 700);
      return;
    }
    updateActionButtons();
  };

  const pickDownloadUrl = (item) => {
    if (!item) return "";
    if (item.hdMediaUrl) return item.hdMediaUrl;
    return item.url || "";
  };

  const fetchWithBestCreds = async (url) => {
    if (!url) return null;
    const isPublic = url.includes("imagine-public.x.ai");
    const response = await fetch(url, {
      credentials: isPublic ? "omit" : "include"
    });
    return response;
  };

  const fetchBinaryViaExtension = (url, timeoutMs) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: "grokViewerFetchBinary", url, timeoutMs: Number(timeoutMs) || 60000 },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: "no-response" });
        }
      );
    });

  const fetchWithTimeout = async (url, timeoutMs) => {
    if (!url) throw new Error("missing-url");
    const targetUrl = normalizeUrl(url || "");
    if (!targetUrl) throw new Error("missing-url");
    let targetOrigin = "";
    try {
      targetOrigin = new URL(targetUrl, window.location.href).origin;
    } catch (error) {
      targetOrigin = "";
    }
    const isCrossOrigin = Boolean(targetOrigin && targetOrigin !== window.location.origin);
    if (isCrossOrigin) {
      const proxied = await fetchBinaryViaExtension(targetUrl, timeoutMs);
      if (proxied && proxied.ok) {
        let buffer = proxied.buffer;
        if ((!buffer || !(buffer instanceof ArrayBuffer)) && proxied.base64) {
          try {
            const binary = atob(String(proxied.base64 || ""));
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) {
              bytes[i] = binary.charCodeAt(i) & 0xff;
            }
            buffer = bytes.buffer;
          } catch (error) {
            buffer = null;
          }
        }
        if (buffer && !(buffer instanceof ArrayBuffer) && ArrayBuffer.isView(buffer)) {
          buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        } else if (Array.isArray(buffer)) {
          buffer = Uint8Array.from(buffer).buffer;
        }
        if (buffer instanceof ArrayBuffer) {
          return new Response(buffer, {
            status: Number(proxied.status || 200) || 200,
            headers: { "content-type": String(proxied.contentType || "application/octet-stream") }
          });
        }
      }
      const errorText = String((proxied && proxied.error) || "fetch-failed");
      const statusCode = Number((proxied && proxied.status) || 0);
      const error = new Error(statusCode ? `${errorText} status=${statusCode}` : errorText);
      if (statusCode) error.status = statusCode;
      throw error;
    }

    let directResponse = null;
    let directError = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      directResponse = await fetch(targetUrl, {
        credentials: "include",
        signal: controller.signal
      });
    } catch (error) {
      directError = error;
    } finally {
      clearTimeout(timer);
    }

    if (directResponse) return directResponse;
    throw directError || new Error("fetch-failed");
  };

  const downloadViaExtension = (url, filename, saveAs) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          action: "grokViewerDownloadUrl",
          url,
          filename,
          saveAs: !!saveAs,
          mode: getDownloadMode(),
          folderPath: sanitizeFolderPath(state.settings && state.settings.folderPath ? state.settings.folderPath : "")
        },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false });
        }
      );
    });

  const isDownloadCanceled = (result) => {
    const err = result && result.error ? String(result.error).toLowerCase() : "";
    return err.includes("canceled") || err.includes("cancelled") || err.includes("user_canceled");
  };

  const blobToDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("read-error"));
      reader.readAsDataURL(blob);
    });

  const downloadBlobDirect = async (blob, filename) => {
    try {
      const targetFilename = resolveDownloadFilename(filename);
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = targetFilename;
      anchor.rel = "noopener";
      anchor.style.display = "none";
      const host = document.body || document.documentElement;
      if (!host) throw new Error("missing-document-host");
      host.appendChild(anchor);
      anchor.click();
      setTimeout(() => {
        try {
          anchor.remove();
        } catch (error) {}
        try {
          URL.revokeObjectURL(blobUrl);
        } catch (error) {}
      }, 12000);
      return { ok: true, filename: targetFilename, direct: true };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error || "blob-download-failed") };
    }
  };

  const downloadBlobViaExtension = async (blob, filename) => {
    if (getDownloadMode() === "folder_once") {
      const local = await writeBlobToChosenFolder(blob, filename);
      if (local && local.ok) return local;
    }
    const blobUrl = URL.createObjectURL(blob);
    const targetFilename = resolveDownloadFilename(filename);
    const result = await downloadViaExtension(blobUrl, targetFilename, resolveSaveAs());
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    return { ...(result || {}), filename: targetFilename };
  };

  const buildDownloadCandidates = (item) => {
    if (!item) return [];
    const urls = [];
    const seen = new Set();
    const videoProbe = normalizeUrl(
      (item && (item.playbackUrl || item.mediaUrl || item.url || item.hdMediaUrl)) || ""
    );
    const isVideoItem = isMp4(videoProbe, item && item.mimeType);
    const addUrl = (url) => {
      const normalized = normalizeUrl(url || "");
      if (!normalized) return;
      const optimized = optimizeThumbUrl(normalized);
      const variants = optimized && optimized !== normalized ? [optimized, normalized] : [normalized];
      for (let i = 0; i < variants.length; i += 1) {
        const candidate = String(variants[i] || "").trim();
        if (!candidate || seen.has(candidate)) continue;
        seen.add(candidate);
        urls.push(candidate);
      }
    };

    const postId = String((item && item.postId) || "").trim();
    const preferredMp4Ids = [];
    const isUuidLike = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    addUrl(pickDownloadUrl(item));
    addUrl(item && item.url ? item.url : "");
    addUrl(item && item.playbackUrl ? item.playbackUrl : "");
    addUrl(item && item.mediaUrl ? item.mediaUrl : "");
    addUrl(item && item.hdMediaUrl ? item.hdMediaUrl : "");
    if (isVideoItem) {
      if (isUuidLike(postId)) preferredMp4Ids.push(postId);
      const rawPrimary = [item.hdMediaUrl, item.playbackUrl, item.mediaUrl, item.url]
        .map((value) => normalizeUrl(value || ""))
        .filter(Boolean);
      for (let i = 0; i < rawPrimary.length; i += 1) {
        const extracted = extractMp4Id(rawPrimary[i]);
        if (extracted && !preferredMp4Ids.includes(extracted)) preferredMp4Ids.push(extracted);
      }
      for (let i = 0; i < preferredMp4Ids.length; i += 1) {
        const id = preferredMp4Ids[i];
        addUrl(`https://imagine-public.x.ai/imagine-public/share-videos/${id}.mp4?cache=1`);
        addUrl(`https://imagine-public.x.ai/imagine-public/share-videos/${id}.mp4`);
      }
    }
    return urls;
  };

  const mergeDownloadItemFields = (targetItem, freshItem) => {
    if (!targetItem || !freshItem) return;
    const keys = [
      "url",
      "hdMediaUrl",
      "mediaUrl",
      "playbackUrl",
      "poster",
      "sourceImageUrl",
      "mimeType",
      "mediaWidth",
      "mediaHeight",
      "isPortrait"
    ];
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (freshItem[key] !== undefined && freshItem[key] !== null && freshItem[key] !== "") {
        targetItem[key] = freshItem[key];
      }
    }
  };

  const resolveFreshDownloadItem = (detail, originalItem) => {
    if (!detail || !originalItem) return null;
    const postId = String(originalItem.postId || "").trim();
    const extracted = extractItems([detail]);
    const videos = (extracted && extracted.videos) || [];
    const images = (extracted && extracted.images) || [];
    let fresh =
      videos.find((entry) => String((entry && entry.postId) || "").trim() === postId) ||
      images.find((entry) => String((entry && entry.postId) || "").trim() === postId) ||
      null;
    if (!fresh && detail && String(detail.id || "").trim() === postId) {
      fresh =
        buildItem(
          detail,
          originalItem.parentPostId || "",
          originalItem.sourceImageUrl || "",
          originalItem.promptText || ""
        ) || buildImageItem(detail);
    }
    return fresh || null;
  };

  const buildFreshDownloadCandidatesForItem = async (item) => {
    const postId = String((item && item.postId) || "").trim();
    if (!postId) return [];
    try {
      const detail = await fetchPostDetails(postId);
      const freshItem = resolveFreshDownloadItem(detail, item);
      if (!freshItem) return [];
      mergeDownloadItemFields(item, freshItem);
      return buildDownloadCandidates(item);
    } catch (error) {
      return [];
    }
  };

  const resolveMediaDownloadFilename = (item) => {
    const targetItem = resolveActiveItem(item) || item;
    if (!targetItem) return "grok-media.bin";
    const candidates = buildDownloadCandidates(targetItem);
    const targetUrl = candidates[0] || targetItem.url || "";
    const baseUrl = String(targetUrl || "").split(/[?#]/)[0];
    const extMatch = baseUrl.match(/\.([a-z0-9]{2,6})$/i);
    const urlExt = extMatch ? extMatch[1].toLowerCase() : "";
    const videoExts = new Set(["mp4", "m4v", "mov", "webm"]);
    const imageExts = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]);
    const itemIsImage =
      targetItem.kind === "image" || isImage(targetItem.url, targetItem.mimeType);
    let ext;
    if (itemIsImage) {
      ext = imageExts.has(urlExt) ? urlExt : "jpg";
    } else if (urlExt && videoExts.has(urlExt)) {
      ext = urlExt;
    } else {
      ext = "mp4";
    }
    const filenameBase = targetItem.postId || targetItem.id || "grok-media";
    return `${filenameBase}.${ext}`;
  };

  const getCreatedAtText = (item) => {
    const target = resolveActiveItem(item) || item;
    const stamp = toTime(target && target.createdAt ? target.createdAt : "");
    if (!stamp) return "Unknown";
    try {
      return new Date(stamp).toISOString();
    } catch (error) {
      return "Unknown";
    }
  };

  const buildPromptInfoFilename = (mediaFilename) => {
    const parts = splitNameExt(mediaFilename || "grok-media.mp4");
    const base = parts.base || "grok-media";
    return `${base}-prompt-info.txt`;
  };

  const buildPromptInfoContent = (item, promptText, mediaFilename) => {
    const lines = [];
    lines.push(`Title: ${mediaFilename || "Unknown"}`);
    lines.push(`Created at: ${getCreatedAtText(item)}`);
    lines.push("");
    lines.push("Original prompt:");
    lines.push(promptText || "");
    return `${lines.join("\n")}\n`;
  };

  // Bulk downloads write one prompts.txt per post folder rather than a sidecar next to
  // every file: outside folder mode each extra file is its own browser download (and
  // its own Save As dialog in ask-each mode), so one file per folder carries the
  // prompts without doubling the download count.
  const buildGroupPromptsContent = (items, folderName) => {
    const blocks = [];
    (items || []).forEach((item) => {
      if (!item) return;
      const prompt = getPromptTextForItem(item);
      if (!prompt) return;
      blocks.push(
        [
          `File: ${resolveMediaDownloadFilename(item)}`,
          `Created at: ${getCreatedAtText(item)}`,
          "Prompt:",
          prompt
        ].join("\n")
      );
    });
    if (!blocks.length) return "";
    const header = [`Post: ${folderName || "Unknown"}`, `Saved at: ${new Date().toISOString()}`, ""];
    return `${header.concat(blocks.join("\n\n---\n\n")).join("\n")}\n`;
  };

  const extractAskEachFolderPathFromFilename = (filename) => {
    const normalized = String(filename || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    if (!normalized) return "";
    const parts = normalized
      .replace(/^[a-z]:/i, "")
      .split("/")
      .filter(Boolean);
    if (parts.length < 2) return "";
    const downloadsIdx = parts.findIndex((part) => String(part).toLowerCase() === "downloads");
    if (downloadsIdx >= 0) {
      const relative = parts.slice(downloadsIdx + 1, -1).join("/");
      return sanitizeFolderPath(relative);
    }
    return sanitizeFolderPath(parts[parts.length - 2] || "");
  };

  const rememberAskEachFolderFromDownloadOutcome = (outcome, requestedFilename) => {
    if (getDownloadMode() !== "ask_each") return;
    let folderPath = "";
    if (outcome && outcome.status && outcome.status.filename) {
      folderPath = extractAskEachFolderPathFromFilename(outcome.status.filename);
    }
    if (!folderPath) {
      const fallback = String(requestedFilename || "").replace(/\\/g, "/");
      const chunks = fallback.split("/").filter(Boolean);
      if (chunks.length > 1) {
        folderPath = sanitizeFolderPath(chunks.slice(0, -1).join("/"));
      }
    }
    const current = getAskEachFolderPath();
    if (current) return;
    if (!folderPath || folderPath === current) return;
    state.settings.askEachFolderPath = folderPath;
    persistSettings();
  };

  const downloadPromptInfoFile = async (item) => {
    const prompt = getPromptTextForItem(item);
    if (!prompt) {
      showToast("Prompt unavailable", "error");
      return;
    }
    const ready = await ensureFolderModeReady();
    if (!ready) return;
    const mediaFilename = resolveMediaDownloadFilename(item);
    const infoFilename = buildPromptInfoFilename(mediaFilename);
    const content = buildPromptInfoContent(item, prompt, mediaFilename);
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const started = await downloadBlobViaExtension(blob, infoFilename);
    if (!started || !started.ok) {
      if (isDownloadCanceled(started)) {
        maybePromptDownloadSetupGuide();
        setReadyStatus();
        return;
      }
      setStatus("Prompt info download failed.");
      return;
    }
    const saveAs = resolveSaveAs();
    const effectiveName = started.filename || resolveDownloadFilename(infoFilename);
    const promptVerify = await verifyDownloadResult(started, saveAs ? 120000 : 1800, !!saveAs);
    if (!promptVerify.ok) {
      if (promptVerify.state === "canceled") {
        maybePromptDownloadSetupGuide();
        setReadyStatus();
        return;
      }
      setStatus("Prompt info download failed.");
      return;
    }
    if (saveAs && promptVerify.outcome) {
      rememberAskEachFolderFromDownloadOutcome(promptVerify.outcome, effectiveName);
    }
    showDownloadReady("Your prompt file is ready. Click here", effectiveName);
    if (!saveAs) await waitForDownloadWithTimeout(effectiveName, true, 20000);
  };

  const downloadFile = async (item, options) => {
    const targetItem = resolveActiveItem(item);
    if (!targetItem) return;
    const skipDuplicatePrompt = !!(options && options.skipDuplicatePrompt);
    try {
      const candidates = buildDownloadCandidates(targetItem);
      const targetUrl = candidates[0] || "";
      if (!targetUrl) {
        setStatus("Download failed.");
        return;
      }
      const filename = resolveMediaDownloadFilename(targetItem);
      const ready = await ensureFolderModeReady();
      if (!ready) return;
      const alreadyDownloaded = isItemDownloaded(state.mode, targetItem);
      if (alreadyDownloaded && !skipDuplicatePrompt) {
        const again = window.confirm("This file has already been downloaded. Do you want to download it again?");
        if (!again) return;
      }

      if (getDownloadMode() === "folder_once") {
        for (let i = 0; i < candidates.length; i += 1) {
          let response = null;
          try {
            response = await fetchWithTimeout(candidates[i], 60000);
          } catch (error) {
            response = null;
          }
          if (!response || !response.ok) continue;
          const blob = await response.blob();
          const local = await writeBlobToChosenFolder(blob, filename);
          if (local && local.ok) {
            recordDownloadedItems(state.mode, [targetItem]);
            syncVisibleDownloadedBadges();
            showDownloadReady("Your file is ready. Click here", local.filename || filename);
            return;
          }
        }
        const targetFilename = resolveDownloadFilename(filename);
        for (let i = 0; i < candidates.length; i += 1) {
          const started = await downloadViaExtension(candidates[i], targetFilename, false);
          const verify = await verifyDownloadResult(started, 1800, false);
          if (verify.ok) {
            recordDownloadedItems(state.mode, [targetItem]);
            syncVisibleDownloadedBadges();
            showDownloadReady("Your file is ready. Click here", targetFilename);
            return;
          }
          if (verify.state === "canceled") {
            maybePromptDownloadSetupGuide();
            setReadyStatus();
            return;
          }
          if (isDownloadCanceled(started)) {
            maybePromptDownloadSetupGuide();
            setReadyStatus();
            return;
          }
        }
        setStatus("Download failed.");
        return;
      }

      const targetFilename = resolveDownloadFilename(filename);
      let saveAs = resolveSaveAs();
      if (alreadyDownloaded && getDownloadMode() === "ask_each") saveAs = true;
      let started = null;
      let verifiedOutcome = null;
      for (let i = 0; i < candidates.length; i += 1) {
        const startedAttempt = await downloadViaExtension(candidates[i], targetFilename, saveAs);
        const verify = await verifyDownloadResult(startedAttempt, saveAs ? 120000 : 1800, !!saveAs);
        if (verify.ok) {
          started = startedAttempt;
          verifiedOutcome = verify.outcome;
          break;
        }
        if (verify.state === "canceled") {
          maybePromptDownloadSetupGuide();
          setReadyStatus();
          return;
        }
        started = startedAttempt;
        if (isDownloadCanceled(started)) {
          maybePromptDownloadSetupGuide();
          setReadyStatus();
          return;
        }
      }
      if (!started || !started.ok) {
        setStatus("Download failed.");
        return;
      }
      if (saveAs && verifiedOutcome) {
        rememberAskEachFolderFromDownloadOutcome(verifiedOutcome, targetFilename);
      }
      recordDownloadedItems(state.mode, [targetItem]);
      syncVisibleDownloadedBadges();
      showDownloadReady("Your file is ready. Click here", targetFilename);
      if (!saveAs) await waitForDownloadWithTimeout(targetFilename, true, 20000);
    } catch (error) {
      setStatus("Download failed.");
    }
  };

  const downloadOne = () => {
    const item = state.items[state.selectedIndex];
    if (!item) return;
    downloadFile(item);
  };

  // Folder names for a post have changed shape over time (a video's id, then the
  // parent post id, now a conversation id), and the checked-items path names a folder
  // after the tile's own id while Download All uses the group id. Re-downloading a post
  // that gained new media would therefore spawn a second folder beside the first. Probe
  // every id this group is known by and reuse whichever folder is already on disk, so
  // new images and videos land next to what was saved before.
  const folderProbeCache = new Map();
  const resetFolderProbeCache = () => folderProbeCache.clear();

  const collectFolderCandidates = (group, canonical) => {
    const candidates = [];
    const push = (value) => {
      const safe = sanitizeFolderSegment(value);
      if (safe && !candidates.includes(safe)) candidates.push(safe);
    };
    push(canonical);
    push(group && group.groupId);
    push(group && group.postId);
    push(group && group.rootPostId);
    // Only ids that ARE this post -- parent/original links can belong to a different
    // post that legitimately owns its own folder, so they must not be probed.
    (group && Array.isArray(group.variants) ? group.variants : []).forEach((variant) => {
      if (!variant) return;
      push(variant.postId);
      push(variant.rootPostId);
      push(variant.id);
    });
    return candidates;
  };

  const findExistingPostFolder = async (group, canonical) => {
    if (getDownloadMode() !== "folder_once" || !chosenFolderHandle) return "";
    const candidates = collectFolderCandidates(group, canonical);
    for (let i = 0; i < candidates.length; i += 1) {
      const name = candidates[i];
      if (folderProbeCache.has(name)) {
        if (folderProbeCache.get(name)) return name;
        continue;
      }
      let exists = false;
      try {
        await chosenFolderHandle.getDirectoryHandle(name, { create: false });
        exists = true;
      } catch (error) {
        exists = false;
      }
      folderProbeCache.set(name, exists);
      if (exists) return name;
    }
    return "";
  };

  const resolveGroupFolderName = async (group, options) => {
    const explicit = options && options.folderName ? sanitizeFolderSegment(options.folderName) : "";
    const canonical =
      explicit ||
      sanitizeFolderSegment(
        (group && (group.groupId || group.postId)) ||
          (group &&
            group.variants &&
            group.variants[0] &&
            (group.variants[0].postId || group.variants[0].id)) ||
          ""
      ) ||
      "grok-post";
    const existing = await findExistingPostFolder(group, canonical);
    if (existing) return existing;
    // Nothing on disk yet: this run is about to create it, so later probes should see it.
    folderProbeCache.set(canonical, true);
    return canonical;
  };

  // Check whether <postFolder>/<name> is already on disk. Only reliable in folder
  // mode (we have a directory handle to query); other modes can't inspect the disk,
  // so this returns false and the download proceeds as usual.
  const postFileExists = async (postFolder, name) => {
    if (getDownloadMode() !== "folder_once" || !chosenFolderHandle) return false;
    try {
      const safePost = sanitizeFolderSegment(postFolder);
      let dir = chosenFolderHandle;
      if (safePost) {
        dir = await chosenFolderHandle.getDirectoryHandle(safePost, { create: false });
      }
      await dir.getFileHandle(name, { create: false });
      return true;
    } catch (error) {
      return false;
    }
  };

  // Save a single compilation file into a per-post subfolder (folder name = post ID).
  // Prefers the chosen File System Access handle (silent, real nested folders);
  // otherwise falls back to the browser downloader with a subfolder path.
  const downloadGroupFile = async (blob, name, postFolder) => {
    const safePost = sanitizeFolderSegment(postFolder);
    if (getDownloadMode() === "folder_once" && chosenFolderHandle) {
      const rel = safePost ? `${safePost}/${name}` : name;
      const local = await writeBlobToChosenFolder(blob, rel);
      if (local && local.ok) return local;
    }
    const prefix = resolvePostFolderPrefix();
    const fullRel = [prefix, safePost, name].filter(Boolean).join("/");
    const blobUrl = URL.createObjectURL(blob);
    const result = await downloadViaExtension(blobUrl, fullRel, resolveSaveAs());
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    if (result && result.ok) return { ...result, filename: fullRel };
    // Last resort: direct anchor download (browsers flatten the subfolder here).
    return downloadBlobDirect(blob, name);
  };

  const downloadGroup = async (groupArg, options) => {
    let group = groupArg || state.items[state.selectedIndex];
    const skipFinalWait = !!(options && options.skipFinalWait);
    const bulk = !!(options && options.bulk);
    // When foldering (a folderName is supplied) a single-media post is valid and
    // still gets its own folder; otherwise require an actual compilation (2+).
    const minVariants = options && options.folderName ? 1 : 2;
    if (!group || !group.variants || group.variants.length < minVariants) return;
    if (!bulk && state.busy) return;
    const ready = await ensureFolderModeReady();
    if (!ready) return;
    if (!bulk) {
      state.busy = true;
      updateActionButtons();
    }
    setStatus(group.variants.length > 1 ? "Preparing compilation..." : "Preparing download...");
    showDownloadProgress();
    if (downloadGroupBtn) {
      downloadGroupBtn.classList.add("done");
      setTimeout(() => {
        if (!downloadGroupBtn) return;
        downloadGroupBtn.classList.remove("done");
      }, 5000);
    }
    const run = async () => {
      try {
        // Drop content-duplicate variants (same picture/clip under different postIds)
        // so one post's folder never gets the same media twice.
        const seenVariantKeys = new Set();
        const items = group.variants.slice().filter((variant) => {
          const key = mediaDedupKey(variant);
          if (!key) return true;
          if (seenVariantKeys.has(key)) return false;
          seenVariantKeys.add(key);
          return true;
        });
        const folderName = await resolveGroupFolderName(group, options);
        let saved = 0;
        let failed = 0;
        let skippedExisting = 0;
        const doneItems = [];
        let lastFilename = "";
        let lastLocal = false;
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i];
          if (!item) continue;
          const name = resolveMediaDownloadFilename(item);
          // Skip files that are already on disk (folder mode only) — no re-fetch.
          if (await postFileExists(folderName, name)) {
            skippedExisting += 1;
            doneItems.push(item);
            const skipText = `Skipping existing ${folderName}/ ${i + 1}/${items.length}...`;
            setStatus(skipText);
            setDownloadProgress(skipText, (i + 1) / items.length);
            continue;
          }
          let response = null;
          let candidates = buildDownloadCandidates(item);
          for (let c = 0; c < candidates.length; c += 1) {
            try {
              response = await fetchWithTimeout(candidates[c], 120000);
              if (response && response.ok) break;
            } catch (error) {
              response = null;
            }
          }
          if (!response || !response.ok) {
            const refreshedCandidates = await buildFreshDownloadCandidatesForItem(item);
            candidates = refreshedCandidates.length ? refreshedCandidates : candidates;
            for (let c = 0; c < candidates.length; c += 1) {
              try {
                response = await fetchWithTimeout(candidates[c], 120000);
                if (response && response.ok) break;
              } catch (error) {
                response = null;
              }
            }
          }
          if (!response || !response.ok) {
            failed += 1;
            continue;
          }
          const blob = await response.blob();
          const result = await downloadGroupFile(blob, name, folderName);
          if (result && result.ok) {
            saved += 1;
            doneItems.push(item);
            lastFilename = result.filename || name;
            lastLocal = !!result.local;
          } else {
            failed += 1;
          }
          const prepText = `Saving ${folderName}/ ${i + 1}/${items.length}...`;
          setStatus(prepText);
          setDownloadProgress(prepText, (i + 1) / items.length);
          await sleep(80);
        }
        if (!saved && !skippedExisting) {
          setStatus("Download failed.");
          return;
        }
        recordDownloadedItems(state.mode, doneItems);
        syncVisibleDownloadedBadges();
        // Only when something new landed -- a folder that was already complete stays
        // untouched instead of collecting prompts (1).txt on every re-run.
        if (saved > 0) {
          const promptsText = buildGroupPromptsContent(doneItems, folderName);
          if (promptsText) {
            try {
              await downloadGroupFile(
                new Blob([promptsText], { type: "text/plain;charset=utf-8" }),
                "prompts.txt",
                folderName
              );
            } catch (error) {}
          }
        }
        let doneText;
        if (saved && skippedExisting) {
          doneText = `Saved ${saved}, skipped ${skippedExisting} existing → ${folderName}/`;
        } else if (skippedExisting && !saved) {
          doneText = `Already in ${folderName}/ (${skippedExisting} file${skippedExisting === 1 ? "" : "s"})`;
        } else if (failed > 0) {
          doneText = `Saved ${saved}/${saved + failed} to ${folderName}/`;
        } else {
          doneText = `Saved ${saved} file${saved === 1 ? "" : "s"} to ${folderName}/`;
        }
        setStatus(doneText);
        setDownloadProgress(doneText, 1);
        if (saved > 0) {
          showDownloadReady("Your files are ready. Click here", lastFilename || folderName);
        }
        if (!bulk) {
          state.busy = false;
          updateActionButtons();
        }
        if (!skipFinalWait && lastFilename && !lastLocal) {
          await waitForDownloadWithTimeout(lastFilename, true, 20000);
        }
      } catch (error) {
        setStatus("Download failed.");
      } finally {
        if (!bulk) {
          state.busy = false;
          hideDownloadProgress(0);
          updateActionButtons();
        }
      }
    };
    return run();
  };

  const collectVideosUnderPost = (item) => {
    if (!item) return [];
    const seedIds = item.variants && item.variants.length
      ? item.variants.map((v) => v && v.postId).filter(Boolean)
      : [item.postId].filter(Boolean);
    if (!seedIds.length) return [];
    const allIds = collectCascadingPostIds(seedIds);
    // Same two blind spots collectMediaUnderPost had: conversation videos live in the
    // v2 cache, not the per-mode one, and they link to the conversation rather than to
    // each other -- so match on the shared root as well as the cascade.
    const rootIds = new Set();
    const addRoot = (value) => {
      const norm = normalizeId(value);
      if (norm) rootIds.add(norm);
    };
    addRoot(item.groupId);
    addRoot(item.rootPostId);
    (item.variants || []).forEach((variant) => addRoot(variant && variant.rootPostId));
    const seen = new Set();
    const videos = [];
    forEachLoadedEntry((entry) => {
      if (!entry || !entry.postId) return;
      if (entry.kind === "image") return;
      const pid = String(entry.postId);
      if (seen.has(pid)) return;
      if (!allIds.has(pid) && !rootIds.has(normalizeId(entry.rootPostId))) return;
      seen.add(pid);
      videos.push(entry);
    });
    return videos;
  };

  // Verified 2026-08-23: /rest/media/post/delete answers a v2 asset id with
  // 404 {"code":5,"message":"Media post not found"}. Conversation media simply is not
  // deletable through the legacy endpoint, so every delete aimed at it is a doomed
  // request. Block those actions with an honest message instead of firing them.
  const isAssetStreamId = (postId) => {
    const target = normalizeId(postId);
    if (!target) return false;
    let found = false;
    [state.assets.pageCache].forEach((cache) => {
      cache.forEach((pageItems) => {
        (pageItems || []).forEach((entry) => {
          if (entry && normalizeId(entry.postId) === target) found = true;
        });
      });
    });
    return found;
  };

  // Deleting a post has to take everything under it. Legacy posts are joined by cascade
  // ids; asset-stream media has no such links between siblings and is joined only by its
  // shared root, so expand both or a delete removes just the tile's primary asset.
  const collectDeleteTargetIds = (seedIds) => {
    const ids = collectCascadingPostIds(seedIds);
    const seeds = new Set((seedIds || []).map(normalizeId).filter(Boolean));
    const roots = new Set();
    forEachLoadedEntry((entry) => {
      if (!entry) return;
      const pid = normalizeId(entry.postId);
      if (pid && seeds.has(pid)) {
        const root = normalizeId(entry.rootPostId);
        if (root) roots.add(root);
      }
    });
    if (!roots.size) return ids;
    forEachLoadedEntry((entry) => {
      if (!entry) return;
      const pid = normalizeId(entry.postId);
      if (pid && roots.has(normalizeId(entry.rootPostId))) ids.add(pid);
    });
    return ids;
  };

  const collectMediaUnderPost = (item) => {
    if (!item) return [];
    const seedIds = item.variants && item.variants.length
      ? item.variants.map((v) => v && v.postId).filter(Boolean)
      : [item.postId].filter(Boolean);
    if (!seedIds.length) return [];
    const allIds = collectCascadingPostIds(seedIds);
    // Conversation media has no cascade links between assets -- everything is tied to
    // the conversation instead -- so also take anything sharing this group's root.
    const rootIds = new Set();
    const addRoot = (value) => {
      const norm = normalizeId(value);
      if (norm) rootIds.add(norm);
    };
    addRoot(item.groupId);
    addRoot(item.rootPostId);
    (item.variants || []).forEach((variant) => addRoot(variant && variant.rootPostId));
    const seen = new Set();
    const media = [];
    forEachLoadedEntry((entry) => {
      if (!entry || !entry.postId) return;
      const pid = String(entry.postId);
      if (seen.has(pid)) return;
      if (!allIds.has(pid) && !rootIds.has(normalizeId(entry.rootPostId))) return;
      seen.add(pid);
      media.push(entry);
    });
    return media;
  };

  const downloadAllVideosForItem = async (item) => {
    const media = collectMediaUnderPost(item);
    if (!media.length) {
      showToast("No media found under this post.", "info");
      return;
    }
    await downloadGroup(
      { variants: media },
      { folderName: (item && (item.groupId || item.postId || item.id)) || "" }
    );
  };

  const deleteAllVideosForItem = async (item) => {
    if (state.busy) return;
    const videos = collectVideosUnderPost(item);
    if (!videos.length) {
      showToast("No videos found under this post.", "info");
      return;
    }
    const ids = videos.map((v) => v && v.postId).filter(Boolean);
    if (!ids.length) return;
    if (!window.confirm(`Delete ${ids.length} video${ids.length === 1 ? "" : "s"} under this post?`)) return;
    playActionAudio("delete");
    state.busy = true;
    updateActionButtons();
    const totalSafe = Math.max(1, ids.length);
    let processed = 0;
    let successCount = 0;
    const failed = [];
    setStatus(ids.length === 1 ? "Deleting video..." : `Deleting ${ids.length} videos...`);
    showDeleteProgress(`Deleting 0/${ids.length}`, 0);
    await runPool(
      ids,
      Math.min(6, Math.max(3, Number(navigator.hardwareConcurrency) || 4)),
      async (postId) => {
        const result = await deletePostWithRetry(postId, 2);
        processed += 1;
        if (result && result.ok) {
          successCount += 1;
          animateThumbRemoval(postId);
        } else {
          failed.push(postId);
        }
        showDeleteProgress(`Deleting ${processed}/${ids.length}`, processed / totalSafe);
      }
    );
    const removedIds = new Set(ids.filter((id) => !failed.includes(id)));
    if (removedIds.size) {
      removedIds.forEach((id) => {
        const norm = normalizeId(id);
        if (norm) pendingDeleteMarkers.add(String(norm));
      });
      invalidateGroupsMemo();
    }
    const lightboxOpenNow = Boolean(lightboxEl && lightboxEl.classList.contains("open"));
    if (lightboxOpenNow) {
      updateItems();
      if (!state.items.length) {
        closeLightbox();
      } else {
        state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, state.items.length - 1));
        loadPlayer();
      }
    } else {
      applyBlurToMarkedThumbs();
    }
    state.busy = false;
    if (failed.length) {
      setStatus(`Failed ${failed.length} deletion${failed.length === 1 ? "" : "s"}.`);
      showToast("Some deletions failed.", "error");
    } else if (successCount > 0) {
      setStatus(successCount === 1 ? "Video deleted." : `${successCount} videos deleted.`);
      showDeleteDone("Videos deleted");
    } else {
      setStatus("No videos deleted.");
    }
    hideDownloadProgress(0);
    updateActionButtons();
  };

  const updateDeleteCheckedButton = () => {
    const count = state.selectedPostIds.size;
    if (deleteCheckedBtn) {
      deleteCheckedBtn.textContent = count > 0 ? `Delete Checked (${count})` : "Delete Checked";
      deleteCheckedBtn.disabled = count === 0 || state.busy;
    }
    if (downloadCheckedBtn) {
      downloadCheckedBtn.textContent = count > 0 ? `Download Checked (${count})` : "Download Checked";
      downloadCheckedBtn.disabled = count === 0 || state.busy;
    }
  };

  const getCurrentPagePostIds = () => {
    const ids = [];
    const items = state.items || [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item) continue;
      if (item.postId) ids.push(String(item.postId));
      const variants = Array.isArray(item.variants) ? item.variants : [];
      for (let j = 0; j < variants.length; j += 1) {
        const v = variants[j];
        if (v && v.postId) ids.push(String(v.postId));
      }
    }
    return Array.from(new Set(ids));
  };

  const toggleCheckAllCurrentPage = () => {
    if (state.busy) return;
    const ids = getCurrentPagePostIds();
    if (!ids.length) return;
    const allChecked = ids.every((id) => state.selectedPostIds.has(id));
    if (allChecked) {
      ids.forEach((id) => state.selectedPostIds.delete(id));
    } else {
      ids.forEach((id) => state.selectedPostIds.add(id));
    }
    renderGrid();
    updateActionButtons();
  };

  const collectMediaForPostIds = (postIds) => {
    const allIds = collectCascadingPostIds(postIds);
    const seen = new Set();
    const media = [];
    forEachLoadedEntry((entry) => {
      if (!entry || !entry.postId) return;
      const pid = String(entry.postId);
      if (!allIds.has(pid) || seen.has(pid)) return;
      seen.add(pid);
      media.push(entry);
    });
    return media;
  };

  // Content identity for a media item: the same picture/clip can appear under two
  // different postIds (e.g. a child image and its top-level counterpart). Key by the
  // stable media UUID in the URL so thumbnail/CDN/query variants of the same asset
  // still collapse; fall back to the stripped URL, then postId. Used to avoid writing
  // the same file into two folders.
  const mediaDedupKey = (item) => {
    if (!item) return "";
    const primaryUrl = normalizeUrl(item.url || item.mediaUrl || item.playbackUrl || item.hdMediaUrl || "");
    const imgId =
      extractImageId(primaryUrl) ||
      extractImageId(normalizeUrl(item.poster || item.sourceImageUrl || ""));
    if (imgId) return `img:${imgId}`;
    const mp4Id = extractMp4Id(primaryUrl);
    if (mp4Id) return `mp4:${mp4Id}`;
    const url = stripUrlForKey(primaryUrl);
    if (url) return `url:${url}`;
    return item.postId ? `post:${item.postId}` : "";
  };

  // The selected-items path only knows a tile's own post id; map it back to the group
  // so its folder matches the one Download All would use for the same post.
  const resolveAliasGroupId = (postId) => normalizeId(postGroupAlias.get(normalizeId(postId)));

  const groupHasVideo = (group) =>
    Boolean(
      group &&
        Array.isArray(group.variants) &&
        group.variants.some((v) => v && v.kind !== "image")
    );

  const downloadCheckedItems = async () => {
    if (state.busy) return;
    const ids = Array.from(state.selectedPostIds).filter(Boolean);
    if (!ids.length) return;
    let processed = 0;
    let succeeded = 0;
    const skipped = [];
    // Selected thumbs can share media (same picture under two posts, or a post's video
    // and image sides); track written media by content so nothing is saved twice, and
    // handle video-bearing posts first so shared images attach to the video folder.
    const orderedIds = ids
      .map((postId) => ({ postId, media: collectMediaForPostIds([postId]) }))
      .sort((a, b) => {
        const av = a.media.some((m) => m && m.kind !== "image") ? 1 : 0;
        const bv = b.media.some((m) => m && m.kind !== "image") ? 1 : 0;
        return bv - av;
      });
    const writtenKeys = new Set();
    for (let i = 0; i < orderedIds.length; i += 1) {
      const { postId, media } = orderedIds[i];
      const fresh = [];
      media.forEach((item) => {
        const key = mediaDedupKey(item);
        if (!key || writtenKeys.has(key)) return;
        writtenKeys.add(key);
        fresh.push(item);
      });
      if (!fresh.length) {
        continue;
      }
      setStatus(`Downloading post ${i + 1} of ${orderedIds.length}...`);
      try {
        await downloadGroup(
          { variants: fresh, groupId: resolveAliasGroupId(postId) || postId },
          { skipFinalWait: true, bulk: true, folderName: resolveAliasGroupId(postId) || postId }
        );
        succeeded += 1;
      } catch (error) {
        skipped.push(postId);
      }
      processed += 1;
      if (i < ids.length - 1) {
        await sleep(150);
      }
    }
    if (succeeded === 0) {
      showToast("No posts downloaded.", "error");
    } else if (skipped.length) {
      showToast(`${succeeded} of ${ids.length} posts downloaded; ${skipped.length} skipped.`, "info");
    } else {
      showToast(`${succeeded} post${succeeded === 1 ? "" : "s"} downloaded.`, "info");
    }
    setStatus(`Downloaded ${succeeded}/${ids.length} posts.`);
  };

  const deleteCheckedItems = async () => {
    if (state.busy) return;
    const ids = Array.from(state.selectedPostIds).filter(Boolean);
    if (!ids.length) return;
    if (!window.confirm(`Delete ${ids.length} checked post${ids.length === 1 ? "" : "s"} (and all related)?`)) return;
    playActionAudio("delete");
    state.busy = true;
    updateActionButtons();
    updateDeleteCheckedButton();
    const cascadeIds = Array.from(collectDeleteTargetIds(ids));
    const total = cascadeIds.length;
    const totalSafe = Math.max(1, total);
    let processed = 0;
    let successCount = 0;
    const failed = [];
    setStatus(`Deleting ${total} post${total === 1 ? "" : "s"}...`);
    showDeleteProgress(`Deleting 0/${total}`, 0);
    await runPool(
      cascadeIds,
      Math.min(6, Math.max(3, Number(navigator.hardwareConcurrency) || 4)),
      async (postId) => {
        const result = await deletePostWithRetry(postId, 2);
        processed += 1;
        if (result && result.ok) {
          successCount += 1;
          animateThumbRemoval(postId);
        } else {
          failed.push(postId);
        }
        showDeleteProgress(`Deleting ${processed}/${total}`, processed / totalSafe);
      }
    );
    const removedIds = new Set(cascadeIds.filter((id) => !failed.includes(id)));
    if (removedIds.size) {
      removedIds.forEach((id) => {
        const norm = normalizeId(id);
        if (norm) pendingDeleteMarkers.add(String(norm));
      });
      invalidateGroupsMemo();
    }
    state.selectedPostIds.clear();
    const lightboxOpenNow = Boolean(lightboxEl && lightboxEl.classList.contains("open"));
    if (lightboxOpenNow) {
      updateItems();
      if (!state.items.length) {
        closeLightbox();
      } else {
        state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, state.items.length - 1));
        loadPlayer();
      }
    } else {
      applyBlurToMarkedThumbs();
    }
    state.busy = false;
    if (failed.length) {
      setStatus(`Failed ${failed.length} deletion${failed.length === 1 ? "" : "s"}.`);
      showToast("Some deletions failed.", "error");
    } else if (successCount > 0) {
      setStatus(successCount === 1 ? "Post deleted." : `${successCount} posts deleted.`);
      showDeleteDone("Deleted");
    } else {
      setStatus("No posts deleted.");
    }
    hideDownloadProgress(0);
    updateActionButtons();
    updateDeleteCheckedButton();
  };

  const downloadAll = async () => {
    if (state.busy) return;
    const ready = await ensureFolderModeReady();
    if (!ready) return;
    state.busy = true;
    updateActionButtons();
    showDownloadProgress();
    setStatus("Loading all pages...");
    try {
      const exhaustOne = async (mode) => {
        const ms = getModeState(mode);
        let safety = 0;
        while (!ms.exhausted && safety < 2000) {
          const fetchIndex = ms.pageCursors.length - 1;
          await fetchAndCachePage(mode, fetchIndex);
          safety += 1;
        }
      };
      // One flat, newest-first stream covers every post. Rate limits are handled in the
      // fetch layer; the small delay just keeps the walk from bunching up.
      let assetSafety = 0;
      while (!state.assets.exhausted && assetSafety < 2000) {
        await fetchAndCacheAssetsPage(state.assets.pageTokens.length - 1);
        assetSafety += 1;
        setStatus(`Loading media... ${state.assets.totalLoaded} items`);
        await sleep(150);
      }
    } catch (error) {
      const detail = String((error && error.message) || error || "unknown error");
      state.busy = false;
      hideDownloadProgress(0);
      updateActionButtons();
      setStatus(`Failed to load all pages: ${detail}`);
      showToast(`Failed to load all pages: ${detail}`, "error");
      return;
    }
    invalidateGroupsMemo();
    updateItems();
    const groups = computeAllUnifiedItems();
    if (!groups.length) {
      state.busy = false;
      hideDownloadProgress(0);
      updateActionButtons();
      showToast("No posts to download.", "info");
      return;
    }
    setStatus(`Downloading ${groups.length} post${groups.length === 1 ? "" : "s"}...`);
    let succeeded = 0;
    const skipped = [];
    // A single picture/clip can surface under more than one post (e.g. a child image
    // and its top-level counterpart), which would otherwise be written into two
    // folders. Process video-bearing posts first so shared images attach to the video
    // folder, and track written media by content so nothing is saved twice.
    const orderedGroups = groups
      .map((group, index) => ({ group, index }))
      .sort((a, b) => (groupHasVideo(b.group) ? 1 : 0) - (groupHasVideo(a.group) ? 1 : 0));
    const writtenKeys = new Set();
    try {
      for (let i = 0; i < orderedGroups.length; i += 1) {
        const { group, index } = orderedGroups[i];
        const seedIds = group && group.variants && group.variants.length
          ? group.variants.map((v) => v && v.postId).filter(Boolean)
          : (group && group.postId ? [group.postId] : []);
        if (!seedIds.length) {
          skipped.push(index);
          continue;
        }
        // Same collector the per-post download uses: cascade links for legacy posts,
        // shared root for conversations, whose assets have no links to each other.
        const media = collectMediaUnderPost(group);
        const fresh = [];
        media.forEach((item) => {
          const key = mediaDedupKey(item);
          if (!key || writtenKeys.has(key)) return;
          writtenKeys.add(key);
          fresh.push(item);
        });
        if (!fresh.length) {
          // Everything here was already written under another post; skip this folder.
          continue;
        }
        setStatus(`Downloading post ${i + 1} of ${orderedGroups.length}...`);
        try {
          await downloadGroup(
            { variants: fresh },
            {
              skipFinalWait: true,
              bulk: true,
              folderName: (group && (group.groupId || group.postId)) || seedIds[0] || ""
            }
          );
          succeeded += 1;
        } catch (error) {
          skipped.push(index);
        }
        if (i < orderedGroups.length - 1) {
          await sleep(150);
        }
      }
    } finally {
      state.busy = false;
      hideDownloadProgress(0);
      updateActionButtons();
    }
    if (succeeded === 0) {
      showToast("No posts downloaded.", "error");
    } else if (skipped.length) {
      showToast(`${succeeded} of ${groups.length} posts downloaded; ${skipped.length} skipped.`, "info");
    } else {
      showToast(`${succeeded} post${succeeded === 1 ? "" : "s"} downloaded.`, "info");
    }
    setStatus(`Downloaded ${succeeded}/${groups.length} posts.`);
  };

  let root;
  let statusEl;
  let gridEl;
  let emptyEl;
  let countEl;
  let footerEl;
  let refreshBtn;
  let downloadAllBtn;
  let deleteAllBtn;
  let deleteCheckedBtn;
  let downloadCheckedBtn;
  let checkAllBtn;
  let hideModToastToggle;
  let downloadReadyEl;
  let downloadReadyAudio;
  let regenCreatedAudio;
  let regenCreatedNoticeEl;
  let regenCreatedTimer = null;
  let promptCopyAudio;
  let promptErrorAudio;
  let downloadClickAudio;
  let shareClickAudio;
  let closeClickAudio;
  let downloadProgressEl;
  let downloadProgressText;
  let downloadProgressFill;
  let progressStopBtn;
  let githubBtn;
  let deleteDoneEl;
  let deleteDoneTimer = null;
  let changelogModal;
  let changelogClose;
  let changelogGithub;
  let settingsModal;
  let settingsClose;
  let settingsBtn;
  let dlModeAsk;
  let dlModeFolder;
  let dlModeAuto;
  let dlModeFolderRow;
  let folderHintEl;
  let changeFolderBtn;
  let bulk32Btn;
  let bulk64Btn;
  let bulk120Btn;
  let bulk500Btn;
  let autoRefreshAlwaysCheck;
  let autoRefreshTimer = null;
  let autoRefreshFailures = 0;
  let autoRefreshLastFetchStatus = 0;
  const groupsMemoStamp = { videos: 0, images: 0 };
  const groupsMemoFor = { videos: -1, images: -1 };
  const groupsMemoResult = { videos: null, images: null };
  const invalidateGroupsMemo = (mode) => {
    if (mode === "videos" || mode === "images") {
      groupsMemoStamp[mode] += 1;
      return;
    }
    groupsMemoStamp.videos += 1;
    groupsMemoStamp.images += 1;
  };
  const pendingDeleteMarkers = new Set();
  const applyBlurToMarkedThumbs = () => {
    if (!gridEl || !pendingDeleteMarkers.size) return;
    const thumbs = gridEl.querySelectorAll(".thumb[data-index]");
    thumbs.forEach((thumbNode) => {
      const thumb = thumbNode instanceof HTMLElement ? thumbNode : null;
      if (!thumb) return;
      const idx = Number(thumb.dataset.index);
      if (!Number.isFinite(idx) || idx < 0 || idx >= state.items.length) return;
      const item = state.items[idx];
      if (!item) return;
      const variants = item.variants && item.variants.length ? item.variants : [item];
      const allMarked = variants.every((v) => {
        const pid = v && v.postId ? String(v.postId) : "";
        return pid && pendingDeleteMarkers.has(pid);
      });
      if (allMarked) thumb.classList.add("deleted-blurry");
    });
  };
  const flushPendingDeletes = () => {
    if (!pendingDeleteMarkers.size) return;
    ["videos", "images"].forEach((mode) => {
      const modeState = getModeState(mode);
      let anyChange = false;
      modeState.pageCache.forEach((pageItems, key) => {
        const before = pageItems || [];
        const filtered = before.filter((entry) => {
          const pid = entry && entry.postId ? String(entry.postId) : "";
          return !pid || !pendingDeleteMarkers.has(pid);
        });
        if (filtered.length !== before.length) {
          modeState.pageCache.set(key, filtered);
          anyChange = true;
        }
      });
      if (!anyChange) return;
      const rebuiltSeen = new Set();
      let rebuiltTotal = 0;
      modeState.pageCache.forEach((pageItems) => {
        (pageItems || []).forEach((entry) => {
          if (!entry) return;
          rebuiltTotal += 1;
          if (mode === "videos") {
            const keys = getVideoDedupKeys(entry);
            keys.forEach((key) => {
              if (key) rebuiltSeen.add(key);
            });
          } else {
            const key = getImageKey(entry);
            if (key) rebuiltSeen.add(key);
          }
        });
      });
      modeState.seen = rebuiltSeen;
      modeState.totalLoaded = rebuiltTotal;
      const cachedPages = Array.from(modeState.pageCache.keys()).filter((page) => {
        const pageItems = modeState.pageCache.get(page) || [];
        return pageItems.length > 0;
      });
      modeState.maxPageLoaded = cachedPages.length ? Math.max(...cachedPages) : -1;
      invalidateGroupsMemo(mode);
    });
    pendingDeleteMarkers.clear();
  };
  let duplicateModal;
  let duplicateClose;
  let duplicateMessageEl;
  let duplicateTimerEl;
  let duplicateYesBtn;
  let duplicateNoBtn;
  let duplicateTimerHandle = null;
  let duplicateIntervalHandle = null;
  let duplicateAskResolver = null;
  let duplicateAskActive = false;
  let duplicateModalPreviousFocus = null;
  let promptChoiceModal;
  let promptChoiceClose;
  let promptChoiceCopyBtn;
  let promptChoiceDownloadBtn;
  let promptChoiceAskResolver = null;
  let promptChoiceTimer = null;
  let promptChoiceModalPreviousFocus = null;
  let lightboxPromptNoticeTimer = null;
  const thumbPromptNoticeTimers = new WeakMap();
  let nestedGuideModal;
  let nestedGuideOkBtn;
  let nestedGuideDontRemind;
  let normalGuideModal;
  let normalGuideOkBtn;
  let normalGuideDontRemind;
  let floatingTooltip;
  let viewModeModal;
  let viewModeModalPreviousFocus = null;
  let modeGridBtn;
  let modeNormalBtn;
  let modeDownloadSettingsBtn;
  let modeSetupDoneDot;
  let modeDontRemind;
  let appEl;
  let brandTitleEl;
  let viewModeBtn;
  let viewModeIcon;
  let viewModeLabel;
  let lastDownloadFilename = "";
  let prevPageBtn;
  let nextPageBtn;
  let pageInfoEl;
  let lastPageBtn;
  let firstPageBtn;
  let pageJumpBtn;
  let logsBtn;
  let logsPanel;
  let logsBody;
  let clearLogsBtn;
  let purgeBtn;
  let logsCloseBtn;
  let thumbAutoplayBtn;
  let sortBtn;
  let tabVideosBtn;
  let tabImagesBtn;
  let lightboxEl;
  let lightboxCountEl;
  let closeBtn;
  let fullscreenBtn;
  let lightboxHdTag;
  let downloadBtn;
  let shareBtn;
  let deleteBtn;
  let promptBtn;
  let regenBtn;
  let autoNextBtn;
  let downloadGroupBtn;
  let autoAllBtn;
  let prevBtn;
  let nextBtn;
  let playerEl;
  let regenOverlayEl;
  let regenProgressTextEl;
  let regenProgressFillEl;
  let regenStopBtn;
  let regenNoticeEl;
  let regenNoticeTextEl;
  let regenNoticeCloseBtn;
  let regenDebugEl;
  let regenDebugBodyEl;
  let variantWrapEl;
  let variantStripEl;
  let variantMoreBtn;
  let variantAutoplayStopBtn;
  let variantDeleteCompilationBtn;
  let imageEl;
  let clearPlayerLoadHooks = null;
  let playerLoadToken = 0;
  let toastEl;
  let toastText;
  let hideModToastWrap;
  const progressControl = { action: "", requested: false };
  const regenState = {
    cooldownUntil: 0,
    jobs: new Map(),
    activePostId: "",
    lastJobAt: 0
  };
  const newGenerationHighlightIds = new Set();
  const hydratedNewVideoPosts = new Set();
  const variantHydrationInFlight = new Set();
  const variantHydrationTouched = new Map();
  const brokenThumbPostIds = new Set();
  let regenNoticeTimer = null;
  let regenCooldownTimer = null;
  let pendingRefreshAfterDelete = false;

  const countLoadedVideos = () => {
    let total = 0;
    state.assets.pageCache.forEach((pageItems) => {
      (pageItems || []).forEach((entry) => {
        if (entry && entry.kind !== "image") total += 1;
      });
    });
    return total;
  };

  const getCountSummary = () => {
    let totalPosts = 0;
    try {
      totalPosts = computeAllUnifiedItems().length;
    } catch (error) {
      totalPosts = state.items.length;
    }
    // The grid's videos come from the asset stream, not the per-mode caches.
    const videoTotal = countLoadedVideos() || getModeState("videos").totalLoaded || 0;
    return { totalPosts, videoTotal };
  };

  const updateCount = () => {
    const { totalPosts, videoTotal } = getCountSummary();
    const text = `${totalPosts} post${totalPosts === 1 ? "" : "s"} · ${videoTotal} video${videoTotal === 1 ? "" : "s"}`;
    if (countEl) countEl.textContent = text;
    if (lightboxCountEl) {
      const pageTotal = state.items.length;
      const current = pageTotal ? state.selectedIndex + 1 : 0;
      lightboxCountEl.textContent = `${current} / ${pageTotal}`;
    }
  };

  const getReadyStatus = () => {
    return "Ready";
  };

  const setReadyStatus = () => {
    if (statusEl) statusEl.textContent = getReadyStatus();
  };

  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text;
  };

  const isRegenCreatedNoticeVisible = () =>
    Boolean(regenCreatedNoticeEl && regenCreatedNoticeEl.classList.contains("show"));

  const hideRegenCreatedNotice = () => {
    if (regenCreatedTimer) {
      clearTimeout(regenCreatedTimer);
      regenCreatedTimer = null;
    }
    if (regenCreatedNoticeEl) regenCreatedNoticeEl.classList.remove("show");
    const progressVisible = downloadProgressEl && downloadProgressEl.classList.contains("show");
    const doneVisible = deleteDoneEl && deleteDoneEl.classList.contains("show");
    const toastVisible = toastEl && toastEl.classList.contains("show");
    if (githubBtn && !progressVisible && !doneVisible && !toastVisible) {
      githubBtn.classList.remove("hidden");
    }
  };

  const showRegenCreatedNotice = () => {
    if (!regenCreatedNoticeEl) return;
    if (regenCreatedTimer) {
      clearTimeout(regenCreatedTimer);
      regenCreatedTimer = null;
    }
    regenCreatedNoticeEl.textContent = "New generation created!";
    regenCreatedNoticeEl.classList.add("show");
    if (githubBtn) githubBtn.classList.add("hidden");
    if (regenCreatedAudio) {
      try {
        regenCreatedAudio.currentTime = 0;
        const playPromise = regenCreatedAudio.play();
        if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
      } catch (e) {}
    }
    regenCreatedTimer = setTimeout(() => {
      hideRegenCreatedNotice();
    }, 4000);
  };

  let downloadReadyTimer = null;
  const showDownloadReady = (label, filename) => {
    if (!downloadReadyEl) return;
    if (label) downloadReadyEl.textContent = label;
    if (filename) lastDownloadFilename = filename;
    downloadReadyEl.style.display = "inline-flex";
    setStatus("File ready!");
    setDownloadProgress("File ready!", 1);
    if (downloadProgressEl) downloadProgressEl.classList.remove("show");
    if (githubBtn) githubBtn.classList.remove("hidden");
    if (downloadReadyTimer) clearTimeout(downloadReadyTimer);
    downloadReadyTimer = setTimeout(() => {
      downloadReadyEl.style.display = "none";
      if (githubBtn) githubBtn.classList.remove("hidden");
      setReadyStatus();
    }, 5000);
    if (downloadReadyAudio) {
      try {
        downloadReadyAudio.currentTime = 0;
        const playPromise = downloadReadyAudio.play();
        if (playPromise && typeof playPromise.catch === "function") {
          playPromise.catch(() => {});
        }
      } catch (e) {}
    }
  };

  const openDownloadsFolder = (filename) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "grokViewerOpenDownloads", filename }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false });
      });
    });

  const openDownloadSettingsPage = () =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "grokViewerOpenDownloadSettingsAndReopen" }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false });
      });
    });

  const waitForDownload = (filename, requireComplete) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: "grokViewerWaitForDownload", filename, requireComplete: !!requireComplete },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false });
        }
      );
    });

  const getDownloadById = (downloadId) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "grokViewerGetDownloadById", downloadId }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false });
      });
    });

  const waitForDownloadIdOutcome = async (downloadId, timeoutMs) => {
    const deadline = Date.now() + (Number.isFinite(timeoutMs) ? timeoutMs : 120000);
    let seenRecord = false;
    while (Date.now() < deadline) {
      const status = await getDownloadById(downloadId);
      if (status && status.ok) {
        seenRecord = true;
        const stateName = String(status.state || "").toLowerCase();
        const errName = String(status.error || "").toLowerCase();
        if (stateName === "complete") return { ok: true, state: "complete", status };
        if (stateName === "interrupted") {
          if (errName.includes("cancel")) return { ok: true, state: "canceled", status };
          return { ok: true, state: "interrupted", status };
        }
      }
      await sleep(250);
    }
    return { ok: false, state: seenRecord ? "pending" : "not-found" };
  };

  const verifyDownloadResult = async (started, timeoutMs, requireComplete) => {
    if (!started || !started.ok) return { ok: false, state: "failed", outcome: null };
    const downloadId = Number((started && started.downloadId) || 0);
    if (!downloadId) return { ok: true, state: "unknown", outcome: null };
    const outcome = await waitForDownloadIdOutcome(downloadId, timeoutMs);
    const stateName = String((outcome && outcome.state) || "").toLowerCase();
    if (stateName === "complete") return { ok: true, state: "complete", outcome: outcome || null };
    if (stateName === "pending") {
      if (requireComplete) return { ok: false, state: "timeout", outcome: null };
      return { ok: true, state: "pending", outcome: null };
    }
    if (stateName === "not-found") return { ok: false, state: "not-found", outcome: null };
    if (stateName === "canceled") return { ok: false, state: "canceled", outcome: outcome || null };
    if (stateName === "interrupted") return { ok: false, state: "interrupted", outcome: outcome || null };
    if (requireComplete) return { ok: false, state: stateName || "failed", outcome: null };
    return { ok: true, state: "pending", outcome: null };
  };

  const waitForDownloadWithTimeout = async (filename, requireComplete, timeoutMs) => {
    const limit = Number.isFinite(timeoutMs) ? timeoutMs : 45000;
    const result = await Promise.race([
      waitForDownload(filename, requireComplete),
      sleep(limit).then(() => ({ ok: false, timeout: true }))
    ]);
    return result || { ok: false };
  };

  const setProgressCancelableAction = (action) => {
    progressControl.action = action || "";
    progressControl.requested = false;
    if (!progressStopBtn) return;
    if (!progressControl.action) {
      progressStopBtn.style.display = "none";
      progressStopBtn.disabled = false;
      return;
    }
    progressStopBtn.style.display = "inline-flex";
    progressStopBtn.disabled = false;
  };

  const requestProgressCancel = () => {
    if (!progressControl.action) return;
    progressControl.requested = true;
    if (progressStopBtn) progressStopBtn.disabled = true;
  };

  const isProgressCancelRequested = (action) =>
    Boolean(progressControl.requested && progressControl.action && (!action || progressControl.action === action));

  let downloadProgressTimer = null;
  const showDownloadProgress = () => {
    if (downloadProgressTimer) clearTimeout(downloadProgressTimer);
    if (downloadProgressEl) downloadProgressEl.classList.add("show");
    if (githubBtn) githubBtn.classList.add("hidden");
    if (deleteDoneEl) deleteDoneEl.classList.remove("show");
  };

  const showDeleteProgress = (text, ratio) => {
    showDownloadProgress();
    setDownloadProgress(text, ratio);
  };

  const hideDownloadProgress = (delayMs) => {
    if (downloadProgressTimer) clearTimeout(downloadProgressTimer);
    const run = () => {
      setProgressCancelableAction("");
      if (downloadProgressEl) downloadProgressEl.classList.remove("show");
      const readyVisible = downloadReadyEl && downloadReadyEl.style.display === "inline-flex";
      const toastVisible = toastEl && toastEl.classList.contains("show");
      const regenCreatedVisible = isRegenCreatedNoticeVisible();
      if (githubBtn && !readyVisible && !toastVisible && !regenCreatedVisible) githubBtn.classList.remove("hidden");
      if (downloadProgressFill) downloadProgressFill.style.width = "0%";
    };
    if (delayMs && delayMs > 0) {
      downloadProgressTimer = setTimeout(run, delayMs);
      return;
    }
    run();
  };

  const setDownloadProgress = (text, ratio) => {
    if (downloadProgressText) downloadProgressText.textContent = text || "";
    if (downloadProgressFill) {
      const pct = Math.max(0, Math.min(100, Math.round((ratio || 0) * 100)));
      downloadProgressFill.style.width = `${pct}%`;
    }
  };

  const showDeleteDone = (message) => {
    setProgressCancelableAction("");
    if (downloadProgressEl) downloadProgressEl.classList.add("pulse");
    if (deleteDoneTimer) clearTimeout(deleteDoneTimer);
    deleteDoneTimer = setTimeout(() => {
      if (downloadProgressEl) downloadProgressEl.classList.remove("show");
      if (downloadProgressEl) downloadProgressEl.classList.remove("pulse");
      if (downloadProgressFill) downloadProgressFill.style.width = "0%";
      if (deleteDoneEl) {
        deleteDoneEl.textContent = message;
        deleteDoneEl.classList.add("show");
      }
      if (githubBtn) githubBtn.classList.add("hidden");
      deleteDoneTimer = setTimeout(() => {
        if (deleteDoneEl) deleteDoneEl.classList.remove("show");
        if (githubBtn && !isRegenCreatedNoticeVisible()) githubBtn.classList.remove("hidden");
      }, 2000);
    }, 400);
  };

  let toastTimer = null;
  const showToast = (message, type) => {
    if (!toastEl || !toastText) return;
    toastText.textContent = message;
    toastEl.classList.remove("hide", "error");
    if (type === "error") toastEl.classList.add("error");
    toastEl.classList.add("show");
    if (githubBtn) githubBtn.classList.add("hidden");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove("show");
      toastEl.classList.add("hide");
      const progressVisible = downloadProgressEl && downloadProgressEl.classList.contains("show");
      const doneVisible = deleteDoneEl && deleteDoneEl.classList.contains("show");
      const regenCreatedVisible = isRegenCreatedNoticeVisible();
      if (githubBtn && !progressVisible && !doneVisible && !regenCreatedVisible) githubBtn.classList.remove("hidden");
    }, 1600);
  };

  const clearLightboxPromptInlineNotice = () => {
    const actionsEl = lightboxEl ? lightboxEl.querySelector(".lightbox-actions") : null;
    if (!actionsEl) return;
    if (lightboxPromptNoticeTimer) {
      clearTimeout(lightboxPromptNoticeTimer);
      lightboxPromptNoticeTimer = null;
    }
    actionsEl.classList.remove("prompt-inline-active");
    const notice = actionsEl.querySelector(".prompt-inline-notice");
    if (notice) {
      notice.classList.remove("error");
      notice.textContent = "";
    }
  };

  const showLightboxPromptInlineNotice = (message, type) => {
    const actionsEl = lightboxEl ? lightboxEl.querySelector(".lightbox-actions") : null;
    if (!actionsEl) return false;
    let notice = actionsEl.querySelector(".prompt-inline-notice");
    if (!notice) {
      notice = document.createElement("div");
      notice.className = "prompt-inline-notice";
      actionsEl.appendChild(notice);
    }
    notice.textContent = String(message || "").trim();
    notice.classList.toggle("error", type === "error");
    actionsEl.classList.add("prompt-inline-active");
    if (lightboxPromptNoticeTimer) clearTimeout(lightboxPromptNoticeTimer);
    lightboxPromptNoticeTimer = setTimeout(() => {
      clearLightboxPromptInlineNotice();
    }, 4000);
    return true;
  };

  const clearThumbPromptInlineNotice = (thumb) => {
    if (!thumb) return;
    const timer = thumbPromptNoticeTimers.get(thumb);
    if (timer) {
      clearTimeout(timer);
      thumbPromptNoticeTimers.delete(thumb);
    }
    thumb.classList.remove("prompt-inline-active");
    const notice = thumb.querySelector(".thumb-inline-notice");
    if (notice) {
      notice.classList.remove("error");
      notice.textContent = "";
    }
  };

  const showThumbPromptInlineNotice = (thumb, message, type) => {
    if (!thumb) return false;
    const overlay = thumb.querySelector(".thumb-overlay");
    if (!overlay) return false;
    let notice = overlay.querySelector(".thumb-inline-notice");
    if (!notice) {
      notice = document.createElement("div");
      notice.className = "thumb-inline-notice";
      overlay.appendChild(notice);
    }
    notice.textContent = String(message || "").trim();
    notice.classList.toggle("error", type === "error");
    thumb.classList.add("prompt-inline-active");
    const oldTimer = thumbPromptNoticeTimers.get(thumb);
    if (oldTimer) clearTimeout(oldTimer);
    const timer = setTimeout(() => {
      clearThumbPromptInlineNotice(thumb);
    }, 4000);
    thumbPromptNoticeTimers.set(thumb, timer);
    return true;
  };

  const showPromptInlineFeedback = (message, type, context = {}) => {
    const safeMessage = String(message || "").trim();
    if (!safeMessage) return;
    const source = String((context && context.source) || "").toLowerCase();
    const trigger = context && context.trigger ? context.trigger : null;
    if (source === "lightbox") {
      if (showLightboxPromptInlineNotice(safeMessage, type)) return;
    }
    if (source === "thumb") {
      const thumb = context && context.thumbEl ? context.thumbEl : trigger && trigger.closest ? trigger.closest(".thumb") : null;
      if (showThumbPromptInlineNotice(thumb, safeMessage, type)) return;
    }
    if (showToast) showToast(safeMessage, type);
  };

  const getSelectedRegenPostId = () => {
    const selected = state.items[state.selectedIndex];
    const active = resolveActiveItem(selected);
    return active && active.postId ? String(active.postId).trim() : "";
  };

  const getActiveRegenPostId = () => {
    const selectedPostId = getSelectedRegenPostId();
    if (selectedPostId) {
      regenState.activePostId = selectedPostId;
      return selectedPostId;
    }
    return String(regenState.activePostId || "").trim();
  };

  const getRegenJob = (postId) => {
    const key = String(postId || "").trim();
    if (!key) return null;
    return regenState.jobs.get(key) || null;
  };

  const getOrCreateRegenJob = (postId) => {
    const key = String(postId || "").trim();
    if (!key) return null;
    const existing = regenState.jobs.get(key);
    if (existing) return existing;
    const created = {
      postId: key,
      running: false,
      progress: 0,
      abortController: null,
      logs: []
    };
    regenState.jobs.set(key, created);
    return created;
  };

  const getRunningRegenCount = () => {
    let count = 0;
    regenState.jobs.forEach((job) => {
      if (job && job.running) count += 1;
    });
    return count;
  };

  const collectPostIdsForItem = (item) => {
    const ids = new Set();
    const add = (value) => {
      const id = String(value || "").trim();
      if (id) ids.add(id);
    };
    if (!item) return ids;
    const active = resolveActiveItem(item) || item;
    add(active && active.postId);
    add(item.postId);
    if (item.variants && item.variants.length) {
      for (let i = 0; i < item.variants.length; i += 1) {
        add(item.variants[i] && item.variants[i].postId);
      }
    }
    return ids;
  };

  const hasNewGenerationHighlight = (item, displayItem) => {
    const postId = String((displayItem && displayItem.postId) || "").trim();
    if (postId && newGenerationHighlightIds.has(postId)) return true;
    if (item && item.variants && item.variants.length) {
      for (let i = 0; i < item.variants.length; i += 1) {
        const id = String((item.variants[i] && item.variants[i].postId) || "").trim();
        if (id && newGenerationHighlightIds.has(id)) return true;
      }
    }
    return false;
  };

  const ensureThumbNewRibbon = (thumb) => {
    if (!thumb) return null;
    let ribbon = thumb.querySelector(".thumb-new-ribbon");
    if (!ribbon) {
      ribbon = document.createElement("span");
      ribbon.className = "thumb-new-ribbon";
      ribbon.textContent = "NEW";
      thumb.appendChild(ribbon);
    }
    return ribbon;
  };

  const syncGridNewGenerationVisuals = () => {
    if (!gridEl) return;
    const thumbs = gridEl.querySelectorAll(".thumb[data-index]");
    for (let i = 0; i < thumbs.length; i += 1) {
      const thumb = thumbs[i];
      const index = Number(thumb.dataset.index || "-1");
      if (!Number.isFinite(index) || index < 0 || index >= state.items.length) continue;
      const item = state.items[index];
      const displayItem = resolveActiveItem(item) || item;
      const shouldHighlight = hasNewGenerationHighlight(item, displayItem);
      thumb.classList.toggle("new-generation", shouldHighlight);
      if (shouldHighlight) {
        ensureThumbNewRibbon(thumb);
      } else {
        const ribbon = thumb.querySelector(".thumb-new-ribbon");
        if (ribbon && ribbon.parentNode) ribbon.parentNode.removeChild(ribbon);
      }
    }
  };

  const markNewGenerationHighlight = (postId) => {
    const id = String(postId || "").trim();
    if (!id) return;
    newGenerationHighlightIds.add(id);
  };

  const consumeNewGenerationHighlightForPostId = (postId) => {
    const id = String(postId || "").trim();
    if (!id) return false;
    const changed = newGenerationHighlightIds.delete(id);
    if (changed) syncGridNewGenerationVisuals();
    return changed;
  };

  const consumeNewGenerationHighlight = (item) => {
    const ids = collectPostIdsForItem(item);
    if (!ids.size) return false;
    let changed = false;
    ids.forEach((id) => {
      if (newGenerationHighlightIds.delete(id)) changed = true;
    });
    if (!changed) return changed;
    syncGridNewGenerationVisuals();
    return changed;
  };

  const updateRegenDebugPanel = () => {
    if (!regenDebugEl) return;
    if (!REGEN_DEBUG_ENABLED) {
      regenDebugEl.classList.remove("show");
      regenDebugEl.setAttribute("hidden", "hidden");
      if (regenDebugBodyEl) regenDebugBodyEl.textContent = "";
      return;
    }
    const lightboxOpen = Boolean(lightboxEl && lightboxEl.classList.contains("open"));
    const activePostId = getActiveRegenPostId();
    const job = getRegenJob(activePostId);
    const lines = job && Array.isArray(job.logs) ? job.logs : [];
    const shouldShow = lightboxOpen && (Boolean(job && job.running) || lines.length > 0);
    if (!shouldShow) {
      regenDebugEl.classList.remove("show");
      regenDebugEl.setAttribute("hidden", "hidden");
      if (regenDebugBodyEl) regenDebugBodyEl.textContent = "";
      return;
    }
    if (regenDebugBodyEl) {
      regenDebugBodyEl.textContent = lines.join("\n");
      regenDebugBodyEl.scrollTop = regenDebugBodyEl.scrollHeight;
    }
    regenDebugEl.removeAttribute("hidden");
    regenDebugEl.classList.add("show");
  };

  const appendRegenLog = (postId, message) => {
    if (!REGEN_DEBUG_ENABLED) return;
    const job = getOrCreateRegenJob(postId);
    if (!job) return;
    const line = `[${formatTime(new Date())}] ${String(message || "")}`;
    job.logs.push(line);
    if (job.logs.length > REGEN_LOG_LIMIT) {
      job.logs.splice(0, job.logs.length - REGEN_LOG_LIMIT);
    }
    updateRegenDebugPanel();
  };

  const clearRegenLogs = (postId) => {
    if (!REGEN_DEBUG_ENABLED) return;
    const job = getOrCreateRegenJob(postId);
    if (!job) return;
    job.logs = [];
    updateRegenDebugPanel();
  };

  const clearRegenNoticeTimer = () => {
    if (!regenNoticeTimer) return;
    clearTimeout(regenNoticeTimer);
    regenNoticeTimer = null;
  };

  const hideRegenNotice = () => {
    clearRegenNoticeTimer();
    if (!regenNoticeEl) return;
    regenNoticeEl.classList.remove("show", "error");
    if (regenNoticeTextEl) {
      regenNoticeTextEl.textContent = "";
    } else {
      regenNoticeEl.textContent = "";
    }
  };

  const showRegenNotice = (message, type, timeoutMs) => {
    if (!regenNoticeEl || !message) return;
    clearRegenNoticeTimer();
    if (regenNoticeTextEl) {
      regenNoticeTextEl.textContent = message;
    } else {
      regenNoticeEl.textContent = message;
    }
    regenNoticeEl.classList.remove("error");
    if (type === "error") regenNoticeEl.classList.add("error");
    regenNoticeEl.classList.add("show");
    const delay = Number.isFinite(timeoutMs) ? timeoutMs : 4200;
    if (delay > 0) {
      regenNoticeTimer = setTimeout(() => {
        hideRegenNotice();
      }, Math.max(900, delay));
    }
  };

  const setRegenOverlayVisible = (visible) => {
    if (!regenOverlayEl) return;
    const show = !!visible;
    regenOverlayEl.classList.toggle("show", show);
    regenOverlayEl.setAttribute("aria-hidden", show ? "false" : "true");
    if (regenStopBtn) regenStopBtn.disabled = !show;
  };

  const syncRegenOverlay = () => {
    const lightboxOpen = Boolean(lightboxEl && lightboxEl.classList.contains("open"));
    if (!lightboxOpen) {
      setRegenOverlayVisible(false);
      updateRegenDebugPanel();
      return;
    }
    const activePostId = getActiveRegenPostId();
    const job = getRegenJob(activePostId);
    if (!job || !job.running) {
      setRegenOverlayVisible(false);
      if (regenStopBtn) regenStopBtn.disabled = true;
      updateRegenDebugPanel();
      return;
    }
    const pct = Math.max(0, Math.min(100, Math.round(Number(job.progress) || 0)));
    if (regenProgressFillEl) regenProgressFillEl.style.setProperty("--regen-pct", String(pct));
    if (regenProgressTextEl) regenProgressTextEl.textContent = `${pct}%`;
    setRegenOverlayVisible(true);
    if (regenStopBtn) regenStopBtn.disabled = false;
    updateRegenDebugPanel();
  };

  const setRegenProgress = (postId, progressValue, textOverride) => {
    const job = getOrCreateRegenJob(postId);
    if (!job) return;
    const pct = Math.max(0, Math.min(100, Math.round(Number(progressValue) || 0)));
    job.progress = pct;
    if (textOverride && getActiveRegenPostId() === job.postId && regenProgressTextEl && /(\d{1,3})/.test(String(textOverride))) {
      const match = String(textOverride).match(/(\d{1,3})/);
      if (match) regenProgressTextEl.textContent = `${Math.max(0, Math.min(100, Number(match[1]) || 0))}%`;
    }
    syncRegenOverlay();
    syncThumbRegenIndicators(job.postId);
  };

  const clearRegenCooldownTimer = () => {
    if (!regenCooldownTimer) return;
    clearInterval(regenCooldownTimer);
    regenCooldownTimer = null;
  };

  const startRegenCooldown = () => {
    regenState.cooldownUntil = Date.now() + REGEN_COOLDOWN_MS;
    clearRegenCooldownTimer();
    regenCooldownTimer = setInterval(() => {
      if (Date.now() >= regenState.cooldownUntil) {
        regenState.cooldownUntil = 0;
        clearRegenCooldownTimer();
      }
      updateActionButtons();
    }, 250);
  };

  const getRegenCooldownSeconds = () => {
    const leftMs = regenState.cooldownUntil - Date.now();
    if (leftMs <= 0) return 0;
    return Math.ceil(leftMs / 1000);
  };

  const resolveRegenIconPath = () => (isGridMode() ? "images/thumbnail/regen.svg" : "images/regen.svg");

  const updateRegenButtonVisual = () => {
    if (!regenBtn) return;
    const icon = regenBtn.querySelector("img");
    if (icon) {
      const nextPath = chrome.runtime.getURL(resolveRegenIconPath());
      if (icon.src !== nextPath) icon.src = nextPath;
    }
  };

  const buildImageReferenceFallback = (postId) => {
    const id = String(postId || "").trim();
    if (!id) return "";
    return `https://imagine-public.x.ai/imagine-public/images/${id}.jpg`;
  };

  const getParentImageFallbackUrl = (item) => {
    if (!item) return "";
    const parentId = String(item.parentPostId || item.originalPostId || "").trim();
    if (!parentId) return "";
    return normalizeUrl(buildImageReferenceFallback(parentId));
  };

  const getBestPosterUrl = (item, options = {}) => {
    if (!item) return "";
    const preferSource = Boolean(options && options.preferSource);
    const sourceImage = normalizeUrl(String(item.sourceImageUrl || "").trim());
    const posterImage = normalizeUrl(String(item.poster || "").trim());
    const parentFallback = getParentImageFallbackUrl(item);
    const ownFallback = normalizeUrl(buildImageReferenceFallback(item.postId || ""));
    const ordered = preferSource
      ? [sourceImage, parentFallback, ownFallback, posterImage]
      : [posterImage, sourceImage, parentFallback, ownFallback];
    for (let i = 0; i < ordered.length; i += 1) {
      const candidate = ordered[i];
      if (!candidate || isMp4(candidate, item.mimeType)) continue;
      return optimizeThumbUrl(candidate);
    }
    return "";
  };

  const sanitizeRegenPrompt = (value) => String(value || "").replace(/\s+/g, " ").trim();

  const normalizeRegenMode = (mode, prompt) => {
    const raw = String(mode || "").trim().toLowerCase();
    if (raw === "custom") return prompt ? "custom" : "normal";
    if (raw === "normal") return "normal";
    return prompt ? "custom" : "normal";
  };

  const normalizeVideoLength = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 6;
    return Math.max(2, Math.min(60, Math.round(parsed)));
  };

  const normalizeResolutionName = (value) => {
    const text = String(value || "").trim();
    return text || "480p";
  };

  const makeUuidLike = () => {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
      }
    } catch (error) {}
    const part = (size) => {
      let out = "";
      const chars = "0123456789abcdef";
      for (let i = 0; i < size; i += 1) {
        out += chars[Math.floor(Math.random() * chars.length)];
      }
      return out;
    };
    return `${part(8)}-${part(4)}-${part(4)}-${part(4)}-${part(12)}`;
  };

  const encodeBase64 = (value) => {
    const text = String(value || "");
    try {
      return btoa(unescape(encodeURIComponent(text)));
    } catch (error) {
      try {
        return btoa(text);
      } catch (error2) {
        return "";
      }
    }
  };
  const looksLikeStatsigHeader = (value) => {
    const text = String(value || "").trim();
    if (!text) return false;
    if (text.length < 80 || text.length > 140) return false;
    return /^[A-Za-z0-9+/_=-]+$/.test(text);
  };
  const makeStatsigLikeId = () => {
    try {
      if (window.crypto && typeof window.crypto.getRandomValues === "function") {
        const bytes = new Uint8Array(70);
        window.crypto.getRandomValues(bytes);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 1) {
          binary += String.fromCharCode(bytes[i]);
        }
        const generated = btoa(binary).replace(/=+$/g, "");
        if (looksLikeStatsigHeader(generated)) return generated;
      }
    } catch (error) {}
    const seed = `${Date.now()}-${Math.random()}-${location.href}-${makeUuidLike()}`;
    const fallback = encodeBase64(seed + seed).replace(/=+$/g, "");
    if (looksLikeStatsigHeader(fallback)) return fallback;
    return encodeBase64(`${seed}-${seed}-${seed}`).replace(/=+$/g, "").slice(0, 96);
  };

  const resolveStatsigHeader = () => {
    const fromStorage = (storageObj) => {
      if (!storageObj) return "";
      const directKeys = [
        "statsig.stable_id",
        "statsigStableId",
        "statsig_stable_id",
        "x-statsig-id",
        "x_statsig_id"
      ];
      for (let i = 0; i < directKeys.length; i += 1) {
        try {
          const value = String(storageObj.getItem(directKeys[i]) || "").trim();
          if (looksLikeStatsigHeader(value)) return value;
        } catch (error) {}
      }
      let keys = [];
      try {
        keys = Object.keys(storageObj);
      } catch (error) {
        keys = [];
      }
      for (let i = 0; i < keys.length; i += 1) {
        const key = String(keys[i] || "").toLowerCase();
        if (!key.includes("statsig")) continue;
        let raw = "";
        try {
          raw = String(storageObj.getItem(keys[i]) || "");
        } catch (error) {
          raw = "";
        }
        if (!raw) continue;
        const trimmed = raw.trim();
        if (looksLikeStatsigHeader(trimmed)) return trimmed;
        try {
          const parsed = JSON.parse(raw);
          const nestedCandidates = [
            parsed,
            parsed && parsed.stableID,
            parsed && parsed.stableId,
            parsed && parsed.statsigStableId,
            parsed && parsed.statsig_stable_id,
            parsed && parsed.statsigId,
            parsed && parsed.id,
            parsed && parsed.value
          ];
          for (let j = 0; j < nestedCandidates.length; j += 1) {
            const candidate = String(nestedCandidates[j] || "").trim();
            if (looksLikeStatsigHeader(candidate)) return candidate;
          }
        } catch (error) {}
      }
      return "";
    };
    let value = "";
    try {
      value = fromStorage(window.localStorage);
    } catch (error) {}
    if (value) return value;
    try {
      value = fromStorage(window.sessionStorage);
    } catch (error) {}
    if (value) return value;
    return makeStatsigLikeId();
  };

  const buildRegenRequestHeaders = () => ({
    "content-type": "application/json",
    accept: "*/*",
    "x-xai-request-id": makeUuidLike(),
    "x-statsig-id": resolveStatsigHeader()
  });

  const fetchPostDetails = async (postId) => {
    if (!postId) return null;
    const response = await fetch(POST_GET_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ id: postId })
    });
    if (!response.ok) throw new Error(`post/get HTTP ${response.status}`);
    const data = await response.json();
    return data && data.post ? data.post : null;
  };

  const deriveHdMetaFromDetail = (detailPost, targetPostId) => {
    if (!detailPost || typeof detailPost !== "object") {
      return {
        resolutionName: "",
        resolutionWidth: 0,
        resolutionHeight: 0,
        hasSignal: false,
        isHD: false
      };
    }
    const targetId = String(targetPostId || "").trim();
    const candidates = [
      detailPost,
      ...(Array.isArray(detailPost.videos) ? detailPost.videos : []),
      ...(Array.isArray(detailPost.childPosts) ? detailPost.childPosts : [])
    ].filter(Boolean);
    let matched = null;
    if (targetId) {
      matched = candidates.find((entry) => String((entry && entry.id) || "").trim() === targetId) || null;
    }
    if (!matched) matched = detailPost;
    const baseVideo =
      detailPost && Array.isArray(detailPost.videos) && detailPost.videos.length ? detailPost.videos[0] : null;
    const matchedResolution = extractResolutionPair(matched);
    const detailResolution = extractResolutionPair(detailPost);
    const baseResolution = extractResolutionPair(baseVideo);
    const resolutionName = String(
      (matched && matched.resolutionName) || (detailPost && detailPost.resolutionName) || (baseVideo && baseVideo.resolutionName) || ""
    ).trim();
    const resolutionWidth = toPositiveSize(
      matchedResolution.width || detailResolution.width || baseResolution.width || 0
    );
    const resolutionHeight = toPositiveSize(
      matchedResolution.height || detailResolution.height || baseResolution.height || 0
    );
    const hasSignal =
      parseResolutionHeightFromName(resolutionName) !== null || Boolean(resolutionWidth || resolutionHeight);
    return {
      resolutionName,
      resolutionWidth,
      resolutionHeight,
      hasSignal,
      isHD: hasSignal ? isHdResolutionMeta(resolutionName, resolutionWidth, resolutionHeight) : false
    };
  };

  const patchHdMetaIntoVideoCache = (postId, meta) => {
    const key = String(postId || "").trim();
    if (!key || !meta) return;
    const modeState = getModeState("videos");
    modeState.pageCache.forEach((pageItems, pageKey) => {
      let changed = false;
      const patched = (pageItems || []).map((entry) => {
        if (!entry || String(entry.postId || "").trim() !== key) return entry;
        changed = true;
        return {
          ...entry,
          resolutionName: meta.resolutionName || entry.resolutionName || "",
          resolutionWidth: meta.resolutionWidth || entry.resolutionWidth || 0,
          resolutionHeight: meta.resolutionHeight || entry.resolutionHeight || 0,
          isHD: meta.hasSignal ? meta.isHD === true : entry.isHD
        };
      });
      if (changed) modeState.pageCache.set(pageKey, patched);
    });
  };

  const shouldProbeHdMeta = (item) => {
    if (!item) return false;
    const postId = String(item.postId || "").trim();
    if (!postId) return false;
    if (hdMetaByPostId.has(postId)) return false;
    if (hdProbeInFlight.has(postId) || hdProbeQueued.has(postId)) return false;
    if (item.isHD === true) return false;
    if (!hasHdResolutionSignal(item)) return true;
    const namedHeight = parseResolutionHeightFromName(item.resolutionName);
    if (namedHeight !== null && namedHeight >= 720) return false;
    if (hasHdUrlCandidate(item)) return true;
    return false;
  };

  const syncVisibleHdBadges = () => {
    if (!gridEl || state.mode !== "videos") return;
    const thumbs = gridEl.querySelectorAll(".thumb[data-index]");
    for (let i = 0; i < thumbs.length; i += 1) {
      const thumb = thumbs[i];
      const idx = Number(thumb.dataset.index || "-1");
      if (!Number.isFinite(idx) || idx < 0 || idx >= state.items.length) continue;
      const item = state.items[idx];
      const displayItem = resolveActiveItem(item) || item;
      const show = isHdVideoItem(displayItem);
      const existing = thumb.querySelector(".thumb-hd-tag");
      if (show) {
        if (!existing) {
          const hdTag = document.createElement("span");
          hdTag.className = "thumb-hd-tag";
          hdTag.textContent = "HD";
          thumb.appendChild(hdTag);
        }
      } else if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }
    }
  };

  const pumpHdProbeQueue = () => {
    while (hdProbeRunning < HD_PROBE_MAX && hdProbeQueue.length) {
      const postId = hdProbeQueue.shift();
      const key = String(postId || "").trim();
      hdProbeQueued.delete(key);
      if (!key || hdProbeInFlight.has(key) || hdMetaByPostId.has(key)) continue;
      hdProbeInFlight.add(key);
      hdProbeRunning += 1;
      fetchPostDetails(key)
        .then((detail) => {
          const meta = deriveHdMetaFromDetail(detail, key);
          hdMetaByPostId.set(key, meta);
          patchHdMetaIntoVideoCache(key, meta);
          syncVisibleHdBadges();
        })
        .catch(() => {
          hdMetaByPostId.set(key, {
            resolutionName: "",
            resolutionWidth: 0,
            resolutionHeight: 0,
            hasSignal: false,
            isHD: false
          });
        })
        .finally(() => {
          hdProbeInFlight.delete(key);
          hdProbeRunning = Math.max(0, hdProbeRunning - 1);
          pumpHdProbeQueue();
        });
    }
  };

  const queueHdProbe = (item) => {
    if (!shouldProbeHdMeta(item)) return;
    const postId = String(item.postId || "").trim();
    hdProbeQueued.add(postId);
    hdProbeQueue.push(postId);
    pumpHdProbeQueue();
  };

  const buildRegenMessage = (imageReference, prompt, requestedMode) => {
    const safePrompt = sanitizeRegenPrompt(prompt || "");
    let mode = normalizeRegenMode(requestedMode, safePrompt);
    if (mode === "custom" && !safePrompt) mode = "normal";
    const parts = [];
    if (imageReference) parts.push(String(imageReference).trim());
    if (mode === "custom" && safePrompt) parts.push(safePrompt);
    if (!parts.length && safePrompt) parts.push(safePrompt);
    parts.push(`--mode=${mode}`);
    return parts.join("  ").trim();
  };

  const buildRegenContext = (item, detail) => {
    const active = resolveActiveItem(item) || item;
    const detailPost = detail || null;
    const detailPrompt = getPostPromptText(detailPost);
    const itemPrompt = sanitizeRegenPrompt(getPromptTextForItem(item) || "");
    const prompt = sanitizeRegenPrompt(detailPrompt || itemPrompt || "");

    const detailMediaType = String((detailPost && detailPost.mediaType) || "").toUpperCase();
    const fromDetailParent =
      (detailPost &&
        (detailPost.originalPostId ||
          detailPost.parentPostId ||
          (detailPost.originalPost && detailPost.originalPost.id) ||
          (detailMediaType.includes("IMAGE") ? detailPost.id : ""))) ||
      "";
    let parentPostId =
      String(
        fromDetailParent ||
          (active && (active.parentPostId || active.originalPostId || active.postId)) ||
          ""
      ).trim();

    const imageCandidates = [
      detailPost && detailPost.originalPost && detailPost.originalPost.mediaUrl,
      detailPost && Array.isArray(detailPost.images) && detailPost.images[0] && detailPost.images[0].mediaUrl,
      detailMediaType.includes("IMAGE") && detailPost ? detailPost.mediaUrl : "",
      active && active.sourceImageUrl,
      active && active.url && isImage(active.url, active.mimeType) ? active.url : "",
      buildImageReferenceFallback(parentPostId)
    ];
    let imageReference = "";
    for (let i = 0; i < imageCandidates.length; i += 1) {
      const candidate = normalizeUrl(imageCandidates[i] || "");
      if (!candidate) continue;
      if (isImage(candidate, "")) {
        imageReference = candidate;
        break;
      }
    }
    if (!imageReference && parentPostId) {
      imageReference = buildImageReferenceFallback(parentPostId);
    }
    if (!parentPostId && imageReference) {
      parentPostId = extractImageId(imageReference) || parentPostId;
    }
    if (!parentPostId && detailPost && detailPost.id) parentPostId = String(detailPost.id);

    const aspectRatioFromDetail =
      normalizeAspectRatioText(detailPost && detailPost.aspectRatio) ||
      normalizeAspectRatioText(detailPost && detailPost.mediaAspectRatio) ||
      normalizeAspectRatioText(detailPost && detailPost.ratio);
    const detailRes = extractResolutionPair(detailPost);
    const originalRes = extractResolutionPair(detailPost && detailPost.originalPost ? detailPost.originalPost : null);
    const activeWidth = toPositiveSize(active && active.mediaWidth);
    const activeHeight = toPositiveSize(active && active.mediaHeight);
    const width = detailRes.width || originalRes.width || activeWidth;
    const height = detailRes.height || originalRes.height || activeHeight;
    const aspectRatio = aspectRatioFromDetail || pickAspectRatioFromDimensions(width, height);

    const baseVideo = detailPost && Array.isArray(detailPost.videos) && detailPost.videos.length ? detailPost.videos[0] : null;
    const resolutionName = normalizeResolutionName(
      (detailPost && detailPost.resolutionName) || (baseVideo && baseVideo.resolutionName) || "480p"
    );
    const videoLength = normalizeVideoLength(
      (detailPost && detailPost.videoDuration) || (baseVideo && baseVideo.videoDuration) || 6
    );
    const mode = normalizeRegenMode((detailPost && detailPost.mode) || "", prompt);
    const message = buildRegenMessage(imageReference, prompt, mode);

    if ((!imageReference && !prompt) || !message || (!parentPostId && !imageReference)) return null;
    if (!parentPostId && imageReference) {
      parentPostId = extractImageId(imageReference) || parentPostId;
    }

    return {
      parentPostId: String(parentPostId || "").trim(),
      imageReference: imageReference || "",
      prompt,
      mode,
      aspectRatio,
      videoLength,
      resolutionName,
      message
    };
  };

  const buildRegenPayload = (context) => ({
    temporary: true,
    modelName: "grok-3",
    message: context.message,
    toolOverrides: { videoGen: true },
    enableSideBySide: true,
    responseMetadata: {
      experiments: [],
      modelConfigOverride: {
        modelMap: {
          videoGenModelConfig: {
            parentPostId: context.parentPostId,
            aspectRatio: context.aspectRatio,
            videoLength: context.videoLength,
            isVideoEdit: false,
            resolutionName: context.resolutionName
          }
        }
      }
    }
  });

  const toEpochMs = (value) => {
    if (!value) return 0;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const collectVideoItemsFromDetail = (detailPost) => {
    if (!detailPost || typeof detailPost !== "object") return [];
    try {
      const extracted = extractItems([detailPost]);
      return dedupeItems((extracted && extracted.videos) || []);
    } catch (error) {
      return [];
    }
  };

  const resolveRefreshedVideoItem = (
    detailPost,
    targetPostId,
    fallbackParentPostId,
    fallbackSourceImageUrl,
    fallbackPromptText
  ) => {
    if (!detailPost || typeof detailPost !== "object") return null;
    const targetId = String(targetPostId || "").trim();
    const direct = buildItem(
      detailPost,
      fallbackParentPostId || "",
      fallbackSourceImageUrl || "",
      fallbackPromptText || ""
    );
    if (direct && (!targetId || String(direct.postId || "").trim() === targetId)) {
      return direct;
    }
    const videos = collectVideoItemsFromDetail(detailPost);
    if (!videos.length) return direct || null;
    if (targetId) {
      for (let i = 0; i < videos.length; i += 1) {
        const candidate = videos[i];
        if (String((candidate && candidate.postId) || "").trim() === targetId) {
          return candidate;
        }
      }
    }
    return videos[0] || direct || null;
  };

  const pickRegenWatcherCandidate = ({
    videos,
    baselineIds,
    sourcePostId,
    parentPostId,
    imageReference,
    startedAtMs
  }) => {
    const sourceId = String(sourcePostId || "").trim();
    const parentId = String(parentPostId || "").trim();
    const imageId = extractImageId(imageReference || "");
    const baseline = baselineIds instanceof Set ? baselineIds : new Set();
    const minCreatedAt = Number(startedAtMs || 0) - 120000;
    let best = null;
    let bestScore = -1;
    let bestTime = -1;

    (videos || []).forEach((item) => {
      if (!item) return;
      const postId = String(item.postId || "").trim();
      if (!postId || postId === sourceId || baseline.has(postId)) return;

      const createdMs = toEpochMs(item.createdAt);
      if (createdMs && createdMs < minCreatedAt) return;

      const candidateParent = String(item.parentPostId || "").trim();
      const candidateOriginal = String(item.originalPostId || "").trim();
      const sourceImageUrl = String(item.sourceImageUrl || "").trim();
      const sourceImageId = extractImageId(sourceImageUrl);
      let score = 0;

      if (sourceId && candidateParent === sourceId) score += 6;
      if (sourceId && candidateOriginal === sourceId) score += 8;
      if (parentId && candidateParent === parentId) score += 5;
      if (parentId && candidateOriginal === parentId) score += 4;
      if (parentId && sourceImageId === parentId) score += 3;
      if (imageId && sourceImageId === imageId) score += 2;
      if (sourceId && String(item.url || "").includes(sourceId)) score += 2;
      if (parentId && String(item.url || "").includes(parentId)) score += 1;
      if (!score) {
        // Fallback conservativo: un post nuovo, non baseline, apparso dopo l'inizio regen.
        if (!createdMs || createdMs < Number(startedAtMs || 0) - 1000) return;
        score = 1;
      }

      const timeScore = createdMs || 0;
      if (score > bestScore || (score === bestScore && timeScore > bestTime)) {
        best = item;
        bestScore = score;
        bestTime = timeScore;
      }
    });

    return best || null;
  };

  const startNativeRegenApiWatcher = ({
    sourcePostId,
    parentPostId,
    imageReference,
    startedAtMs,
    seedIds,
    getRequestId,
    signal,
    onLog
  }) => {
    let stopped = false;
    let forced = false;
    const baselineIds = new Set();
    (seedIds || []).forEach((id) => {
      const key = String(id || "").trim();
      if (key) baselineIds.add(key);
    });

    const sourceId = String(sourcePostId || "").trim();
    const parentId = String(parentPostId || "").trim();
    const postIds = [];
    if (sourceId) postIds.push(sourceId);
    if (parentId && parentId !== sourceId) postIds.push(parentId);

    const log = (line) => {
      if (typeof onLog === "function" && line) onLog(String(line));
    };

    const loadDetailVideos = async () => {
      const out = [];
      for (let i = 0; i < postIds.length; i += 1) {
        const postId = postIds[i];
        if (!postId) continue;
        let detail = null;
        try {
          detail = await fetchPostDetails(postId);
        } catch (error) {
          detail = null;
        }
        const videos = collectVideoItemsFromDetail(detail);
        for (let j = 0; j < videos.length; j += 1) out.push(videos[j]);
      }
      return dedupeItems(out);
    };

    const loop = async () => {
      const seededVideos = await loadDetailVideos();
      seededVideos.forEach((item) => {
        const postId = String((item && item.postId) || "").trim();
        if (postId) baselineIds.add(postId);
      });

      while (!stopped && !forced && !(signal && signal.aborted)) {
        await sleep(2200);
        if (stopped || forced || (signal && signal.aborted)) break;

        const videos = await loadDetailVideos();
        const candidate = pickRegenWatcherCandidate({
          videos,
          baselineIds,
          sourcePostId: sourceId,
          parentPostId: parentId,
          imageReference,
          startedAtMs
        });
        if (!candidate) continue;

        const requestId = String((typeof getRequestId === "function" && getRequestId()) || "").trim();
        if (!requestId) continue;

        forced = true;
        log(`API watcher detected completion candidate ${String(candidate.postId || "n/a")}`);
        const payload = {
          action: "grokViewerRegenForceCompleteNativeTab",
          requestId,
          videoPostId: String(candidate.postId || ""),
          videoUrl: normalizeUrl(String(candidate.playbackUrl || candidate.url || "")),
          thumbnailImageUrl: normalizeUrl(String(candidate.poster || candidate.sourceImageUrl || "")),
          parentPostId: String(candidate.parentPostId || parentId || "")
        };
        await new Promise((resolve) => {
          chrome.runtime.sendMessage(payload, () => resolve());
        });
        break;
      }
    };

    loop();
    return () => {
      stopped = true;
    };
  };

  const handleRegenStreamObject = (data, tracker, hooks) => {
    const onLog = hooks && typeof hooks.onLog === "function" ? hooks.onLog : null;
    const onProgress = hooks && typeof hooks.onProgress === "function" ? hooks.onProgress : null;
    const responseNode = data && data.result && data.result.response ? data.result.response : null;
    if (!responseNode) return;
    const stream = responseNode.streamingVideoGenerationResponse;
    if (stream) {
      const progress = Number(stream.progress);
      if (Number.isFinite(progress)) {
        const pct = Math.max(0, Math.min(100, Math.round(progress)));
        if (pct !== tracker.progress) {
          tracker.progress = pct;
          if (onProgress) onProgress(pct);
        }
      }
      if (stream.videoPostId) tracker.videoPostId = String(stream.videoPostId);
      if (stream.videoUrl) tracker.videoUrl = normalizeUrl(stream.videoUrl);
      if (stream.thumbnailImageUrl) tracker.thumbnailImageUrl = normalizeUrl(stream.thumbnailImageUrl);
      if (stream.parentPostId) tracker.parentPostId = String(stream.parentPostId);
      if (stream.moderated === true) tracker.moderated = true;
      return;
    }
    const queryAction = responseNode.queryAction;
    if (queryAction && queryAction.type && !tracker.queryLogged) {
      tracker.queryLogged = true;
      if (onLog) onLog(`Query action: ${queryAction.type}`);
    }
  };

  const consumeRegenStream = async (response, tracker, hooks) => {
    if (!response.body || typeof response.body.getReader !== "function") {
      const text = await response.text();
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i += 1) {
        try {
          const parsed = JSON.parse(lines[i]);
          handleRegenStreamObject(parsed, tracker, hooks);
        } catch (error) {}
      }
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line);
            handleRegenStreamObject(parsed, tracker, hooks);
          } catch (error) {}
        }
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      try {
        const parsed = JSON.parse(tail);
        handleRegenStreamObject(parsed, tracker, hooks);
      } catch (error) {}
    }
  };

  const consumeRegenViaMainWorld = (payload, tracker, signal, sourcePostId, hooks) =>
    new Promise((resolve, reject) => {
      const requestId = `gv-regen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let settled = false;
      const onLog = REGEN_DEBUG_ENABLED && hooks && typeof hooks.onLog === "function" ? hooks.onLog : null;
      const onProgress = hooks && typeof hooks.onProgress === "function" ? hooks.onProgress : null;
      const emitLog = (message) => {
        if (!onLog || !message) return;
        onLog(String(message));
      };

      const applyMainEventData = (data) => {
        if (!data || typeof data !== "object") return;
        const progress = Number(data.progress);
        if (Number.isFinite(progress)) {
          const pct = Math.max(0, Math.min(100, Math.round(progress)));
          if (pct !== tracker.progress) {
            tracker.progress = pct;
            if (onProgress) onProgress(pct);
          }
        }
        if (data.videoPostId) tracker.videoPostId = String(data.videoPostId);
        if (data.videoUrl) tracker.videoUrl = normalizeUrl(String(data.videoUrl));
        if (data.thumbnailImageUrl) tracker.thumbnailImageUrl = normalizeUrl(String(data.thumbnailImageUrl));
        if (data.parentPostId) tracker.parentPostId = String(data.parentPostId);
        if (data.moderated === true) tracker.moderated = true;
      };

      const onMessage = (event) => {
        if (!event || event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== "grok-viewer" || data.requestId !== requestId) return;
        if (data.type === "regen-http") {
          const statusCode = Number(data.status || 0);
          if (statusCode > 0) {
            tracker.status = statusCode;
            const channel = data.channel ? ` (${String(data.channel)})` : "";
            const hasStatsig = data.hasStatsig === true ? " statsig:yes" : data.hasStatsig === false ? " statsig:no" : "";
            const statsigSource = data.statsigSource ? ` src:${String(data.statsigSource)}` : "";
            const statsigLength = Number(data.statsigLength || 0);
            const statsigLenText = statsigLength > 0 ? ` len:${statsigLength}` : "";
            const challenge = data.challengeDetected === true ? " cf:challenge" : "";
            const hint = data.errorHint ? ` hint:${String(data.errorHint)}` : "";
            const rid = data.xaiRequestId ? ` req:${String(data.xaiRequestId).slice(0, 8)}` : "";
            emitLog(`conversations/new HTTP ${statusCode}${channel}${hasStatsig}${statsigSource}${statsigLenText}${challenge}${hint}${rid}`);
          }
          return;
        }
        if (data.type === "regen-query") {
          const queryType = String(data.queryType || "");
          if (queryType && !tracker.queryLogged) {
            tracker.queryLogged = true;
            emitLog(`Query action: ${queryType}`);
          }
          return;
        }
        if (data.type === "regen-stream") {
          applyMainEventData(data);
        }
      };

      const onAbort = () => {
        chrome.runtime.sendMessage({ action: "grokViewerRegenAbortViaMain", requestId }, () => {});
      };

      const cleanup = () => {
        window.removeEventListener("message", onMessage);
        if (signal) signal.removeEventListener("abort", onAbort);
      };

      window.addEventListener("message", onMessage);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      chrome.runtime.sendMessage({ action: "grokViewerRegenViaMain", requestId, payload, sourcePostId }, (response) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        const result = response || { ok: false, status: 0, error: "no-main-response" };
        applyMainEventData(result);
        const statusCode = Number(result.status || 0);
        if (statusCode > 0 && !tracker.status) {
          tracker.status = statusCode;
          const channel = result.channel ? ` (${String(result.channel)})` : "";
          const hasStatsig = result.hasStatsig === true ? " statsig:yes" : result.hasStatsig === false ? " statsig:no" : "";
          const statsigSource = result.statsigSource ? ` src:${String(result.statsigSource)}` : "";
          const statsigLength = Number(result.statsigLength || 0);
          const statsigLenText = statsigLength > 0 ? ` len:${statsigLength}` : "";
          const challenge = result.challengeDetected === true ? " cf:challenge" : "";
          const hint = result.errorHint ? ` hint:${String(result.errorHint)}` : "";
          const rid = result.xaiRequestId ? ` req:${String(result.xaiRequestId).slice(0, 8)}` : "";
          emitLog(`conversations/new HTTP ${statusCode}${channel}${hasStatsig}${statsigSource}${statsigLenText}${challenge}${hint}${rid}`);
        }
        if (result.ok) {
          resolve(result);
          return;
        }
        const error = new Error(result.error || `regen-main-http-${statusCode || 0}`);
        if (statusCode) error.status = statusCode;
        if (result.aborted) error.name = "AbortError";
        reject(error);
      });
    });

  const consumeRegenViaNativeTab = (postId, tracker, signal, hooks) =>
    new Promise((resolve, reject) => {
      const requestId = `gv-regen-native-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let settled = false;
      let timeoutId = null;
      let lastProgressSource = "";
      const onLog = REGEN_DEBUG_ENABLED && hooks && typeof hooks.onLog === "function" ? hooks.onLog : null;
      const onProgress = hooks && typeof hooks.onProgress === "function" ? hooks.onProgress : null;
      const onRequestId = hooks && typeof hooks.onRequestId === "function" ? hooks.onRequestId : null;
      if (onRequestId) {
        try {
          onRequestId(requestId);
        } catch (error) {}
      }

      const emitLog = (message) => {
        if (!onLog || !message) return;
        onLog(String(message));
      };

      const applyNativeEventData = (data) => {
        if (!data || typeof data !== "object") return;
        const progress = Number(data.progress);
        if (Number.isFinite(progress)) {
          const pct = Math.max(0, Math.min(100, Math.round(progress)));
          if (pct !== tracker.progress) {
            tracker.progress = pct;
            if (onProgress) onProgress(pct);
          }
        }
        if (data.videoPostId) tracker.videoPostId = String(data.videoPostId);
        if (data.videoUrl) tracker.videoUrl = normalizeUrl(String(data.videoUrl));
        if (data.thumbnailImageUrl) tracker.thumbnailImageUrl = normalizeUrl(String(data.thumbnailImageUrl));
        if (data.parentPostId) tracker.parentPostId = String(data.parentPostId);
        if (data.moderated === true) tracker.moderated = true;
      };

      const cleanup = () => {
        chrome.runtime.onMessage.removeListener(onRuntimeMessage);
        if (signal) signal.removeEventListener("abort", onAbort);
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };

      const finishResolve = (payload) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(payload || {});
      };

      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error || "native-regen-failed")));
      };

      const onRuntimeMessage = (message) => {
        if (!message || message.action !== "grokViewerRegenNativeEvent" || message.requestId !== requestId) return;
        const eventType = String(message.type || "").trim();
        if (!eventType) return;

        if (eventType === "opened") {
          const tabId = Number(message.targetTabId || 0);
          if (tabId) emitLog(`Native tab opened id=${tabId}`);
          return;
        }

        if (eventType === "clicked") {
          const confirmLabel = message.confirmLabel ? String(message.confirmLabel) : "";
          if (message.confirmed === true) {
            emitLog(`Repeat clicked and confirmed (${confirmLabel || "create video"})`);
          } else {
            emitLog("Repeat clicked on native post page");
          }
          return;
        }

        if (eventType === "http") {
          const statusCode = Number(message.status || 0);
          if (statusCode > 0) tracker.status = statusCode;
          const challenge = message.challengeDetected === true ? " cf:challenge" : "";
          const hint = message.errorHint ? ` hint:${String(message.errorHint)}` : "";
          emitLog(`conversations/new HTTP ${statusCode || 0} (native-post-tab)${challenge}${hint}`);
          return;
        }

        if (eventType === "query") {
          const queryType = String(message.queryType || "");
          if (queryType && !tracker.queryLogged) {
            tracker.queryLogged = true;
            emitLog(`Query action: ${queryType}`);
          }
          return;
        }

        if (eventType === "diag") {
          if (!onLog) return;
          const source = message.progressSource ? String(message.progressSource) : "-";
          const prev = Number.isFinite(Number(message.prevProgress)) ? Math.round(Number(message.prevProgress)) : 0;
          const raw = Number.isFinite(Number(message.rawProgress)) ? Math.round(Number(message.rawProgress)) : 0;
          const eff = Number.isFinite(Number(message.effectiveProgress)) ? Math.round(Number(message.effectiveProgress)) : 0;
          const tick100 = Number(message.hundredTicks || 0);
          const tick95 = Number(message.highTicks || 0);
          const status = Number(message.status || 0);
          const seen = message.requestSeen === true ? "yes" : "no";
          const streams = Number(message.streamCount || 0);
          const seq = Number(message.seq || 0);
          const nudge = message.nudgeSent === true ? "yes" : "no";
          const nudgeCount = Number(message.nudgeCount || 0);
          const probe = Number.isFinite(Number(message.probeProgress)) && Number(message.probeProgress) >= 0
            ? `${Math.round(Number(message.probeProgress))}%`
            : "-";
          const dom = Number.isFinite(Number(message.domProgress)) && Number(message.domProgress) >= 0
            ? `${Math.round(Number(message.domProgress))}%`
            : "-";
          const hint = message.generationHintVisible === true ? "yes" : "no";
          const ready = message.readyActionVisible === true ? "yes" : "no";
          const isNew = message.isNewVideo === true ? "yes" : "no";
          emitLog(
            `diag src:${source} prev:${prev}% raw:${raw}% eff:${eff}% probe:${probe} dom:${dom} status:${status} reqSeen:${seen} streams:${streams} seq:${seq} nudge:${nudge}#${nudgeCount} 100t:${tick100} 95t:${tick95} hint:${hint} ready:${ready} new:${isNew}`
          );
          return;
        }

        if (eventType === "stream") {
          const source = String(message.progressSource || "").trim().toLowerCase();
          if (source && source !== lastProgressSource) {
            lastProgressSource = source;
            emitLog(`Progress source: ${source}`);
          }
          applyNativeEventData(message);
          return;
        }

        if (eventType === "completed") {
          applyNativeEventData(message);
          if (onProgress) onProgress(100);
          finishResolve(message);
          return;
        }

        if (eventType === "aborted") {
          const abortError = new Error("native-regen-aborted");
          abortError.name = "AbortError";
          finishReject(abortError);
          return;
        }

        if (eventType === "failed") {
          const statusCode = Number(message.status || 0);
          const error = new Error(String(message.error || "native-regen-failed"));
          if (statusCode) error.status = statusCode;
          if (message.challengeDetected === true) error.challengeDetected = true;
          if (message.errorHint) error.errorHint = String(message.errorHint);
          if (message.moderated === true) error.moderated = true;
          finishReject(error);
        }
      };

      const onAbort = () => {
        chrome.runtime.sendMessage({ action: "grokViewerRegenAbortNativeTab", requestId }, () => {});
      };

      chrome.runtime.onMessage.addListener(onRuntimeMessage);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      timeoutId = setTimeout(() => {
        const timeoutError = new Error("native-regen-timeout");
        finishReject(timeoutError);
      }, 4 * 60 * 1000);

      chrome.runtime.sendMessage({ action: "grokViewerRegenViaNativeTab", requestId, postId }, (response) => {
        if (settled) return;
        if (chrome.runtime.lastError) {
          finishReject(new Error(chrome.runtime.lastError.message));
          return;
        }
        const result = response || { ok: false, error: "no-native-response" };
        if (!result.ok) {
          const statusCode = Number(result.status || 0);
          const error = new Error(String(result.error || "native-regen-start-failed"));
          if (statusCode) error.status = statusCode;
          finishReject(error);
          return;
        }
        if (result.targetTabId) {
          emitLog(`Native post tab ready id=${Number(result.targetTabId)}`);
        }
      });
    });

  const stopRegeneration = (reason, postId) => {
    const targetPostId = String(postId || getActiveRegenPostId() || "").trim();
    if (!targetPostId) return;
    const job = getRegenJob(targetPostId);
    if (!job || !job.running || !job.abortController) return;
    appendRegenLog(targetPostId, reason || "Stop requested");
    job.abortController.abort();
  };

  const startRegeneration = async () => {
    const selected = state.items[state.selectedIndex];
    const active = resolveActiveItem(selected);
    if (!selected || !active) return;
    const jobPostId = active.postId ? String(active.postId).trim() : "";
    if (!jobPostId) {
      showRegenNotice("Regeneration unavailable for this item.", "error");
      return;
    }
    const runningCount = getRunningRegenCount();
    const existingJob = getRegenJob(jobPostId);
    if (existingJob && existingJob.running) {
      regenState.activePostId = jobPostId;
      syncRegenOverlay();
      showRegenNotice("Regeneration already running for this item.", "error");
      return;
    }
    if (runningCount >= REGEN_MAX_CONCURRENT) {
      showRegenNotice(`Maximum ${REGEN_MAX_CONCURRENT} regenerations at once.`, "error");
      return;
    }
    const cooldownSeconds = getRegenCooldownSeconds();
    if (cooldownSeconds > 0 && runningCount === 0) {
      showRegenNotice(`Please wait ${cooldownSeconds}s before regenerating again.`, "error");
      return;
    }
    const job = getOrCreateRegenJob(jobPostId);
    if (!job) return;
    regenMicroLog("startRegeneration", { postId: jobPostId, mode: state.mode, viewMode: state.viewMode });
    clearRegenLogs(jobPostId);
    hideRegenNotice();
    job.running = true;
    job.progress = 0;
    job.abortController = new AbortController();
    regenState.activePostId = jobPostId;
    regenState.lastJobAt = Date.now();
    setRegenProgress(jobPostId, 1, "Regeneration 1%");
    syncRegenOverlay();
    updateActionButtons();
    appendRegenLog(jobPostId, `Starting regeneration for post ${active.postId}`);
    let lastLoggedProgress = -1;
    let stopApiWatcher = () => {};

    try {
      let detail = null;
      try {
        detail = await fetchPostDetails(active.postId);
        appendRegenLog(jobPostId, "post/get completed");
      } catch (error) {
        appendRegenLog(jobPostId, `post/get failed: ${error.message || error}`);
      }

      const context = buildRegenContext(selected, detail);
      if (!context) {
        throw new Error("regen-context-unavailable");
      }
      if (!context.parentPostId) {
        throw new Error("regen-parent-missing");
      }

      const payload = buildRegenPayload(context);
      appendRegenLog(jobPostId, `Payload ready mode=${context.mode} ratio=${context.aspectRatio} len=${context.videoLength}s`);
      const messagePreview = context.message.length > 180 ? `${context.message.slice(0, 180)}...` : context.message;
      appendRegenLog(jobPostId, `Message: ${messagePreview}`);
      startRegenCooldown();
      const tracker = {
        progress: 1,
        moderated: false,
        videoPostId: "",
        videoUrl: "",
        thumbnailImageUrl: "",
        parentPostId: context.parentPostId,
        queryLogged: false,
        status: 0
      };
      const nativePostId = String(active.postId || selected.postId || context.parentPostId || "").trim();
      if (!nativePostId) {
        throw new Error("regen-post-id-missing");
      }
      appendRegenLog(jobPostId, "Channel: native post tab bridge");
      regenMicroLog("native-channel", { postId: nativePostId, parentPostId: context.parentPostId });
      let nativeRequestId = "";
      const seedIds = new Set();
      seedIds.add(jobPostId);
      seedIds.add(nativePostId);
      if (selected && Array.isArray(selected.variants)) {
        selected.variants.forEach((variant) => {
          const id = String((variant && variant.postId) || "").trim();
          if (id) seedIds.add(id);
        });
      }
      stopApiWatcher = startNativeRegenApiWatcher({
        sourcePostId: nativePostId,
        parentPostId: context.parentPostId,
        imageReference: context.imageReference,
        startedAtMs: Date.now(),
        seedIds: Array.from(seedIds),
        getRequestId: () => nativeRequestId,
        signal: job.abortController.signal,
        onLog: (line) => appendRegenLog(jobPostId, line)
      });
      await consumeRegenViaNativeTab(nativePostId, tracker, job.abortController.signal, {
        onRequestId: (id) => {
          nativeRequestId = String(id || "").trim();
          regenMicroLog("native-request-id", nativeRequestId);
        },
        onLog: (line) => {
          appendRegenLog(jobPostId, line);
          const text = String(line || "");
          if (
            /clicked|not found|failed|timeout|cloudflare|http|challenge|repeat|create video/i.test(text)
          ) {
            regenMicroLog("native-log", text);
          }
        },
        onProgress: (pct) => {
          setRegenProgress(jobPostId, pct);
          if (pct !== lastLoggedProgress) {
            lastLoggedProgress = pct;
            appendRegenLog(jobPostId, `Progress ${pct}%`);
          }
        }
      });

      if (tracker.moderated) {
        appendRegenLog(jobPostId, "Moderated=true detected");
        showRegenNotice("Generation failed, likely due to NSFW moderation.", "error", 5200);
        return;
      }
      if (!tracker.videoUrl && !tracker.videoPostId) {
        appendRegenLog(jobPostId, "No final video payload received");
        showRegenNotice("Generation did not complete. No final payload received.", "error", 5200);
        return;
      }

      setRegenProgress(jobPostId, 100, "Regeneration 100%");
      const beforeRefreshGroup = state.items[state.selectedIndex];
      const beforeRefreshActive = resolveActiveItem(beforeRefreshGroup) || beforeRefreshGroup;
      const beforeRefreshActivePostId = normalizeId(beforeRefreshActive && beforeRefreshActive.postId);
      const beforeRefreshGroupId = normalizeId(beforeRefreshGroup && beforeRefreshGroup.groupId);
      const generatedPostId = String(tracker.videoPostId || extractMp4Id(tracker.videoUrl || "") || "").trim();
      if (generatedPostId) markNewGenerationHighlight(generatedPostId);
      if (generatedPostId && (beforeRefreshGroupId || beforeRefreshActivePostId)) {
        rememberGroupAlias(generatedPostId, beforeRefreshGroupId || beforeRefreshActivePostId);
      }
      appendRegenLog(jobPostId, `Completed videoPostId=${tracker.videoPostId || "n/a"}`);
      await refresh({ silent: true, includeOtherMode: true });
      if (isGridMode() && state.mode === "videos") {
        const selectedByGenerated = generatedPostId ? selectGroupByPostId(generatedPostId) : false;
        const selectedByPrevious = !selectedByGenerated && beforeRefreshActivePostId
          ? selectGroupByPostId(beforeRefreshActivePostId)
          : false;
        if (!selectedByGenerated && !selectedByPrevious && beforeRefreshGroupId) {
          selectGroupByGroupId(beforeRefreshGroupId);
        }
      }
      const lightboxOpenNow = Boolean(lightboxEl && lightboxEl.classList.contains("open"));
      if (lightboxOpenNow) {
        if (isGridMode() && state.mode === "videos") {
          await hydrateActiveGroupVariantsFromDetails({
            force: true,
            keepPostId: beforeRefreshActivePostId,
            preferPostId: generatedPostId
          });
        }
        loadPlayer();
        showRegenNotice("New generation completed, check it in the Viewer! 🙋🏼", "", 0);
      } else {
        showRegenCreatedNotice();
      }
      appendRegenLog(jobPostId, "Silent refresh completed");
    } catch (error) {
      regenMicroLog("regen-error", String((error && error.message) || error || "unknown"));
      const aborted =
        error && (error.name === "AbortError" || String(error.message || "").toLowerCase().includes("abort"));
      if (aborted) {
        appendRegenLog(jobPostId, "Generation stopped by user");
        showRegenNotice("Generation stopped.", "error", 2800);
      } else {
        const statusCode = Number(error && error.status);
        const rawError = String((error && error.message) || error || "");
        const rawLower = rawError.toLowerCase();
        if (statusCode === 403 || statusCode === 429) {
          appendRegenLog(jobPostId, `Rate limited or blocked (${statusCode})`);
          showRegenNotice("Generation temporarily blocked (403/429). Please retry later.", "error", 4600);
        } else if (rawLower.includes("start-button-not-found") || rawLower.includes("repeat-button-not-found")) {
          appendRegenLog(jobPostId, "Generation failed: native start button not found");
          showRegenNotice("Could not find Create video/Repeat button on native page.", "error", 5200);
        } else if (rawLower.includes("repeat-clicked-but-not-triggered")) {
          appendRegenLog(jobPostId, "Generation failed: start button clicked but no generation request detected");
          showRegenNotice("Create video/Repeat was clicked but generation did not start.", "error", 5200);
        } else if (rawLower.includes("cloudflare-challenge-page") || rawLower.includes("cloudflare-or-auth-block")) {
          appendRegenLog(jobPostId, "Generation blocked by Cloudflare challenge/auth");
          showRegenNotice("Generation temporarily blocked (403/429). Please retry later.", "error", 4600);
        } else if (rawLower.includes("native-regen-timeout")) {
          appendRegenLog(jobPostId, "Generation failed: native page timeout");
          showRegenNotice("Generation timed out on native page.", "error", 5200);
        } else if (rawLower.includes("moderated")) {
          appendRegenLog(jobPostId, "Generation failed: moderation");
          showRegenNotice("Generation failed, likely due to NSFW moderation.", "error", 5200);
        } else if (rawLower.includes("regen-post-id-missing")) {
          appendRegenLog(jobPostId, "Generation failed: missing post id");
          showRegenNotice("Regeneration unavailable for this item.", "error", 4600);
        } else {
          appendRegenLog(jobPostId, `Generation failed: ${rawError}`);
          showRegenNotice("Generation failed.", "error", 5200);
        }
      }
    } finally {
      try {
        stopApiWatcher();
      } catch (error) {}
      job.running = false;
      job.abortController = null;
      syncThumbRegenIndicators(jobPostId);
      syncRegenOverlay();
      updateActionButtons();
      updateRegenDebugPanel();
    }
  };

  const showFloatingTooltip = (text, target, placement) => {
    if (!floatingTooltip || !text || !target) return;
    floatingTooltip.textContent = text;
    const rect = target.getBoundingClientRect();
    const left = rect.left + rect.width / 2;
    const placeTop = placement === "top";
    let top = rect.bottom + 8;
    floatingTooltip.style.transform = "translateX(-50%)";
    if (placeTop) {
      floatingTooltip.style.transform = "translate(-50%, -100%)";
      top = rect.top - 8;
    }
    floatingTooltip.style.left = `${left}px`;
    floatingTooltip.style.top = `${top}px`;
    floatingTooltip.classList.add("show");
  };

  const hideFloatingTooltip = () => {
    if (!floatingTooltip) return;
    floatingTooltip.classList.remove("show");
  };

  const openChangelogModal = () => {
    if (!changelogModal) return;
    changelogModal.classList.add("open");
    changelogModal.setAttribute("aria-hidden", "false");
  };

  const closeChangelogModal = () => {
    if (!changelogModal) return;
    changelogModal.classList.remove("open");
    changelogModal.setAttribute("aria-hidden", "true");
  };

  const openSettingsModal = () => {
    if (!settingsModal) return;
    updateSettingsUI();
    settingsModal.classList.add("open");
    settingsModal.setAttribute("aria-hidden", "false");
  };

  const closeSettingsModal = () => {
    if (!settingsModal) return;
    settingsModal.classList.remove("open");
    settingsModal.setAttribute("aria-hidden", "true");
  };

  const updateModeSetupDoneUI = () => {
    if (!modeSetupDoneDot) return;
    modeSetupDoneDot.classList.toggle("show", !!state.settings.downloadSettingsGuideDone);
  };

  const maybePromptDownloadSetupGuide = () => {};

  const showDuplicateModal = (message, seconds = 10) => {
    if (!duplicateModal) return;
    const activeEl = document.activeElement;
    if (activeEl instanceof Element && !duplicateModal.contains(activeEl)) {
      duplicateModalPreviousFocus = activeEl;
    }
    duplicateAskActive = false;
    duplicateAskResolver = null;
    duplicateModal.removeAttribute("inert");
    if (duplicateYesBtn) duplicateYesBtn.style.display = "none";
    if (duplicateNoBtn) duplicateNoBtn.style.display = "none";
    if (duplicateMessageEl && message) duplicateMessageEl.textContent = message;
    if (duplicateTimerHandle) clearTimeout(duplicateTimerHandle);
    if (duplicateIntervalHandle) clearInterval(duplicateIntervalHandle);
    let secondsLeft = Math.max(1, Number(seconds) || 10);
    if (duplicateTimerEl) duplicateTimerEl.textContent = String(secondsLeft);
    duplicateIntervalHandle = setInterval(() => {
      secondsLeft -= 1;
      if (duplicateTimerEl) duplicateTimerEl.textContent = secondsLeft > 0 ? String(secondsLeft) : "";
      if (secondsLeft <= 0 && duplicateIntervalHandle) {
        clearInterval(duplicateIntervalHandle);
        duplicateIntervalHandle = null;
      }
    }, 1000);
    duplicateTimerHandle = setTimeout(() => {
      hideDuplicateModal();
    }, Math.max(1, Number(seconds) || 10) * 1000);
    duplicateModal.classList.add("open");
    duplicateModal.setAttribute("aria-hidden", "false");
  };

  const askDuplicateModal = (message, seconds = 10) =>
    new Promise((resolve) => {
      if (!duplicateModal) {
        resolve(false);
        return;
      }
      duplicateAskActive = true;
      duplicateAskResolver = resolve;
      const activeEl = document.activeElement;
      if (activeEl instanceof Element && !duplicateModal.contains(activeEl)) {
        duplicateModalPreviousFocus = activeEl;
      }
      duplicateModal.removeAttribute("inert");
      if (duplicateMessageEl && message) duplicateMessageEl.textContent = message;
      if (duplicateYesBtn) duplicateYesBtn.style.display = "inline-flex";
      if (duplicateNoBtn) duplicateNoBtn.style.display = "inline-flex";
      if (duplicateTimerHandle) clearTimeout(duplicateTimerHandle);
      if (duplicateIntervalHandle) clearInterval(duplicateIntervalHandle);
      let secondsLeft = Math.max(1, Number(seconds) || 10);
      if (duplicateTimerEl) duplicateTimerEl.textContent = String(secondsLeft);
      duplicateIntervalHandle = setInterval(() => {
        secondsLeft -= 1;
        if (duplicateTimerEl) duplicateTimerEl.textContent = secondsLeft > 0 ? String(secondsLeft) : "";
        if (secondsLeft <= 0 && duplicateIntervalHandle) {
          clearInterval(duplicateIntervalHandle);
          duplicateIntervalHandle = null;
        }
      }, 1000);
      duplicateTimerHandle = setTimeout(() => {
        if (duplicateAskActive && duplicateAskResolver) {
          const resolver = duplicateAskResolver;
          duplicateAskResolver = null;
          duplicateAskActive = false;
          resolver(false);
        }
        hideDuplicateModal();
      }, Math.max(1, Number(seconds) || 10) * 1000);
      duplicateModal.classList.add("open");
      duplicateModal.setAttribute("aria-hidden", "false");
      const focusTarget = duplicateYesBtn || duplicateNoBtn || duplicateClose;
      if (focusTarget && typeof focusTarget.focus === "function") {
        setTimeout(() => {
          try {
            focusTarget.focus({ preventScroll: true });
          } catch (error) {
            try {
              focusTarget.focus();
            } catch (e) {}
          }
        }, 0);
      }
    });

  const hideDuplicateModal = () => {
    if (!duplicateModal) return;
    if (duplicateAskActive && duplicateAskResolver) {
      const resolver = duplicateAskResolver;
      duplicateAskResolver = null;
      duplicateAskActive = false;
      resolver(false);
    }
    if (duplicateTimerHandle) {
      clearTimeout(duplicateTimerHandle);
      duplicateTimerHandle = null;
    }
    if (duplicateIntervalHandle) {
      clearInterval(duplicateIntervalHandle);
      duplicateIntervalHandle = null;
    }
    if (duplicateYesBtn) duplicateYesBtn.style.display = "none";
    if (duplicateNoBtn) duplicateNoBtn.style.display = "none";
    if (duplicateTimerEl) duplicateTimerEl.textContent = "";
    const safeFocusFallback = refreshBtn || settingsBtn || viewModeBtn || githubBtn || appEl || null;
    const restoreTarget =
      duplicateModalPreviousFocus &&
      typeof duplicateModalPreviousFocus.focus === "function" &&
      duplicateModalPreviousFocus.isConnected &&
      !duplicateModal.contains(duplicateModalPreviousFocus)
        ? duplicateModalPreviousFocus
        : safeFocusFallback;
    const activeEl = document.activeElement;
    if (activeEl && typeof duplicateModal.contains === "function" && duplicateModal.contains(activeEl)) {
      try {
        if (typeof activeEl.blur === "function") activeEl.blur();
      } catch (error) {}
    }
    if (restoreTarget && typeof restoreTarget.focus === "function") {
      try {
        restoreTarget.focus({ preventScroll: true });
      } catch (error) {
        try {
          restoreTarget.focus();
        } catch (e) {}
      }
    }
    requestAnimationFrame(() => {
      duplicateModal.classList.remove("open");
      duplicateModal.setAttribute("aria-hidden", "true");
      duplicateModal.setAttribute("inert", "");
    });
    duplicateModalPreviousFocus = null;
  };

  const closePromptChoiceModal = (result) => {
    if (promptChoiceTimer) {
      clearTimeout(promptChoiceTimer);
      promptChoiceTimer = null;
    }
    if (promptChoiceAskResolver) {
      const resolver = promptChoiceAskResolver;
      promptChoiceAskResolver = null;
      resolver(result || null);
    }
    if (!promptChoiceModal) return;
    const activeEl = document.activeElement;
    if (activeEl && typeof promptChoiceModal.contains === "function" && promptChoiceModal.contains(activeEl)) {
      try {
        if (typeof activeEl.blur === "function") activeEl.blur();
      } catch (error) {}
    }
    const fallbackFocus = promptBtn || refreshBtn || settingsBtn || viewModeBtn || githubBtn || appEl || null;
    const restoreTarget =
      promptChoiceModalPreviousFocus &&
      typeof promptChoiceModalPreviousFocus.focus === "function" &&
      promptChoiceModalPreviousFocus.isConnected &&
      !promptChoiceModal.contains(promptChoiceModalPreviousFocus)
        ? promptChoiceModalPreviousFocus
        : fallbackFocus;
    if (restoreTarget && typeof restoreTarget.focus === "function") {
      try {
        restoreTarget.focus({ preventScroll: true });
      } catch (error) {
        try {
          restoreTarget.focus();
        } catch (e) {}
      }
    }
    requestAnimationFrame(() => {
      promptChoiceModal.classList.remove("open");
      promptChoiceModal.setAttribute("aria-hidden", "true");
      promptChoiceModal.setAttribute("inert", "");
    });
    promptChoiceModalPreviousFocus = null;
  };

  const askPromptChoiceModal = () =>
    new Promise((resolve) => {
      if (!promptChoiceModal) {
        resolve("copy");
        return;
      }
      if (promptChoiceAskResolver) {
        resolve(null);
        return;
      }
      const activeEl = document.activeElement;
      if (activeEl instanceof Element && !promptChoiceModal.contains(activeEl)) {
        promptChoiceModalPreviousFocus = activeEl;
      }
      promptChoiceAskResolver = resolve;
      promptChoiceModal.removeAttribute("inert");
      promptChoiceModal.classList.add("open");
      promptChoiceModal.setAttribute("aria-hidden", "false");
      const focusTarget = promptChoiceCopyBtn || promptChoiceDownloadBtn || promptChoiceClose || null;
      if (focusTarget && typeof focusTarget.focus === "function") {
        setTimeout(() => {
          try {
            focusTarget.focus({ preventScroll: true });
          } catch (error) {
            try {
              focusTarget.focus();
            } catch (e) {}
          }
        }, 0);
      }
      promptChoiceTimer = setTimeout(() => {
        closePromptChoiceModal("copy");
      }, 30000);
    });

  const updateSettingsUI = () => {
    const mode = getDownloadMode();
    if (dlModeAsk) dlModeAsk.checked = mode === "ask_each";
    if (dlModeFolder) dlModeFolder.checked = mode === "folder_once";
    if (dlModeAuto) dlModeAuto.checked = mode === "default_auto";
    if (dlModeFolder) dlModeFolder.disabled = false;
    if (folderHintEl) {
      const folderText = getFolderDisplayValue();
      if (!supportsFolderHandles()) {
        folderHintEl.textContent =
          mode === "folder_once" && folderText
            ? `Downloads go to one folder in your Downloads directory - ${folderText}`
            : "Choose a folder name from your Downloads directory and keep using it.";
      } else {
        folderHintEl.textContent =
          mode === "folder_once" && folderText
            ? `Downloads go to one folder in your Downloads directory - ${folderText}`
            : "Downloads go to one folder in your Downloads directory.";
      }
    }
    if (changeFolderBtn) {
      changeFolderBtn.style.display = mode === "folder_once" ? "inline-flex" : "none";
    }
    const bulk = getBulkTarget();
    if (bulk32Btn) bulk32Btn.classList.toggle("active", bulk === 32);
    if (bulk64Btn) bulk64Btn.classList.toggle("active", bulk === 64);
    if (bulk120Btn) bulk120Btn.classList.toggle("active", bulk === 120);
    if (bulk500Btn) bulk500Btn.classList.toggle("active", bulk === 500);
    if (autoRefreshAlwaysCheck) autoRefreshAlwaysCheck.checked = !!state.settings.autoRefreshAlways;
  };

  const setDownloadMode = async (mode) => {
    if (mode !== "ask_each" && mode !== "folder_once" && mode !== "default_auto") return;
    const previousMode = getDownloadMode();
    const previousFolder = sanitizeFolderPath(state.settings.folderPath || "");
    if (previousMode === mode && mode !== "folder_once") {
      updateSettingsUI();
      return;
    }
    if (mode === "folder_once") {
      const forcePick = !supportsFolderHandles();
      const ok = await pickFolderAndEnableMode(forcePick);
      if (!ok) {
        state.settings.downloadMode = previousMode;
        state.settings.folderPath = previousFolder;
        persistSettings();
        updateSettingsUI();
        setStatus("Folder selection canceled.");
      }
      return;
    }
    state.settings.downloadMode = mode;
    persistSettings();
    updateSettingsUI();
  };

  const setBulkTarget = (value) => {
    const parsed = Number(value);
    const target = parsed === 64 || parsed === 120 || parsed === 500 ? parsed : 32;
    state.settings.bulkTarget = target;
    persistSettings();
    updateSettingsUI();
    if (target === 500) {
      window.alert("500-batch mode enabled. During bulk download, do not use the extension until it finishes.");
    }
  };

  const showViewModeModal = () => {
    if (!viewModeModal) return;
    const activeEl = document.activeElement;
    if (activeEl instanceof Element && !viewModeModal.contains(activeEl)) {
      viewModeModalPreviousFocus = activeEl;
    }
    viewModeModal.removeAttribute("inert");
    viewModeModal.classList.add("open");
    viewModeModal.setAttribute("aria-hidden", "false");
    if (appEl) appEl.classList.add("hidden");
    const preferredBtn = state.viewMode === "grid" ? modeNormalBtn : modeGridBtn;
    setTimeout(() => {
      if (preferredBtn && typeof preferredBtn.focus === "function") preferredBtn.focus({ preventScroll: true });
    }, 0);
  };

  const hideViewModeModal = () => {
    if (!viewModeModal) return;
    const activeEl = document.activeElement;
    if (activeEl instanceof Element && viewModeModal.contains(activeEl)) {
      try {
        activeEl.blur();
      } catch (error) {}
    }
    viewModeModal.classList.remove("open");
    viewModeModal.setAttribute("aria-hidden", "true");
    viewModeModal.setAttribute("inert", "");
    if (appEl) appEl.classList.remove("hidden");
    const fallbackFocus = viewModeBtn && typeof viewModeBtn.focus === "function" ? viewModeBtn : null;
    const restoreTarget =
      viewModeModalPreviousFocus &&
      typeof viewModeModalPreviousFocus.focus === "function" &&
      viewModeModalPreviousFocus.isConnected
        ? viewModeModalPreviousFocus
        : fallbackFocus;
    if (restoreTarget && typeof restoreTarget.focus === "function") {
      setTimeout(() => {
        try {
          restoreTarget.focus({ preventScroll: true });
        } catch (error) {}
      }, 0);
    }
    viewModeModalPreviousFocus = null;
  };

  const setViewMode = (mode, persist) => {
    if (mode !== "grid" && mode !== "normal") return;
    if (state.viewMode !== mode) {
      state.pageByMode.videos = 0;
      state.pageByMode.images = 0;
    }
    state.viewMode = mode;
    if (mode !== "grid") state.autoAdvanceAll = false;
    if (persist) chrome.storage.local.set({ [VIEW_MODE_KEY]: mode });
    if (brandTitleEl) {
      brandTitleEl.textContent = mode === "grid" ? "Grok-Viewer Grid" : "Grok-Viewer";
    }
    if (viewModeIcon) {
      const icon = mode === "grid" ? "images/grid.svg" : "images/normal.svg";
      const alt = mode === "grid" ? "Grid view" : "Normal view";
      viewModeIcon.src = chrome.runtime.getURL(icon);
      viewModeIcon.alt = alt;
    }
    if (viewModeBtn) {
      viewModeBtn.dataset.tooltip = mode === "grid" ? "Return to normal mode" : "Return to Grid mode";
    }
    if (viewModeLabel) {
      viewModeLabel.textContent = mode === "grid" ? "Grid Mode Enabled" : "Normal Mode Enabled";
    }
    updateItems();
  };

  const buildShareLink = (postId) => {
    if (!postId) return "";
    return `https://grok.com/imagine/post/${postId}?source=post-page&platform=web`;
  };

  const copyToClipboard = async (text) => {
    if (!text) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {}
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.left = "-9999px";
      area.style.top = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch (e) {
      return false;
    }
  };

  const shareItem = async (item) => {
    const targetItem = resolveActiveItem(item);
    if (!targetItem || !targetItem.postId) return;
    const link = buildShareLink(targetItem.postId);
    if (!link) return;
    await copyToClipboard(link);
    showToast("Link copied");
  };

  const getPromptTextForItem = (item) => {
    const target = resolveActiveItem(item) || item;
    if (!target) return "";
    const fromTarget = target.promptText ? String(target.promptText).trim() : "";
    if (fromTarget) return fromTarget;
    if (item && item.variants && item.variants.length) {
      for (let i = 0; i < item.variants.length; i += 1) {
        const variant = item.variants[i];
        const variantPrompt = variant && variant.promptText ? String(variant.promptText).trim() : "";
        if (variantPrompt) return variantPrompt;
      }
    }
    return "";
  };

  const copyPromptItem = async (item, promptOverride, context = null) => {
    if (promptCopyAudio) {
      try {
        promptCopyAudio.currentTime = 0;
        const playPromise = promptCopyAudio.play();
        if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
      } catch (error) {}
    }
    const prompt = promptOverride || getPromptTextForItem(item);
    if (!prompt) {
      if (promptErrorAudio) {
        try {
          promptErrorAudio.currentTime = 0;
          const playPromise = promptErrorAudio.play();
          if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
        } catch (error) {}
      }
      showPromptInlineFeedback("Prompt unavailable", "error", context || {});
      return;
    }
    await copyToClipboard(prompt);
    showPromptInlineFeedback("Prompt copied", "", context || {});
  };

  const handlePromptItem = async (item, context = null) => {
    const prompt = getPromptTextForItem(item);
    if (!prompt) {
      if (promptErrorAudio) {
        try {
          promptErrorAudio.currentTime = 0;
          const playPromise = promptErrorAudio.play();
          if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
        } catch (error) {}
      }
      showPromptInlineFeedback("Prompt unavailable", "error", context || {});
      return;
    }
    const choice = await askPromptChoiceModal();
    if (choice === "download") {
      await downloadPromptInfoFile(item);
      return;
    }
    await copyPromptItem(item, prompt, context || {});
  };

  const playActionAudio = (action) => {
    let audio = null;
    if (action === "download") audio = downloadClickAudio;
    if (action === "share") audio = shareClickAudio;
    if (action === "delete") audio = closeClickAudio;
    if (!audio) return;
    try {
      audio.currentTime = 0;
      const playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
    } catch (error) {}
  };

  const applyModeUI = () => {
    const isImages = state.mode === "images";
    if (tabVideosBtn) tabVideosBtn.classList.toggle("active", !isImages);
    if (tabImagesBtn) tabImagesBtn.classList.toggle("active", isImages);
    if (autoNextBtn) autoNextBtn.style.display = isImages ? "none" : "";
    if (downloadAllBtn) downloadAllBtn.textContent = "Download All";
    if (deleteAllBtn) deleteAllBtn.textContent = "Delete All Videos";
    if (downloadAllBtn) {
      downloadAllBtn.dataset.tooltip = "Download every post into its own folder (videos + image).";
    }
    if (deleteAllBtn) {
      deleteAllBtn.dataset.tooltip = "Delete all videos under every post (images are kept).";
    }
    if (refreshBtn) {
      refreshBtn.dataset.tooltip = isImages ? "Refresh images." : "Refresh videos.";
    }
    if (thumbAutoplayBtn) {
      thumbAutoplayBtn.style.display = isImages ? "none" : "";
      thumbAutoplayBtn.textContent = "Autoplay Previews";
    }
    if (downloadBtn) downloadBtn.dataset.tooltip = isImages ? "Download this image only" : "Download this video only";
    if (shareBtn) shareBtn.dataset.tooltip = isImages ? "Receive a link for this image" : "Receive a link for this video";
    if (deleteBtn) deleteBtn.dataset.tooltip = isImages ? "Delete this image" : "Delete this video";
    if (promptBtn) promptBtn.dataset.tooltip = "Copy this prompt";
    if (regenBtn) regenBtn.dataset.tooltip = "Generate an alternative video from this prompt";
    if (autoNextBtn) autoNextBtn.dataset.tooltip = "All your videos will play automatically";
    if (downloadGroupBtn) downloadGroupBtn.dataset.tooltip = "Download only this compilation";
    updateRegenButtonVisual();
    if (sortBtn) {
      sortBtn.style.display = "";
      sortBtn.textContent = state.sortOrder === "asc" ? "Sort by new" : "Sort by old";
    }
    if (hideModToastWrap) hideModToastWrap.style.display = isImages ? "none" : "";
    if (footerEl) footerEl.style.display = "grid";
  };

  const setMode = (mode) => {
    if (mode !== "videos" && mode !== "images") return;
    if (state.mode === mode) return;
    state.mode = mode;
    if (mode === "images") state.autoAdvanceAll = false;
    state.selectedIndex = 0;
    applyModeUI();
    updateActionButtons();
    ensurePageData(mode, state.pageByMode[mode] || 0);
  };

  const updateActionButtons = () => {
    const selected = state.items[state.selectedIndex];
    const activeItem = resolveActiveItem(selected);
    const activePostId = activeItem && activeItem.postId ? String(activeItem.postId).trim() : "";
    if (activePostId) regenState.activePostId = activePostId;
    const canDelete = Boolean(activeItem && activeItem.postId);
    const isImages = state.mode === "images";
    {
      const checkedCount = state.selectedPostIds.size;
      if (deleteCheckedBtn) {
        deleteCheckedBtn.textContent = checkedCount > 0 ? `Delete Checked (${checkedCount})` : "Delete Checked";
        deleteCheckedBtn.disabled = checkedCount === 0 || state.busy;
      }
      if (downloadCheckedBtn) {
        downloadCheckedBtn.textContent = checkedCount > 0 ? `Download Checked (${checkedCount})` : "Download Checked";
        downloadCheckedBtn.disabled = checkedCount === 0 || state.busy;
      }
      if (checkAllBtn) {
        const pageIds = getCurrentPagePostIds();
        const allChecked = pageIds.length > 0 && pageIds.every((id) => state.selectedPostIds.has(id));
        checkAllBtn.textContent = allChecked ? "Uncheck All" : "Check All";
        checkAllBtn.dataset.tooltip = allChecked
          ? "Uncheck every post on this page."
          : "Check every post on this page.";
        checkAllBtn.disabled = pageIds.length === 0 || state.busy;
      }
    }
    const regenContext = selected ? buildRegenContext(selected, null) : null;
    const activeJob = getRegenJob(activePostId);
    const activeRunning = Boolean(activeJob && activeJob.running);
    const runningCount = getRunningRegenCount();
    const cooldownSeconds = getRegenCooldownSeconds();
    const cooldownBlocked = cooldownSeconds > 0 && runningCount === 0;
    if (downloadBtn) downloadBtn.disabled = !activeItem || state.busy;
    if (shareBtn) shareBtn.disabled = !activeItem || !activeItem.postId || state.busy;
    if (deleteBtn) deleteBtn.disabled = !canDelete || state.busy;
    if (promptBtn) promptBtn.disabled = !activeItem || state.busy;
    if (regenBtn) {
      const canRegenerate = Boolean(activeItem && activeItem.postId);
      const slotBlocked = !activeRunning && runningCount >= REGEN_MAX_CONCURRENT;
      regenBtn.disabled = !canRegenerate || state.busy || activeRunning || cooldownBlocked || slotBlocked;
      regenBtn.classList.toggle("active", activeRunning);
      if (activeRunning) {
        const pct = Math.max(0, Math.min(100, Math.round(Number(activeJob && activeJob.progress) || 0)));
        regenBtn.dataset.tooltip = `Regeneration in progress (${pct}%)`;
      } else if (slotBlocked) {
        regenBtn.dataset.tooltip = `Maximum ${REGEN_MAX_CONCURRENT} regenerations in progress`;
      } else if (cooldownBlocked) {
        regenBtn.dataset.tooltip = `Regenerate available in ${cooldownSeconds}s`;
      } else {
        regenBtn.dataset.tooltip = "Generate an alternative video from this prompt";
      }
      updateRegenButtonVisual();
    }
    if (downloadAllBtn) {
      // Conversation media never lands in the per-mode caches, and in grid mode the v2
      // stream is walked before the legacy one -- so gating on videoItems/imageItems
      // alone left this disabled while the grid was full of conversation tiles.
      const hasAny =
        state.assets.totalLoaded ||
        state.videoItems.length ||
        state.imageItems.length ||
        state.items.length;
      downloadAllBtn.disabled = !hasAny || state.busy;
    }
    if (deleteAllBtn) {
      const hasVideos = countLoadedVideos() || state.videoItems.length;
      const currentDeleteRunning = isDeleteAllRunning("videos");
      deleteAllBtn.disabled = !hasVideos || currentDeleteRunning || (state.busy && !isBusyFromDeleteOnly());
    }
    if (autoNextBtn) autoNextBtn.classList.toggle("active", !isImages && state.autoAdvance);
    if (autoAllBtn) {
      const showAllAutoplay = isGridMode() && !isImages;
      autoAllBtn.style.display = showAllAutoplay ? "inline-flex" : "none";
      autoAllBtn.classList.toggle("active", showAllAutoplay && state.autoAdvanceAll);
      autoAllBtn.disabled = !showAllAutoplay || state.busy;
    }
    if (downloadGroupBtn) {
      const showGroup = isGridMode() && selected && selected.variants && selected.variants.length > 1;
      downloadGroupBtn.style.display = "inline-flex";
      downloadGroupBtn.disabled = !showGroup || state.busy;
    }
    if (variantDeleteCompilationBtn) {
      const canDeleteCompilation =
        isGridMode() &&
        state.mode === "videos" &&
        selected &&
        selected.variants &&
        selected.variants.length > 1;
      variantDeleteCompilationBtn.style.display = canDeleteCompilation ? "inline-flex" : "none";
      variantDeleteCompilationBtn.disabled = !canDeleteCompilation || state.busy;
    }
    updateLightboxAutoplayIcon();
    updateAutoplayAllIcon();
  };

  const purgeCache = (options = {}) => {
    const confirmFirst = options.confirm !== false;
    const reload = options.reload !== false;
    const silent = options.silent === true;
    if (confirmFirst && !window.confirm("Purge cached list? This won't delete downloaded files.")) return false;
    chrome.storage.local.remove(STORAGE_KEY, () => {
      state.items = [];
      state.videoItems = [];
      state.imageItems = [];
      state.selectedIndex = 0;
      state.busy = false;
      state.knownUrls = new Set();
      if (gridEl) gridEl.innerHTML = "";
      if (emptyEl) emptyEl.classList.add("show");
      if (playerEl) {
        try {
          playerEl.pause();
          playerEl.removeAttribute("src");
          playerEl.load();
        } catch (e) {}
      }
      closeLightbox();
      if (!silent) setStatus("Cache purged. Reloading...");
      if (reload) {
        setTimeout(() => {
          window.location.reload();
        }, 60);
      } else {
        updateActionButtons();
      }
    });
    return true;
  };

  const setThumbStatus = (postId, stateName, label) => {
    if (!postId || !gridEl) return;
    const thumb = gridEl.querySelector(`.thumb[data-post-id="${postId}"]`);
    if (!thumb) return;
    thumb.classList.remove("deleting");
    const statusEl = thumb.querySelector(".thumb-status");
    if (statusEl) statusEl.textContent = label || "";
    if (stateName === "deleting") {
      thumb.classList.add("deleting");
    }
  };

  const escapeSelectorValue = (value) => {
    const text = String(value || "");
    if (!text) return "";
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(text);
    }
    return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  };

  const animateThumbRemoval = (postId) => {
    const id = String(postId || "").trim();
    if (!id || !gridEl) return;
    const escaped = escapeSelectorValue(id);
    if (!escaped) return;
    const thumbs = gridEl.querySelectorAll(`.thumb[data-post-id="${escaped}"]`);
    for (let i = 0; i < thumbs.length; i += 1) {
      const thumb = thumbs[i];
      if (!thumb || !thumb.isConnected) continue;
      thumb.classList.add("removing");
      const card = thumb.closest(".thumb-card");
      if (card) {
        card.classList.add("removing");
        setTimeout(() => {
          if (card && card.isConnected) card.remove();
        }, 230);
      } else {
        setTimeout(() => {
          if (thumb && thumb.isConnected) thumb.remove();
        }, 230);
      }
    }
  };

  const applyThumbRegenState = (thumb) => {
    if (!thumb) return;
    const postId = String((thumb.dataset && thumb.dataset.postId) || "").trim();
    const thumbIndex = Number(thumb.dataset && thumb.dataset.index ? thumb.dataset.index : "-1");
    const thumbItem =
      Number.isFinite(thumbIndex) && thumbIndex >= 0 && thumbIndex < state.items.length ? state.items[thumbIndex] : null;
    const indicator = thumb.querySelector(".thumb-regen-mini");
    const indicatorText = indicator ? indicator.querySelector(".thumb-regen-mini-text") : null;
    let job = getRegenJob(postId);
    if (thumbItem) {
      const relatedIds = collectPostIdsForItem(thumbItem);
      relatedIds.forEach((id) => {
        const relatedJob = getRegenJob(id);
        if (!relatedJob || !relatedJob.running) return;
        if (!job || !job.running || Number(relatedJob.progress || 0) > Number(job.progress || 0)) {
          job = relatedJob;
        }
      });
    }
    const running = Boolean(job && job.running);
    thumb.classList.toggle("regen-running", running);
    if (!indicator) return;
    if (!running) {
      indicator.style.setProperty("--regen-pct", "0");
      if (indicatorText) indicatorText.textContent = "";
      return;
    }
    const pct = Math.max(0, Math.min(100, Math.round(Number(job.progress) || 0)));
    indicator.style.setProperty("--regen-pct", String(pct));
    if (indicatorText) indicatorText.textContent = String(pct);
  };

  const syncThumbRegenIndicators = (postId) => {
    if (!gridEl) return;
    const allThumbs = gridEl.querySelectorAll(".thumb[data-index]");
    for (let i = 0; i < allThumbs.length; i += 1) {
      applyThumbRegenState(allThumbs[i]);
    }
  };

  let autoplayBatchTimer = 0;
  let autoplayRunToken = 0;

  const stopAutoplayBatch = () => {
    autoplayRunToken += 1;
    if (autoplayBatchTimer) {
      clearTimeout(autoplayBatchTimer);
      autoplayBatchTimer = 0;
    }
  };

  const syncThumbAutoplayPlayback = () => {
    if (!gridEl) return;
    const videos = Array.from(gridEl.querySelectorAll(".thumb video"));
    stopAutoplayBatch();
    if (!state.thumbAutoplay) {
      videos.forEach((el) => {
        if (!el) return;
        try {
          el.pause();
        } catch (e) {}
      });
      return;
    }

    const token = ++autoplayRunToken;
    const batchSize = 6;
    let index = 0;
    const playBatch = () => {
      if (!state.thumbAutoplay || token !== autoplayRunToken) return;
      const end = Math.min(index + batchSize, videos.length);
      for (; index < end; index += 1) {
        const el = videos[index];
        if (!el || !el.isConnected) continue;
        const src = el.dataset.src || "";
        if (src && !el.src) {
          el.src = src;
        }
        const p = el.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
      if (index < videos.length) {
        autoplayBatchTimer = window.setTimeout(playBatch, 12);
      } else {
        autoplayBatchTimer = 0;
      }
    };
    playBatch();
  };

  const scheduleWork = (cb) => {
    if (window.requestIdleCallback) {
      window.requestIdleCallback(() => cb(), { timeout: 120 });
      return;
    }
    window.requestAnimationFrame(cb);
  };

  const renderGrid = () => {
    if (!gridEl) return;
    const token = (state.renderToken += 1);
    gridEl.innerHTML = "";
    if (!state.items.length) {
      if (emptyEl) emptyEl.classList.add("show");
      const emptyTitle = emptyEl ? emptyEl.querySelector("h2") : null;
      if (emptyTitle) emptyTitle.textContent = "Nothing here yet";
      updateCount();
      updateActionButtons();
      return;
    }
    if (emptyEl) emptyEl.classList.remove("show");
    const items = state.items.slice();
    const mode = state.mode;
    updateCount();
    updatePager();
    const chunkSize = 36;
    let index = 0;
    const renderChunk = () => {
      if (token !== state.renderToken) return;
      const fragment = document.createDocumentFragment();
      const sliceEnd = Math.min(index + chunkSize, items.length);
      for (; index < sliceEnd; index += 1) {
        const item = items[index];
        const displayItem = resolveActiveItem(item) || item;
        const isNewGenerationItem = hasNewGenerationHighlight(item, displayItem);
        const eagerThumb = index < 24;
        const card = document.createElement("div");
        card.className = "thumb-card";
        card.dataset.index = String(index);
        const thumb = document.createElement("div");
        thumb.className = "thumb";
        thumb.dataset.index = String(index);
        if (isGridMode()) thumb.classList.add("grid-thumb");
        if (displayItem && displayItem.postId) thumb.dataset.postId = displayItem.postId;
        if (isNewGenerationItem) {
          thumb.classList.add("new-generation");
          const newRibbon = document.createElement("span");
          newRibbon.className = "thumb-new-ribbon";
          newRibbon.textContent = "NEW";
          thumb.appendChild(newRibbon);
        }
        const itemKind = (displayItem && displayItem.kind) || (state.mode === "images" ? "image" : "video");
        if (itemKind === "video") {
          if (isHdVideoItem(displayItem)) {
            const hdTag = document.createElement("span");
            hdTag.className = "thumb-hd-tag";
            hdTag.textContent = "HD";
            thumb.appendChild(hdTag);
          } else {
            queueHdProbe(displayItem);
          }
        }
        thumb.setAttribute("role", "button");
        thumb.tabIndex = 0;

        if (pendingDeleteMarkers.size) {
          const variants = item && item.variants && item.variants.length ? item.variants : [item];
          const allMarked = variants.every((v) => {
            const pid = v && v.postId ? String(v.postId) : "";
            return pid && pendingDeleteMarkers.has(pid);
          });
          if (allMarked) thumb.classList.add("deleted-blurry");
        }

        if (itemKind === "image") {
          const img = document.createElement("img");
          img.src = optimizeThumbUrl(displayItem.url, { imageGridLow: true });
          img.alt = "Generated image";
          img.loading = eagerThumb ? "eager" : "lazy";
          img.fetchPriority = eagerThumb ? "high" : "auto";
          img.decoding = "async";
          thumb.appendChild(img);
        } else if (state.thumbAutoplay) {
          const video = document.createElement("video");
          video.muted = true;
          video.playsInline = true;
          video.preload = eagerThumb ? "metadata" : "none";
          video.loop = true;
          video.autoplay = false;
          video.tabIndex = -1;
          video.dataset.index = String(index);
          const fastPoster = getBestPosterUrl(displayItem, { preferSource: true });
          if (fastPoster && !isMp4(fastPoster, displayItem.mimeType)) video.poster = fastPoster;
          const thumbSource = getThumbPreviewVideoUrl(displayItem);
          if (!thumbSource) {
            quarantineBrokenVideoPost(displayItem && displayItem.postId);
            continue;
          }
          if (eagerThumb) {
            video.src = thumbSource;
          } else {
            video.dataset.src = thumbSource;
          }
          video.addEventListener("error", () => {
            addLog(`Thumb error: ${displayItem.url}`);
            quarantineBrokenVideoPost(displayItem && displayItem.postId);
          });
          thumb.appendChild(video);
        } else {
          const img = document.createElement("img");
          const fastPoster = getBestPosterUrl(displayItem, { preferSource: true });
          if (fastPoster && !isMp4(fastPoster, displayItem.mimeType)) {
            img.src = fastPoster;
            img.alt = "Generated video";
            img.loading = eagerThumb ? "eager" : "lazy";
            img.fetchPriority = eagerThumb ? "high" : "auto";
            img.decoding = "async";
            img.onerror = () => {
              const sourceFirstFallback = getBestPosterUrl(displayItem, { preferSource: true });
              if (!img.dataset.fallback && sourceFirstFallback && sourceFirstFallback !== img.src) {
                img.dataset.fallback = "1";
                img.src = sourceFirstFallback;
                return;
              }
              if (img.dataset.videoFallback) return;
              img.dataset.videoFallback = "1";
              const video = document.createElement("video");
              video.muted = true;
              video.playsInline = true;
              video.preload = "metadata";
              video.loop = false;
              video.autoplay = false;
              video.tabIndex = -1;
              const fallbackVideoSrc = getThumbPreviewVideoUrl(displayItem);
              if (!fallbackVideoSrc) {
                quarantineBrokenVideoPost(displayItem && displayItem.postId);
                if (img.parentNode) img.parentNode.removeChild(img);
                return;
              }
              video.src = fallbackVideoSrc;
              video.addEventListener("loadedmetadata", () => {
                try {
                  const target = Math.min(0.1, video.duration || 0);
                  if (target > 0) video.currentTime = target;
                } catch (e) {}
              });
              video.addEventListener("seeked", () => {
                try {
                  video.pause();
                } catch (e) {}
              });
              video.addEventListener("error", () => {
                addLog(`Thumb error: ${displayItem.url}`);
                quarantineBrokenVideoPost(displayItem && displayItem.postId);
              });
              if (img.parentNode) img.parentNode.replaceChild(video, img);
            };
            thumb.appendChild(img);
          } else {
            const video = document.createElement("video");
            video.muted = true;
            video.playsInline = true;
            video.preload = "metadata";
            video.loop = false;
            video.autoplay = false;
            video.tabIndex = -1;
            const previewVideoSrc = getThumbPreviewVideoUrl(displayItem);
            if (!previewVideoSrc) {
              quarantineBrokenVideoPost(displayItem && displayItem.postId);
              continue;
            }
            video.src = previewVideoSrc;
            video.addEventListener("loadeddata", () => {
              try {
                video.pause();
              } catch (e) {}
            });
            video.addEventListener("error", () => {
              addLog(`Thumb error: ${displayItem.url}`);
              quarantineBrokenVideoPost(displayItem && displayItem.postId);
            });
            thumb.appendChild(video);
          }
        }

        const regenMini = document.createElement("div");
        regenMini.className = "thumb-regen-mini";
        const regenMiniText = document.createElement("span");
        regenMiniText.className = "thumb-regen-mini-text";
        regenMini.appendChild(regenMiniText);
        thumb.appendChild(regenMini);
        applyThumbRegenState(thumb);

        const checkBox = document.createElement("div");
        checkBox.className = "thumb-check";
        checkBox.dataset.action = "toggle-check";
        checkBox.dataset.index = String(index);
        if (displayItem && displayItem.postId) checkBox.dataset.postId = displayItem.postId;
        checkBox.setAttribute("role", "checkbox");
        checkBox.tabIndex = 0;
        const isChecked = !!(displayItem && displayItem.postId && state.selectedPostIds.has(String(displayItem.postId)));
        if (isChecked) {
          checkBox.classList.add("checked");
          thumb.classList.add("selected");
          checkBox.setAttribute("aria-checked", "true");
        } else {
          checkBox.setAttribute("aria-checked", "false");
        }
        thumb.appendChild(checkBox);

        if (item && item.variants && item.variants.length > 1) {
          thumb.classList.add("has-group-badge");
          const badge = document.createElement("div");
          badge.className = "group-badge";
          thumb.appendChild(badge);
        }

        const itemDownloadedMode = itemKind === "image" ? "images" : "videos";
        if (isItemDownloaded(itemDownloadedMode, displayItem)) {
          const downloadedBadge = document.createElement("div");
          downloadedBadge.className = "downloaded-badge";
          downloadedBadge.textContent = "✓";
          downloadedBadge.dataset.tooltip = "File already downloaded";
          downloadedBadge.setAttribute("aria-label", "File already downloaded");
          thumb.appendChild(downloadedBadge);
        }

        const overlay = document.createElement("div");
        overlay.className = "thumb-overlay";
        const statusChip = document.createElement("div");
        statusChip.className = "thumb-status";
        const actions = document.createElement("div");
        actions.className = "thumb-actions";

        const deleteAction = document.createElement("button");
        deleteAction.type = "button";
        deleteAction.className = "icon-btn danger";
        deleteAction.title = displayItem.postId ? "Delete" : "Delete unavailable";
        deleteAction.dataset.tooltip = "Delete";
        deleteAction.appendChild(buildIcon("images/thumbnail/close.svg", "Delete"));
        deleteAction.dataset.action = "delete";
        deleteAction.dataset.index = String(index);
        if (!displayItem.postId || state.busy) deleteAction.disabled = true;

        const promptAction = document.createElement("button");
        promptAction.type = "button";
        promptAction.className = "icon-btn prompt";
        promptAction.title = "Copy this prompt";
        promptAction.dataset.tooltip = "Copy this prompt";
        promptAction.appendChild(buildIcon("images/prompt.svg", "Prompt"));
        promptAction.dataset.action = "prompt";
        promptAction.dataset.index = String(index);

        const downloadVideosAction = document.createElement("button");
        downloadVideosAction.type = "button";
        downloadVideosAction.className = "icon-btn download";
        downloadVideosAction.title = "Download all videos and image under this post";
        downloadVideosAction.dataset.tooltip = "Download all videos and image under this post";
        downloadVideosAction.appendChild(buildIcon("images/compilation.svg", "Download all media"));
        downloadVideosAction.dataset.action = "download-videos";
        downloadVideosAction.dataset.index = String(index);
        if (state.busy) downloadVideosAction.disabled = true;

        const deleteVideosAction = document.createElement("button");
        deleteVideosAction.type = "button";
        deleteVideosAction.className = "icon-btn danger";
        deleteVideosAction.title = "Delete all videos under this post";
        deleteVideosAction.dataset.tooltip = "Delete all videos under this post";
        deleteVideosAction.appendChild(buildIcon("images/thumbnail/close.svg", "Delete all videos"));
        deleteVideosAction.dataset.action = "delete-videos";
        deleteVideosAction.dataset.index = String(index);
        if (state.busy) deleteVideosAction.disabled = true;

        actions.appendChild(promptAction);
        actions.appendChild(downloadVideosAction);
        actions.appendChild(deleteVideosAction);
        actions.appendChild(deleteAction);
        overlay.appendChild(statusChip);
        overlay.appendChild(actions);
        thumb.appendChild(overlay);
        card.appendChild(thumb);
        fragment.appendChild(card);
      }
      gridEl.appendChild(fragment);
      if (index < items.length) {
        scheduleWork(renderChunk);
        return;
      }
      syncThumbAutoplayPlayback();
      updateActionButtons();
    };
    scheduleWork(renderChunk);
  };

  const ensureDownloadedBadgeForThumb = (thumb) => {
    if (!thumb) return;
    if (thumb.querySelector(".downloaded-badge")) return;
    const downloadedBadge = document.createElement("div");
    downloadedBadge.className = "downloaded-badge";
    downloadedBadge.textContent = "✓";
    downloadedBadge.dataset.tooltip = "File already downloaded";
    downloadedBadge.setAttribute("aria-label", "File already downloaded");
    thumb.appendChild(downloadedBadge);
  };

  const syncVisibleDownloadedBadges = () => {
    if (!gridEl) return;
    const mode = state.mode;
    const thumbs = gridEl.querySelectorAll(".thumb[data-index]");
    thumbs.forEach((thumbNode) => {
      const thumb = thumbNode instanceof HTMLElement ? thumbNode : null;
      if (!thumb) return;
      const idx = Number(thumb.dataset.index);
      if (!Number.isFinite(idx) || idx < 0 || idx >= state.items.length) return;
      const group = state.items[idx];
      const displayItem = resolveActiveItem(group) || group;
      if (!displayItem) return;
      if (isItemDownloaded(mode, displayItem)) {
        ensureDownloadedBadgeForThumb(thumb);
      } else {
        const existing = thumb.querySelector(".downloaded-badge");
        if (existing) existing.remove();
      }
    });
  };

  const findGroupLocationByPostId = (postId) => {
    const targetId = normalizeId(postId);
    if (!targetId) return { groupIndex: -1, variantIndex: -1 };
    for (let groupIndex = 0; groupIndex < state.items.length; groupIndex += 1) {
      const group = state.items[groupIndex];
      if (!group) continue;
      const directId = normalizeId(group.postId);
      if (directId && directId === targetId) return { groupIndex, variantIndex: -1 };
      const variants = Array.isArray(group.variants) ? group.variants : [];
      for (let variantIndex = 0; variantIndex < variants.length; variantIndex += 1) {
        const variantId = normalizeId(variants[variantIndex] && variants[variantIndex].postId);
        if (variantId && variantId === targetId) return { groupIndex, variantIndex };
      }
    }
    return { groupIndex: -1, variantIndex: -1 };
  };

  const selectGroupByPostId = (postId) => {
    const found = findGroupLocationByPostId(postId);
    if (found.groupIndex < 0) return false;
    state.selectedIndex = found.groupIndex;
    const group = state.items[found.groupIndex];
    if (group && Array.isArray(group.variants) && group.variants.length) {
      if (found.variantIndex >= 0) {
        group.activeIndex = found.variantIndex;
      } else if (!Number.isFinite(group.activeIndex) || group.activeIndex < 0 || group.activeIndex >= group.variants.length) {
        group.activeIndex = 0;
      }
    }
    return true;
  };

  const selectGroupByGroupId = (groupId) => {
    const target = normalizeId(groupId);
    if (!target) return false;
    const index = state.items.findIndex((entry) => normalizeId(entry && entry.groupId) === target);
    if (index < 0) return false;
    state.selectedIndex = index;
    const group = state.items[index];
    if (group && Array.isArray(group.variants) && group.variants.length) {
      if (!Number.isFinite(group.activeIndex) || group.activeIndex < 0 || group.activeIndex >= group.variants.length) {
        group.activeIndex = 0;
      }
    }
    return true;
  };

  const hydrateActiveGroupVariantsFromDetails = async (options = {}) => {
    if (!isGridMode() || state.mode !== "videos") return false;
    const group = state.items[state.selectedIndex];
    if (!group) return false;
    const active = resolveActiveItem(group) || group;
    const groupId = normalizeId(group.groupId || group.postId);
    const activePostId = normalizeId(active.postId);
    const fetchTargetId =
      normalizeId(active.parentPostId) ||
      normalizeId(active.originalPostId) ||
      activePostId ||
      groupId;
    if (!fetchTargetId) return false;
    const hydrationKey = `${groupId || fetchTargetId}:${fetchTargetId}`;
    const now = Date.now();
    if (!options.force) {
      const lastTouch = Number(variantHydrationTouched.get(hydrationKey) || 0);
      if (lastTouch && now - lastTouch < 12000) return false;
    }
    if (variantHydrationInFlight.has(hydrationKey)) return false;
    variantHydrationInFlight.add(hydrationKey);
    variantHydrationTouched.set(hydrationKey, now);
    try {
      const detail = await fetchPostDetails(fetchTargetId);
      const detailVideos = collectVideoItemsFromDetail(detail);
      if (!detailVideos.length) return false;
      const seedIds = new Set(
        [
          groupId,
          activePostId,
          normalizeId(group.postId),
          normalizeId(group.parentPostId),
          normalizeId(group.originalPostId),
          normalizeId(active.parentPostId),
          normalizeId(active.originalPostId)
        ].filter(Boolean)
      );
      const currentVariants =
        Array.isArray(group.variants) && group.variants.length
          ? group.variants.slice()
          : [group].filter(Boolean);
      const familyCandidates = detailVideos.filter((candidate) => {
        if (!candidate) return false;
        const postId = normalizeId(candidate.postId);
        const parentId = normalizeId(candidate.parentPostId);
        const originalId = normalizeId(candidate.originalPostId);
        if (!postId) return false;
        if (seedIds.has(postId) || seedIds.has(parentId) || seedIds.has(originalId)) return true;
        if (groupId && (parentId === groupId || originalId === groupId)) return true;
        if (activePostId && (parentId === activePostId || originalId === activePostId)) return true;
        return false;
      });
      if (!familyCandidates.length) return false;
      const mergedVariants = dedupeItems(currentVariants.concat(familyCandidates));
      if (mergedVariants.length <= currentVariants.length) return false;
      const sortedVariants = mergedVariants
        .slice()
        .sort((a, b) => toTime(a && a.createdAt) - toTime(b && b.createdAt));
      const keepPostId = normalizeId(options.keepPostId) || activePostId;
      const preferPostId = normalizeId(options.preferPostId);
      let nextActiveIndex = keepPostId
        ? sortedVariants.findIndex((variant) => normalizeId(variant && variant.postId) === keepPostId)
        : -1;
      if (nextActiveIndex < 0 && preferPostId) {
        nextActiveIndex = sortedVariants.findIndex((variant) => normalizeId(variant && variant.postId) === preferPostId);
      }
      if (nextActiveIndex < 0) nextActiveIndex = Math.max(0, sortedVariants.length - 1);
      group.variants = sortedVariants;
      group.groupCount = sortedVariants.length;
      group.isGroup = sortedVariants.length > 1;
      group.activeIndex = nextActiveIndex;
      return true;
    } catch (error) {
      return false;
    } finally {
      variantHydrationInFlight.delete(hydrationKey);
    }
  };

  const updateVariantAutoplayToggleButton = () => {
    if (!variantAutoplayStopBtn) return;
    const running = !!state.variantPreviewAutoplay;
    variantAutoplayStopBtn.classList.toggle("stopped", !running);
    variantAutoplayStopBtn.setAttribute(
      "aria-label",
      running ? "Stop autoplay previews" : "Enable autoplay previews"
    );
    variantAutoplayStopBtn.dataset.tooltip = running
      ? "Stop autoplay previews"
      : "Enable autoplay previews";
    const icon = variantAutoplayStopBtn.querySelector("img");
    if (icon) {
      const nextSrc = chrome.runtime.getURL(
        running ? "images/stop.svg" : "images/autoplay.svg"
      );
      if (icon.src !== nextSrc) icon.src = nextSrc;
      icon.alt = running ? "Stop autoplay previews" : "Enable autoplay previews";
    }
  };

  const applyVariantPreviewAutoplayState = () => {
    if (!variantStripEl) return;
    const variantVideos = variantStripEl.querySelectorAll(".variant-thumb video");
    for (let i = 0; i < variantVideos.length; i += 1) {
      const video = variantVideos[i];
      if (!video) continue;
      video.autoplay = !!state.variantPreviewAutoplay;
      video.loop = !!state.variantPreviewAutoplay;
      if (state.variantPreviewAutoplay) {
        video.preload = "metadata";
        const playPromise = video.play();
        if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
      } else {
        video.preload = "metadata";
        try {
          video.pause();
        } catch (error) {}
      }
    }
    updateVariantAutoplayToggleButton();
  };

  const renderVariantStrip = () => {
    if (!variantStripEl || !variantWrapEl) return;
    const group = state.items[state.selectedIndex];
    if (
      isGridMode() &&
      state.mode === "videos" &&
      group &&
      (!group.variants || group.variants.length <= 1)
    ) {
      const keepPostId = normalizeId((resolveActiveItem(group) || group).postId);
      hydrateActiveGroupVariantsFromDetails({ keepPostId }).then((changed) => {
        const lightboxOpenNow = Boolean(lightboxEl && lightboxEl.classList.contains("open"));
        if (!changed || !lightboxOpenNow) return;
        renderVariantStrip();
        updateActionButtons();
      });
    }
    if (!isGridMode() || !group || !group.variants || group.variants.length <= 1) {
      variantWrapEl.classList.remove("show");
      variantWrapEl.classList.remove("scrollable");
      variantStripEl.innerHTML = "";
      if (variantMoreBtn) variantMoreBtn.style.display = "none";
      updateVariantAutoplayToggleButton();
      return;
    }
    variantWrapEl.classList.add("show");
    variantStripEl.innerHTML = "";
    const ordered = group.variants
      .map((variant, index) => ({ variant, index }))
      .sort((a, b) => {
        const aTime = toTime(a.variant && a.variant.createdAt);
        const bTime = toTime(b.variant && b.variant.createdAt);
        return aTime - bTime;
      });
    const parentIndex = ordered.findIndex((entry) => entry.variant && entry.variant.postId === group.groupId);
    if (parentIndex > 0) {
      const parentEntry = ordered.splice(parentIndex, 1)[0];
      ordered.unshift(parentEntry);
    }
    ordered.forEach((entry, displayIdx) => {
      const variant = entry.variant;
      const idx = entry.index;
      const thumb = document.createElement("div");
      thumb.className = "variant-thumb";
      if (idx === (group.activeIndex || 0)) thumb.classList.add("active");
      const variantPostId = String((variant && variant.postId) || "").trim();
      if (variantPostId) thumb.dataset.variantId = variantPostId;
      const variantIsNew = Boolean(variantPostId && newGenerationHighlightIds.has(variantPostId));
      if (variantIsNew) {
        thumb.classList.add("new-generation");
        const ribbon = document.createElement("span");
        ribbon.className = "variant-new-ribbon";
        ribbon.textContent = "NEW";
        thumb.appendChild(ribbon);
      }
      const previewInfo = resolveVariantPreview(variant, group);
      const preview = previewInfo.url;
      if (previewInfo.useVideo) {
        const vid = document.createElement("video");
        vid.muted = true;
        vid.playsInline = true;
        vid.autoplay = !!state.variantPreviewAutoplay;
        vid.loop = !!state.variantPreviewAutoplay;
        vid.preload = "metadata";
        vid.src = preview;
        const posterCandidate = optimizeThumbUrl(normalizeUrl((variant && (variant.poster || variant.sourceImageUrl)) || ""));
        if (posterCandidate && !isMp4(posterCandidate, variant && variant.mimeType)) {
          vid.poster = posterCandidate;
        }
        if (state.variantPreviewAutoplay) {
          const playPromise = vid.play();
          if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
        }
        thumb.appendChild(vid);
      } else {
        const img = document.createElement("img");
        img.src = preview;
        img.alt = "Variant";
        img.loading = "lazy";
        thumb.appendChild(img);
      }
      const num = document.createElement("div");
      num.className = "variant-num";
      num.textContent = String(displayIdx + 1);
      thumb.appendChild(num);
      thumb.onclick = () => {
        if (variantPostId) consumeNewGenerationHighlightForPostId(variantPostId);
        group.activeIndex = idx;
        loadPlayer();
        renderVariantStrip();
      };
      variantStripEl.appendChild(thumb);
    });
    const isScrollable = ordered.length > 3;
    variantStripEl.classList.toggle("scrollable", isScrollable);
    variantWrapEl.classList.toggle("scrollable", isScrollable);
    if (variantMoreBtn) variantMoreBtn.style.display = isScrollable ? "grid" : "none";
    applyVariantPreviewAutoplayState();
    const activeThumb = variantStripEl.querySelector(".variant-thumb.active");
    if (activeThumb && typeof activeThumb.scrollIntoView === "function") {
      activeThumb.scrollIntoView({ block: "nearest" });
    }
  };

  const mergeRefreshedVideoIntoItem = (targetItem, refreshed) => {
    if (!targetItem || !refreshed) return;
    if (refreshed.playbackUrl) targetItem.playbackUrl = refreshed.playbackUrl;
    if (refreshed.mediaUrl) targetItem.mediaUrl = refreshed.mediaUrl;
    if (refreshed.url) targetItem.url = refreshed.url;
    if (refreshed.hdMediaUrl) targetItem.hdMediaUrl = refreshed.hdMediaUrl;
    if (refreshed.poster) targetItem.poster = refreshed.poster;
    if (refreshed.sourceImageUrl) targetItem.sourceImageUrl = refreshed.sourceImageUrl;
    if (refreshed.mimeType && !targetItem.mimeType) targetItem.mimeType = refreshed.mimeType;
    if (refreshed.mediaWidth) targetItem.mediaWidth = refreshed.mediaWidth;
    if (refreshed.mediaHeight) targetItem.mediaHeight = refreshed.mediaHeight;
    if (refreshed.isPortrait !== null && refreshed.isPortrait !== undefined) {
      targetItem.isPortrait = refreshed.isPortrait;
    }
  };

  const loadPlayer = () => {
    ensureMediaPreconnect();
    const group = state.items[state.selectedIndex];
    if (!group) return;
    if (group && group.variants && group.variants.length) {
      if (!Number.isFinite(group.activeIndex) || group.activeIndex >= group.variants.length) {
        group.activeIndex = 0;
      }
    }
    const item = resolveActiveItem(group);
    if (!item) return;
    const lightboxItemKind = (item && item.kind) || (state.mode === "images" ? "image" : "video");
    if (lightboxHdTag) {
      const showHd = lightboxItemKind === "video" && isHdVideoItem(item);
      lightboxHdTag.classList.toggle("show", showHd);
    }
    const clearPendingPlayerLoadHooks = () => {
      if (!clearPlayerLoadHooks) return;
      try {
        clearPlayerLoadHooks();
      } catch (error) {}
      clearPlayerLoadHooks = null;
    };
    const isImages = lightboxItemKind === "image" && item.url && isImage(item.url, item.mimeType);
    if (isImages) {
      clearPendingPlayerLoadHooks();
      if (lightboxEl) lightboxEl.classList.remove("gv-landscape-video");
      if (playerEl) {
        try {
          playerEl.pause();
        } catch (e) {}
        playerEl.removeAttribute("src");
        playerEl.removeAttribute("poster");
        playerEl.load();
        playerEl.style.display = "none";
        playerEl.controls = false;
      }
      if (imageEl) {
        imageEl.style.display = "block";
        imageEl.src = item.url;
      }
      if (lightboxHdTag) lightboxHdTag.classList.remove("show");
    } else {
      if (imageEl) {
        imageEl.style.display = "none";
        imageEl.removeAttribute("src");
      }
      if (!playerEl) return;
      clearPendingPlayerLoadHooks();
      if (lightboxEl) lightboxEl.classList.toggle("gv-landscape-video", isLandscapeMediaItem(item));
      const itemPostId = String(item.postId || "").trim();
      const isNewGenerationItem = Boolean(itemPostId && newGenerationHighlightIds.has(itemPostId));
      if (isNewGenerationItem && itemPostId && !hydratedNewVideoPosts.has(itemPostId)) {
        hydratedNewVideoPosts.add(itemPostId);
        fetchPostDetails(itemPostId)
          .then((detail) => {
            if (!detail) return;
            const refreshed = resolveRefreshedVideoItem(
              detail,
              itemPostId,
              item.parentPostId || "",
              item.sourceImageUrl || "",
              item.promptText || ""
            );
            if (!refreshed) return;
            mergeRefreshedVideoIntoItem(item, refreshed);
            const activeNow = resolveActiveItem(state.items[state.selectedIndex]);
            const activeNowId = String((activeNow && activeNow.postId) || "").trim();
            const lightboxOpenNow = Boolean(lightboxEl && lightboxEl.classList.contains("open"));
            if (lightboxOpenNow && activeNowId && activeNowId === itemPostId) {
              loadPlayer();
            }
          })
          .catch(() => {
            hydratedNewVideoPosts.delete(itemPostId);
          });
      }
      const playbackCandidates = getPlaybackCandidates(item);
      const token = ++playerLoadToken;
      const primarySource = playbackCandidates[0] || "";
      let missingSourceRetryTimer = null;
      const clearMissingSourceRetry = () => {
        if (!missingSourceRetryTimer) return;
        clearTimeout(missingSourceRetryTimer);
        missingSourceRetryTimer = null;
      };
      if (!primarySource) {
        const posterFallback = getBestPosterUrl(item, { preferSource: true });
        if (posterFallback && !isMp4(posterFallback, item.mimeType)) {
          playerEl.poster = posterFallback;
        } else {
          playerEl.removeAttribute("poster");
        }
        playerEl.style.display = "";
        playerEl.controls = true;
        playerEl.preload = "auto";
        playerEl.playsInline = true;
        playerEl.setAttribute("fetchpriority", "high");
        if (itemPostId) {
          const retryMissingSource = async (attempt) => {
            if (token !== playerLoadToken) return;
            const lightboxOpenNow = Boolean(lightboxEl && lightboxEl.classList.contains("open"));
            if (!lightboxOpenNow) return;
            const activeNow = resolveActiveItem(state.items[state.selectedIndex]);
            const activeNowId = String((activeNow && activeNow.postId) || "").trim();
            if (!activeNowId || activeNowId !== itemPostId) return;
            try {
              const detail = await fetchPostDetails(itemPostId);
              if (!detail || token !== playerLoadToken) return;
              const refreshed = resolveRefreshedVideoItem(
                detail,
                itemPostId,
                item.parentPostId || "",
                item.sourceImageUrl || "",
                item.promptText || ""
              );
              if (refreshed) {
                mergeRefreshedVideoIntoItem(item, refreshed);
              }
            } catch (error) {}
            if (token !== playerLoadToken) return;
            const refreshedCandidates = getPlaybackCandidates(item);
            if (refreshedCandidates.length) {
              loadPlayer();
              return;
            }
            if (attempt >= 18) return;
            missingSourceRetryTimer = setTimeout(() => {
              retryMissingSource(attempt + 1);
            }, 280);
          };
          retryMissingSource(0);
        }
        clearPlayerLoadHooks = () => {
          clearMissingSourceRetry();
        };
        return;
      }
      const posterCandidate = getBestPosterUrl(item, { preferSource: true });
      if (posterCandidate && !isMp4(posterCandidate, item.mimeType)) {
        playerEl.poster = posterCandidate;
      } else {
        playerEl.removeAttribute("poster");
      }
      let candidateIndex = 0;
      let fallbackTimer = null;
      let sourceProbeTimer = null;
      let sourceProbeAttempts = 0;
      let progressWatchTimer = null;
      let stallNoProgressTicks = 0;
      let stallRecoveryPasses = 0;
      let lastPlaybackTime = -1;
      let detailRefreshInFlight = false;
      let detailRefreshed = false;
      const clearSourceProbe = () => {
        if (!sourceProbeTimer) return;
        clearTimeout(sourceProbeTimer);
        sourceProbeTimer = null;
      };
      const clearProgressWatch = () => {
        if (!progressWatchTimer) return;
        clearInterval(progressWatchTimer);
        progressWatchTimer = null;
      };
      const applySource = (sourceUrl) => {
        if (!sourceUrl) return;
        playerEl.pause();
        const currentSrc = String(playerEl.currentSrc || playerEl.src || "");
        if (currentSrc !== sourceUrl) {
          playerEl.src = sourceUrl;
          playerEl.load();
        }
        playerEl.loop = !(state.autoAdvance || state.autoAdvanceAll);
        const playPromise = playerEl.play();
        if (playPromise && typeof playPromise.catch === "function") {
          playPromise.catch(() => {});
        }
      };
      const tryRefreshCurrentPostSources = async () => {
        if (detailRefreshed || detailRefreshInFlight || !itemPostId || token !== playerLoadToken) return;
        detailRefreshInFlight = true;
        try {
          const detail = await fetchPostDetails(itemPostId);
          if (!detail || token !== playerLoadToken) return;
          const refreshed = resolveRefreshedVideoItem(
            detail,
            itemPostId,
            item.parentPostId || "",
            item.sourceImageUrl || "",
            item.promptText || ""
          );
          if (!refreshed) return;
          mergeRefreshedVideoIntoItem(item, refreshed);
          const refreshedCandidates = getPlaybackCandidates(item);
          for (let i = 0; i < refreshedCandidates.length; i += 1) {
            if (!playbackCandidates.includes(refreshedCandidates[i])) {
              playbackCandidates.push(refreshedCandidates[i]);
            }
          }
          if (candidateIndex + 1 < playbackCandidates.length) {
            detailRefreshed = true;
            tryFallback();
            return;
          }
          const currentCandidate = playbackCandidates[Math.max(0, candidateIndex)] || playbackCandidates[0] || "";
          if (currentCandidate && playerEl && token === playerLoadToken && playerEl.readyState < 2) {
            const currentSrc = String(playerEl.currentSrc || playerEl.src || "");
            if (currentSrc !== currentCandidate) {
              applySource(currentCandidate);
            }
          }
        } catch (error) {
          // keep current source candidates
        } finally {
          detailRefreshInFlight = false;
        }
      };
      const tryFallback = () => {
        if (candidateIndex + 1 >= playbackCandidates.length) {
          tryRefreshCurrentPostSources();
          return;
        }
        candidateIndex += 1;
        applySource(playbackCandidates[candidateIndex]);
      };
      const scheduleSourceProbe = () => {
        if (!itemPostId) return;
        if (sourceProbeAttempts >= 20) return;
        clearSourceProbe();
        sourceProbeTimer = setTimeout(async () => {
          if (!playerEl || token !== playerLoadToken) return;
          if (playerEl.readyState >= 2) return;
          sourceProbeAttempts += 1;
          await tryRefreshCurrentPostSources();
          if (!playerEl || token !== playerLoadToken) return;
          if (playerEl.readyState < 2) {
            const currentCandidate = playbackCandidates[Math.max(0, candidateIndex)] || playbackCandidates[0] || "";
            if (currentCandidate) applySource(currentCandidate);
            scheduleSourceProbe();
          }
        }, 240);
      };
      const scheduleProgressWatch = () => {
        clearProgressWatch();
        progressWatchTimer = setInterval(() => {
          if (!playerEl || token !== playerLoadToken) {
            clearProgressWatch();
            return;
          }
          const lightboxOpenNow = Boolean(lightboxEl && lightboxEl.classList.contains("open"));
          if (!lightboxOpenNow) {
            clearProgressWatch();
            return;
          }
          if (playerEl.ended || playerEl.paused || playerEl.seeking) {
            lastPlaybackTime = Number(playerEl.currentTime || 0);
            stallNoProgressTicks = 0;
            stallRecoveryPasses = 0;
            return;
          }
          const nowTime = Number(playerEl.currentTime || 0);
          const duration = Number(playerEl.duration || 0);
          const nearEnd = duration > 0 && nowTime >= duration - 0.45;
          if (nowTime > lastPlaybackTime + 0.04 || nearEnd) {
            lastPlaybackTime = nowTime;
            stallNoProgressTicks = 0;
            stallRecoveryPasses = 0;
            return;
          }
          const networkLoading =
            typeof playerEl.NETWORK_LOADING === "number" ? playerEl.NETWORK_LOADING : 2;
          const needsRecovery = playerEl.readyState < 3 || Number(playerEl.networkState || 0) === networkLoading;
          if (!needsRecovery) {
            stallNoProgressTicks = 0;
            return;
          }
          stallNoProgressTicks += 1;
          if (stallNoProgressTicks < 5) return;
          stallNoProgressTicks = 0;
          stallRecoveryPasses += 1;
          const playPromise = playerEl.play();
          if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
          scheduleSourceProbe();
          if (stallRecoveryPasses < 2) return;
          stallRecoveryPasses = 0;
          const currentCandidate = playbackCandidates[Math.max(0, candidateIndex)] || playbackCandidates[0] || "";
          if (currentCandidate && playerEl.readyState < 2) {
            applySource(currentCandidate);
          } else {
            tryFallback();
          }
        }, 480);
      };
      const onLoadedMetadata = () => {
        if (!playerEl || token !== playerLoadToken || !lightboxEl) return;
        const vw = Number(playerEl.videoWidth || 0);
        const vh = Number(playerEl.videoHeight || 0);
        if (vw > 0 && vh > 0) {
          lightboxEl.classList.toggle("gv-landscape-video", vw >= vh);
        }
      };
      const onLoadedData = () => {
        if (token !== playerLoadToken) return;
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        clearSourceProbe();
        lastPlaybackTime = Number(playerEl.currentTime || 0);
        stallNoProgressTicks = 0;
        stallRecoveryPasses = 0;
        scheduleProgressWatch();
      };
      const onError = () => {
        if (token !== playerLoadToken) return;
        tryRefreshCurrentPostSources()
          .catch(() => {})
          .finally(() => {
            if (token !== playerLoadToken) return;
            tryFallback();
          });
      };
      const onWaitingOrStalled = () => {
        if (token !== playerLoadToken || !playerEl) return;
        const playPromise = playerEl.play();
        if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
        scheduleSourceProbe();
      };
      playerEl.addEventListener("loadedmetadata", onLoadedMetadata);
      playerEl.addEventListener("loadeddata", onLoadedData);
      playerEl.addEventListener("error", onError);
      playerEl.addEventListener("waiting", onWaitingOrStalled);
      playerEl.addEventListener("stalled", onWaitingOrStalled);
      fallbackTimer = setTimeout(() => {
        if (!playerEl || token !== playerLoadToken) return;
        if (playerEl.readyState < 2) tryFallback();
      }, 950);
      clearPlayerLoadHooks = () => {
        if (!playerEl) return;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        clearMissingSourceRetry();
        clearSourceProbe();
        clearProgressWatch();
        playerEl.removeEventListener("loadedmetadata", onLoadedMetadata);
        playerEl.removeEventListener("loadeddata", onLoadedData);
        playerEl.removeEventListener("error", onError);
        playerEl.removeEventListener("waiting", onWaitingOrStalled);
        playerEl.removeEventListener("stalled", onWaitingOrStalled);
      };
      playerEl.style.display = "";
      playerEl.controls = true;
      playerEl.preload = "auto";
      playerEl.playsInline = true;
      playerEl.setAttribute("fetchpriority", "high");
      applySource(primarySource);
      scheduleSourceProbe();
    }
    updateCount();
    updateActionButtons();
    syncRegenOverlay();
    renderVariantStrip();
    updateLightboxAutoplayIcon();
    prewarmAroundCurrentSelection();
  };

  const toggleAutoAdvance = () => {
    state.autoAdvance = !state.autoAdvance;
    if (state.autoAdvance) state.autoAdvanceAll = false;
    spinAutoplayIcon();
    if (playerEl) {
      playerEl.loop = !state.autoAdvance;
    }
    updateActionButtons();
  };

  const stepVariant = (delta) => {
    if (!isGridMode()) return;
    const group = state.items[state.selectedIndex];
    if (!group || !group.variants || group.variants.length <= 1) return;
    clearAutoAdvanceAllTimer();
    const total = group.variants.length;
    const current = Number.isFinite(group.activeIndex) ? group.activeIndex : 0;
    const next = (current + delta + total) % total;
    group.activeIndex = next;
    loadPlayer();
    renderVariantStrip();
  };

  let autoAdvanceAllTimer = null;
  const clearAutoAdvanceAllTimer = () => {
    if (autoAdvanceAllTimer) {
      clearTimeout(autoAdvanceAllTimer);
      autoAdvanceAllTimer = null;
    }
  };
  // Videos advance on their "ended" event; images have no such event, so when
  // autoplay-all lands on an image variant, advance after a short slideshow delay.
  const scheduleAutoAdvanceAllForImage = () => {
    clearAutoAdvanceAllTimer();
    if (!state.autoAdvanceAll || !isGridMode()) return;
    if (!activeLightboxIsImage()) return;
    autoAdvanceAllTimer = setTimeout(() => {
      autoAdvanceAllTimer = null;
      if (state.autoAdvanceAll && lightboxEl && lightboxEl.classList.contains("open")) {
        stepAutoplayAll();
      }
    }, 3000);
  };

  const stepAutoplayAll = () => {
    if (!isGridMode() || !state.items.length) return;
    const group = state.items[state.selectedIndex];
    let advancedWithinGroup = false;
    if (group && group.variants && group.variants.length > 1) {
      const current = Number.isFinite(group.activeIndex) ? group.activeIndex : 0;
      if (current < group.variants.length - 1) {
        group.activeIndex = current + 1;
        loadPlayer();
        renderVariantStrip();
        advancedWithinGroup = true;
      }
    }
    if (!advancedWithinGroup) {
      state.selectedIndex = (state.selectedIndex + 1 + state.items.length) % state.items.length;
      const nextGroup = state.items[state.selectedIndex];
      if (nextGroup && nextGroup.variants && nextGroup.variants.length > 0) {
        nextGroup.activeIndex = 0;
      }
      loadPlayer();
    }
    scheduleAutoAdvanceAllForImage();
  };

  const toggleAutoAdvanceAll = () => {
    if (!isGridMode() || state.mode === "images") return;
    state.autoAdvanceAll = !state.autoAdvanceAll;
    if (state.autoAdvanceAll) state.autoAdvance = false;
    if (playerEl) playerEl.loop = false;
    if (!state.autoAdvanceAll) clearAutoAdvanceAllTimer();
    else scheduleAutoAdvanceAllForImage();
    updateActionButtons();
  };

  const getCurrentGroup = () => state.items[state.selectedIndex] || null;

  const isNestedGroupActive = () => {
    const group = getCurrentGroup();
    return Boolean(isGridMode() && group && group.variants && group.variants.length > 1);
  };

  const updateLightboxAutoplayIcon = () => {
    if (!autoNextBtn) return;
    const img = autoNextBtn.querySelector("img");
    if (!img) return;
    const icon = isNestedGroupActive() ? "images/autoplay-nidification.svg" : "images/autoplay.svg";
    img.src = chrome.runtime.getURL(icon);
    autoNextBtn.dataset.tooltip = isNestedGroupActive()
      ? "Only this compilation will autoplay"
      : "All your videos will play automatically";
  };

  const updateAutoplayAllIcon = () => {
    if (!autoAllBtn) return;
    autoAllBtn.dataset.tooltip = "All your videos will autoplay";
    const img = autoAllBtn.querySelector("img");
    if (img) img.src = chrome.runtime.getURL("images/autoplay-full.svg");
  };

  const spinAutoplayIcon = () => {
    spinButtonIcon(autoNextBtn);
  };

  const spinPromptIcon = () => {
    spinButtonIcon(promptBtn);
  };

  const spinButtonIcon = (button) => {
    if (!button) return;
    const icon = button.querySelector("img, svg");
    if (!icon) return;
    icon.classList.remove("autoplay-spin");
    void icon.offsetWidth;
    icon.classList.add("autoplay-spin");
    window.setTimeout(() => {
      icon.classList.remove("autoplay-spin");
    }, 500);
  };

  const openNestedGuideModal = () => {
    if (!nestedGuideModal) return;
    nestedGuideModal.classList.add("open");
    nestedGuideModal.setAttribute("aria-hidden", "false");
  };

  const closeNestedGuideModal = () => {
    if (!nestedGuideModal) return;
    nestedGuideModal.classList.remove("open");
    nestedGuideModal.setAttribute("aria-hidden", "true");
  };

  const maybeShowNestedGuide = () => {
    if (!isNestedGroupActive()) return;
    if (state.settings.skipNestedGuide || state.settings.nestedGuideShown) return;
    if (nestedGuideDontRemind) nestedGuideDontRemind.checked = !!state.settings.skipNestedGuide;
    openNestedGuideModal();
  };

  const openNormalGuideModal = () => {
    if (!normalGuideModal) return;
    normalGuideModal.classList.add("open");
    normalGuideModal.setAttribute("aria-hidden", "false");
  };

  const closeNormalGuideModal = () => {
    if (!normalGuideModal) return;
    normalGuideModal.classList.remove("open");
    normalGuideModal.setAttribute("aria-hidden", "true");
  };

  const maybeShowNormalGuide = () => {
    if (isGridMode()) return;
    if (state.settings.skipNormalGuide || state.settings.normalGuideShown) return;
    if (normalGuideDontRemind) normalGuideDontRemind.checked = !!state.settings.skipNormalGuide;
    openNormalGuideModal();
  };

  const openLightbox = (index) => {
    if (!lightboxEl) return;
    ensureMediaPreconnect();
    state.selectedIndex = (index + state.items.length) % state.items.length;
    const group = state.items[state.selectedIndex];
    if (group && group.variants && !Number.isFinite(group.activeIndex)) {
      group.activeIndex = 0;
    }
    state.variantPreviewAutoplay = true;
    lightboxEl.classList.add("open");
    lightboxEl.setAttribute("aria-hidden", "false");
    updateRegenButtonVisual();
    const activePostId = getSelectedRegenPostId();
    if (activePostId) regenState.activePostId = activePostId;
    updateRegenDebugPanel();
    syncRegenOverlay();
    prewarmAroundCurrentSelection();
    loadPlayer();
    const keepNestedRibbon = Boolean(isGridMode() && group && group.variants && group.variants.length > 1);
    if (!keepNestedRibbon) consumeNewGenerationHighlight(group);
    updateLightboxAutoplayIcon();
    if (isGridMode()) {
      maybeShowNestedGuide();
      if (state.mode === "videos") {
        const keepPostId = normalizeId((resolveActiveItem(group) || group).postId);
        hydrateActiveGroupVariantsFromDetails({ keepPostId }).then((changed) => {
          const lightboxOpenNow = Boolean(lightboxEl && lightboxEl.classList.contains("open"));
          if (!changed || !lightboxOpenNow) return;
          loadPlayer();
        });
      }
    } else {
      maybeShowNormalGuide();
    }
  };

  const closeLightbox = () => {
    if (!lightboxEl) return;
    clearAutoAdvanceAllTimer();
    clearLightboxPromptInlineNotice();
    lightboxEl.classList.remove("open");
    lightboxEl.classList.remove("gv-landscape-video");
    lightboxEl.setAttribute("aria-hidden", "true");
    closeNestedGuideModal();
    closeNormalGuideModal();
    if (clearPlayerLoadHooks) {
      try {
        clearPlayerLoadHooks();
      } catch (error) {}
      clearPlayerLoadHooks = null;
    }
    if (playerEl) {
      playerEl.pause();
      playerEl.removeAttribute("src");
      playerEl.load();
    }
    if (imageEl) {
      imageEl.style.display = "none";
      imageEl.removeAttribute("src");
    }
    if (lightboxHdTag) lightboxHdTag.classList.remove("show");
    setRegenOverlayVisible(false);
    hideRegenNotice();
    updateRegenDebugPanel();
  };

  const step = (delta) => {
    if (!state.items.length) return;
    clearAutoAdvanceAllTimer();
    state.selectedIndex = (state.selectedIndex + delta + state.items.length) % state.items.length;
    loadPlayer();
  };

  const startLogTimer = () => {};

  const stopLogTimer = () => {};

  const toggleLogs = () => {};


  const initHideModToastToggle = () => {
    if (!hideModToastToggle) return;
    chrome.storage.local.get("gvHideModerationToast", (data) => {
      const enabled = Boolean(data && data.gvHideModerationToast);
      hideModToastToggle.classList.toggle("active", enabled);
      hideModToastToggle.setAttribute("aria-pressed", enabled ? "true" : "false");
      hideModToastToggle.textContent = enabled ? "Toast hidden" : "Hide moderation toast";
    });
  };

const initHideModToastTooltip = () => {};

  const initUI = async () => {
    debug("initUI start");
    const response = await fetch(chrome.runtime.getURL("embed.html"));
    debug("embed fetch response", { ok: response.ok, status: response.status });
    if (!response.ok) {
      throw new Error(`embed-fetch-failed-${response.status}`);
    }
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script").forEach((script) => script.remove());
    const style = doc.querySelector("style");
    const body = doc.body;
    if (!body) {
      throw new Error("embed-body-missing");
    }

    const overlay = document.createElement("div");
    overlay.id = "gv-overlay";
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 999999;
      background: #0b0f16;
      display: flex;
      justify-content: center;
      align-items: stretch;
      overflow: hidden;
    `;

    const host = document.createElement("div");
    host.id = "gv-root";
    host.style.cssText = "width: 100%; max-width: 1200px;";
    overlay.appendChild(host);
    document.body.appendChild(overlay);
    debug("overlay attached", { hasBody: Boolean(document.body) });

    const shadow = host.attachShadow({ mode: "open" });
    if (style) {
      const styleEl = document.createElement("style");
      const rawCss = style.textContent || "";
      const cssWithHost = rawCss.replace(/\bbody\b/g, ":host");
      styleEl.textContent = cssWithHost.replace(/url\((['"]?)(images\/[^'")]+)\1\)/g, (match, quote, path) => {
        const resolved = chrome.runtime.getURL(path);
        const q = quote || "";
        return `url(${q}${resolved}${q})`;
      });
      shadow.appendChild(styleEl);
    }
    const container = document.createElement("div");
    container.innerHTML = body.innerHTML;
    container.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") || "";
      if (!src) return;
      if (src.startsWith("chrome-extension://") || src.startsWith("http") || src.startsWith("data:")) return;
      const cleaned = src.startsWith("/") ? src.slice(1) : src;
      img.src = chrome.runtime.getURL(cleaned);
    });
    shadow.appendChild(container);

    root = shadow;
    appEl = shadow.querySelector(".app");
    footerEl = shadow.querySelector(".footer");
    brandTitleEl = shadow.querySelector("#brandTitleText");
    viewModeBtn = shadow.querySelector("#viewModeBtn");
    viewModeIcon = shadow.querySelector("#viewModeIcon");
    viewModeLabel = shadow.querySelector("#viewModeLabel");
    statusEl = shadow.querySelector("#status");
    gridEl = shadow.querySelector("#grid");
    emptyEl = shadow.querySelector("#empty");
    countEl = shadow.querySelector("#count");
    thumbAutoplayBtn = shadow.querySelector("#thumbAutoplayBtn");
    sortBtn = shadow.querySelector("#sortBtn");
    refreshBtn = shadow.querySelector("#refreshBtn");
    downloadAllBtn = shadow.querySelector("#downloadAllBtn");
    deleteAllBtn = shadow.querySelector("#deleteAllBtn");
    deleteCheckedBtn = shadow.querySelector("#deleteCheckedBtn");
    downloadCheckedBtn = shadow.querySelector("#downloadCheckedBtn");
    checkAllBtn = shadow.querySelector("#checkAllBtn");
    tabVideosBtn = shadow.querySelector("#tabVideos");
    tabImagesBtn = shadow.querySelector("#tabImages");
    prevPageBtn = shadow.querySelector("#prevPageBtn");
    nextPageBtn = shadow.querySelector("#nextPageBtn");
    pageInfoEl = shadow.querySelector("#pageInfo");
    lastPageBtn = shadow.querySelector("#lastPageBtn");
    firstPageBtn = shadow.querySelector("#firstPageBtn");
    pageJumpBtn = shadow.querySelector("#pageJumpBtn");
    downloadReadyEl = shadow.querySelector("#downloadReady");
    regenCreatedNoticeEl = shadow.querySelector("#regenCreatedNotice");
    if (downloadReadyEl) {
      downloadReadyEl.onclick = () => {
        openDownloadsFolder(lastDownloadFilename);
      };
    }
    downloadReadyAudio = new Audio(chrome.runtime.getURL("audio/1.mp3"));
    regenCreatedAudio = new Audio(chrome.runtime.getURL("audio/regeneration.mp3"));
    promptCopyAudio = new Audio(chrome.runtime.getURL("audio/prompt.mp3"));
    promptErrorAudio = new Audio(chrome.runtime.getURL("audio/wrong.wav"));
    downloadClickAudio = new Audio(chrome.runtime.getURL("audio/download.mp3"));
    shareClickAudio = new Audio(chrome.runtime.getURL("audio/share.mp3"));
    closeClickAudio = new Audio(chrome.runtime.getURL("audio/close.mp3"));
    logsBtn = shadow.querySelector("#logsBtn");
    logsPanel = shadow.querySelector("#logsPanel");
    logsBody = shadow.querySelector("#logsBody");
    clearLogsBtn = shadow.querySelector("#clearLogsBtn");
    purgeBtn = shadow.querySelector("#purgeBtn");
    hideModToastToggle = shadow.querySelector("#hideModToastWrap");
    hideModToastWrap = hideModToastToggle;
    logsCloseBtn = shadow.querySelector("#logsCloseBtn");
    lightboxEl = shadow.querySelector("#lightbox");
    lightboxCountEl = shadow.querySelector("#lightboxCount");
    closeBtn = shadow.querySelector("#closeBtn");
    fullscreenBtn = shadow.querySelector("#fullscreenBtn");
    lightboxHdTag = shadow.querySelector("#lightboxHdTag");
    downloadBtn = shadow.querySelector("#downloadBtn");
    shareBtn = shadow.querySelector("#shareBtn");
    deleteBtn = shadow.querySelector("#deleteBtn");
    promptBtn = shadow.querySelector("#promptBtn");
    regenBtn = shadow.querySelector("#regenBtn");
    autoNextBtn = shadow.querySelector("#autoNextBtn");
    downloadGroupBtn = shadow.querySelector("#downloadGroupBtn");
    autoAllBtn = shadow.querySelector("#autoAllBtn");
    prevBtn = shadow.querySelector("#prevBtn");
    nextBtn = shadow.querySelector("#nextBtn");
    playerEl = shadow.querySelector("#player");
    regenOverlayEl = shadow.querySelector("#regenOverlay");
    regenProgressTextEl = shadow.querySelector("#regenProgressText");
    regenProgressFillEl = shadow.querySelector("#regenProgressFill");
    regenStopBtn = shadow.querySelector("#regenStopBtn");
    regenNoticeEl = shadow.querySelector("#regenNotice");
    regenNoticeTextEl = shadow.querySelector("#regenNoticeText");
    regenNoticeCloseBtn = shadow.querySelector("#regenNoticeClose");
    regenDebugEl = shadow.querySelector("#regenDebug");
    regenDebugBodyEl = shadow.querySelector("#regenDebugBody");
    variantWrapEl = shadow.querySelector("#variantWrap");
    variantStripEl = shadow.querySelector("#variantStrip");
    variantAutoplayStopBtn = shadow.querySelector("#variantAutoplayStopBtn");
    variantDeleteCompilationBtn = shadow.querySelector("#variantDeleteCompilationBtn");
    variantMoreBtn = shadow.querySelector("#variantMoreBtn");
    const playerBox = shadow.querySelector(".gv-player-box");
    if (playerBox) {
      const img = document.createElement("img");
      img.id = "imagePlayer";
      img.alt = "Generated image";
      img.style.cssText = "display:none;border-radius:18px;";
      img.addEventListener("dblclick", () => {
        if (!activeLightboxIsImage() || !imageEl) return;
        if (document.fullscreenElement) return;
        if (imageEl.requestFullscreen) {
          imageEl.requestFullscreen().catch(() => {});
        }
      });
      playerBox.appendChild(img);
      imageEl = img;
    }
    toastEl = shadow.querySelector("#toast");
    toastText = shadow.querySelector("#toastText");
    githubBtn = shadow.querySelector("#githubBtn");
    changelogModal = shadow.querySelector("#changelogModal");
    changelogClose = shadow.querySelector("#changelogClose");
    changelogGithub = shadow.querySelector("#changelogGithub");
    settingsModal = shadow.querySelector("#settingsModal");
    settingsClose = shadow.querySelector("#settingsClose");
    settingsBtn = shadow.querySelector("#settingsBtn");
    dlModeAsk = shadow.querySelector("#dlModeAsk");
    dlModeFolder = shadow.querySelector("#dlModeFolder");
    dlModeAuto = shadow.querySelector("#dlModeAuto");
    dlModeFolderRow = shadow.querySelector("#dlModeFolderRow");
    folderHintEl = shadow.querySelector("#folderHint");
    changeFolderBtn = shadow.querySelector("#changeFolderBtn");
    bulk32Btn = shadow.querySelector("#bulk32Btn");
    bulk64Btn = shadow.querySelector("#bulk64Btn");
    bulk120Btn = shadow.querySelector("#bulk120Btn");
    bulk500Btn = shadow.querySelector("#bulk500Btn");
    autoRefreshAlwaysCheck = shadow.querySelector("#autoRefreshAlways");
    duplicateModal = shadow.querySelector("#duplicateModal");
    duplicateClose = shadow.querySelector("#duplicateClose");
    duplicateMessageEl = shadow.querySelector("#duplicateMessage");
    duplicateTimerEl = shadow.querySelector("#duplicateTimer");
    duplicateYesBtn = shadow.querySelector("#duplicateYesBtn");
    duplicateNoBtn = shadow.querySelector("#duplicateNoBtn");
    promptChoiceModal = shadow.querySelector("#promptChoiceModal");
    promptChoiceClose = shadow.querySelector("#promptChoiceClose");
    promptChoiceCopyBtn = shadow.querySelector("#promptChoiceCopyBtn");
    promptChoiceDownloadBtn = shadow.querySelector("#promptChoiceDownloadBtn");
    nestedGuideModal = shadow.querySelector("#nestedGuideModal");
    nestedGuideOkBtn = shadow.querySelector("#nestedGuideOkBtn");
    nestedGuideDontRemind = shadow.querySelector("#nestedGuideDontRemind");
    normalGuideModal = shadow.querySelector("#normalGuideModal");
    normalGuideOkBtn = shadow.querySelector("#normalGuideOkBtn");
    normalGuideDontRemind = shadow.querySelector("#normalGuideDontRemind");
    viewModeModal = shadow.querySelector("#viewModeModal");
    modeGridBtn = shadow.querySelector("#modeGridBtn");
    modeNormalBtn = shadow.querySelector("#modeNormalBtn");
    modeDownloadSettingsBtn = shadow.querySelector("#modeDownloadSettingsBtn");
    modeSetupDoneDot = shadow.querySelector("#modeSetupDoneDot");
    modeDontRemind = shadow.querySelector("#modeDontRemind");
    if (viewModeModal) viewModeModal.setAttribute("inert", "");
    downloadProgressEl = shadow.querySelector("#downloadProgress");
    downloadProgressText = shadow.querySelector("#downloadProgressText");
    downloadProgressFill = shadow.querySelector("#downloadProgressFill");
    progressStopBtn = shadow.querySelector("#progressStopBtn");
    deleteDoneEl = shadow.querySelector("#deleteDone");
    floatingTooltip = shadow.querySelector("#floatingTooltip");
    setRegenOverlayVisible(false);
    if (regenProgressFillEl) regenProgressFillEl.style.setProperty("--regen-pct", "0");
    if (regenProgressTextEl) regenProgressTextEl.textContent = "0%";
    updateRegenDebugPanel();

    if (refreshBtn) refreshBtn.onclick = refreshCurrentPage;
    if (downloadAllBtn) downloadAllBtn.onclick = downloadAll;
    if (progressStopBtn) {
      progressStopBtn.onclick = () => {
        requestProgressCancel();
      };
    }
    if (deleteAllBtn) deleteAllBtn.onclick = deleteAllVideos;
    if (deleteCheckedBtn) deleteCheckedBtn.onclick = deleteCheckedItems;
    if (downloadCheckedBtn) downloadCheckedBtn.onclick = downloadCheckedItems;
    if (checkAllBtn) checkAllBtn.onclick = toggleCheckAllCurrentPage;
    if (downloadGroupBtn)
      downloadGroupBtn.onclick = () => {
        spinButtonIcon(downloadGroupBtn);
        downloadGroup();
      };
    if (gridEl) {
      gridEl.addEventListener("mouseover", (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const tooltipNode = target.closest(".icon-btn, .downloaded-badge");
        if (!tooltipNode || !gridEl.contains(tooltipNode)) return;
        if (tooltipNode.classList.contains("icon-btn") && !tooltipNode.closest(".thumb-actions")) return;
        const text = tooltipNode.getAttribute("data-tooltip") || "";
        if (!text) return;
        showFloatingTooltip(text, tooltipNode, "bottom");
      });
      gridEl.addEventListener("mouseout", (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const tooltipNode = target.closest(".icon-btn, .downloaded-badge");
        if (!tooltipNode) return;
        const related = event.relatedTarget;
        if (related instanceof Element && tooltipNode.contains(related)) return;
        hideFloatingTooltip();
      });
      gridEl.addEventListener("scroll", () => hideFloatingTooltip());
    }
    if (prevPageBtn) {
      prevPageBtn.onclick = () => {
        const mode = state.mode;
        const current = state.pageByMode[mode] || 0;
        const next = Math.max(0, current - 1);
        state.pageByMode[mode] = next;
        ensurePageData(mode, next);
      };
    }
    if (firstPageBtn) {
      firstPageBtn.onclick = () => {
        const mode = state.mode;
        state.pageByMode[mode] = 0;
        ensurePageData(mode, 0);
      };
    }
    if (nextPageBtn) {
      nextPageBtn.onclick = () => {
        const mode = state.mode;
        const current = state.pageByMode[mode] || 0;
        const next = current + 1;
        state.pageByMode[mode] = next;
        ensurePageData(mode, next);
      };
    }
    if (lastPageBtn) {
      lastPageBtn.onclick = () => {
        goToLastPage();
      };
    }
    if (pageJumpBtn) {
      pageJumpBtn.onclick = () => {
        const pageCount = getPageCount(state.mode);
        const value = window.prompt(`Go to page (1-${pageCount})`);
        if (!value) return;
        const cleaned = String(value).trim();
        if (!/^[0-9]+$/.test(cleaned)) {
          showToast("Invalid page", "error");
          return;
        }
        const pageNum = Number(cleaned);
        if (!Number.isFinite(pageNum) || pageNum < 1 || pageNum > pageCount) {
          showToast("Invalid page", "error");
          return;
        }
        const target = pageNum - 1;
        state.pageByMode[state.mode] = target;
        ensurePageData(state.mode, target);
      };
    }
    if (variantMoreBtn && variantStripEl) {
      variantMoreBtn.onclick = () => {
        variantStripEl.scrollBy({ top: 64, behavior: "smooth" });
      };
    }
    if (variantAutoplayStopBtn) {
      variantAutoplayStopBtn.onclick = () => {
        state.variantPreviewAutoplay = !state.variantPreviewAutoplay;
        applyVariantPreviewAutoplayState();
      };
    }
    if (variantDeleteCompilationBtn) {
      variantDeleteCompilationBtn.onclick = () => {
        deleteWholeCompilation();
      };
    }
    if (gridEl) {
      gridEl.addEventListener("click", (event) => {
        const checkBox = event.target && event.target.closest ? event.target.closest(".thumb-check") : null;
        if (checkBox && gridEl.contains(checkBox)) {
          event.preventDefault();
          event.stopPropagation();
          const postId = checkBox.dataset.postId || "";
          if (!postId) return;
          if (state.selectedPostIds.has(postId)) {
            state.selectedPostIds.delete(postId);
            checkBox.classList.remove("checked");
            checkBox.setAttribute("aria-checked", "false");
            const t = checkBox.closest(".thumb");
            if (t) t.classList.remove("selected");
          } else {
            state.selectedPostIds.add(postId);
            checkBox.classList.add("checked");
            checkBox.setAttribute("aria-checked", "true");
            const t = checkBox.closest(".thumb");
            if (t) t.classList.add("selected");
          }
          updateDeleteCheckedButton();
          return;
        }
        const actionBtn = event.target && event.target.closest ? event.target.closest("button.icon-btn") : null;
        if (actionBtn && gridEl.contains(actionBtn)) {
          event.preventDefault();
          event.stopPropagation();
          const index = Number(actionBtn.dataset.index || "-1");
          const item = state.items[index];
          if (!item || state.busy) return;
          const action = actionBtn.dataset.action || "";
          spinButtonIcon(actionBtn);
          if (action === "delete") deleteItem(item);
          if (action === "prompt") handlePromptItem(item, { source: "thumb", trigger: actionBtn });
          if (action === "download-videos") {
            playActionAudio("download");
            downloadAllVideosForItem(item);
          }
          if (action === "delete-videos") {
            deleteAllVideosForItem(item);
          }
          return;
        }
        const thumbBtn = event.target && event.target.closest ? event.target.closest(".thumb") : null;
        if (thumbBtn && gridEl.contains(thumbBtn)) {
          event.preventDefault();
          const index = Number(thumbBtn.dataset.index || "-1");
          if (Number.isFinite(index) && index >= 0) openLightbox(index);
        }
      });
      gridEl.addEventListener("keydown", (event) => {
        const actionBtn = event.target && event.target.closest ? event.target.closest("button.icon-btn") : null;
        if (actionBtn && gridEl.contains(actionBtn)) return;
        const thumb = event.target && event.target.closest ? event.target.closest(".thumb") : null;
        if (!thumb || !gridEl.contains(thumb)) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        const index = Number(thumb.dataset.index || "-1");
        if (Number.isFinite(index) && index >= 0) openLightbox(index);
      });
    }
    if (thumbAutoplayBtn) {
      thumbAutoplayBtn.onclick = () => {
        state.thumbAutoplay = !state.thumbAutoplay;
        applyModeUI();
        renderGrid();
        updateActionButtons();
      };
    }
    if (sortBtn) {
      sortBtn.onclick = () => {
        state.sortOrder = state.sortOrder === "asc" ? "desc" : "asc";
        state.groupOrder = new Map();
        state.groupLatest = new Map();
        invalidateGroupsMemo();
        state.items = computeCurrentItems();
        applyModeUI();
        renderGrid();
        updateCount();
        updateActionButtons();
      };
    }
    if (purgeBtn) {
      purgeBtn.onclick = () => purgeCache();
    }
    if (tabVideosBtn) tabVideosBtn.onclick = () => setMode("videos");
    if (tabImagesBtn) tabImagesBtn.onclick = () => setMode("images");
    if (hideModToastToggle) {
      hideModToastToggle.onclick = () => {
        const enabled = !hideModToastToggle.classList.contains("active");
        hideModToastToggle.classList.toggle("active", enabled);
        hideModToastToggle.setAttribute("aria-pressed", enabled ? "true" : "false");
        hideModToastToggle.textContent = enabled ? "Toast hidden" : "Hide moderation toast";
        chrome.storage.local.set({ gvHideModerationToast: enabled });
        chrome.runtime.sendMessage({ action: "grokViewerSetHideModToast", enabled });
      };
    }
    if (downloadBtn)
      downloadBtn.onclick = () => {
        spinButtonIcon(downloadBtn);
        playActionAudio("download");
        downloadOne();
      };
    if (shareBtn)
      shareBtn.onclick = () => {
        const item = state.items[state.selectedIndex];
        spinButtonIcon(shareBtn);
        playActionAudio("share");
        if (item) shareItem(item);
      };
    if (deleteBtn)
      deleteBtn.onclick = () => {
        spinButtonIcon(deleteBtn);
        deleteOne();
      };
    if (promptBtn)
      promptBtn.onclick = () => {
        const item = state.items[state.selectedIndex];
        if (!item) return;
        spinPromptIcon();
        handlePromptItem(item, { source: "lightbox", trigger: promptBtn });
      };
    if (regenBtn)
      regenBtn.onclick = () => {
        startRegeneration();
      };
    if (regenStopBtn)
      regenStopBtn.onclick = () => {
        stopRegeneration("Stop pressed");
      };
    if (regenNoticeCloseBtn) {
      regenNoticeCloseBtn.onclick = () => hideRegenNotice();
    }
    if (autoNextBtn)
      autoNextBtn.onclick = () => {
        spinButtonIcon(autoNextBtn);
        toggleAutoAdvance();
      };
    if (autoAllBtn)
      autoAllBtn.onclick = () => {
        spinButtonIcon(autoAllBtn);
        toggleAutoAdvanceAll();
      };
    if (githubBtn) {
      githubBtn.onclick = () => {
        openChangelogModal();
      };
    }
    if (settingsBtn) settingsBtn.onclick = () => openSettingsModal();
    if (settingsClose) settingsClose.onclick = () => closeSettingsModal();
    if (settingsModal) {
      settingsModal.addEventListener("click", (event) => {
        if (event.target === settingsModal) closeSettingsModal();
      });
    }
    if (duplicateClose) duplicateClose.onclick = () => hideDuplicateModal();
    if (duplicateYesBtn) {
      duplicateYesBtn.onclick = () => {
        if (duplicateAskActive && duplicateAskResolver) {
          const resolver = duplicateAskResolver;
          duplicateAskResolver = null;
          duplicateAskActive = false;
          resolver(true);
        }
        hideDuplicateModal();
      };
    }
    if (duplicateNoBtn) {
      duplicateNoBtn.onclick = () => {
        if (duplicateAskActive && duplicateAskResolver) {
          const resolver = duplicateAskResolver;
          duplicateAskResolver = null;
          duplicateAskActive = false;
          resolver(false);
        }
        hideDuplicateModal();
      };
    }
    if (duplicateModal) {
      duplicateModal.addEventListener("click", (event) => {
        if (event.target === duplicateModal) hideDuplicateModal();
      });
    }
    if (promptChoiceClose) {
      promptChoiceClose.onclick = () => {
        closePromptChoiceModal(null);
      };
    }
    if (promptChoiceCopyBtn) {
      promptChoiceCopyBtn.onclick = () => {
        closePromptChoiceModal("copy");
      };
    }
    if (promptChoiceDownloadBtn) {
      promptChoiceDownloadBtn.onclick = () => {
        closePromptChoiceModal("download");
      };
    }
    if (promptChoiceModal) {
      promptChoiceModal.addEventListener("click", (event) => {
        if (event.target === promptChoiceModal) closePromptChoiceModal(null);
      });
    }
    if (nestedGuideOkBtn) {
      nestedGuideOkBtn.onclick = () => {
        state.settings.nestedGuideShown = true;
        if (nestedGuideDontRemind && nestedGuideDontRemind.checked) {
          state.settings.skipNestedGuide = true;
        }
        persistSettings();
        closeNestedGuideModal();
      };
    }
    if (nestedGuideModal) {
      nestedGuideModal.addEventListener("click", (event) => {
        if (event.target !== nestedGuideModal) return;
        state.settings.nestedGuideShown = true;
        persistSettings();
        closeNestedGuideModal();
      });
    }
    if (normalGuideOkBtn) {
      normalGuideOkBtn.onclick = () => {
        state.settings.normalGuideShown = true;
        if (normalGuideDontRemind && normalGuideDontRemind.checked) {
          state.settings.skipNormalGuide = true;
        }
        persistSettings();
        closeNormalGuideModal();
      };
    }
    if (normalGuideModal) {
      normalGuideModal.addEventListener("click", (event) => {
        if (event.target !== normalGuideModal) return;
        state.settings.normalGuideShown = true;
        persistSettings();
        closeNormalGuideModal();
      });
    }
    const dlModeAskRow = dlModeAsk && dlModeAsk.closest ? dlModeAsk.closest(".settings-row") : null;
    const dlModeAutoRow = dlModeAuto && dlModeAuto.closest ? dlModeAuto.closest(".settings-row") : null;
    if (dlModeAsk) {
      dlModeAsk.onchange = () => {
        setDownloadMode("ask_each");
      };
    }
    if (dlModeAuto) {
      dlModeAuto.onchange = () => {
        setDownloadMode("default_auto");
      };
    }
    if (dlModeFolder) {
      dlModeFolder.onchange = async () => {
        await setDownloadMode("folder_once");
      };
    }
    if (dlModeAskRow) {
      dlModeAskRow.onclick = (event) => {
        const target = event.target;
        if (target && target.closest && target.closest("input.settings-check")) return;
        setDownloadMode("ask_each");
      };
    }
    if (dlModeAutoRow) {
      dlModeAutoRow.onclick = (event) => {
        const target = event.target;
        if (target && target.closest && target.closest("input.settings-check")) return;
        setDownloadMode("default_auto");
      };
    }
    if (dlModeFolderRow) {
      dlModeFolderRow.onclick = async (event) => {
        const target = event.target;
        if (target && target.closest && target.closest("#changeFolderBtn")) return;
        if (target && target.closest && target.closest("input.settings-check")) return;
        await setDownloadMode("folder_once");
      };
    }
    if (changeFolderBtn) {
      changeFolderBtn.onclick = async () => {
        const ok = await pickFolderAndEnableMode(true);
        if (!ok) {
          setStatus("Folder selection canceled.");
          return;
        }
      };
    }
    if (bulk32Btn) bulk32Btn.onclick = () => setBulkTarget(32);
    if (bulk64Btn) bulk64Btn.onclick = () => setBulkTarget(64);
    if (bulk120Btn) bulk120Btn.onclick = () => setBulkTarget(120);
    if (bulk500Btn) bulk500Btn.onclick = () => setBulkTarget(500);
    if (autoRefreshAlwaysCheck) {
      autoRefreshAlwaysCheck.onchange = () => {
        state.settings.autoRefreshAlways = !!autoRefreshAlwaysCheck.checked;
        persistSettings();
        updateSettingsUI();
        updateAutoRefreshLoop();
      };
    }
    if (changelogClose) changelogClose.onclick = closeChangelogModal;
    if (changelogModal) {
      changelogModal.onclick = (event) => {
        if (event.target === changelogModal) closeChangelogModal();
      };
    }
    if (changelogGithub) {
      changelogGithub.onclick = () => {
        window.open("https://github.com/exabeet/grok-viewer", "_blank", "noopener");
      };
    }
    if (modeGridBtn) {
      modeGridBtn.onclick = () => {
        setViewMode("grid", true);
        hideViewModeModal();
      };
    }
    if (modeNormalBtn) {
      modeNormalBtn.onclick = () => {
        setViewMode("normal", true);
        hideViewModeModal();
      };
    }
    if (modeDownloadSettingsBtn) {
      modeDownloadSettingsBtn.onclick = async () => {
        state.settings.downloadSettingsGuideDone = true;
        persistSettings();
        updateModeSetupDoneUI();
        const response = await openDownloadSettingsPage();
        if (!response || !response.ok) {
          setStatus("Open browser download settings manually.");
        }
      };
    }
    if (modeDontRemind) {
      modeDontRemind.checked = !!state.settings.skipIntroModal;
      modeDontRemind.onchange = () => {
        state.settings.skipIntroModal = !!modeDontRemind.checked;
        persistSettings();
      };
    }
    if (viewModeBtn) {
      viewModeBtn.onclick = () => {
        const next = state.viewMode === "grid" ? "normal" : "grid";
        setViewMode(next, true);
      };
    }
    if (viewModeModal) {
      viewModeModal.onclick = (event) => {
        if (event.target === viewModeModal) return;
      };
    }
    if (closeBtn) closeBtn.onclick = closeLightbox;
    if (fullscreenBtn) {
      fullscreenBtn.onclick = () => {
        spinButtonIcon(fullscreenBtn);
        const targetEl = activeLightboxIsImage() ? imageEl : playerEl;
        if (!targetEl) return;
        const isFullscreen = document.fullscreenElement;
        if (isFullscreen) {
          document.exitFullscreen().catch(() => {});
          return;
        }
        if (targetEl.requestFullscreen) {
          targetEl.requestFullscreen().catch(() => {});
        }
      };
    }
    if (prevBtn) prevBtn.onclick = () => step(-1);
    if (nextBtn) nextBtn.onclick = () => step(1);
    if (playerEl) {
      playerEl.addEventListener("ended", () => {
        if (activeLightboxIsImage()) return;
        if (isGridMode() && state.autoAdvanceAll) {
          stepAutoplayAll();
          return;
        }
        if (!state.autoAdvance) return;
        if (isNestedGroupActive()) {
          stepVariant(1);
          return;
        }
        step(1);
      });
    }
    if (lightboxEl) {
      lightboxEl.onclick = (event) => {
        if (event.target === lightboxEl) closeLightbox();
      };
    }

    document.addEventListener("keydown", (event) => {
      if (changelogModal && changelogModal.classList.contains("open") && event.key === "Escape") {
        closeChangelogModal();
        return;
      }
      if (promptChoiceModal && promptChoiceModal.classList.contains("open")) {
        if (event.key === "Escape") {
          event.preventDefault();
          closePromptChoiceModal(null);
        }
        return;
      }
      if (!lightboxEl || !lightboxEl.classList.contains("open")) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        step(-1);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        step(1);
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        stepVariant(1);
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        stepVariant(-1);
      }
      if (event.key === "Escape") closeLightbox();
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        if (activeLightboxIsImage()) return;
        if (!playerEl) return;
        if (playerEl.paused) {
          const playPromise = playerEl.play();
          if (playPromise && typeof playPromise.catch === "function") {
            playPromise.catch(() => {});
          }
        } else {
          playerEl.pause();
        }
      }
    });

    initHideModToastToggle();
    initHideModToastTooltip();
    await loadSettings();
    await loadDownloadedLookup();
    updateSettingsUI();
    updateAutoRefreshLoop();
    updateModeSetupDoneUI();
    setReadyStatus();
    applyModeUI();
    updatePager();
    chrome.storage.local.get([STORAGE_KEY, VIEW_MODE_KEY], (data) => {
      const storedMode = data && data[VIEW_MODE_KEY] ? data[VIEW_MODE_KEY] : "";
      if (storedMode === "grid" || storedMode === "normal") {
        state.viewMode = storedMode;
        if (brandTitleEl) {
          brandTitleEl.textContent = state.viewMode === "grid" ? "Grok-Viewer Grid" : "Grok-Viewer";
        }
        if (viewModeIcon) {
          const icon = state.viewMode === "grid" ? "images/grid.svg" : "images/normal.svg";
          const alt = state.viewMode === "grid" ? "Grid view" : "Normal view";
          viewModeIcon.src = chrome.runtime.getURL(icon);
          viewModeIcon.alt = alt;
        }
        if (viewModeBtn) {
          viewModeBtn.dataset.tooltip = state.viewMode === "grid" ? "Return to normal mode" : "Return to Grid mode";
        }
      }
      if (modeDontRemind) modeDontRemind.checked = !!state.settings.skipIntroModal;
      if (state.settings.skipIntroModal) hideViewModeModal();
      else showViewModeModal();
      const cached = data && data[STORAGE_KEY] ? data[STORAGE_KEY] : null;
      const cachedItems = cached && Array.isArray(cached.items) ? cached.items : [];
      if (cachedItems.length) {
        const modeState = getModeState("videos");
        const pageItems = dedupeItems(cachedItems)
          .slice(0, state.pageSize)
          .map((item) => minimizeVideoItem(item))
          .filter((item) => ensurePlayableVideoItem(item))
          .filter(Boolean);
        modeState.pageCache.set(0, pageItems);
        pageItems.forEach((item) => {
          const keys = getVideoDedupKeys(item);
          keys.forEach((key) => {
            if (key) modeState.seen.add(key);
          });
        });
        modeState.totalLoaded = pageItems.length;
        modeState.maxPageLoaded = pageItems.length ? 0 : -1;
        invalidateGroupsMemo("videos");
        updateItems();
        setReadyStatus();
      }
      debug("starting refresh from cache", { cachedCount: cachedItems.length });
      refresh();
    });
    debug("initUI setup complete");
  };

  try {
    window.__gvDebug = {
      state,
      computeAllGroupsForMode,
      computeAllUnifiedItems,
      computeCurrentItems,
      getModeState,
      invalidateGroupsMemo,
      groupItems,
      dedupeImageItems,
      sortByCreatedAt,
      groupsMemoStamp,
      groupsMemoFor,
      groupsMemoResult
    };
  } catch (error) {}

  initUI()
    .then(() => {
      debug("initUI resolved");
    })
    .catch((error) => {
      const message = String((error && error.message) || error || "unknown-init-error");
      debugError("initUI failed", { message });
      showFatalDebugOverlay(`initUI failed: ${message}`);
    });
})();

import { LS_KEY } from "./constants.js";

// ── Mutable app state ──
// Exported as a live binding — modules that import `state` always see the current value.
// Use `setState(newState)` to replace the entire state object.

export let state = null;
export let sharedData = { projects: [], songs: [], invites: [], myProjects: [], mySongs: [], loaded: false };

export function setState(newState) {
  state = newState;
}

export function setSharedData(newData) {
  sharedData = newData;
}

export function loadState() {
  const raw = localStorage.getItem(LS_KEY);
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }
  return {
    version: 1,
    settings: {
      defaultProject: "",
      defaultGenre: "Metalcore",
      defaultSprint: "Unsorted",
      lyricsScratch: ""
    },
    songs: [],
    quickLog: [],
  };
}

export function normalizeState() {
  state.settings = state.settings || {};
  state.songs = Array.isArray(state.songs) ? state.songs : [];
  state.quickLog = Array.isArray(state.quickLog) ? state.quickLog : [];
  state.releases = Array.isArray(state.releases) ? state.releases : [];
  state.songs.forEach((song) => {
    song.versions = Array.isArray(song.versions) ? song.versions : [];
    song.versions.forEach((v) => {
      if (typeof v.isActive !== "boolean") v.isActive = false;
      // Local file support
      if (v.fileId === undefined) v.fileId = null;
      if (v.fileName === undefined) v.fileName = "";
      if (v.fileType === undefined) v.fileType = "";
      if (v.fileSize === undefined) v.fileSize = 0;

      if (v.localAudioId === undefined) v.localAudioId = null;
      if (v.originalFileName === undefined) v.originalFileName = "";
      // Supabase cloud storage
      if (v.driveFileId && !v.audioPath) v.audioPath = null; // migrate: driveFileId no longer used
      if (v.audioPath === undefined) v.audioPath = null;
      // Player playlist flags
      if (typeof v.playerYes !== "boolean") v.playerYes = false;
      if (typeof v.favorite !== "boolean") v.favorite = false;
    });
    // Enforce exactly one active version
    const activeVs = song.versions.filter(v => v.isActive);
    if (activeVs.length === 0 && song.versions.length) {
      // None active — pick most recently updated
      const newest = song.versions.reduce((a, b) =>
        new Date(a.updatedAt || a.createdAt || 0) >= new Date(b.updatedAt || b.createdAt || 0) ? a : b
      );
      newest.isActive = true;
    } else if (activeVs.length > 1) {
      // Multiple active — keep most recently updated, clear the rest
      const newest = activeVs.reduce((a, b) =>
        new Date(a.updatedAt || a.createdAt || 0) >= new Date(b.updatedAt || b.createdAt || 0) ? a : b
      );
      song.versions.forEach(v => { v.isActive = (v.id === newest.id); });
    }
    if (song.coverImageUrl === undefined) song.coverImageUrl = null;
    // Migrate coverDriveFileId → coverPath
    if (song.coverDriveFileId && !song.coverPath) song.coverPath = null;
    if (song.coverPath === undefined) song.coverPath = null;
    // User-uploaded cover art
    if (song.userCoverImageUrl === undefined) song.userCoverImageUrl = null;
    if (song.userCoverPath === undefined) song.userCoverPath = null;
    if (!song.coverSource) song.coverSource = song.userCoverPath ? "user" : "ai";
  });
  // Projects (persisted independently of songs)
  state.projects = Array.isArray(state.projects) ? state.projects : [];

  // Player state (queue)
  state.player = state.player || {};
  state.player.queue = Array.isArray(state.player.queue) ? state.player.queue : [];
  state.player.repeatQueue = Array.isArray(state.player.repeatQueue) ? state.player.repeatQueue : [];
  state.player.nowPlaying = state.player.nowPlaying || null;

  // Playback toggles (persisted)
  if (typeof state.player.shuffle !== "boolean") state.player.shuffle = false;
  if (state.player.repeat !== true && state.player.repeat !== "one") state.player.repeat = false;
}

export function ensureProjectInState(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return;
  if (!state.projects.includes(trimmed)) {
    state.projects.push(trimmed);
  }
}

// ── saveState with injectable sync ──
let _syncFn = null;
let _importQueueRunningFn = null;

export function initStateSave({ syncFn, importQueueRunningFn }) {
  _syncFn = syncFn;
  _importQueueRunningFn = importQueueRunningFn;
}

export function saveState() {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
  // Auto-sync to Supabase (debounced) — skip during bulk import to avoid
  // partial pushes that can trigger realtime sync and delete un-pushed songs.
  // The import loop does its own explicit push at the end.
  const importRunning = _importQueueRunningFn ? _importQueueRunningFn() : false;
  if (!importRunning && _syncFn) {
    _syncFn(state);
  }
}

// ── Data accessors ──

export function getSong(id) {
  return state.songs.find((s) => s.id === id)
    || (state._sharedSongsCache || []).find(s => s.id === id);
}

export function getVersion(song, versionId) {
  return (song?.versions || []).find(v => v.id === versionId) || null;
}

export function featuredVersion(song) {
  if (!song) return null;
  return (song.versions || []).find(v => v.isActive) || (song.versions || [])[0] || null;
}

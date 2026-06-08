// RiffBank v1.4 (Local-first PWA + Supabase cloud sync)
// - Song creation + editing
// - Version history + Best flag
// - Best-only Player (plays links)
// - Dashboard + Settings
// - Export / Import
// - Supabase integration (auth, cloud sync, audio/cover storage)

window.onerror = (m, src, line, col) => console.error(`[RiffBank] JS ERROR: ${m} (${line}:${col})`);

// Dev toggles + debug flags now in constants.js

// ── Import queue (alerts bell, persisted to localStorage for resume) ──
// Each entry: { id, title, project, status, progress, ts, existingSongId, idbKey, fileName, fileType, fileSize }
// IMPORT_QUEUE_KEY now in constants.js
let importQueue = [];

function _loadImportQueue() {
  try {
    const raw = localStorage.getItem(IMPORT_QUEUE_KEY);
    if (raw) importQueue = JSON.parse(raw);
  } catch { importQueue = []; }
}
function _saveImportQueue() {
  try { localStorage.setItem(IMPORT_QUEUE_KEY, JSON.stringify(importQueue)); } catch {}
}
function _clearImportQueue() {
  importQueue = [];
  try { localStorage.removeItem(IMPORT_QUEUE_KEY); } catch {}
}
// Remove completed/failed items older than 24 hours
function _pruneImportQueue() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const before = importQueue.length;
  importQueue = importQueue.filter(q => {
    // Keep anything still active
    if (q.status === "waiting" || q.status === "uploading") return true;
    // Keep done/failed items younger than 24h
    return (q.ts || 0) > cutoff;
  });
  if (importQueue.length !== before) _saveImportQueue();
}

function _updateImportQueueItem(id, updates) {
  const item = importQueue.find(q => q.id === id);
  if (item) Object.assign(item, updates, { ts: Date.now() });
  _saveImportQueue();
  _updateNotifBadge();
  if (R.drawerView === "alerts") _renderImportQueueDOM();
}

function _timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function _renderImportQueueDOM() {
  const container = document.getElementById("importQueueContainer");
  if (!container) return;
  if (!importQueue.length) { container.innerHTML = ""; return; }

  const failedItems = importQueue.filter(q => q.status === "failed");
  const retryAllBtn = failedItems.length >= 2
    ? `<button class="iqRetryAllBtn" id="iqRetryAll">Retry all ${failedItems.length} failed</button>`
    : "";

  container.innerHTML = `
    <div class="alertSectionLabel" style="display:flex;align-items:center;justify-content:space-between;">Import Queue${retryAllBtn}</div>
    ${[...importQueue].sort((a, b) => (b.ts || 0) - (a.ts || 0)).map(q => {
      const isDone = q.status === "done";
      const isFailed = q.status === "failed";
      const isActive = !isDone && !isFailed;
      const barColor = isDone ? "#4ade80" : isFailed ? "#f87171" : "#4ecdc4";
      const statusText = q.statusText || (isDone ? "Imported" : isFailed ? "Failed" : q.status === "uploading" ? "Uploading…" : "Waiting…");
      const clickAttr = isDone && q.songId ? `data-iq-song="${q.songId}"` : "";
      const retryBtn = isFailed ? `<button class="iqRetryBtn" data-iq-retry="${q.id}">Retry</button>` : "";
      return `
      <div class="alertRow${isDone ? " alertRowClickable" : ""}" ${clickAttr}>
        <div class="alertIcon" style="color:${barColor}">${isDone ? "●" : isFailed ? "●" : "◌"}</div>
        <div class="alertBody">
          <div class="alertTitle">${escapeHtml(q.title)}${q.fileSize ? `<span style="color:rgba(255,255,255,.25);font-weight:400;font-size:12px;margin-left:6px">${q.fileSize >= 1048576 ? (q.fileSize / 1048576).toFixed(1) + " MB" : Math.round(q.fileSize / 1024) + " KB"}</span>` : ""}</div>
          <div class="alertMsg">${isFailed ? `<span style="color:#f87171">${escapeHtml(statusText)}</span>` : statusText}</div>
          ${isActive ? `<div class="alertProgress"><div class="alertProgressFill" style="width:${q.progress || 0}%;background:${barColor}"></div></div>` : ""}
          ${retryBtn}
        </div>
        ${!isActive && q.ts ? `<div class="alertTime">${_timeAgo(q.ts)}</div>` : ""}
      </div>`;
    }).join("")}
  `;

  // Wire click-to-navigate for successful imports
  container.querySelectorAll("[data-iq-song]").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-iq-retry]")) return;
      const songId = row.getAttribute("data-iq-song");
      if (!songId) return;
      navigateForward(() => {
        R.drawerView = null;
        R.currentTab = "songs";
        R.songsView = "list";
        R.selectedSongId = songId;
        R.selectedVersionId = null;
      });
    });
  });

  // Wire individual retry buttons
  container.querySelectorAll("[data-iq-retry]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const qId = btn.getAttribute("data-iq-retry");
      _retryImportItem(qId);
    });
  });

  // Wire retry-all button
  const retryAllEl = container.querySelector("#iqRetryAll");
  if (retryAllEl) {
    retryAllEl.addEventListener("click", (e) => {
      e.stopPropagation();
      _retryAllFailedImports();
    });
  }
}

async function _retryImportItem(queueId) {
  const qItem = importQueue.find(q => q.id === queueId);
  if (!qItem || qItem.status !== "failed") return;

  _updateImportQueueItem(qItem.id, { status: "uploading", progress: 5, statusText: "Retrying…" });

  try {
    // Find the song and version that were created during the original attempt
    const song = state.songs.find(s => s.id === (qItem.songId || qItem.id));
    if (!song) { _updateImportQueueItem(qItem.id, { status: "failed", progress: 0, statusText: "Song not found in library" }); return; }

    const v = qItem.versionId
      ? (song.versions || []).find(ver => ver.id === qItem.versionId)
      : (song.versions || [])[0];
    if (!v) { _updateImportQueueItem(qItem.id, { status: "failed", progress: 0, statusText: "Version not found" }); return; }

    // Retrieve blob: try version fileId first, then import IDB key
    let blob = null;
    if (v.fileId) {
      try { const rec = await audioGet(v.fileId); blob = rec?.blob; } catch {}
    }
    if (!blob && qItem.idbKey) {
      try { const rec = await audioGet(qItem.idbKey); blob = rec?.blob; } catch {}
    }
    if (!blob) { _updateImportQueueItem(qItem.id, { status: "failed", progress: 0, statusText: "Audio file missing — please re-import" }); return; }

    _updateImportQueueItem(qItem.id, { progress: 40, statusText: "Uploading to cloud…" });

    const result = await supabaseUploadAudio({
      blob: new File([blob], qItem.fileName || "audio", { type: qItem.fileType || "audio/*" }),
      songId: song.id, versionId: v.id, fileName: qItem.fileName || "audio",
    });

    if (result.success) {
      v.audioPath = result.audioPath;
      saveState();
      await supabasePushState(state).catch(console.warn);

      // Clean up import blob
      if (qItem.idbKey) {
        try { const db = await openAudioDb(); const tx = db.transaction(AUDIO_STORE, "readwrite"); tx.objectStore(AUDIO_STORE).delete(qItem.idbKey); db.close(); } catch {}
      }

      _updateImportQueueItem(qItem.id, { status: "done", progress: 100, statusText: "Imported", songId: song.id });
      toast(`"${qItem.title}" uploaded successfully`);
    } else {
      _updateImportQueueItem(qItem.id, { status: "failed", progress: 0, statusText: result.error || "Upload failed" });
    }
  } catch (e) {
    _updateImportQueueItem(qItem.id, { status: "failed", progress: 0, statusText: e.message || "Retry failed" });
  }
}

async function _retryAllFailedImports() {
  const failedItems = importQueue.filter(q => q.status === "failed");
  if (!failedItems.length) return;
  toast(`Retrying ${failedItems.length} failed upload${failedItems.length !== 1 ? "s" : ""}…`);
  for (const qItem of failedItems) {
    await _retryImportItem(qItem.id);
  }
}

// ── Activity log (alerts bell) ──
// Each entry: { id, songTitle, status: "saving"|"compressing"|"uploading"|"syncing"|"done"|"failed", ts, message, progress: 0-100 }
const activityLog = [];

// Map upload status to progress percentage
const _uploadProgressMap = { saving: 5, compressing: 20, uploading: 50, syncing: 85, done: 100, failed: 0 };

// ── Persistent notification inbox (survives refresh, 30-day retention) ──
// NOTIF_STORAGE_KEY, NOTIF_MAX_AGE_MS now in constants.js

function _loadNotifications() {
  try {
    const raw = localStorage.getItem(NOTIF_STORAGE_KEY);
    if (!raw) return [];
    const items = JSON.parse(raw);
    const cutoff = Date.now() - NOTIF_MAX_AGE_MS;
    return items.filter(n => n.ts >= cutoff);
  } catch { return []; }
}

function _saveNotifications(items) {
  try { localStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(items)); } catch {}
}

function addNotification({ title, body, type = "share", friendshipId, requesterName, requesterId, avatarUrl }) {
  const items = _loadNotifications();
  // Don't duplicate friend request notifications for the same friendship
  if (type === "friend_request" && friendshipId) {
    if (items.some(n => n.type === "friend_request" && n.friendshipId === friendshipId)) return;
  }
  const entry = { id: crypto.randomUUID(), title, body, type, ts: Date.now(), read: false };
  if (friendshipId) entry.friendshipId = friendshipId;
  if (requesterName) entry.requesterName = requesterName;
  if (requesterId) entry.requesterId = requesterId;
  if (avatarUrl) entry.avatarUrl = avatarUrl;
  items.unshift(entry);
  if (items.length > 100) items.length = 100;
  _saveNotifications(items);
  _updateNotifBadge();
  if (R.drawerView === "alerts") renderAlerts();
}

function markNotificationsRead() {
  const items = _loadNotifications();
  let changed = false;
  for (const n of items) { if (!n.read) { n.read = true; changed = true; } }
  if (changed) { _saveNotifications(items); _updateNotifBadge(); }
}

function _updateNotifBadge() {
  const unread = _loadNotifications().filter(n => !n.read).length;
  const btn = document.querySelector("#htbNotif");
  if (!btn) return;
  let badge = btn.querySelector(".bellBadge");
  const activeImports = importQueue.filter(q => q.status !== "done" && q.status !== "failed").length;
  const total = unread + activityLog.filter(a => a.status !== "done" && a.status !== "failed").length + (activeImports > 0 ? 1 : 0);
  if (total > 0) {
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "bellBadge";
      badge.style.cssText = "position:absolute;top:0;right:0;min-width:16px;height:16px;background:#f43f5e;border-radius:8px;font-size:10px;font-weight:700;color:#fff;display:flex;align-items:center;justify-content:center;padding:0 4px;line-height:1;";
      btn.style.position = "relative";
      btn.appendChild(badge);
    }
    badge.textContent = total;
    badge.style.display = "flex";
  } else if (badge) {
    badge.style.display = "none";
  }
}
function logActivity(id, songTitle, status, message) {
  const progress = _uploadProgressMap[status] ?? 0;
  const existing = activityLog.find(a => a.id === id);
  if (existing) {
    existing.status = status;
    existing.message = message;
    existing.progress = progress;
    existing.ts = Date.now();
  } else {
    activityLog.unshift({ id, songTitle, status, message, progress, ts: Date.now() });
  }
  // Keep last 50
  if (activityLog.length > 50) activityLog.length = 50;

  // Persist completed uploads as bell notifications (survives refresh)
  if (status === "done") {
    addNotification({ title: songTitle, body: "Uploaded to cloud", type: "upload" });
  }

  updateBellBadge();
  // Live-update alerts view if open
  if (R.drawerView === "alerts") renderAlerts();
}
function updateBellBadge() {
  _updateNotifBadge();
}

// Debug toggle: highlight sync status on song cards
// Toggle via console: toggleSyncDebug()
window.RIFFBANK_DEBUG_SYNC = false;
window.toggleSyncDebug = () => {
  window.RIFFBANK_DEBUG_SYNC = !window.RIFFBANK_DEBUG_SYNC;
  console.log(`[RiffBank] Sync debug ${window.RIFFBANK_DEBUG_SYNC ? "ON" : "OFF"}`);
  render();
};

import {
  DISABLE_SPLASH, DISABLE_WELCOME, SHOW_BUILD_BADGE,
  LS_KEY, IMPORT_QUEUE_KEY, NOTIF_STORAGE_KEY, NOTIF_MAX_AGE_MS,
  AUDIO_DB, AUDIO_STORE, TAB_TITLES,
} from "./constants.js";
import {
  $, nowStamp, slug, escapeHtml, escapeTextarea, uid,
  basenameNoExt, titleizeFromSlug, safeString, normalizeFileUrl,
  extFromPath, yyyymmddFromDate, guessNumericSuffixFromTitle,
  shuffleArray, normalizeAudioLink, fmtTime, yieldToMain,
} from "./ui/dom.js";
import { toast } from "./ui/toast.js";
import {
  initCoverArt, coverSvg, coverCache, generatingArtSongs,
  isIOSDevice, buildArtPrompt, hashStr, makeRng, clamp,
} from "./ui/coverArt.js";
import {
  initCoverArtOps, autoGenerateArt, openCoverCropOverlay, showCropOverlay,
  generateArtForSong, startBulkGenArt, artCooldownUntil, setArtCooldownUntil, bulkArtState,
} from "./ui/coverArtOps.js";
import {
  state, setState, sharedData, setSharedData,
  loadState, normalizeState, ensureProjectInState,
  saveState, initStateSave,
  getSong, getVersion, featuredVersion,
  isPlayable, songHasPlayableAudio,
} from "./state.js";
import { Nav } from "./ui/nav.js";
import { iconBookmark, iconChart, iconBulb, iconPlus, iconPeople } from "./ui/icons.js";
import {
  salSvg, dismissOnboarding, showWelcomeScreen, showDriveScreen,
  openSalSheet, openSalOnboarding,
} from "./ui/onboarding.js";
import {
  AVATAR_PRESETS, renderAvatarPreset, openAvatarPicker,
  renderAvatarHtml, openAvatarCrop, syncProfileNavIcon,
} from "./ui/avatars.js";
import {
  getVersionSyncColor, getSongSyncColor, sharedBadge,
  sharedBadgeProject, syncDot,
} from "./ui/syncBadges.js";
import { seedDefaultLibraryIfNeeded } from "./seedLibrary.js";
import "./swRegister.js";
import { showAuthScreen } from "./ui/authScreen.js";
import { showProfileSetupIfNeeded } from "./ui/profileSetup.js";
import { runSalImportFlow, getImportFlowRan, setImportFlowRan } from "./ui/salImportFlow.js";
import { initSync, incrementalSyncFromSupabase } from "./sync.js";
import { openLoadedInviteBuilder } from "./ui/loadedInviteBuilder.js";
import { initAppContext, ctx } from "./appContext.js";
import { renderHome } from "./views/homeView.js";
import { renderSongsList, renderSongDetail, renderVersionDetail } from "./views/songsView.js";
import { renderProjects, renderProjectSongs } from "./views/projectsView.js";
import { renderReleases, renderReleaseDetail } from "./views/releasesView.js";
import { renderGlobalSearch } from "./views/searchView.js";
import {
  renderCollab, renderCollabContent, renderFriendRequests, renderFriendsList,
  renderFriendProfile, renderMessages, renderChat, renderAddFriend,
  setCollabFriendsCache, setCollabConvosCache, setPendingFriendCount, getPendingFriendCount,
} from "./views/collabView.js";
import {
  initSettingsView, renderSettings, renderSettingsAccount, renderSettingsCloud,
  renderSettingsLibrary, renderSettingsArt, renderSettingsDebug, renderSettingsDanger,
} from "./ui/settingsView.js";
import {
  audioUrlCache, coverUrlCache, cachedAudioPaths,
  openAudioDB, putAudioBlob, getAudioBlob,
  putCoverBlob, getCoverBlobUrl, restoreCoverUrlsFromCache,
  compressAudioForUpload,
  openAudioDb, audioPut, audioGet, audioDelete, audioGetAll,
} from "./audio/audioDB.js";
import {
  initCloudSync, cacheAllCloudAudio, backupAllAudioToCloud, ensureAllAudioInCloud,
} from "./audio/cloudSync.js";
import { runSplashSequence, replaySplash } from "./splash/splash.js";
import { R } from "./router.js";
import {
  SUPABASE_URL, SUPABASE_ANON_KEY,
  supabase, signUp, signIn, signOut, getSession, onAuthChange, verifyOtp, resendConfirmation,
  isPasswordRecovery,
  supabaseSyncStateSoon, supabasePushState, supabasePullState, supabasePullStateSilent,
  supabaseUploadAudio, supabaseFetchAudioBlob, supabaseDeleteAudio, supabaseDiscoverAudioPaths,
  supabaseUploadCover, supabaseFetchCoverBlob, supabaseCountUserSongs,
  createShareInvite, getShareInvite, acceptShareInvite,
  fetchAllSharedData,
  pullSharedProjects, pullSharedSongs, pullMySharedProjects, pullMySharedSongs,
  listMyInvites, deleteShareInvite,
  removeProjectMember, getSongShares, revokeSongShare, updateSongShareRole,
  upsertProfile, searchUsers, shareWithUser,
  sendFriendRequest, acceptFriendRequest, removeFriendship,
  getMyFriends, getPendingFriendRequests, getPendingFriendCount as fetchPendingFriendCount,
  sendMessage, getMessages, getConversations, markMessagesRead, getUnreadMessageCount,
  subscribeToRealtimeNotifications, getProfileById,
  createLoadedInvite, getMyLoadedInvites, updateLoadedInvite, deleteLoadedInvite,
  getLoadedInvitePreview, claimLoadedInvite,
} from "./supabase.js";

// LS_KEY now in constants.js
const HAS_SAVED_STATE = !!localStorage.getItem(LS_KEY); // used to detect first-run seeding


let splashAlreadyRan = false;

// ---------------------
// Player view state
// ---------------------
let playerQueue = []; // array of { songId, versionId }
let sheetState = null; // { songId, versionId }

// NEW: fullscreen player UI state (single source of truth)

// Projects sub-screen ("list" = project list, string = selected project name)

// Releases sub-screen (null = list, string = release ID being viewed)

// Session-only: hide mini player until the user actually plays something after a fresh launch
let hasPlayedThisSession = false;

// Full-screen Now Playing is an overlay (independent of tabs)

function setFullPlayerOpen(on) {
  R.isFullPlayerOpen = !!on;

  // One CSS toggle so fullscreen can take the whole space
  document.body.classList.toggle("fullplayer-open", R.isFullPlayerOpen);

  // Hard guarantee: never show both at once.
  // IMPORTANT: when closing fullscreen, do NOT force-show the mini player.
  // Let syncMiniPlayerUI decide based on session + nowPlaying state.
  if (miniPlayerEl) {
    if (R.isFullPlayerOpen) {
      miniPlayerEl.classList.add("hidden");
      miniPlayerEl.classList.remove("visible");
      miniPlayerEl.setAttribute("aria-hidden", "true");
      document.body.classList.remove("hasMiniPlayer");
    } else {
      // Re-evaluate whether the mini player should be shown.
      // (e.g. hide it if nothing has played this session)
      syncMiniPlayerUI?.();
    }
  }
}

const view = $("#view");
if (!view) {
  console.error("RiffBank: #view not found. Check index.html structure.");
} else {
  // ✅ Ensure CSS that targets `.view` applies to `#view`
  view.classList.add("view");
}

const screens = {
  home: document.getElementById("screen-home"),
  songs: document.getElementById("screen-songs"),
  songDetail: document.getElementById("screen-song-detail"),
  versionDetail: document.getElementById("screen-version-detail"),
  player: document.getElementById("screen-player"),
  settings: document.getElementById("screen-settings"),
  collab: document.getElementById("screen-collab"),
  drawer: document.getElementById("screen-drawer"),
  projectDetail: document.getElementById("screen-project-detail"),
};

// Nav class now in ui/nav.js
// Placeholder to mark where it was — the class and all 800 lines are in the module.
// class Nav {

const nav = new Nav();

let activeScreenName = "home";
let activeScreenEl = screens.home || view;

function setActiveScreen(name) {
  const next = screens[name] || screens.home || view;
  if (!next) return;
  activeScreenName = name;
  activeScreenEl = next;

  Object.entries(screens).forEach(([screenName, el]) => {
    if (!el) return;
    const isActive = screenName === name;
    el.classList.toggle("is-active", isActive);
    // Keep home screen alive so particles don't get destroyed on nav away
    if (!isActive && screenName !== "home") el.innerHTML = "";
  });

  // Pause/resume home particles + CSS animations to freeze state while away
  const homeGrid = screens.home?.querySelector(".homeGrid");
  if (homeGrid) {
    if (homeGrid._resumeTimer) { clearTimeout(homeGrid._resumeTimer); homeGrid._resumeTimer = null; }
    if (name === "home") {
      // Delay resume until after transition overlay is removed (~300ms transition)
      homeGrid._resumeTimer = setTimeout(() => {
        if (homeGrid._resumeHome) homeGrid._resumeHome();
      }, 330);
    } else {
      if (homeGrid._pauseHome) homeGrid._pauseHome();
    }
  }
}

// Thin wrappers — all logic lives in the Nav class above.

// New centralized forward navigation: captures frozen snapshots before AND
// after mutations, then animates between them. No live DOM leaks.
function navigateForward(mutateFn) {
  const captured = {
    currentTab: R.currentTab, drawerView: R.drawerView, projectDetailScreen: R.projectDetailScreen, releaseDetailId: R.releaseDetailId,
    selectedSongId: R.selectedSongId, selectedVersionId: R.selectedVersionId, songsView: R.songsView, overlayView: R.overlayView, friendProfileId: R.friendProfileId,
    songsBackTarget: R.songsBackTarget, lyricsEditSongId: R.lyricsEditSongId, collabMode: R.collabMode, songsFromCollab: R.songsFromCollab, settingsView: R.settingsView, collabPill: R.collabPill,
    headerTitle: headerTitle?.textContent ?? "RiffBank"
  };
  nav.captureState(captured);
  nav.slideTransition({
    direction: "forward",
    mutate: () => {
      mutateFn();
      render();
    }
  });
}

const headerTitle = $("#headerTitle");
const headerBackEl = document.getElementById("headerBack");
const toastEl = $("#toast");

// Audio storage (IndexedDB) now in audio/audioDB.js

// ---------------------
// iOS audio unlock (required if you do async before play())
// ---------------------
let audioUnlocked = false;

// Tiny silent MP3 (very short). Used only to unlock iOS playback.
const SILENT_MP3 =
  "data:audio/mpeg;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async function unlockAudioOnce() {
  if (audioUnlocked) return;

  try {
    // Use a separate one-shot audio element so we never disrupt globalAudio playback
    const a = new Audio(SILENT_MP3);
    a.preload = "auto";
    a.volume = 0;

    // Must be inside a user gesture
    await a.play();
    a.pause();

    audioUnlocked = true;
  } catch (e) {
    console.warn("Audio unlock failed:", e);
  }
}

// openAudioDB, putAudioBlob, getAudioBlob, putCoverBlob,
// getCoverBlobUrl, restoreCoverUrlsFromCache now in audio/audioDB.js

function getActiveTab() {
  // If you already track current tab in a variable, return that instead.
  // Fallback: find the active bottom nav button.
  const active = document.querySelector(".bottomNav .active");
  return active?.dataset?.tab || "home";
}

function setActiveTab(tab) {
  // Use YOUR existing tab switcher here if you have one.
  // This is intentionally a lightweight fallback.
  document.querySelectorAll(".bottomNav [data-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
}

function ensureNowPlayingOverlay() {
  let el = document.getElementById("nowPlayingOverlay");
  if (el) return el;

  el = document.createElement("div");
  el.id = "nowPlayingOverlay";
  el.style.position = "fixed";
  el.style.inset = "0";
  el.style.zIndex = "9998";
  el.style.background = "transparent"; // your CSS handles background vibes
  document.body.appendChild(el);
  return el;
}

let nowPlayingOverlayEl = null;

function getNowPlayingOverlayEl() {
  if (!nowPlayingOverlayEl) nowPlayingOverlayEl = ensureNowPlayingOverlay();
  return nowPlayingOverlayEl;
}

// fmtTime now in ui/dom.js

function openNowPlaying() {
  if (!state.player?.nowPlaying) return;

  R.fullPlayerOpen = true;
  R.isNowPlayingFullscreen = true;

  const overlay = getNowPlayingOverlayEl();
  overlay.innerHTML = renderNowPlayingHTML();
  wireNowPlayingEvents(overlay);
  overlay.classList.add("is-open");
}

function closeNowPlaying() {
  R.fullPlayerOpen = false;
  R.isNowPlayingFullscreen = false;

  const overlay = getNowPlayingOverlayEl();renderNowPlayingHTML
  overlay.classList.remove("is-open");

  setTimeout(() => {
    if (!R.fullPlayerOpen) overlay.innerHTML = "";
  }, 200);
}

// Full-screen Now Playing overlay HTML (kept in sync with renderNowPlaying)
function renderNowPlayingHTML() {
const np = state.player?.nowPlaying;
  if (!np) return "";

  const song = getSong(np.songId);
  const v = song ? getVersion(song, np.versionId) : null;

  const title = escapeHtml(song?.title || "");
  const subtitle = escapeHtml(v?.label || "");
  const coverArt = ""; // coverSvg generates SVG not a URL, so leave blank for now
  const dur = Number.isFinite(globalAudio?.duration) ? globalAudio.duration : 0;
  const cur = Number.isFinite(globalAudio?.currentTime) ? globalAudio.currentTime : 0;
  const pct = dur > 0 ? (cur / dur) * 100 : 0;

  const shuffleOn = !!state.player.shuffle;
  const repeatState = state.player.repeat; // false | true | "one"

  return `
    <div class="fp" id="fpRoot">
      <div class="fpTop">
        <button class="fpIconBtn" id="fpClose" aria-label="Close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>
        </button>
        <div class="fpTopRight">
          <button class="fpIconBtn" id="fpMore" aria-label="More">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
          </button>
        </div>
      </div>

      <div class="fpCoverWrap">
        ${song ? coverSvg(song) : ""}
      </div>

      <div class="fpMeta">
        <div class="fpTitle">${title}</div>
        <div class="fpSubtitle">${subtitle}</div>
      </div>

      <div class="fpActions">
        <button class="fpPill">Song</button>
        <button class="fpPill">Up next</button>
        <button class="fpPill">Save</button>
        <button class="fpPill">Share</button>
      </div>

      <div class="fpScrub">
        <div class="fpTime">${fmtTime(cur)}</div>
        <input id="fpSeek" class="fpSeek" type="range" min="0" max="100" value="${pct}" />
        <div class="fpTime">${fmtTime(dur)}</div>
      </div>

      <div class="fpControls">
        <button class="fpCtrl ${shuffleOn ? "is-active" : ""}" id="fpShuffle" aria-label="Shuffle">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="4" y1="4" x2="21" y2="21"/></svg>
        </button>
        <button class="fpCtrl" id="fpPrev" aria-label="Previous">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6z"/><path d="M20 6v12l-10-6z"/></svg>
        </button>
        <button class="fpCtrl fpPlay" id="fpPlay" aria-label="Play/Pause">
          ${globalAudio?.paused
            ? `<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`
            : `<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6z"/><path d="M14 5h4v14h-4z"/></svg>`
          }
        </button>
        <button class="fpCtrl" id="fpNext" aria-label="Next">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M16 5h2v14h-2z"/><path d="M4 6v12l10-6z"/></svg>
        </button>
        <button class="fpCtrl ${repeatState ? "is-active" : ""}" id="fpRepeat" aria-label="Repeat" style="position:relative">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
          ${repeatState === "one" ? `<span class="r1b">1</span>` : ""}
        </button>
      </div>

      <div class="fpBottomTabs">
        <button class="fpBottomTab is-active" type="button">UP NEXT</button>
        <button class="fpBottomTab" type="button">LYRICS</button>
        <button class="fpBottomTab" type="button">RELATED</button>
      </div>
    </div>
  `;
}

function wireNowPlayingEvents(overlay) {
  overlay.querySelector("#fpClose")?.addEventListener("click", closeNowPlaying);

  // Swipe down to close
  const root = overlay.querySelector("#fpRoot");
  if (root) {
    let startY = 0, dy = 0, dragging = false;

    root.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      dragging = true;
      startY = e.touches[0].clientY;
      dy = 0;
    }, { passive: true });

    root.addEventListener("touchmove", (e) => {
      if (!dragging || e.touches.length !== 1) return;
      dy = e.touches[0].clientY - startY;
      if (dy < 0) dy = 0;
      if (dy > 0) {
        root.style.transform = `translateY(${dy}px)`;
        root.style.transition = "none";
      }
    }, { passive: true });

    root.addEventListener("touchend", () => {
      dragging = false;
      if (dy > 120) closeNowPlaying();
      else {
        root.style.transition = "transform 171ms ease";
        root.style.transform = "translateY(0px)";
      }
    }, { passive: true });
  }

  overlay.querySelector("#fpSeek")?.addEventListener("input", (e) => {
    const dur = globalAudio?.duration || 0;
    if (!dur) return;
    const pct = parseFloat(e.target.value || "0") / 100;
    globalAudio.currentTime = Math.max(0, Math.min(dur, dur * pct));
  });

  overlay.querySelector("#fpPlay")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!state.player?.nowPlaying) return;

    if (globalAudio.paused) await playNowPlaying();
    else globalAudio.pause();

    overlay.innerHTML = renderNowPlayingHTML();
    wireNowPlayingEvents(overlay);
  });

  overlay.querySelector("#fpPrev")?.addEventListener("click", (e) => {
    e.stopPropagation();
    try { globalAudio.currentTime = 0; } catch {}
  });

  overlay.querySelector("#fpNext")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!state.player?.queue?.length) return;
    _miniCarouselDir = 1; // forward
    if (state.player.nowPlaying) {
      if (!state.player.playHistory) state.player.playHistory = [];
      state.player.playHistory.push(state.player.nowPlaying);
    }
    const next = state.player.queue.shift();
    state.player.nowPlaying = next;
    saveState();
    playNowPlaying();
    overlay.innerHTML = renderNowPlayingHTML();
    wireNowPlayingEvents(overlay);
  });

  overlay.querySelector("#fpShuffle")?.addEventListener("click", () => {
    state.player.shuffle = !state.player.shuffle;
    saveState();
    overlay.querySelector("#fpShuffle")?.classList.toggle("is-active", state.player.shuffle);
  });

  overlay.querySelector("#fpRepeat")?.addEventListener("click", () => {
    const r = state.player.repeat;
    state.player.repeat = r === false ? true : r === true ? "one" : false;
    saveState();
    const btn = overlay.querySelector("#fpRepeat");
    if (btn) {
      btn.classList.toggle("is-active", !!state.player.repeat);
      btn.querySelector(".r1b")?.remove();
      if (state.player.repeat === "one") {
        const badge = document.createElement("span");
        badge.className = "r1b";
        badge.textContent = "1";
        btn.appendChild(badge);
      }
    }
  });
}

async function getLocalObjectUrl(localAudioId) {
  if (!localAudioId) return "";
  if (audioUrlCache.has(localAudioId)) return audioUrlCache.get(localAudioId);

  const rec = await getAudioBlob(localAudioId);
  if (!rec?.blob) return "";

  const url = URL.createObjectURL(rec.blob);
  audioUrlCache.set(localAudioId, url);
  return url;
}

function isHomeRoot() {
  return (
    R.currentTab === "home" &&
    !R.drawerView &&
    !R.overlayView &&
    !R.selectedSongId
  );
}

// toast() now in ui/toast.js

// ---------------------
// Global audio + mini player
// ---------------------
const globalAudio = document.getElementById("globalAudio");

const miniPlayerEl = document.getElementById("miniPlayer");

const bottomNavEl  = document.getElementById("bottomNav");

let _dockRaf = 0;
function scheduleDockSpaceSync() {
  if (_dockRaf) cancelAnimationFrame(_dockRaf);
  _dockRaf = requestAnimationFrame(() => {
    _dockRaf = requestAnimationFrame(syncDockSpace);
  });
}

function syncDockSpace() {
  const vv = window.visualViewport;
  const viewportH = vv ? vv.height : window.innerHeight;
  const navTop = bottomNavEl ? bottomNavEl.getBoundingClientRect().top : viewportH;

  // Track actual nav height so mini player can anchor flush against it
  const navH = Math.round(viewportH - navTop);
  document.documentElement.style.setProperty("--nav-h", navH + "px");

  let topDock = navTop;

  if (miniPlayerEl && !miniPlayerEl.classList.contains("hidden")) {
    const mr = miniPlayerEl.getBoundingClientRect();
    if (mr.height > 0) topDock = Math.min(topDock, mr.top);
  }

  const dockH = Math.max(0, Math.round(viewportH - topDock));
  document.documentElement.style.setProperty("--dock-h", dockH + "px");
}

function isMiniPlayerActuallyVisible() {
  if (!miniPlayerEl) return false;
  if (miniPlayerEl.classList.contains("hidden")) return false;
  if (!miniPlayerEl.classList.contains("visible")) return false;
  if (miniPlayerEl.getAttribute("aria-hidden") === "true") return false;
  return true;
}

function updateDockSpace() {
  // bottom nav is always present
  const navH = bottomNavEl ? bottomNavEl.getBoundingClientRect().height : 0;

  // Track actual nav height so mini player can anchor flush against it
  document.documentElement.style.setProperty("--nav-h", `${Math.ceil(navH)}px`);

  // if mini player is visible, reserve up to its TOP (includes nav + gap automatically)
  let dockH = navH;
  if (isMiniPlayerActuallyVisible()) {
    const r = miniPlayerEl.getBoundingClientRect();
    const fromBottomToMiniTop = window.innerHeight - r.top;
    dockH = Math.max(dockH, fromBottomToMiniTop);
  }

  // write the CSS var used by #view padding-bottom
  document.documentElement.style.setProperty("--dock-h", `${Math.ceil(dockH)}px`);
}

function syncMiniPlayerReserveSpace() {
  document.body.classList.toggle("hasMiniPlayer", isMiniPlayerActuallyVisible());
  updateDockSpace();
}

// keep dock height correct on resize/orientation changes
window.addEventListener("resize", () => updateDockSpace(), { passive: true });

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => updateDockSpace(), { passive: true });
}

const miniArtEl    = document.getElementById("miniArt");
const miniToggleEl = document.getElementById("miniToggle");
const miniScrubEl  = document.getElementById("miniScrub");
const miniTitleEl  = document.getElementById("miniTitle");
const miniSubEl    = document.getElementById("miniSub");

// Track currently displayed song so we can detect real changes
let _miniDisplayedKey = "";
// Direction hint for carousel: 1 = forward (slide left), -1 = backward (slide right)
let _miniCarouselDir = 0;

// isPlayable, songHasPlayableAudio now in state.js

async function syncMiniPlayerUI() {
    // ✅ If fullscreen Now Playing is open, mini player must never appear
  if (document.body.classList.contains("fullplayer-open")) {
    miniPlayerEl.classList.add("hidden");
    miniPlayerEl.classList.remove("visible");
    miniPlayerEl.setAttribute("aria-hidden", "true");
    document.body.classList.remove("hasMiniPlayer");
    syncMiniPlayerReserveSpace();
    return;
  }

  if (!miniPlayerEl) return;

  // ✅ Fresh-launch behavior: don't show the mini player until the user plays something this session
  if (!hasPlayedThisSession) {
    miniPlayerEl.classList.add("hidden");
    miniPlayerEl.classList.remove("visible");
    miniPlayerEl.setAttribute("aria-hidden", "true");
    document.body.classList.remove("hasMiniPlayer");
    syncMiniPlayerReserveSpace();
    return;
  }

// Guard: older builds may not define isNowPlayingFullscreen
if (typeof R.isNowPlayingFullscreen !== "undefined" && R.isNowPlayingFullscreen) {
  miniPlayerEl.classList.add("hidden");
  miniPlayerEl.classList.remove("visible");
  miniPlayerEl.setAttribute("aria-hidden", "true");
  document.body.classList.remove("hasMiniPlayer");
  syncMiniPlayerReserveSpace();
  return;
}

  const now = state.player?.nowPlaying;
  if (!now) {
    miniPlayerEl.classList.add("hidden");
    miniPlayerEl.classList.remove("visible");
    miniPlayerEl.setAttribute("aria-hidden", "true");
    document.body.classList.remove("hasMiniPlayer");
    syncMiniPlayerReserveSpace();
    return;
  }

  const song = getSong(now.songId);
  const v = song ? getVersion(song, now.versionId) : null;

  if (!song) {
    miniPlayerEl.classList.add("hidden");
    miniPlayerEl.classList.remove("visible");
    miniPlayerEl.setAttribute("aria-hidden", "true");
    document.body.classList.remove("hasMiniPlayer");
    syncMiniPlayerReserveSpace();
    return;
  }

  // Determine if mini player is already on screen
  const wasAlreadyVisible = miniPlayerEl.classList.contains("visible") && !miniPlayerEl.classList.contains("hidden");
  const newKey = now.songId + "/" + now.versionId;
  const songChanged = newKey !== _miniDisplayedKey;

  // Show mini player — suppress slide-up transition if already visible
  miniPlayerEl.style.transition = wasAlreadyVisible ? "none" : "";
  miniPlayerEl.classList.remove("hidden");
  miniPlayerEl.classList.add("visible");
  miniPlayerEl.setAttribute("aria-hidden", "false");
  document.body.classList.add("hasMiniPlayer");
  syncMiniPlayerReserveSpace();
  if (wasAlreadyVisible) {
    requestAnimationFrame(() => { miniPlayerEl.style.transition = ""; });
  }

  // ── Carousel song content swap ──
  const inner = miniPlayerEl.querySelector(".miniSwipeInner");
  const dir = _miniCarouselDir;
  _miniCarouselDir = 0; // consume direction

  if (wasAlreadyVisible && songChanged && inner && dir !== 0) {
    // Build incoming content off-screen
    const comeFrom = dir > 0 ? "110%" : "-110%";
    const flyTo    = dir > 0 ? "-110%" : "110%";

    let peekArt = "";
    try { peekArt = coverSvg(song, { lite: true }); } catch {}

    const ghost = document.createElement("div");
    ghost.className = "miniSwipeInner";
    ghost.style.cssText = `position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;transform:translateX(${comeFrom});transition:none;`;
    ghost.innerHTML = `<div class="miniArt" aria-hidden="true">${peekArt}</div><div class="miniMeta"><div class="miniTitle">${escapeHtml(song.title || "Untitled")}</div><div class="miniSub">${escapeHtml(song.project || "")}</div></div>`;

    const swipeZone = miniPlayerEl.querySelector(".miniSwipeZone");
    if (swipeZone) swipeZone.appendChild(ghost);

    // Slide current out + ghost in
    inner.style.transition = "transform 236ms ease";
    inner.style.transform = `translateX(${flyTo})`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      ghost.style.transition = "transform 236ms ease";
      ghost.style.transform = "translateX(0)";
    }));

    // After animation: update real inner, remove ghost
    setTimeout(() => {
      ghost.remove();
      inner.style.transition = "none";
      inner.style.transform = "translateX(0)";
      // Update the real inner content to match the new song
      if (miniArtEl) try { miniArtEl.innerHTML = coverSvg(song, { lite: true }); } catch { miniArtEl.innerHTML = ""; }
      if (miniTitleEl) miniTitleEl.textContent = song.title || "Untitled";
      if (miniSubEl) miniSubEl.textContent = song.project || "";
    }, 240);
  } else {
    // No carousel — just update content in place
    if (miniTitleEl) miniTitleEl.textContent = song.title || "Untitled";
    if (miniSubEl) miniSubEl.textContent = song.project || "";
    if (miniArtEl) {
      try { miniArtEl.innerHTML = coverSvg(song, { lite: true }); } catch { miniArtEl.innerHTML = ""; }
    }
  }

  _miniDisplayedKey = newKey;

  // play/pause icon
  if (miniToggleEl) miniToggleEl.innerHTML = globalAudio?.paused
    ? `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`
    : `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;

  // keep scrub in sync
  syncMiniScrub();
}

scheduleDockSpaceSync();
window.addEventListener("resize", scheduleDockSpaceSync);
if (window.visualViewport) window.visualViewport.addEventListener("resize", scheduleDockSpaceSync);

function syncMiniScrub(){
  if (!miniScrubEl || !globalAudio) return;
  if (Number.isFinite(globalAudio.duration) && globalAudio.duration > 0) {
    const pct = (globalAudio.currentTime / globalAudio.duration) * 100;
    miniScrubEl.value = String(Math.floor(pct * 10));
    miniScrubEl.style.background = `linear-gradient(to right, #a855f7 0%, #ec4899 ${pct}%, rgba(255,255,255,.12) ${pct}%)`;
  } else {
    miniScrubEl.value = "0";
    miniScrubEl.style.background = "rgba(255,255,255,.12)";
  }
}

globalAudio?.addEventListener("timeupdate", syncMiniScrub);
globalAudio?.addEventListener("loadedmetadata", syncMiniScrub);

miniScrubEl?.addEventListener("input", (e) => {
  if (!globalAudio) return;
  const val = Number(e.target.value || 0) / 1000;
  if (Number.isFinite(globalAudio.duration) && globalAudio.duration > 0) {
    globalAudio.currentTime = val * globalAudio.duration;
  }
});

let _autoSkipCount = 0; // guard against infinite skip loops
async function playNowPlaying({ autoplay = true } = {}){
  const now = state.player?.nowPlaying;
  if (!now || !globalAudio) return;

  const url = await getPlayableUrlForVersion(now.songId, now.versionId);
  if (!url || url === "drive-auth-required") {
    // Auto-skip to next playable track (limit skips to prevent infinite loop)
    if (_autoSkipCount < 20) {
      _autoSkipCount++;
      console.warn(`[Player] Skipping unplayable track (${now.songId}), advancing...`);
      if (advanceToNextTrack({ render: false })) return;
    }
    _autoSkipCount = 0;
    // Keep mini player visible even though audio failed — don't leave user stranded
    hasPlayedThisSession = true;
    toast("No audio available — upload from another device or re-import");
    await syncMiniPlayerUI();
    return;
  }
  _autoSkipCount = 0; // reset on successful play

  // Mark that this session has begun playback (so mini player can appear)
  hasPlayedThisSession = true;

  // Ensure only ONE audio plays in the whole app
  document.querySelectorAll("audio").forEach(a => {
    if (a !== globalAudio) {
      try { a.pause(); } catch {}
      try { a.removeAttribute("src"); a.load(); } catch {}
    }
  });

  // If already playing this exact src, don't reset time
  if (globalAudio.src !== url) {
    // Only reset error/stall guards when the TRACK changes, not just the URL
    // (same track can get a new blob URL after cache clear — guard must persist)
    const trackKey = `${now.songId}:${now.versionId}`;
    if (_stallRetriedTrack && _stallRetriedTrack !== trackKey) _stallRetriedTrack = null;
    if (_errorSkipTrack && _errorSkipTrack !== trackKey) _errorSkipTrack = null;

    // Blob URLs don't support range requests — tell browser to fully buffer ahead
    globalAudio.preload = url.startsWith("blob:") ? "auto" : "metadata";
    globalAudio.src = url;
    console.log(`[Player] src set: ${url.slice(0, 60)}… preload=${globalAudio.preload}`);
  }

  if (autoplay) {
    try {
      await globalAudio.play(); // must be called from a user gesture on iOS
    } catch (e) {
      console.warn(e);
      toast("Tap Play to start audio (iOS rule) 😅");
    }
  }

  // Media Session API: lock screen, CarPlay, headphones, keyboard media keys
  if ("mediaSession" in navigator) {
    const song = getSong(now.songId);
    const v = song ? getVersion(song, now.versionId) : null;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song?.title || "Untitled",
      artist: song?.project || "",
      album: v?.label || "",
    });
    navigator.mediaSession.setActionHandler("play", () => {
      globalAudio.play()
        .then(() => {
          navigator.mediaSession.playbackState = "playing";
          if (miniToggleEl) miniToggleEl.textContent = "⏸";
        })
        .catch(() => {
          // Blob URL may have expired after backgrounding — reload from source and play
          playNowPlaying({ autoplay: true });
        });
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      globalAudio.pause();
      navigator.mediaSession.playbackState = "paused";
      if (miniToggleEl) miniToggleEl.textContent = "▶";
    });
    navigator.mediaSession.setActionHandler("nexttrack", () => {
      if (state.player?.repeat === "one") return;
      advanceToNextTrack({ render: true });
    });
    navigator.mediaSession.setActionHandler("previoustrack", () => {
      globalAudio.currentTime = 0;
    });
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (details.seekTime != null && Number.isFinite(globalAudio.duration)) {
        globalAudio.currentTime = details.seekTime;
      }
    });
    navigator.mediaSession.playbackState = autoplay ? "playing" : "paused";
  }

  await syncMiniPlayerUI();
}

// nowStamp, slug, escapeHtml, escapeTextarea, uid now in ui/dom.js

// state, loadState, sharedData now in state.js
setState(loadState());

// Wire cover art module dependencies (saveState/render are hoisted function declarations)
initCoverArt({ supabaseFetchCoverBlob, saveState, render });
initCloudSync({ globalAudio, render });
initCoverArtOps({ render, getSelectedSongId: () => R.selectedSongId });
initSync({ render, getImportQueueRunning: () => _importQueueRunning, getImportQueue: () => importQueue });
// initAppContext moved into init() — some refs need all declarations to be evaluated first
initSettingsView({ recoverAndUploadAudio });

// normalizeState, ensureProjectInState, saveState now in state.js
normalizeState();

// Wire saveState's sync dependency
initStateSave({
  syncFn: supabaseSyncStateSoon,
  importQueueRunningFn: () => _importQueueRunning,
});

// ---------------------
// Default library seeding (from /public/library)
// ---------------------
// fetchJson, seed library helpers now in seedLibrary.js


// ---------------------
// ---------------------
// compressAudioForUpload, openAudioDb, audioPut, audioGet,
// audioDelete, audioGetAll now in audio/audioDB.js

// Delete a song from Supabase (DB rows + storage files) — fire-and-forget
async function deleteSongEverywhere(song) {
  if (!song) return;
  // Delete versions, then song row from DB — await to ensure completion
  try {
    await supabase.from("versions").delete().eq("song_id", song.id);
    await supabase.from("songs").delete().eq("id", song.id);
  } catch (e) {
    console.warn("[Supabase] delete song rows:", e);
  }
  // Delete audio files from storage — both by audioPath AND by listing the song folder
  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id;
  for (const v of (song.versions || [])) {
    if (v.audioPath) supabaseDeleteAudio(v.audioPath).catch(() => {});
    // Also clean up the entire version folder in storage (catches orphaned files)
    if (userId) {
      const folderPath = `${userId}/${song.id}/${v.id}`;
      try {
        const { data: files } = await supabase.storage.from("audio").list(folderPath);
        if (files?.length) {
          const paths = files.map(f => `${folderPath}/${f.name}`);
          await supabase.storage.from("audio").remove(paths);
        }
      } catch {}
    }
  }
  // Delete cover from storage
  if (song.coverPath) {
    supabase.storage.from("covers").remove([song.coverPath]).catch(() => {});
  }
  // Note: art_rate_limits cleanup skipped — RLS blocks direct deletes.
  // Rows expire naturally or can be cleaned up server-side.
}

// Recover lost audio refs: scan IndexedDB blobs, match to versions by filename,
// re-link fileId, and upload to Supabase Storage
async function recoverAndUploadAudio() {
  const allBlobs = await audioGetAll();
  if (!allBlobs.length) { toast("No audio blobs found in local storage"); return; }

  // Build lookups (skip supa: cached entries)
  const blobByName = new Map();
  const blobById = new Map();
  const blobByTitleKey = new Map();
  for (const rec of allBlobs) {
    if (rec.id.startsWith("supa:")) continue;
    if (rec.name) {
      blobByName.set(rec.name, rec);
      const key = rec.name.replace(/\.[^.]+$/, "").toLowerCase().trim();
      if (key) blobByTitleKey.set(key, rec);
    }
    blobById.set(rec.id, rec);
  }

  let relinked = 0, uploaded = 0, failed = 0;
  const errors = [];
  const usedIds = new Set();
  toast(`Found ${blobByName.size} local audio blobs — recovering…`);

  for (const song of (state.songs || [])) {
    for (const v of (song.versions || [])) {
      // Skip if already fully synced (has local audio AND cloud backup)
      if (v.audioPath && (v.fileId || v.localAudioId)) continue;

      // Find the blob: try exact match first, then fuzzy by song title
      let rec = blobById.get(v.fileId) || blobById.get(v.localAudioId)
             || blobByName.get(v.fileName) || blobByName.get(v.originalFileName);
      if (!rec) {
        const titleKey = (song.title || "").toLowerCase().trim();
        if (titleKey) rec = blobByTitleKey.get(titleKey);
      }
      if (!rec && v.fileId) {
        try { rec = await audioGet(v.fileId); } catch {}
      }
      if (!rec?.blob || usedIds.has(rec.id)) continue;
      usedIds.add(rec.id);

      // Re-link fileId if missing
      if (!v.fileId) {
        v.fileId = rec.id;
        v.fileType = v.fileType || rec.type || "";
        v.fileSize = v.fileSize || rec.size || 0;
        relinked++;
      }

      // Backfill fileName if it was lost (e.g. cloud sync returned null)
      if (!v.fileName && rec.name) {
        v.fileName = rec.name;
      }

      // Upload to Supabase Storage if not already backed up
      if (v.audioPath) continue;
      try {
        toast(`Compressing ${song.title}…`);
        const uploadBlob = await compressAudioForUpload(rec.blob, globalAudio);
        const fileName = v.fileName || rec.name || "audio";
        const result = await supabaseUploadAudio({
          blob: new File([uploadBlob], fileName, { type: uploadBlob.type || rec.type || "audio/*" }),
          songId: song.id,
          versionId: v.id,
          fileName,
        });
        if (result.success) {
          v.audioPath = result.audioPath;
          uploaded++;
        } else {
          errors.push(`${song.title}: ${result.error}`);
          failed++;
        }
      } catch (e) {
        errors.push(`${song.title}: ${e.message || e}`);
        failed++;
      }
      toast(`Recovering: ${uploaded} uploaded, ${failed} failed…`);
    }
  }

  if (relinked || uploaded) {
    saveState();
    // Push immediately so audioPath makes it to DB
    await supabasePushState(state).catch(console.warn);
    render();
  }

  let msg = uploaded || failed
    ? `Recovery: ${uploaded} uploaded, ${failed} failed` + (relinked ? `, ${relinked} re-linked` : "")
    : "Recovery: nothing to do (all synced or no blobs found)";
  if (errors.length) msg += "\n\nErrors:\n" + errors.slice(0, 5).join("\n");
  console.log("[RiffBank Recovery]", msg);
}

// Debug: run `debugRecovery()` in browser console or tap "Debug Recovery" in Settings
window.debugRecovery = async () => {
  const allBlobs = await audioGetAll();
  const nonSupa = allBlobs.filter(r => !String(r.id).startsWith("supa:"));
  const lines = [];
  lines.push(`IndexedDB: ${allBlobs.length} total, ${nonSupa.length} non-supa`);
  lines.push("");

  // Show first few blob IDs/names
  for (const r of nonSupa.slice(0, 3)) {
    lines.push(`Blob: id=${String(r.id).slice(0,12)}… name="${r.name}" hasBlob=${!!r.blob}`);
  }
  if (nonSupa.length > 3) lines.push(`…and ${nonSupa.length - 3} more`);
  lines.push("");

  // Check each version
  let needsUpload = 0, hasBlob = 0, noBlob = 0;
  const details = [];
  for (const song of (state.songs || [])) {
    for (const v of (song.versions || [])) {
      if (v.audioPath) continue; // already synced
      needsUpload++;
      let blobFound = false;
      if (v.fileId) {
        try {
          const r = await audioGet(v.fileId);
          blobFound = !!r?.blob;
        } catch {}
      }
      if (blobFound) hasBlob++; else noBlob++;
      details.push(`${song.title} / ${v.label}: fileId=${v.fileId ? "yes" : "NO"} blob=${blobFound ? "YES" : "NO"} fileName="${v.fileName || ""}"`);
    }
  }
  lines.push(`Need upload: ${needsUpload} (${hasBlob} have blobs, ${noBlob} missing)`);
  lines.push("");
  for (const d of details) lines.push(d);

  console.log("[RiffBank Debug]\n" + lines.join("\n"));
};

// Pick audio from iOS Files picker
function pickAudioFile() {
  return new Promise((resolve) => {
    // Reuse the hidden input already in the DOM (iOS PWA needs a persistent element)
    let input = document.getElementById("_audioPickerDynamic");
    if (!input) {
      input = document.createElement("input");
      input.id = "_audioPickerDynamic";
      input.type = "file";
      input.style.position = "fixed";
      input.style.left = "-9999px";
      input.style.top = "-9999px";
      input.style.opacity = "0";
      input.style.pointerEvents = "none";
      document.body.appendChild(input);
    }

    // Reset so the same file can be re-picked
    input.value = "";

    // Only file extensions — avoids iOS showing camera/photo options
    input.accept = ".wav,.mp3,.m4a,.aac,.aiff,.flac,.ogg,.caf";

    const handler = () => {
      input.removeEventListener("change", handler);
      const f = input.files?.[0] || null;

      if (!f) return resolve(null);

      const name = (f.name || "").toLowerCase();
      const okExt = /\.(wav|mp3|m4a|aac|aiff|flac|ogg|caf)$/i.test(name);
      const okMime = (f.type || "").startsWith("audio/");

      if (!okExt && !okMime) {
        toast("That doesn’t look like an audio file 😅");
        return resolve(null);
      }

      resolve(f);
    };

    input.addEventListener("change", handler);

    // Small delay for iOS PWA — ensures the input is ready
    setTimeout(() => input.click(), 50);
  });
}

// Pick multiple audio files at once
function pickAudioFiles() {
  return new Promise((resolve) => {
    let input = document.getElementById("_audioPickerMulti");
    if (!input) {
      input = document.createElement("input");
      input.id = "_audioPickerMulti";
      input.type = "file";
      input.multiple = true;
      input.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none;";
      document.body.appendChild(input);
    }
    input.value = "";
    input.accept = ".wav,.mp3,.m4a,.aac,.aiff,.flac,.ogg,.caf";
    const handler = () => {
      input.removeEventListener("change", handler);
      const files = Array.from(input.files || []).filter(f => {
        const okExt = /\.(wav|mp3|m4a|aac|aiff|flac|ogg|caf)$/i.test(f.name || "");
        const okMime = (f.type || "").startsWith("audio/");
        return okExt || okMime;
      });
      resolve(files);
    };
    input.addEventListener("change", handler);
    setTimeout(() => input.click(), 50);
  });
}

// ── Duplicate detection helpers (shared by single create + bulk import) ──

/** Find existing versions whose fileName matches (case-insensitive).
 *  Also matches stem (without extension) so "song.wav" matches "song.m4a".
 *  Returns [{song, version}] — one hit per song max. */
function _findFileNameDuplicates(fileName) {
  if (!fileName) return [];
  const lower = fileName.toLowerCase();
  const stem = lower.replace(/\.[^.]+$/, "");
  const hits = [];
  const seenSongs = new Set();
  for (const song of state.songs) {
    if (seenSongs.has(song.id)) continue;
    for (const v of (song.versions || [])) {
      const vName = (v.fileName || "").toLowerCase();
      const vOriginal = (v.originalFileName || "").toLowerCase();
      // Exact match
      if (vName === lower || vOriginal === lower) {
        seenSongs.add(song.id);
        hits.push({ song, version: v });
        break;
      }
      // Stem match (without extension)
      const vStem = vName.replace(/\.[^.]+$/, "");
      const vOrigStem = vOriginal.replace(/\.[^.]+$/, "");
      if (stem && vStem && (vStem === stem || vOrigStem === stem)) {
        seenSongs.add(song.id);
        hits.push({ song, version: v });
        break;
      }
    }
  }
  return hits;
}

/** Find an existing song with the same title in the same project. Returns song or null */
function _findSongNameDuplicate(title, project) {
  if (!title || !project) return null;
  const tLower = title.trim().toLowerCase();
  const pLower = project.trim().toLowerCase();
  return state.songs.find(s =>
    (s.title || "").trim().toLowerCase() === tLower &&
    (s.project || "").trim().toLowerCase() === pLower
  ) || null;
}

/** Show a duplicate-file dialog. onContinue = proceed anyway, onGoToSong = navigate to the match */
function _showDuplicateFileDialog(fileName, hits, { onContinue, onDismiss }) {
  document.getElementById("dupFileDialog")?.remove();
  document.getElementById("dupFileBackdrop")?.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "dupFileBackdrop";
  backdrop.className = "biModalBackdrop";

  const dialog = document.createElement("div");
  dialog.id = "dupFileDialog";
  dialog.className = "biModal";
  dialog.style.maxHeight = "70vh";

  const matchRows = hits.map(h => {
    const vLabel = h.version?.label || "song";
    const verId = h.version?.id || "";
    return `<div class="dupMatchRow" data-song-id="${h.song.id}" data-version-id="${verId}">
      <div class="dupMatchTitle">${escapeHtml(h.song.title)}</div>
      <div class="dupMatchSub">${escapeHtml(h.song.project || "")} · ${escapeHtml(vLabel)}</div>
    </div>`;
  }).join("");

  dialog.innerHTML = `
    <div class="biModalHeader">
      <div class="biModalTitle">Possible Duplicate</div>
      <div class="biModalSub">A file named <b>${escapeHtml(fileName)}</b> already exists:</div>
    </div>
    <div class="biModalBody" style="padding:8px 0;">
      ${matchRows}
    </div>
    <div class="biModalActions">
      <button class="biModalBtn biModalRemove" id="dupCancel">Cancel</button>
      <button class="biModalBtn biModalDone" id="dupContinue">Import Anyway</button>
    </div>
  `;

  document.body.appendChild(backdrop);
  document.body.appendChild(dialog);

  requestAnimationFrame(() => {
    backdrop.classList.add("open");
    dialog.classList.add("open");
  });

  const close = () => {
    backdrop.classList.remove("open");
    dialog.classList.remove("open");
    setTimeout(() => { backdrop.remove(); dialog.remove(); }, 250);
  };

  backdrop.addEventListener("click", () => { close(); onDismiss?.(); });
  dialog.querySelector("#dupCancel")?.addEventListener("click", () => { close(); onDismiss?.(); });

  dialog.querySelector("#dupContinue")?.addEventListener("click", () => {
    close();
    onContinue?.();
  });

  dialog.querySelectorAll(".dupMatchRow").forEach(row => {
    row.addEventListener("click", () => {
      const songId = row.dataset.songId;
      const versionId = row.dataset.versionId;
      close();
      onDismiss?.();
      // Navigate to the matching song/version detail
      navigateForward(() => {
        R.currentTab = "songs";
        R.songsView = "list";
        R.selectedSongId = songId;
        R.selectedVersionId = versionId || null;
        setHeader("Song");
        syncTabs();
      });
    });
  });
}

/** Show a combined duplicate-file dialog for bulk import (multiple files may match).
 *  allDups = [{ fileName, hits: [{song, version}] }]
 */
function _showBulkDuplicateFileDialog(allDups, { onContinue, onDismiss }) {
  document.getElementById("dupFileDialog")?.remove();
  document.getElementById("dupFileBackdrop")?.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "dupFileBackdrop";
  backdrop.className = "biModalBackdrop";

  const dialog = document.createElement("div");
  dialog.id = "dupFileDialog";
  dialog.className = "biModal";
  dialog.style.maxHeight = "70vh";

  const matchSections = allDups.map(d => {
    const rows = d.hits.map(h => {
      const vLabel = h.version?.label || "song";
      const verId = h.version?.id || "";
      return `<div class="dupMatchRow" data-song-id="${h.song.id}" data-version-id="${verId}">
        <div class="dupMatchTitle">${escapeHtml(h.song.title)}</div>
        <div class="dupMatchSub">${escapeHtml(h.song.project || "")} · ${escapeHtml(vLabel)}</div>
      </div>`;
    }).join("");
    return `<div style="padding:6px 20px 2px;font-size:12px;color:rgba(255,255,255,.35);font-weight:600;">${escapeHtml(d.fileName)}</div>${rows}`;
  }).join("");

  const fileWord = allDups.length === 1 ? "file" : "files";

  dialog.innerHTML = `
    <div class="biModalHeader">
      <div class="biModalTitle">Possible Duplicates</div>
      <div class="biModalSub">${allDups.length} ${fileWord} already uploaded. Tap a match to view it:</div>
    </div>
    <div class="biModalBody" style="padding:0 0 8px;max-height:40vh;overflow-y:auto;">
      ${matchSections}
    </div>
    <div class="biModalActions">
      <button class="biModalBtn biModalRemove" id="dupCancel">Cancel</button>
      <button class="biModalBtn biModalDone" id="dupContinue">Import Anyway</button>
    </div>
  `;

  document.body.appendChild(backdrop);
  document.body.appendChild(dialog);

  requestAnimationFrame(() => {
    backdrop.classList.add("open");
    dialog.classList.add("open");
  });

  const close = () => {
    backdrop.classList.remove("open");
    dialog.classList.remove("open");
    setTimeout(() => { backdrop.remove(); dialog.remove(); }, 250);
  };

  backdrop.addEventListener("click", () => { close(); onDismiss?.(); });
  dialog.querySelector("#dupCancel")?.addEventListener("click", () => { close(); onDismiss?.(); });

  dialog.querySelector("#dupContinue")?.addEventListener("click", () => {
    close();
    onContinue?.();
  });

  dialog.querySelectorAll(".dupMatchRow").forEach(row => {
    row.addEventListener("click", () => {
      const songId = row.dataset.songId;
      const versionId = row.dataset.versionId;
      close();
      onDismiss?.();
      closeCreateOverlay();
      navigateForward(() => {
        R.currentTab = "songs";
        R.songsView = "list";
        R.selectedSongId = songId;
        R.selectedVersionId = versionId || null;
        setHeader("Song");
        syncTabs();
      });
    });
  });
}

/** Show a dialog when song name already exists in the project.
 *  fromCreate=true: single create overlay (offer to go to the song to add a version)
 */
function _showDuplicateSongDialog(existingSong, { fromCreate } = {}) {
  document.getElementById("dupSongDialog")?.remove();
  document.getElementById("dupSongBackdrop")?.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "dupSongBackdrop";
  backdrop.className = "biModalBackdrop";

  const dialog = document.createElement("div");
  dialog.id = "dupSongDialog";
  dialog.className = "biModal";

  const vCount = (existingSong.versions || []).length;
  const vLabel = `${vCount} version${vCount !== 1 ? "s" : ""}`;

  dialog.innerHTML = `
    <div class="biModalHeader">
      <div class="biModalTitle">Song Already Exists</div>
      <div class="biModalSub">
        <b>${escapeHtml(existingSong.title)}</b> already exists in <b>${escapeHtml(existingSong.project || "")}</b> with ${vLabel}.
      </div>
    </div>
    <div class="biModalBody" style="padding:12px 20px;">
      <div class="dupWarnBanner">Maybe you want to add a new version instead?<br>Tap below to go to the song and add a version from there.</div>
    </div>
    <div style="padding:0 20px;">
      <div class="dupMatchRow" id="dupGoToSong" style="border-radius:10px;background:rgba(255,255,255,.03);">
        <div class="dupMatchTitle">${escapeHtml(existingSong.title)}</div>
        <div class="dupMatchSub">${escapeHtml(existingSong.project || "")} · ${vLabel}</div>
      </div>
    </div>
    <div class="biModalActions">
      <button class="biModalBtn biModalRemove" id="dupSongCancel">Cancel</button>
    </div>
  `;

  document.body.appendChild(backdrop);
  document.body.appendChild(dialog);

  requestAnimationFrame(() => {
    backdrop.classList.add("open");
    dialog.classList.add("open");
  });

  const close = () => {
    backdrop.classList.remove("open");
    dialog.classList.remove("open");
    setTimeout(() => { backdrop.remove(); dialog.remove(); }, 250);
  };

  backdrop.addEventListener("click", close);
  dialog.querySelector("#dupSongCancel")?.addEventListener("click", close);

  dialog.querySelector("#dupGoToSong")?.addEventListener("click", () => {
    close();
    if (fromCreate) closeCreateOverlay();
    navigateForward(() => {
      R.currentTab = "songs";
      R.songsView = "list";
      R.selectedSongId = existingSong.id;
      R.selectedVersionId = null;
      setHeader("Song");
      syncTabs();
    });
  });
}

// ── Bulk Import staging state ──
// Each item: { id, file, title, project, existingSongId, existingSongTitle }
let bulkStagingFiles = [];

function openBulkImport() {
  pickAudioFiles().then(files => {
    if (!files.length) return;
    const defaultProject = state.settings?.defaultProject || "";
    bulkStagingFiles = files.map(f => ({
      id: uid(),
      file: f,
      title: f.name.replace(/\.[^.]+$/, "").trim(),
      project: defaultProject,
      existingSongId: null,
      existingSongTitle: null,
      _reviewed: false,
    }));

    // Check for file-name duplicates across all picked files
    const allDups = [];
    for (const f of files) {
      const hits = _findFileNameDuplicates(f.name);
      if (hits.length) allDups.push({ fileName: f.name, hits });
    }

    const proceedToStaging = () => {
      closeCreateOverlay();
      navigateForward(() => {
        R.overlayView = "bulkImport";
        setHeader(`Import (${bulkStagingFiles.length})`);
        syncTabs();
      });
    };

    if (allDups.length) {
      // Show a combined duplicate dialog for all flagged files
      _showBulkDuplicateFileDialog(allDups, {
        onContinue: proceedToStaging,
        onDismiss: () => { bulkStagingFiles = []; },
      });
    } else {
      proceedToStaging();
    }
  });
}

function renderBulkImport() {
  setHeader(`Import (${bulkStagingFiles.length})`);
  const appEl = document.querySelector(".app");
  appEl?.classList.add("collapseTitle");
  const h1 = appEl?.querySelector(".titleblock h1");
  if (h1) h1.style.opacity = "0";

  if (!bulkStagingFiles.length) {
    activeScreenEl.innerHTML = `<div class="setPage"><div class="setPageTitle">Import</div><div style="padding:24px 4px;opacity:.5;font-size:15px;">No files staged. Go back and pick files.</div></div>`;
    _setBulkCollapseTitle();
    return;
  }

  const cardHtml = (item) => {
    const fakeSong = { id: item.id, title: item.title, project: item.project, genre: "" };
    const sizeMB = (item.file.size / 1024 / 1024).toFixed(1);
    const ext = (item.file.name.match(/\.([^.]+)$/) || [, ""])[1].toUpperCase();
    const versionOf = item.existingSongId
      ? `+ version of ${escapeHtml(item.existingSongTitle || "song")}`
      : "";
    const artistLabel = item.project ? escapeHtml(item.project) : "No artist";

    // Check for warnings
    const fileDups = _findFileNameDuplicates(item.file.name);
    const nameDup = !item.existingSongId ? _findSongNameDuplicate(item.title, item.project) : null;
    const hasWarning = fileDups.length > 0 || nameDup;
    const warningBorder = hasWarning ? ` style="border:1px solid rgba(251,191,36,.3);border-radius:14px;"` : "";

    return `
      <div class="songCard biCard" data-bi="${item.id}">
        <div class="songCardStack"${warningBorder}>
          <div class="songCardLayer songCardLayer2"></div>
          <div class="songCardLayer songCardLayer1"></div>
          <div class="songCardFront">
            <div class="songCardArt">${coverSvg(fakeSong, { lite: true })}</div>
          </div>
        </div>
        <div class="songCardInfo">
          <div class="songCardTitleRow"><div class="songCardTitle">${escapeHtml(item.title)}</div></div>
          <div class="songCardSub">${artistLabel}</div>
          <div class="songCardSub" style="opacity:.4;font-size:11px;margin-top:1px;">${escapeHtml(item.file.name)} · ${ext} · ${sizeMB} MB</div>
          ${versionOf ? `<div class="songCardSub" style="color:#4ecdc4;font-size:11px;margin-top:1px;">${versionOf}</div>` : ""}
          ${hasWarning ? `<div class="songCardSub" style="color:#fbbf24;font-size:11px;margin-top:2px;">Possible duplicate</div>` : ""}
        </div>
      </div>
    `;
  };

  const readyItems = bulkStagingFiles.filter(f => f._reviewed);
  const reviewItems = bulkStagingFiles.filter(f => !f._reviewed);

  const sectionHtml = (label, count, items, extraClass) => {
    if (!items.length) return "";
    return `
      <div class="biSection ${extraClass || ""}">
        <div class="biSectionHeader">
          <span class="biSectionLabel">${label}</span>
          <span class="biSectionCount">${count}</span>
        </div>
        <div class="songsList">${items.map(f => cardHtml(f)).join("")}</div>
      </div>`;
  };

  activeScreenEl.innerHTML = `
    <div class="setPage" style="padding-bottom:140px;">
      <div class="setPageTitle">Import (${bulkStagingFiles.length})</div>
      <div style="font-size:13px;color:rgba(255,255,255,.4);padding:0 2px 16px;">Tap a card to edit title, project, or add as a version to an existing song.</div>
      ${sectionHtml("Review", reviewItems.length, reviewItems, "biSectionReview")}
      ${sectionHtml("Ready", readyItems.length, readyItems, "biSectionReady")}
    </div>
    <div class="biFooter">
      <button class="biImportBtn" id="biStartImport">Import ${bulkStagingFiles.length} Song${bulkStagingFiles.length !== 1 ? "s" : ""}</button>
    </div>
  `;

  // Wire card taps
  activeScreenEl.querySelectorAll(".biCard[data-bi]").forEach(el => {
    el.addEventListener("click", () => {
      const id = el.dataset.bi;
      const item = bulkStagingFiles.find(f => f.id === id);
      if (item) openBulkEditSheet(item);
    });
  });

  // Wire import button
  $("#biStartImport")?.addEventListener("click", () => startBulkImport());

  _setBulkCollapseTitle();
}

function _setBulkCollapseTitle() {
  if (activeScreenEl._collapseTitleScroll) {
    activeScreenEl.removeEventListener("scroll", activeScreenEl._collapseTitleScroll);
    activeScreenEl._collapseTitleScroll = null;
  }
  const _screen = activeScreenEl;
  const _sm = document.querySelector(".app.collapseTitle .titleblock h1");
  if (!_sm) return;
  requestAnimationFrame(() => {
    const bt = _screen.querySelector(".setPageTitle");
    if (!bt) return;
    const topbarEl = document.querySelector(".topbar");
    const screenTop = _screen.getBoundingClientRect().top;
    const topbarBottom = topbarEl ? topbarEl.getBoundingClientRect().bottom : 80;
    const fadeStart = bt.offsetTop - (topbarBottom - screenTop);
    const fadeEnd = fadeStart + (bt.offsetHeight || 40);
    const range = fadeEnd - fadeStart;
    const onScroll = () => {
      const progress = Math.min(1, Math.max(0, (_screen.scrollTop - fadeStart) / range));
      _sm.style.opacity = progress;
    };
    _screen._collapseTitleScroll = onScroll;
    _screen.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  });
}

// ── Bulk edit bottom sheet ──
// Collect ephemeral projects created during this staging session
function _biEphemeralProjects() {
  const real = new Set([
    ...(state.settings?.defaultProject ? [state.settings.defaultProject.trim()] : []),
    ...(state.projects || []).map(p => p.trim()).filter(Boolean),
    ...state.songs.map(s => (s.project || "").trim()).filter(Boolean),
  ]);
  const ephemeral = new Set();
  for (const f of bulkStagingFiles) {
    if (f.project && !real.has(f.project)) ephemeral.add(f.project);
  }
  return { real: [...real].sort(), ephemeral: [...ephemeral].sort() };
}

// Collect ephemeral songs created during this staging session
function _biEphemeralSongs() {
  // "Songs" from other staged files that will become new songs (not versions)
  return bulkStagingFiles
    .filter(f => !f.existingSongId && f.title)
    .map(f => ({ id: f.id, title: f.title, project: f.project || "", _staged: true }));
}

function openBulkEditSheet(item) {
  document.getElementById("biEditModal")?.remove();
  document.getElementById("biEditBackdrop")?.remove();

  const curIdx = bulkStagingFiles.indexOf(item);
  const hasNext = curIdx >= 0 && curIdx < bulkStagingFiles.length - 1;

  const { real: realProjects, ephemeral: ephemeralProjects } = _biEphemeralProjects();
  const allProjects = [...realProjects, ...ephemeralProjects];

  // Project cards HTML (same style as Create overlay)
  const projCardsHTML = allProjects.map(p => {
    const isSelected = item.project === p;
    const isEphemeral = ephemeralProjects.includes(p);
    const songCount = isEphemeral
      ? bulkStagingFiles.filter(f => f.project === p).length
      : state.songs.filter(s => (s.project || "").trim() === p).length;
    const countLabel = isEphemeral ? `${songCount} staged` : `${songCount} song${songCount !== 1 ? "s" : ""}`;
    return `
      <button class="coProjCard${isSelected ? " biProjSelected" : ""}" data-biproj="${escapeHtml(p)}">
        <div class="coProjArt">${isEphemeral
          ? `<div style="width:100%;height:100%;background:rgba(78,205,196,.1);border-radius:inherit;display:flex;align-items:center;justify-content:center;color:#4ecdc4;font-size:11px;font-weight:700;">NEW</div>`
          : getProjectCoverArt(p)}</div>
        <div class="coProjName">${escapeHtml(p)}</div>
        <div class="coProjCount">${countLabel}</div>
      </button>`;
  }).join("");

  const sizeMB = (item.file.size / 1024 / 1024).toFixed(1);
  const ext = (item.file.name.match(/\.([^.]+)$/) || [, ""])[1].toUpperCase();

  // Pre-check for file-name duplicates
  const fileDups = _findFileNameDuplicates(item.file.name);
  const fileDupHTML = fileDups.length
    ? `<div class="dupWarnBanner" style="margin:8px 20px 0;">
        This file name already exists. Tap to view:
        ${fileDups.map(h => `<div class="dupMatchRow" data-dup-song="${h.song.id}" data-dup-ver="${h.version?.id || ""}" style="padding:6px 0;border:none;">
          <span class="dupMatchTitle" style="font-size:13px;">${escapeHtml(h.song.title)}</span>
          <span class="dupMatchSub" style="font-size:11px;margin-left:4px;">${escapeHtml(h.version?.label || "")}</span>
        </div>`).join("")}
      </div>`
    : "";

  const backdrop = document.createElement("div");
  backdrop.id = "biEditBackdrop";
  backdrop.className = "biModalBackdrop";

  const modal = document.createElement("div");
  modal.id = "biEditModal";
  modal.className = "biModal";
  modal.innerHTML = `
    <div class="biModalHeader">
      <div class="biModalTitle">${escapeHtml(item.file.name)}</div>
      <div class="biModalSub">${ext} · ${sizeMB} MB${curIdx >= 0 ? ` · ${curIdx + 1} of ${bulkStagingFiles.length}` : ""}</div>
    </div>
    ${fileDupHTML}

    <div class="biModalBody">
      <div class="biField">
        <div class="biFieldLabel">Title</div>
        <input class="setInput" id="biEditTitle" type="text" value="${escapeHtml(item.title)}" />
        <div id="biDupWarn"></div>
      </div>

      <div class="biField">
        <div class="biFieldLabel">Project</div>
        <div class="coProjScroll" style="margin-top:6px;">
          ${projCardsHTML}
          <button class="coProjCard coProjNew" data-biproj="__new__">
            <div class="coProjArt"><div style="width:100%;height:100%;background:rgba(255,255,255,.06);border-radius:inherit;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.4);font-size:24px;font-weight:300">+</div></div>
            <div class="coProjName">New Project</div>
            <div class="coProjCount">Create new</div>
          </button>
        </div>
      </div>

      <div class="biField">
        <div class="biFieldLabel">Add as version to existing song</div>
        <div class="biSongPicker" id="biSongPicker">
          ${item.existingSongId
            ? `<div class="biPickedSong">
                <span>${escapeHtml(item.existingSongTitle || "Song")}</span>
                <button class="biPickedClear" id="biClearSong">&times;</button>
              </div>`
            : `<button class="biPickSongBtn" id="biOpenSongPicker">Select a song…</button>`
          }
        </div>
      </div>
    </div>

    <div class="biModalActions">
      <button class="biModalBtn biModalRemove" id="biRemoveFile">Remove</button>
      ${hasNext ? `<button class="biModalBtn biModalNext" id="biNextFile">Next</button>` : ""}
      <button class="biModalBtn biModalDone" id="biSaveEdit">Done</button>
    </div>
  `;

  document.body.appendChild(backdrop);
  document.body.appendChild(modal);

  // Track selected project within modal
  let selectedProject = item.project || "";
  let newProjectMode = false;

  requestAnimationFrame(() => {
    backdrop.classList.add("open");
    modal.classList.add("open");
  });

  // Save current edits into the item
  const _saveCurrentEdits = () => {
    item.title = (modal.querySelector("#biEditTitle")?.value || "").trim() || item.title;
    if (newProjectMode) {
      item.project = (modal.querySelector("#biNewProject")?.value || "").trim();
    } else {
      item.project = selectedProject;
    }
    item._reviewed = true;
  };

  // Lock body scroll while modal is open (prevents keyboard-triggered page scroll)
  document.body.style.overflow = "hidden";
  document.body.style.position = "fixed";
  document.body.style.width = "100%";

  const closeModal = () => {
    document.body.style.overflow = "";
    document.body.style.position = "";
    document.body.style.width = "";
    backdrop.classList.remove("open");
    modal.classList.remove("open");
    setTimeout(() => { backdrop.remove(); modal.remove(); }, 250);
  };

  backdrop.addEventListener("click", () => { _saveCurrentEdits(); closeModal(); renderBulkImport(); });

  // ── Live duplicate song-name validation ──
  const _checkBiDupName = () => {
    const title = (modal.querySelector("#biEditTitle")?.value || "").trim();
    const proj = newProjectMode
      ? (modal.querySelector("#biNewProject")?.value || "").trim()
      : selectedProject;
    const warnEl = modal.querySelector("#biDupWarn");
    const doneBtn = modal.querySelector("#biSaveEdit");
    if (!warnEl || !doneBtn) return;

    // Skip check if this item is set as a version of an existing song
    if (item.existingSongId) {
      warnEl.innerHTML = "";
      doneBtn.disabled = false;
      return;
    }

    const dup = _findSongNameDuplicate(title, proj);
    if (dup) {
      const vCount = (dup.versions || []).length;
      warnEl.innerHTML = `<div class="dupWarnBanner">
        A song named <b>${escapeHtml(dup.title)}</b> already exists in <b>${escapeHtml(dup.project || "")}</b> (${vCount} version${vCount !== 1 ? "s" : ""}).
        <br>Consider adding this as a <a id="biDupAddVersion">new version</a> of that song instead.
      </div>`;
      doneBtn.disabled = true;
      warnEl.querySelector("#biDupAddVersion")?.addEventListener("click", (e) => {
        e.preventDefault();
        item.existingSongId = dup.id;
        item.existingSongTitle = dup.title;
        const pickerEl = modal.querySelector("#biSongPicker");
        if (pickerEl) {
          pickerEl.innerHTML = `
            <div class="biPickedSong">
              <span>${escapeHtml(dup.title)}</span>
              <button class="biPickedClear" id="biClearSong">&times;</button>
            </div>`;
          pickerEl.querySelector("#biClearSong")?.addEventListener("click", (ev) => {
            ev.stopPropagation();
            item.existingSongId = null;
            item.existingSongTitle = null;
            pickerEl.innerHTML = `<button class="biPickSongBtn" id="biOpenSongPicker">Select a song…</button>`;
            pickerEl.querySelector("#biOpenSongPicker")?.addEventListener("click", openSongPickerPopup);
            _checkBiDupName();
          });
        }
        _checkBiDupName();
      });
    } else {
      warnEl.innerHTML = "";
      doneBtn.disabled = false;
    }
  };

  // Run initial check
  requestAnimationFrame(_checkBiDupName);

  // Watch title input
  modal.querySelector("#biEditTitle")?.addEventListener("input", _checkBiDupName);

  // Wire file-dup links to navigate to song/version
  modal.querySelectorAll("[data-dup-song]").forEach(row => {
    row.addEventListener("click", () => {
      const songId = row.dataset.dupSong;
      const verId = row.dataset.dupVer;
      closeModal();
      navigateForward(() => {
        R.currentTab = "songs";
        R.songsView = "list";
        R.selectedSongId = songId;
        R.selectedVersionId = verId || null;
        setHeader("Song");
        syncTabs();
      });
    });
  });

  // Project card selection
  modal.querySelectorAll("[data-biproj]").forEach(card => {
    card.addEventListener("click", () => {
      const val = card.dataset.biproj;
      if (val === "__new__") {
        _openNewProjectDialog(modal, (newName) => {
          if (!newName) return;
          selectedProject = newName;
          newProjectMode = false;
          // Re-render project cards with new project included
          // (it will show up as ephemeral on next openBulkEditSheet)
          // For now, just update item and visually mark
          item.project = newName;
          _saveCurrentEdits();
          closeModal();
          renderBulkImport();
          // Re-open to show updated project list
          requestAnimationFrame(() => openBulkEditSheet(item));
        });
      } else {
        newProjectMode = false;
        selectedProject = val;
      }
      // Update selected state visually
      modal.querySelectorAll("[data-biproj]").forEach(c => c.classList.remove("biProjSelected"));
      if (val !== "__new__") card.classList.add("biProjSelected");
      _checkBiDupName();
    });
  });

  // Song picker — opens a sub-popup with filterable list
  const openSongPickerPopup = () => {
    document.getElementById("biSongListPopup")?.remove();

    const ephemeralSongs = _biEphemeralSongs().filter(s => s.id !== item.id);
    const allSongs = [
      ...ephemeralSongs.map(s => ({ ...s, _label: "staged" })),
      ...state.songs.map(s => ({ id: s.id, title: s.title, project: s.project || "", _label: "" })),
    ];

    const popup = document.createElement("div");
    popup.id = "biSongListPopup";
    popup.className = "biSongPopup";
    popup.innerHTML = `
      <div class="biSongPopupHeader">
        <input class="setInput" id="biSongFilter" type="text" placeholder="Search songs…" />
      </div>
      <div class="biSongPopupList" id="biSongPopupList"></div>
      <button class="biSongPopupCancel" id="biSongPopupCancel">Cancel</button>
    `;
    modal.appendChild(popup);

    const listEl = popup.querySelector("#biSongPopupList");
    const filterInput = popup.querySelector("#biSongFilter");

    const renderList = (q) => {
      const lower = (q || "").toLowerCase();
      const filtered = lower
        ? allSongs.filter(s => (s.title || "").toLowerCase().includes(lower))
        : allSongs;
      listEl.innerHTML = filtered.slice(0, 30).map(s => `
        <div class="biSongPopupRow" data-spid="${s.id}">
          <div class="biSongPopupTitle">${escapeHtml(s.title)}</div>
          <div class="biSongPopupMeta">${escapeHtml(s.project)}${s._label ? ` · <span style="color:#4ecdc4">${s._label}</span>` : ""}</div>
        </div>
      `).join("") || `<div style="padding:16px;text-align:center;opacity:.4;font-size:13px;">No matches</div>`;

      listEl.querySelectorAll(".biSongPopupRow").forEach(row => {
        row.addEventListener("click", () => {
          const sid = row.dataset.spid;
          const picked = allSongs.find(s => s.id === sid);
          if (picked) {
            item.existingSongId = picked.id;
            item.existingSongTitle = picked.title;
            const pickerEl = modal.querySelector("#biSongPicker");
            if (pickerEl) {
              pickerEl.innerHTML = `
                <div class="biPickedSong">
                  <span>${escapeHtml(picked.title)}${picked._label ? ` <span style="color:#4ecdc4;font-size:11px;">(${picked._label})</span>` : ""}</span>
                  <button class="biPickedClear" id="biClearSong">&times;</button>
                </div>
              `;
              pickerEl.querySelector("#biClearSong")?.addEventListener("click", (e) => {
                e.stopPropagation();
                item.existingSongId = null;
                item.existingSongTitle = null;
                pickerEl.innerHTML = `<button class="biPickSongBtn" id="biOpenSongPicker">Select a song…</button>`;
                pickerEl.querySelector("#biOpenSongPicker")?.addEventListener("click", openSongPickerPopup);
              });
            }
          }
          popup.remove();
        });
      });
    };

    filterInput?.addEventListener("input", (e) => renderList(e.target.value));
    renderList("");
    setTimeout(() => filterInput?.focus(), 100);

    popup.querySelector("#biSongPopupCancel")?.addEventListener("click", () => popup.remove());
  };

  modal.querySelector("#biOpenSongPicker")?.addEventListener("click", openSongPickerPopup);

  // Clear song selection
  modal.querySelector("#biClearSong")?.addEventListener("click", (e) => {
    e.stopPropagation();
    item.existingSongId = null;
    item.existingSongTitle = null;
    const pickerEl = modal.querySelector("#biSongPicker");
    if (pickerEl) {
      pickerEl.innerHTML = `<button class="biPickSongBtn" id="biOpenSongPicker">Select a song…</button>`;
      pickerEl.querySelector("#biOpenSongPicker")?.addEventListener("click", openSongPickerPopup);
    }
    _checkBiDupName();
  });

  // Remove file
  modal.querySelector("#biRemoveFile")?.addEventListener("click", () => {
    bulkStagingFiles = bulkStagingFiles.filter(f => f.id !== item.id);
    closeModal();
    if (!bulkStagingFiles.length) {
      goBack({ animate: true });
    } else {
      renderBulkImport();
    }
  });

  // Next — save edits and open the next item
  modal.querySelector("#biNextFile")?.addEventListener("click", () => {
    _saveCurrentEdits();
    const nextItem = bulkStagingFiles[curIdx + 1];
    // Restore body scroll (openBulkEditSheet will re-lock it)
    document.body.style.overflow = "";
    document.body.style.position = "";
    document.body.style.width = "";
    backdrop.remove();
    modal.remove();
    renderBulkImport();
    if (nextItem) openBulkEditSheet(nextItem);
  });

  // Save / Done
  modal.querySelector("#biSaveEdit")?.addEventListener("click", () => {
    _saveCurrentEdits();
    closeModal();
    renderBulkImport();
  });
}

// ── New Project mini dialog (iOS-style center alert) ──
function _openNewProjectDialog(parentModal, onDone) {
  document.getElementById("biNewProjDialog")?.remove();
  document.getElementById("biNewProjDialogBg")?.remove();

  const bg = document.createElement("div");
  bg.id = "biNewProjDialogBg";
  bg.style.cssText = "position:fixed;inset:0;z-index:99995;background:rgba(0,0,0,.45);opacity:0;transition:opacity .15s ease;";

  const dlg = document.createElement("div");
  dlg.id = "biNewProjDialog";
  dlg.style.cssText = "position:fixed;z-index:99996;left:50%;top:50%;transform:translate(-50%,-50%) scale(.92);width:270px;background:#2a2a2e;border-radius:16px;padding:20px;opacity:0;transition:opacity .15s ease, transform .2s ease;";
  dlg.innerHTML = `
    <div style="font-size:16px;font-weight:700;color:#fff;text-align:center;margin-bottom:4px;">New Project</div>
    <div style="font-size:13px;color:rgba(255,255,255,.4);text-align:center;margin-bottom:14px;">Enter a name for your project</div>
    <input class="setInput" id="biNewProjInput" type="text" placeholder="Project name" style="margin-bottom:16px;" />
    <div style="display:flex;gap:10px;">
      <button id="biNewProjCancel" style="flex:1;padding:12px;border:none;border-radius:10px;background:rgba(255,255,255,.08);color:rgba(255,255,255,.5);font-size:15px;font-weight:600;cursor:pointer;">Cancel</button>
      <button id="biNewProjDone" style="flex:1;padding:12px;border:none;border-radius:10px;background:rgba(78,205,196,.15);color:#4ecdc4;font-size:15px;font-weight:600;cursor:pointer;">Done</button>
    </div>
  `;

  document.body.appendChild(bg);
  document.body.appendChild(dlg);

  requestAnimationFrame(() => {
    bg.style.opacity = "1";
    dlg.style.opacity = "1";
    dlg.style.transform = "translate(-50%,-50%) scale(1)";
  });
  setTimeout(() => dlg.querySelector("#biNewProjInput")?.focus(), 100);

  const closeDlg = () => {
    bg.style.opacity = "0";
    dlg.style.opacity = "0";
    dlg.style.transform = "translate(-50%,-50%) scale(.92)";
    setTimeout(() => { bg.remove(); dlg.remove(); }, 200);
  };

  bg.addEventListener("click", closeDlg);
  dlg.querySelector("#biNewProjCancel")?.addEventListener("click", closeDlg);
  dlg.querySelector("#biNewProjDone")?.addEventListener("click", () => {
    const name = (dlg.querySelector("#biNewProjInput")?.value || "").trim();
    closeDlg();
    if (name) onDone(name);
  });
  // Enter key submits
  dlg.querySelector("#biNewProjInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      dlg.querySelector("#biNewProjDone")?.click();
    }
  });
}

// ── Bulk import execution ──
async function startBulkImport() {
  if (!bulkStagingFiles.length) return;

  const items = [...bulkStagingFiles];
  const total = items.length;
  bulkStagingFiles = [];

  // Phase 1: Save all blobs to IndexedDB — show a blocking overlay
  const saveOverlay = document.createElement("div");
  saveOverlay.id = "biSaveOverlay";
  saveOverlay.style.cssText = "position:fixed;inset:0;z-index:999999;background:var(--bg,#0d0d0f);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:32px;";
  saveOverlay.innerHTML = `
    <div style="font-size:22px;font-weight:700;color:#fff;">Preparing Import</div>
    <div id="biSaveStatus" style="font-size:14px;color:rgba(255,255,255,.45);text-align:center;">Saving files locally… 0/${total}</div>
    <div style="width:200px;height:3px;background:rgba(255,255,255,.08);border-radius:2px;overflow:hidden;">
      <div id="biSaveBar" style="height:100%;width:0%;background:#4ecdc4;border-radius:2px;transition:width .2s ease;"></div>
    </div>
    <div style="font-size:12px;color:rgba(255,255,255,.25);margin-top:4px;">Please keep the app open</div>
  `;
  document.body.appendChild(saveOverlay);

  const saveStatusEl = saveOverlay.querySelector("#biSaveStatus");
  const saveBarEl = saveOverlay.querySelector("#biSaveBar");

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const idbKey = `import:${item.id}`;
    const pct = Math.round(((i + 1) / total) * 100);
    if (saveStatusEl) saveStatusEl.textContent = `Saving files locally… ${i + 1}/${total}`;
    if (saveBarEl) saveBarEl.style.width = pct + "%";

    try {
      await audioPut({
        id: idbKey,
        name: item.file.name || "audio",
        type: item.file.type || "audio/*",
        size: item.file.size || 0,
        blob: item.file,
        createdAt: nowStamp(),
      });
    } catch (e) {
      console.warn(`[BulkImport] Failed to save "${item.title}" locally:`, e);
    }
    // Build the queue entry — keep File ref for direct upload (won't survive restart,
    // but IDB fallback handles that case)
    importQueue.push({
      id: item.id,
      title: item.title,
      project: item.project || "Project",
      existingSongId: item.existingSongId || null,
      idbKey,
      _file: item.file,  // in-memory only — direct upload, no IDB round-trip
      fileName: item.file.name || "audio",
      fileType: item.file.type || "audio/*",
      fileSize: item.file.size || 0,
      status: "waiting",
      progress: 0,
      ts: Date.now(),
    });
  }
  _saveImportQueue();
  _updateNotifBadge();

  // Dismiss overlay
  saveOverlay.remove();

  // Navigate to Songs list
  R.overlayView = null;
  R.currentTab = "songs";
  R.songsView = "list";
  setHeader("Songs");
  syncTabs();
  render();

  // Phase 2: Upload from IndexedDB (resumable)
  await _processImportQueue();
}

// ── Staggered art generation for bulk imports ──
// Limits concurrent API calls and adds delays to avoid rate limiting.
async function _bulkGenerateArt(songIds) {
  const MAX_CONCURRENT = 1;
  const DELAY_MS = 12000; // 12s between starting each art request (6 req/min limit)
  const queue = [...songIds];
  let active = 0;
  const results = { success: 0, failed: 0 };

  return new Promise((resolve) => {
    function next() {
      if (!queue.length && active === 0) return resolve(results);
      while (queue.length && active < MAX_CONCURRENT) {
        const songId = queue.shift();
        const song = state.songs.find(s => s.id === songId);
        if (!song || song.coverImageUrl || song.coverPath) {
          results.success++;
          next();
          continue;
        }
        active++;
        generatingArtSongs.add(songId);
        coverCache.clear();
        render();
        generateArtForSong(song)
          .then(() => { coverCache.clear(); saveState(); results.success++; })
          .catch(e => { console.warn(`[BulkArt] Failed for "${song.title}":`, e); results.failed++; })
          .finally(() => {
            active--;
            generatingArtSongs.delete(songId);
            coverCache.clear();
            render();
            // Stagger the next request
            setTimeout(next, DELAY_MS);
          });
        // Don't start the next one immediately — wait for the delay
        return;
      }
    }
    next();
  });
}

// ── Post-import health check ──
// Verifies audio, sync, and cover art for all recently imported songs.
// Retries missing art generation for any songs that failed.
async function _postImportHealthCheck(songIds) {
  const issues = [];
  const missingArt = [];

  for (const id of songIds) {
    const song = state.songs.find(s => s.id === id);
    if (!song) continue;

    // Check audio
    const hasAudio = (song.versions || []).some(v => v.audioPath);
    if (!hasAudio) issues.push(`"${song.title}": no cloud audio`);

    // Check cover art
    if (!song.coverImageUrl && !song.coverPath) {
      missingArt.push(id);
    }
  }

  // Retry missing art with staggered queue
  if (missingArt.length) {
    console.log(`[PostImport] ${missingArt.length} song(s) missing art — retrying`);
    await _bulkGenerateArt(missingArt);
  }

  if (issues.length) {
    console.warn("[PostImport] Issues found:", issues);
  }
  console.log(`[PostImport] Health check complete: ${songIds.length} songs checked, ${issues.length} issues, ${missingArt.length} art retries`);
}

// Process any pending import queue items — called on startup and after staging.
// Lean path: upload blob directly to Supabase Storage (no compression),
// save locally under version fileId, one supabasePushState at the end.
let _importQueueRunning = false;
async function _processImportQueue() {
  if (_importQueueRunning) return;
  _importQueueRunning = true;

  const pending = importQueue.filter(q => q.status === "waiting" || q.status === "uploading");
  let imported = 0, failed = 0;

  // Pre-create song objects in state so art gen can find them immediately.
  // The upload loop will reuse these (it checks state.songs.find first).
  const newSongIds = [];
  for (const qItem of pending) {
    if (qItem.existingSongId) continue;
    if (state.songs.find(s => s.id === qItem.id)) { newSongIds.push(qItem.id); continue; }
    const song = {
      id: qItem.id, title: qItem.title, project: qItem.project,
      genre: "", sprint: state.settings?.defaultSprint || "Unsorted",
      instrumentation: "", collaborators: "", status: "Idea", stuckState: "Active",
      nextAction: "", vibes: "", lyrics: "", notes: "", versions: [],
      createdAt: nowStamp(), updatedAt: nowStamp(),
    };
    ensureProjectInState(song.project);
    state.songs.unshift(song);
    newSongIds.push(qItem.id);
  }
  if (newSongIds.length) saveState();

  // Start art generation concurrently with uploads (staggered, 12s apart).
  // Songs exist in state now, so _bulkGenerateArt can find them.
  const artPromise = newSongIds.length
    ? _bulkGenerateArt(newSongIds)
    : Promise.resolve({ success: 0, failed: 0 });

  for (const qItem of pending) {
    _updateImportQueueItem(qItem.id, { status: "uploading", progress: 5, statusText: "Reading file…" });

    // Prefer in-memory File ref (direct from phone) — fall back to IDB on resume
    let blob = qItem._file || null;
    if (!blob) {
      try {
        const rec = await audioGet(qItem.idbKey);
        blob = rec?.blob;
      } catch {}
    }

    if (!blob) {
      console.warn(`[BulkImport] No blob for "${qItem.title}" (no File ref, no IDB entry)`);
      _updateImportQueueItem(qItem.id, { status: "failed", progress: 0, statusText: "File not found" });
      failed++;
      continue;
    }

    _updateImportQueueItem(qItem.id, { progress: 15, statusText: "Creating song…" });

    try {
      let song, v;

      if (qItem.existingSongId) {
        song = getSong(qItem.existingSongId) || state.songs.find(s => s.id === qItem.existingSongId);
        if (!song) { _updateImportQueueItem(qItem.id, { status: "failed", progress: 0, statusText: "Song not found" }); failed++; continue; }
        v = createVersion(song);
      } else {
        song = state.songs.find(s => s.id === qItem.id);
        if (!song) {
          song = {
            id: qItem.id, title: qItem.title, project: qItem.project,
            genre: "", sprint: state.settings?.defaultSprint || "Unsorted",
            instrumentation: "", collaborators: "", status: "Idea", stuckState: "Active",
            nextAction: "", vibes: "", lyrics: "", notes: "", versions: [],
            createdAt: nowStamp(), updatedAt: nowStamp(),
          };
          ensureProjectInState(song.project);
          state.songs.unshift(song);
        }
        if ((song.versions || []).some(ver => ver.audioPath)) {
          imported++;
          _updateImportQueueItem(qItem.id, { status: "done", progress: 100, statusText: "Imported" });
          continue;
        }
        v = song.versions.length ? song.versions[0] : createVersion(song);
      }

      _updateImportQueueItem(qItem.id, { progress: 25, statusText: "Saving locally…" });

      // Set version metadata
      const audioId = uid();
      v.fileId = audioId;
      v.fileName = qItem.fileName;
      v.fileType = qItem.fileType;
      v.fileSize = qItem.fileSize;
      song.updatedAt = nowStamp();

      // Save blob locally under the version's fileId (for local playback) — best-effort
      try {
        await audioPut({
          id: audioId, name: qItem.fileName, type: qItem.fileType,
          size: qItem.fileSize, blob, createdAt: nowStamp(),
        });
      } catch (e) {
        console.warn(`[BulkImport] Local save failed for "${qItem.title}" (quota?) — cloud upload continues:`, e);
      }
      saveState();
      if (R.drawerView !== "alerts") render();

      _updateImportQueueItem(qItem.id, { progress: 40, statusText: "Uploading to cloud…" });

      // Upload directly to Supabase Storage from File ref — no IDB round-trip needed
      const result = await supabaseUploadAudio({
        blob: new File([blob], qItem.fileName, { type: qItem.fileType || "audio/*" }),
        songId: song.id, versionId: v.id, fileName: qItem.fileName,
      });

      if (result.success) {
        v.audioPath = result.audioPath;
        saveState();

        _updateImportQueueItem(qItem.id, { progress: 85, statusText: "Cleaning up…" });

        // Clean up import blob from IDB (real audio is under version fileId now)
        try { const db = await openAudioDb(); const tx = db.transaction(AUDIO_STORE, "readwrite"); tx.objectStore(AUDIO_STORE).delete(qItem.idbKey); db.close(); } catch {}

        imported++;
        _updateImportQueueItem(qItem.id, { status: "done", progress: 100, statusText: "Imported", songId: song.id });
      } else {
        console.warn(`[BulkImport] Upload failed for "${qItem.title}":`, result.error);
        // Keep import blob in IDB so retry can use it
        failed++;
        _updateImportQueueItem(qItem.id, { status: "failed", progress: 0, statusText: result.error || "Upload failed", songId: song.id, versionId: v.id });
      }

      if (R.drawerView !== "alerts") render();
    } catch (e) {
      console.warn(`[BulkImport] Failed for "${qItem.title}":`, e);
      _updateImportQueueItem(qItem.id, { status: "failed", progress: 0, statusText: e.message || "Failed" });
      failed++;
    }
  }

  // One push at the end — all songs + versions in a single batch
  // NOTE: _importQueueRunning stays true until after the final push so that
  // incrementalSyncFromSupabase() won't delete the newly-created songs
  // (cloud doesn't have them yet).
  if (imported) {
    await supabasePushState(state).catch(console.warn);
  }

  // Toast summary
  if (imported || failed) {
    _updateNotifBadge();
    toast(failed ? `Imported ${imported}, ${failed} failed` : `${imported} song${imported !== 1 ? "s" : ""} imported`);
  }

  // Wait for concurrent art generation to finish
  const artResults = await artPromise;
  if (artResults.failed) {
    console.log(`[BulkImport] Art gen: ${artResults.success} OK, ${artResults.failed} failed — running health check`);
  }

  // Post-import health check — verify audio, sync, and cover art; retry missing art
  const allImportedIds = pending.filter(q => !q.existingSongId).map(q => q.id);
  if (allImportedIds.length) {
    await _postImportHealthCheck(allImportedIds);
  }

  // Final push to capture any art paths added by health check
  if (imported) {
    await supabasePushState(state).catch(console.warn);
  }

  // All pushes are done — safe to let incremental sync run normally
  _importQueueRunning = false;

  // Keep all items — they'll be cleaned up after 24h by _pruneImportQueue()
  _saveImportQueue();
  _updateNotifBadge();
  if (R.drawerView === "alerts") _renderImportQueueDOM();
}

// normalizeAudioLink now in ui/dom.js

// Set of fileIds whose local blobs are known-bad (truncated/corrupt) — skip to cloud
const _badLocalBlobs = new Set();

async function getPlayableUrlForVersion(songId, versionId) {
  const song = getSong(songId);
  const v = getVersion(song, versionId);
  if (!song || !v) return null;

  // Priority 1a: Cloud audio — cached locally in IndexedDB (instant, no network)
  if (v.audioPath) {
    const cacheKey = `supa:${v.audioPath}`;
    if (audioUrlCache.has(cacheKey)) return audioUrlCache.get(cacheKey);

    const cached = await audioGet(`supa:${v.audioPath}`);
    if (cached?.blob?.size) {
      const url = URL.createObjectURL(cached.blob);
      audioUrlCache.set(cacheKey, url);
      return url;
    }
  }

  // Priority 1b: Cloud audio — live fetch from Supabase Storage
  if (v.audioPath) {
    const blob = await supabaseFetchAudioBlob(v.audioPath);
    if (blob?.size) {
      const url = URL.createObjectURL(blob);
      audioUrlCache.set(`supa:${v.audioPath}`, url);
      putAudioBlob({ id: `supa:${v.audioPath}`, blob, name: v.fileName || v.label || "audio", type: v.fileType || blob.type || "audio/*", size: blob.size }).catch(() => {});
      return url;
    }
    // Cloud file is missing or empty — clear the bad audioPath so isPlayable() reflects reality
    console.warn(`[Player] Cloud audio empty/missing for "${song.title}" — clearing audioPath`);
    supabaseDeleteAudio(v.audioPath).catch(() => {});
    v.audioPath = null;
    saveState();
  }

  // Priority 2: Direct URL link
  if (v.link) {
    return normalizeAudioLink(v.link);
  }

  // Priority 3: Local file (fileId in IndexedDB) — fallback only when cloud audio
  // hasn't been uploaded yet. This keeps local blobs usable while the background
  // upload sweep pushes them to the cloud.
  if (v.fileId && !_badLocalBlobs.has(v.fileId)) {
    const cacheKey = `file:${v.fileId}`;
    const cached = audioUrlCache.get(cacheKey);
    if (cached) return cached;

    const rec = await audioGet(v.fileId);
    if (rec?.blob) {
      if (v.fileSize && rec.blob.size < v.fileSize * 0.5) {
        console.warn(`[Player] Local blob for ${v.fileId} is ${rec.blob.size}B vs expected ${v.fileSize}B — skipping`);
      } else {
        const url = URL.createObjectURL(rec.blob);
        audioUrlCache.set(cacheKey, url);
        return url;
      }
    }
  }

  // Priority 4: Local audio (localAudioId — legacy path)
  if (v.localAudioId) {
    const url = await getLocalObjectUrl(v.localAudioId);
    if (url) return url;
  }

  return null;
}

// In-memory set of audioPaths known to be cached in IndexedDB
// cachedAudioPaths now exported as cachedAudioPaths from audio/audioDB.js

// cacheAllCloudAudio, backupAllAudioToCloud, ensureAllAudioInCloud now in audio/cloudSync.js

// Sync debug: check each version's audio availability
// Returns "green" (local + synced to cloud), "yellow" (local only, not backed up), "red" (no audio)
// getVersionSyncColor, getSongSyncColor, sharedBadge, sharedBadgeProject, syncDot now in ui/syncBadges.js

// Deep async audit: checks IndexedDB for actual blobs, logs a table to console
window.auditSync = async () => {
  const results = [];
  for (const song of (state.songs || [])) {
    for (const v of (song.versions || [])) {
      const row = {
        song: song.title,
        version: v.label || v.id,
        fileId: v.fileId ? "yes" : "",
        localAudioId: v.localAudioId ? "yes" : "",
        audioPath: v.audioPath ? "yes" : "",
        link: v.link ? "yes" : "",
        localBlobOk: "",
        cloudCacheOk: "",
        status: getVersionSyncColor(v),
      };
      // Check if local blob actually exists in IndexedDB
      if (v.fileId) {
        try { const r = await audioGet(v.fileId); row.localBlobOk = r?.blob ? "yes" : "MISSING"; } catch { row.localBlobOk = "ERROR"; }
        if (row.localBlobOk === "MISSING") row.status = "red";
      }
      if (v.localAudioId) {
        try { const r = await getAudioBlob(v.localAudioId); row.localBlobOk = r?.blob ? "yes" : "MISSING"; } catch { row.localBlobOk = "ERROR"; }
        if (row.localBlobOk === "MISSING" && !v.fileId) row.status = v.audioPath ? "yellow" : "red";
      }
      // Check if cloud blob is cached locally
      if (v.audioPath) {
        try { const r = await audioGet(`supa:${v.audioPath}`); row.cloudCacheOk = r?.blob ? "yes" : "no"; } catch { row.cloudCacheOk = "no"; }
      }
      results.push(row);
    }
  }
  console.table(results);
  const reds = results.filter(r => r.status === "red");
  const yellows = results.filter(r => r.status === "yellow");
  console.log(`[RiffBank Sync Audit] ${results.length} versions: ${reds.length} broken, ${yellows.length} cloud-only, ${results.length - reds.length - yellows.length} local`);
  if (reds.length) console.warn("Broken versions (no playable audio):", reds.map(r => `${r.song} / ${r.version}`));
  return results;
};

function getSongById(data, songId) {
  return (data.songs || []).find(s => s.id === songId);
}

function getVersionById(song, versionId) {
  if (!song) return null;
  return (song.versions || []).find(v => v.id === versionId);
}

function ensureVersionFlags(v) {
  if (!v) return v;
  if (typeof v.playerYes !== "boolean") v.playerYes = false;
  if (typeof v.favorite !== "boolean") v.favorite = false; // Player favorites
  return v;
}

function versionLabel(v) {
  const parts = [];
  if (v?.label) parts.push(v.label);
  if (v?.stamp) parts.push(v.stamp);
  return parts.filter(Boolean).join(" • ");
}

function pickCoverUrl(song, v) {
  // adjust if you have cover art fields already
  return v?.coverUrl || song?.coverUrl || "";
}

function playerItems(data) {
  const items = [];
  for (const s of (data.songs || [])) {
    if (!(s.versions || []).length) continue;
    // One row per song — always the active version (or first as fallback)
    // Prefer active version, but only if it has audio; otherwise pick first playable
    const vv = (s.versions.find(v => v.isActive && isPlayable(v))
             || s.versions.find(v => isPlayable(v))
             || s.versions[0]);
    const v = ensureVersionFlags(vv);
    items.push({
      songId: s.id,
      versionId: v.id,
      songName: s.title || "Untitled",
      artistName: s.artist || "You",
      project: s.project || "",
      coverUrl: pickCoverUrl(s, v),
      favorite: !!v.favorite,
      updatedAt: v.updatedAt || v.stamp || s.updatedAt || "",
      label: versionLabel(v)
    });
  }

  // filter
  let out = items;
  if (R.playerFilter === "projects") out = out.filter(x => x.project);
  // "playlists" and "releases" are future — show all for now
  // "all" = Riffs (default) — shows everything

  // sort
  if (R.playerSort === "title") {
    out = out.slice().sort((a,b) => a.songName.localeCompare(b.songName));
  } else {
    // "recent" (best effort): if no dates, keep natural order
    out = out.slice().sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  return out;
}

// shuffleArray now in ui/dom.js

// SW registration now in swRegister.js (imported as side-effect module)

let pendingScrollToUpload = false;

const songsListState = {
  sortMode: "updated",
  query: "",
  statusFilter: "",
  projectFilter: "",
  ownerFilter: "all", // "all" | "mine" | "shared"
};

let projectsOwnerFilter = "all"; // "all" | "mine" | "shared"


// ---------------------
// Drawer open/close
// ---------------------

function setDrawerView(v) {
  R.drawerView = v;
  R.selectedSongId = null;
  render();
}

function setHeader(t) {
  if (headerTitle) headerTitle.textContent = t;
  const appEl = document.querySelector(".app");
  appEl?.classList.remove("pdActive", "pdScrolled", "collapseTitle");
  // Reset inline opacity from collapse scroll listener
  const h1El = appEl?.querySelector(".titleblock h1");
  if (h1El) h1El.style.opacity = "";
  // Restore screen padding when leaving project detail
  document.querySelectorAll(".screen").forEach(s => s.style.paddingBottom = "");
}

// Show/hide the back button based on whether we're on a nested screen
const ROOT_TABS = new Set(["home", "player"]);
function syncBackButton() {
  if (!headerBackEl) return;
  // Profile is always root — never show back button
  if (R.currentTab === "profile") { headerBackEl.style.display = "none"; return; }
  // Collab root — no sidebar, hide back button
  const onCollabRoot = R.currentTab === "collab" && !R.overlayView && !R.selectedSongId && !R.projectDetailScreen && !R.drawerView;
  if (onCollabRoot) { headerBackEl.style.display = "none"; return; }
  const onRoot =
    ROOT_TABS.has(R.currentTab) &&
    !R.drawerView &&
    !R.overlayView &&
    !R.selectedSongId &&
    !R.selectedVersionId &&
    !R.projectDetailScreen &&
    !R.releaseDetailId &&
    R.songsView !== "create";
  headerBackEl.style.display = onRoot ? "none" : "flex";
}

// Wire back button once
headerBackEl?.addEventListener("click", () => {
  goBack({ animate: true });
});

function syncTabs() {
  const highlightTab = R.currentTab === "songs" ? "home" : R.currentTab;
  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === highlightTab);
  });
  syncProfileNavIcon();
}

// getSong, getVersion now in state.js

function createVersion(song) {
  if (!song) return null;

  const vNum = (song.versions?.length || 0) + 1;

  const v = {
    id: uid(),
    label: `${song.title || "Song"} - v${vNum}`,
    notes: "",
    link: "",
    isActive: true,
    createdAt: nowStamp(),
  };

  song.versions = Array.isArray(song.versions) ? song.versions : [];
  // New version becomes the active one — deactivate all others
  song.versions.forEach(x => x.isActive = false);
  song.versions.unshift(v);
  song.updatedAt = nowStamp();

  saveState();
  return v;
}

// featuredVersion now in state.js

function playVersion(songId, versionId, { goPlayer = true } = {}) {
  const song = getSong(songId);
  const v = getVersion(song, versionId);
  if (!song || !v || (!v.link && !v.fileId && !v.localAudioId && !v.audioPath))
    return toast("No playable audio for that version 😅");

  state.player.nowPlaying = { songId, versionId };
  state.player.shuffle = false;  // ← ADD
  state.player.repeat = false;   // ← ADD
  saveState();
  toast("Playing ▶️");

    // ✅ unlock inside the tap gesture
  unlockAudioOnce();

  // start audio immediately (user gesture-safe)
  playNowPlaying({ autoplay: true });

  if (goPlayer) {
    R.drawerView = null;
    R.overlayView = null;
    R.selectedSongId = null;
    R.selectedVersionId = null;
    R.currentTab = "player";
    setHeader("Player");
    syncTabs();
    render();
  } else {
    // even if we don’t go to player, show the mini bar
    syncMiniPlayerUI();
  }
}

function addToQueue(songId, versionId) {
  const song = getSong(songId);
  const v = getVersion(song, versionId);
  if (!song || !v || (!v.link && !v.fileId && !v.localAudioId && !v.audioPath))
  return toast("No playable audio for that version 😅");

  state.player.queue.push({ songId, versionId });
  saveState();
  toast("Queued ➕");
}

function setActive(songId, versionId){
  const song = getSong(songId);
  const v = getVersion(song, versionId);
  if (!song || !v) return;
  song.versions.forEach(x => x.isActive = (x.id === versionId));
  song.updatedAt = nowStamp();
  saveState();
}

function drivePathFor(song) {
  const root = slug(state.settings.driveRoot || "RiffBank");
  const project = slug(song.project || "Project");
  const title = slug(song.title || "Untitled");
  return `${root}/${project}/${title}/Versions`;
}

function suggestedFileName(song, originalFileName) {
  const extMatch = (originalFileName || "").match(/\.([a-z0-9]+)$/i);
  const ext = extMatch ? extMatch[1] : "wav";
  const title = slug(song.title || "Untitled");
  const vNum = (song.versions?.length || 0) + 1;
  const stamp = nowStamp();
  return `${title} - v${vNum} - ${stamp}.${ext}`;
}

async function copyText(txt) {
  if (!txt) return;

  try {
    // Preferred modern path
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(txt);
      toast("Copied 📋");
      return;
    }
  } catch {
    // fall through to legacy
  }

  // Legacy fallback (works in more edge cases)
  try {
    const ta = document.createElement("textarea");
    ta.value = txt;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast("Copied 📋");
  } catch {
    toast("Couldn’t copy 😅");
  }
}

function badgeForStatus(status) {
  const s = (status || "Idea").toLowerCase();
  if (s === "done" || s === "released")
    return `<span class="badge good">✅ ${escapeHtml(status)}</span>`;
  if (s === "mix" || s === "master" || s === "ready")
    return `<span class="badge warn">⚡ ${escapeHtml(status)}</span>`;
  return `<span class="badge">🎧 ${escapeHtml(status || "Idea")}</span>`;
}


// Create button in bottom nav
document.querySelector(".createNavBtn")?.addEventListener("click", () => openCreateOverlay());

// salSvg, dismissOnboarding, showWelcomeScreen, showDriveScreen now in ui/onboarding.js

// Profile nav button — inject user avatar into nav icon
// syncProfileNavIcon now in ui/avatars.js

// Unread message badge — updates Collab nav icon + Messages sidebar button
let _unreadMsgCount = 0;
let _prevUnreadMsgCount = 0;
let _prevPendingFriendCount = 0;
// Track which friend requests we've already created notifications for
let _knownFriendRequestIds = new Set(
  _loadNotifications().filter(n => n.friendshipId).map(n => n.friendshipId)
);

// Request notification permission — must be called from a user gesture (tap/click)
// on iOS PWAs. Calling during boot is silently ignored.
let _notifPermissionAsked = false;
async function requestNotificationPermission() {
  if (_notifPermissionAsked) return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "default") { _notifPermissionAsked = true; return; }
  _notifPermissionAsked = true;
  await Notification.requestPermission();
}

// Attach notification permission request to first user tap anywhere in the app.
// This satisfies iOS's user-gesture requirement.
function _attachNotifPermissionToGesture() {
  if (!("Notification" in window) || Notification.permission !== "default") return;
  const handler = () => {
    requestNotificationPermission();
    document.removeEventListener("click", handler, true);
    document.removeEventListener("touchend", handler, true);
  };
  document.addEventListener("click", handler, true);
  document.addEventListener("touchend", handler, true);
}

// Show a local push notification for new messages
function _showMessageNotification(newCount) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && R.overlayView === "chat") return; // user is in chat
  const count = newCount - _prevUnreadMsgCount;
  if (count <= 0) return;

  const reg = navigator.serviceWorker?.controller ? navigator.serviceWorker.ready : null;
  if (reg) {
    reg.then(r => {
      r.showNotification("RiffBank", {
        body: count === 1 ? "You have a new message" : `You have ${count} new messages`,
        icon: "/icon-1024.png",
        badge: "/icon-1024.png",
        tag: "riffbank-new-message",
        renotify: true,
        data: { url: "/" },
      });
    }).catch(() => {});
  }
}

// Show an OS-level push notification via ServiceWorker (if permitted)
// title: notification title (e.g. sender name), body: message text, icon: profile pic URL
function _showPushNotification(body, tag, { title, icon } = {}) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible") return; // don't spam if app is open
  const reg = navigator.serviceWorker?.controller ? navigator.serviceWorker.ready : null;
  if (reg) {
    reg.then(r => {
      r.showNotification(title || "RiffBank", {
        body,
        icon: icon || "/icon-1024.png",
        badge: "/icon-1024.png",
        tag: tag || "riffbank-notification",
        renotify: true,
        data: { url: "/" },
      });
    }).catch(() => {});
  }
}

// Update PWA app badge (home screen icon badge)
function _updateAppBadge(count) {
  if ("setAppBadge" in navigator) {
    if (count > 0) navigator.setAppBadge(count).catch(() => {});
    else navigator.clearAppBadge().catch(() => {});
  }
}

function syncMessageBadges() {
  Promise.all([
    getUnreadMessageCount().catch(() => 0),
    fetchPendingFriendCount().catch(() => 0),
  ]).then(([msgCount, friendCount]) => {
    // Show notification if new messages arrived since last check
    if (msgCount > _unreadMsgCount) {
      _showMessageNotification(msgCount);
    }
    // Detect new friend requests and add to notification inbox
    if (friendCount > _prevPendingFriendCount && _prevPendingFriendCount >= 0) {
      _addFriendRequestNotifications();
    }
    _prevUnreadMsgCount = _unreadMsgCount;
    _unreadMsgCount = msgCount;
    _prevPendingFriendCount = getPendingFriendCount();
    setPendingFriendCount(friendCount);
    _applyAllBadges(msgCount, friendCount);
  });
}

// Fetch pending friend requests and add notifications for any we haven't seen
function _addFriendRequestNotifications() {
  getPendingFriendRequests().then(requests => {
    for (const r of requests) {
      if (_knownFriendRequestIds.has(r.id)) continue;
      _knownFriendRequestIds.add(r.id);
      const name = r.profile?.display_name || "Someone";
      addNotification({
        title: "Friend Request",
        body: `${name} sent you a friend request`,
        type: "friend_request",
        friendshipId: r.id,
        requesterName: name,
        requesterId: r.requester_id,
        avatarUrl: r.profile?.avatar_url || null,
      });
    }
  }).catch(() => {});
}

function _applyAllBadges(msgCount, friendCount) {
  const total = (msgCount || 0) + (friendCount || 0);
  // Collab tab nav badge
  const navBadge = document.getElementById("collabNavBadge");
  if (navBadge) { navBadge.textContent = total || ""; navBadge.style.display = total ? "flex" : "none"; }
  // Inline back button badge (slides with content)
  const inlineBadge = document.querySelector(".collabInlineBadge");
  if (inlineBadge) { inlineBadge.textContent = total || ""; inlineBadge.style.display = total ? "flex" : "none"; }
  // Header back button badge
  const backBadge = document.getElementById("headerBackBadge");
  if (backBadge) { backBadge.style.display = "none"; }
  // Messages sidebar badge
  const msgBadge = document.querySelector(".msgBadge");
  if (msgBadge) { msgBadge.textContent = msgCount || ""; msgBadge.style.display = msgCount ? "flex" : "none"; }
  // Friends sidebar badge
  const fb = document.querySelector(".friendsBadge");
  if (fb) { fb.textContent = friendCount || ""; fb.style.display = friendCount ? "flex" : "none"; }
  // PWA home screen app badge
  _updateAppBadge(total);
}

// Poll message badges every 10s
setInterval(syncMessageBadges, 10000);

// Shared data polling disabled — fetch on-demand from Collab tab only

// Also check when app comes back to foreground
let _lastForegroundSync = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    syncMessageBadges();
    // Re-pull from Supabase when app comes to foreground (cross-device sync).
    // Throttle to at most once per 30 seconds to avoid hammering the DB.
    const now = Date.now();
    if (now - _lastForegroundSync > 30_000 && !_importQueueRunning) {
      _lastForegroundSync = now;
      incrementalSyncFromSupabase().catch(console.warn);
    }
  }
});

// Shared flag: true while PTR has visually displaced content (blocks elastic overscroll)
let _ptrBusy = false;

// ── Pull-to-refresh ──────────────────────────────────────
(() => {
  const THRESHOLD = 40;        // px to pull before triggering refresh
  const MAX_PULL = 80;         // px visual cap
  const SPINNER_SIZE = 32;
  let _ptrActive = false;
  let _ptrStartY = 0;
  let _ptrDist = 0;
  let _ptrRefreshing = false;

  // Create the spinner element
  const spinner = document.createElement("div");
  spinner.className = "ptrSpinner";
  spinner.innerHTML = `<svg viewBox="0 0 24 24" width="${SPINNER_SIZE}" height="${SPINNER_SIZE}"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="50 14"/></svg>`;
  document.querySelector(".app")?.appendChild(spinner);

  // Elements that stay pinned (not pulled down)
  const PINNED_SELS = ".songsTitleRow, .songsHead, .songsBar, .sdFab, .homeTopbar, .homeGreet, .playerHead, .setPageTitle, .songsPageTitle, .collabPillBar";
  // Subset used to measure where the spinner should appear (top headers only, not FABs etc.)
  const HEADER_SELS = ".songsTitleRow, .songsHead, .songsBar, .homeTopbar, .homeGreet, .playerHead, .setPageTitle, .songsPageTitle, .collabPillBar";

  // Get only the content elements that should move (skip pinned)
  function _getContentEls() {
    if (!activeScreenEl) return [];
    const els = [];
    for (const child of activeScreenEl.children) {
      if (child.matches?.(PINNED_SELS)) continue;
      els.push(child);
    }
    return els;
  }

  // Get the bottom edge of the lowest header element (for spinner positioning)
  function _getHeaderBottom() {
    if (!activeScreenEl) return 0;
    let bottom = 0;
    for (const child of activeScreenEl.children) {
      if (child.matches?.(HEADER_SELS)) {
        const rect = child.getBoundingClientRect();
        if (rect.bottom > bottom) bottom = rect.bottom;
      }
    }
    return bottom || activeScreenEl.getBoundingClientRect().top;
  }

  function _setContentOffset(px) {
    for (const el of _getContentEls()) {
      el.style.transform = px ? `translateY(${px}px)` : "";
    }
  }

  function _resetContent(animate) {
    for (const el of _getContentEls()) {
      if (animate) {
        el.style.transition = "transform .3s cubic-bezier(.2,.9,.3,1)";
        el.style.transform = "";
        const ref = el;
        const onEnd = () => { ref.style.transition = ""; ref.removeEventListener("transitionend", onEnd); };
        ref.addEventListener("transitionend", onEnd);
      } else {
        el.style.transition = "";
        el.style.transform = "";
      }
    }
  }

  // Cascading shimmer on song cards after refresh
  function _shimmerCards() {
    if (!activeScreenEl) return;
    const cards = activeScreenEl.querySelectorAll(".songCard, .songsGroup, .hCard, .collabSectionContent > *, .songRow, .pCard");
    cards.forEach((el, i) => {
      el.style.animationDelay = `${i * 50}ms`;
      el.classList.add("ptrShimmer");
    });
    setTimeout(() => {
      cards.forEach(el => { el.classList.remove("ptrShimmer"); el.style.animationDelay = ""; });
    }, cards.length * 50 + 600);
  }

  // Screens where pull-to-refresh is allowed (root list views only)
  const PTR_SCREENS = new Set(["screen-songs", "screen-collab", "screen-drawer"]);

  document.addEventListener("touchstart", (e) => {
    if (_ptrRefreshing) return;
    // Block PTR while full player is open or being dismissed
    if (R.isFullPlayerOpen || document.getElementById("fullPlayer")) return;
    if (!activeScreenEl || activeScreenEl.scrollTop > 1) return;
    // Only allow PTR on root list screens (not detail views)
    if (!PTR_SCREENS.has(activeScreenEl.id)) return;
    // Block on detail views (song detail, version detail, project detail, etc.)
    if (R.selectedSongId || R.selectedVersionId || R.projectDetailScreen || R.overlayView) return;
    if (R.drawerView && R.drawerView !== "projects" && R.drawerView !== "releases") return;
    const t = e.changedTouches?.[0];
    if (!t || t.clientX <= 30) return;
    _ptrStartY = t.clientY;
    _ptrActive = true;
    _ptrDist = 0;
  }, { passive: true });

  let _headerBase = 0; // cached header bottom for spinner positioning

  document.addEventListener("touchmove", (e) => {
    if (!_ptrActive || _ptrRefreshing) return;
    const t = e.changedTouches?.[0];
    if (!t) return;
    const dy = t.clientY - _ptrStartY;
    if (dy < 0) {
      // User reversed direction — cancel PTR for this touch entirely
      if (_ptrDist > 0) {
        _resetContent(false);
        spinner.style.opacity = "0";
        spinner.style.transform = `translate(-50%, 0) scale(0)`;
        spinner.classList.remove("ptrReady");
      }
      _ptrDist = 0;
      _ptrActive = false;
      _ptrBusy = false;
      return;
    }
    // Prevent native overscroll so only our elastic effect moves content
    e.preventDefault();
    _ptrBusy = true;
    // Cache header bottom on first move
    if (_ptrDist === 0) _headerBase = _getHeaderBottom();
    // Dampen the pull (sqrt curve for elastic rubbery feel)
    _ptrDist = Math.min(MAX_PULL, Math.sqrt(dy) * 4);
    const progress = Math.min(1, _ptrDist / THRESHOLD);
    // Elastic: push only content down (headers stay pinned)
    _setContentOffset(_ptrDist);
    // Spinner grows in the gap below the header
    const spinnerTop = _headerBase + _ptrDist / 2 - SPINNER_SIZE / 2;
    const scale = Math.min(1, progress);
    spinner.style.transform = `translate(-50%, ${spinnerTop}px) scale(${scale})`;
    spinner.style.opacity = String(progress);
    spinner.querySelector("svg").style.transform = `rotate(${_ptrDist * 4}deg)`;
    if (_ptrDist >= THRESHOLD) spinner.classList.add("ptrReady");
    else spinner.classList.remove("ptrReady");
  }, { passive: false });

  document.addEventListener("touchend", () => {
    if (!_ptrActive) return;
    _ptrActive = false;
    if (_ptrDist >= THRESHOLD && !_ptrRefreshing) {
      _ptrRefreshing = true;
      spinner.classList.add("ptrRefreshing");
      spinner.classList.remove("ptrReady");
      // Hold content down at threshold while refreshing
      _setContentOffset(THRESHOLD);
      const spinnerTop = _headerBase + THRESHOLD / 2 - SPINNER_SIZE / 2;
      spinner.style.transition = "transform .2s ease";
      spinner.style.transform = `translate(-50%, ${spinnerTop}px) scale(1)`;
      spinner.style.opacity = "1";
      setTimeout(() => { spinner.style.transition = ""; }, 200);
      Promise.all([
        incrementalSyncFromSupabase().catch(console.warn),
        refreshSharedData().then(() => { setCollabFriendsCache(null); setCollabConvosCache(null); render(); }).catch(() => {}),
      ]).finally(() => {
        _ptrRefreshing = false;
        _ptrBusy = false;
        spinner.classList.remove("ptrRefreshing");
        // Snap spinner away
        spinner.style.transition = "transform .3s ease, opacity .3s ease";
        spinner.style.transform = `translate(-50%, 0) scale(0)`;
        spinner.style.opacity = "0";
        setTimeout(() => { spinner.style.transition = ""; }, 300);
        // render() replaced the DOM, so clear transforms on the new elements
        _resetContent(false);
        // Ensure scroll stays at top (PTR only fires from top)
        if (activeScreenEl) activeScreenEl.scrollTop = 0;
        // Shimmer the cards
        setTimeout(_shimmerCards, 100);
      });
    } else {
      // Cancel — snap back
      spinner.style.transition = "transform .3s cubic-bezier(.2,.9,.3,1), opacity .3s ease";
      spinner.style.transform = `translate(-50%, 0) scale(0)`;
      spinner.style.opacity = "0";
      spinner.classList.remove("ptrReady");
      setTimeout(() => { spinner.style.transition = ""; }, 300);
      _resetContent(true);
    }
    _ptrDist = 0;
    _ptrBusy = false;
  }, { passive: true });
})();

// ── Bottom elastic overscroll (iOS-style rubber band) ────────────────
(() => {
  const MAX_BOUNCE = 80;
  let _ebActive = false;   // true once finger is past the bottom edge
  let _ebAnchorY = 0;      // clientY where bottom was first hit
  let _ebDist = 0;
  let _ebTracking = false;  // true while any eligible touch is down
  let _ebLastY = 0;
  let _ebBouncing = false;  // true during momentum bounce animation
  const EB_SCREENS = new Set(["screen-songs", "screen-player", "screen-collab", "screen-settings", "screen-drawer"]);

  // Velocity tracking for momentum bounce
  let _ebVSamples = [];     // { t, y } recent touch samples

  function _isAtBottom(el) {
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
  }

  const EB_SKIP = ".sdFab";
  function _getElasticEls() {
    if (!activeScreenEl) return [];
    const els = [];
    for (const child of activeScreenEl.children) {
      if (child.matches?.(EB_SKIP)) continue;
      els.push(child);
    }
    return els;
  }

  function _isEligible() {
    if (_ptrBusy) return false;
    if (!activeScreenEl || !EB_SCREENS.has(activeScreenEl.id)) return false;
    if (R.selectedSongId || R.selectedVersionId || R.projectDetailScreen || R.overlayView) return false;
    if (R.drawerView && R.drawerView !== "projects" && R.drawerView !== "releases") return false;
    if (R.isFullPlayerOpen || document.getElementById("fullPlayer")) return false;
    return true;
  }

  function _springBack() {
    if (_ebDist <= 0) return;
    for (const el of _getElasticEls()) {
      el.style.transition = "transform .4s cubic-bezier(.2,1,.3,1)";
      el.style.transform = "";
      const ref = el;
      const onEnd = () => { ref.style.transition = ""; ref.removeEventListener("transitionend", onEnd); };
      ref.addEventListener("transitionend", onEnd);
    }
    _ebDist = 0;
  }

  // Momentum bounce: triggered when a fast scroll slams into the bottom
  function _momentumBounce(velocity) {
    if (_ebBouncing || !_isEligible()) return;
    // velocity = px/ms (positive = scrolling down toward bottom)
    // Only bounce if fast enough
    if (velocity < 0.8) return;
    _ebBouncing = true;
    const bouncePx = Math.min(MAX_BOUNCE, Math.sqrt(velocity * 100) * 4);
    const els = _getElasticEls();
    // Phase 1: quick stretch
    for (const el of els) {
      el.style.transition = `transform .15s cubic-bezier(.1,.6,.3,1)`;
      el.style.transform = `translateY(${-bouncePx}px)`;
    }
    // Phase 2: spring back
    setTimeout(() => {
      for (const el of els) {
        el.style.transition = "transform .45s cubic-bezier(.2,1,.3,1)";
        el.style.transform = "";
        const ref = el;
        const onEnd = () => {
          ref.style.transition = "";
          ref.removeEventListener("transitionend", onEnd);
          _ebBouncing = false;
        };
        ref.addEventListener("transitionend", onEnd);
      }
      // Safety: clear bouncing flag even if transitionend doesn't fire
      setTimeout(() => { _ebBouncing = false; }, 500);
    }, 150);
  }

  // Detect momentum scroll hitting bottom
  let _ebPrevScrollTop = 0;
  let _ebPrevScrollTime = 0;
  let _ebTouchDown = false;

  document.addEventListener("touchstart", (e) => {
    _ebTouchDown = true;
    _ebBouncing = false; // cancel any in-progress bounce if user touches
    const t = e.changedTouches?.[0];
    if (!t || t.clientX <= 30) { _ebTracking = false; return; }
    // Always track the touch — eligibility is checked in touchmove
    // so elastic can activate mid-touch after PTR releases
    _ebTracking = true;
    _ebActive = false;
    _ebDist = 0;
    _ebLastY = t.clientY;
    _ebVSamples = [{ t: Date.now(), y: t.clientY }];
    // If eligible and already at bottom, activate immediately
    if (_isEligible() && _isAtBottom(activeScreenEl)) {
      _ebActive = true;
      _ebAnchorY = t.clientY;
    }
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!_ebTracking) return;
    // Check eligibility on every move so elastic can activate after PTR releases mid-touch
    if (!_isEligible()) {
      if (_ebDist > 0) { _ebDist = 0; for (const el of _getElasticEls()) el.style.transform = ""; }
      _ebActive = false;
      return;
    }
    const t = e.changedTouches?.[0];
    if (!t) return;
    const now = Date.now();
    _ebLastY = t.clientY;

    // Track velocity samples (keep last 5)
    _ebVSamples.push({ t: now, y: t.clientY });
    if (_ebVSamples.length > 5) _ebVSamples.shift();

    // Not yet at bottom — check if we just arrived
    if (!_ebActive) {
      if (_isAtBottom(activeScreenEl)) {
        // Just hit the bottom mid-gesture! Start elastic from here
        _ebActive = true;
        _ebAnchorY = t.clientY;
        _ebDist = 0;
      }
      return;
    }

    // We're in elastic territory
    const dy = _ebAnchorY - t.clientY; // positive = pulling further past bottom
    if (dy <= 0) {
      // User reversed — reset elastic but stay active
      if (_ebDist > 0) {
        _ebDist = 0;
        for (const el of _getElasticEls()) el.style.transform = "";
      }
      // Update anchor so elastic restarts smoothly if they reverse again
      _ebAnchorY = t.clientY;
      return;
    }
    // Verify still at bottom (user might scroll content back up)
    if (!_isAtBottom(activeScreenEl)) {
      _ebActive = false;
      _ebDist = 0;
      for (const el of _getElasticEls()) el.style.transform = "";
      return;
    }
    e.preventDefault();
    _ebDist = Math.min(MAX_BOUNCE, Math.sqrt(dy) * 4);
    for (const el of _getElasticEls()) {
      el.style.transform = `translateY(${-_ebDist}px)`;
    }
  }, { passive: false });

  document.addEventListener("touchend", () => {
    _ebTouchDown = false;
    if (!_ebTracking) return;
    _ebTracking = false;
    _ebActive = false;
    _springBack();

    // Compute release velocity for momentum tracking
    if (_ebVSamples.length >= 2 && activeScreenEl) {
      const first = _ebVSamples[0];
      const last = _ebVSamples[_ebVSamples.length - 1];
      const dt = last.t - first.t;
      if (dt > 0) {
        const vel = (first.y - last.y) / dt; // px/ms, positive = scrolling down
        if (vel > 0.3) {
          // User was flicking down — set up scroll listener for momentum hit
          _ebPrevScrollTop = activeScreenEl.scrollTop;
          _ebPrevScrollTime = Date.now();
        }
      }
    }
    _ebVSamples = [];
  }, { passive: true });

  // Listen for scroll events to detect momentum hitting the bottom
  document.getElementById("appScreens")?.addEventListener("scroll", () => {
    if (_ebTouchDown || _ebBouncing || !activeScreenEl) return;
    if (!_isEligible()) return;
    const now = Date.now();
    const st = activeScreenEl.scrollTop;
    const dt = now - _ebPrevScrollTime;

    if (_isAtBottom(activeScreenEl) && dt > 0 && dt < 300) {
      // Estimate velocity from recent scroll delta
      const scrollDelta = st - _ebPrevScrollTop;
      if (scrollDelta > 0) {
        const vel = scrollDelta / dt; // px/ms
        _momentumBounce(vel);
      }
    }
    _ebPrevScrollTop = st;
    _ebPrevScrollTime = now;
  }, { passive: true, capture: true });
})();

// openSalSheet, openSalOnboarding now in ui/onboarding.js

// Tabs
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetTab = btn.dataset.tab || "home";

    // Already on home root with no overlays — nothing to do
    if (targetTab === "home" && R.currentTab === "home" && nav.depth === 0 && !R.drawerView && !R.overlayView) {
      return;
    }

    // If tapping home while deep in a nav stack, jump straight to home
    if (targetTab === "home" && nav.depth > 0) {
      nav.slideTransition({ direction: "jumpHome", mutate: () => {
        R.songsBackTarget = null;
        R.drawerView = null;
        R.overlayView = null;
        R.selectedSongId = null;
        R.selectedVersionId = null;
        R.projectDetailScreen = null;
        R.releaseDetailId = null;
        R.songsView = "list";
        R.songsListScrollTop = 0;
        R.collabMode = false;
        R.songsFromCollab = false;
        R.currentTab = "home";
        if (screens.home) screens.home.scrollTop = 0;
        try { window.scrollTo(0, 0); } catch {}
        try { document.documentElement.scrollTop = 0; } catch {}
        try { document.body.scrollTop = 0; } catch {}
        syncTabs();
        setHeader("RiffBank");
        render();
      }});
      return;
    }

    R.songsBackTarget = null;
    nav.clearStacks();

    // Normal navigation
    R.drawerView = null;
    R.overlayView = null;
    R.selectedSongId = null;
    R.selectedVersionId = null;
    R.projectDetailScreen = null;
    R.releaseDetailId = null;
    R.songsView = "list";
    R.songsListScrollTop = 0;
    R.collabMode = false;
    R.songsFromCollab = false;

    R.currentTab = targetTab;
    if (targetTab === "player") {
      R.playerScreen = "list";
    }
    if (targetTab === "collab") {
      R.collabPill = "projects";
    }

    if (targetTab === "home") {
      if (screens.home) screens.home.scrollTop = 0;
      try { window.scrollTo(0, 0); } catch {}
      try { document.documentElement.scrollTop = 0; } catch {}
      try { document.body.scrollTop = 0; } catch {}
    }

    syncTabs();
    setHeader(TAB_TITLES[R.currentTab] || "RiffBank");
    render();
  });
});

// Tap header to go Home (feels app-y)
headerTitle?.addEventListener("click", () => {
  // Ignore taps when already on a root tab with no nav depth — prevents ghost
  // back-button behaviour on Collab/Home/Player root screens where the collapsed
  // titleblock overlaps the area where a back chevron would appear.
  const onRoot = ROOT_TABS.has(R.currentTab) || R.currentTab === "collab" || R.currentTab === "profile";
  if (onRoot && nav.depth === 0 && !R.drawerView && !R.overlayView && !R.selectedSongId && !R.projectDetailScreen) return;

  const resetToHome = () => {
    R.drawerView = null;
    R.overlayView = null;
    R.selectedSongId = null;
    R.selectedVersionId = null;
    R.projectDetailScreen = null;
    R.releaseDetailId = null;
    R.songsView = "list";
    R.songsListScrollTop = 0;
    R.collabMode = false;
    R.currentTab = "home";
    R.songsBackTarget = null;
    nav.clearStacks();
    if (screens.home) screens.home.scrollTop = 0;
    try { window.scrollTo(0, 0); } catch {}
    try { document.documentElement.scrollTop = 0; } catch {}
    try { document.body.scrollTop = 0; } catch {}
    syncTabs();
    setHeader("RiffBank");
    render();
  };

  // If on home tab with nav depth, jump straight to home; otherwise snap
  if (R.currentTab === "home" && nav.depth > 0) {
    nav.slideTransition({ direction: "jumpHome", mutate: resetToHome });
  } else {
    resetToHome();
  }
});

// ---------------------
// Hidden audio picker wiring
// ---------------------
const audioPickerEl = document.getElementById("audioFilePicker");
let audioPickerCtx = null; // { songId, versionId }

audioPickerEl?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file || !audioPickerCtx) return;

  try {
    const { songId, versionId } = audioPickerCtx;
    const song = getSong(songId);
    const v = getVersion(song, versionId);
    if (!song || !v) return toast("Couldn’t find that version 😅");

    toast("Uploading to cloud…");
    await attachSharedAudio(song, v, file, file.name || "audio", file.type || "audio/*", file.size || 0);
    render(); // refresh UI
  } catch (err) {
    console.error(err);
    toast("Import failed 😭");
  } finally {
    // reset so picking the same file twice still triggers change
    e.target.value = "";
    audioPickerCtx = null;
  }
});

// ---------------------
// iOS slide-back animation (back button)
// ---------------------
function slideBackTransition(renderUnderneath) {
  nav.slideTransition({ direction: "back", mutate: renderUnderneath });
}

function goBack({ animate = false } = {}) {
  // Prevent double-back while a View Transition is still in flight
  if (nav._transitionActive) return;
  const doRender = () => {
    // Resolve the state to restore: animated backs already popped in slideTransition/nav.back()
    // (pendingBackState), non-animated backs pop here.
    let restoreState = animate ? nav.consumePendingState() : nav.popStacks();

    if (restoreState) {
      R.currentTab = restoreState.currentTab;
      R.drawerView = restoreState.drawerView;
      R.projectDetailScreen = restoreState.projectDetailScreen;
      R.releaseDetailId = restoreState.releaseDetailId;
      R.selectedSongId = restoreState.selectedSongId;
      R.selectedVersionId = restoreState.selectedVersionId;
      R.songsView = restoreState.songsView;
      R.overlayView = restoreState.overlayView;
      R.friendProfileId = restoreState.friendProfileId ?? null;
      R.songsBackTarget = restoreState.songsBackTarget;
      R.lyricsEditSongId = restoreState.lyricsEditSongId ?? null;
      R.collabMode = restoreState.collabMode ?? false;
      R.songsFromCollab = restoreState.songsFromCollab ?? false;
      R.settingsView = restoreState.settingsView ?? null;
      R.collabPill = restoreState.collabPill ?? "projects";
      // Going back to home resets songs scroll so next visit starts fresh
      if (restoreState.currentTab === "home" && !restoreState.drawerView) R.songsListScrollTop = 0;
      setHeader(restoreState.headerTitle);
      syncTabs();
      nav._isBackNav = true;
      render();
      nav._isBackNav = false;
      // Restore scroll position (for non-animated / swipe-back path)
      if (nav._restoredScrollTop && activeScreenEl) {
        activeScreenEl.scrollTop = nav._restoredScrollTop;
      }
      return;
    }

    // Fallback: no state stack entry (e.g. legacy or root-level back)
    if (R.overlayView) {
      R.overlayView = null;
      R.currentTab = "home";
      R.drawerView = null;
      R.selectedSongId = null;
      R.songsView = "list";
      R.songsListScrollTop = 0;
      nav.clearStacks();
      setHeader("RiffBank");
      syncTabs();
      render();
      return;
    }

    if (R.currentTab !== "home" || R.drawerView) {
      R.currentTab = "home";
      R.drawerView = null;
      R.projectDetailScreen = null;
      R.releaseDetailId = null;
      R.songsView = "list";
      R.songsListScrollTop = 0;
      R.selectedSongId = null;
      R.selectedVersionId = null;
      R.collabMode = false;
      nav.clearStacks();
      setHeader("RiffBank");
      syncTabs();
      render();
      return;
    }
  };

  if (animate) slideBackTransition(doRender);
  else doRender();
}

// ---------------------
// Swipe gestures
// ---------------------
let touchStartX = 0;
let touchStartY = 0;
let touchTracking = false;
let touchMode = null;

// Swipe-back state — purely visual overlays, no state changes during gesture
let swipeQueenEl = null;    // frozen clone of current screen (follows finger)
let swipeAceEl = null;      // frozen clone of previous screen (parallaxes underneath)
let swipeShadow = null;     // dimming overlay between ace and queen
let swipeActive = false;    // whether a swipe-back gesture is in progress

document.addEventListener("touchstart", (e) => {
  const t = e.changedTouches?.[0];
  if (!t) return;

// Left-edge gesture — swipe back
if (t.clientX <= 24) {
  // Player has nothing to go back to; bare home/collab root has nothing to go back to
  if (R.currentTab === "player") return;
  if (R.currentTab === "collab" && !R.projectDetailScreen && !R.selectedSongId && !R.overlayView) return;
  if (R.currentTab === "home" && !R.drawerView && !R.overlayView) return;

  touchTracking = true;
  touchMode = "back";
  touchStartX = t.clientX;
  touchStartY = t.clientY;
  if (touchMode === "back") {
    // Guard: no transition during flight, must have state to go back to
    if (nav._transitionActive || nav.stateStack.length === 0) {
      touchTracking = false; touchMode = null; return;
    }

    const navBottomOffset = nav._bottomOffset();
    const appRect = document.querySelector(".app")?.getBoundingClientRect();
    const appTop = appRect?.top ?? 0;
    const appLeft = appRect?.left ?? 0;
    const appWidth = appRect?.width ?? window.innerWidth;

    // Helper: position a full-app clone as a fixed overlay
    function positionAppClone(clone, zIndex) {
      clone.querySelector("#bottomNav")?.remove();
      clone.querySelector("#sheetOverlay")?.remove();
      clone.querySelector("#createSheet")?.remove();
      const s = clone.style;
      s.position = "fixed";
      s.top = `${appTop}px`;
      s.left = `${appLeft}px`;
      s.width = `${appWidth}px`;
      s.height = "auto";
      s.bottom = navBottomOffset;
      s.zIndex = String(zIndex);
      s.overflow = "hidden";
      s.pointerEvents = "none";
      s.margin = "0";
      s.background = "var(--bg)";
      return clone;
    }

    // Restore scrollTop on a clone's active screen — must be called AFTER
    // the clone is in the DOM, because scrollTop has no effect on detached nodes.
    function restoreCloneScroll(clone, scrollTop) {
      const cloneScreen = clone.querySelector(".screen.is-active");
      if (cloneScreen) cloneScreen.scrollTop = scrollTop;
    }

    // 1. Queen: frozen clone of the CURRENT app state (follows finger)
    const capture = nav._captureApp();
    if (capture) {
      swipeQueenEl = positionAppClone(capture.clone, 501);
      // Bake fixed-position FAB into absolute pixel coords so it stays
      // visible inside the overflow:hidden clone (same as nav.back())
      const queenFab = swipeQueenEl.querySelector('.sdFab');
      if (queenFab) {
        const liveFab = document.querySelector('.sdFab');
        if (liveFab) {
          const fr = liveFab.getBoundingClientRect();
          queenFab.style.position = 'absolute';
          queenFab.style.top = `${fr.top}px`;
          queenFab.style.left = `${fr.left}px`;
          queenFab.style.bottom = 'auto';
          queenFab.style.right = 'auto';
          swipeQueenEl.appendChild(queenFab);
        }
      }
      document.body.appendChild(swipeQueenEl);
      restoreCloneScroll(swipeQueenEl, capture.scrollTop);
    }

    // 2. Ace: frozen clone of the PREVIOUS app state (captured during forward nav)
    //    Same technique as queen — full _captureApp() clone, pixel-perfect
    const aceCapture = nav.appStack.length > 0 ? nav.appStack[nav.appStack.length - 1] : null;
    if (aceCapture) {
      const aceClone = nav._cloneDeep(aceCapture.clone);
      swipeAceEl = positionAppClone(aceClone, 499);
      // Bake fixed-position FAB into absolute coords (same as queen)
      const aceFab = swipeAceEl.querySelector('.sdFab');
      if (aceFab) {
        // Try live FAB for position; if current screen has no FAB, compute from CSS
        const liveFab = document.querySelector('.sdFab');
        if (liveFab) {
          const fr = liveFab.getBoundingClientRect();
          aceFab.style.position = 'absolute';
          aceFab.style.top = `${fr.top}px`;
          aceFab.style.left = `${fr.left}px`;
          aceFab.style.bottom = 'auto';
          aceFab.style.right = 'auto';
        } else {
          // No live FAB on current screen — compute position from viewport
          const dockH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dock-h')) || 80;
          aceFab.style.position = 'absolute';
          aceFab.style.top = `${window.innerHeight - dockH - 24 - 52}px`;
          aceFab.style.left = `${window.innerWidth - 20 - 52}px`;
          aceFab.style.bottom = 'auto';
          aceFab.style.right = 'auto';
        }
        swipeAceEl.appendChild(aceFab);
      }
      swipeAceEl.style.transform = `translateX(-${nav.ACE_PARALLAX}px)`;
      document.body.appendChild(swipeAceEl);
      restoreCloneScroll(swipeAceEl, aceCapture.scrollTop);
    }

    // 3. Shadow between ace and queen for depth
    swipeShadow = document.createElement("div");
    swipeShadow.style.cssText = "position:fixed;inset:0;z-index:500;background:rgba(0,0,0,.35);pointer-events:none;";
    document.body.appendChild(swipeShadow);

    swipeActive = true;
  }
  return;
}

}, { passive: true });

document.addEventListener("touchmove", (e) => {
  // Collab sidebar swipe (independent of nav touchTracking)
  if (_sidebarSwipe.tracking) { const st = e.changedTouches?.[0]; if (st) _sidebarTouchMove(st); }

  if (!touchTracking) return;
  const t = e.changedTouches?.[0];
  if (!t) return;

  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;

  if (Math.abs(dx) <= 10 || Math.abs(dx) <= Math.abs(dy)) return;

  if (touchMode === "back") {
    const clamp = Math.max(0, dx);
    const ratio = Math.min(clamp / window.innerWidth, 1);
    // Queen (frozen clone): follow finger
    if (swipeQueenEl) swipeQueenEl.style.transform = `translateX(${clamp}px)`;
    // Ace (frozen clone): parallax from -ACE_PARALLAX toward 0
    if (swipeAceEl) swipeAceEl.style.transform = `translateX(${-nav.ACE_PARALLAX * (1 - ratio)}px)`;
    // Shadow fades as queen reveals ace
    if (swipeShadow) swipeShadow.style.opacity = 1 - ratio;
    return;
  }

}, { passive: true });

function cleanupSwipe() {
  if (swipeQueenEl) { swipeQueenEl.remove(); swipeQueenEl = null; }
  if (swipeAceEl) { swipeAceEl.remove(); swipeAceEl = null; }
  if (swipeShadow) { swipeShadow.remove(); swipeShadow = null; }
  swipeActive = false;
}

document.addEventListener("touchend", (e) => {
  // Collab sidebar swipe (independent of nav touchTracking)
  if (_sidebarSwipe.tracking) { _sidebarTouchEnd(e.changedTouches?.[0]); }

  if (!touchTracking) return;
  const t = e.changedTouches?.[0];

  if (touchMode === "back") {
    const dx = t ? t.clientX - touchStartX : 0;
    const threshold = window.innerWidth * 0.38;

    if (dx >= threshold && swipeActive) {
      // Commit: animate overlays, then goBack() handles actual navigation
      const dur = 250;
      const ease = "cubic-bezier(.4,0,.2,1)";
      if (swipeQueenEl) { swipeQueenEl.style.transition = `transform ${dur}ms ${ease}`; swipeQueenEl.style.transform = `translateX(${window.innerWidth}px)`; }
      if (swipeAceEl) { swipeAceEl.style.transition = `transform ${dur}ms ${ease}`; swipeAceEl.style.transform = "translateX(0)"; }
      if (swipeShadow) { swipeShadow.style.transition = `opacity ${dur}ms ${ease}`; swipeShadow.style.opacity = "0"; }
      setTimeout(() => {
        cleanupSwipe();
        // Same door, different handle — goBack() does the real navigation
        goBack({ animate: false });
      }, dur);
    } else {
      // Cancel: spring queen back, remove overlays — no state to restore
      const dur = swipeActive ? 200 : 0;
      if (swipeQueenEl) { swipeQueenEl.style.transition = `transform ${dur}ms ease-out`; swipeQueenEl.style.transform = "translateX(0)"; }
      if (swipeAceEl) { swipeAceEl.style.transition = `transform ${dur}ms ease-out`; swipeAceEl.style.transform = `translateX(-${nav.ACE_PARALLAX}px)`; }
      if (swipeShadow) { swipeShadow.style.transition = `opacity ${dur}ms ease-out`; swipeShadow.style.opacity = "1"; }
      setTimeout(() => cleanupSwipe(), dur);
    }
    touchTracking = false;
    touchMode = null;
    return;
  }

  touchTracking = false;
  touchMode = null;
}, { passive: true });

miniToggleEl?.addEventListener("click", async (e) => {
  e.stopPropagation();
  if (!globalAudio) return;

  // ✅ unlock inside the tap gesture
  await unlockAudioOnce();

  if (globalAudio.paused) {
    try {
      await globalAudio.play();
    } catch {
      await playNowPlaying({ autoplay: true });
    }
  } else {
    globalAudio.pause();
  }
});

// Hard stop + reset to "fresh launch" state (no mini player, no overlay, no audio playing)
function stopAndResetPlayback() {
  // Stop audio immediately
  try { globalAudio.pause(); } catch {}
  try { globalAudio.currentTime = 0; } catch {}

  // Detach the current source so iOS stops the media session cleanly
  try {
    globalAudio.removeAttribute("src");
    globalAudio.load();
  } catch {}

  // Clear app playback state
  if (state.player) {
    state.player.nowPlaying = null;
    state.player.queue = [];
  }

  // Fresh-launch behavior: mini player stays hidden until a new play action this session
  hasPlayedThisSession = false;

  // Clear any lingering inline transform/transition from swipe gestures
  // so the CSS classes can properly position the mini player when it reappears
  if (miniPlayerEl) {
    miniPlayerEl.style.transform = "";
    miniPlayerEl.style.transition = "";
  }

  // Ensure fullscreen overlay is fully closed + removed from hit testing
  try { closeNowPlaying(); } catch {}
  setFullPlayerOpen(false);

  saveState();
  syncMiniPlayerUI();
  scheduleDockSpaceSync();
}

// Mini player: swipe-down to dismiss, swipe L/R to skip tracks
{
  let mpDir = null; // null | 'x' | 'y'
  let mpStartX = 0;
  let mpStartY = 0;

  miniPlayerEl?.addEventListener("touchstart", (e) => {
    if (!miniPlayerEl || e.touches.length !== 1) return;
    if (e.target.closest("#miniToggle, #miniScrub")) return;
    mpDir = null;
    mpStartX = e.touches[0].clientX;
    mpStartY = e.touches[0].clientY;
    miniPlayerEl.dataset.dragDy = "0";
    miniPlayerEl.dataset.didDrag = "0";
    miniPlayerEl.dataset.swipeDx = "0";
  }, { passive: true });

  miniPlayerEl?.addEventListener("touchmove", (e) => {
    if (!miniPlayerEl || e.touches.length !== 1 || mpStartX === 0) return;
    const t = e.touches[0];
    const dx = t.clientX - mpStartX;
    const dy = t.clientY - mpStartY;

    if (!mpDir && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      mpDir = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }

    if (mpDir === 'x') {
      const inner = miniPlayerEl.querySelector('.miniSwipeInner');
      // Rubber band: apply 18% resistance when swiping in a "dead" direction
      const goingNext = dx < 0;
      const repeatOne = state.player?.repeat === "one";
      const canGo = repeatOne ? false : goingNext
        ? ((state.player?.queue || []).length > 0 || state.player?.repeat === true)
        : ((state.player?.playHistory || []).length > 0);
      const effectiveDx = canGo ? dx : dx * 0.18;
      if (inner) { inner.style.transition = 'none'; inner.style.transform = `translateX(${effectiveDx}px)`; }
      miniPlayerEl.dataset.didDrag = "1";
      miniPlayerEl.dataset.swipeDx = String(dx); // store raw dx for threshold
    } else if (mpDir === 'y') {
      const dyDown = Math.max(0, dy);
      if (dyDown < 14) return;
      miniPlayerEl.dataset.didDrag = "1";
      miniPlayerEl.dataset.dragDy = String(dyDown);
      miniPlayerEl.style.transition = "none";
      miniPlayerEl.style.transform = `translateX(-50%) translateY(${Math.min(dyDown, 240)}px)`;
    }
  }, { passive: true });

  miniPlayerEl?.addEventListener("touchend", () => {
    if (!miniPlayerEl) return;
    const didDrag = miniPlayerEl.dataset.didDrag === "1";
    const dy = parseFloat(miniPlayerEl.dataset.dragDy || "0");
    const dx = parseFloat(miniPlayerEl.dataset.swipeDx || "0");
    const dir = mpDir;
    delete miniPlayerEl.dataset.dragDy;
    delete miniPlayerEl.dataset.didDrag;
    delete miniPlayerEl.dataset.swipeDx;
    mpDir = null; mpStartX = 0; mpStartY = 0;

    if (dir === 'x') {
      const inner = miniPlayerEl.querySelector('.miniSwipeInner');
      if (didDrag && Math.abs(dx) > 55) {
        const goNext = dx < 0;
        // Dead swipe check
        const repeatOne = state.player?.repeat === "one";
        const canGoForward = !repeatOne && ((state.player?.queue || []).length > 0 || state.player?.repeat === true);
        const canGoBack = !repeatOne && ((state.player?.playHistory || []).length > 0);
        const isDead = goNext ? !canGoForward : !canGoBack;
        if (isDead) {
          // Rubber band spring back
          if (inner) { inner.style.transition = 'transform 386ms cubic-bezier(.36,.07,.19,.97)'; inner.style.transform = 'translateX(0)'; }
          return;
        }
        const flyTo   = goNext ? '-110%' : '110%';
        const comeFrom = goNext ? '110%' : '-110%';

        // Pre-render the next/prev song for a seamless carousel slide
        let peekSong = null;
        if (goNext) {
          const nextRef = (state.player?.queue || [])[0];
          if (nextRef) peekSong = getSong(nextRef.songId);
        } else {
          const prevRef = (state.player?.playHistory || []).at?.(-1);
          if (prevRef) peekSong = getSong(prevRef.songId);
        }

        // Build ghost card starting off-screen on the incoming side
        const ghost = document.createElement('div');
        ghost.className = 'miniSwipeInner';
        ghost.style.cssText = `position:absolute;top:0;left:0;right:0;bottom:0;transform:translateX(${comeFrom});transition:none;`;
        if (peekSong) {
          let peekArt = '';
          try { peekArt = coverSvg(peekSong, { lite: true }); } catch {}
          ghost.innerHTML = `<div class="miniArt" aria-hidden="true">${peekArt}</div><div class="miniMeta"><div class="miniTitle">${escapeHtml(peekSong.title || 'Untitled')}</div><div class="miniSub">${escapeHtml(peekSong.project || '')}</div></div>`;
        }
        const swipeZone = miniPlayerEl.querySelector('.miniSwipeZone');
        if (swipeZone) swipeZone.appendChild(ghost);

        // Slide current out and ghost in simultaneously (true carousel)
        if (inner) { inner.style.transition = 'transform 236ms ease'; inner.style.transform = `translateX(${flyTo})`; }
        requestAnimationFrame(() => requestAnimationFrame(() => {
          ghost.style.transition = 'transform 236ms ease';
          ghost.style.transform = 'translateX(0)';
        }));

        miniPlayerEl.dataset.suppressClick = "1";
        setTimeout(() => {
          if (goNext) advanceToNextTrack({ render: false });
          else        advanceToPrevTrack({ render: false });
          _miniCarouselDir = 0; // swipe already animated — suppress duplicate carousel in syncMiniPlayerUI
          ghost.remove();
          if (inner) { inner.style.transition = 'none'; inner.style.transform = 'translateX(0)'; }
          syncMiniPlayerUI();
        }, 257);
      } else {
        if (inner) { inner.style.transition = 'transform 193ms ease'; inner.style.transform = 'translateX(0)'; }
      }
    } else {
      if (didDrag && dy > 12) { stopAndResetPlayback(); return; }
      miniPlayerEl.style.transition = "transform 171ms ease";
      miniPlayerEl.style.transform = "translateX(-50%) translateY(0px)";
    }
  }, { passive: true });
}

miniPlayerEl?.addEventListener("click", (e) => {
  const isControl = e.target.closest("#miniToggle, #miniScrub");
  if (miniPlayerEl?.dataset?.suppressClick === "1") {
    delete miniPlayerEl.dataset.suppressClick;
    return;
  }
  if (isControl) return;
  if (!state.player?.nowPlaying) return;

  R.prevTabBeforeFullPlayer = R.currentTab;
  R.prevSelectedSongIdBeforeFullPlayer = R.selectedSongId;

  // Clear any drawer/project state so the render router reaches the player
  R.drawerView = null;
  R.projectDetailScreen = null;

  R.currentTab = "player";
  R.playerScreen = "now";
  setHeader("Now Playing");
  syncTabs();
  render();
});

miniScrubEl?.addEventListener("pointerdown", (e) => e.stopPropagation());
miniScrubEl?.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

// Spacebar toggles play/pause (like Spotify / YouTube)
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  // Don't intercept when typing in an input, textarea, or contenteditable
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
  e.preventDefault();
  if (!globalAudio || !state.player?.nowPlaying) return;
  if (globalAudio.paused) {
    globalAudio.play().catch(() => {});
  } else {
    globalAudio.pause();
  }
});

globalAudio?.addEventListener("play", () => {
  syncMiniPlayerUI();
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
});
globalAudio?.addEventListener("pause", () => {
  syncMiniPlayerUI();
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
});
// Advance to the next track, respecting repeat (queue-level loop) and shuffle.
// Returns true if something will play, false if queue is truly empty.
function advanceToNextTrack({ render: doRender = false } = {}) {
  // Repeat one: loop the current song without touching the queue
  if (state.player?.repeat === "one" && globalAudio) {
    globalAudio.currentTime = 0;
    globalAudio.play().catch(() => {});
    return true;
  }

  const q = state.player?.queue || [];

  // Helper: find next playable item in a queue, skipping unplayable entries
  function shiftPlayable(arr) {
    while (arr.length) {
      const candidate = arr.shift();
      const s = getSong(candidate.songId);
      const ver = s ? getVersion(s, candidate.versionId) : null;
      if (ver && isPlayable(ver)) return candidate;
    }
    return null;
  }

  if (q.length) {
    const next = shiftPlayable(q);
    if (next) {
      if (state.player.nowPlaying) {
        if (!state.player.playHistory) state.player.playHistory = [];
        state.player.playHistory.push(state.player.nowPlaying);
      }
      _miniCarouselDir = 1; // forward → slide left
      state.player.nowPlaying = next;
      saveState();
      playNowPlaying({ autoplay: true });
      if (doRender) render();
      return true;
    }
  }
  // Queue exhausted — rebuild from repeatQueue if repeat-all is on
  if (state.player?.repeat === true) {
    const rq = state.player?.repeatQueue || [];
    if (rq.length) {
      const fresh = state.player.shuffle ? shuffleArray([...rq]) : [...rq];
      const next = shiftPlayable(fresh);
      if (next) {
        if (state.player.nowPlaying) {
          if (!state.player.playHistory) state.player.playHistory = [];
          state.player.playHistory.push(state.player.nowPlaying);
        }
        _miniCarouselDir = 1; // forward → slide left
        state.player.nowPlaying = next;
        state.player.queue = fresh; // remaining (already shifted)
        saveState();
        playNowPlaying({ autoplay: true });
        if (doRender) render();
        return true;
      }
    }
  }
  return false;
}

function advanceToPrevTrack({ render: doRender = false } = {}) {
  // If more than 3s in, just restart current song (not a dead swipe)
  if (globalAudio && globalAudio.currentTime > 3) {
    globalAudio.currentTime = 0;
    return true;
  }
  const history = state.player?.playHistory || [];
  if (!history.length) return false; // dead — no history to go back to

  const prev = history.pop();
  _miniCarouselDir = -1; // backward → slide right
  if (state.player?.nowPlaying) {
    state.player.queue = [state.player.nowPlaying, ...(state.player.queue || [])];
  }
  state.player.nowPlaying = prev;
  state.player.playHistory = history;
  saveState();
  playNowPlaying({ autoplay: true });
  if (doRender) render();
  return true;
}

// Track short-play detection: if a track "ends" suspiciously fast, the local blob
// may be truncated. Try cloud audio before advancing. Prevents infinite short-play loops.
let _shortPlayCount = 0;
let _shortPlayTrack = null;
globalAudio?.addEventListener("ended", async () => {
  const now = state.player?.nowPlaying;
  const dur = globalAudio.duration;
  const ct = globalAudio.currentTime;
  const trackKey = now ? `${now.songId}:${now.versionId}` : null;
  console.log(`[Player] ENDED — dur=${dur?.toFixed(1)}s currentTime=${ct?.toFixed(1)}s track=${trackKey}`);

  // Guard: ignore spurious "ended" events (common with blob URLs on Safari/iOS).
  // Case 1: known duration and currentTime far from the end
  if (Number.isFinite(dur) && dur > 10 && Number.isFinite(ct) && ct < dur - 1.5) {
    console.warn(`[Player] Spurious ended event — currentTime ${ct.toFixed(1)}s far from duration ${dur.toFixed(1)}s, ignoring`);
    return;
  }
  // Case 2: audio is still actively playing (not paused, not truly ended)
  if (!globalAudio.paused && !globalAudio.ended) {
    console.warn(`[Player] Spurious ended event — audio still playing (paused=${globalAudio.paused} ended=${globalAudio.ended}), ignoring`);
    return;
  }

  // Detect suspiciously short playback (< 10s) — likely truncated local blob
  if (now && Number.isFinite(dur) && dur < 10) {
    if (_shortPlayTrack !== trackKey) { _shortPlayCount = 0; _shortPlayTrack = trackKey; }
    _shortPlayCount++;

    if (_shortPlayCount <= 2) {
      // Flag local blob as bad so getPlayableUrlForVersion skips it and tries cloud
      const song = getSong(now.songId);
      const v = song ? getVersion(song, now.versionId) : null;
      if (v?.fileId) {
        _badLocalBlobs.add(v.fileId);
        audioUrlCache.delete(`file:${v.fileId}`);
      }
      console.warn(`[Player] Track ended in ${dur.toFixed(1)}s — possible truncated blob, retrying from cloud...`);
      _clearAudioCacheForNowPlaying();
      await playNowPlaying({ autoplay: true });
      return;
    }
    // Gave up — stop looping on this broken track
    console.warn(`[Player] Track keeps ending early, stopping`);
    toast("This track may be corrupted — try re-uploading");
    syncMiniPlayerUI();
    return;
  }

  // Normal end — reset short-play counter and advance
  _shortPlayCount = 0;
  _shortPlayTrack = null;
  if (!advanceToNextTrack({ render: R.fullPlayerOpen })) syncMiniPlayerUI();
});

// Auto-skip on audio load/decode errors so playback doesn't silently stop
let _errorSkipTrack = null; // guard: don't repeatedly error-skip the same track
globalAudio?.addEventListener("error", () => {
  const now = state.player?.nowPlaying;
  if (!now) return;
  const trackKey = `${now.songId}:${now.versionId}`;
  const errCode = globalAudio.error?.code;
  const errMsg = globalAudio.error?.message;
  console.log(`[Player] ERROR — code=${errCode} msg=${errMsg} track=${trackKey}`);

  // Guard: if audio is still actively playing, this is a spurious error
  // (e.g., secondary resource fetch failed while primary buffer is fine)
  if (!globalAudio.paused && globalAudio.currentTime > 0) {
    console.warn(`[Player] Ignoring error — audio still playing at ${globalAudio.currentTime.toFixed(1)}s`);
    return;
  }

  if (_errorSkipTrack === trackKey) {
    // Already tried skipping this track — stop to avoid infinite loop
    console.warn(`[Player] Repeated error on same track ${trackKey}, stopping`);
    toast("Can't play this track right now");
    syncMiniPlayerUI();
    return;
  }
  _errorSkipTrack = trackKey;
  console.warn(`[Player] Audio error for ${now.songId}, skipping...`);
  // Clear the broken cached URL so retry can re-fetch from source
  _clearAudioCacheForNowPlaying();
  if (!advanceToNextTrack({ render: R.fullPlayerOpen })) {
    toast("Playback error — no more tracks");
    syncMiniPlayerUI();
  }
});

// Audio stalled mid-playback (common on iOS when blob URL expires after backgrounding)
// Retry once PER TRACK by re-fetching the audio from IndexedDB/cloud
let _stallRetriedTrack = null; // "songId:versionId" of the track we already retried
globalAudio?.addEventListener("stalled", async () => {
  const now = state.player?.nowPlaying;
  if (!now) return;
  if (globalAudio.paused) return; // don't retry if intentionally paused
  // Blob URLs have the entire file in memory — they can't truly stall.
  // Browsers (especially Safari) fire spurious stalled events for blob sources.
  if (globalAudio.src?.startsWith("blob:")) return;
  const trackKey = `${now.songId}:${now.versionId}`;
  if (_stallRetriedTrack === trackKey) return; // already retried this track — don't loop
  console.warn("[Player] Audio stalled — retrying from source...");
  _stallRetriedTrack = trackKey;
  const savedTime = globalAudio.currentTime || 0;
  _clearAudioCacheForNowPlaying();
  await playNowPlaying({ autoplay: true });
  // Restore playback position so it doesn't restart from 0
  if (savedTime > 1 && Number.isFinite(globalAudio.duration) && savedTime < globalAudio.duration) {
    try { globalAudio.currentTime = savedTime; } catch {}
  }
});

function _clearAudioCacheForNowPlaying() {
  const now = state.player?.nowPlaying;
  if (!now) return;
  const song = getSong(now.songId);
  const v = song ? getVersion(song, now.versionId) : null;
  if (v?.fileId) audioUrlCache.delete(`file:${v.fileId}`);
  if (v?.audioPath) audioUrlCache.delete(`supa:${v.audioPath}`);
}

// ---------------------
// Bottom sheet (GLOBAL)
// ---------------------
const sheet = $("#createSheet");
const sheetOverlay = $("#sheetOverlay");
const sheetContent = $("#sheetContent");
let sheetMode = "chooser"; // chooser | song | lyrics | release | songMenu | versionMenu | songFilters | shareTarget | shareNewSong | shareExistingSong
let sheetSongMenuId = null;

function openSongMenu(songId){
  sheetSongMenuId = songId;
  openSheet("songMenu");
}

function openSongFilters(){
  openSheet("songFilters");
}

function openSheet(mode = "chooser") {
  sheetMode = mode;
  renderSheet();
  document.body.classList.add("sheetOpen");
  sheet?.setAttribute("aria-hidden", "false");
  sheetOverlay?.setAttribute("aria-hidden", "false");
}

function closeSheet() {
  document.body.classList.remove("sheetOpen");
  sheet?.setAttribute("aria-hidden", "true");
  sheetOverlay?.setAttribute("aria-hidden", "true");
}

function renderSheet() {
  if (!sheetContent) return;

  if (sheetMode === "chooser") {
    sheetContent.innerHTML = `
      <div class="sheetTitle">Create</div>
      <div class="sheetRow">
        <button class="sheetChoice" id="sheetNewSong">
          New song
          <span class="sub">title + project + sprint</span>
        </button>
        <button class="sheetChoice" id="sheetNewLyrics">
          New lyrics
          <span class="sub">quick scratchpad</span>
        </button>
      </div>
    `;
    $("#sheetNewSong")?.addEventListener("click", () => openSheet("song"));
    $("#sheetNewLyrics")?.addEventListener("click", () => openSheet("lyrics"));
    return;
  }

  if (sheetMode === "song") {
    const existingProjects = [...new Set([
      ...(state.settings?.defaultProject ? [state.settings.defaultProject.trim()] : []),
      ...(state.projects || []).map(p => p.trim()).filter(Boolean),
      ...state.songs.map(s => (s.project || "").trim()).filter(Boolean),
    ])].sort();
    const defaultProj = state.settings.defaultProject || "";

    // Track the picked file for optional first-version upload
    let _sheetAudioFile = null;

    sheetContent.innerHTML = `
      <div class="sheetTitle">New song</div>

      <div class="sheetForm">
        <button class="sheetFileBtn" id="sheetPickFile">
          <div class="sheetFileIcon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          </div>
          <div class="sheetFileMeta">
            <div class="sheetFileLabel" id="sheetFileName">Add audio file</div>
            <div class="sheetFileSub" id="sheetFileSub">Optional — or just create a placeholder</div>
          </div>
        </button>
        <input id="sheetSongTitle" type="text" placeholder="Title (e.g. Internal)" />
        <select id="sheetSongProject">
          ${existingProjects.map(p => `<option value="${escapeHtml(p)}"${p === defaultProj ? " selected" : ""}>${escapeHtml(p)}</option>`).join("")}
          <option value="__new__"${!existingProjects.length ? " selected" : ""}>+ New project…</option>
        </select>
        <input id="sheetNewProject" type="text" placeholder="Project name"
          style="display:${!existingProjects.length ? "block" : "none"}; margin-top:-4px" />
        <input id="sheetSongGenre" type="text" placeholder="Genre" value="${escapeHtml(state.settings.defaultGenre || "")}" />
        <input id="sheetSongSprint" type="text" placeholder="Sprint" value="${escapeHtml(state.settings.defaultSprint || "")}" />
      </div>

      <div class="sheetActions">
        <button class="sheetBtn ghost" id="sheetBack">Back</button>
        <button class="sheetBtn primary" id="sheetCreateSong">Create</button>
      </div>
    `;

    // Optional file pick — auto-populate title from filename
    $("#sheetPickFile")?.addEventListener("click", async () => {
      const file = await pickAudioFile();
      if (!file) return;
      _sheetAudioFile = file;

      const nameEl = $("#sheetFileName");
      const subEl = $("#sheetFileSub");
      const btn = $("#sheetPickFile");
      if (nameEl) nameEl.textContent = file.name;
      if (subEl) subEl.textContent = `${(file.size/1024/1024).toFixed(1)} MB · tap to change`;
      if (btn) btn.classList.add("sheetFilePicked");

      // Auto-populate title if empty
      const titleInput = $("#sheetSongTitle");
      if (titleInput && !titleInput.value.trim()) {
        const baseName = (file.name || "").replace(/\.[^.]+$/, "").replace(/[-_]/g, " ").trim();
        titleInput.value = baseName;
      }
    });

    $("#sheetSongProject")?.addEventListener("change", (e) => {
      const isNew = e.target.value === "__new__";
      const inp = $("#sheetNewProject");
      if (inp) { inp.style.display = isNew ? "block" : "none"; }
      if (isNew) setTimeout(() => $("#sheetNewProject")?.focus(), 0);
    });

    $("#sheetBack")?.addEventListener("click", () => openSheet("chooser"));

    $("#sheetCreateSong")?.addEventListener("click", async () => {
      const title = ($("#sheetSongTitle")?.value || "").trim();
      if (!title) return toast("Give it a title 🙂");

      const projSel = $("#sheetSongProject")?.value || "";
      const projectRaw = projSel === "__new__"
        ? ($("#sheetNewProject")?.value || "").trim()
        : projSel;

      const song = {
        id: uid(),
        title,
        project: projectRaw || "Project",
        genre: ($("#sheetSongGenre")?.value || "").trim() || "",
        sprint: ($("#sheetSongSprint")?.value || "").trim() || "Unsorted",
        instrumentation: "",
        collaborators: "",
        status: "Idea",
        stuckState: "Active",
        nextAction: "",
        vibes: "",
        lyrics: "",
        notes: "",
        versions: [],
        createdAt: nowStamp(),
        updatedAt: nowStamp(),
      };

      ensureProjectInState(song.project);
      state.songs.unshift(song);

      // If user picked a file, create v1 with audio attached
      if (_sheetAudioFile) {
        const v = createVersion(song);
        saveState();
        toast("Uploading to cloud…");
        await attachSharedAudio(song, v, _sheetAudioFile, _sheetAudioFile.name || "audio", _sheetAudioFile.type || "audio/*", _sheetAudioFile.size || 0);
      } else {
        saveState();
        toast("Created 🎸");
      }

      closeSheet();
      R.currentTab = "songs";
      R.songsView = "list";
      R.selectedSongId = song.id;
      setHeader("Song");
      syncTabs();
      render();
      autoGenerateArt(song);
    });

    setTimeout(() => $("#sheetSongTitle")?.focus(), 0);
    return;
  }

  if (sheetMode === "lyrics") {
    closeSheet();
    R.lyricsEditSongId = null;
    R.overlayView = "lyrics";
    setHeader("Lyrics");
    renderLyricsScratch();
    openLyricsSongPicker();
    return;
  }

  if (sheetMode === "release") {
    const projects = Array.from(new Set(state.songs.map(s => (s.project || "").trim()).filter(Boolean))).sort();

    const songOptions = projects.map(proj => {
      const projSongs = state.songs.filter(s => (s.project || "").trim() === proj);
      const items = projSongs.map(s => `
        <label class="sheetSongPick">
          <input type="checkbox" name="relSong" value="${s.id}" />
          <span>${escapeHtml(s.title)}</span>
        </label>
      `).join("");
      return `
        <div class="sheetPickGroup">
          <div class="sheetPickLabel">${escapeHtml(proj)}</div>
          ${items}
        </div>
      `;
    }).join("");

    sheetContent.innerHTML = `
      <div class="sheetTitle">New Release</div>
      <div class="sheetForm">
        <input id="relTitle" type="text" placeholder="Title (e.g. The Life EP)" />
        <input id="relArtist" type="text" placeholder="Artist" />
        <input id="relDate" type="date" value="2026-06-01" />
        <div class="sheetPickScroll">
          ${songOptions || `<div class="small">No songs yet — create some songs first.</div>`}
        </div>
      </div>
      <div class="sheetActions">
        <button class="sheetBtn ghost" id="sheetRelCancel">Cancel</button>
        <button class="sheetBtn primary" id="sheetRelCreate">Create</button>
      </div>
    `;

    $("#sheetRelCancel")?.addEventListener("click", closeSheet);

    $("#sheetRelCreate")?.addEventListener("click", () => {
      const title = ($("#relTitle")?.value || "").trim();
      const artist = ($("#relArtist")?.value || "").trim();
      const date = ($("#relDate")?.value || "").trim();
      if (!title) { toast("Please enter a title"); return; }
      const checked = [...sheetContent.querySelectorAll("input[name='relSong']:checked")].map(el => el.value);
      state.releases = state.releases || [];
      state.releases.push({
        id: uid(),
        title,
        artist,
        songIds: checked,
        releaseDate: date,
        createdAt: nowStamp(),
        updatedAt: nowStamp(),
      });
      saveState();
      closeSheet();
      R.drawerView = "releases";
      R.releaseDetailId = null;
      render();
      toast(`"${title}" created 🎵`);
    });

    setTimeout(() => $("#relTitle")?.focus(), 0);
    return;
  }

    if (sheetMode === "songMenu") {
    const song = getSong(sheetSongMenuId);
    const title = song?.title || "Song";

    sheetContent.innerHTML = `
      <div class="sheetTitle">${escapeHtml(title)}</div>

      <div class="sheetForm" style="gap:10px">
        <button class="sheetChoice" id="songMenuOpen">Open song</button>
        <button class="sheetChoice" id="songMenuRename">Rename</button>
        <button class="sheetChoice" id="songMenuDelete" style="background: rgba(255,92,119,.12); border-color: rgba(255,92,119,.25);">
          Delete song
          <span class="sub">this can’t be undone</span>
        </button>
        <button class="sheetChoice" id="songMenuCancel">Cancel</button>
      </div>
    `;

    $("#songMenuOpen")?.addEventListener("click", () => {
      if (!song) return closeSheet();
      closeSheet();
      R.currentTab = "songs";
      R.songsView = "list";
      R.selectedSongId = song.id;
      setHeader("Song");
      syncTabs();
      render();
    });

    $("#songMenuRename")?.addEventListener("click", () => {
      if (!song) return closeSheet();
      closeSheet();
      const newName = prompt("Rename song:", song.title || "");
      if (newName === null) return;
      const trimmed = newName.trim();
      if (!trimmed || trimmed === song.title) return;
      song.title = trimmed;
      song.updatedAt = nowStamp();
      saveState();
      coverCache.clear();
      render();
      toast("Renamed");
    });

    $("#songMenuDelete")?.addEventListener("click", async () => {
      if (!song) return closeSheet();
      if (!confirm(`Delete "${song.title}"?`)) return;
      state.songs = state.songs.filter(s => s.id !== song.id);
      saveState();
      closeSheet();
      R.currentTab = "songs";
      R.songsView = "list";
      R.selectedSongId = null;
      setHeader("Songs");
      syncTabs();
      render();
      // Delete from cloud after UI updates
      await deleteSongEverywhere(song);
      toast("Deleted from cloud");
    });

    $("#songMenuCancel")?.addEventListener("click", () => {
      closeSheet();
    });

    return;
  }

  if (sheetMode === "songDetailMenu") {
    const song = getSong(sheetSongMenuId);
    if (!song) { closeSheet(); return; }
    const fv = featuredVersion(song);
    const title = song?.title || "Song";
    const canGenArt = !generatingArtSongs.has(song.id) && Date.now() >= artCooldownUntil;
    const artLabel = generatingArtSongs.has(song.id) ? "Generating..." : song.coverImageUrl ? "Regen Art" : "Gen Art";
    const hasUserCover = !!(song.userCoverImageUrl || song.userCoverPath);
    const hasAiCover = !!(song.coverImageUrl || song.coverPath);
    const toggleLabel = song.coverSource === "user"
      ? (hasAiCover ? "Use AI Art" : "")
      : (hasUserCover ? "Use My Photo" : "");
    sheetContent.innerHTML = `
      <div class="sheetTitle">${escapeHtml(title)}</div>

      <div class="sheetForm" style="gap:10px">
        <button class="sheetChoice" id="sdmDetails">Details</button>
        <button class="sheetChoice" id="sdmRename">Rename</button>
        <button class="sheetChoice" id="sdmQueue" ${(fv?.link || fv?.fileId || fv?.localAudioId || fv?.audioPath) ? "" : "disabled"}>Add to Queue</button>
        <button class="sheetChoice" id="sdmUploadCover">
          Upload Cover
          <span class="sub">use your own photo</span>
        </button>
        ${toggleLabel ? `<button class="sheetChoice" id="sdmToggleCover">${escapeHtml(toggleLabel)}</button>` : ""}
        <button class="sheetChoice" id="sdmGenArt" ${canGenArt ? "" : "disabled"}>${escapeHtml(artLabel)}</button>
        <button class="sheetChoice" id="sdmDelete" style="background: rgba(255,92,119,.12); border-color: rgba(255,92,119,.25);">
          Delete song
          <span class="sub">this can't be undone</span>
        </button>
        <button class="sheetChoice" id="sdmCancel">Cancel</button>
      </div>
    `;

    $("#sdmDetails")?.addEventListener("click", () => {
      closeSheet();
      if (!fv) {
        const first = createVersion(song);
        if (!first) return toast("Couldn't create version");
        navigateForward(() => {
          R.selectedVersionId = first.id;
        });
        return;
      }
      navigateForward(() => {
        R.selectedVersionId = fv.id;
      });
    });

    $("#sdmRename")?.addEventListener("click", () => {
      closeSheet();
      const newName = prompt("Rename song:", song.title || "");
      if (newName === null) return;
      const trimmed = newName.trim();
      if (!trimmed || trimmed === song.title) return;
      song.title = trimmed;
      song.updatedAt = nowStamp();
      saveState();
      coverCache.clear();
      render();
      toast("Renamed");
    });

    $("#sdmQueue")?.addEventListener("click", () => {
      if (fv) addToQueue(song.id, fv.id);
      closeSheet();
    });

    $("#sdmGenArt")?.addEventListener("click", async () => {
      if (!canGenArt) return;
      closeSheet();
      generatingArtSongs.add(song.id);
      setArtCooldownUntil(Date.now() + 10000);
      coverCache.clear();
      render();

      try {
        await generateArtForSong(song);
        coverCache.clear();
        saveState();
        toast("Art generated");
      } catch (e) {
        console.error("Art generation failed:", e);
        toast(e.message || "Art generation failed");
      } finally {
        generatingArtSongs.delete(song.id);
        coverCache.clear();
        render();
        const remaining = artCooldownUntil - Date.now();
        if (remaining > 0) setTimeout(() => render(), remaining + 50);
      }
    });

    $("#sdmUploadCover")?.addEventListener("click", () => {
      closeSheet();
      openCoverCropOverlay(song.id);
    });

    $("#sdmToggleCover")?.addEventListener("click", () => {
      song.coverSource = song.coverSource === "user" ? "ai" : "user";
      coverCache.clear();
      saveState();
      closeSheet();
      render();
      toast(song.coverSource === "user" ? "Using your photo" : "Using AI art");
    });

    $("#sdmDelete")?.addEventListener("click", async () => {
      if (!confirm(`Delete "${song.title}"?`)) return;
      state.songs = state.songs.filter(s => s.id !== song.id);
      saveState();
      closeSheet();
      R.selectedSongId = null;
      R.selectedVersionId = null;
      R.songsView = "list";
      setHeader("Songs");
      render();
      // Delete from cloud after UI updates
      await deleteSongEverywhere(song);
      toast("Deleted from cloud");
    });

    $("#sdmCancel")?.addEventListener("click", () => closeSheet());

    return;
  }

      if (sheetMode === "songFilters") {
    // Build project list from settings + songs + standalone projects
    const projects = Array.from(
      new Set([
        ...(state.settings?.defaultProject ? [state.settings.defaultProject.trim()] : []),
        ...(state.projects || []).map(p => p.trim()).filter(Boolean),
        ...state.songs.map(s => (s.project || "").trim()).filter(Boolean)
      ])
    ).sort((a,b) => a.localeCompare(b));

    sheetContent.innerHTML = `
      <div class="sheetTitle">Filters</div>

      <div class="sheetForm">
        <label class="label" style="margin:0">Status</label>
        <select id="sfStatus">
          <option value="">All statuses</option>
          ${["Idea","Demo","Arrange","Mix","Master","Ready","Done","Released"].map(
            s => `<option value="${s}" ${songsListState.statusFilter === s ? "selected" : ""}>${s}</option>`
          ).join("")}
        </select>

        <label class="label" style="margin:8px 0 0">Project</label>
        <select id="sfProject">
          <option value="">All projects</option>
          ${projects.map(
            p => `<option value="${escapeHtml(p)}" ${songsListState.projectFilter === p ? "selected" : ""}>${escapeHtml(p)}</option>`
          ).join("")}
        </select>
      </div>

      <div class="sheetActions" style="margin-top:12px">
        <button class="sheetBtn ghost" id="sfClear">Clear</button>
        <button class="sheetBtn primary" id="sfApply">Apply</button>
      </div>
    `;

    $("#sfClear")?.addEventListener("click", () => {
      songsListState.statusFilter = "";
      songsListState.projectFilter = "";
      toast("Cleared 🧼");
      closeSheet();
      renderSongsList();
    });

    $("#sfApply")?.addEventListener("click", () => {
      songsListState.statusFilter = ($("#sfStatus")?.value || "");
      songsListState.projectFilter = ($("#sfProject")?.value || "");
      closeSheet();
      toast("Applied ✅");
      renderSongsList();
    });

    return;
  }

      if (sheetMode === "versionMenu") {
    const song = getSong(sheetVersionMenu.songId);
    const v = getVersion(song, sheetVersionMenu.versionId);

    if (!song || !v) {
      closeSheet();
      return;
    }

    const playable = !!(v.link || v.fileId || v.localAudioId || v.audioPath);

    sheetContent.innerHTML = `
      <div class="sheetTitle">${escapeHtml(song.title)}</div>
      <div class="small" style="margin-top:-6px; opacity:.75">${escapeHtml(v.label || "Version")}</div>

      <div class="sheetForm" style="gap:10px; margin-top:12px">
        <button class="sheetChoice" id="vmPlay" ${playable ? "" : "disabled"}>Play</button>
        <button class="sheetChoice" id="vmQueue" ${playable ? "" : "disabled"}>Add to Queue</button>
        <button class="sheetChoice" id="vmDetails">View Details</button>
        <button class="sheetChoice" id="vmRename">Rename</button>
        <button class="sheetChoice" id="vmSetActive" ${v.isActive ? "disabled" : ""}>${v.isActive ? "Active ✅" : "Set Active ✅"}</button>
        <button class="sheetChoice" id="vmOpen" ${playable ? "" : "disabled"}>Open link</button>
        <button class="sheetChoice" id="vmCopy">Copy name</button>

        <button class="sheetChoice" id="vmDelete" style="background: rgba(255,92,119,.12); border-color: rgba(255,92,119,.25);">
          Delete version
          <span class="sub">this can’t be undone</span>
        </button>

        <button class="sheetChoice" id="vmCancel">Cancel</button>
      </div>
    `;

    $("#vmPlay")?.addEventListener("click", () => {
      closeSheet();
      playVersion(song.id, v.id, { goPlayer: false });
    });

    $("#vmQueue")?.addEventListener("click", () => {
      addToQueue(song.id, v.id);
      closeSheet();
    });

    $("#vmDetails")?.addEventListener("click", () => {
      closeSheet();
      navigateForward(() => {
        R.selectedSongId = song.id;
        R.selectedVersionId = v.id;
      });
    });

    $("#vmRename")?.addEventListener("click", () => {
      closeSheet();
      const newLabel = prompt("Rename version:", v.label || "");
      if (newLabel === null) return;
      const trimmed = newLabel.trim();
      if (!trimmed || trimmed === v.label) return;
      v.label = trimmed;
      song.updatedAt = nowStamp();
      saveState();
      render();
      toast("Renamed");
    });

    $("#vmSetActive")?.addEventListener("click", () => {
      setActive(song.id, v.id);
      toast("Active ✅");
      closeSheet();
      render();
    });

    $("#vmOpen")?.addEventListener("click", () => {
      if (v.link) window.open(v.link, "_blank");
      closeSheet();
    });

    $("#vmCopy")?.addEventListener("click", async () => {
      await copyText(v.label || "");
      closeSheet();
    });

    $("#vmDelete")?.addEventListener("click", () => {
      if (!confirm(`Delete this version?`)) return;
      const wasActive = v.isActive;
      song.versions = (song.versions || []).filter(x => x.id !== v.id);

      // If the deleted version was active, promote the first remaining
      if (wasActive && song.versions.length && !song.versions.some(x => x.isActive)) {
        song.versions[0].isActive = true;
      }

      song.updatedAt = nowStamp();
      saveState();
      toast("Deleted 🗑️");
      closeSheet();
      render();
    });

    $("#vmCancel")?.addEventListener("click", closeSheet);
    return;
  }

  if (sheetMode === "projectMenu") {
    const p = sheetProjectMenuName;
    if (!p) { closeSheet(); return; }
    const isDefault = (state.settings.defaultProject || "").trim() === p;
    sheetContent.innerHTML = `
      <div class="sheetTitle">${escapeHtml(p)}</div>
      <div class="sheetForm" style="gap:10px; margin-top:12px">
        <button class="sheetChoice" id="pmRename">Rename</button>
        <button class="sheetChoice" id="pmInvite">Invite to Project</button>
        <button class="sheetChoice" id="pmSetDefault" ${isDefault ? "disabled" : ""}>${isDefault ? "Default ✅" : "Set as default"}</button>
        <button class="sheetChoice" id="pmCancel">Cancel</button>
      </div>
    `;
    $("#pmRename")?.addEventListener("click", () => {
      closeSheet();
      const newName = prompt("Rename project:", p);
      if (newName === null) return;
      const trimmed = newName.trim();
      if (!trimmed || trimmed === p) return;
      // Update all songs that belong to this project
      for (const s of state.songs) {
        if ((s.project || "").trim() === p) {
          s.project = trimmed;
          s.updatedAt = nowStamp();
        }
      }
      // Update the projects list
      const idx = (state.projects || []).indexOf(p);
      if (idx !== -1) state.projects[idx] = trimmed;
      // Update default project if it was this one
      if ((state.settings.defaultProject || "").trim() === p) {
        state.settings.defaultProject = trimmed;
      }
      // Update projectDetailScreen if we're viewing this project
      if (R.projectDetailScreen === p) R.projectDetailScreen = trimmed;
      saveState();
      coverCache.clear();
      render();
      toast("Renamed");
    });
    $("#pmInvite")?.addEventListener("click", () => {
      closeSheet();
      shareInvite(p);
    });
    $("#pmSetDefault")?.addEventListener("click", () => {
      state.settings.defaultProject = p;
      saveState();
      toast("Default set ✅");
      closeSheet();
      renderProjects();
    });
    $("#pmCancel")?.addEventListener("click", closeSheet);
    return;
  }

  if (sheetMode === "releaseMenu") {
    const rel = (state.releases || []).find(r => r.id === sheetReleaseMenuId);
    if (!rel) { closeSheet(); return; }
    sheetContent.innerHTML = `
      <div class="sheetTitle">${escapeHtml(rel.title)}</div>
      <div class="sheetForm" style="gap:10px; margin-top:12px">
        <button class="sheetChoice" id="rmRename">Rename</button>
        <button class="sheetChoice" id="rmDelete" style="color:#ef4444">Delete Release</button>
        <button class="sheetChoice" id="rmCancel">Cancel</button>
      </div>
    `;
    $("#rmRename")?.addEventListener("click", () => {
      closeSheet();
      const newName = prompt("Rename release:", rel.title || "");
      if (newName === null) return;
      const trimmed = newName.trim();
      if (!trimmed || trimmed === rel.title) return;
      rel.title = trimmed;
      saveState();
      render();
      toast("Renamed");
    });
    $("#rmDelete")?.addEventListener("click", () => {
      closeSheet();
      if (!confirm(`Delete "${rel.title}"?`)) return;
      state.releases = (state.releases || []).filter(r => r.id !== rel.id);
      saveState();
      R.releaseDetailId = null;
      render();
    });
    $("#rmCancel")?.addEventListener("click", closeSheet);
    return;
  }

  // shareRole and sharePicker modes are rendered by their own opener functions
  if (sheetMode === "shareRole" || sheetMode === "sharePicker") return;
}

let sheetVersionMenu = { songId: null, versionId: null };
let sheetProjectMenuName = null;

function openVersionMenu(songId, versionId){
  sheetVersionMenu = { songId, versionId };
  openSheet("versionMenu");
}

function openProjectMenu(projectName) {
  sheetProjectMenuName = projectName;
  openSheet("projectMenu");
}

let sheetReleaseMenuId = null;

function openReleaseMenu(releaseId) {
  sheetReleaseMenuId = releaseId;
  openSheet("releaseMenu");
}

sheetOverlay?.addEventListener("click", closeSheet);

// Swipe down to dismiss sheet
let sheetStartY = 0;
let sheetTracking = false;

sheet?.addEventListener("touchstart", (e) => {
  const t = e.touches?.[0];
  if (!t) return;
  sheetTracking = true;
  sheetStartY = t.clientY;
}, { passive: true });

sheet?.addEventListener("touchmove", (e) => {
  if (!sheetTracking) return;
  const t = e.touches?.[0];
  if (!t) return;
  const dy = t.clientY - sheetStartY;
  if (dy > 12) e.preventDefault();
}, { passive: false });

sheet?.addEventListener("touchend", (e) => {
  if (!sheetTracking) return;
  sheetTracking = false;
  const t = e.changedTouches?.[0];
  if (!t) return;
  const dy = t.clientY - sheetStartY;
  if (dy > 80) closeSheet();
}, { passive: true });

// ---------------------
// Full-screen Create Overlay
// ---------------------
const GENRE_LIST = [
  "Acoustic","Alternative","Ambient","Anime","Blues","Bluegrass","Bounce","Britpop",
  "Celtic","Chillwave","Classical","Country","Cyberpunk","Dance","Darkwave",
  "Deathcore","Disco","Doom Metal","Downtempo","Dream Pop","Drum & Bass","Dub",
  "Dubstep","EDM","Electro","Electronic","Emo","Experimental","Folk","Funk",
  "Future Bass","Garage Rock","Glitch","Gospel","Goth","Grindcore","Grunge",
  "Hard Rock","Hardcore","Heavy Metal","Hip Hop","House","Hyperpop","Indie",
  "Indie Pop","Indie Rock","Industrial","J-Pop","J-Rock","Jazz","K-Pop","Latin",
  "Lo-Fi","Lounge","Math Rock","Melodic Hardcore","Metal","Metalcore","Midwest Emo",
  "Minimal","Motown","Neo-Soul","New Wave","Noise","Nu Metal","Opera","Orchestral",
  "Pop","Pop Punk","Pop Rock","Post-Hardcore","Post-Metal","Post-Punk","Post-Rock",
  "Power Metal","Progressive","Progressive Metal","Progressive Rock","Psych Rock",
  "Punk","R&B","Rap","Reggae","Reggaeton","Rock","Screamo","Shoegaze","Singer-Songwriter",
  "Ska","Slowcore","Soul","Stoner Rock","Surf Rock","Synth Pop","Synthwave","Tech House",
  "Techno","Thrash Metal","Trap","Trip Hop","Vaporwave","World"
];

let createOverlayEl = null;
let createTab = "song"; // "song" | "idea" | "lyrics"
let createGenreSearch = "";
let createSelectedGenres = [];
let createSelectedProject = "";
let createGenreDropdownOpen = false;
let createAudioFile = null; // optional audio file for first version
let createTitleValue = ""; // preserve title across re-renders

function openCreateOverlay() {
  if (createOverlayEl) return;

  createTab = "song";
  createGenreSearch = "";
  createSelectedGenres = [];
  createSelectedProject = "";
  createGenreDropdownOpen = false;
  createAudioFile = null;
  createTitleValue = "";

  createOverlayEl = document.createElement("div");
  createOverlayEl.id = "createOverlay";
  createOverlayEl.className = "createOverlay";
  document.body.appendChild(createOverlayEl);

  requestAnimationFrame(() => {
    createOverlayEl?.classList.add("open");
  });

  renderCreateOverlay();
  setupCreateOverlaySwipe();
}

function setupCreateOverlaySwipe() {
  if (!createOverlayEl) return;
  let startY = 0, currentY = 0, dragging = false, locked = false;
  const DISMISS_THRESHOLD = 120;

  createOverlayEl.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    currentY = startY;
    dragging = false;
    locked = false;
  }, { passive: true });

  createOverlayEl.addEventListener("touchmove", (e) => {
    if (locked || e.touches.length !== 1) return;
    currentY = e.touches[0].clientY;
    const dy = currentY - startY;

    if (!dragging) {
      // Need enough movement to decide direction
      if (Math.abs(dy) < 10) return;
      // If swiping up, don't intercept — let content scroll
      if (dy < 0) { locked = true; return; }
      // If scrollable body isn't at top, let it scroll normally
      const body = createOverlayEl.querySelector(".coBody");
      if (body && body.scrollTop > 0) { locked = true; return; }
      // Swiping down from scroll-top — start drag
      dragging = true;
      createOverlayEl.style.transition = "none";
    }

    if (dragging) {
      const downDy = Math.max(0, currentY - startY);
      createOverlayEl.style.transform = `translateY(${downDy}px)`;
      createOverlayEl.style.opacity = `${1 - downDy / 400}`;
    }
  }, { passive: true });

  createOverlayEl.addEventListener("touchend", () => {
    if (!dragging) return;
    dragging = false;
    const dy = currentY - startY;
    if (dy > DISMISS_THRESHOLD) {
      createOverlayEl.style.transition = "opacity .2s ease, transform .25s ease";
      createOverlayEl.style.transform = "translateY(100%)";
      createOverlayEl.style.opacity = "0";
      setTimeout(() => { if (createOverlayEl) { createOverlayEl.remove(); createOverlayEl = null; } }, 260);
    } else {
      createOverlayEl.style.transition = "opacity .2s ease, transform .2s ease";
      createOverlayEl.style.transform = "translateY(0)";
      createOverlayEl.style.opacity = "1";
    }
  }, { passive: true });
}

function closeCreateOverlay() {
  if (!createOverlayEl) return;
  createOverlayEl.classList.remove("open");
  createOverlayEl.addEventListener("transitionend", () => {
    createOverlayEl?.remove();
    createOverlayEl = null;
  }, { once: true });
  // Fallback if no transition fires
  setTimeout(() => { if (createOverlayEl) { createOverlayEl.remove(); createOverlayEl = null; } }, 350);
}

function getProjectGenreDefault(projectName) {
  if (!projectName) return [];
  const projSongs = state.songs.filter(s => (s.project || "").trim() === projectName);
  if (!projSongs.length) return [];

  const genreCount = {};
  projSongs.forEach(s => {
    const genres = (s.genre || "").split(",").map(g => g.trim()).filter(Boolean);
    genres.forEach(g => { genreCount[g] = (genreCount[g] || 0) + 1; });
  });

  // Sort by frequency descending
  return Object.entries(genreCount)
    .sort((a, b) => b[1] - a[1])
    .map(e => e[0]);
}

function getProjectCoverArt(projectName) {
  // Find most recent song in project that has cover art
  const projSongs = state.songs
    .filter(s => (s.project || "").trim() === projectName)
    .sort((a, b) => (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || ""));

  for (const s of projSongs) {
    if (s.coverImageUrl) {
      return `<img src="${escapeHtml(s.coverImageUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`;
    }
  }

  // Fallback: use coverSvg from first song
  if (projSongs.length) {
    try { return coverSvg(projSongs[0], { lite: true }); } catch {}
  }

  return `<div style="width:100%;height:100%;background:linear-gradient(135deg,#2a2a3e,#1a1a2e);border-radius:inherit;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.3);font-size:20px">+</div>`;
}

function renderCreateOverlay() {
  if (!createOverlayEl) return;

  // Preserve title input across re-renders
  const prevTitle = createOverlayEl.querySelector("#coTitle");
  if (prevTitle) createTitleValue = prevTitle.value;

  const existingProjects = [...new Set([
    ...(state.settings?.defaultProject ? [state.settings.defaultProject.trim()] : []),
    ...(state.projects || []).map(p => p.trim()).filter(Boolean),
    ...state.songs.map(s => (s.project || "").trim()).filter(Boolean),
  ])].sort();

  const tabItems = [
    { key: "song", label: "Song" },
    { key: "idea", label: "Idea" },
    { key: "lyrics", label: "Lyrics" },
  ];

  const tabsHTML = tabItems.map(t =>
    `<button class="coTab${createTab === t.key ? " active" : ""}" data-cotab="${t.key}">${t.label}</button>`
  ).join("");

  let contentHTML = "";

  if (createTab === "song") {
    // Project cards
    const projCardsHTML = existingProjects.map(p => {
      const isSelected = createSelectedProject === p;
      const songCount = state.songs.filter(s => (s.project || "").trim() === p).length;
      return `
        <button class="coProjCard${isSelected ? " selected" : ""}" data-proj="${escapeHtml(p)}">
          <div class="coProjArt">${getProjectCoverArt(p)}</div>
          <div class="coProjName">${escapeHtml(p)}</div>
          <div class="coProjCount">${songCount} song${songCount !== 1 ? "s" : ""}</div>
        </button>`;
    }).join("");

    const newProjSelected = createSelectedProject === "__new__";

    // Genre chips
    const genreChipsHTML = createSelectedGenres.map(g =>
      `<span class="coGenreChip">${escapeHtml(g)}<button class="coGenreChipX" data-genre="${escapeHtml(g)}">&times;</button></span>`
    ).join("");

    // Genre dropdown items (filtered)
    const searchLower = createGenreSearch.toLowerCase();
    const filteredGenres = GENRE_LIST.filter(g =>
      g.toLowerCase().includes(searchLower) && !createSelectedGenres.includes(g)
    );
    const genreDropdownHTML = createGenreDropdownOpen && filteredGenres.length
      ? `<div class="coGenreDropdown">${filteredGenres.slice(0, 12).map(g =>
          `<button class="coGenreOption" data-genre="${escapeHtml(g)}">${escapeHtml(g)}</button>`
        ).join("")}</div>`
      : "";

    const hasFile = !!createAudioFile;
    const fileDisplayName = hasFile ? escapeHtml(createAudioFile.name) : "";
    const fileDisplaySize = hasFile ? `${(createAudioFile.size/1024/1024).toFixed(1)} MB` : "";

    contentHTML = `
      <button class="coFileBtn${hasFile ? " picked" : ""}" id="coPickFile">
        <div class="coFileIcon">
          ${hasFile
            ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`
            : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`
          }
        </div>
        <div class="coFileMeta">
          <div class="coFileName">${hasFile ? fileDisplayName : "Add audio file"}</div>
          <div class="coFileSub">${hasFile ? `${fileDisplaySize} · tap to change` : "Optional · or create a placeholder"}</div>
        </div>
        ${hasFile ? `<button class="coFileClear" id="coFileClear">&times;</button>` : ""}
      </button>

      <div class="coField">
        <label class="coLabel">Title</label>
        <input id="coTitle" class="coInput" type="text" placeholder="e.g. Dinosaur Uprising" autocomplete="off" value="${escapeHtml(createTitleValue)}" />
      </div>

      <div class="coField">
        <label class="coLabel">Project</label>
        <div class="coProjScroll">
          ${projCardsHTML}
          <button class="coProjCard coProjNew${newProjSelected ? " selected" : ""}" data-proj="__new__">
            <div class="coProjArt"><div style="width:100%;height:100%;background:rgba(255,255,255,.06);border-radius:inherit;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.4);font-size:24px;font-weight:300">+</div></div>
            <div class="coProjName">New Project</div>
            <div class="coProjCount">Create new</div>
          </button>
        </div>
        ${newProjSelected ? `<input id="coNewProject" class="coInput" type="text" placeholder="Project name" style="margin-top:10px" />` : ""}
      </div>

      <div class="coField">
        <label class="coLabel">Genre</label>
        <div class="coGenreChips">${genreChipsHTML}</div>
        <div class="coGenreWrap">
          <input id="coGenreSearch" class="coInput" type="text" placeholder="Search genres..." value="${escapeHtml(createGenreSearch)}" autocomplete="off" />
          ${genreDropdownHTML}
        </div>
      </div>

      <button class="coCreateBtn" id="coCreateSong">Create Song</button>
      <button class="coBulkBtn" id="coBulkImport">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        Bulk Import
      </button>
    `;
  } else {
    contentHTML = `
      <div class="coPlaceholder">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
        </svg>
        <div class="coPlaceholderText">Under Construction</div>
        <div class="coPlaceholderSub">This tab is coming soon</div>
      </div>
    `;
  }

  createOverlayEl.innerHTML = `
    <div class="coHeader">
      <div class="coTabs">${tabsHTML}</div>
      <button class="coClose" id="coCloseBtn">&times;</button>
    </div>
    <div class="coBody">${contentHTML}</div>
  `;

  // Wire events
  createOverlayEl.querySelector("#coCloseBtn")?.addEventListener("click", closeCreateOverlay);

  createOverlayEl.querySelectorAll(".coTab").forEach(btn => {
    btn.addEventListener("click", () => {
      createTab = btn.dataset.cotab;
      renderCreateOverlay();
    });
  });

  if (createTab === "song") {
    // File pick
    createOverlayEl.querySelector("#coPickFile")?.addEventListener("click", async (e) => {
      if (e.target.closest("#coFileClear")) return;
      const file = await pickAudioFile();
      if (!file) return;

      // Check for duplicate file name
      const dupHits = _findFileNameDuplicates(file.name);
      if (dupHits.length) {
        _showDuplicateFileDialog(file.name, dupHits, {
          onContinue: () => {
            createAudioFile = file;
            if (!createTitleValue.trim()) {
              createTitleValue = (file.name || "").replace(/\.[^.]+$/, "").replace(/[-_]/g, " ").trim();
            }
            renderCreateOverlay();
          },
          onDismiss: () => { /* user cancelled, don't set file */ },
        });
        return;
      }

      createAudioFile = file;
      // Auto-populate title if empty
      if (!createTitleValue.trim()) {
        createTitleValue = (file.name || "").replace(/\.[^.]+$/, "").replace(/[-_]/g, " ").trim();
      }
      renderCreateOverlay();
    });

    // File clear
    createOverlayEl.querySelector("#coFileClear")?.addEventListener("click", (e) => {
      e.stopPropagation();
      createAudioFile = null;
      renderCreateOverlay();
    });

    // Project selection
    createOverlayEl.querySelectorAll(".coProjCard").forEach(card => {
      card.addEventListener("click", () => {
        const proj = card.dataset.proj;
        createSelectedProject = proj;

        // Auto-populate genre from project
        if (proj !== "__new__") {
          const defaultGenres = getProjectGenreDefault(proj);
          createSelectedGenres = [...defaultGenres];
        } else {
          createSelectedGenres = [];
        }

        renderCreateOverlay();

        if (proj === "__new__") {
          setTimeout(() => createOverlayEl?.querySelector("#coNewProject")?.focus(), 0);
        }
      });
    });

    // Genre search
    const genreInput = createOverlayEl.querySelector("#coGenreSearch");
    genreInput?.addEventListener("input", (e) => {
      createGenreSearch = e.target.value;
      createGenreDropdownOpen = true;
      renderCreateOverlay();
      // Re-focus and restore cursor
      const newInput = createOverlayEl?.querySelector("#coGenreSearch");
      if (newInput) {
        newInput.focus();
        newInput.selectionStart = newInput.selectionEnd = newInput.value.length;
      }
    });
    genreInput?.addEventListener("focus", () => {
      if (createGenreDropdownOpen) return;
      createGenreDropdownOpen = true;
      renderCreateOverlay();
      const newInput = createOverlayEl?.querySelector("#coGenreSearch");
      if (newInput) {
        newInput.focus();
        newInput.selectionStart = newInput.selectionEnd = newInput.value.length;
      }
    });

    // Genre option select
    createOverlayEl.querySelectorAll(".coGenreOption").forEach(btn => {
      btn.addEventListener("click", () => {
        const g = btn.dataset.genre;
        if (!createSelectedGenres.includes(g)) createSelectedGenres.push(g);
        createGenreSearch = "";
        createGenreDropdownOpen = false;
        renderCreateOverlay();
      });
    });

    // Genre chip remove
    createOverlayEl.querySelectorAll(".coGenreChipX").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const g = btn.dataset.genre;
        createSelectedGenres = createSelectedGenres.filter(x => x !== g);
        renderCreateOverlay();
      });
    });

    // Close genre dropdown on outside click
    createOverlayEl.querySelector(".coBody")?.addEventListener("click", (e) => {
      if (!e.target.closest(".coGenreWrap") && !e.target.closest(".coGenreChipX")) {
        if (createGenreDropdownOpen) {
          createGenreDropdownOpen = false;
          renderCreateOverlay();
        }
      }
    });

    // Create button
    createOverlayEl.querySelector("#coBulkImport")?.addEventListener("click", () => openBulkImport());

    createOverlayEl.querySelector("#coCreateSong")?.addEventListener("click", async () => {
      const title = (createOverlayEl?.querySelector("#coTitle")?.value || "").trim();
      if (!title) return toast("Give it a title");

      let project = createSelectedProject;
      if (project === "__new__") {
        project = (createOverlayEl?.querySelector("#coNewProject")?.value || "").trim();
        if (!project) return toast("Enter a project name");
      }
      if (!project) return toast("Pick a project");

      // Check for duplicate song name in this project
      const existingDup = _findSongNameDuplicate(title, project);
      if (existingDup) {
        _showDuplicateSongDialog(existingDup, { fromCreate: true });
        return;
      }

      const song = {
        id: uid(),
        title,
        project,
        genre: createSelectedGenres.join(", "),
        sprint: state.settings.defaultSprint || "Unsorted",
        instrumentation: "",
        collaborators: "",
        status: "Idea",
        stuckState: "Active",
        nextAction: "",
        vibes: "",
        lyrics: "",
        notes: "",
        versions: [],
        createdAt: nowStamp(),
        updatedAt: nowStamp(),
      };

      ensureProjectInState(song.project);
      state.songs.unshift(song);

      // If user picked a file, create v1 with audio attached
      if (createAudioFile) {
        const v = createVersion(song);
        saveState();
        toast("Uploading to cloud…");
        await attachSharedAudio(song, v, createAudioFile, createAudioFile.name || "audio", createAudioFile.type || "audio/*", createAudioFile.size || 0);
      } else {
        saveState();
        toast("Created");
      }

      // Remove overlay instantly (no CSS transition) so navigateForward captures Home underneath
      if (createOverlayEl) { createOverlayEl.remove(); createOverlayEl = null; }

      navigateForward(() => {
        R.currentTab = "songs";
        R.songsView = "list";
        R.selectedSongId = song.id;
        setHeader("Song");
        syncTabs();
      });
      autoGenerateArt(song);
    });

    // Focus title
    setTimeout(() => createOverlayEl?.querySelector("#coTitle")?.focus(), 100);
  }
}

// ---------------------
// Export / Import
// ---------------------
$("#exportBtn")?.addEventListener("click", async () => {
  try {
    const payload = JSON.stringify(state, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `riffbank-backup-${nowStamp().replace(" ", "_")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Exported ✅");
  } catch {
    toast("Export failed 😅");
  }
});

$("#importFile")?.addEventListener("change", async (e) => {
  const input = e.target;
  const file = input?.files?.[0];
  if (!file) return;

  try {
    const txt = await file.text();
    const incoming = JSON.parse(txt);

    if (!incoming || !incoming.songs || !incoming.settings) {
      console.warn("[RiffBank] That file doesn't look like a RiffBank backup.");
      return;
    }

    if (!confirm("Import will replace your current data on this device. Continue?")) return;

    setState(incoming);
    normalizeState();
    saveState();
    toast("Imported ✅");
    render();
  } catch {
    console.warn("[RiffBank] Could not parse that JSON file.");
  } finally {
    if (input) input.value = "";
  }
});

// ---------------------
// Render router
// ---------------------
function render() {
  // Snapshot current screen so nav.forward()/nav.back() can show it as the ace
  nav.snapshot(activeScreenEl);

  if (!view) return;

  syncTabs();
  syncBackButton();

    // ✅ Enforce fullscreen player state every render (no overlap, no reserved padding)
  setFullPlayerOpen(!!R.fullPlayerOpen);

  document.body.classList.toggle(
    "isHome",
    R.currentTab === "home" && !R.drawerView && !R.overlayView && !R.selectedSongId && !R.selectedVersionId
  );
  document.body.classList.toggle(
    "hasHeaderGrad",
    R.currentTab === "songs" ||
    R.currentTab === "player" ||
    R.currentTab === "collab" ||
    R.drawerView === "projects" ||
    R.drawerView === "releases" ||
    R.drawerView === "eps" ||
    R.drawerView === "collabs"
  );

  // On forward navigation, reset scroll so screens always start at the top
  const _isBack = nav._isBackNav;

  // Drawer screens
  if (R.drawerView === "projects") {
    if (R.projectDetailScreen) {
      setActiveScreen("projectDetail");
      if (!_isBack) activeScreenEl.scrollTop = 0;
      return renderProjectSongs(R.projectDetailScreen);
    }
    setActiveScreen("drawer");
    if (!_isBack) activeScreenEl.scrollTop = 0;
    return renderProjects();
  }
  if (R.drawerView === "releases") { setActiveScreen("drawer"); if (!_isBack) activeScreenEl.scrollTop = 0; return R.releaseDetailId ? renderReleaseDetail(R.releaseDetailId) : renderReleases(); }
  if (R.drawerView === "eps") { setActiveScreen("drawer"); if (!_isBack) activeScreenEl.scrollTop = 0; return renderEPs(); }
  if (R.drawerView === "collabs") { setActiveScreen("drawer"); if (!_isBack) activeScreenEl.scrollTop = 0; return renderCollaborators(); }
  if (R.drawerView === "importExport") { setActiveScreen("drawer"); if (!_isBack) activeScreenEl.scrollTop = 0; return renderImportExport(); }
  if (R.drawerView === "about") { setActiveScreen("drawer"); if (!_isBack) activeScreenEl.scrollTop = 0; return renderAbout(); }
  if (R.drawerView === "globalSearch") { setActiveScreen("drawer"); if (!_isBack) activeScreenEl.scrollTop = 0; return renderGlobalSearch(); }
  if (R.drawerView === "alerts") { setActiveScreen("drawer"); if (!_isBack) activeScreenEl.scrollTop = 0; return renderAlerts(); }

  // Overlay screens (bulk import, lyrics, friends, etc.)
  if (R.overlayView === "bulkImport") {
    setActiveScreen("drawer");
    if (!_isBack) activeScreenEl.scrollTop = 0;
    return renderBulkImport();
  }
  if (R.overlayView === "lyrics") {
    setActiveScreen("home");
    if (!_isBack) activeScreenEl.scrollTop = 0;
    return renderLyricsScratch();
  }
  if (R.overlayView === "friendRequests") {
    setActiveScreen("drawer");
    if (!_isBack) activeScreenEl.scrollTop = 0;
    return renderFriendRequests();
  }
  if (R.overlayView === "friendsList") {
    setActiveScreen("drawer");
    if (!_isBack) activeScreenEl.scrollTop = 0;
    return renderFriendsList();
  }
  if (R.overlayView === "addFriend") {
    setActiveScreen("drawer");
    if (!_isBack) activeScreenEl.scrollTop = 0;
    return renderAddFriend();
  }
  if (R.overlayView === "friendProfile") {
    setActiveScreen("drawer");
    if (!_isBack) activeScreenEl.scrollTop = 0;
    return renderFriendProfile(R.friendProfileId);
  }
  if (R.overlayView === "messages") {
    setActiveScreen("drawer");
    if (!_isBack) activeScreenEl.scrollTop = 0;
    return renderMessages();
  }
  if (R.overlayView === "chat") {
    setActiveScreen("drawer");
    if (!_isBack) activeScreenEl.scrollTop = 0;
    return renderChat(R.friendProfileId);
  }

  // Normal screens
  if (R.currentTab === "home") {
    setActiveScreen("home");
    if (!_isBack) activeScreenEl.scrollTop = 0;
    // On back-nav, reuse existing home if particles are still alive (avoids position jump)
    const existingGrid = activeScreenEl.querySelector(".homeGrid");
    if (_isBack && existingGrid && existingGrid._cleanupHome) return;
    return renderHome();
  }
  if (R.currentTab === "songs") {
    if (R.selectedSongId && R.selectedVersionId) {
      setActiveScreen("versionDetail");
      if (!_isBack) activeScreenEl.scrollTop = 0;
      return renderVersionDetail(R.selectedSongId, R.selectedVersionId);
    }
    if (R.selectedSongId) {
      setActiveScreen("songDetail");
      if (!_isBack) activeScreenEl.scrollTop = 0;
      return renderSongDetail(R.selectedSongId);
    }
    setActiveScreen("songs");
    if (!_isBack) activeScreenEl.scrollTop = 0;
    if (R.songsView === "create") return renderSongCreate();
    return renderSongsList();
  }
  if (R.currentTab === "player") {
    setActiveScreen("player");
    if (R.playerScreen === "now") return renderNowPlaying();
    return renderPlayer();
  }
  if (R.currentTab === "collab") {
    if (R.projectDetailScreen) {
      if (R.selectedSongId && R.selectedVersionId) {
        setActiveScreen("versionDetail");
        if (!_isBack) activeScreenEl.scrollTop = 0;
        return renderVersionDetail(R.selectedSongId, R.selectedVersionId);
      }
      if (R.selectedSongId) {
        setActiveScreen("songDetail");
        if (!_isBack) activeScreenEl.scrollTop = 0;
        return renderSongDetail(R.selectedSongId);
      }
      setActiveScreen("projectDetail");
      if (!_isBack) activeScreenEl.scrollTop = 0;
      return renderProjectSongs(R.projectDetailScreen);
    }
    if (R.selectedSongId && R.selectedVersionId) {
      setActiveScreen("versionDetail");
      if (!_isBack) activeScreenEl.scrollTop = 0;
      return renderVersionDetail(R.selectedSongId, R.selectedVersionId);
    }
    if (R.selectedSongId) {
      setActiveScreen("songDetail");
      if (!_isBack) activeScreenEl.scrollTop = 0;
      return renderSongDetail(R.selectedSongId);
    }
    setActiveScreen("collab");
    return renderCollab();
  }
  if (R.currentTab === "profile") { setActiveScreen("collab"); return renderProfile(); }
  if (R.currentTab === "settings") {
    setActiveScreen("settings");
    if (R.settingsView === "account") return renderSettingsAccount();
    if (R.settingsView === "cloud") return renderSettingsCloud();
    if (R.settingsView === "library") return renderSettingsLibrary();
    if (R.settingsView === "art") return renderSettingsArt();
    if (R.settingsView === "debug") return renderSettingsDebug();
    if (R.settingsView === "danger") return renderSettingsDanger();
    return renderSettings();
  }
}

scheduleDockSpaceSync();

// Pre-fetch the active version's Drive audio for every song so first play is instant.
// Pre-fetch cloud audio into IndexedDB for offline playback.
async function preFetchCloudAudio() {
  for (const song of (state.songs || [])) {
    for (const v of (song.versions || [])) {
      if (!v.audioPath || v.fileId) continue;
      const dbKey = `supa:${v.audioPath}`;
      const existing = await audioGet(dbKey);
      if (existing?.blob) { cachedAudioPaths.add(v.audioPath); continue; }
      const blob = await supabaseFetchAudioBlob(v.audioPath);
      if (blob) {
        cachedAudioPaths.add(v.audioPath);
        await putAudioBlob({
          id: dbKey,
          blob,
          name: v.fileName || v.label || "audio",
          type: v.fileType || blob.type || "audio/*",
          size: blob.size,
        });
      }
    }
  }
}

// ---------------------
// Web Share Target — receive files shared from other apps
// ---------------------
async function checkSharedAudioFile() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("shared")) return;

  // Clean URL so refreshing doesn't re-trigger
  history.replaceState(null, "", window.location.pathname);

  try {
    const cache = await caches.open("riffbank-share-target");
    const resp = await cache.match("shared-audio-file");
    if (!resp) return;

    const blob = await resp.blob();
    const fileName = decodeURIComponent(resp.headers.get("X-File-Name") || "audio");
    const fileType = resp.headers.get("X-File-Type") || "audio/*";
    const fileSize = parseInt(resp.headers.get("X-File-Size") || "0", 10);

    // Clean up the temp cache
    await cache.delete("shared-audio-file");

    // Show the share target sheet
    openShareTargetSheet(blob, fileName, fileType, fileSize);
  } catch (err) {
    console.error("Share target error:", err);
  }
}

function openShareTargetSheet(blob, fileName, fileType, fileSize) {
  // Check for file-name duplicates before showing options
  const dupHits = _findFileNameDuplicates(fileName);
  if (dupHits.length) {
    _showDuplicateFileDialog(fileName, dupHits, {
      onContinue: () => _openShareTargetSheetInner(blob, fileName, fileType, fileSize),
      onDismiss: () => {},
    });
    return;
  }
  _openShareTargetSheetInner(blob, fileName, fileType, fileSize);
}

function _openShareTargetSheetInner(blob, fileName, fileType, fileSize) {
  sheetMode = "shareTarget";
  const existingSongs = (state.songs || []).filter(s => s.title);

  sheetContent.innerHTML = `
    <div class="sheetTitle">Shared file</div>
    <div style="padding:0 20px 12px;color:#aaa;font-size:13px">${escapeHtml(fileName)}</div>

    <div class="sheetRow">
      <button class="sheetChoice" id="shareNewSong">
        New song
        <span class="sub">create a song with this file</span>
      </button>
      <button class="sheetChoice" id="shareExistingSong">
        Existing song
        <span class="sub">add as latest version</span>
      </button>
    </div>
  `;

  document.body.classList.add("sheetOpen");
  sheet?.setAttribute("aria-hidden", "false");
  sheetOverlay?.setAttribute("aria-hidden", "false");

  $("#shareNewSong")?.addEventListener("click", () => {
    closeSheet();
    openShareNewSongSheet(blob, fileName, fileType, fileSize);
  });

  $("#shareExistingSong")?.addEventListener("click", () => {
    closeSheet();
    openShareExistingSongSheet(blob, fileName, fileType, fileSize);
  });
}

function openShareNewSongSheet(blob, fileName, fileType, fileSize) {
  sheetMode = "shareNewSong";

  const existingProjects = [...new Set([
    ...(state.settings?.defaultProject ? [state.settings.defaultProject.trim()] : []),
    ...(state.projects || []).map(p => p.trim()).filter(Boolean),
    ...state.songs.map(s => (s.project || "").trim()).filter(Boolean),
  ])].sort();
  const defaultProj = state.settings.defaultProject || "";

  sheetContent.innerHTML = `
    <div class="sheetTitle">New song</div>
    <div style="padding:0 20px 12px;color:#aaa;font-size:13px">${escapeHtml(fileName)}</div>

    <div class="sheetForm">
      <input id="sheetSongTitle" type="text" placeholder="Title (e.g. Internal)" />
      <select id="sheetSongProject">
        ${existingProjects.map(p => `<option value="${escapeHtml(p)}"${p === defaultProj ? " selected" : ""}>${escapeHtml(p)}</option>`).join("")}
        <option value="__new__"${!existingProjects.length ? " selected" : ""}>+ New project…</option>
      </select>
      <input id="sheetNewProject" type="text" placeholder="Project name"
        style="display:${!existingProjects.length ? "block" : "none"}; margin-top:-4px" />
      <input id="sheetSongGenre" type="text" placeholder="Genre" value="${escapeHtml(state.settings.defaultGenre || "")}" />
      <input id="sheetSongSprint" type="text" placeholder="Sprint" value="${escapeHtml(state.settings.defaultSprint || "")}" />
    </div>

    <div class="sheetActions">
      <button class="sheetBtn ghost" id="sheetBack">Back</button>
      <button class="sheetBtn primary" id="sheetCreateSong">Create</button>
    </div>
  `;

  document.body.classList.add("sheetOpen");
  sheet?.setAttribute("aria-hidden", "false");
  sheetOverlay?.setAttribute("aria-hidden", "false");

  $("#sheetSongProject")?.addEventListener("change", (e) => {
    const isNew = e.target.value === "__new__";
    const inp = $("#sheetNewProject");
    if (inp) { inp.style.display = isNew ? "block" : "none"; }
    if (isNew) setTimeout(() => $("#sheetNewProject")?.focus(), 0);
  });

  $("#sheetBack")?.addEventListener("click", () => {
    closeSheet();
    openShareTargetSheet(blob, fileName, fileType, fileSize);
  });

  $("#sheetCreateSong")?.addEventListener("click", async () => {
    const title = ($("#sheetSongTitle")?.value || "").trim();
    if (!title) return toast("Give it a title 🙂");

    const projSel = $("#sheetSongProject")?.value || "";
    const projectRaw = projSel === "__new__"
      ? ($("#sheetNewProject")?.value || "").trim()
      : projSel;

    const song = {
      id: uid(),
      title,
      project: projectRaw || "Project",
      genre: ($("#sheetSongGenre")?.value || "").trim() || "",
      sprint: ($("#sheetSongSprint")?.value || "").trim() || "Unsorted",
      instrumentation: "",
      collaborators: "",
      status: "Idea",
      stuckState: "Active",
      nextAction: "",
      vibes: "",
      lyrics: "",
      notes: "",
      versions: [],
      createdAt: nowStamp(),
      updatedAt: nowStamp(),
    };

    ensureProjectInState(song.project);
    state.songs.unshift(song);

    // Create version and attach audio — upload to cloud before navigating
    const v = createVersion(song);
    saveState();

    closeSheet();
    toast("Uploading to cloud…");
    await attachSharedAudio(song, v, blob, fileName, fileType, fileSize);

    R.currentTab = "songs";
    R.songsView = "list";
    R.selectedSongId = song.id;
    setHeader("Song");
    syncTabs();
    render();
    autoGenerateArt(song);
  });

  setTimeout(() => $("#sheetSongTitle")?.focus(), 0);
}

function openShareExistingSongSheet(blob, fileName, fileType, fileSize) {
  sheetMode = "shareExistingSong";

  const songs = (state.songs || []).filter(s => s.title);

  sheetContent.innerHTML = `
    <div class="sheetTitle">Choose song</div>
    <div style="padding:0 20px 12px;color:#aaa;font-size:13px">${escapeHtml(fileName)}</div>

    <div class="sheetForm">
      <input id="shareSearchSongs" type="text" placeholder="Search songs…" />
    </div>

    <div id="shareSongList" class="sheetRow" style="flex-direction:column;max-height:50vh;overflow-y:auto">
      ${songs.map(s => `
        <button class="sheetChoice sharePickSong" data-id="${s.id}" style="text-align:left">
          ${escapeHtml(s.title)}
          <span class="sub">${escapeHtml(s.project || "")}${s.versions?.length ? ` · ${s.versions.length} version${s.versions.length > 1 ? "s" : ""}` : ""}</span>
        </button>
      `).join("")}
    </div>

    <div class="sheetActions">
      <button class="sheetBtn ghost" id="sheetBack">Back</button>
    </div>
  `;

  document.body.classList.add("sheetOpen");
  sheet?.setAttribute("aria-hidden", "false");
  sheetOverlay?.setAttribute("aria-hidden", "false");

  // Search filter
  $("#shareSearchSongs")?.addEventListener("input", (e) => {
    const q = (e.target.value || "").toLowerCase();
    const list = document.getElementById("shareSongList");
    if (!list) return;
    for (const btn of list.querySelectorAll(".sharePickSong")) {
      const text = (btn.textContent || "").toLowerCase();
      btn.style.display = !q || text.includes(q) ? "" : "none";
    }
  });

  $("#sheetBack")?.addEventListener("click", () => {
    closeSheet();
    openShareTargetSheet(blob, fileName, fileType, fileSize);
  });

  // Song pick handlers
  for (const btn of document.querySelectorAll(".sharePickSong")) {
    btn.addEventListener("click", async () => {
      const songId = btn.dataset.id;
      const song = getSong(songId);
      if (!song) return toast("Song not found 😅");

      const v = createVersion(song);
      saveState();

      closeSheet();
      toast("Uploading to cloud…");
      await attachSharedAudio(song, v, blob, fileName, fileType, fileSize);

      R.currentTab = "songs";
      R.songsView = "list";
      R.selectedSongId = song.id;
      setHeader("Song");
      syncTabs();
      render();
    });
  }

  setTimeout(() => $("#shareSearchSongs")?.focus(), 0);
}

async function attachSharedAudio(song, v, blob, fileName, fileType, fileSize) {
  const id = uid();

  await audioPut({
    id,
    name: fileName,
    type: fileType,
    size: fileSize,
    blob,
    createdAt: nowStamp(),
  });

  v.fileId = id;
  v.fileName = fileName;
  v.fileType = fileType;
  v.fileSize = fileSize;

  song.updatedAt = nowStamp();
  saveState();

  // Upload to Supabase Storage (compress large files first)
  toast("Syncing to cloud…");
  try {
    const compressed = await compressAudioForUpload(blob, globalAudio);
    const result = await supabaseUploadAudio({
      blob: new File([compressed], fileName, { type: compressed.type || fileType }),
      songId: song.id,
      versionId: v.id,
      fileName,
    });
    if (result.success) {
      v.audioPath = result.audioPath;
      localStorage.setItem(LS_KEY, JSON.stringify(state));
      // Push immediately — don't rely on 5s debounce (iOS kills bg timers)
      const pushOk = await supabasePushState(state).catch(e => { console.warn("[Push]", e); return false; });
      toast(pushOk ? "Synced to cloud" : "Audio uploaded, but song record failed to sync");
    } else {
      toast("Cloud sync failed — will retry on next launch");
    }
  } catch (e) {
    console.warn("[attachSharedAudio] cloud upload failed:", e);
    toast("Cloud sync failed — will retry on next launch");
  }
}

// Yield to the main thread so the audio pipeline doesn't starve
// yieldToMain now in ui/dom.js

// waitForAudioIdle now in audio/cloudSync.js

// Cloud-only portion of attachSharedAudio (fire-and-forget for non-blocking uploads)
// Waits for audio playback to pause before uploading to avoid glitching playback.
async function attachSharedAudioCloud(song, v, blob, fileName, fileType) {
  const logId = v.id || uid();
  const title = song.title || fileName;
  logActivity(logId, title, "saving", "Waiting to sync…");

  // Don't upload while audio is playing — causes stuttering and glitches
  if (!globalAudio.paused) {
    logActivity(logId, title, "saving", "Waiting for playback to pause…");
    await waitForAudioIdle();
  }

  toast("Syncing to cloud…");
  try {
    await yieldToMain();
    logActivity(logId, title, "compressing", "Compressing audio…");
    const compressed = await compressAudioForUpload(blob, globalAudio);
    await yieldToMain();

    // Re-check: if user started playing during compression, wait again
    if (!globalAudio.paused) {
      logActivity(logId, title, "uploading", "Waiting for playback to pause…");
      await waitForAudioIdle();
    }

    logActivity(logId, title, "uploading", "Uploading to cloud…");
    const result = await supabaseUploadAudio({
      blob: new File([compressed], fileName, { type: compressed.type || fileType }),
      songId: song.id,
      versionId: v.id,
      fileName,
    });
    await yieldToMain();
    if (result.success) {
      v.audioPath = result.audioPath;
      localStorage.setItem(LS_KEY, JSON.stringify(state));
      logActivity(logId, title, "syncing", "Syncing song record…");
      await yieldToMain();
      const pushOk = await supabasePushState(state).catch(e => { console.warn("[Push]", e); return false; });
      logActivity(logId, title, "done", pushOk ? "Synced to cloud" : "Audio uploaded, record sync failed");
      toast(pushOk ? "Synced to cloud" : "Audio uploaded, but song record failed to sync");
    } else {
      logActivity(logId, title, "failed", "Cloud upload failed");
      console.warn(`[CloudSync] Upload failed for "${title}":`, result.error);
      toast(`Cloud sync failed for "${title}" — will retry on next launch`);
    }
  } catch (e) {
    console.warn(`[CloudSync] Upload error for "${title}":`, e);
    logActivity(logId, title, "failed", "Cloud upload error");
    toast(`Cloud sync failed for "${title}" — will retry on next launch`);
  }
}



async function init() {
  initAppContext({ render, navigateForward, goBack, setHeader, syncTabs, setActiveScreen, getActiveScreenEl: () => activeScreenEl, _updateNotifBadge, resetSongsFilters, getSongsListState: () => songsListState, getProjectsOwnerFilter: () => projectsOwnerFilter, setProjectsOwnerFilter: (v) => { projectsOwnerFilter = v; }, openCreateOverlay, openSheet, openSongMenu, playVersion, addToQueue, createVersion, setActive, openSongFilters, pickAudioFile, getGlobalAudio: () => globalAudio, unlockAudioOnce, playNowPlaying, syncMiniPlayerUI, shareInviteSong, openVersionMenu, nav, refreshSharedData, syncMessageBadges });

  if (!DISABLE_SPLASH) {
    await runSplashSequence();
  } else {
    const splash = document.getElementById("splash");
    if (splash) splash.remove();
    await new Promise(r => requestAnimationFrame(r));
  }

  // ── Auth gate: require login before loading app ──
  const session = await getSession();
  let authed = !!session;
  if (authed) {
    // Verify session is still valid server-side (e.g. user deleted)
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) { await supabase.auth.signOut(); authed = false; }
  }
  if (!authed) {
    await showAuthScreen();
  } else if (isPasswordRecovery()) {
    // User arrived via password reset email — force them to set a new password
    // before continuing into the app.
    await showAuthScreen({ initialView: "reset" });
  }

  // ── Boot overlay: show immediately after auth so there's no black screen ──
  const bootOverlay = document.createElement("div");
  bootOverlay.id = "splash";
  bootOverlay.setAttribute("aria-hidden", "false");
  bootOverlay.classList.add("phase1"); // skip intro anim, go straight to visible
  bootOverlay.innerHTML = `
    <div class="splashInner">
      <div id="splashTitle" class="ready" style="animation:welcomeTitleShimmer 3s ease infinite;opacity:1;transform:none">RiffBank</div>
      <div id="splashSub" class="splashSub show static">
        <span id="splashSubText" class="splashSubText">Indexing your universe</span>
        <span class="splashEllipsis" aria-hidden="true">
          <span></span><span></span><span></span>
        </span>
      </div>
    </div>`;
  document.body.appendChild(bootOverlay);
  // Force paint so overlay is visible before we do anything else
  bootOverlay.offsetHeight;
  document.body.classList.remove("splashing");

  // Profile setup — show once after signup if no profile exists
  await showProfileSetupIfNeeded();

  // ── Claim loaded invite if pending (from invite.html?li=TOKEN, URL ?li= param, or cookie) ──
  const _urlLI = new URLSearchParams(window.location.search).get("li");
  const _cookieLI = document.cookie.match(/(?:^|;\s*)pendingLoadedInvite=([^;]*)/)?.[1];
  const _pendingLI = _urlLI || localStorage.getItem("pendingLoadedInvite") || (_cookieLI ? decodeURIComponent(_cookieLI) : null);
  if (_urlLI) {
    // Clean the li param from the URL so it doesn't fire again on refresh
    const _cleanUrl = new URL(window.location);
    _cleanUrl.searchParams.delete("li");
    history.replaceState(null, "", _cleanUrl.pathname + (_cleanUrl.search || "") + _cleanUrl.hash);
  }
  if (_pendingLI) {
    localStorage.removeItem("pendingLoadedInvite");
    document.cookie = "pendingLoadedInvite=;path=/;max-age=0"; // clear cookie
    try {
      const claimResult = await claimLoadedInvite(_pendingLI);
      if (claimResult?.success) {
        // Store for post-boot toast
        window._loadedInviteClaimResult = claimResult;
      } else if (claimResult?.error) {
        console.warn("[LoadedInvite] claim error:", claimResult.error);
      }
    } catch (e) {
      console.warn("[LoadedInvite] claim failed:", e);
    }
  }

  // If local state is empty, pull from Supabase before showing the app
  // (on fresh install / cache wipe, localStorage has no songs yet)
  if (!state.songs.length) {
    try {
      await incrementalSyncFromSupabase();
      setImportFlowRan(true); // skip the background re-sync later
    } catch (e) { console.warn("[Init] sync failed:", e); }
  }

  // ── Subtext jump-swap helper (rotate transition between lines) ──
  const JUMP_MS = parseInt(getComputedStyle(document.documentElement)
    .getPropertyValue("--splash-jump-ms").trim(), 10) || 520;
  const _sleep = ms => new Promise(r => setTimeout(r, ms));
  const bootSub = bootOverlay.querySelector("#splashSub");
  const bootSubText = bootOverlay.querySelector("#splashSubText");

  async function jumpSwap(nextText) {
    if (!bootSub || !bootSubText) return;
    bootSub.classList.remove("static");
    bootSub.classList.remove("jumpIn", "jumpOut");
    void bootSub.offsetHeight;
    bootSub.classList.add("jumpOut");
    await _sleep(JUMP_MS);
    bootSub.classList.remove("jumpOut");
    bootSubText.textContent = nextText;
    void bootSub.offsetHeight;
    bootSub.classList.add("jumpIn");
    await _sleep(JUMP_MS);
    bootSub.classList.remove("jumpIn");
    bootSub.classList.add("static");
  }

  // Build badge — always-visible cache version indicator for debugging
  if (SHOW_BUILD_BADGE) {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    const swUrl = (reg?.active?.scriptURL || "");
    // Read CACHE_VERSION from sw.js via a fetch so it stays in sync
    let buildId = "?";
    try {
      const swText = await fetch("/sw.js?" + Date.now()).then(r => r.text());
      const m = swText.match(/CACHE_VERSION\s*=\s*"([^"]+)"/);
      if (m) buildId = m[1];
    } catch {}
    const badge = document.createElement("div");
    badge.id = "buildBadge";
    badge.textContent = `v${buildId}`;
    badge.style.cssText = "position:fixed;top:4px;left:50%;transform:translateX(-50%);z-index:999999;background:rgba(0,0,0,.75);color:#0f0;font:bold 10px/1 monospace;padding:3px 6px;border-radius:4px;pointer-events:none;white-space:nowrap;";
    document.body.appendChild(badge);
  }

  // Seed example release if none exist yet
  if (!state.releases.length) {
    const jmSongs = state.songs.filter(s => /jonathan/i.test(s.project || ""));
    if (jmSongs.length) {
      state.releases.push({
        id: uid(),
        title: "The Life EP",
        artist: "Jonathan Marrs",
        songIds: jmSongs.map(s => s.id),
        releaseDate: "2026-06-01",
        createdAt: nowStamp(),
        updatedAt: nowStamp(),
      });
      saveState();
    }
  }

  // Render the app behind the boot overlay
  setHeader("RiffBank");
  syncTabs();
  render();
  syncMiniPlayerUI();

  // Now that the home screen is painted, fade out any remaining onboarding overlays
  dismissOnboarding();

  // ── Sync data while cycling through subtext lines ──
  const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(r, ms))]);

  let syncDone = false;
  const syncTask = withTimeout(Promise.all([
    restoreCoverUrlsFromCache(state.songs, supabaseFetchCoverBlob).then(() => render()).catch(() => {}),
    (!getImportFlowRan()
      ? incrementalSyncFromSupabase().then(() => {
          preFetchCloudAudio().catch(console.warn);
        }).catch(console.warn)
      : Promise.resolve()),
  ]), 8000).then(() => { syncDone = true; }); // 8s max — don't block the app forever

  // Background sweep: upload any local-only audio to cloud (fire-and-forget)
  syncTask.then(() => ensureAllAudioInCloud().catch(console.warn));

  // Resume any interrupted bulk imports from a previous session
  _loadImportQueue();
  _pruneImportQueue();
  const pendingImports = importQueue.filter(q => q.status === "waiting" || q.status === "uploading");
  if (pendingImports.length) {
    console.log(`[BulkImport] Resuming ${pendingImports.length} interrupted import(s)`);
    // Reset any "uploading" items back to "waiting" since the upload was interrupted
    for (const q of pendingImports) { if (q.status === "uploading") q.status = "waiting"; }
    _saveImportQueue();
    _updateNotifBadge();
    syncTask.then(() => _processImportQueue().catch(console.warn));
  }

  // Cycle subtext until sync finishes, then show "Entering RiffBank"
  const lines = ["Indexing your universe", "Syncing sessions"];
  let lineIdx = 0;
  const MIN_HOLD = 1200; // minimum time per line so it doesn't flash

  // Show first line for at least MIN_HOLD, then cycle until sync is done
  await _sleep(MIN_HOLD);
  while (!syncDone) {
    lineIdx = (lineIdx + 1) % lines.length;
    await jumpSwap(lines[lineIdx]);
    // Wait for either sync to finish or MIN_HOLD, whichever is longer
    await Promise.race([syncTask, _sleep(MIN_HOLD)]);
  }

  // Sync is done — show "Entering RiffBank" briefly then dismiss
  await jumpSwap("Entering RiffBank");
  await _sleep(700);

  // Scan cached audio blobs + re-link orphaned versions (non-blocking)
  (async () => {
    // Phase 0: Strip stale local fileId/localAudioId from versions that already have
    // VALID cloud audio (audioPath with non-zero blob). A previous bug preserved these
    // during cloud sync, causing the player to use a truncated local blob instead of
    // the full cloud copy. Only strip if cloud blob is verified non-empty.
    let stripped = 0;
    for (const song of (state.songs || [])) {
      for (const v of (song.versions || [])) {
        if (v.audioPath && (v.fileId || v.localAudioId)) {
          const cached = await audioGet(`supa:${v.audioPath}`).catch(() => null);
          if (cached?.blob?.size) {
            v.fileId = null;
            v.localAudioId = null;
            stripped++;
          } else {
            console.warn(`[Boot] Keeping local refs for "${song.title}" — cloud blob missing or empty`);
          }
        }
      }
    }
    if (stripped) {
      console.log(`[Boot] Stripped ${stripped} stale local audio ref(s) — cloud audio verified`);
      saveState();
    }

    // Phase 0b: Validate all cloud audioPaths — clear any that point to 0-byte or missing files.
    // This catches corrupt uploads so songs don't appear playable when they aren't.
    let cleared = 0;
    for (const song of (state.songs || [])) {
      for (const v of (song.versions || [])) {
        if (!v.audioPath) continue;
        // Check IDB cache first (free), then live-fetch (one HEAD-like request per version)
        let valid = false;
        try {
          const cached = await audioGet(`supa:${v.audioPath}`);
          if (cached?.blob?.size) { valid = true; continue; }
        } catch {}
        try {
          const blob = await supabaseFetchAudioBlob(v.audioPath);
          if (blob?.size) { valid = true; continue; }
        } catch {}
        if (!valid) {
          console.warn(`[Boot] Cloud audio empty/missing for "${song.title}" — clearing audioPath`);
          supabaseDeleteAudio(v.audioPath).catch(() => {});
          v.audioPath = null;
          cleared++;
        }
      }
    }
    if (cleared) {
      console.log(`[Boot] Cleared ${cleared} broken cloud audio ref(s)`);
      saveState();
      render();
    }

    // Phase 1: Track which cloud audio is already cached in IndexedDB
    for (const song of (state.songs || [])) {
      for (const v of (song.versions || [])) {
        if (!v.audioPath || v.fileId || v.localAudioId) continue;
        try {
          const rec = await audioGet(`supa:${v.audioPath}`);
          if (rec?.blob) cachedAudioPaths.add(v.audioPath);
        } catch {}
      }
    }

    // Phase 1.5: Backfill missing fileNames from IDB records.
    // Cloud sync can return file_name=null for versions uploaded before the column was populated.
    try {
      let backfilled = 0;
      for (const song of (state.songs || [])) {
        for (const v of (song.versions || [])) {
          if (v.fileName) continue; // already has a name
          if (!v.fileId) continue;  // no local audio to look up
          try {
            const rec = await audioGet(v.fileId);
            if (rec?.name) {
              v.fileName = rec.name;
              backfilled++;
            }
          } catch {}
        }
      }
      if (backfilled) {
        console.log(`[Boot] Backfilled fileName for ${backfilled} version(s)`);
        saveState();
      }
    } catch (e) { console.warn("[Boot] fileName backfill failed:", e); }

    // Phase 2: Re-link versions that lost their fileId during cloud sync.
    // Scan IndexedDB for orphaned blobs and match by filename.
    try {
      const allBlobs = await audioGetAll();
      if (allBlobs.length) {
        const blobByName = new Map();
        const blobById = new Map();
        for (const rec of allBlobs) {
          if (rec.id.startsWith("supa:")) continue;
          if (rec.name) blobByName.set(rec.name, rec);
          blobById.set(rec.id, rec);
        }
        // Also build fuzzy lookup: blob name without extension → blob
        const blobByTitleKey = new Map();
        for (const rec of allBlobs) {
          if (rec.id.startsWith("supa:") || !rec.name) continue;
          const key = rec.name.replace(/\.[^.]+$/, "").toLowerCase().trim();
          if (key) blobByTitleKey.set(key, rec);
        }
        const usedIds = new Set();
        let relinked = 0;
        for (const song of (state.songs || [])) {
          for (const v of (song.versions || [])) {
            if (v.fileId || v.localAudioId || v.audioPath) continue; // already has audio
            let rec = blobByName.get(v.fileName) || blobByName.get(v.originalFileName);
            // Fuzzy: match blob filename (sans extension) to song title
            if (!rec) {
              const titleKey = (song.title || "").toLowerCase().trim();
              if (titleKey) rec = blobByTitleKey.get(titleKey);
            }
            if (rec?.blob && !usedIds.has(rec.id)) {
              usedIds.add(rec.id);
              v.fileId = rec.id;
              v.fileType = v.fileType || rec.type || "";
              v.fileSize = v.fileSize || rec.size || 0;
              if (!v.fileName && rec.name) v.fileName = rec.name;
              relinked++;
            }
          }
        }
        if (relinked) {
          console.log(`[Boot] Re-linked ${relinked} orphaned audio ref(s)`);
          saveState();
          render();
        }
      }
    } catch (e) { console.warn("[Boot] Audio re-link scan failed:", e); }
  })();

  // Final render with all data in place, then fade out
  // Show loaded invite welcome screen BEFORE render — go directly from splash to welcome
  const _hasInviteWelcome = !!window._loadedInviteClaimResult;
  if (_hasInviteWelcome) {
    const r = window._loadedInviteClaimResult;
    delete window._loadedInviteClaimResult;
    _showLoadedInviteWelcome(r);
  }

  render();
  syncMiniPlayerUI();

  bootOverlay.classList.add("hide");
  bootOverlay.addEventListener("transitionend", () => bootOverlay.remove());

  // Sync unread message badges — seed notifications for any pending friend requests not yet in inbox
  getPendingFriendRequests().then(requests => {
    for (const r of requests) {
      _knownFriendRequestIds.add(r.id);
      const existing = _loadNotifications();
      if (!existing.some(n => n.friendshipId === r.id)) {
        const name = r.profile?.display_name || "Someone";
        addNotification({ title: "Friend Request", body: `${name} sent you a friend request`, type: "friend_request", friendshipId: r.id, requesterName: name, requesterId: r.requester_id, avatarUrl: r.profile?.avatar_url || null });
      }
    }
  }).catch(() => {});
  syncMessageBadges();

  // Request notification permission on first user tap (iOS requires user gesture)
  _attachNotifPermissionToGesture();

  // Update notification bell badge on startup
  _updateNotifBadge();

  // Check for Web Share Target file
  checkSharedAudioFile();

  // Fetch shared data + loaded invites immediately so collab tab is populated
  Promise.all([
    refreshSharedData(),
    _refreshLoadedInvites(),
  ]).then(() => {
    // Re-render if user is on a tab that shows shared content
    if (R.currentTab === "player" || R.currentTab === "collab" || R.currentTab === "songs" || R.drawerView) render();
  }).catch(console.warn);

  // Realtime: instant notifications for shares, messages, friend requests, and own song changes
  // Debounce own-song changes: the realtime subscription fires for our OWN writes too,
  // which triggers a pull→merge→render loop mid-playback. Only sync if we haven't
  // pushed recently (i.e., the change came from another device).
  let _ownSongDebounce = null;
  subscribeToRealtimeNotifications({
    onOwnSongChange: () => {
      // Skip during bulk import — partial cloud state would delete un-pushed songs
      if (_importQueueRunning) {
        console.log("[Realtime] Ignoring own-song change — bulk import running");
        return;
      }
      // Skip if audio is actively playing — sync can disrupt playback
      if (globalAudio && !globalAudio.paused) {
        console.log("[Realtime] Ignoring own-song change — audio playing");
        return;
      }
      // Debounce: wait 3s after last event before syncing (batches rapid-fire events)
      clearTimeout(_ownSongDebounce);
      _ownSongDebounce = setTimeout(() => {
        console.log("[Realtime] Own song changed — syncing from cloud");
        incrementalSyncFromSupabase().catch(console.warn);
      }, 3000);
    },
    onNewShare: async (row) => {
      // Look up who shared it
      const senderId = row?.invited_by || row?.owner_id;
      const profile = senderId ? await getProfileById(senderId).catch(() => null) : null;
      const name = profile?.display_name || "Someone";
      const avatar = profile?.avatar_url || null;
      const label = row?.song_id ? `${name} shared a song with you` : `${name} shared a project with you`;
      addNotification({ title: name, body: label, type: "share" });
      _showPushNotification(label, "riffbank-new-share", { title: name, icon: avatar });
      toast(label);
      // Refresh full shared data in background (for UI updates)
      refreshSharedData().then(() => {
        if (R.currentTab === "player" || R.currentTab === "collab" || R.currentTab === "songs" || R.drawerView) render();
      }).catch(() => {});
    },
    onNewMessage: async (row) => {
      // Look up sender profile for rich notification
      const profile = row?.sender_id ? await getProfileById(row.sender_id).catch(() => null) : null;
      const name = profile?.display_name || "Someone";
      const avatar = profile?.avatar_url || null;
      const body = row?.body || "Sent you a message";
      // Truncate long messages for the notification
      const preview = body.length > 100 ? body.slice(0, 100) + "…" : body;
      _showPushNotification(preview, "riffbank-msg-" + (row?.sender_id || ""), { title: name, icon: avatar });
      syncMessageBadges();
    },
    onNewFriendRequest: async (row) => {
      const senderId = row?.requester_id;
      const profile = senderId ? await getProfileById(senderId).catch(() => null) : null;
      const name = profile?.display_name || "Someone";
      const avatar = profile?.avatar_url || null;
      addNotification({
        title: "Friend Request",
        body: `${name} sent you a friend request`,
        type: "friend_request",
        friendshipId: row?.id,
        requesterName: name,
        requesterId: senderId,
        avatarUrl: avatar,
      });
      _showPushNotification(`${name} sent you a friend request`, "riffbank-friend-request", { title: name, icon: avatar });
      syncMessageBadges();
    },
  });

  // Fallback: poll shared data + own songs every 60s in case Realtime disconnects
  setInterval(() => {
    refreshSharedData().then(() => {
      if (R.currentTab === "player" || R.currentTab === "collab" || R.currentTab === "songs" || R.drawerView) render();
    }).catch(() => {});
    // Skip sync while bulk import is running — partial cloud state would delete un-pushed songs
    if (!_importQueueRunning) {
      incrementalSyncFromSupabase().catch(console.warn);
    }
  }, 60000);
}

// Incremental sync: pull Supabase state and merge only new/changed songs

// ES modules run after DOM is parsed, so DOMContentLoaded may already be gone
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", init);
} else {
  init(); // DOM already ready by the time the module ran
}

// ---------------------


function renderEPs() {
  setHeader("EPs");
  activeScreenEl.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between; align-items:center">
        <h2>EPs</h2>
        <button id="closeDrawerView" class="ghost">Close</button>
      </div>
      <div class="small">Ready for next step: define EPs and assign songs.</div>
    </div>
  `;
  $("#closeDrawerView").addEventListener("click", () => {
    R.drawerView = null;
    setHeader(TAB_TITLES[R.currentTab] || "RiffBank");
    render();
  });
}

function renderCollaborators() {
  setHeader("Collaborators");

  const counts = {};
  state.songs.forEach(s => {
    const raw = (s.collaborators || "").split(",").map(x => x.trim()).filter(Boolean);
    raw.forEach(name => counts[name] = (counts[name] || 0) + 1);
  });

  const rows = Object.entries(counts)
    .sort((a,b) => b[1] - a[1])
    .map(([name, count]) => `
      <div class="item" style="cursor:default">
        <div class="row" style="justify-content:space-between; align-items:center">
          <div class="title"><b>${escapeHtml(name)}</b></div>
          <span class="badge">${count} song${count === 1 ? "" : "s"}</span>
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn" data-filter-collab="${escapeHtml(name)}">View songs</button>
        </div>
      </div>
    `).join("");

  activeScreenEl.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between; align-items:center">
        <h2>Collaborators</h2>
        <button id="closeDrawerView" class="ghost">Close</button>
      </div>
      <div class="small">Pulled from song "Collaborators" field (comma-separated).</div>
      <div class="hr"></div>

      <div class="list">
        ${rows || `<div class="small">No collaborators yet. Add names like "Darian, Mason".</div>`}
      </div>
    </div>
  `;

  $("#closeDrawerView").addEventListener("click", () => {
    R.drawerView = null;
    setHeader(TAB_TITLES[R.currentTab] || "RiffBank");
    render();
  });

  activeScreenEl.querySelectorAll("[data-filter-collab]").forEach(btn => {
    btn.addEventListener("click", () => {
      const name = btn.getAttribute("data-filter-collab");
      R.drawerView = null;
      R.currentTab = "songs";
      R.songsView = "list";
      R.selectedSongId = null;
      setHeader("Songs");
      syncTabs();
      render();
      setTimeout(() => {
        const q = $("#q");
        if (q) {
          q.value = name;
          q.dispatchEvent(new Event("input"));
          toast(`Showing: ${name}`);
        }
      }, 0);
    });
  });
}

function renderImportExport() {
  setHeader("Import / Export");

  activeScreenEl.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between; align-items:center">
        <h2>Import / Export</h2>
        <button id="closeDrawerView" class="ghost">Close</button>
      </div>
      <div class="small">Export first if you care. Import replaces local data.</div>
      <div class="hr"></div>
      <div class="row" style="gap:10px">
        <button id="doExport" class="btn primary">Export backup</button>
        <button id="doImport" class="btn">Import backup</button>
      </div>
    </div>
  `;

  $("#closeDrawerView").addEventListener("click", () => {
    R.drawerView = null;
    setHeader(TAB_TITLES[R.currentTab] || "RiffBank");
    render();
  });

  $("#doExport").addEventListener("click", () => $("#exportBtn")?.click());
  $("#doImport").addEventListener("click", () => $("#importFile")?.click());
}

function renderAbout() {
  setHeader("About");

  activeScreenEl.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between; align-items:center">
        <h2>RiffBank</h2>
        <button id="closeDrawerView" class="ghost">Close</button>
      </div>
      <div class="small">Local-only PWA. Your data lives in localStorage on this device.</div>
      <div class="hr"></div>
      <div class="small">
        <div><b>Storage key:</b> ${escapeHtml(LS_KEY)}</div>
        <div style="margin-top:6px"><b>Total songs:</b> ${state.songs.length}</div>
      </div>
    </div>
  `;

  $("#closeDrawerView").addEventListener("click", () => {
    R.drawerView = null;
    setHeader(TAB_TITLES[R.currentTab] || "RiffBank");
    render();
  });
}

function resetSongsFilters({ keepSort = true } = {}) {
  const sort = songsListState.sortMode || "updated";
  songsListState.query = "";
  songsListState.statusFilter = "";
  songsListState.projectFilter = "";
  if (!keepSort) songsListState.sortMode = "updated";
  else songsListState.sortMode = sort;
}

// ---------------------
// Home
// ---------------------


function buildInviteUrl(projectName) {
  const base = `${location.origin}/invite`;
  const params = new URLSearchParams();
  // Get current user's display name or email
  const userEmail = supabase.auth.getUser?.()?.then?.(r => r.data?.user?.email) || "";
  const fromName = state.settings?.displayName || "";
  if (fromName) params.set("from", fromName);
  if (projectName) params.set("project", projectName);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

async function getInviteUrl(projectName) {
  const base = `${location.origin}/invite`;
  const params = new URLSearchParams();
  try {
    const { data } = await supabase.auth.getUser();
    const fromName = state.settings?.displayName || data?.user?.email?.split("@")[0] || "";
    if (fromName) params.set("from", fromName);
  } catch {}
  if (projectName) params.set("project", projectName);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

// Legacy invite (no role/token — just a link to install RiffBank)
async function shareInviteLegacy(projectName) {
  const url = await getInviteUrl(projectName);
  const text = projectName
    ? `Join me on RiffBank to collaborate on "${projectName}"!`
    : "Join me on RiffBank — the app for managing songs, versions, and releases!";
  if (navigator.share) {
    try { await navigator.share({ title: "RiffBank Invite", text, url }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(`${text}\n${url}`); toast("Invite link copied!"); }
  catch { toast("Couldn't copy — try manually"); }
}

// New sharing flow — creates a DB invite token with role, then shares the link
async function shareInvite(projectName) {
  // Resolve the Supabase project ID from name
  let projectId = null;
  if (projectName) {
    try {
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData?.user?.id;
      if (uid) {
        const { data: proj } = await supabase
          .from("projects").select("id").eq("owner_id", uid).eq("name", projectName).maybeSingle();
        projectId = proj?.id || null;
      }
    } catch {}
  }

  if (!projectId) {
    // Fall back to legacy invite if we can't resolve project
    return shareInviteLegacy(projectName);
  }

  // Open role picker sheet
  openShareRoleSheet({ projectId, projectName, songId: null, songTitle: null });
}

// Share a specific song
async function shareInviteSong(songId) {
  const song = getSong(songId);
  if (!song) return toast("Song not found");
  openShareRoleSheet({ projectId: null, projectName: null, songId: song.id, songTitle: song.title });
}

// ── Sharing management overlay ──────────────────────────────────────
let shareOverlayEl = null;
let _shareRoleDropdownScrim = null;

const _roleSvg = {
  collaborator: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  viewer: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
};

function openShareOverlay({ projectId, projectName, songId, songTitle }) {
  if (shareOverlayEl) shareOverlayEl.remove();
  shareOverlayEl = document.createElement("div");
  shareOverlayEl.className = "shareOverlay";
  document.body.appendChild(shareOverlayEl);
  requestAnimationFrame(() => shareOverlayEl.classList.add("open"));

  _renderSharingManagement({ projectId, projectName, songId, songTitle });
}

async function _renderSharingManagement({ projectId, projectName, songId, songTitle }) {
  if (!shareOverlayEl) return;
  const targetLabel = projectName || songTitle || "content";

  // Show loading state
  shareOverlayEl.innerHTML = `
    <div class="shareOverlayHeader">
      <button class="shareOverlayClose" id="shareClose">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <div class="shareOverlayTitle">Sharing</div>
    </div>
    <div class="shareResultsEmpty"><div class="collabSpinner"></div></div>
  `;
  $("#shareClose")?.addEventListener("click", closeShareOverlay);

  // Fetch current shares
  const shares = songId ? await getSongShares(songId) : [];

  if (!shareOverlayEl) return; // closed while loading

  shareOverlayEl.innerHTML = `
    <div class="shareOverlayHeader">
      <button class="shareOverlayClose" id="shareClose">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <div class="shareOverlayTitle">Sharing</div>
    </div>

    <div class="sharingBody">
      <button class="sharingAddBtn" id="sharingAddBtn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/>
          <polyline points="16 6 12 2 8 6"/>
          <line x1="12" y1="2" x2="12" y2="15"/>
        </svg>
        Share "${escapeHtml(targetLabel)}"
      </button>

      <div class="sharingList" id="sharingList">
        ${shares.length ? shares.map(s => {
          const p = s.profile;
          const name = p.display_name || "Unknown";
          const meta = [p.instrument, p.genre, p.location].filter(Boolean).map(escapeHtml).join(" · ") || "RiffBank user";
          const avatarHtml = p.avatar_url
            ? (p.avatar_url.startsWith("preset:")
              ? (() => { const pr = AVATAR_PRESETS.find(a => a.id === p.avatar_url.replace("preset:","")); return pr ? `<div class="friendAvatar" style="width:48px;height:48px">${renderAvatarPreset(pr)}</div>` : `<div class="friendAvatar" style="width:48px;height:48px;font-size:18px">${escapeHtml(name.charAt(0).toUpperCase())}</div>`; })()
              : `<div class="friendAvatar" style="width:48px;height:48px"><img src="${escapeHtml(p.avatar_url)}" /></div>`)
            : `<div class="friendAvatar" style="width:48px;height:48px;font-size:18px">${escapeHtml(name.charAt(0).toUpperCase())}</div>`;
          return `
            <div class="friendRow sharingRow" data-uid="${escapeHtml(s.userId)}">
              ${avatarHtml}
              <div class="friendInfo">
                <div class="friendName">${escapeHtml(name)}</div>
                <div class="friendMeta">${meta}</div>
              </div>
              <button class="sharingRoleBadge" data-uid="${escapeHtml(s.userId)}" data-role="${s.role}">
                ${_roleSvg[s.role] || ""}
                ${s.role === "collaborator" ? "Collaborator" : "Viewer"}
              </button>
              <button class="friendRemoveBtn sharingRevokeBtn" data-uid="${escapeHtml(s.userId)}" aria-label="Revoke access">&times;</button>
            </div>
          `;
        }).join("") : `
          <div class="friendsEmpty">Not shared with anyone yet.<br>Tap the button above to share this song.</div>
        `}
      </div>
    </div>
  `;

  // Wire close
  $("#shareClose")?.addEventListener("click", closeShareOverlay);

  // Wire "Share" add button
  $("#sharingAddBtn")?.addEventListener("click", () => {
    _openShareAddFlow({ projectId, projectName, songId, songTitle });
  });

  // Wire role badge dropdowns
  shareOverlayEl.querySelectorAll(".sharingRoleBadge").forEach(badge => {
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      const uid = badge.dataset.uid;
      const currentRole = badge.dataset.role;
      _openRoleDropdown(badge, uid, currentRole, { projectId, projectName, songId, songTitle });
    });
  });

  // Wire revoke buttons
  shareOverlayEl.querySelectorAll(".sharingRevokeBtn").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const uid = btn.dataset.uid;
      const row = btn.closest(".sharingRow");
      const name = row?.querySelector(".friendName")?.textContent || "this user";
      if (!confirm(`Remove ${name}'s access?`)) return;
      btn.style.opacity = ".4";
      try {
        await revokeSongShare(songId, uid);
        toast(`Removed ${name}'s access`);
        _renderSharingManagement({ projectId, projectName, songId, songTitle });
      } catch (err) {
        console.error("Revoke failed:", err);
        toast("Failed to remove access");
        btn.style.opacity = "1";
      }
    });
  });
}

// ── Role dropdown + Sal confirmation dialog ─────────────────────────
function _openRoleDropdown(anchorEl, userId, currentRole, shareOpts) {
  _closeRoleDropdown();

  const otherRole = currentRole === "collaborator" ? "viewer" : "collaborator";
  const otherLabel = otherRole === "collaborator" ? "Collaborator" : "Viewer";
  const currentLabel = currentRole === "collaborator" ? "Collaborator" : "Viewer";

  // Scrim
  _shareRoleDropdownScrim = document.createElement("div");
  _shareRoleDropdownScrim.className = "shareRoleScrim open";
  document.body.appendChild(_shareRoleDropdownScrim);

  // Dropdown
  const dropdown = document.createElement("div");
  dropdown.className = "shareRoleDropdown";
  dropdown.innerHTML = `
    <button class="shareRoleDropItem active" data-role="${currentRole}">
      ${_roleSvg[currentRole]} ${currentLabel}
      <svg class="shareRoleCheck" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
    </button>
    <button class="shareRoleDropItem" data-role="${otherRole}">
      ${_roleSvg[otherRole]} ${otherLabel}
    </button>
  `;
  document.body.appendChild(dropdown);

  // Position dropdown above the badge
  const rect = anchorEl.getBoundingClientRect();
  dropdown.style.position = "fixed";
  dropdown.style.left = `${rect.left}px`;
  dropdown.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  dropdown.style.zIndex = "100002";
  requestAnimationFrame(() => dropdown.classList.add("open"));

  // Dismiss on scrim tap
  _shareRoleDropdownScrim.addEventListener("click", _closeRoleDropdown);

  // Wire role options
  dropdown.querySelectorAll(".shareRoleDropItem").forEach(item => {
    item.addEventListener("click", () => {
      const role = item.dataset.role;
      _closeRoleDropdown();
      if (role !== currentRole) {
        _openRoleConfirmDialog(userId, role, shareOpts);
      }
    });
  });
}

function _closeRoleDropdown() {
  if (_shareRoleDropdownScrim) {
    _shareRoleDropdownScrim.remove();
    _shareRoleDropdownScrim = null;
  }
  document.querySelectorAll(".shareRoleDropdown").forEach(el => el.remove());
}

function _openRoleConfirmDialog(userId, newRole, shareOpts) {
  const isCollab = newRole === "collaborator";
  const roleLabel = isCollab ? "Collaborator" : "Viewer";
  const blurb = isCollab
    ? "They'll be able to add songs, versions, and audio to this song."
    : "They'll only be able to browse and listen — no editing.";

  const backdrop = document.createElement("div");
  backdrop.className = "shareConfirmBackdrop";
  backdrop.innerHTML = `
    <div class="shareConfirmDialog">
      <img class="shareConfirmSal" src="./sal.png" alt="Sal" />
      <div class="shareConfirmTitle">Change access to ${roleLabel}?</div>
      <div class="shareConfirmBlurb">${blurb}</div>
      <div class="shareConfirmActions">
        <button class="shareConfirmCancel" id="roleConfirmCancel">Cancel</button>
        <button class="shareConfirmOk" id="roleConfirmOk">Change to ${roleLabel}</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add("open"));

  const close = () => {
    backdrop.classList.remove("open");
    setTimeout(() => backdrop.remove(), 200);
  };

  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector("#roleConfirmCancel").addEventListener("click", close);
  backdrop.querySelector("#roleConfirmOk").addEventListener("click", async () => {
    const okBtn = backdrop.querySelector("#roleConfirmOk");
    okBtn.textContent = "Updating...";
    okBtn.disabled = true;
    try {
      await updateSongShareRole(shareOpts.songId, userId, newRole);
      toast(`Changed to ${roleLabel}`);
      close();
      _renderSharingManagement(shareOpts);
    } catch (err) {
      console.error("Role update failed:", err);
      toast("Failed to update role");
      okBtn.textContent = `Change to ${roleLabel}`;
      okBtn.disabled = false;
    }
  });
}

// ── Add user sub-flow (search + role picker) ────────────────────────
function _openShareAddFlow({ projectId, projectName, songId, songTitle }) {
  if (!shareOverlayEl) return;
  const targetLabel = projectName || songTitle || "content";
  let selectedUser = null;
  let searchTimer = null;

  const renderAddFlow = () => {
    shareOverlayEl.innerHTML = `
      <div class="shareOverlayHeader">
        <button class="shareOverlayClose" id="shareAddBack">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div class="shareOverlayTitle">Share "${escapeHtml(targetLabel)}"</div>
      </div>

      <div class="shareSearchWrap">
        <svg class="shareSearchIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="shareSearch" class="shareSearchInput" type="text" placeholder="Search users..." autocomplete="off" />
      </div>

      ${selectedUser ? `
        <div class="shareSelected">
          <div class="shareSelectedInfo">
            ${selectedUser.avatar_url
              ? `<img class="shareUserAvatar" src="${escapeHtml(selectedUser.avatar_url)}" />`
              : `<div class="shareUserAvatar shareUserAvatarFallback">${escapeHtml((selectedUser.display_name || "?").charAt(0).toUpperCase())}</div>`
            }
            <div>
              <div class="shareSelectedName">${escapeHtml(selectedUser.display_name)}</div>
              <div class="shareSelectedMeta">${[selectedUser.instrument, selectedUser.genre, selectedUser.location].filter(Boolean).map(escapeHtml).join(" · ") || "RiffBank user"}</div>
            </div>
            <button class="shareSelectedClear" id="shareClearUser">&times;</button>
          </div>

          <div class="shareRolePicker">
            <div class="shareRoleLabel">Choose their access:</div>
            <button class="shareRoleOption" data-role="collaborator">
              <div class="shareRoleIcon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </div>
              <div>
                <div class="shareRoleOptionTitle">Collaborator</div>
                <div class="shareRoleOptionSub">Full edit — add songs, versions, audio</div>
              </div>
            </button>
            <button class="shareRoleOption" data-role="viewer">
              <div class="shareRoleIcon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              </div>
              <div>
                <div class="shareRoleOptionTitle">Viewer</div>
                <div class="shareRoleOptionSub">Browse &amp; listen only</div>
              </div>
            </button>
          </div>
        </div>
      ` : `
        <div class="shareResults" id="shareResults">
          <div class="shareResultsEmpty"><div class="collabSpinner"></div></div>
        </div>
      `}
    `;

    // Wire back button → return to management screen
    $("#shareAddBack")?.addEventListener("click", () => {
      _renderSharingManagement({ projectId, projectName, songId, songTitle });
    });

    // Load friends as default list
    const resultsDefault = $("#shareResults");
    if (resultsDefault && !selectedUser) {
      getMyFriends().then(friends => {
        const cur = $("#shareResults");
        if (!cur || $("#shareSearch")?.value?.trim()) return;
        if (!friends.length) {
          cur.innerHTML = `<div class="shareResultsEmpty">Search for people or add friends from the Collab tab</div>`;
          return;
        }
        cur.innerHTML = `<div class="shareRoleLabel" style="padding:0 4px 8px;font-size:12px">Your Friends</div><div class="shareResultsList">${friends.map(f => {
          const u = f.profile || {};
          const meta = [u.instrument, u.genre, u.location].filter(Boolean).join(" · ");
          return `
            <button class="shareUserRow" data-uid="${u.id}">
              ${u.avatar_url
                ? (u.avatar_url.startsWith("preset:")
                  ? (() => { const pr = AVATAR_PRESETS.find(a => a.id === u.avatar_url.replace("preset:","")); return pr ? `<div class="shareUserAvatar">${renderAvatarPreset(pr)}</div>` : `<div class="shareUserAvatar shareUserAvatarFallback">${escapeHtml((u.display_name || "?").charAt(0).toUpperCase())}</div>`; })()
                  : `<img class="shareUserAvatar" src="${escapeHtml(u.avatar_url)}" />`)
                : `<div class="shareUserAvatar shareUserAvatarFallback">${escapeHtml((u.display_name || "?").charAt(0).toUpperCase())}</div>`
              }
              <div class="shareUserInfo">
                <div class="shareUserName">${escapeHtml(u.display_name || "Unknown")}</div>
                <div class="shareUserMeta">${meta ? escapeHtml(meta) : "RiffBank user"}</div>
              </div>
            </button>
          `;
        }).join("")}</div>`;
        cur.querySelectorAll(".shareUserRow").forEach(row => {
          row.addEventListener("click", () => {
            const uid = row.getAttribute("data-uid");
            selectedUser = friends.find(f => f.profile?.id === uid)?.profile;
            renderAddFlow();
          });
        });
      }).catch(() => {
        const cur = $("#shareResults");
        if (cur) cur.innerHTML = `<div class="shareResultsEmpty">Search for people on RiffBank</div>`;
      });
    }

    // Wire search
    const searchInput = $("#shareSearch");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(async () => {
          const q = searchInput.value.trim();
          const resultsEl = $("#shareResults");
          if (!resultsEl) return;
          if (!q) { renderAddFlow(); return; }

          resultsEl.innerHTML = `<div class="shareResultsEmpty"><div class="collabSpinner"></div></div>`;
          const users = await searchUsers(q);
          if (!users.length) {
            resultsEl.innerHTML = `<div class="shareResultsEmpty">No users found for "${escapeHtml(q)}"</div>`;
            return;
          }
          resultsEl.innerHTML = `<div class="shareResultsList">${users.map(u => {
            const meta = [u.instrument, u.genre, u.location].filter(Boolean).join(" · ");
            return `
              <button class="shareUserRow" data-uid="${u.id}">
                ${u.avatar_url
                  ? `<img class="shareUserAvatar" src="${escapeHtml(u.avatar_url)}" />`
                  : `<div class="shareUserAvatar shareUserAvatarFallback">${escapeHtml((u.display_name || "?").charAt(0).toUpperCase())}</div>`
                }
                <div class="shareUserInfo">
                  <div class="shareUserName">${escapeHtml(u.display_name || "Unknown")}</div>
                  <div class="shareUserMeta">${meta ? escapeHtml(meta) : "RiffBank user"}</div>
                </div>
              </button>
            `;
          }).join("")}</div>`;
          resultsEl.querySelectorAll(".shareUserRow").forEach(row => {
            row.addEventListener("click", () => {
              const uid = row.getAttribute("data-uid");
              selectedUser = users.find(u => u.id === uid);
              renderAddFlow();
            });
          });
        }, 300);
      });
      if (!selectedUser) setTimeout(() => searchInput.focus(), 150);
    }

    // Wire clear selection
    $("#shareClearUser")?.addEventListener("click", () => {
      selectedUser = null;
      renderAddFlow();
    });

    // Wire role buttons → share and return to management
    shareOverlayEl.querySelectorAll(".shareRoleOption").forEach(btn => {
      btn.addEventListener("click", async () => {
        const role = btn.dataset.role;
        btn.style.opacity = ".5";
        btn.disabled = true;
        try {
          await shareWithUser({
            targetUserId: selectedUser.id,
            projectId: projectId || undefined,
            songId: songId || undefined,
            role,
          });
          toast(`Shared with ${selectedUser.display_name} as ${role}`);
          _renderSharingManagement({ projectId, projectName, songId, songTitle });
        } catch (e) {
          console.error("Share failed:", e);
          toast(e.message || "Failed to share");
          btn.style.opacity = "1";
          btn.disabled = false;
        }
      });
    });
  };

  renderAddFlow();
}

function closeShareOverlay() {
  _closeRoleDropdown();
  if (!shareOverlayEl) return;
  shareOverlayEl.classList.remove("open");
  setTimeout(() => { shareOverlayEl?.remove(); shareOverlayEl = null; }, 300);
}

// Legacy wrapper — openShareRoleSheet now opens the full overlay
function openShareRoleSheet(opts) {
  openShareOverlay(opts);
}

// Track known shared IDs so we can detect new shares
let _knownSharedSongIds = new Set();
let _knownSharedProjectIds = new Set();

function _showShareNotification(newItems) {
  if (!newItems.length) return;

  // Persist each share to the notification inbox
  for (const item of newItems) {
    addNotification({
      title: item.name,
      body: `Shared with you by ${item.from}`,
      type: "share",
    });
  }

  const label = newItems.length === 1
    ? `"${newItems[0].name}" was shared with you by ${newItems[0].from}`
    : `${newItems.length} new items shared with you`;

  // Push notification (if permitted and not currently in collab)
  if ("Notification" in window && Notification.permission === "granted"
      && !(document.visibilityState === "visible" && R.currentTab === "collab")) {
    const reg = navigator.serviceWorker?.controller ? navigator.serviceWorker.ready : null;
    if (reg) {
      reg.then(r => {
        r.showNotification("RiffBank", {
          body: label,
          icon: "/icon-1024.png",
          badge: "/icon-1024.png",
          tag: "riffbank-new-share",
          renotify: true,
          data: { url: "/" },
        });
      }).catch(() => {});
    }
  }

  // Also show in-app toast
  toast(label);
}

let _refreshSharedRunning = false;
async function refreshSharedData() {
  if (_refreshSharedRunning) return; // prevent overlapping runs
  _refreshSharedRunning = true;
  refreshSharedData._lastRun = Date.now();
  try {
    console.log("[Collab] fetching all shared data (single RPC)...");
    const result = await fetchAllSharedData();
    if (!result) { console.warn("[Collab] RPC returned null"); return; }
    const { projects, songs, invites, myProjects, mySongs } = result;
    console.log("[Collab] all done");

    // Detect newly shared items
    const newItems = [];
    for (const sp of (projects || [])) {
      if (sp.projectId && !_knownSharedProjectIds.has(sp.projectId)) {
        newItems.push({ name: sp.projectName || "a project", from: sp.ownerName || "Someone" });
      }
    }
    for (const ss of (songs || [])) {
      const sid = ss.song?.id;
      if (sid && !_knownSharedSongIds.has(sid)) {
        newItems.push({ name: ss.song?.title || "a song", from: ss.ownerName || "Someone" });
      }
    }

    // Update known IDs
    _knownSharedSongIds = new Set((songs || []).map(s => s.song?.id).filter(Boolean));
    _knownSharedProjectIds = new Set((projects || []).map(p => p.projectId).filter(Boolean));

    // Show notification for new shares (skip on first load)
    if (sharedData.loaded && newItems.length) {
      _showShareNotification(newItems);
    }

    setSharedData({ projects: projects || [], songs: songs || [], invites: invites || [], myProjects: myProjects || [], mySongs: mySongs || [], loaded: true });
  } catch (e) {
    console.warn("[Collab] Failed to fetch shared data:", e);
    if (!sharedData.loaded) sharedData = { projects: [], songs: [], invites: [], myProjects: [], mySongs: [], loaded: true };
  } finally {
    _refreshSharedRunning = false;
  }
}

// ── Friends sidebar state ──
let _collabSidebarOpen = false;
// Open share picker — choose project or song to share
// ── Profile Tab ──────────────────────────────────

let _profileData = null; // cached from Supabase
let _profileDataVersion = 0; // bumped on save — used to skip redundant DOM rewrites
let _profileRenderedVersion = -1; // version last written to DOM

async function loadProfileData() {
  try {
    const { data: userData } = await supabase.auth.getUser();
    const uid = userData?.user?.id;
    if (!uid) return null;
    const { data } = await supabase
      .from("profiles")
      .select("first_name, last_name, display_name, avatar_url, location, instrument, genre, bio")
      .eq("id", uid)
      .maybeSingle();
    _profileData = data || {};
    _profileData.email = userData.user.email || "";
    _profileData.uid = uid;
    return _profileData;
  } catch (e) {
    console.warn("[Profile] load failed:", e);
    return _profileData || {};
  }
}

function renderProfile() {
  // Skip everything if profile is already displayed with current data
  if (_profileData && _profileRenderedVersion === _profileDataVersion && activeScreenEl.querySelector(".profHero")) {
    return;
  }

  setHeader("Profile");

  const appEl = document.querySelector(".app");
  appEl?.classList.add("collapseTitle");
  const h1 = appEl?.querySelector(".titleblock h1");
  if (h1) h1.style.opacity = "0";

  // Use cached data if available — render immediately, no spinner
  if (_profileData) {
    renderProfileContent(_profileData);
    return;
  }

  // First load: show spinner, fetch from Supabase
  activeScreenEl.innerHTML = `
    <div class="profileWrap">
      <div class="collabSpinner" style="margin:80px auto 0"></div>
    </div>
  `;

  loadProfileData().then(profile => {
    _profileDataVersion++;
    renderProfileContent(profile || {});
  });
}

function renderProfileContent(profile) {
  _profileRenderedVersion = _profileDataVersion;
  const displayName = profile.display_name || state.settings?.displayName || "RiffBanker";
  const avatarSrc = state.settings?.profileAvatarUrl || profile.avatar_url || null;
  const initial = (displayName || "?").charAt(0).toUpperCase();
  const songCount = state.songs?.length || 0;
  const projectCount = [...new Set(state.songs.map(s => (s.project || "").trim()).filter(Boolean))].length;

  // Build "detail rows" — each field displayed like a playlist/song row
  const detailRow = (value, label, icon) => {
    if (!value) return "";
    return `
      <div class="profDetailRow">
        <div class="profDetailIcon">${icon}</div>
        <div class="profDetailInfo">
          <div class="profDetailValue">${escapeHtml(value)}</div>
          <div class="profDetailLabel">${escapeHtml(label)}</div>
        </div>
      </div>
    `;
  };

  const iconUser = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
  const iconAt = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 006 0v-1a10 10 0 10-3.92 7.94"/></svg>`;
  const iconPin = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
  const iconMusic = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
  const iconGenre = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="5.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="15.5" r="2.5"/><path d="M8 17V5l12-2v12"/></svg>`;
  const iconBio = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;

  const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(" ");

  activeScreenEl.innerHTML = `
    <div class="profileWrap">
      <!-- Hero: avatar left, name right (Spotify-style) -->
      <div class="profHero">
        <div class="profHeroAvatar">
          ${renderAvatarHtml(avatarSrc, 100, initial)}
        </div>
        <div class="profHeroInfo">
          <div class="profHeroName">${escapeHtml(displayName)}</div>
          <div class="profHeroStats">${songCount} · Songs · ${projectCount} Projects · ${(sharedData.songs?.length || 0) + (sharedData.mySongs?.length || 0) + (sharedData.projects || []).reduce((n, sp) => n + (sp.songs?.length || 0), 0) + (sharedData.myProjects || []).reduce((n, mp) => n + (mp.songs?.length || 0), 0)} Shared</div>
        </div>
      </div>

      <!-- Action buttons -->
      <div class="profActions">
        <button class="profActionBtn" id="profEditBtn">Edit</button>
        <button class="profActionIcon" id="profShareBtn" aria-label="Share">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
        </button>
        <button class="profActionIcon" id="profSettingsBtn" aria-label="Settings">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
        </button>
      </div>

      <!-- Details section — song-row style -->
      <div class="profileSection">
        <div class="profileSectionTitle">Details</div>
        <div class="profDetailList">
          ${detailRow(fullName, "Name", iconUser)}
          ${detailRow(displayName, "Username", iconAt)}
          ${detailRow(profile.location, "Location", iconPin)}
          ${detailRow(profile.instrument, "Instrument", iconMusic)}
          ${detailRow(profile.genre, "Genre", iconGenre)}
          ${detailRow(profile.bio, "Bio", iconBio)}
          ${!fullName && !profile.location && !profile.instrument && !profile.genre ? `
            <div class="profDetailEmpty">Tap Edit to add your details</div>
          ` : ""}
        </div>
      </div>

      <!-- Account section -->
      <div class="profileSection">
        <div class="profileSectionTitle">Account</div>
        <button class="profileChoice" id="profSignOut">
          Sign Out
          <span class="sub">${escapeHtml(profile.email || "")}</span>
        </button>
        <button class="profileChoice" id="profResetSetup" style="color:rgba(255,255,255,.35)">
          Restart Welcome Flow
          <span class="sub">testing only</span>
        </button>
      </div>
    </div>
  `;

  // Edit button → open edit overlay
  $("#profEditBtn")?.addEventListener("click", () => openProfileEdit(profile));

  // Share profile
  $("#profShareBtn")?.addEventListener("click", async () => {
    const text = `Check out ${displayName} on RiffBank!`;
    if (navigator.share) {
      try { await navigator.share({ title: "RiffBank Profile", text }); return; } catch {}
    }
    try { await navigator.clipboard.writeText(text); toast("Copied!"); } catch { toast("Couldn't copy"); }
  });

  // Settings → sign out sheet
  $("#profSettingsBtn")?.addEventListener("click", () => {
    // Scroll to account section
    const accountSection = activeScreenEl.querySelectorAll(".profileSection")[1];
    if (accountSection) accountSection.scrollIntoView({ behavior: "smooth" });
  });

  // Sign out
  $("#profSignOut")?.addEventListener("click", async () => {
    if (!confirm("Sign out of RiffBank?")) return;
    try {
      localStorage.removeItem("profileSetupDone");
      await signOut(); location.reload();
    } catch (e) { toast(e.message || "Sign out failed"); }
  });

  // Reset welcome flow (testing)
  $("#profResetSetup")?.addEventListener("click", async () => {
    if (!confirm("Reset everything? You'll go through the full welcome + profile setup again.")) return;
    localStorage.removeItem("salOnboardingDone");
    localStorage.removeItem("salImportFlowDone");
    localStorage.removeItem("profileSetupDone");
    localStorage.removeItem("salImportSkipped");
    try { await signOut(); } catch {}
    location.reload();
  });
}

// ── Edit Profile Overlay (Spotify-style full screen) ──

function openProfileEdit(profile) {
  const el = document.createElement("div");
  el.className = "profEditOverlay";
  const avatarSrc = state.settings?.profileAvatarUrl || (profile.avatar_url?.startsWith("http") ? profile.avatar_url : null);
  const initial = ((profile.display_name || "?").charAt(0)).toUpperCase();
  let newAvatarFile = null;
  let newAvatarPreset = null;

  el.innerHTML = `
    <div class="profEditHeader">
      <button class="profEditCancel" id="profEditCancel">Cancel</button>
      <div class="profEditTitle">Edit Profile</div>
      <button class="profEditSave" id="profEditSave">Save</button>
    </div>
    <div class="profEditBody">
      <button class="profEditAvatarBtn" id="profEditAvatarBtn">
        ${avatarSrc
          ? `<img class="profEditAvatarImg" id="profEditAvatarImg" src="${avatarSrc}" />`
          : `<div class="profEditAvatarFallback" id="profEditAvatarImg">${escapeHtml(initial)}</div>`
        }
        <div class="profEditAvatarBadge">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </div>
      </button>
      <div class="profEditFields">
        <div class="profEditField">
          <label class="profEditLabel">First Name</label>
          <input id="peFirstName" class="profEditInput" type="text" value="${escapeHtml(profile.first_name || "")}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
        </div>
        <div class="profEditField">
          <label class="profEditLabel">Last Name</label>
          <input id="peLastName" class="profEditInput" type="text" value="${escapeHtml(profile.last_name || "")}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
        </div>
        <div class="profEditField">
          <label class="profEditLabel">Username</label>
          <input id="peDisplayName" class="profEditInput" type="text" value="${escapeHtml(profile.display_name || "")}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
        </div>
        <div class="profEditField">
          <label class="profEditLabel">Location</label>
          <input id="peLocation" class="profEditInput" type="text" value="${escapeHtml(profile.location || "")}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
        </div>
        <div class="profEditField">
          <label class="profEditLabel">Instrument</label>
          <input id="peInstrument" class="profEditInput" type="text" value="${escapeHtml(profile.instrument || "")}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
        </div>
        <div class="profEditField">
          <label class="profEditLabel">Genre</label>
          <input id="peGenre" class="profEditInput" type="text" value="${escapeHtml(profile.genre || "")}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
        </div>
        <div class="profEditField">
          <label class="profEditLabel">Bio</label>
          <textarea id="peBio" class="profEditInput profEditTextarea" rows="3" autocomplete="off" autocorrect="off" spellcheck="false">${escapeHtml(profile.bio || "")}</textarea>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("open"));

  // Avatar picker — opens bottom sheet
  el.querySelector("#profEditAvatarBtn")?.addEventListener("click", () => {
    openAvatarPicker({
      currentSrc: avatarSrc,
      onPickFile: (file, previewUrl) => {
        newAvatarFile = file;
        newAvatarPreset = null;
        const url = previewUrl || URL.createObjectURL(file);
        const imgEl = el.querySelector("#profEditAvatarImg");
        if (imgEl?.tagName === "IMG") { imgEl.src = url; }
        else if (imgEl) { imgEl.outerHTML = `<img class="profEditAvatarImg" id="profEditAvatarImg" src="${url}" />`; }
      },
      onPickPreset: (preset) => {
        newAvatarPreset = preset;
        newAvatarFile = null;
        const imgEl = el.querySelector("#profEditAvatarImg");
        if (imgEl) { imgEl.outerHTML = `<div class="profEditAvatarFallback" id="profEditAvatarImg">${renderAvatarPreset(preset)}</div>`; }
      },
      onRemove: () => {
        newAvatarFile = null;
        newAvatarPreset = null;
        const imgEl = el.querySelector("#profEditAvatarImg");
        if (imgEl) { imgEl.outerHTML = `<div class="profEditAvatarFallback" id="profEditAvatarImg">${escapeHtml(initial)}</div>`; }
      },
    });
  });

  // Cancel
  el.querySelector("#profEditCancel")?.addEventListener("click", () => {
    el.classList.remove("open");
    setTimeout(() => el.remove(), 300);
  });

  // Save
  el.querySelector("#profEditSave")?.addEventListener("click", async () => {
    const saveBtn = el.querySelector("#profEditSave");
    saveBtn.textContent = "...";
    saveBtn.disabled = true;

    const data = {
      first_name: (el.querySelector("#peFirstName")?.value || "").trim() || null,
      last_name: (el.querySelector("#peLastName")?.value || "").trim() || null,
      display_name: (el.querySelector("#peDisplayName")?.value || "").trim() || "RiffBanker",
      location: (el.querySelector("#peLocation")?.value || "").trim() || null,
      instrument: (el.querySelector("#peInstrument")?.value || "").trim() || null,
      genre: (el.querySelector("#peGenre")?.value || "").trim() || null,
      bio: (el.querySelector("#peBio")?.value || "").trim() || null,
      updated_at: new Date().toISOString(),
    };

    try {
      if (!profile.uid) {
      } else {
        // Upload new avatar or save preset
        if (newAvatarFile) {
          const ext = newAvatarFile.name?.split(".").pop() || "jpg";
          const path = `${profile.uid}/avatar.${ext}`;
          const { error: uploadErr } = await supabase.storage.from("covers").upload(path, newAvatarFile, { upsert: true, contentType: newAvatarFile.type || "image/jpeg" });
          if (uploadErr) {
            toast("Avatar upload failed — try again");
            saveBtn.textContent = "Save";
            saveBtn.disabled = false;
            return;
          }
          // Use signed URL (1 year) — public URL returns 400 if bucket isn't public
          const { data: signedData, error: signErr } = await supabase.storage.from("covers").createSignedUrl(path, 60 * 60 * 24 * 365);
          if (signErr || !signedData?.signedUrl) {
            // Fallback to public URL
            const { data: urlData } = supabase.storage.from("covers").getPublicUrl(path);
            if (urlData?.publicUrl) {
              const freshUrl = urlData.publicUrl.split("?")[0] + "?t=" + Date.now();
              data.avatar_url = freshUrl;
              state.settings.profileAvatarUrl = freshUrl;
            }
          } else {
            data.avatar_url = signedData.signedUrl;
            state.settings.profileAvatarUrl = signedData.signedUrl;
          }
        } else if (newAvatarPreset) {
          data.avatar_url = `preset:${newAvatarPreset.id}`;
          state.settings.profileAvatarUrl = data.avatar_url;
        }

        await supabase.from("profiles").update(data).eq("id", profile.uid);
      }
      state.settings.displayName = data.display_name;
      saveState();
      syncProfileNavIcon();
      // Update cache in-place so renderProfile() uses it immediately (no spinner/re-fetch)
      _profileData = { ..._profileData, ...data, email: _profileData?.email || "", uid: profile.uid };
      _profileDataVersion++; // bump so renderProfile() knows to re-render DOM

      el.classList.remove("open");
      setTimeout(() => { el.remove(); renderProfile(); }, 300);
      toast("Profile updated");
    } catch (e) {
      toast(e.message || "Save failed");
      saveBtn.textContent = "Save";
      saveBtn.disabled = false;
    }
  });
}

function openCollabSharePicker() {
  const projects = [...new Set([
    ...(state.settings?.defaultProject ? [state.settings.defaultProject.trim()] : []),
    ...(state.projects || []).map(p => p.trim()).filter(Boolean),
    ...state.songs.map(s => (s.project || "").trim()).filter(Boolean),
  ])].sort();

  sheetMode = "sharePicker";
  openSheet("sharePicker");

  const projOptions = projects.map(p =>
    `<button class="sheetChoice" data-share-proj="${escapeHtml(p)}">${escapeHtml(p)}<span class="sub">project</span></button>`
  ).join("");

  const songOptions = state.songs.slice(0, 20).map(s =>
    `<button class="sheetChoice" data-share-song="${escapeHtml(s.id)}">${escapeHtml(s.title)}<span class="sub">${escapeHtml(s.project || "")}</span></button>`
  ).join("");

  sheetContent.innerHTML = `
    <div class="sheetTitle">Share Something</div>
    <div class="small" style="margin-top:-4px; opacity:.65; line-height:1.5">
      Pick a project or song to share:
    </div>
    <div class="sheetForm" style="gap:6px; margin-top:14px; max-height:50vh; overflow-y:auto">
      ${projects.length ? `<div class="small" style="font-weight:700; opacity:.5; margin:6px 0 2px">Projects</div>` : ""}
      ${projOptions}
      ${state.songs.length ? `<div class="small" style="font-weight:700; opacity:.5; margin:10px 0 2px">Songs</div>` : ""}
      ${songOptions}
      <button class="sheetChoice" id="sharePickerCancel">Cancel</button>
    </div>
  `;

  sheetContent.querySelectorAll("[data-share-proj]").forEach(btn => {
    btn.addEventListener("click", () => {
      const projName = btn.getAttribute("data-share-proj");
      closeSheet();
      shareInvite(projName);
    });
  });

  sheetContent.querySelectorAll("[data-share-song]").forEach(btn => {
    btn.addEventListener("click", () => {
      const songId = btn.getAttribute("data-share-song");
      closeSheet();
      shareInviteSong(songId);
    });
  });

  $("#sharePickerCancel")?.addEventListener("click", closeSheet);
}

// ── Loaded Invite Builder ──────────────────────────────────────────

let _loadedInvitesCache = null; // cached getMyLoadedInvites() result

async function _refreshLoadedInvites() {
  try { _loadedInvitesCache = await getMyLoadedInvites(); } catch { _loadedInvitesCache = []; }
}


// ── Loaded Invite Welcome Screen ──────────────────────────
function _showLoadedInviteWelcome(claimResult) {
  const { sender_name, project_count, song_count, role } = claimResult;

  const projIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
  const songIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;

  const roleLabel = role === "collaborator" ? "Collaborator" : "Viewer";
  const initial = (sender_name || "?")[0].toUpperCase();

  const overlay = document.createElement("div");
  overlay.className = "liWelcomeOverlay";

  // Summary counts for initial render
  const countParts = [];
  if (project_count) countParts.push(`${project_count} project${project_count > 1 ? "s" : ""}`);
  if (song_count) countParts.push(`${song_count} song${song_count > 1 ? "s" : ""}`);

  overlay.innerHTML = `
    <div class="liWelcomeInner">
      <div class="liWelcomeSal">
        <img src="./sal.svg" alt="Sal" width="90">
      </div>

      <div class="liWelcomeTitle">Welcome to RiffBank!</div>
      <div class="liWelcomeSub">
        <strong>${escapeHtml(sender_name)}</strong> already shared ${countParts.join(" and ")} with you — you're all set!
      </div>

      <div class="liWelcomeSender">
        <div class="liWelcomeSenderAvatar">
          <div class="liWelcomeSenderAvatarFallback">${initial}</div>
        </div>
        <div class="liWelcomeSenderInfo">
          <div class="liWelcomeSenderName">${escapeHtml(sender_name)}</div>
          <div class="liWelcomeSenderRole">${roleLabel} access</div>
        </div>
      </div>

      <div class="liWelcomeItems" id="liWelcomeItems">
        <div style="text-align:center;padding:16px 0;color:rgba(255,255,255,.35);font-size:13px">Loading shared items...</div>
      </div>

      <button class="liWelcomeBtn" id="liWelcomeGo">Let's Go!</button>
    </div>
  `;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("open"));

  function dismiss() {
    overlay.classList.remove("open");
    setTimeout(() => overlay.remove(), 350);
  }

  overlay.querySelector("#liWelcomeGo").addEventListener("click", () => {
    dismiss();
    // Navigate to Collab tab to see shared content
    R.currentTab = "collab";
    R.collabPill = "projects";
    render();
  });

  // Fetch shared data, then enrich the items list
  refreshSharedData().then(() => {
    if (R.currentTab === "collab") render();
    const itemsEl = overlay.querySelector("#liWelcomeItems");
    if (!itemsEl) return;

    const { projects, songs } = sharedData;
    if (!projects.length && !songs.length) {
      itemsEl.innerHTML = `
        <div class="liWelcomeItem">
          <div class="liWelcomeItemIcon">${projIcon}</div>
          <div class="liWelcomeItemBody">
            <div class="liWelcomeItemTitle">${countParts.join(" & ")}</div>
            <div class="liWelcomeItemSub">Shared by ${escapeHtml(sender_name)}</div>
          </div>
        </div>`;
      return;
    }

    let html = "";

    if (projects.length) {
      html += `<div class="liWelcomeItemLabel">Projects</div>`;
      for (const p of projects) {
        const name = p.projectName || "Untitled";
        const songCount = (p.songs || []).length;
        html += `
          <div class="liWelcomeItem">
            <div class="liWelcomeItemIcon">${projIcon}</div>
            <div class="liWelcomeItemBody">
              <div class="liWelcomeItemTitle">${escapeHtml(name)}</div>
              <div class="liWelcomeItemSub">${songCount} song${songCount !== 1 ? "s" : ""}</div>
            </div>
          </div>`;
      }
    }

    if (songs.length) {
      html += `<div class="liWelcomeItemLabel">Songs</div>`;
      for (const s of songs.slice(0, 10)) {
        const title = s.song?.title || "Untitled";
        const proj = s.song?.project || "";
        html += `
          <div class="liWelcomeItem">
            <div class="liWelcomeItemIcon">${songIcon}</div>
            <div class="liWelcomeItemBody">
              <div class="liWelcomeItemTitle">${escapeHtml(title)}</div>
              ${proj ? `<div class="liWelcomeItemSub">${escapeHtml(proj)}</div>` : ""}
            </div>
          </div>`;
      }
      if (songs.length > 10) {
        html += `<div class="liWelcomeItemSub" style="text-align:center;padding:4px 0">+${songs.length - 10} more</div>`;
      }
    }

    itemsEl.innerHTML = html;
  }).catch(() => {
    const itemsEl = overlay.querySelector("#liWelcomeItems");
    if (itemsEl) {
      itemsEl.innerHTML = `
        <div class="liWelcomeItem">
          <div class="liWelcomeItemIcon">${projIcon}</div>
          <div class="liWelcomeItemBody">
            <div class="liWelcomeItemTitle">${countParts.join(" & ")}</div>
            <div class="liWelcomeItemSub">Shared by ${escapeHtml(sender_name)}</div>
          </div>
        </div>`;
    }
  });
}

// Re-share an existing loaded invite link
async function _reshareLoadedInvite(invite) {
  const url = `${location.origin}/invite.html?li=${invite.token}`;
  if (navigator.share) {
    try { await navigator.share({ title: "RiffBank Invite", text: "Check out my music on RiffBank!", url }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(url); toast("Invite link copied!"); }
  catch { toast("Couldn't copy link"); }
}

function renderAlerts() {
  setHeader("Alerts");
  const appEl = document.querySelector(".app");
  appEl?.classList.add("collapseTitle");
  const h1 = appEl?.querySelector(".titleblock h1");
  if (h1) h1.style.opacity = "0";

  // Mark all inbox notifications as read when viewing
  markNotificationsRead();

  const statusIcon = (s) => {
    if (s === "done") return `<span style="color:#22c55e">&#10003;</span>`;
    if (s === "failed") return `<span style="color:#f43f5e">&#10007;</span>`;
    return `<span class="alertSpinner"></span>`;
  };

  const notifIcon = (type) => {
    if (type === "upload") return `<span style="color:#22c55e"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></span>`;
    if (type === "share") return `<span style="color:#a855f7"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg></span>`;
    if (type === "friend_request" || type === "friend_accepted" || type === "friend_declined") return `<span style="color:#3b82f6"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg></span>`;
    return `<span style="color:#888">&#x1F514;</span>`;
  };

  const timeAgo = (ts) => {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  // Build avatar HTML for friend request notifications (supports preset: and http avatars)
  const notifAvatar = (n) => {
    const initial = (n.requesterName || "?").charAt(0).toUpperCase();
    return `<div class="alertAvatar">${renderAvatarHtml(n.avatarUrl, 36, initial)}</div>`;
  };

  // Notification inbox items (shares, etc.) — sorted newest first
  const notifications = _loadNotifications().sort((a, b) => b.ts - a.ts);

  // Group consecutive upload notifications within 5 minutes into batch summaries
  const BATCH_WINDOW = 5 * 60 * 1000;
  const grouped = [];
  let i = 0;
  while (i < notifications.length) {
    const n = notifications[i];
    if (n.type === "upload") {
      // Collect all uploads within BATCH_WINDOW of this one
      const batch = [n];
      let j = i + 1;
      while (j < notifications.length && notifications[j].type === "upload" && Math.abs(n.ts - notifications[j].ts) < BATCH_WINDOW) {
        batch.push(notifications[j]);
        j++;
      }
      if (batch.length >= 2) {
        grouped.push({ _isBatch: true, items: batch, ts: batch[0].ts });
        i = j;
      } else {
        grouped.push(n);
        i++;
      }
    } else {
      grouped.push(n);
      i++;
    }
  }

  const notifHTML = grouped.length
    ? grouped.map(entry => {
      if (entry._isBatch) {
        const count = entry.items.length;
        const titles = entry.items.map(n => escapeHtml(n.title));
        const preview = titles.slice(0, 3).join(", ") + (count > 3 ? `, +${count - 3} more` : "");
        return `
      <div class="alertRow alertRowClickable alertBatchRow" data-batch-expand>
        <div class="alertIcon">${notifIcon("upload")}</div>
        <div class="alertBody">
          <div class="alertTitle">${count} songs imported</div>
          <div class="alertMsg">${preview}</div>
        </div>
        <div class="alertTime">${timeAgo(entry.ts)}</div>
        <div class="alertChevron"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></div>
      </div>
      <div class="alertBatchItems" style="display:none">
        ${entry.items.map(n => `
        <div class="alertRow alertBatchChild">
          <div class="alertIcon">${notifIcon("upload")}</div>
          <div class="alertBody">
            <div class="alertTitle">${escapeHtml(n.title)}</div>
            <div class="alertMsg">${escapeHtml(n.body)}</div>
          </div>
          <div class="alertTime">${timeAgo(n.ts)}</div>
        </div>`).join("")}
      </div>`;
      }
      const n = entry;
      const isFR = n.type === "friend_request" || n.type === "friend_accepted" || n.type === "friend_declined";
      const isPendingFR = n.type === "friend_request" && n.friendshipId;
      const avatarHTML = isFR ? notifAvatar(n) : `<div class="alertIcon">${notifIcon(n.type)}</div>`;
      const clickable = isPendingFR && n.requesterId ? `data-notif-profile="${n.requesterId}" data-notif-friendship="${n.friendshipId}" data-notif-id="${n.id}"` : "";
      const actionBtns = isPendingFR ? `
        <div class="alertFriendActions">
          <button class="alertAcceptBtn" data-notif-accept="${n.id}" data-friendship-id="${n.friendshipId}">Accept</button>
          <button class="alertDeclineBtn" data-notif-decline="${n.id}" data-friendship-id="${n.friendshipId}">Decline</button>
        </div>` : "";
      return `
      <div class="alertRow${n.read ? "" : " alertUnread"}${isPendingFR ? " alertRowClickable" : ""}" ${clickable}>
        ${avatarHTML}
        <div class="alertBody">
          <div class="alertTitle">${escapeHtml(n.title)}</div>
          <div class="alertMsg">${escapeHtml(n.body)}</div>
          ${actionBtns}
        </div>
        <div class="alertTime">${timeAgo(n.ts)}</div>
      </div>`;
    }).join("")
    : "";

  // Activity log items (uploads, syncs) — with progress bars for in-progress uploads
  const activityHTML = activityLog.length
    ? activityLog.map(a => {
      const inProgress = a.status !== "done" && a.status !== "failed";
      const pct = a.progress || 0;
      const barHTML = inProgress ? `<div class="alertProgress"><div class="alertProgressFill" style="width:${pct}%"></div></div>` : "";
      return `
      <div class="alertRow">
        <div class="alertIcon">${statusIcon(a.status)}</div>
        <div class="alertBody">
          <div class="alertTitle">${escapeHtml(a.songTitle)}</div>
          <div class="alertMsg">${escapeHtml(a.message)}</div>
          ${barHTML}
        </div>
        <div class="alertTime">${timeAgo(a.ts)}</div>
      </div>`;
    }).join("")
    : "";

  const hasContent = grouped.length || activityLog.length || importQueue.length;

  activeScreenEl.innerHTML = `
    <div style="padding:0 2px">
      <div class="songsTitleRow"><div class="songsPageTitle">Alerts</div></div>
      <div id="importQueueContainer"></div>
      ${grouped.length ? `<div class="alertSectionLabel"${importQueue.length ? ` style="margin-top:20px"` : ""}>Notifications</div>${notifHTML}` : ""}
      ${activityLog.length ? `<div class="alertSectionLabel" style="${grouped.length || importQueue.length ? "margin-top:20px" : ""}">Activity</div>${activityHTML}` : ""}
      ${!hasContent ? `<div style="padding:40px 20px;text-align:center;color:rgba(255,255,255,.3)">No notifications yet</div>` : ""}
    </div>
  `;

  // Render import queue into its container
  _renderImportQueueDOM();

  // Wire batch expand/collapse
  activeScreenEl.querySelectorAll("[data-batch-expand]").forEach(row => {
    row.addEventListener("click", () => {
      const items = row.nextElementSibling;
      if (!items || !items.classList.contains("alertBatchItems")) return;
      const expanded = items.style.display !== "none";
      items.style.display = expanded ? "none" : "block";
      row.classList.toggle("alertBatchExpanded", !expanded);
    });
  });

  // Wire accept/decline buttons on friend request notifications
  activeScreenEl.querySelectorAll("[data-notif-accept]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const notifId = btn.getAttribute("data-notif-accept");
      const friendshipId = btn.getAttribute("data-friendship-id");
      btn.textContent = "...";
      try {
        await acceptFriendRequest(friendshipId);
        _updateFriendNotification(notifId, "accepted");
        setPendingFriendCount(Math.max(0, getPendingFriendCount() - 1));
        _applyAllBadges(_unreadMsgCount, getPendingFriendCount());
        toast("Friend request accepted!");
        renderAlerts();
      } catch (err) { toast(err.message || "Failed"); btn.textContent = "Accept"; }
    });
  });
  activeScreenEl.querySelectorAll("[data-notif-decline]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const notifId = btn.getAttribute("data-notif-decline");
      const friendshipId = btn.getAttribute("data-friendship-id");
      btn.textContent = "...";
      try {
        await removeFriendship(friendshipId);
        _updateFriendNotification(notifId, "declined");
        setPendingFriendCount(Math.max(0, getPendingFriendCount() - 1));
        _applyAllBadges(_unreadMsgCount, getPendingFriendCount());
        toast("Request declined");
        renderAlerts();
      } catch (err) { toast(err.message || "Failed"); btn.textContent = "Decline"; }
    });
  });

  // Clickable friend request rows → open profile with accept/decline bar
  activeScreenEl.querySelectorAll("[data-notif-profile]").forEach(row => {
    row.addEventListener("click", (e) => {
      // Don't navigate if they clicked the accept/decline buttons
      if (e.target.closest("[data-notif-accept]") || e.target.closest("[data-notif-decline]")) return;
      const userId = row.getAttribute("data-notif-profile");
      const friendshipId = row.getAttribute("data-notif-friendship");
      const notifId = row.getAttribute("data-notif-id");
      if (userId) {
        _pendingFriendAction = { friendshipId, notifId };
        navigateForward(() => {
          R.drawerView = null; // clear so render() doesn't re-enter alerts
          R.friendProfileId = userId;
          R.overlayView = "friendProfile";
        });
      }
    });
  });

  // Collapse title: fade small title in as big title scrolls behind topbar
  if (activeScreenEl._collapseTitleScroll) {
    activeScreenEl.removeEventListener("scroll", activeScreenEl._collapseTitleScroll);
    activeScreenEl._collapseTitleScroll = null;
  }
  const _screen = activeScreenEl;
  const _sm = document.querySelector(".app.collapseTitle .titleblock h1");
  if (_sm) {
    requestAnimationFrame(() => {
      const bt = _screen.querySelector(".songsPageTitle");
      if (!bt) return;
      const topbarEl = document.querySelector(".topbar");
      const screenTop = _screen.getBoundingClientRect().top;
      const topbarBottom = topbarEl ? topbarEl.getBoundingClientRect().bottom : 80;
      const fadeStart = bt.offsetTop - (topbarBottom - screenTop);
      const fadeEnd = fadeStart + (bt.offsetHeight || 40);
      const range = fadeEnd - fadeStart;
      const onScroll = () => {
        const progress = Math.min(1, Math.max(0, (_screen.scrollTop - fadeStart) / range));
        _sm.style.opacity = progress;
      };
      _screen._collapseTitleScroll = onScroll;
      _screen.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
    });
  }
}

// Update a friend request notification to show accepted/declined status
function _updateFriendNotification(notifId, action) {
  const items = _loadNotifications();
  const n = items.find(i => i.id === notifId);
  if (!n) return;
  const name = n.requesterName || "Someone";
  n.type = action === "accepted" ? "friend_accepted" : "friend_declined";
  n.title = action === "accepted" ? "Friend Added" : "Request Declined";
  n.body = `You ${action} ${name}'s friend request`;
  delete n.friendshipId; // no longer actionable
  n.ts = Date.now();
  _saveNotifications(items);
}

// Global search view moved to views/searchView.js

// ── Lyrics view ──
let lyricsQuery = "";

function renderLyricsScratch() {
  if (R.lyricsEditSongId) return renderLyricsEdit(R.lyricsEditSongId);

  R.overlayView = "lyrics";
  setHeader("Lyrics");
  const appEl = document.querySelector(".app");
  appEl?.classList.add("collapseTitle");
  const h1 = appEl?.querySelector(".titleblock h1");
  if (h1) h1.style.opacity = "0";

  // Collect songs that have lyrics
  const lq = lyricsQuery.toLowerCase();
  const songsWithLyrics = state.songs.filter(s => (s.lyrics || "").trim()).filter(s => {
    if (!lq) return true;
    return `${s.title} ${s.project} ${s.lyrics}`.toLowerCase().includes(lq);
  });

  activeScreenEl.innerHTML = `
    <div class="songsPageTitle">Lyrics</div>
    <div class="lyricsHead">
      <input id="lyricsSearch" type="text" placeholder="Search lyrics..." value="${escapeHtml(lyricsQuery)}" />
    </div>

    <div class="lyricsList">
      ${
        songsWithLyrics.length
          ? songsWithLyrics.map(s => {
              const cover = coverSvg(s, { lite: true });
              const preview = (s.lyrics || "").replace(/\n/g, " ").slice(0, 60) + ((s.lyrics || "").length > 60 ? "…" : "");
              return `
                <div class="lyricsRow" data-lyrics-song="${s.id}">
                  <div class="lyricsCover" aria-hidden="true">${cover}</div>
                  <div class="lyricsMain">
                    <div class="lyricsName">${escapeHtml(s.title || "Untitled")}</div>
                    <div class="lyricsMeta">${escapeHtml(preview)}</div>
                  </div>
                  <button class="lyricsMore" data-lmore="${s.id}" aria-label="More options">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
                  </button>
                </div>
              `;
            }).join("")
          + `<div style="text-align:center;padding:20px 0 8px;color:rgba(255,255,255,0.35);font-size:13px;">${songsWithLyrics.length} song${songsWithLyrics.length === 1 ? "" : "s"}</div>`
          : `<div class="emptyState">No lyrics yet. Tap + to add lyrics for a song.</div>`
      }
    </div>

    <button class="sdFab" id="lyricsAddFab" aria-label="Add lyrics">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
  `;

  // Search
  const searchInput = $("#lyricsSearch");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      lyricsQuery = searchInput.value;
      renderLyricsScratch();
      const el = $("#lyricsSearch");
      if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; }
    });
  }

  // Row tap → open lyrics editor
  activeScreenEl.querySelectorAll(".lyricsRow").forEach(row => {
    row.addEventListener("click", () => {
      const sid = row.getAttribute("data-lyrics-song");
      if (sid) {
        R.lyricsEditSongId = sid;
        navigateForward(() => renderLyricsEdit(sid));
      }
    });
  });

  // Kebab → action sheet (delete lyrics)
  activeScreenEl.querySelectorAll(".lyricsMore").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const sid = btn.getAttribute("data-lmore");
      const s = getSong(sid);
      if (!s) return;
      openLyricsActionSheet(s);
    });
  });

  // FAB → pick a song to add lyrics
  $("#lyricsAddFab")?.addEventListener("click", () => openLyricsSongPicker());

  // Collapsing title scroll listener
  const _screen = activeScreenEl;
  const _sm = document.querySelector(".app.collapseTitle .titleblock h1");
  if (_sm) {
    requestAnimationFrame(() => {
      const bt = _screen.querySelector(".songsPageTitle");
      if (!bt) return;
      const topbarEl = document.querySelector(".topbar");
      const screenTop = _screen.getBoundingClientRect().top;
      const topbarBottom = topbarEl ? topbarEl.getBoundingClientRect().bottom : 80;
      const fadeStart = bt.offsetTop - (topbarBottom - screenTop);
      const fadeEnd = fadeStart + (bt.offsetHeight || 40);
      const range = fadeEnd - fadeStart;

      const onScroll = () => {
        const progress = Math.min(1, Math.max(0, (_screen.scrollTop - fadeStart) / range));
        _sm.style.opacity = progress;
      };
      _screen._collapseTitleScroll = onScroll;
      _screen.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
    });
  }
}

function openLyricsActionSheet(song) {
  document.querySelectorAll(".actionSheetBackdrop, .actionSheet").forEach(el => el.remove());

  const backdrop = document.createElement("div");
  backdrop.className = "actionSheetBackdrop";
  const sheet = document.createElement("div");
  sheet.className = "actionSheet";
  sheet.innerHTML = `
    <div class="actionSheetHeader">
      <div style="font-weight:900; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
        ${escapeHtml(song.title || "Untitled")}
      </div>
      <div class="small" style="margin-top:4px;">Lyrics</div>
    </div>
    <button class="actionSheetBtn" data-act="edit">Edit Lyrics</button>
    <button class="actionSheetBtn danger" data-act="clear">Clear Lyrics</button>
    <button class="actionSheetBtn" data-act="cancel">Cancel</button>
  `;

  function close() { backdrop.remove(); sheet.remove(); }
  backdrop.addEventListener("click", close);

  sheet.querySelectorAll("[data-act]").forEach(btn => {
    btn.addEventListener("click", () => {
      const act = btn.getAttribute("data-act");
      if (act === "edit") {
        close();
        R.lyricsEditSongId = song.id;
        navigateForward(() => renderLyricsEdit(song.id));
      } else if (act === "clear") {
        close();
        song.lyrics = "";
        song.updatedAt = nowStamp();
        saveState();
        toast("Lyrics cleared");
        renderLyricsScratch();
      } else {
        close();
      }
    });
  });

  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
}

function renderLyricsEdit(songId) {
  const song = getSong(songId);
  if (!song) {
    R.lyricsEditSongId = null;
    return renderLyricsScratch();
  }

  R.overlayView = "lyrics";
  R.lyricsEditSongId = songId;
  setHeader("Edit Lyrics");

  const cover = coverSvg(song, { lite: true });

  activeScreenEl.innerHTML = `
    <div class="lyricsEditHead">
      <div class="lyricsEditCover">${cover}</div>
      <div class="lyricsEditInfo">
        <div class="lyricsEditTitle">${escapeHtml(song.title || "Untitled")}</div>
        <div class="lyricsEditSub">${escapeHtml(song.project || "—")}</div>
      </div>
    </div>
    <textarea id="lyricsEditArea" class="lyricsEditArea" placeholder="Write lyrics...">${escapeTextarea(song.lyrics || "")}</textarea>
    <div class="lyricsEditActions">
      <button id="lyricsSaveBtn" class="btn primary">Save</button>
    </div>
  `;

  $("#lyricsSaveBtn")?.addEventListener("click", () => {
    song.lyrics = $("#lyricsEditArea")?.value || "";
    song.updatedAt = nowStamp();
    saveState();
    toast("Lyrics saved");
  });

  setTimeout(() => $("#lyricsEditArea")?.focus(), 100);
}

function openLyricsSongPicker() {
  document.querySelectorAll(".actionSheetBackdrop, .actionSheet").forEach(el => el.remove());

  // Songs that DON'T already have lyrics
  const available = state.songs.filter(s => !(s.lyrics || "").trim());
  const all = state.songs;

  const backdrop = document.createElement("div");
  backdrop.className = "actionSheetBackdrop";
  const sheet = document.createElement("div");
  sheet.className = "actionSheet";
  sheet.style.maxHeight = "70vh";
  sheet.style.overflowY = "auto";
  sheet.innerHTML = `
    <div class="actionSheetHeader">
      <div style="font-weight:900; font-size:14px;">Add Lyrics</div>
      <div class="small" style="margin-top:4px;">Pick a song</div>
    </div>
    ${(available.length ? available : all).map(s => `
      <button class="actionSheetBtn" data-pick-song="${s.id}">${escapeHtml(s.title || "Untitled")}</button>
    `).join("")}
    ${!available.length && all.length ? `<div class="small" style="padding:8px 16px;color:var(--muted);">All songs already have lyrics</div>` : ""}
    ${!all.length ? `<div class="small" style="padding:8px 16px;color:var(--muted);">No songs yet</div>` : ""}
    <button class="actionSheetBtn" data-pick-song="cancel">Cancel</button>
  `;

  function close() { backdrop.remove(); sheet.remove(); }
  backdrop.addEventListener("click", close);

  sheet.querySelectorAll("[data-pick-song]").forEach(btn => {
    btn.addEventListener("click", () => {
      const sid = btn.getAttribute("data-pick-song");
      close();
      if (sid === "cancel") return;
      R.lyricsEditSongId = sid;
      navigateForward(() => renderLyricsEdit(sid));
    });
  });

  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
}

function renderNextActions() {
  R.overlayView = "next";
  setHeader("Next Actions");
  const songs = state.songs.filter((s) => (s.nextAction || "").trim());
  activeScreenEl.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between; align-items:center">
        <h2>Next Actions</h2>
        <button id="closeNextActions" class="ghost">Close</button>
      </div>
      <div class="songsList">
        ${
          songs.length
            ? songs.map((s) => `
              <div class="songRow" data-open-song="${s.id}">
                <div class="title"><b>${escapeHtml(s.title)}</b></div>
                <div class="meta">${escapeHtml(s.nextAction || "")}</div>
              </div>
            `).join("")
            : `<div class="small" style="padding:12px 0">No next actions yet.</div>`
        }
      </div>
    </div>
  `;
  $("#closeNextActions")?.addEventListener("click", () => {
    R.overlayView = null;
    R.currentTab = "home";
    setHeader("RiffBank");
    renderHome();
  });
  activeScreenEl.querySelectorAll("[data-open-song]").forEach((el) =>
    el.addEventListener("click", () => {
      navigateForward(() => {
        R.currentTab = "songs";
        R.selectedSongId = el.getAttribute("data-open-song");
      });
    })
  );
}

// clamp, hashStr, makeRng, coverCache, generatingArtSongs now in ui/coverArt.js


// isIOSDevice, coverSvg now in ui/coverArt.js


// ---------------------
function renderPlayer() {
  setHeader("");

  // Build playlist rows (one row per version where playerYes === true)
  const allItems = playerItems(state); // uses R.playerFilter/R.playerSort globals

  // Apply search filter
  const pq = R.playerQuery.toLowerCase();
  const items = pq
    ? allItems.filter(it => {
        const s = getSong(it.songId);
        const hay = `${it.songName || s?.title || ""} ${s?.project || ""} ${it.versionLabel || ""}`.toLowerCase();
        return hay.includes(pq);
      })
    : allItems;

  function openPlayerActionSheet(item) {
    // Remove any existing sheet
    document.querySelectorAll(".actionSheetBackdrop, .actionSheet").forEach(el => el.remove());

    const s = getSong(item.songId);
    const v = s ? getVersion(s, item.versionId) : null;
    if (!s || !v) return;

    // Ensure flags exist
    ensureVersionFlags(v);

    const backdrop = document.createElement("div");
    backdrop.className = "actionSheetBackdrop";

    const sheet = document.createElement("div");
    sheet.className = "actionSheet";
    sheet.innerHTML = `
      <div class="actionSheetHeader">
        <div style="font-weight:900; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
          ${escapeHtml(s.title || "Untitled")}
        </div>
        <div class="small" style="margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
          ${escapeHtml(v.label || "Version")}
        </div>
      </div>

      <button class="actionSheetBtn" data-act="play">Play</button>
      <button class="actionSheetBtn" data-act="queue">Add to Queue</button>
      <button class="actionSheetBtn" data-act="fav">
        ${v.favorite ? "Unfavorite" : "Favorite"}
      </button>

      <button class="actionSheetBtn" data-act="goto">Go to Song</button>

      <button class="actionSheetBtn danger" data-act="remove">Remove from Playlist</button>
      <button class="actionSheetBtn" data-act="cancel">Cancel</button>
    `;

    function close() {
      backdrop.remove();
      sheet.remove();
    }

    backdrop.addEventListener("click", close);

    sheet.querySelectorAll("[data-act]").forEach(btn => {
      btn.addEventListener("click", () => {
        const act = btn.getAttribute("data-act");

        if (act === "play") {
          close();
          playVersion(s.id, v.id, { goPlayer: true });
          return;
        }

        if (act === "queue") {
          addToQueue(s.id, v.id);
          close();
          return;
        }

        if (act === "fav") {
          v.favorite = !v.favorite;
          s.updatedAt = nowStamp();
          saveState();
          toast(v.favorite ? "Favorited 💚" : "Unfavorited");
          close();
          renderPlayer();
          return;
        }

        if (act === "remove") {
          v.playerYes = false;
          s.updatedAt = nowStamp();
          saveState();
          toast("Removed from playlist");
          close();
          renderPlayer();
          return;
        }

        if (act === "goto") {
          close();
          R.currentTab = "songs";
          R.drawerView = null;
          R.overlayView = null;
          R.selectedSongId = s.id;
          R.selectedVersionId = null;
          setHeader("Song");
          syncTabs();
          render();
          return;
        }

        close();
      });
    });

    document.body.appendChild(backdrop);
    document.body.appendChild(sheet);
  }

  // ── Layout: Title row → Search → Filters → List ──
  activeScreenEl.innerHTML = `
    <div class="playerHead">
      <div class="playerTitleRow">
        <div class="playerPageTitle">Player</div>
        <div class="playerActions">
          <button class="playerShuffleBtn ${state.player?.shuffle ? "is-active" : ""}" id="playerShuffle" aria-label="Shuffle">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>
              <polyline points="21 16 21 21 16 21"/><line x1="4" y1="4" x2="21" y2="21"/>
            </svg>
          </button>
          <button class="playerPlayBtn" id="playerPlayAll" aria-label="Play">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </button>
        </div>
      </div>
      <input
        id="playerSearch"
        type="text"
        placeholder="Search player..."
        value="${escapeHtml(R.playerQuery)}"
      />
    </div>

    <div class="playerChipsSticky">
      <div class="chipsRow" aria-label="Player filters">
        <button class="chip ${R.playerFilter === "all" ? "active" : ""}" data-pf="all">Riffs</button>
        <button class="chip ${R.playerFilter === "playlists" ? "active" : ""}" data-pf="playlists">Playlists</button>
        <button class="chip ${R.playerFilter === "projects" ? "active" : ""}" data-pf="projects">Projects</button>
        <button class="chip ${R.playerFilter === "releases" ? "active" : ""}" data-pf="releases">Releases</button>
      </div>
    </div>

    <div class="playerList">
      ${
        items.length
          ? items.map((it) => {
              const s = getSong(it.songId);

              const title = it.songName || s?.title || "Untitled";
              const meta = s?.project || "—";
              const fav = !!it.favorite;

              const cover = s ? coverSvg(s, { lite: true }) : "";

              const np = state.player?.nowPlaying;
              const isPlaying = np && np.songId === it.songId && np.versionId === it.versionId;

              return `
                <div class="playerRow${isPlaying ? " playing" : ""}"
                     data-pr-song="${it.songId}"
                     data-pr-ver="${it.versionId}">
                  <div class="playerCover" aria-hidden="true">${cover}</div>

                  <div class="playerMain">
                    <div class="playerName">${escapeHtml(title)}</div>
                    <div class="playerMeta">
                      <span>${escapeHtml(meta)}</span>
                      ${fav ? `<span class="playerBadge fav">♥</span>` : ``}
                    </div>
                  </div>
                  <button class="playerMore" data-more-song="${it.songId}" data-more-ver="${it.versionId}" aria-label="More options">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
                  </button>
                </div>
              `;
            }).join("")
          + (items.length ? `<div style="text-align:center;padding:20px 0 8px;color:rgba(255,255,255,0.35);font-size:13px;">${items.length} song${items.length === 1 ? "" : "s"}</div>` : "")
          : `<div class="emptyState">No songs yet. Add songs from the Songs tab.</div>`
      }
    </div>
  `;

  // Search input — live filter
  const searchInput = $("#playerSearch");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      R.playerQuery = searchInput.value;
      renderPlayer();
      // Re-focus and restore cursor position
      const el = $("#playerSearch");
      if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; }
    });
  }

  // Filter chips (single-select mode filters)
  activeScreenEl.querySelectorAll("[data-pf]").forEach(btn => {
    btn.addEventListener("click", () => {
      R.playerFilter = btn.getAttribute("data-pf") || "all";
      renderPlayer();
    });
  });

  // Play all — resets shuffle so songs play in order
  $("#playerPlayAll")?.addEventListener("click", async () => {
    if (!items.length) return toast("Playlist empty 😅");
    // Only queue versions that actually have audio
    const all = items.filter(x => {
      const s = getSong(x.songId);
      const v = s ? getVersion(s, x.versionId) : null;
      return v && isPlayable(v);
    }).map(x => ({ songId: x.songId, versionId: x.versionId }));
    if (!all.length) return toast("No playable songs 😅");
    state.player.nowPlaying = all[0];
    state.player.queue = all.slice(1);
    state.player.repeatQueue = all;
    state.player.shuffle = false;
    saveState();
    await playNowPlaying({ autoplay: true });
    toast("Playing ▶️");
    renderPlayer();
  });

  // Shuffle — also turns on shuffle mode in the full player
  $("#playerShuffle")?.addEventListener("click", async () => {
    if (!items.length) return toast("Playlist empty 😅");
    // Only queue versions that actually have audio
    const playable = items.filter(x => {
      const s = getSong(x.songId);
      const v = s ? getVersion(s, x.versionId) : null;
      return v && isPlayable(v);
    });
    if (!playable.length) return toast("No playable songs 😅");
    const all = shuffleArray(playable).map(x => ({ songId: x.songId, versionId: x.versionId }));
    state.player.nowPlaying = all[0];
    state.player.queue = all.slice(1);
    state.player.repeatQueue = all;
    state.player.shuffle = true;
    saveState();
    await playNowPlaying({ autoplay: true });
    toast("Shuffled ▶️");
    renderPlayer();
  });

  // More (...) buttons — open action sheet
  activeScreenEl.querySelectorAll(".playerMore").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const songId = btn.getAttribute("data-more-song");
      const verId = btn.getAttribute("data-more-ver");
      if (!songId || !verId) return;
      const item = items.find(x => x.songId === songId && x.versionId === verId);
      if (item) openPlayerActionSheet(item);
    });
  });

  // Row interactions: tap to play, long-press for action sheet
  activeScreenEl.querySelectorAll(".playerRow").forEach(row => {
    let lpTimer = null;
    let didLongPress = false;

    row.addEventListener("touchstart", (e) => {
      didLongPress = false;
      lpTimer = setTimeout(() => {
        didLongPress = true;
        const songId = row.getAttribute("data-pr-song");
        const versionId = row.getAttribute("data-pr-ver");
        if (!songId || !versionId) return;
        const item = items.find(x => x.songId === songId && x.versionId === versionId);
        if (item) openPlayerActionSheet(item);
      }, 500);
    }, { passive: true });

    row.addEventListener("touchend", () => { clearTimeout(lpTimer); });
    row.addEventListener("touchmove", () => { clearTimeout(lpTimer); });
    row.addEventListener("touchcancel", () => { clearTimeout(lpTimer); });

    row.addEventListener("click", async (e) => {
      if (didLongPress) return;

      const songId = row.getAttribute("data-pr-song");
      const versionId = row.getAttribute("data-pr-ver");
      if (!songId || !versionId) return;

      // Tap row = play immediately; reset shuffle since user picked a specific track
      state.player.nowPlaying = { songId, versionId };
      state.player.shuffle = false;
      saveState();
      await playNowPlaying({ autoplay: true });
      toast("Playing ▶️");
      renderPlayer();
    });
  });

}

function renderNowPlaying() {
  const now = state.player?.nowPlaying;
  if (!now) {
    R.playerScreen = "list";
    return renderPlayer();
  }

  if (activeScreenEl) activeScreenEl.scrollTop = 0;
  requestAnimationFrame(() => { if (activeScreenEl) activeScreenEl.scrollTop = 0; });

  const song = getSong(now.songId);
  const v = song ? getVersion(song, now.versionId) : null;
  if (!song || !v) {
    R.playerScreen = "list";
    return renderPlayer();
  }

  setHeader("Now Playing");
  const isFirstOpen = !R.fullPlayerOpen;
  R.fullPlayerOpen = true;
  setFullPlayerOpen(true);

  const title = song.title || "Untitled";
  const subtitle = v.label || "Version";
  const art = coverSvg(song);

  // ── Track-change horizontal slide (skip full rebuild when already open) ──
  if (!isFirstOpen) {
    const dir = _miniCarouselDir || 1;
    _miniCarouselDir = 0;

    const fp = document.getElementById("fullPlayer");
    if (fp) {
      const artCard = fp.querySelector(".fpArtCard");
      const meta = fp.querySelector(".fpMeta");
      const bg = fp.querySelector(".fpBg");

      if (artCard && meta) {
        const exitX  = dir === 1 ? "-110%" : "110%";
        const enterX = dir === 1 ? "110%"  : "-110%";
        const dur = "0.4s";
        const ease = "cubic-bezier(.32,.72,.24,1)";

        // Clone old content for exit animation
        const fpRect   = fp.getBoundingClientRect();
        const artRect  = artCard.getBoundingClientRect();
        const metaRect = meta.getBoundingClientRect();

        const artClone  = artCard.cloneNode(true);
        const metaClone = meta.cloneNode(true);

        for (const c of [artClone, metaClone]) {
          c.style.position = "absolute";
          c.style.zIndex = "5";
          c.style.margin = "0";
          c.style.flexShrink = "0";
        }
        artClone.style.top    = (artRect.top  - fpRect.top)  + "px";
        artClone.style.left   = (artRect.left - fpRect.left) + "px";
        artClone.style.width  = artRect.width  + "px";
        artClone.style.height = artRect.height + "px";
        metaClone.style.top   = (metaRect.top  - fpRect.top)  + "px";
        metaClone.style.left  = (metaRect.left - fpRect.left) + "px";
        metaClone.style.width = metaRect.width + "px";

        fp.appendChild(artClone);
        fp.appendChild(metaClone);

        // Update real elements with new song data
        artCard.querySelector(".fpArt").innerHTML = art;
        meta.querySelector(".fpTitle").textContent = title;
        meta.querySelector(".fpSub").textContent   = subtitle;
        if (bg) bg.innerHTML = art;

        // Position new content off-screen
        artCard.style.transition = "none";
        meta.style.transition    = "none";
        artCard.style.transform  = `translateX(${enterX})`;
        meta.style.transform     = `translateX(${enterX})`;

        requestAnimationFrame(() => requestAnimationFrame(() => {
          // Slide clones out
          artClone.style.transition  = `transform ${dur} ${ease}, opacity ${dur} ease`;
          metaClone.style.transition = `transform ${dur} ${ease}, opacity ${dur} ease`;
          artClone.style.transform   = `translateX(${exitX})`;
          artClone.style.opacity     = "0";
          metaClone.style.transform  = `translateX(${exitX})`;
          metaClone.style.opacity    = "0";

          // Slide new content in
          artCard.style.transition = `transform ${dur} ${ease}`;
          meta.style.transition    = `transform ${dur} ${ease}`;
          artCard.style.transform  = "translateX(0)";
          meta.style.transform     = "translateX(0)";

          const cleanUp = (el) => {
            el.style.transition = "";
            el.style.transform  = "";
          };
          artClone.addEventListener("transitionend",  () => artClone.remove(),  { once: true });
          metaClone.addEventListener("transitionend", () => metaClone.remove(), { once: true });
          artCard.addEventListener("transitionend",   () => cleanUp(artCard),   { once: true });
          meta.addEventListener("transitionend",      () => cleanUp(meta),      { once: true });
        }));

        // Also update lyrics bar + body for track change
        const lBarArt = fp.querySelector(".fpLyricsBarArt");
        const lBarTitle = fp.querySelector(".fpLyricsBarTitle");
        const lBarSub = fp.querySelector(".fpLyricsBarSub");
        const lBody = fp.querySelector(".fpLyricsText");
        if (lBarArt) lBarArt.innerHTML = art;
        if (lBarTitle) lBarTitle.textContent = title;
        if (lBarSub) lBarSub.textContent = subtitle;
        if (lBody) lBody.innerHTML = song.lyrics ? escapeHtml(song.lyrics) : '<span class="fpLyricsEmpty">No lyrics yet</span>';
        // Enable/disable lyrics tab based on new song
        const lTab = fp.querySelector(".fpTabLyrics");
        if (lTab) lTab.disabled = !song.lyrics;

        return; // skip full innerHTML rebuild
      }
    }
  }

  const _shuffleSvg = `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="4" y1="4" x2="21" y2="21"/></svg>`;
  const _prevSvg    = `<svg viewBox="0 0 24 24" width="35" height="35" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>`;
  const _nextSvg    = `<svg viewBox="0 0 24 24" width="35" height="35" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>`;
  const _repeatSvg  = `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;
  const _playSvg    = `<svg viewBox="0 0 24 24" width="55" height="55" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
  const _pauseSvg   = `<svg viewBox="0 0 24 24" width="55" height="55" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;

  activeScreenEl.innerHTML = `
    <section class="fp" id="fullPlayer" aria-label="Now playing">
      <div class="fpBg" aria-hidden="true">${art}</div>

      <header class="fpHeader">
        <button class="fpNavBtn" id="npBackBtn" aria-label="Close"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
        <div class="fpHeaderTitle">Now Playing</div>
        <button class="fpNavBtn" type="button" aria-label="More" disabled>⋮</button>
      </header>

      <div class="fpArtCard" aria-hidden="true">
        <div class="fpArt">${art}</div>
      </div>

      <div class="fpMeta">
        <div class="fpTitle">${escapeHtml(title)}</div>
        <div class="fpSub">${escapeHtml(subtitle)}</div>
      </div>

      <div class="fpActions" aria-label="Actions">
        <button class="fpPill" id="npGoList" type="button">Up next</button>
        <button class="fpPill" type="button" disabled>Save</button>
        <button class="fpPill" type="button" disabled>Share</button>
      </div>

      <div class="fpScrub">
        <span class="fpTime" id="npTimeCur">0:00</span>
        <input id="npScrub" class="fpScrubBar" type="range" min="0" max="1000" value="0" aria-label="Progress" />
        <span class="fpTime" id="npTimeDur">0:00</span>
      </div>

      <div class="fpControls" role="group" aria-label="Playback controls">
        <button class="fpCtrl ${state.player?.shuffle ? 'is-active' : ''}" type="button" aria-label="Shuffle" id="npShuffle">${_shuffleSvg}</button>
        <button class="fpCtrl" id="npPrev" type="button" aria-label="Previous">${_prevSvg}</button>
        <button class="fpCtrl fpPlay" id="npToggle" type="button" aria-label="Play / Pause">${globalAudio?.paused ? _playSvg : _pauseSvg}</button>
        <button class="fpCtrl" id="npNext" type="button" aria-label="Next">${_nextSvg}</button>
        <button class="fpCtrl ${state.player?.repeat ? 'is-active' : ''}" type="button" aria-label="Repeat" id="npRepeat">${_repeatSvg}${state.player?.repeat === "one" ? `<span class="r1b">1</span>` : ""}</button>
      </div>

      <div class="fpLyricsBar">
        <div class="fpLyricsBarArt">${art}</div>
        <div class="fpLyricsBarMeta">
          <div class="fpLyricsBarTitle">${escapeHtml(title)}</div>
          <div class="fpLyricsBarSub">${escapeHtml(subtitle)}</div>
        </div>
        <button class="fpLyricsBarPlay" id="npLyricsToggle" type="button" aria-label="Play / Pause">${globalAudio?.paused ? _playSvg : _pauseSvg}</button>
      </div>

      <div class="fpLyricsScrub">
        <div class="fpLyricsScrubFill" id="npLyricsScrubFill"></div>
      </div>

      <nav class="fpBottomTabs" aria-label="Now playing tabs">
        <button class="fpTab fpTabUpNext is-active" type="button" id="npTabUpNext">UP NEXT</button>
        <button class="fpTab fpTabLyrics" type="button" id="npTabLyrics" ${song.lyrics ? '' : 'disabled'}>LYRICS</button>
        <button class="fpTab fpTabRelated" type="button" disabled>RELATED</button>
      </nav>

      <div class="fpLyricsBody" id="npLyricsBody">
        <div class="fpLyricsText">${song.lyrics ? escapeHtml(song.lyrics) : '<span class="fpLyricsEmpty">No lyrics yet</span>'}</div>
      </div>
    </section>
  `;

  // Slide-up entrance animation — only when first opening, not on track change
  if (isFirstOpen) {
    const _fp = $("#fullPlayer");
    if (_fp) {
      _fp.style.transform = "translateY(100%)";
      _fp.style.transition = "none";
      requestAnimationFrame(() => requestAnimationFrame(() => {
        _fp.style.transition = "transform 471ms cubic-bezier(.22,.9,.24,1)";
        _fp.style.transform = "translateY(0)";
        _fp.addEventListener("transitionend", () => {
          _fp.style.transition = "";
          _fp.style.transform = "";
        }, { once: true });
      }));
    }
  }

  const npScrub = $("#npScrub");

  function syncNowScrub() {
    // Bail if the now-playing view has been torn down (stale closure)
    if (!npScrub || !globalAudio || !document.contains(npScrub)) return;

    if (Number.isFinite(globalAudio.duration) && globalAudio.duration > 0) {
      npScrub.value = String(Math.floor((globalAudio.currentTime / globalAudio.duration) * 1000));
    } else {
      npScrub.value = "0";
    }

    const toggleEl = $("#npToggle");
    const curEl    = $("#npTimeCur");
    const durEl    = $("#npTimeDur");
    if (toggleEl) toggleEl.innerHTML = globalAudio.paused ? _playSvg : _pauseSvg;
    if (curEl)    curEl.textContent    = fmtTime(globalAudio.currentTime || 0);
    if (durEl)    durEl.textContent    = fmtTime(globalAudio.duration    || 0);
  }

  syncNowScrub();
  globalAudio?.addEventListener("timeupdate", syncNowScrub);
  globalAudio?.addEventListener("loadedmetadata", syncNowScrub);
  globalAudio?.addEventListener("play", syncNowScrub);
  globalAudio?.addEventListener("pause", syncNowScrub);

  const cleanup = () => {
    globalAudio?.removeEventListener("timeupdate", syncNowScrub);
    globalAudio?.removeEventListener("loadedmetadata", syncNowScrub);
    globalAudio?.removeEventListener("play", syncNowScrub);
    globalAudio?.removeEventListener("pause", syncNowScrub);
  };

  const closeFullPlayer = () => {
    cleanup();
    R.fullPlayerOpen = false;
    setFullPlayerOpen(false);
    R.playerScreen = "list";
    if (R.prevTabBeforeFullPlayer) {
      R.currentTab = R.prevTabBeforeFullPlayer;
      R.selectedSongId = R.prevSelectedSongIdBeforeFullPlayer;
      R.prevTabBeforeFullPlayer = null;
      R.prevSelectedSongIdBeforeFullPlayer = null;
      setHeader(R.currentTab === "songs" && R.selectedSongId ? "Song" : TAB_TITLES[R.currentTab] || "RiffBank");
    } else {
      setHeader("Player");
    }
    syncTabs();
    render();
  };

  $("#npBackBtn")?.addEventListener("click", closeFullPlayer);

  // ✅ Swipe down to close — reveals previous screen underneath
  const fp = $("#fullPlayer");
  let swipeOn = false;
  let startY = 0;
  let startX = 0;
  let lastDy = 0;
  let _peekReady = false;
  let _savedPrevTab = null;
  let _savedPrevSongId = null;

  fp?.addEventListener("touchstart", (e) => {
    const t = e.touches?.[0];
    if (!t) return;
    if (e.target?.closest?.("button, input, a, .fpLyricsBody")) return;

    swipeOn = true;
    startY = t.clientY;
    startX = t.clientX;
    lastDy = 0;
    _peekReady = false;
  }, { passive: true });

  fp?.addEventListener("touchmove", (e) => {
    if (!swipeOn) return;
    const t = e.touches?.[0];
    if (!t) return;

    const dy = t.clientY - startY;
    const dx = t.clientX - startX;
    if (dy < 0) return;
    if (Math.abs(dx) > Math.abs(dy)) return;

    e.preventDefault();
    lastDy = dy;

    // First significant drag: lift player to body, render previous screen underneath
    if (!_peekReady && dy > 8) {
      _peekReady = true;
      _savedPrevTab = R.prevTabBeforeFullPlayer;
      _savedPrevSongId = R.prevSelectedSongIdBeforeFullPlayer;

      // Move fp to body so it floats above everything
      document.body.appendChild(fp);

      // Restore previous screen underneath
      R.fullPlayerOpen = false;
      setFullPlayerOpen(false);
      R.playerScreen = "list";
      if (_savedPrevTab) {
        R.currentTab = _savedPrevTab;
        R.selectedSongId = _savedPrevSongId;
        R.prevTabBeforeFullPlayer = null;
        R.prevSelectedSongIdBeforeFullPlayer = null;
        setHeader(R.currentTab === "songs" && R.selectedSongId ? "Song" : TAB_TITLES[R.currentTab] || "RiffBank");
      } else {
        setHeader("Player");
      }
      syncTabs();
      render();
    }

    fp.style.transform = `translateY(${dy}px)`;
    fp.style.transition = "none";
  }, { passive: false });

  fp?.addEventListener("touchend", () => {
    if (!swipeOn) return;
    swipeOn = false;

    if (_peekReady) {
      if (lastDy > 80) {
        // Commit close: slide player off-screen, then remove
        cleanup();
        fp.style.transition = "transform 300ms cubic-bezier(.32,0,.6,1), opacity 214ms ease";
        fp.style.transform = "translateY(100%)";
        fp.style.opacity = "0";
        fp.addEventListener("transitionend", () => fp.remove(), { once: true });
      } else {
        // Cancel: animate player back into place, restore state
        R.fullPlayerOpen = true;
        setFullPlayerOpen(true);
        R.prevTabBeforeFullPlayer = _savedPrevTab;
        R.prevSelectedSongIdBeforeFullPlayer = _savedPrevSongId;
        R.currentTab = "player";
        R.playerScreen = "now";
        syncTabs();

        // Slide fp back to origin, then move it back into #view
        fp.style.transition = "transform 300ms cubic-bezier(.32,0,.6,1)";
        fp.style.transform = "translateY(0px)";
        fp.addEventListener("transitionend", () => {
          fp.style.transition = "";
          fp.style.transform = "";
          // Move fp back from body into #view where it belongs
          const view = document.getElementById("view");
          if (view && fp.parentNode === document.body) {
            view.appendChild(fp);
          }
        }, { once: true });
      }
      _peekReady = false;
    } else {
      fp.style.transition = "transform 193ms ease, opacity 180ms ease";
      fp.style.transform = "translateY(0px)";
      fp.style.opacity = "1";
    }
  }, { passive: true });

  npScrub?.addEventListener("input", (e) => {
    if (!globalAudio) return;
    const val = Number(e.target.value || 0) / 1000;
    if (Number.isFinite(globalAudio.duration) && globalAudio.duration > 0) {
      globalAudio.currentTime = val * globalAudio.duration;
    }
  });

  $("#npToggle")?.addEventListener("click", async () => {
    if (!globalAudio) return;
    await unlockAudioOnce();
    if (globalAudio.paused) {
      if (!globalAudio.src) {
        await playNowPlaying({ autoplay: true }); // first time, no src yet
      } else {
        await globalAudio.play(); // resume from current position
      }
    } else {
      globalAudio.pause();
    }
    syncMiniPlayerUI();
  });

  $("#npNext")?.addEventListener("click", () => {
    if (state.player?.repeat === "one") return;
    if (!advanceToNextTrack({ render: true })) toast("Queue empty 😅");
  });

  $("#npPrev")?.addEventListener("click", () => {
    if (state.player?.repeat === "one") return;
    advanceToPrevTrack({ render: true });
  });

  $("#npShuffle")?.addEventListener("click", () => {
  state.player.shuffle = !state.player.shuffle;
  saveState();
  $("#npShuffle")?.classList.toggle("is-active", !!state.player.shuffle);
});

$("#npRepeat")?.addEventListener("click", () => {
  const r = state.player.repeat;
  state.player.repeat = r === false ? true : r === true ? "one" : false;
  saveState();
  const btn = $("#npRepeat");
  if (btn) {
    btn.classList.toggle("is-active", !!state.player.repeat);
    btn.querySelector(".r1b")?.remove();
    if (state.player.repeat === "one") {
      const badge = document.createElement("span");
      badge.className = "r1b";
      badge.textContent = "1";
      btn.appendChild(badge);
    }
  }
});

  $("#npGoSong")?.addEventListener("click", () => {
    cleanup();
    setFullPlayerOpen(false);
    R.currentTab = "songs";
    R.selectedSongId = song.id;
    R.selectedVersionId = null;
    R.drawerView = null;
    R.overlayView = null;
    R.playerScreen = "list";
    setHeader("Song");
    syncTabs();
    render();
  });

  $("#npGoList")?.addEventListener("click", () => {
    cleanup();
    setFullPlayerOpen(false);
    R.playerScreen = "list";
    setHeader("Player");
    render();
  });

  // ── Lyrics tab switching ──
  const _fpEl = $("#fullPlayer");

  function switchToTab(tab) {
    if (!_fpEl) return;
    // Toggle tab active states
    _fpEl.querySelectorAll(".fpTab").forEach(t => t.classList.remove("is-active"));
    if (tab === "lyrics") {
      _fpEl.querySelector(".fpTabLyrics")?.classList.add("is-active");
      _fpEl.classList.add("fp--lyrics");
    } else {
      _fpEl.querySelector(".fpTabUpNext")?.classList.add("is-active");
      _fpEl.classList.remove("fp--lyrics");
    }
  }

  $("#npTabLyrics")?.addEventListener("click", () => switchToTab("lyrics"));
  $("#npTabUpNext")?.addEventListener("click", () => switchToTab("upnext"));

  // Tap lyrics bar to go back to full player
  _fpEl?.querySelector(".fpLyricsBar")?.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    switchToTab("upnext");
  });

  // Play/pause from lyrics bar
  $("#npLyricsToggle")?.addEventListener("click", async () => {
    if (!globalAudio) return;
    await unlockAudioOnce();
    if (globalAudio.paused) {
      if (!globalAudio.src) {
        await playNowPlaying({ autoplay: true });
      } else {
        await globalAudio.play();
      }
    } else {
      globalAudio.pause();
    }
    syncMiniPlayerUI();
  });

  // Sync lyrics scrub fill + lyrics bar play button
  function syncLyricsScrub() {
    if (!globalAudio || !document.getElementById("fullPlayer")) return;
    const fill = $("#npLyricsScrubFill");
    if (fill && Number.isFinite(globalAudio.duration) && globalAudio.duration > 0) {
      fill.style.width = ((globalAudio.currentTime / globalAudio.duration) * 100) + "%";
    }
    const lBtn = $("#npLyricsToggle");
    if (lBtn) lBtn.innerHTML = globalAudio?.paused ? _playSvg : _pauseSvg;
  }
  globalAudio?.addEventListener("timeupdate", syncLyricsScrub);
  globalAudio?.addEventListener("play", syncLyricsScrub);
  globalAudio?.addEventListener("pause", syncLyricsScrub);
}

// ---------------------
// Settings
// ---------------------
// ── Settings: shared SVG icons ──
const _setChev = `<div class="setRowChev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg></div>`;
const _setIcons = {
  account: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  cloud: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>`,
  library: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`,
  art: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>`,
  debug: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`,
  danger: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
};

// Wire collapsing-title scroll listener for a settings sub-screen
// Settings views now in ui/settingsView.js

// ---------------------
// Prevent rubber band scroll
// ---------------------
function preventRubberBandScroll(container) {
  if (!container) return;
  let startY = 0;

  container.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches && e.touches.length > 1) return;
      startY = e.touches?.[0]?.clientY ?? 0;
    },
    { passive: true }
  );

  container.addEventListener(
    "touchmove",
    (e) => {
      // ✅ Never block touches on Home (otherwise taps can die)
      if (document.body.classList.contains("isHome")) return;

      // ✅ Allow native scrolling on Songs detail screens (Song + Version detail)
      if (R.currentTab === "songs" && R.selectedSongId) return;

      const canScroll = container.scrollHeight > container.clientHeight + 1;
      if (!canScroll) return;

      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "textarea" || tag === "input" || tag === "select") return;

      const y = e.touches?.[0]?.clientY ?? 0;
      const dy = y - startY;

      // ✅ Allow small finger wiggles so taps still register
      if (Math.abs(dy) < 10) return;

      const atTop = container.scrollTop <= 0;
      const atBottom =
        Math.ceil(container.scrollTop + container.clientHeight + 1) >= container.scrollHeight;

      if ((atTop && dy > 0) || (atBottom && dy < 0)) e.preventDefault();
    },
    { passive: false }
  );
}

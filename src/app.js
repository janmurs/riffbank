// RiffBank v1.3 (Local-first PWA + Google Drive sync)
// - Song creation + editing
// - Upload Helper (suggested filename + Drive path)
// - Version history + Best flag
// - Best-only Player (plays links)
// - Dashboard + Settings
// - Export / Import
// - Google Drive integration (auto-sync uploads, stream playback)

window.onerror = (m, src, line, col) => alert(`JS ERROR:\n${m}\n${line}:${col}`);

// Dev toggle: skip splash animation
 const DISABLE_SPLASH = false;

// console.log("RIFFBANK APP.JS LOADED ✅", new Date().toISOString());
// alert("RIFFBANK APP.JS LOADED ✅ " + new Date().toISOString());

import { $ } from "./ui/dom.js";
import { runSplashSequence } from "./splash/splash.js";
import {
  gdriveLoadGIS,
  gdriveIsConnected,
  gdriveHasValidToken,
  gdriveGetConfig,
  gdriveConnect,
  gdriveConnectNewFolder,
  gdriveDisconnect,
  gdriveUploadAudio,
  gdriveFetchBlob,
  gdriveDeleteFile,
  gdriveSyncStateSoon,
  gdriveSyncStateNow,
  gdrivePullState,
  gdrivePullStateSilent,
  gdriveRebuildFromFolders,
} from "./gdrive.js";

const LS_KEY = "riffbank_v1";
const HAS_SAVED_STATE = !!localStorage.getItem(LS_KEY); // used to detect first-run seeding

let prevTabBeforeFullPlayer = null;
let prevSelectedSongIdBeforeFullPlayer = null;

let splashAlreadyRan = false;

// ---------------------
// Player view state
// ---------------------
let playerFilter = "all"; // all | fav
let playerSort = "recent"; // recent | title
let playerQueue = []; // array of { songId, versionId }
let sheetState = null; // { songId, versionId }
let lastTabBeforeFullPlayer = null;
let fullPlayerOpen = false;

// NEW: fullscreen player UI state (single source of truth)
let isFullPlayerOpen = false;

// Projects sub-screen ("list" = project list, string = selected project name)
let projectDetailScreen = null;

// Session-only: hide mini player until the user actually plays something after a fresh launch
let hasPlayedThisSession = false;

// Full-screen Now Playing is an overlay (independent of tabs)
let isNowPlayingFullscreen = false;

function setFullPlayerOpen(on) {
  isFullPlayerOpen = !!on;

  // One CSS toggle so fullscreen can take the whole space
  document.body.classList.toggle("fullplayer-open", isFullPlayerOpen);

  // Hard guarantee: never show both at once.
  // IMPORTANT: when closing fullscreen, do NOT force-show the mini player.
  // Let syncMiniPlayerUI decide based on session + nowPlaying state.
  if (miniPlayerEl) {
    if (isFullPlayerOpen) {
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
  player: document.getElementById("screen-player"),
  settings: document.getElementById("screen-settings"),
  drawer: document.getElementById("screen-drawer"),
};

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
    if (!isActive) el.innerHTML = "";
  });
}

const headerTitle = $("#headerTitle");
const toastEl = $("#toast");

// ---------------------
// Audio storage (IndexedDB) - Phase 1
// ---------------------
const AUDIO_DB = "riffbank_audio_v1";
const AUDIO_STORE = "files";
const audioUrlCache = new Map(); // localAudioId -> objectURL

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

function openAudioDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(AUDIO_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        db.createObjectStore(AUDIO_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putAudioBlob({ id, blob, name, type, size }) {
  const db = await openAudioDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, "readwrite");
    tx.objectStore(AUDIO_STORE).put({
      id,
      blob,
      name,
      type,
      size,
      savedAt: nowStamp(),
    });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function getAudioBlob(id) {
  const db = await openAudioDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, "readonly");
    const req = tx.objectStore(AUDIO_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

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

  function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

function openNowPlaying() {
  if (!state.player?.nowPlaying) return;

  fullPlayerOpen = true;
  isNowPlayingFullscreen = true;

  const overlay = getNowPlayingOverlayEl();
  overlay.innerHTML = renderNowPlayingHTML();
  wireNowPlayingEvents(overlay);
  overlay.classList.add("is-open");
}

function closeNowPlaying() {
  fullPlayerOpen = false;
  isNowPlayingFullscreen = false;

  const overlay = getNowPlayingOverlayEl();renderNowPlayingHTML
  overlay.classList.remove("is-open");

  setTimeout(() => {
    if (!fullPlayerOpen) overlay.innerHTML = "";
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
  const repeatOn = !!state.player.repeat;

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
        <div class="fpCoverWrap">
        ${song ? coverSvg(song) : ""}
      </div>
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
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M4 20l8-8"/><path d="M21 3l-7 7"/><path d="M16 21h5v-5"/><path d="M4 4l5 5"/><path d="M15 15l6 6"/></svg>
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
        <button class="fpCtrl ${repeatOn ? "is-active" : ""}" id="fpRepeat" aria-label="Repeat">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
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
        root.style.transition = "transform 160ms ease";
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
    state.player.repeat = !state.player.repeat;
    saveState();
    overlay.querySelector("#fpRepeat")?.classList.toggle("is-active", state.player.repeat);
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
    currentTab === "home" &&
    !drawerView &&
    !overlayView &&
    !selectedSongId
  );
}

function toast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 1400);
}

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
const miniNextEl   = document.getElementById("miniNext");
const miniPrevEl   = document.getElementById("miniPrev");
const miniScrubEl  = document.getElementById("miniScrub");
const miniTitleEl  = document.getElementById("miniTitle");
const miniSubEl    = document.getElementById("miniSub");

function isPlayable(v){
  return !!(v?.link || v?.fileId || v?.localAudioId || v?.driveFileId);
}

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
if (typeof isNowPlayingFullscreen !== "undefined" && isNowPlayingFullscreen) {
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

  if (!song || !v || !isPlayable(v)) {
    miniPlayerEl.classList.add("hidden");
    miniPlayerEl.classList.remove("visible");
    miniPlayerEl.setAttribute("aria-hidden", "true");
    document.body.classList.remove("hasMiniPlayer");
    syncMiniPlayerReserveSpace();
    return;
  }

  // show
  miniPlayerEl.classList.remove("hidden");
  miniPlayerEl.setAttribute("aria-hidden", "false");
  document.body.classList.add("hasMiniPlayer");
  requestAnimationFrame(() => {
  miniPlayerEl.classList.add("visible");
  miniPlayerEl.setAttribute("aria-hidden", "false");
  syncMiniPlayerReserveSpace(); // <-- IMPORTANT: updates --dock-h so content isn't covered
  });

  // album art
  if (miniArtEl) {
    // Use your existing neon cover generator (lite for speed)
    miniArtEl.innerHTML = coverSvg(song, { lite: true });
  }

// title / subtitle (set first so text always shows even if art generation fails)
if (miniTitleEl) miniTitleEl.textContent = song.title || "Untitled";
if (miniSubEl) miniSubEl.textContent = v.label || "";

// album art
if (miniArtEl) {
  try {
    miniArtEl.innerHTML = coverSvg(song, { lite: true });
  } catch (e) {
    console.warn("mini coverSvg failed:", e);
    miniArtEl.innerHTML = "";
  }
}

  // play/pause icon
  if (miniToggleEl) miniToggleEl.textContent = globalAudio?.paused ? "▶" : "⏸";

  // keep scrub in sync
  syncMiniScrub();
}

scheduleDockSpaceSync();
window.addEventListener("resize", scheduleDockSpaceSync);
if (window.visualViewport) window.visualViewport.addEventListener("resize", scheduleDockSpaceSync);

function syncMiniScrub(){
  if (!miniScrubEl || !globalAudio) return;
  if (Number.isFinite(globalAudio.duration) && globalAudio.duration > 0) {
    miniScrubEl.value = String(Math.floor((globalAudio.currentTime / globalAudio.duration) * 1000));
  } else {
    miniScrubEl.value = "0";
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

async function playNowPlaying({ autoplay = true } = {}){
  const now = state.player?.nowPlaying;
  if (!now || !globalAudio) return;

  const url = await getPlayableUrlForVersion(now.songId, now.versionId);
  if (!url) return toast("No playable audio 😅");
  if (url === "drive-auth-required") return toast("Sign in to Google Drive to stream this file — tap Settings > Drive to reconnect 🔑");

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
  if (globalAudio.src !== url) globalAudio.src = url;

  if (autoplay) {
    try {
      await globalAudio.play(); // must be called from a user gesture on iOS
    } catch (e) {
      console.warn(e);
      toast("Tap Play to start audio (iOS rule) 😅");
    }
  }

  await syncMiniPlayerUI();
}

function nowStamp(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}${mi}`;
}

function slug(s) {
  return String(s || "")
    .trim()
    .replace(/[\/\\:*?"<>|#%{}[\]^`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeTextarea(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return (
    "id-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

function loadState() {
  const raw = localStorage.getItem(LS_KEY);
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }
  return {
    version: 1,
    settings: {
      driveRoot: "RiffBank",
      defaultProject: "SkeletonDanceParty",
      defaultGenre: "Metalcore",
      defaultSprint: "Unsorted",
      lyricsScratch: ""
    },
    songs: [],
    quickLog: [],
  };
}

let state = loadState();

function normalizeState() {
  state.settings = state.settings || {};
  state.songs = Array.isArray(state.songs) ? state.songs : [];
  state.quickLog = Array.isArray(state.quickLog) ? state.quickLog : [];
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
      // Google Drive support
      if (v.driveFileId === undefined) v.driveFileId = null;
      if (v.driveWebViewLink === undefined) v.driveWebViewLink = "";
      // Player playlist flags
      if (typeof v.playerYes !== "boolean") v.playerYes = false;
      if (typeof v.favorite !== "boolean") v.favorite = false;
    });
    // Ensure exactly one active version if versions exist and none is currently active
    if (song.versions.length && !song.versions.some(v => v.isActive)) {
      song.versions[0].isActive = true;
    }
  });
  // Player state (queue)
  state.player = state.player || {};
  state.player.queue = Array.isArray(state.player.queue) ? state.player.queue : [];
  state.player.repeatQueue = Array.isArray(state.player.repeatQueue) ? state.player.repeatQueue : [];
  state.player.nowPlaying = state.player.nowPlaying || null;

  // Playback toggles (persisted)
  if (typeof state.player.shuffle !== "boolean") state.player.shuffle = false;
  if (typeof state.player.repeat !== "boolean") state.player.repeat = false;
}

normalizeState();

function saveState() {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
  // Auto-sync to Google Drive (debounced — pushes 5s after last save)
  gdriveSyncStateSoon(state);
}

// ---------------------
// Default library seeding (from /public/library)
// ---------------------
async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

function basenameNoExt(path) {
  const base = String(path || "").split("/").pop() || "";
  return base.replace(/\.[a-z0-9]+$/i, "");
}

function titleizeFromSlug(s) {
  return String(s || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function safeString(x) {
  return (x == null ? "" : String(x)).trim();
}

function normalizeFileUrl(file) {
  // Accept "./library/...", "/library/...", or "library/..."
  let f = safeString(file);
  if (!f) return "";
  if (f.startsWith("http://") || f.startsWith("https://")) return f;
  if (f.startsWith("/")) return f;
  if (f.startsWith("./")) return f;
  if (f.startsWith("library/")) return "./" + f;
  return "./" + f;
}

function extFromPath(p) {
  const m = String(p || "").match(/\.([a-z0-9]+)$/i);
  return (m?.[1] || "").toLowerCase();
}

function yyyymmddFromDate(d) {
  const s = safeString(d);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  return `${m[1]}${m[2]}${m[3]}`;
}

function guessNumericSuffixFromTitle(t) {
  const s = safeString(t);
  // e.g. "Wasting 20260206 2" -> "2"
  const m = s.match(/\b(\d{1,2})\b\s*$/);
  return m ? m[1] : "";
}

function resolveSeedLibraryUrl({ bandId, songSlug, verObj }) {
  // Only for seeded catalog items coming from /public/library manifests.
  // Canonical layout:
  //   /library/<band>/<songSlug>/<filename>
  const raw = safeString(verObj?.file || verObj?.url || verObj?.path || "");
  const normalized = normalizeFileUrl(raw);
  const band = safeString(bandId);
  const slug = safeString(songSlug);

  if (!band || !slug) return normalized;

  // If manifest already points at the correct canonical folder, keep it.
  if (normalized.includes(`/library/${band}/${slug}/`)) return normalized;

  // Derive extension (prefer explicit file path ext; fallback to format)
  const ext =
    extFromPath(raw) ||
    extFromPath(normalized) ||
    safeString(verObj?.format).toLowerCase() ||
    "wav";

  const rawBase = String(raw || "").split("/").pop() || "";
  const normBase = String(normalized || "").split("/").pop() || "";
  const id = safeString(verObj?.id);

  // Prefer a filename that matches the song slug (most reliable)
  const candidates = [];
  if (rawBase && rawBase.toLowerCase().startsWith(slug.toLowerCase() + "_")) candidates.push(rawBase);
  if (normBase && normBase.toLowerCase().startsWith(slug.toLowerCase() + "_")) candidates.push(normBase);

  // If id looks like a filename base, use it
  if (id && id.toLowerCase().startsWith(slug.toLowerCase())) candidates.push(`${id}.${ext}`);

  // Heuristic: slug + date stamp (+ optional numeric suffix)
  const ds = yyyymmddFromDate(verObj?.date || verObj?.createdAt);
  if (ds) {
    const suffix = guessNumericSuffixFromTitle(verObj?.title || verObj?.name || "");
    if (suffix) candidates.push(`${slug}_${ds}_${suffix}.${ext}`);
    candidates.push(`${slug}_${ds}.${ext}`);
  }

  // Fallbacks: whatever filename we were given, or slug.ext
  if (rawBase) candidates.push(rawBase);
  if (normBase) candidates.push(normBase);
  candidates.push(`${slug}.${ext}`);

  // Pick first unique candidate
  const seen = new Set();
  const filename = candidates.find((c) => {
    const key = String(c || "").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return `./library/${band}/${slug}/${filename}`;
}

function guessSongTitle(songObj) {
  return (
    safeString(songObj?.title) ||
    safeString(songObj?.name) ||
    safeString(songObj?.displayName) ||
    titleizeFromSlug(songObj?.slug || "") ||
    "Untitled"
  );
}

function guessVersionLabel(songTitle, verObj, fileUrl, idx) {
  const t = safeString(verObj?.title) || safeString(verObj?.name) || safeString(verObj?.label);
  if (t) return t;
  const base = basenameNoExt(fileUrl);
  if (base) return titleizeFromSlug(base);
  return `${songTitle} - v${idx + 1}`;
}

function dateToStamp(d) {
  const s = safeString(d);
  if (!s) return nowStamp();
  return s;
}

function buildSeedSong({ bandId, bandName, songObj }) {
  const title = guessSongTitle(songObj);
  const versionsRaw = Array.isArray(songObj?.versions)
    ? songObj.versions
    : Array.isArray(songObj?.files)
      ? songObj.files
      : Array.isArray(songObj?.tracks)
        ? songObj.tracks
        : [];

  const song = {
    id: uid(),
    title,
    project: bandName || bandId || "Project",
    genre: safeString(songObj?.genre) || "",
    sprint: safeString(songObj?.sprint) || "Library",
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
    featuredVersionId: null,
  };

  const fallbackFile = songObj?.file || songObj?.url || songObj?.path;
  const normalizedFallback = normalizeFileUrl(fallbackFile);
  const finalVersions = versionsRaw.length
    ? versionsRaw
    : (normalizedFallback ? [{ file: normalizedFallback, title: title }] : []);

  const versions = finalVersions.map((v, idx) => {
    const fileUrl = resolveSeedLibraryUrl({ bandId, songSlug: songObj?.slug, verObj: v });
    return {
      id: uid(),
      label: guessVersionLabel(title, v, fileUrl, idx),
      notes: safeString(v?.notes) || "",
      link: fileUrl,
      isBest: !!(v?.best || v?.isBest),
      isActive: false,
      createdAt: dateToStamp(v?.date || v?.createdAt),
      playerYes: (typeof v?.playerYes === "boolean") ? v.playerYes : true,
      favorite: (typeof v?.favorite === "boolean") ? v.favorite : false,
    };
  });

  let best = versions.find(x => x.isBest);
  if (!best && versions.length) {
    best = versions[0];
    best.isBest = true;
  }
  if (best) {
    song.featuredVersionId = best.id;
  }

  song.versions = versions.reverse();
  return song;
}

async function seedDefaultLibraryIfNeeded({ force = false } = {}) {
  if (!force && HAS_SAVED_STATE) return false;
  if (!force && Array.isArray(state?.songs) && state.songs.length) return false;

  let index;
  try {
    // library is served from the site root
    try {
      index = await fetchJson("/library/index.json");
    } catch {
      // fallback for some local setups
      index = await fetchJson("./library/index.json");
    }
  } catch {
    return false;
  }

  const manifestPaths = Array.isArray(index?.manifests) ? index.manifests : [];
  if (!manifestPaths.length) return false;

  const seeded = [];

  for (const mp of manifestPaths) {
    try {
      const manifest = await fetchJson(mp);
      const bandId = safeString(manifest?.band || manifest?.id || manifest?.slug || "");
      const bandName = safeString(manifest?.displayName || manifest?.name || bandId || "");

      const songsRaw = Array.isArray(manifest?.songs)
        ? manifest.songs
        : Array.isArray(manifest?.tracks)
          ? manifest.tracks
          : [];

      for (const s of songsRaw) {
        if (!s) continue;
        const built = buildSeedSong({ bandId, bandName, songObj: s });
        if (built?.versions?.length) seeded.push(built);
      }
    } catch {
      // keep going
    }
  }

  if (!seeded.length) return false;

  state = loadState();
  state.songs = seeded;
  state.quickLog = [];
  state.player = { queue: [], nowPlaying: null };
  normalizeState();
  saveState();
  return true;
}

// ---------------------
// Local audio store (IndexedDB) — iPhone-friendly
// ---------------------

function openAudioDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(AUDIO_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        db.createObjectStore(AUDIO_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function audioPut(fileRecord) {
  const db = await openAudioDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, "readwrite");
    tx.objectStore(AUDIO_STORE).put(fileRecord);
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function audioGet(id) {
  const db = await openAudioDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, "readonly");
    const req = tx.objectStore(AUDIO_STORE).get(id);
    req.onsuccess = () => { db.close(); resolve(req.result || null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function audioDelete(id) {
  const db = await openAudioDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, "readwrite");
    tx.objectStore(AUDIO_STORE).delete(id);
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// Pick audio from iOS Files picker
function pickAudioFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";

    // iOS/Safari sometimes mislabels audio MIME types, so don't over-filter
    input.accept = ""; // allow all

    input.onchange = () => {
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

    input.click();
  });
}

function normalizeAudioLink(link) {
  if (!link) return link;

  // Leave absolute / special URLs alone
  if (/^(https?:)?\/\//i.test(link)) return link;
  if (link.startsWith("blob:")) return link;
  if (link.startsWith("data:")) return link;

  let out = String(link).trim();

  // Remove leading "./"
  if (out.startsWith("./")) out = out.slice(1); // "./public/.." -> "/public/.."

  // Ensure it starts with "/"
  if (!out.startsWith("/")) out = "/" + out;

  // Fix "public/..." paths -> served from root
  if (out.startsWith("/public/")) out = out.slice("/public".length); // "/public/library/.." -> "/library/.."

  return out;
}

async function getPlayableUrlForVersion(songId, versionId) {
  const song = getSong(songId);
  const v = getVersion(song, versionId);
  if (!song || !v) return null;

  // Priority 1: Local file (fileId in IndexedDB)
  if (v.fileId) {
    const cacheKey = `file:${v.fileId}`;
    if (audioUrlCache.has(cacheKey)) return audioUrlCache.get(cacheKey);

    const rec = await audioGet(v.fileId);
    if (rec?.blob) {
      const url = URL.createObjectURL(rec.blob);
      audioUrlCache.set(cacheKey, url);
      return url;
    }
    // Local file missing — fall through to other sources
  }

  // Priority 2: Local audio (localAudioId — legacy path)
  if (v.localAudioId) {
    const url = await getLocalObjectUrl(v.localAudioId);
    if (url) return url;
  }

  // Priority 3a: IndexedDB-cached Drive blob — instant, zero auth required
  if (v.driveFileId) {
    const cacheKey = `drive:${v.driveFileId}`;
    if (audioUrlCache.has(cacheKey)) return audioUrlCache.get(cacheKey);

    const cached = await audioGet(`gdrive:${v.driveFileId}`);
    if (cached?.blob) {
      const url = URL.createObjectURL(cached.blob);
      audioUrlCache.set(cacheKey, url);
      return url;
    }
  }

  // Priority 3b: Live fetch from Drive (only if a valid token is already in memory —
  // never triggers a sign-in popup mid-playback)
  if (v.driveFileId && gdriveIsConnected() && gdriveHasValidToken()) {
    const blob = await gdriveFetchBlob(v.driveFileId);
    if (blob) {
      const url = URL.createObjectURL(blob);
      audioUrlCache.set(`drive:${v.driveFileId}`, url);
      putAudioBlob({ id: `gdrive:${v.driveFileId}`, blob, name: v.fileName || v.label || "audio", type: v.fileType || blob.type || "audio/*", size: blob.size }).catch(() => {});
      return url;
    }
    if (!v.link) return "drive-auth-required";
  } else if (v.driveFileId && gdriveIsConnected() && !v.link) {
    // Drive file exists but no token — tell user to reconnect rather than silently failing
    return "drive-auth-required";
  }

  // Priority 4: Direct URL link
  if (v.link) {
    return normalizeAudioLink(v.link);
  }
  return null;
}

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
    const vv = s.versions.find(v => v.isActive) || s.versions[0];
    const v = ensureVersionFlags(vv);
    items.push({
      songId: s.id,
      versionId: v.id,
      songName: s.title || "Untitled",
      artistName: s.artist || "You",
      coverUrl: pickCoverUrl(s, v),
      favorite: !!v.favorite,
      updatedAt: v.updatedAt || v.stamp || s.updatedAt || "",
      label: versionLabel(v)
    });
  }

  // filter
  let out = items;
  if (playerFilter === "fav") out = out.filter(x => x.favorite);

  // sort
  if (playerSort === "title") {
    out = out.slice().sort((a,b) => a.songName.localeCompare(b.songName));
  } else {
    // "recent" (best effort): if no dates, keep natural order
    out = out.slice().sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  return out;
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// PWA SW register (auto-update + auto-activate)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", {
      updateViaCache: "none",
    });

      // If a new SW activates, reload once so we’re on the newest cached assets
      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      });

      // If an update is found, tell it to activate immediately
      function maybeAutoActivate() {
        const waiting = reg.waiting;
        if (waiting) {
          waiting.postMessage({ type: "SKIP_WAITING" });
        }
      }

      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;

        nw.addEventListener("statechange", () => {
          // installed + we already had a controller = this is an update
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            maybeAutoActivate();
          }
        });
      });

      // 🔥 Force-check on every load (beats the “24-hour SW update check” behavior)
      try { await reg.update(); } catch {}

      // If it’s already waiting (rare but happens), activate it
      maybeAutoActivate();

      // Optional: also re-check shortly after load (covers racey cases on iOS)
      setTimeout(() => { try { reg.update(); } catch {} }, 1500);
    } catch (e) {
      console.warn("SW registration failed", e);
    }
  });
}

const TAB_TITLES = {
  home: "RiffBank",
  songs: "Songs",
  player: "Player",
  settings: "Settings",
};

let currentTab = "home";
let selectedSongId = null;
let songsView = "list";
let pendingScrollToUpload = false;
let selectedVersionId = null; // ✅ new: when you tap a specific version row
let playerScreen = "list"; // "list" | "now"

const songsListState = {
  sortMode: "updated",
  query: "",
  statusFilter: "",
  projectFilter: "",
};

let drawerView = null;
let songsBackTarget = null; // e.g. "projects" | "collabs"
let drawerOpen = false;
let overlayView = null;

// ---------------------
// Drawer open/close
// ---------------------
function openDrawer() {
  drawerOpen = true;
  document.body.classList.add("drawerOpen");
  $("#drawer")?.setAttribute("aria-hidden", "false");
  $("#drawerOverlay")?.setAttribute("aria-hidden", "false");
}

function closeDrawer() {
  drawerOpen = false;
  document.body.classList.remove("drawerOpen");
  $("#drawer")?.setAttribute("aria-hidden", "true");
  $("#drawerOverlay")?.setAttribute("aria-hidden", "true");
}

function setDrawerView(v) {
  drawerView = v;
  closeDrawer();
  selectedSongId = null;
  render();
}

function setHeader(t) {
  if (headerTitle) headerTitle.textContent = t;
}

function syncTabs() {
  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === currentTab);
  });
}

function getSong(id) {
  return state.songs.find((s) => s.id === id);
}

function bestVersion(song) {
  if (!song?.versions?.length) return null;
  return song.versions.find((v) => v.isActive) || song.versions[0];
}

function getVersion(song, versionId){
  return (song?.versions || []).find(v => v.id === versionId) || null;
}

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

function featuredVersion(song){
  if (!song) return null;
  return (song.versions || []).find(v => v.isActive) || (song.versions || [])[0] || null;
}

function playVersion(songId, versionId, { goPlayer = true } = {}) {
  const song = getSong(songId);
  const v = getVersion(song, versionId);
  if (!song || !v || (!v.link && !v.fileId && !v.localAudioId && !v.driveFileId))
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
    drawerView = null;
    overlayView = null;
    selectedSongId = null;
    selectedVersionId = null;
    currentTab = "player";
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
  if (!song || !v || (!v.link && !v.fileId && !v.localAudioId && !v.driveFileId))
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

// Drawer controls
$("#drawerCloseBtn")?.addEventListener("click", closeDrawer);
$("#drawerOverlay")?.addEventListener("click", closeDrawer);

// Drawer menu items
document.querySelectorAll(".drawerItem").forEach((btn) => {
  btn.addEventListener("click", () => setDrawerView(btn.dataset.drawer));
});

// Tabs (Player + Home + Settings)
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetTab = btn.dataset.tab || "home";
    songsBackTarget = null;

    // If you tap Home while already on the true Home root, open Create sheet
    if (targetTab === "home" && isHomeRoot()) {
      openSheet("chooser");
      return;
    }

    // Otherwise: normal navigation
    drawerView = null;
    overlayView = null;
    selectedSongId = null;
    songsView = "list";

    currentTab = targetTab;
    if (targetTab === "player") {
      playerScreen = "list";
    }

    // ✅ Fix: if we navigate back to Home, ensure NO scroll position carries over.
    // (On iOS, the page can sometimes scroll the window instead of the inner scroller.)
    if (targetTab === "home") {
      if (screens.home) screens.home.scrollTop = 0;
      try { window.scrollTo(0, 0); } catch {}
      try { document.documentElement.scrollTop = 0; } catch {}
      try { document.body.scrollTop = 0; } catch {}
    }

    syncTabs();
    setHeader(TAB_TITLES[currentTab] || "RiffBank");
    render();
  });
});

// Tap header to go Home (feels app-y)
headerTitle?.addEventListener("click", () => {
  drawerView = null;
  overlayView = null;
  selectedSongId = null;
  songsView = "list";
  currentTab = "home";
  songsBackTarget = null;

  // ✅ Fix: header-tap Home should also reset ALL scroll positions.
  if (screens.home) screens.home.scrollTop = 0;
  try { window.scrollTo(0, 0); } catch {}
  try { document.documentElement.scrollTop = 0; } catch {}
  try { document.body.scrollTop = 0; } catch {}

  syncTabs();
  setHeader("RiffBank");
  render();
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

    const id = uid();
    await putAudioBlob({
      id,
      blob: file,
      name: file.name,
      type: file.type,
      size: file.size,
    });

    v.localAudioId = id;
    v.originalFileName = file.name || "";
    song.updatedAt = nowStamp();
    saveState();

    toast("Imported ✅");
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
// iOS slide-back animation
// ---------------------
function slideBackTransition(renderUnderneath) {
  const viewEl = $("#view");
  if (!viewEl) return renderUnderneath();

  const r = viewEl.getBoundingClientRect();
  const overlay = document.createElement("div");
  overlay.className = "viewSlideOverlay";
  overlay.style.top = `${r.top}px`;
  overlay.style.left = `${r.left}px`;
  overlay.style.width = `${r.width}px`;
  overlay.style.height = `${r.height}px`;

  overlay.innerHTML = viewEl.innerHTML;
  overlay.scrollTop = viewEl.scrollTop;

  document.body.appendChild(overlay);
  renderUnderneath();

  requestAnimationFrame(() => overlay.classList.add("out"));
  overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
}

function goBack({ animate = false } = {}) {
  const doRender = () => {
    if (drawerOpen) { closeDrawer(); return; }

    if (overlayView) {
      overlayView = null;
      currentTab = "home";
      drawerView = null;
      selectedSongId = null;
      songsView = "list";
      setHeader("RiffBank");
      syncTabs();
      render();
      return;
    }

    if (drawerView) {
      drawerView = null;
      setHeader(TAB_TITLES[currentTab] || "RiffBank");
      syncTabs();
      render();
      return;
    }

    // ✅ If you're in a version detail view, back goes to the song page
    if (selectedSongId && selectedVersionId) {
      selectedVersionId = null;
      currentTab = "songs";
      setHeader("Song");
      syncTabs();
      render();
      return;
    }

    if (selectedSongId) {
      selectedSongId = null;
      selectedVersionId = null;  // ← ADD: always clear this too
      currentTab = "songs";
      songsView = "list";
      drawerView = null;          // ← ADD: clear any drawer bleed
      overlayView = null;         // ← ADD: clear any overlay bleed
      setHeader("Songs");
      syncTabs();
      render();
      return;
    }

    if (currentTab === "songs" && songsView === "create") {
      songsView = "list";
      setHeader("Songs");
      syncTabs();
      render();
      return;
    }

    // If Songs list was opened from a drawer view (e.g. Projects -> View songs),
    // going back from the Songs list should return to that drawer view.
    if (
      currentTab === "songs" &&
      songsView === "list" &&
      !selectedSongId &&
      songsBackTarget
    ) {
      const target = songsBackTarget;
      songsBackTarget = null;

      overlayView = null;
      drawerView = target;     // ✅ back to Projects screen
      currentTab = "home";     // keep bottom nav unselected
      setHeader(TAB_TITLES[currentTab] || "RiffBank");
      syncTabs();
      render();
      return;
    }

    if (currentTab !== "home") {
      currentTab = "home";
      songsView = "list";
      selectedSongId = null;
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

document.addEventListener("touchstart", (e) => {
  const t = e.changedTouches?.[0];
  if (!t) return;

// Left-edge gesture
if (!drawerOpen && t.clientX <= 24) {
  // ← ADD THIS: disable swipe when fullscreen player is open
  if (playerScreen === "now" && currentTab === "player") return;
  
  touchTracking = true;
  const onHomeRoot = (currentTab === "home" && !drawerView && !overlayView);
  touchMode = onHomeRoot ? "open" : "back";
  touchStartX = t.clientX;
  touchStartY = t.clientY;
  return;
}

  // Drawer close gesture
  if (drawerOpen) {
    touchTracking = true;
    touchMode = "close";
    touchStartX = t.clientX;
    touchStartY = t.clientY;
  }
}, { passive: true });

document.addEventListener("touchmove", (e) => {
  if (!touchTracking) return;
  const t = e.changedTouches?.[0];
  if (!t) return;

  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;

  if (Math.abs(dx) <= 10 || Math.abs(dx) <= Math.abs(dy)) return;

  if (touchMode === "open" && dx >= 60) {
    openDrawer();
    touchTracking = false;
    touchMode = null;
  }

  if (touchMode === "back" && dx >= 60) {
    goBack({ animate: true });
    touchTracking = false;
    touchMode = null;
  }

  if (touchMode === "close" && dx <= -60) {
    closeDrawer();
    touchTracking = false;
    touchMode = null;
  }
}, { passive: true });

document.addEventListener("touchend", () => {
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

miniNextEl?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!advanceToNextTrack()) toast("Queue empty 😅");
});

miniPrevEl?.addEventListener("click", (e) => {
  e.stopPropagation();
  // simple behavior: restart track
  if (!globalAudio) return;
  globalAudio.currentTime = 0;
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

  // Ensure fullscreen overlay is fully closed + removed from hit testing
  try { closeNowPlaying(); } catch {}
  setFullPlayerOpen(false);

  saveState();
  syncMiniPlayerUI();
  scheduleDockSpaceSync();
}

// Swipe down on mini player = stop + reset + hide (tap-safe + center-safe)
miniPlayerEl?.addEventListener(
  "touchstart",
  (e) => {
    if (!miniPlayerEl) return;
    if (e.touches.length !== 1) return;

    const isControl = e.target.closest("#miniPrev, #miniToggle, #miniNext, #miniScrub");
    if (isControl) return;

    miniPlayerEl.dataset.dragStartY = String(e.touches[0].clientY);
    miniPlayerEl.dataset.dragDy = "0";
    miniPlayerEl.dataset.didDrag = "0";
  },
  { passive: true }
);

miniPlayerEl?.addEventListener(
  "touchmove",
  (e) => {
    if (!miniPlayerEl) return;

    const startY = parseFloat(miniPlayerEl.dataset.dragStartY || "NaN");
    if (!Number.isFinite(startY)) return;
    if (e.touches.length !== 1) return;

    let dy = e.touches[0].clientY - startY;
    if (dy < 0) dy = 0;

    const ACTIVATE_PX = 14;
    if (dy < ACTIVATE_PX) return;

    miniPlayerEl.dataset.didDrag = "1";
    miniPlayerEl.dataset.dragDy = String(dy);

    miniPlayerEl.style.transition = "none";
    // ✅ preserve centering
    miniPlayerEl.style.transform = `translateX(-50%) translateY(${Math.min(dy, 240)}px)`;
  },
  { passive: true }
);

miniPlayerEl?.addEventListener(
  "touchend",
  () => {
    if (!miniPlayerEl) return;

    const didDrag = miniPlayerEl.dataset.didDrag === "1";
    const dy = parseFloat(miniPlayerEl.dataset.dragDy || "0");

    delete miniPlayerEl.dataset.dragStartY;
    delete miniPlayerEl.dataset.dragDy;
    delete miniPlayerEl.dataset.didDrag;

    const CLOSE_PX = 90;

    // snap back always
    miniPlayerEl.style.transition = "transform 160ms ease";
    miniPlayerEl.style.transform = "translateX(-50%) translateY(0px)";

    if (didDrag && dy > CLOSE_PX) {
      // ✅ HARD STOP audio (iOS needs src cleared sometimes)
    if (dy > 80) {
      stopAndResetPlayback();     // ✅ the full reset you already wrote
      // syncMiniPlayerUI handles visibility
      return;
    }

      // ✅ Reset state to "fresh launch"
      state.player.nowPlaying = null;
      state.player.queue = [];
      hasPlayedThisSession = false;

      // ✅ Close fullscreen if it was open (now safe)
      try { closeNowPlaying(); } catch {}

      saveState();
      syncMiniPlayerUI();
      scheduleDockSpaceSync?.();
      render();
    }
  },
  { passive: true }
);

miniPlayerEl?.addEventListener("click", (e) => {
  const isControl = e.target.closest("#miniPrev, #miniToggle, #miniNext, #miniScrub");
  if (miniPlayerEl?.dataset?.suppressClick === "1") {
    delete miniPlayerEl.dataset.suppressClick;
    return;
  }
  if (isControl) return;
  if (!state.player?.nowPlaying) return;

  prevTabBeforeFullPlayer = currentTab;
  prevSelectedSongIdBeforeFullPlayer = selectedSongId;
  currentTab = "player";
  playerScreen = "now";

  // ← REPLACE openNowPlaying() with this:
  currentTab = "player";
  playerScreen = "now";
  setHeader("Now Playing");
  syncTabs();
  render();
});

miniScrubEl?.addEventListener("pointerdown", (e) => e.stopPropagation());
miniScrubEl?.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

globalAudio?.addEventListener("play", syncMiniPlayerUI);
globalAudio?.addEventListener("pause", syncMiniPlayerUI);
// Advance to the next track, respecting repeat (queue-level loop) and shuffle.
// Returns true if something will play, false if queue is truly empty.
function advanceToNextTrack({ render: doRender = false } = {}) {
  const q = state.player?.queue || [];
  if (q.length) {
    state.player.nowPlaying = q.shift();
    saveState();
    playNowPlaying({ autoplay: true });
    if (doRender) render();
    return true;
  }
  // Queue exhausted — rebuild from repeatQueue if repeat is on
  if (state.player?.repeat) {
    const rq = state.player?.repeatQueue || [];
    if (rq.length) {
      const fresh = state.player.shuffle ? shuffleArray([...rq]) : [...rq];
      state.player.nowPlaying = fresh.shift();
      state.player.queue = fresh;
      saveState();
      playNowPlaying({ autoplay: true });
      if (doRender) render();
      return true;
    }
  }
  return false;
}

globalAudio?.addEventListener("ended", () => {
  if (!advanceToNextTrack()) syncMiniPlayerUI();
});

// ---------------------
// Bottom sheet (GLOBAL)
// ---------------------
const sheet = $("#createSheet");
const sheetOverlay = $("#sheetOverlay");
const sheetContent = $("#sheetContent");
let sheetMode = "chooser"; // chooser | song | lyrics | songMenu | versionMenu | songFilters
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
    sheetContent.innerHTML = `
      <div class="sheetTitle">New song</div>

      <div class="sheetForm">
        <input id="sheetSongTitle" type="text" placeholder="Title (e.g. Internal)" />
        <input id="sheetSongProject" type="text" placeholder="Project" value="${escapeHtml(state.settings.defaultProject || "")}" />
        <input id="sheetSongGenre" type="text" placeholder="Genre" value="${escapeHtml(state.settings.defaultGenre || "")}" />
        <input id="sheetSongSprint" type="text" placeholder="Sprint" value="${escapeHtml(state.settings.defaultSprint || "")}" />
      </div>

      <div class="sheetActions">
        <button class="sheetBtn ghost" id="sheetBack">Back</button>
        <button class="sheetBtn primary" id="sheetCreateSong">Create</button>
      </div>
    `;

    $("#sheetBack")?.addEventListener("click", () => openSheet("chooser"));

    $("#sheetCreateSong")?.addEventListener("click", () => {
      const title = ($("#sheetSongTitle")?.value || "").trim();
      if (!title) return toast("Give it a title 🙂");

      const song = {
        id: uid(),
        title,
        project: ($("#sheetSongProject")?.value || "").trim() || "Project",
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

      state.songs.unshift(song);
      saveState();
      toast("Created 🎸");

      closeSheet();
      currentTab = "songs";
      songsView = "list";
      selectedSongId = song.id;
      setHeader("Song");
      syncTabs();
      render();
    });

    setTimeout(() => $("#sheetSongTitle")?.focus(), 0);
    return;
  }

  if (sheetMode === "lyrics") {
    const value = state.settings.lyricsScratch || "";
    sheetContent.innerHTML = `
      <div class="sheetTitle">New lyrics</div>

      <div class="sheetForm">
        <textarea id="sheetLyrics" placeholder="Write lyric ideas...">${escapeTextarea(value)}</textarea>
      </div>

      <div class="sheetActions">
        <button class="sheetBtn ghost" id="sheetBack">Back</button>
        <button class="sheetBtn primary" id="sheetSaveLyrics">Save</button>
      </div>
    `;

    $("#sheetBack")?.addEventListener("click", () => openSheet("chooser"));
    $("#sheetSaveLyrics")?.addEventListener("click", () => {
      state.settings.lyricsScratch = $("#sheetLyrics")?.value || "";
      saveState();
      toast("Lyrics saved ✍️");
      closeSheet();
    });

    setTimeout(() => $("#sheetLyrics")?.focus(), 0);
  }

    if (sheetMode === "songMenu") {
    const song = getSong(sheetSongMenuId);
    const title = song?.title || "Song";

    sheetContent.innerHTML = `
      <div class="sheetTitle">${escapeHtml(title)}</div>

      <div class="sheetForm" style="gap:10px">
        <button class="sheetChoice" id="songMenuOpen">Open song</button>
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
      currentTab = "songs";
      songsView = "list";
      selectedSongId = song.id;
      setHeader("Song");
      syncTabs();
      render();
    });

    $("#songMenuDelete")?.addEventListener("click", () => {
      if (!song) return closeSheet();
      if (!confirm(`Delete "${song.title}"?`)) return;
      state.songs = state.songs.filter(s => s.id !== song.id);
      saveState();
      toast("Deleted 🗑️");
      closeSheet();
      currentTab = "songs";
      songsView = "list";
      selectedSongId = null;
      setHeader("Songs");
      syncTabs();
      render();
    });

    $("#songMenuCancel")?.addEventListener("click", () => {
      closeSheet();
    });

    return;
  }

      if (sheetMode === "songFilters") {
    // Build project list from settings + songs
    const projects = Array.from(
      new Set([
        ...(state.settings?.defaultProject ? [state.settings.defaultProject.trim()] : []),
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

    const playable = !!(v.link || v.fileId || v.localAudioId || v.driveFileId);

    sheetContent.innerHTML = `
      <div class="sheetTitle">${escapeHtml(song.title)}</div>
      <div class="small" style="margin-top:-6px; opacity:.75">${escapeHtml(v.label || "Version")}</div>

      <div class="sheetForm" style="gap:10px; margin-top:12px">
        <button class="sheetChoice" id="vmPlay" ${playable ? "" : "disabled"}>Play</button>
        <button class="sheetChoice" id="vmQueue" ${playable ? "" : "disabled"}>Add to Queue</button>
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
        <button class="sheetChoice" id="pmSetDefault" ${isDefault ? "disabled" : ""}>${isDefault ? "Default ✅" : "Set as default"}</button>
        <button class="sheetChoice" id="pmCancel">Cancel</button>
      </div>
    `;
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
      alert("That file doesn't look like a RiffBank backup.");
      return;
    }

    if (!confirm("Import will replace your current data on this device. Continue?")) return;

    state = incoming;
    normalizeState();
    saveState();
    toast("Imported ✅");
    render();
  } catch {
    alert("Could not parse that JSON file.");
  } finally {
    if (input) input.value = "";
  }
});

// ---------------------
// Render router
// ---------------------
function render() {
  if (!view) return;

  syncTabs();

    // ✅ Enforce fullscreen player state every render (no overlap, no reserved padding)
  setFullPlayerOpen(!!fullPlayerOpen);

  document.body.classList.toggle(
    "isHome",
    currentTab === "home" && !drawerView && !overlayView && !selectedSongId && !selectedVersionId
  );

  // Drawer screens
  if (drawerView === "projects") { setActiveScreen("drawer"); return projectDetailScreen ? renderProjectSongs(projectDetailScreen) : renderProjects(); }
  if (drawerView === "eps") { setActiveScreen("drawer"); return renderEPs(); }
  if (drawerView === "collabs") { setActiveScreen("drawer"); return renderCollaborators(); }
  if (drawerView === "importExport") { setActiveScreen("drawer"); return renderImportExport(); }
  if (drawerView === "about") { setActiveScreen("drawer"); return renderAbout(); }

  // Normal screens
  if (currentTab === "home") { setActiveScreen("home"); return renderHome(); }
  if (currentTab === "songs") {
    setActiveScreen("songs");
    if (selectedSongId && selectedVersionId) return renderVersionDetail(selectedSongId, selectedVersionId);
    if (selectedSongId) return renderSongDetail(selectedSongId);
    if (songsView === "create") return renderSongCreate();
    return renderSongsList();
  }
  if (currentTab === "player") {
    setActiveScreen("player");
    if (playerScreen === "now") return renderNowPlaying();
    return renderPlayer();
  }
  if (currentTab === "settings") { setActiveScreen("settings"); return renderSettings(); }
}

scheduleDockSpaceSync();

// Pre-fetch the active version's Drive audio for every song so first play is instant.
// Runs in the background after init — caches blobs in IndexedDB keyed by driveFileId.
async function preFetchDriveAudio() {
  // Only run when a token is already in memory — never triggers a sign-in popup
  if (!gdriveIsConnected() || !gdriveHasValidToken()) return;
  for (const song of (state.songs || [])) {
    const av = (song.versions || []).find(v => v.isActive) || song.versions?.[0];
    if (!av?.driveFileId || av.fileId) continue; // no Drive file, or local copy already exists
    const dbKey = `gdrive:${av.driveFileId}`;
    const existing = await audioGet(dbKey);
    if (existing?.blob) continue; // already cached
    const blob = await gdriveFetchBlob(av.driveFileId);
    if (blob) {
      await putAudioBlob({
        id: dbKey,
        blob,
        name: av.fileName || av.label || "audio",
        type: av.fileType || blob.type || "audio/*",
        size: blob.size,
      });
    }
  }
}

async function init() {
  if (!DISABLE_SPLASH) {
    await runSplashSequence();
  } else {
    const splash = document.getElementById("splash");
    if (splash) splash.remove();
  }

  // Auto-seed disabled — use Drive sync or manual import instead
  // const seeded = await seedDefaultLibraryIfNeeded({ force: false });
  // if (seeded) toast("Seeded library 🎧");

  // Load Google Identity Services (non-blocking, for Drive integration)
  gdriveLoadGIS();

  // Try to pull latest state from Drive (if connected + token still valid)
  if (gdriveIsConnected()) {
    try {
      const driveState = await gdrivePullStateSilent();      if (driveState && driveState.songs) {
        // Compare: use Drive state if it has songs and local doesn't,
        // or if Drive has a newer updatedAt on any song
        const localHasSongs = state.songs && state.songs.length > 0;
        const driveHasSongs = driveState.songs && driveState.songs.length > 0;

        let useDrive = false;

        if (driveHasSongs && !localHasSongs) {
          // Local is empty, Drive has data — use Drive
          useDrive = true;
        } else if (driveHasSongs && localHasSongs) {
          // Both have data — compare most recent updatedAt
          const localNewest = Math.max(...state.songs.map(s => new Date(s.updatedAt || 0).getTime()));
          const driveNewest = Math.max(...driveState.songs.map(s => new Date(s.updatedAt || 0).getTime()));
          if (driveNewest > localNewest) useDrive = true;
        }

        if (useDrive) {
          state = driveState;
          normalizeState();
          localStorage.setItem(LS_KEY, JSON.stringify(state));
          toast("Synced from Drive ☁️");
        }
      }
    } catch (err) {
      console.warn("RiffBank: Drive state pull failed on init", err);
    }
  }

  setHeader("RiffBank");
  syncTabs();
  render();
  syncMiniPlayerUI();

  // Background: pre-fetch Drive audio so first play is instant (non-blocking)
  if (gdriveIsConnected()) {
    preFetchDriveAudio().catch(console.warn);
  }
}

// ES modules run after DOM is parsed, so DOMContentLoaded may already be gone
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", init);
} else {
  init(); // DOM already ready by the time the module ran
}

// ---------------------
// Drawer views
// ---------------------
function renderProjects() {
  setHeader("Projects");

  const projects = Array.from(
    new Set([
      ...(state.settings?.defaultProject ? [state.settings.defaultProject.trim()] : []),
      ...state.songs.map(s => (s.project || "").trim()).filter(Boolean)
    ])
  ).sort((a, b) => a.localeCompare(b));

  const rows = projects.map(p => {
    const count = state.songs.filter(s => (s.project || "").trim() === p).length;
    const isDefault = (state.settings.defaultProject || "").trim() === p;
    const fakeSong = { id: p, title: p, project: p, genre: "" };
    return `
      <div class="songRow" data-open-proj="${escapeHtml(p)}">
        <div class="songThumb" aria-hidden="true">
          ${coverSvg(fakeSong, { lite: true })}
        </div>
        <div class="songMain">
          <div class="songTop">
            <div class="songTitleRow">
              <div class="songTitle">${escapeHtml(p)}</div>
              <div class="songPills">
                ${isDefault ? `<span class="pill good">Default</span>` : ""}
              </div>
            </div>
            <button class="songMore" data-proj-more="${escapeHtml(p)}" aria-label="Project menu">⋯</button>
          </div>
          <div class="songSub">${count} song${count === 1 ? "" : "s"}</div>
        </div>
      </div>
    `;
  }).join("");

  activeScreenEl.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between; align-items:center">
        <h2>Projects</h2>
        <button id="closeDrawerView" class="ghost">Close</button>
      </div>

      <div class="hr"></div>

      <h2>New project</h2>
      <div class="row">
        <div class="col">
          <div class="label">Name</div>
          <input id="newProjName" type="text" placeholder="e.g. SkeletonDanceParty" />
        </div>
        <div class="col" style="display:flex; align-items:flex-end; gap:10px">
          <button id="createProj" class="btn primary">Create</button>
        </div>
      </div>

      <div class="hr"></div>

      <h2>All projects (${projects.length})</h2>
      <div id="projList">
        ${rows || `<div class="small">No projects yet. Create one above.</div>`}
      </div>
    </div>
  `;

  $("#closeDrawerView").addEventListener("click", () => {
    drawerView = null;
    setHeader(TAB_TITLES[currentTab] || "RiffBank");
    render();
  });

  $("#createProj").addEventListener("click", () => {
    const name = ($("#newProjName").value || "").trim();
    if (!name) return toast("Give it a name 🙂");
    state.settings.defaultProject = name;
    saveState();
    toast("Project added ✅");
    renderProjects();
  });

  activeScreenEl.querySelectorAll("[data-open-proj]").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-proj-more]")) return;
      projectDetailScreen = row.getAttribute("data-open-proj");
      render();
    });
  });

  activeScreenEl.querySelectorAll("[data-proj-more]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openProjectMenu(btn.getAttribute("data-proj-more"));
    });
  });
}

function renderProjectSongs(projectName) {
  setHeader(projectName);

  const songs = state.songs.filter(s => (s.project || "").trim() === projectName);

  const items = songs
    .filter(s => (s.versions || []).length)
    .map(s => {
      const vv = s.versions.find(v => v.isActive) || s.versions[0];
      return { songId: s.id, versionId: vv.id };
    });

  const rows = songs.map(s => {
    const vCount = (s.versions || []).length;
    const updated = s.updatedAt ? timeAgo(s.updatedAt) : "—";
    return `
      <div class="songRow" data-open-song="${s.id}">
        <div class="songThumb" aria-hidden="true">
          ${coverSvg(s, { lite: true })}
          <div class="songDur">—:—</div>
        </div>
        <div class="songMain">
          <div class="songTop">
            <div class="songTitleRow">
              <div class="songTitle">${escapeHtml(s.title || "Untitled")}</div>
            </div>
          </div>
          <div class="songSub">${escapeHtml(s.genre || "—")}</div>
          <div class="songMetaRow">
            <span>🎧 ${vCount}</span>
            <span class="sep">•</span>
            <span>🕒 ${escapeHtml(updated)}</span>
          </div>
        </div>
      </div>
    `;
  }).join("");

  activeScreenEl.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between; align-items:center">
        <button id="projBack" class="ghost">← Back</button>
        <button id="closeDrawerView" class="ghost">Close</button>
      </div>
      <h2>${escapeHtml(projectName)}</h2>
      <div class="meta">${songs.length} song${songs.length === 1 ? "" : "s"}</div>
      <div class="hr"></div>
      <div class="row" style="gap:8px; margin-bottom:12px">
        <button id="projPlayAll" class="btn primary" ${!items.length ? "disabled" : ""}>▶ Play All</button>
        <button id="projShuffle" class="btn" ${!items.length ? "disabled" : ""}>⇄ Shuffle</button>
      </div>
      <div id="projSongList">
        ${rows || `<div class="small">No songs in this project yet.</div>`}
      </div>
    </div>
  `;

  $("#projBack").addEventListener("click", () => {
    projectDetailScreen = null;
    render();
  });

  $("#closeDrawerView").addEventListener("click", () => {
    projectDetailScreen = null;
    drawerView = null;
    setHeader(TAB_TITLES[currentTab] || "RiffBank");
    render();
  });

  $("#projPlayAll")?.addEventListener("click", async () => {
    if (!items.length) return toast("No playable songs 😅");
    const all = [...items];
    state.player.nowPlaying = all[0];
    state.player.queue = all.slice(1);
    state.player.repeatQueue = all;
    saveState();
    await playNowPlaying({ autoplay: true });
    toast("Playing ▶️");
  });

  $("#projShuffle")?.addEventListener("click", async () => {
    if (!items.length) return toast("No playable songs 😅");
    const all = shuffleArray([...items]);
    state.player.nowPlaying = all[0];
    state.player.queue = all.slice(1);
    state.player.repeatQueue = all;
    saveState();
    await playNowPlaying({ autoplay: true });
    toast("Shuffled ▶️");
  });

  activeScreenEl.querySelectorAll("[data-open-song]").forEach(row => {
    row.addEventListener("click", () => {
      const sid = row.getAttribute("data-open-song");
      projectDetailScreen = null;
      drawerView = null;
      currentTab = "songs";
      songsView = "detail";
      selectedSongId = sid;
      selectedVersionId = null;
      setHeader("Song");
      render();
    });
  });
}

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
    drawerView = null;
    setHeader(TAB_TITLES[currentTab] || "RiffBank");
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
      <div class="small">Pulled from song “Collaborators” field (comma-separated).</div>
      <div class="hr"></div>

      <div class="list">
        ${rows || `<div class="small">No collaborators yet. Add names like "Darian, Mason".</div>`}
      </div>
    </div>
  `;

  $("#closeDrawerView").addEventListener("click", () => {
    drawerView = null;
    setHeader(TAB_TITLES[currentTab] || "RiffBank");
    render();
  });

  activeScreenEl.querySelectorAll("[data-filter-collab]").forEach(btn => {
    btn.addEventListener("click", () => {
      const name = btn.getAttribute("data-filter-collab");
      drawerView = null;
      currentTab = "songs";
      songsView = "list";
      selectedSongId = null;
      setHeader("Songs");
      syncTabs();
      renderSongsList();
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
    drawerView = null;
    setHeader(TAB_TITLES[currentTab] || "RiffBank");
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
    drawerView = null;
    setHeader(TAB_TITLES[currentTab] || "RiffBank");
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
function renderHome() {
  overlayView = null;
  currentTab = "home";
  setHeader("RiffBank");
  

  const songCount = state.songs.length;

  activeScreenEl.innerHTML = `
    <div class="homeReleaf">
      <div class="homeGridReleaf">
        <button class="homeCard" data-home="songs" aria-label="Songs">
          ${iconBookmark()}
          <div class="cardText">${songCount} song${songCount === 1 ? "" : "s"}</div>
          <div class="cardSub">library</div>
        </button>

        <button class="homeCard" data-home="projects" aria-label="Projects">
          ${iconChart()}
          <div class="cardText">projects</div>
          <div class="cardSub">organize</div>
        </button>

        <button class="homeCard" data-home="browse" aria-label="Browse">
          ${iconBulb()}
          <div class="cardText">browse</div>
          <div class="cardSub">search</div>
        </button>

        <button class="homeCard" data-home="lyrics" aria-label="Lyrics">
          ${iconPlus()}
          <div class="cardText">lyrics</div>
          <div class="cardSub">scratchpad</div>
        </button>

        <button class="homeCard homeCardWide" data-home="next" aria-label="Next Actions">
          ${iconPeople()}
          <div class="cardText">next actions</div>
          <div class="cardSub">finish songs</div>
        </button>
      </div>
    </div>
  `;

  activeScreenEl.querySelectorAll("[data-home]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-home");
      if (target === "songs") {
        resetSongsFilters({ keepSort: true }); // ✅ clear filters when opening Songs fresh
        songsBackTarget = null;               // optional: prevents weird “back target” reuse

        currentTab = "songs";
        songsView = "list";
        selectedSongId = null;
        setHeader("Songs");
        syncTabs();
        render();
        return;
      }
      if (target === "projects") return setDrawerView("projects");
      if (target === "browse") {
        resetSongsFilters({ keepSort: true }); // ✅ browse starts clean too
        songsBackTarget = null;

        currentTab = "songs";
        songsView = "list";
        selectedSongId = null;
        setHeader("Songs");
        syncTabs();
        render();
        setTimeout(() => $("#q")?.focus(), 0);
        return;
      }
      if (target === "lyrics") return renderLyricsScratch();
      if (target === "next") return renderNextActions();
    });
  });
}

// Icons
function iconBookmark(){
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 3h12v18l-6-4-6 4V3z"></path>
  </svg>`;
}
function iconChart(){
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 17l6-6 4 4 7-7"></path>
    <path d="M14 8h6v6"></path>
  </svg>`;
}
function iconBulb(){
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 18h6"></path>
    <path d="M10 22h4"></path>
    <path d="M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 3H9c0-1 0-2-1-3z"></path>
  </svg>`;
}
function iconPlus(){
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 5v14"></path>
    <path d="M5 12h14"></path>
  </svg>`;
}
function iconPeople(){
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M16 11a4 4 0 1 0-8 0"></path>
    <path d="M2 21c1.5-4 6-6 10-6s8.5 2 10 6"></path>
    <path d="M8 9a3 3 0 1 1 0-6"></path>
    <path d="M16 3a3 3 0 1 1 0 6"></path>
  </svg>`;
}

// Lyrics scratch
function renderLyricsScratch() {
  overlayView = "lyrics";
  setHeader("Lyrics");
  const value = state.settings.lyricsScratch || "";
  activeScreenEl.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between; align-items:center">
        <h2>Lyrics scratch</h2>
        <button id="closeLyrics" class="ghost">Close</button>
      </div>
      <textarea id="lyricsScratch" placeholder="Capture lyric ideas...">${escapeTextarea(value)}</textarea>
      <div class="row" style="margin-top:10px">
        <button id="saveLyricsScratch" class="btn primary">Save</button>
      </div>
    </div>
  `;
  $("#closeLyrics")?.addEventListener("click", () => {
    overlayView = null;
    currentTab = "home";
    setHeader("RiffBank");
    renderHome();
  });
  $("#saveLyricsScratch")?.addEventListener("click", () => {
    state.settings.lyricsScratch = $("#lyricsScratch").value;
    saveState();
    toast("Lyrics saved ✍️");
  });
}

function renderNextActions() {
  overlayView = "next";
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
    overlayView = null;
    currentTab = "home";
    setHeader("RiffBank");
    renderHome();
  });
  activeScreenEl.querySelectorAll("[data-open-song]").forEach((el) =>
    el.addEventListener("click", () => {
      currentTab = "songs";
      selectedSongId = el.getAttribute("data-open-song");
      setHeader("Song");
      render();
    })
  );
}

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function hashStr(str){
  str = String(str || "");
  let h = 2166136261;
  for (let i=0;i<str.length;i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}

function makeRng(seed){
  let t = seed >>> 0;
  return () => {
    // xorshift32
    t ^= t << 13; t >>>= 0;
    t ^= t >> 17; t >>>= 0;
    t ^= t << 5;  t >>>= 0;
    return (t >>> 0) / 4294967296;
  };
}

// --- Cover caching + iOS "lite" mode ---
const coverCache = new Map();

function isIOSDevice(){
  // iPadOS can report as MacIntel with touch points
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function coverSvg(song, { lite = false } = {}) {
  const forceLite = lite || isIOSDevice();
  const key = `${song.id}|${song.title}|${song.project}|${song.genre}|${forceLite ? "lite" : "full"}`;

  if (coverCache.has(key)) return coverCache.get(key);

  const seed = hashStr(`${song.id}|${song.title}|${song.project}|${song.genre}`);
  const r = makeRng(seed);

  const h1 = Math.floor(r()*360);
  const h2 = (h1 + 90 + Math.floor(r()*90)) % 360;
  const h3 = (h2 + 90 + Math.floor(r()*90)) % 360;

  const c1 = `hsl(${h1} 95% 60%)`;
  const c2 = `hsl(${h2} 95% 58%)`;
  const c3 = `hsl(${h3} 95% 62%)`;

  const b = Array.from({length: 3}).map(() => ({
    x: Math.floor(r()*120),
    y: Math.floor(r()*120),
    rad: Math.floor(40 + r()*55),
    col: [c1,c2,c3][Math.floor(r()*3)]
  }));

  const sx1 = Math.floor(r()*40);
  const sy1 = Math.floor(30 + r()*60);
  const sx2 = Math.floor(90 + r()*40);
  const sy2 = Math.floor(20 + r()*80);

  // LITE: no turbulence/grain, no SVG filter stack (huge iOS win)
  const svg = forceLite ? `
  <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${c1}" stop-opacity=".95"/>
        <stop offset=".55" stop-color="${c2}" stop-opacity=".85"/>
        <stop offset="1" stop-color="${c3}" stop-opacity=".9"/>
      </linearGradient>
      <radialGradient id="vig" cx="50%" cy="45%" r="70%">
        <stop offset="55%" stop-color="rgba(0,0,0,0)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,.28)"/>
      </radialGradient>
    </defs>

    <rect width="120" height="120" fill="url(#g)"/>
    ${b.map(x => `<circle cx="${x.x}" cy="${x.y}" r="${x.rad}" fill="${x.col}" opacity=".22"/>`).join("")}

    <path d="M ${sx1} ${sy1} C ${sx1+35} ${sy1-30}, ${sx2-35} ${sy2+30}, ${sx2} ${sy2}"
      stroke="rgba(255,255,255,.55)" stroke-width="5" stroke-linecap="round" opacity=".18"/>

    <rect width="120" height="120" fill="url(#vig)"/>
  </svg>` : `
  <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${c1}" stop-opacity=".95"/>
        <stop offset=".55" stop-color="${c2}" stop-opacity=".85"/>
        <stop offset="1" stop-color="${c3}" stop-opacity=".9"/>
      </linearGradient>

      <filter id="blur">
        <feGaussianBlur stdDeviation="12" />
      </filter>

      <filter id="grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
        <feColorMatrix type="matrix" values="
          1 0 0 0 0
          0 1 0 0 0
          0 0 1 0 0
          0 0 0 .12 0"/>
      </filter>

      <filter id="glow">
        <feGaussianBlur stdDeviation="3" result="b"/>
        <feMerge>
          <feMergeNode in="b"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>

      <radialGradient id="vig" cx="50%" cy="45%" r="70%">
        <stop offset="55%" stop-color="rgba(0,0,0,0)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,.35)"/>
      </radialGradient>
    </defs>

    <rect width="120" height="120" fill="url(#g)"/>

    <g filter="url(#blur)" opacity=".9">
      ${b.map(x => `<circle cx="${x.x}" cy="${x.y}" r="${x.rad}" fill="${x.col}" opacity=".55"/>`).join("")}
    </g>

    <path d="M ${sx1} ${sy1} C ${sx1+35} ${sy1-30}, ${sx2-35} ${sy2+30}, ${sx2} ${sy2}"
      stroke="rgba(255,255,255,.65)" stroke-width="6" stroke-linecap="round" opacity=".22" filter="url(#glow)"/>

    <rect width="120" height="120" fill="url(#vig)"/>
    <rect width="120" height="120" filter="url(#grain)" opacity=".55"/>
  </svg>`;

  coverCache.set(key, svg);
  return svg;
}

function parseStamp(stamp){
  // "YYYY-MM-DD HHMM"
  if (!stamp) return null;
  const [d, hm] = String(stamp).split(" ");
  if (!d || !hm || hm.length < 4) return null;
  const [yyyy, mm, dd] = d.split("-").map(Number);
  const hh = Number(hm.slice(0,2));
  const mi = Number(hm.slice(2,4));
  if (!yyyy || !mm || !dd) return null;
  return new Date(yyyy, mm-1, dd, hh, mi, 0, 0);
}

function timeAgo(stamp){
  const dt = parseStamp(stamp);
  if (!dt) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - dt.getTime()) / 1000));
  const min = Math.floor(sec/60);
  const hr = Math.floor(min/60);
  const day = Math.floor(hr/24);
  if (day >= 1) return `${day}d`;
  if (hr >= 1) return `${hr}h`;
  if (min >= 1) return `${min}m`;
  return "now";
}

function shortBestLabel(song){
  const bv = bestVersion(song);
  if (!bv?.label) return "—";
  const m = bv.label.match(/\bv(\d+(\.\d+)?)\b/i);
  if (m) return `v${m[1]}`;
  return "Best";
}

// ---------------------
// Songs list + create
// ---------------------
function renderSongsList() {
  setHeader("Songs");

  const songs = [...state.songs];
  const projects = Array.from(
    new Set([
      ...(state.settings?.defaultProject ? [state.settings.defaultProject.trim()] : []),
      ...state.songs.map((s) => (s.project || "").trim()).filter(Boolean),
    ])
  ).sort((a, b) => a.localeCompare(b));

  activeScreenEl.innerHTML = `
    <div class="songsHead">
      <div class="songsBar">
        <input
          id="q"
          type="text"
          placeholder="Search songs..."
          value="${escapeHtml(songsListState.query)}"
        />
        <button class="filterBtn" id="openSongFilters" aria-label="Filters">
          ${iconFilter()}
        </button>
      </div>
    </div>

    <div id="songList" class="songsList"></div>
    <div class="small">Tip: use the center “New record” button to create.</div>
  `;

  const listEl = $("#songList");

  const applyFilter = () => {
    const qValue = $("#q")?.value || "";
    const q = qValue.toLowerCase();

    // filters now come from state (set by the filter sheet)
    const sf = songsListState.statusFilter || "";
    const pf = songsListState.projectFilter || "";

    songsListState.query = qValue;

    const filtered = songs
      .filter((s) => {
        const hay = `${s.title} ${s.project} ${s.genre} ${s.sprint} ${s.instrumentation} ${s.collaborators} ${s.vibes} ${s.lyrics} ${s.notes}`.toLowerCase();
        const qOk = !q || hay.includes(q);
        const sOk = !sf || s.status === sf;
        const pOk = !pf || (s.project || "").trim() === pf;
        return qOk && sOk && pOk;
      })
      .sort((a, b) => {
        if (songsListState.sortMode === "title") return (a.title || "").localeCompare(b.title || "");
        if (songsListState.sortMode === "status") {
          const statusSort = (a.status || "").localeCompare(b.status || "");
          if (statusSort !== 0) return statusSort;
          return (b.updatedAt || "").localeCompare(a.updatedAt || "");
        }
        return (b.updatedAt || "").localeCompare(a.updatedAt || "");
      });

    listEl.innerHTML = filtered.length
      ? filtered.map((s) => {
                    const vCount = s.versions?.length || 0;
          const bestLbl = shortBestLabel(s);
          const updated = timeAgo(s.updatedAt || s.createdAt);

          const statusPill =
            (s.status || "").toLowerCase() === "done" || (s.status || "").toLowerCase() === "released"
              ? `pill good`
              : (s.status || "").toLowerCase() === "mix" || (s.status || "").toLowerCase() === "master" || (s.status || "").toLowerCase() === "ready"
              ? `pill warn`
              : `pill`;

          const stuckPill =
            s.stuckState === "Stuck" ? `pill bad`
            : s.stuckState === "Parked" ? `pill warn`
            : `pill`;

          const sub = `${s.genre || "—"} • ${(s.vibes || "").trim() ? (s.vibes || "").trim() : (s.nextAction || "").trim() ? `Next: ${s.nextAction}` : (s.project || "")}`.trim();

          return `
            <div class="songRow" data-id="${s.id}">
              <div class="songThumb" aria-hidden="true">
                ${coverSvg(s, { lite: true })}
                <div class="songDur">—:—</div>
              </div>

              <div class="songMain">
                <div class="songTop">
                  <div class="songTitleRow">
                    <div class="songTitle">${escapeHtml(s.title)}</div>
                    <div class="songPills">
                      <span class="${statusPill}">${escapeHtml(s.status || "Idea")}</span>
                      <span class="${stuckPill}">${escapeHtml(s.stuckState || "Active")}</span>
                    </div>
                  </div>

                  <button class="songMore" data-more="${s.id}" aria-label="Song menu">⋯</button>
                </div>

                <div class="songSub">${escapeHtml(sub)}</div>

                <div class="songMetaRow">
                  <span>🎧 ${vCount}</span>
                  <span class="sep">•</span>
                  <span>⭐ ${escapeHtml(bestLbl)}</span>
                  <span class="sep">•</span>
                  <span>🕒 ${escapeHtml(updated)}</span>
                </div>
              </div>
            </div>
          `;
        }).join("")
      : `<div class="small">No matches.</div>`;

    listEl.querySelectorAll("[data-id]").forEach((el) => {
      el.addEventListener("click", () => {
        selectedSongId = el.getAttribute("data-id");
        setHeader("Song");
        render();
      });
    });

        listEl.querySelectorAll("[data-more]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-more");
        if (id) openSongMenu(id);
      });
    });
  };

  $("#q").addEventListener("input", applyFilter);

  $("#openSongFilters")?.addEventListener("click", openSongFilters);

  applyFilter();
}

function renderSongCreate() {
  setHeader("Upload Song");
  activeScreenEl.innerHTML = `
    <div class="card">
      <h2>Upload Song</h2>
      <div class="small">Use the center New Record button instead — this screen is legacy.</div>
    </div>
  `;
}

function iconFilter(){
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 6h16"></path>
    <path d="M7 12h10"></path>
    <path d="M10 18h4"></path>
  </svg>`;
}

// ---------------------
// Song detail
// ---------------------
function renderSongDetail(id) {
  const song = getSong(id);
  if (!song) {
    selectedSongId = null;
    selectedVersionId = null;
    return renderSongsList();
  }

  setHeader("Song");

    // ✅ Fix: entering Song detail should not inherit Songs list scroll position
  if (activeScreenEl) activeScreenEl.scrollTop = 0;
  try { window.scrollTo(0, 0); } catch {}
  try { document.documentElement.scrollTop = 0; } catch {}
  try { document.body.scrollTop = 0; } catch {}
  requestAnimationFrame(() => { if (screens.home) screens.home.scrollTop = 0; });

  const fv = featuredVersion(song);
  const vCount = song.versions?.length || 0;

  // hero cover uses your neon generator
  const heroCover = coverSvg(song);
  const rowCover  = coverSvg(song, { lite: true }); // always lite for version rows

  const featuredTag = fv?.isBest ? "⭐ Best" : fv?.isActive ? "🎧 Active" : "Featured";
  const featuredSub = fv
    ? `${escapeHtml(fv.label || "Version")} ${fv.notes ? `• ${escapeHtml(fv.notes)}` : ""}`
    : "No versions yet — add one below";

activeScreenEl.innerHTML = `
  <div class="albumHero">
    <button class="songHeroBack" id="songHeroBack" aria-label="Back">←</button>

    <div class="albumBg" aria-hidden="true">
      ${heroCover}
    </div>

    <div class="albumTop">
      <div class="albumArt" aria-hidden="true">
        ${heroCover}
      </div>

      <div class="albumText">
        <div class="albumTitle">${escapeHtml(song.title)}</div>
        <div class="albumMeta">
          ${escapeHtml(song.project || "—")} • ${escapeHtml(song.genre || "—")} •
          ${vCount} version${vCount===1?"":"s"}
        </div>
      </div>
    </div>

    <div class="albumActions">
      <button class="songHeroPlay" id="songBigPlay" ${(fv?.link || fv?.fileId || fv?.localAudioId || fv?.driveFileId) ? "" : "disabled"}>
        ▶ Play
      </button>
      <button class="songHeroQueue" id="songBigQueue" ${(fv?.link || fv?.fileId || fv?.localAudioId || fv?.driveFileId) ? "" : "disabled"}>
        + Queue
      </button>
      <button class="songHeroDetails" id="songDetailsBtn">
        Details
      </button>
    </div>
  </div>

  <div class="versionsWrap">
    <div class="versionsHeader">
      <div class="versionsTitle">Versions</div>
      <div class="versionsHeaderRight">
        <button class="btn" id="addVersionJump">Add version</button>
      </div>
    </div>

    <div id="versionsRows" class="versionsRows"></div>
  </div>
`;

  $("#songHeroBack")?.addEventListener("click", () => goBack({ animate: true }));

  $("#songBigPlay")?.addEventListener("click", () => {
    if (!(fv?.link || fv?.fileId || fv?.localAudioId || fv?.driveFileId)) return toast("No playable audio yet 😅");
    playVersion(song.id, fv.id, { goPlayer: false });
  });

  $("#songBigQueue")?.addEventListener("click", () => {
    if (!(fv?.link || fv?.fileId || fv?.localAudioId || fv?.driveFileId)) return toast("No playable audio yet 😅");
    addToQueue(song.id, fv.id);
  });

  // For now, keep your existing “Details” as the old long form screen:
  // We’ll implement it as: details = version detail of the featured? or a new view later.
  // For today: send you to the existing song form by reusing your old renderSongDetail UI? (we replaced it)
  // So: we’ll open the featured version detail as “Details” as a first step.
$("#songDetailsBtn")?.addEventListener("click", () => {
  // If no versions yet, create the first one and open it
  if (!fv) {
    const first = createVersion(song);
    if (!first) return toast("Couldn’t create version 😅");
    selectedVersionId = first.id;
    render();
    return;
  }

  selectedVersionId = fv.id;
  render();
});

$("#addVersionJump")?.addEventListener("click", () => {
  // Always create a brand new version (even if versions already exist)
  const newV = createVersion(song);
  if (!newV) return toast("Couldn’t create version 😅");
  selectedVersionId = newV.id;
  render();
});

  // Render version rows
  const rowsEl = $("#versionsRows");
  const versions = (song.versions || []).slice();

  rowsEl.innerHTML = versions.length
    ? versions.map((v) => {
        const sub = `${escapeHtml(v.createdAt || "")}${v.notes ? ` • ${escapeHtml(v.notes)}` : ""}`;
        const activeOverlay = v.isActive
          ? `<div class="vThumbCheck"><svg viewBox="0 0 20 20" fill="none" width="16" height="16"><path d="M3.5 10.5l4.5 4.5 8.5-9" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`
          : "";

        return `
          <div class="vRow" data-vrow="${v.id}">
            <div class="vThumb ${v.isActive ? "is-active" : ""}" data-vactive="${v.id}" role="button" aria-label="Set active">${rowCover}${activeOverlay}</div>

            <div class="vMain">
              <div class="vTop">
                <div class="vTitle">${escapeHtml(v.label || "Version")}</div>
              </div>
              <div class="vSub">${sub}</div>
            </div>

            <button class="vMore" data-vmore="${v.id}" aria-label="Version menu">⋯</button>
          </div>
        `;
      }).join("")
    : `<div class="small" style="padding:12px 2px">No versions yet. Add one from Details.</div>`;

  rowsEl.querySelectorAll("[data-vrow]").forEach((row) => {
    row.addEventListener("click", () => {
      selectedVersionId = row.getAttribute("data-vrow");
      render();
    });
  });

  rowsEl.querySelectorAll("[data-vactive]").forEach((thumb) => {
    thumb.addEventListener("click", (e) => {
      e.stopPropagation();
      const vid = thumb.getAttribute("data-vactive");
      song.versions.forEach(vv => { vv.isActive = vv.id === vid; });
      song.updatedAt = nowStamp();
      saveState();
      render();
    });
  });

  rowsEl.querySelectorAll("[data-vmore]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const vid = btn.getAttribute("data-vmore");
      openVersionMenu(song.id, vid);
    });
  });
}

function renderVersionDetail(songId, versionId) {
  const song = getSong(songId);
  const v = getVersion(song, versionId);

  if (!song || !v) {
    selectedVersionId = null;
    return renderSongDetail(songId);
  }

  setHeader("Version");

    // ✅ Fix: entering Version detail should not inherit prior scroll position
  if (activeScreenEl) activeScreenEl.scrollTop = 0;
  try { window.scrollTo(0, 0); } catch {}
  try { document.documentElement.scrollTop = 0; } catch {}
  try { document.body.scrollTop = 0; } catch {}
  requestAnimationFrame(() => { if (screens.home) screens.home.scrollTop = 0; });

  const hasPlayable = !!(v.link || v.fileId || v.localAudioId || v.driveFileId);
  const hasLocal = !!(v.fileId || v.localAudioId);
  const hasDrive = !!v.driveFileId;
  const driveConnected = gdriveIsConnected();

  activeScreenEl.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between; align-items:center">
        <h2>${escapeHtml(song.title)}</h2>
        <button class="ghost" id="backToSong">Back</button>
      </div>
      <div class="small">${escapeHtml(song.project || "—")} • ${escapeHtml(song.genre || "—")}</div>

      <div class="hr"></div>

      <div class="row" style="gap:10px; align-items:center; flex-wrap:wrap">
        <div class="badge ${v.isActive ? "good" : ""}">${v.isActive ? "✅ Active" : "Active —"}</div>
      </div>

      <div class="hr"></div>

      <div class="label">Label</div>
      <input id="vLabel" type="text" value="${escapeHtml(v.label || "")}" />

      <div class="label" style="margin-top:10px">Notes</div>
      <input id="vNotesEdit" type="text" value="${escapeHtml(v.notes || "")}" />

      <div class="label" style="margin-top:10px">Link (URL)</div>
      <input id="vLink" type="text" value="${escapeHtml(v.link || "")}" placeholder="Paste direct audio URL" />

      <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap">
        <button class="btn" id="importAudioBtn">Import audio (Files) 📁</button>
        <button class="btn" id="clearLocalBtn" ${hasLocal ? "" : "disabled"}>Remove local file</button>
        ${hasLocal && driveConnected && !hasDrive ? `
          <button class="btn" id="uploadToDriveBtn">Upload to Drive ☁️</button>
        ` : ""}
      </div>

      ${hasLocal ? `
        <div class="small" style="margin-top:8px">
          Local: <b>${escapeHtml(v.fileName || v.originalFileName || "audio file")}</b>
          ${v.fileSize ? ` • ${(v.fileSize/1024/1024).toFixed(1)} MB` : ""}
        </div>
      ` : `<div class="small" style="margin-top:8px">No local file attached.</div>`}

      ${hasDrive ? `
        <div class="small" style="margin-top:6px; color: #4ecdc4;">
          ☁️ On Drive: <b>${escapeHtml(v.fileName || v.originalFileName || "audio")}</b>
          ${v.driveWebViewLink ? ` <a href="${escapeHtml(v.driveWebViewLink)}" target="_blank" style="color:#4ecdc4; text-decoration:underline; margin-left:4px;">View ↗</a>` : ""}
        </div>
      ` : (driveConnected ? `
        <div class="small" style="margin-top:6px; opacity:.5">☁️ Not yet synced to Drive.</div>
      ` : ``)}

      <div class="row" style="margin-top:12px; gap:10px; flex-wrap:wrap">
        <button class="btn primary" id="saveVersion">Save</button>
        <button class="btn" id="playThis" ${hasPlayable ? "" : "disabled"}>Play</button>
        <button class="btn" id="queueThis" ${hasPlayable ? "" : "disabled"}>Queue</button>
      </div>

      <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap">
        <button class="btn" id="toggleActiveBtn">${v.isActive ? "Active ✅" : "Set Active ✅"}</button>
        <button class="btn" id="openLinkBtn" ${v.link ? "" : "disabled"}>Open link</button>
        <button class="btn" id="deleteVersionBtn">Delete</button>
      </div>
    </div>
  `;

  // Back
  $("#backToSong")?.addEventListener("click", () => goBack({ animate: true }));

  // Save
  $("#saveVersion")?.addEventListener("click", () => {
    v.label = ($("#vLabel")?.value || "").trim();
    v.notes = ($("#vNotesEdit")?.value || "").trim();
    v.link  = ($("#vLink")?.value || "").trim();

    song.updatedAt = nowStamp();
    saveState();
    toast("Saved ✅");
    renderVersionDetail(songId, versionId);
  });

  // Import audio (local file + Drive)
  $("#importAudioBtn")?.addEventListener("click", async () => {
    try {
      const file = await pickAudioFile();
      if (!file) return;

      const id = uid();

      // Always store locally first (fast, offline)
      await audioPut({
        id,
        name: file.name || "audio",
        type: file.type || "audio/*",
        size: file.size || 0,
        blob: file,
        createdAt: nowStamp(),
      });

      v.fileId = id;
      v.fileName = file.name || "audio";
      v.fileType = file.type || "audio/*";
      v.fileSize = file.size || 0;

      song.updatedAt = nowStamp();
      saveState();
      toast("Imported locally ✅");

      // Also upload to Google Drive (if connected)
      if (gdriveIsConnected()) {
        toast("Uploading to Drive… ☁️");

        const suggested = suggestedFileName(song, file.name);

        const result = await gdriveUploadAudio({
          file,
          fileName: suggested,
          project: song.project,
          songTitle: song.title,
        });

        if (result.success) {
          v.driveFileId = result.driveFileId;
          v.driveWebViewLink = result.driveWebViewLink || "";
          saveState();
          toast("Synced to Drive ✅ ☁️");
        } else {
          console.warn("Drive upload failed:", result.error);
          toast("Local saved, Drive failed 😅");
        }
      }

      renderVersionDetail(songId, versionId);
    } catch (err) {
      console.error(err);
      toast("Import failed 😭");
    }
  });

  // Remove local file
  $("#clearLocalBtn")?.addEventListener("click", async () => {
    if (!confirm("Remove local audio from this device?")) return;

    // if it was stored under fileId
    if (v.fileId) {
      try { await audioDelete(v.fileId); } catch {}
      v.fileId = null;
      v.fileName = "";
      v.fileType = "";
      v.fileSize = 0;
    }

    // if it was stored under localAudioId (your other system)
    if (v.localAudioId) {
      // you used putAudioBlob/getAudioBlob for this path,
      // but you don't have a delete wrapper there — so just clear pointer:
      v.localAudioId = null;
      v.originalFileName = "";
    }

    song.updatedAt = nowStamp();
    saveState();
    toast("Removed 🧼");
    renderVersionDetail(songId, versionId);
  });

  // Play / Queue
  $("#playThis")?.addEventListener("click", () => playVersion(songId, versionId, { goPlayer: false }));
  $("#queueThis")?.addEventListener("click", () => addToQueue(songId, versionId));

  // Upload to Drive (manual push for local-only files)
  $("#uploadToDriveBtn")?.addEventListener("click", async () => {
    if (!gdriveIsConnected()) return toast("Connect Drive first in Settings ⚙️");

    let blob = null;
    let fileName = v.fileName || v.originalFileName || "audio.wav";

    if (v.fileId) {
      const rec = await audioGet(v.fileId);
      if (rec?.blob) blob = rec.blob;
    } else if (v.localAudioId) {
      const rec = await getAudioBlob(v.localAudioId);
      if (rec?.blob) blob = rec.blob;
    }

    if (!blob) return toast("No local file to upload 😅");

    toast("Uploading to Drive… ☁️");
    const suggested = suggestedFileName(song, fileName);
    const result = await gdriveUploadAudio({
      file: blob,
      fileName: suggested,
      project: song.project,
      songTitle: song.title,
    });

    if (result.success) {
      v.driveFileId = result.driveFileId;
      v.driveWebViewLink = result.driveWebViewLink || "";
      song.updatedAt = nowStamp();
      saveState();
      toast("Uploaded to Drive ✅ ☁️");
      renderVersionDetail(songId, versionId);
    } else {
      toast("Upload failed: " + (result.error || "unknown") + " 😅");
    }
  });

  // Active (exclusive — only one version active at a time)
  $("#toggleActiveBtn")?.addEventListener("click", () => {
    setActive(songId, versionId);
    toast("Active ✅");
    renderVersionDetail(songId, versionId);
  });

  // Open link
  $("#openLinkBtn")?.addEventListener("click", () => {
    if (v.link) window.open(v.link, "_blank");
  });

  // Delete
  $("#deleteVersionBtn")?.addEventListener("click", async () => {
    if (!confirm("Delete this version?")) return;

    // Also delete from Drive if synced
    if (v.driveFileId && gdriveIsConnected()) {
      try { await gdriveDeleteFile(v.driveFileId); } catch {}
    }

    const wasActive = v.isActive;
    song.versions = (song.versions || []).filter(x => x.id !== versionId);

    // If the deleted version was active, promote the first remaining version
    if (wasActive && song.versions.length && !song.versions.some(x => x.isActive)) {
      song.versions[0].isActive = true;
    }

    song.updatedAt = nowStamp();
    saveState();
    toast("Deleted 🗑️");

    selectedVersionId = null;
    renderSongDetail(songId);
  });
}

// ---------------------
// Player
// ---------------------
function renderPlayer() {
  setHeader("Player");

  // Build playlist rows (one row per version where playerYes === true)
  const items = playerItems(state); // uses playerFilter/playerSort globals

  const now = state.player?.nowPlaying || null;

  function isNowPlayingRow(songId, versionId) {
    return !!(now && now.songId === songId && now.versionId === versionId);
  }

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
          currentTab = "songs";
          drawerView = null;
          overlayView = null;
          selectedSongId = s.id;
          selectedVersionId = null;
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

  // Header + chips + list
  activeScreenEl.innerHTML = `
    <div class="playerHeader">
      <div class="playerTitleRow">
        <div>
          <div class="small">Playlist</div>
          <h2 class="playerTitle">Active Versions</h2>
          <div class="playerCount">${items.length} song${items.length === 1 ? "" : "s"}</div>
        </div>

        <div class="playerActions">
          <button class="playerShuffleBtn" id="playerShuffle" aria-label="Shuffle">⤮</button>
          <button class="playerPlayBtn" id="playerPlayAll" aria-label="Play">▶</button>
        </div>
      </div>
    </div>

    <div class="chipsRow" aria-label="Player filters">
      <button class="chip ${playerFilter === "all" ? "active" : ""}" data-pf="all">All</button>
      <button class="chip ${playerFilter === "fav" ? "active" : ""}" data-pf="fav">Favorites</button>

      <span style="width:10px; flex:0 0 auto;"></span>

      <button class="chip ${playerSort === "recent" ? "active" : ""}" data-ps="recent">Recent</button>
      <button class="chip ${playerSort === "title" ? "active" : ""}" data-ps="title">Title</button>
    </div>

    <div class="playerList">
      ${
        items.length
          ? items.map((it) => {
              const s = getSong(it.songId);
              const v = s ? getVersion(s, it.versionId) : null;

              // Fallback if missing
              const title = it.songName || s?.title || "Untitled";
              const meta = it.label || v?.label || "Version";
              const fav = !!it.favorite;

              const cover = s ? coverSvg(s, { lite: true }) : "";

              return `
                <div class="playerRow ${isNowPlayingRow(it.songId, it.versionId) ? "playing" : ""}"
                     data-pr-song="${it.songId}"
                     data-pr-ver="${it.versionId}">
                  <div class="playerCover" aria-hidden="true">${cover}</div>

                  <div class="playerMain">
                    <div class="playerName">${escapeHtml(title)}</div>
                    <div class="playerMeta">
                      <span>${escapeHtml(meta)}</span>
                      ${fav ? `<span class="playerBadge fav">♥</span>` : ``}
                      ${
                        isNowPlayingRow(it.songId, it.versionId)
                          ? `<span class="playerBadge">Now</span>`
                          : ``
                      }
                    </div>
                  </div>

                  <button class="playerMore" data-pr-more="1" aria-label="More">⋯</button>
                </div>
              `;
            }).join("")
          : `<div class=”emptyState”>No songs yet. Add songs from the Songs tab.</div>`
      }
    </div>
  `;

  // Filter chips
  activeScreenEl.querySelectorAll("[data-pf]").forEach(btn => {
    btn.addEventListener("click", () => {
      playerFilter = btn.getAttribute("data-pf") || "all";
      renderPlayer();
    });
  });
  activeScreenEl.querySelectorAll("[data-ps]").forEach(btn => {
    btn.addEventListener("click", () => {
      playerSort = btn.getAttribute("data-ps") || "recent";
      renderPlayer();
    });
  });

  // Play all (in current filter/sort order)
  $("#playerPlayAll")?.addEventListener("click", async () => {
    if (!items.length) return toast("Playlist empty 😅");
    const all = items.map(x => ({ songId: x.songId, versionId: x.versionId }));
    state.player.nowPlaying = all[0];
    state.player.queue = all.slice(1);
    state.player.repeatQueue = all; // stored so repeat can rebuild
    saveState();
    await playNowPlaying({ autoplay: true });
    toast("Playing ▶️");
    renderPlayer();
  });

  // Shuffle
  $("#playerShuffle")?.addEventListener("click", async () => {
    if (!items.length) return toast("Playlist empty 😅");
    const all = shuffleArray(items).map(x => ({ songId: x.songId, versionId: x.versionId }));
    state.player.nowPlaying = all[0];
    state.player.queue = all.slice(1);
    state.player.repeatQueue = all;
    saveState();
    await playNowPlaying({ autoplay: true });
    toast("Shuffled ▶️");
    renderPlayer();
  });

  // Row interactions
  activeScreenEl.querySelectorAll(".playerRow").forEach(row => {
    row.addEventListener("click", async (e) => {
      const isMore = e.target.closest(".playerMore");
      const songId = row.getAttribute("data-pr-song");
      const versionId = row.getAttribute("data-pr-ver");
      if (!songId || !versionId) return;

      const item = items.find(x => x.songId === songId && x.versionId === versionId);
      if (!item) return;

      if (isMore) {
        e.stopPropagation();
        openPlayerActionSheet(item);
        return;
      }

      // Tap row = play immediately (Spotify-ish)
      state.player.nowPlaying = { songId, versionId };
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
    playerScreen = "list";
    return renderPlayer();
  }

  if (activeScreenEl) activeScreenEl.scrollTop = 0;
  requestAnimationFrame(() => { if (activeScreenEl) activeScreenEl.scrollTop = 0; });

  const song = getSong(now.songId);
  const v = song ? getVersion(song, now.versionId) : null;
  if (!song || !v) {
    playerScreen = "list";
    return renderPlayer();
  }

  setHeader("Now Playing");
  setFullPlayerOpen(true);

  const title = song.title || "Untitled";
  const subtitle = v.label || "Version";
  const art = coverSvg(song);

  activeScreenEl.innerHTML = `
    <section class="fp" id="fullPlayer" aria-label="Now playing">
      <div class="fpBg" aria-hidden="true">${art}</div>

      <header class="fpHeader">
        <button class="fpIcon" id="npBackBtn" aria-label="Close">⌄</button>

        <div class="fpHeaderRight">
          <button class="fpIcon" type="button" aria-label="Cast" disabled>⎚</button>
          <button class="fpIcon" type="button" aria-label="More" disabled>⋮</button>
        </div>
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
        <button class="fpCtrl ${state.player?.shuffle ? 'is-active' : ''}" type="button" aria-label="Shuffle" id="npShuffle">🔀</button>
        <button class="fpCtrl" id="npPrev" type="button" aria-label="Previous">⏮</button>
        <button class="fpCtrl fpPlay" id="npToggle" type="button" aria-label="Play / Pause">${globalAudio?.paused ? "▶" : "⏸"}</button>
        <button class="fpCtrl" id="npNext" type="button" aria-label="Next">⏭</button>
        <button class="fpCtrl ${state.player?.repeat ? 'is-active' : ''}" type="button" aria-label="Repeat" id="npRepeat">🔁</button>
      </div>

      <nav class="fpBottomTabs" aria-label="Now playing tabs">
        <button class="fpTab is-active" type="button">UP NEXT</button>
        <button class="fpTab" type="button" disabled>LYRICS</button>
        <button class="fpTab" type="button" disabled>RELATED</button>
      </nav>
    </section>
  `;

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
    if (toggleEl) toggleEl.textContent = globalAudio.paused ? "▶" : "⏸";
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
    setFullPlayerOpen(false);
    playerScreen = "list";
    if (prevTabBeforeFullPlayer) {
      currentTab = prevTabBeforeFullPlayer;
      selectedSongId = prevSelectedSongIdBeforeFullPlayer;
      prevTabBeforeFullPlayer = null;
      prevSelectedSongIdBeforeFullPlayer = null;
      setHeader(currentTab === "songs" && selectedSongId ? "Song" : TAB_TITLES[currentTab] || "RiffBank");
    } else {
      setHeader("Player");
    }
    syncTabs();
    render();
  };

  $("#npBackBtn")?.addEventListener("click", closeFullPlayer);

  // ✅ Swipe down to close
  const fp = $("#fullPlayer");
  let swipeOn = false;
  let startY = 0;
  let startX = 0;
  let lastDy = 0;

  fp?.addEventListener("touchstart", (e) => {
    const t = e.touches?.[0];
    if (!t) return;
    if (e.target?.closest?.("button, input, a")) return;

    swipeOn = true;
    startY = t.clientY;
    startX = t.clientX;
    lastDy = 0;
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
    const clamped = Math.min(dy, 160);
    fp.style.transform = `translateY(${clamped}px)`;
    fp.style.transition = "none";
    fp.style.opacity = String(1 - (clamped / 240));
  }, { passive: false });

  fp?.addEventListener("touchend", () => {
    if (!swipeOn) return;
    swipeOn = false;

    const shouldClose = lastDy > 80;
    fp.style.transition = "transform 180ms ease, opacity 180ms ease";
    fp.style.transform = "translateY(0px)";
    fp.style.opacity = "1";

    if (shouldClose) closeFullPlayer();
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
    if (!advanceToNextTrack({ render: true })) toast("Queue empty 😅");
  });

  $("#npPrev")?.addEventListener("click", () => {
    if (!globalAudio) return;
    globalAudio.currentTime = 0;
  });

  $("#npShuffle")?.addEventListener("click", () => {
  state.player.shuffle = !state.player.shuffle;
  saveState();
  $("#npShuffle")?.classList.toggle("is-active", !!state.player.shuffle);
});

$("#npRepeat")?.addEventListener("click", () => {
  state.player.repeat = !state.player.repeat;
  saveState();
  $("#npRepeat")?.classList.toggle("is-active", !!state.player.repeat);
});

  $("#npGoSong")?.addEventListener("click", () => {
    cleanup();
    setFullPlayerOpen(false);
    currentTab = "songs";
    selectedSongId = song.id;
    selectedVersionId = null;
    drawerView = null;
    overlayView = null;
    playerScreen = "list";
    setHeader("Song");
    syncTabs();
    render();
  });

  $("#npGoList")?.addEventListener("click", () => {
    cleanup();
    setFullPlayerOpen(false);
    playerScreen = "list";
    setHeader("Player");
    render();
  });
}

// ---------------------
// Settings
// ---------------------
function renderSettings() {
  setHeader("Settings");

  const driveConnected = gdriveIsConnected();
  const driveCfg = gdriveGetConfig();

  activeScreenEl.innerHTML = `
    <div class="card">
      <h2>Settings</h2>

      <div style="
        background: ${driveConnected ? "rgba(78,205,196,.08)" : "rgba(255,255,255,.04)"};
        border: 1px solid ${driveConnected ? "rgba(78,205,196,.25)" : "rgba(255,255,255,.08)"};
        border-radius: 12px;
        padding: 16px;
        margin-bottom: 16px;
      ">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${driveConnected ? "#4ecdc4" : "currentColor"}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12A10 10 0 1 1 12 2"/><path d="M22 2L12 12"/><path d="M16 2h6v6"/></svg>
          <span style="font-weight:900; font-size:15px;">Google Drive</span>
          ${driveConnected
            ? `<span style="
                background: rgba(78,205,196,.15);
                color: #4ecdc4;
                font-size: 11px;
                font-weight: 700;
                padding: 2px 8px;
                border-radius: 6px;
                margin-left: auto;
              ">Connected</span>`
            : `<span style="
                background: rgba(255,255,255,.06);
                color: rgba(255,255,255,.4);
                font-size: 11px;
                font-weight: 700;
                padding: 2px 8px;
                border-radius: 6px;
                margin-left: auto;
              ">Not connected</span>`
          }
        </div>

        ${driveConnected ? `
          <div class="small" style="margin-bottom:6px">
            Signed in as <b>${escapeHtml(driveCfg.userEmail || "Google account")}</b>
          </div>
          <div class="small" style="margin-bottom:10px; opacity:.6">
            Home folder: <b>${escapeHtml(driveCfg.homeFolderName || "RiffBank")}</b><br>
            Structure: <code style="font-size:11px">${escapeHtml(driveCfg.homeFolderName)}/Project/Song/Versions/</code>
          </div>
          <div class="small" style="margin-bottom:10px; opacity:.7">
            Audio imports are automatically uploaded to Drive. Your files also stay on this device for offline playback.
          </div>
          <div class="row" style="gap:10px">
            <button id="driveOpenFolder" class="btn" style="flex:1">Open in Drive ↗</button>
            <button id="driveDisconnect" class="btn" style="flex:1; background: rgba(255,92,119,.08); border-color: rgba(255,92,119,.2); color: #ff5c77;">Disconnect</button>
          </div>
          <div class="row" style="gap:10px; margin-top:10px">
            <button id="driveSyncPush" class="btn" style="flex:1">Push state to Drive ⬆</button>
            <button id="driveSyncPull" class="btn" style="flex:1">Pull state from Drive ⬇</button>
          </div>
          <div class="row" style="gap:10px; margin-top:10px">
            <button id="driveRebuild" class="btn" style="flex:1; background: rgba(255,200,50,.08); border-color: rgba(255,200,50,.2); color: #ffc832;">Rebuild from Drive folders 🔄</button>
          </div>
          <div class="small" style="margin-top:6px; opacity:.5">
            Rebuild scans your Drive folder structure and recreates song metadata from the files it finds.
          </div>
        ` : `
          <div class="small" style="margin-bottom:12px; opacity:.7">
            Connect your Google Drive to automatically back up audio files to the cloud.
            RiffBank creates organized folders for each project and song.
          </div>

          <button id="drivePickBtn" class="btn primary" style="width:100%; margin-bottom:10px">
            Choose existing folder
          </button>
          <div class="small" style="margin-bottom:14px; opacity:.5; text-align:center">
            Browse your Drive and pick a folder to use as RiffBank's home
          </div>

          <div style="display:flex; align-items:center; gap:10px; margin-bottom:14px">
            <div style="flex:1; height:1px; background:rgba(255,255,255,.1)"></div>
            <div style="font-size:12px; opacity:.4">or</div>
            <div style="flex:1; height:1px; background:rgba(255,255,255,.1)"></div>
          </div>

          <div class="label" style="margin-bottom:4px">Create a new folder</div>
          <div class="row" style="gap:10px">
            <input id="driveNewName" type="text" value="${escapeHtml(state.settings.driveRoot || "RiffBank")}" placeholder="e.g. RiffBank" style="flex:1" />
            <button id="driveCreateBtn" class="btn">Create</button>
          </div>
          <div class="small" style="margin-top:4px; opacity:.5">
            Creates a new folder at the root of your Google Drive
          </div>
        `}
      </div>

      <div class="hr"></div>

      <div class="label">Drive root folder name</div>
      <input id="driveRoot" type="text" value="${escapeHtml(state.settings.driveRoot || "RiffBank")}" />
      <div class="small">Used to suggest where files should live in Drive/iCloud/etc.</div>

      <div class="hr"></div>
      <h2>Defaults</h2>

      <div class="row">
        <div class="col">
          <div class="label">Default project</div>
          <input id="defProject" type="text" value="${escapeHtml(state.settings.defaultProject || "")}" />
        </div>
        <div class="col">
          <div class="label">Default genre</div>
          <input id="defGenre" type="text" value="${escapeHtml(state.settings.defaultGenre || "")}" />
        </div>
      </div>

      <div class="row" style="margin-top:10px">
        <div class="col">
          <div class="label">Default sprint</div>
          <input id="defSprint" type="text" value="${escapeHtml(state.settings.defaultSprint || "")}" />
        </div>
      </div>

      <div class="row" style="margin-top:10px">
        <button id="saveSettings" class="btn primary">Save</button>
      </div>

      <div class="hr"></div>
      <h2>Danger zone</h2>
      <button id="wipe" class="btn">Wipe local data</button>
      <div class="small">This only affects this device/browser. Export first if you care.</div>
    </div>
  `;

  // Google Drive: Pick existing folder
  $("#drivePickBtn")?.addEventListener("click", async () => {
    toast("Connecting to Google Drive… ☁️");

    const result = await gdriveConnect();

    if (result.success) {
      state.settings.driveRoot = result.homeFolderName || "RiffBank";
      saveState();
      toast("Connected to Google Drive ✅");
      renderSettings();
    } else {
      toast(result.error || "Connection failed 😅");
    }
  });

  // Google Drive: Create new folder
  $("#driveCreateBtn")?.addEventListener("click", async () => {
    const folderName = ($("#driveNewName")?.value || "").trim() || "RiffBank";
    toast("Connecting to Google Drive… ☁️");

    const result = await gdriveConnectNewFolder(folderName);

    if (result.success) {
      state.settings.driveRoot = folderName;
      saveState();
      toast("Connected to Google Drive ✅");
      renderSettings();
    } else {
      toast(result.error || "Connection failed 😅");
    }
  });

  // Google Drive: Disconnect
  $("#driveDisconnect")?.addEventListener("click", () => {
    if (!confirm("Disconnect from Google Drive? Your files on Drive stay — RiffBank just won't sync new uploads.")) return;
    gdriveDisconnect();
    toast("Disconnected 🔌");
    renderSettings();
  });

  // Google Drive: Open home folder
  $("#driveOpenFolder")?.addEventListener("click", () => {
    const folderId = driveCfg.homeFolderId;
    if (folderId) {
      window.open(`https://drive.google.com/drive/folders/${folderId}`, "_blank");
    }
  });

  // Google Drive: Push state now
  $("#driveSyncPush")?.addEventListener("click", async () => {
    toast("Pushing state to Drive… ☁️");
    const ok = await gdriveSyncStateNow(state);
    if (ok) {
      toast("State pushed to Drive ✅");
    } else {
      toast("Push failed — try reconnecting 😅");
    }
  });

  // Google Drive: Pull state now
  $("#driveSyncPull")?.addEventListener("click", async () => {
    toast("Pulling state from Drive… ☁️");
    const driveState = await gdrivePullState();
    if (driveState && driveState.songs) {
      if (!confirm(`Found ${driveState.songs.length} songs on Drive. Replace local data?`)) return;
      state = driveState;
      normalizeState();
      localStorage.setItem(LS_KEY, JSON.stringify(state));
      toast("Synced from Drive ✅ ☁️");
      render();
    } else {
      toast("No state found on Drive (or token expired) 😅");
    }
  });

  // Google Drive: Rebuild from folder structure
  $("#driveRebuild")?.addEventListener("click", async () => {
    toast("Scanning Drive folders… 🔄");
    const songs = await gdriveRebuildFromFolders();

    if (!songs || songs.length === 0) {
      toast("No songs found in Drive folders 😅");
      return;
    }

    if (!confirm(`Found ${songs.length} songs from Drive folders. Replace local library?`)) return;

    state.songs = songs;
    normalizeState();
    saveState();
    toast(`Rebuilt ${songs.length} songs from Drive ✅ 🔄`);
    render();
  });

  // Existing settings
  $("#saveSettings").addEventListener("click", () => {
    state.settings.driveRoot = $("#driveRoot").value.trim() || "RiffBank";
    state.settings.defaultProject = $("#defProject").value.trim() || "";
    state.settings.defaultGenre = $("#defGenre").value.trim() || "";
    state.settings.defaultSprint = $("#defSprint").value.trim() || "";
    saveState();
    toast("Saved ✅");
  });

  $("#wipe").addEventListener("click", async () => {
    if (!confirm("Wipe all local RiffBank data on this browser?")) return;

    localStorage.removeItem(LS_KEY);
    state = loadState();
    normalizeState();
    // Save locally only — do NOT sync empty state to Drive
    localStorage.setItem(LS_KEY, JSON.stringify(state));

    toast("Wiped 🧼 (Drive state untouched)");
    currentTab = "home";
    setHeader("RiffBank");

    if (screens.home) screens.home.scrollTop = 0;
    try { window.scrollTo(0, 0); } catch {}
    try { document.documentElement.scrollTop = 0; } catch {}
    try { document.body.scrollTop = 0; } catch {}
    requestAnimationFrame(() => { if (activeScreenEl) activeScreenEl.scrollTop = 0; });

    render();
  });
}

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
      if (currentTab === "songs" && selectedSongId) return;

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

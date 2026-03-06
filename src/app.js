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
 const DISABLE_SPLASH = true;

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
  gdriveUploadCoverArt,
  gdriveGetStreamUrl,
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

// Releases sub-screen (null = list, string = release ID being viewed)
let releaseDetailId = null;

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
  collab: document.getElementById("screen-collab"),
  drawer: document.getElementById("screen-drawer"),
};

const backPeekEl = document.getElementById("back-peek");
let backPeekHTML = "";

// Navigation history stack — each entry is the HTML of a screen we navigated away from.
// Used so swipe-back and forward-slide both show the correct "ace under the queen".
let navHistoryStack = [];
let navHistoryTopbarStack = []; // topbar HTML for each navHistoryStack entry (for ace topbar in swipe-back)
let navScrollStack = [];  // scrollTop of each screen pushed to navHistoryStack
let prevAceViewTop = 0;   // top of the previous screen when backPeekHTML was captured
let prevAceScrollTop = 0; // scrollTop of the previous screen when backPeekHTML was captured
let prevTopbarHTML = "";  // outerHTML of topbar at render() snapshot time (before setHeader changes it)
let prevTopbarRect = null; // bounding rect of topbar at snapshot time
let swipeAceEl = null;   // fixed-position ace overlay (home snapshot) — z-index: 499
let swipeQueenEl = null; // fixed-position queen overlay (songs snapshot) — z-index: 500

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

// Show the "ace" (previous screen) behind the view during a forward slide.
function _showPeekBackdrop(html) {
  if (!backPeekEl || !html) return;
  backPeekEl.innerHTML = html;
  backPeekEl.style.display = "block";
}
function _hidePeekBackdrop() {
  if (!backPeekEl) return;
  backPeekEl.style.display = "none";
  backPeekEl.innerHTML = "";
}

// Slide the new screen in from the right (call after render() for forward navigation).
// Uses an opaque overlay snapshot of the new screen so the ace (previous screen) shows
// cleanly on the left without any see-through bleed from transparent .screen elements.
function triggerForwardSlide() {
  const el = activeScreenEl;
  const topbar = document.querySelector(".topbar");
  if (!el) return;

  // Push the "previous screen" HTML (and its topbar snapshot) onto the nav stacks
  // so swipe-back can restore both the correct content and topbar title.
  if (backPeekHTML) navHistoryStack.push(backPeekHTML);
  navHistoryTopbarStack.push(prevTopbarHTML);
  navScrollStack.push(prevAceScrollTop);

  // Shared measurements.
  const bnEl = document.getElementById("bottomNav");
  const bnRect = bnEl?.getBoundingClientRect();
  const navBottomOffset = bnRect ? `${window.innerHeight - bnRect.top}px` : "0px";
  const r = el.getBoundingClientRect();

  // Build ace overlay (previous screen) — spans top:0 so it covers the full area
  // including the topbar region. Contains a frozen topbar clone (prevTopbarHTML) showing
  // the previous title, plus the screen content below it (prevAceViewTop).
  let aceOverlay = null;
  if (backPeekHTML) {
    const viewEl = document.getElementById("view");
    const viewRect = viewEl?.getBoundingClientRect();
    const aceLeft = viewRect ? viewRect.left : r.left;
    const aceWidth = viewRect ? viewRect.width : r.width;
    aceOverlay = document.createElement("div");
    aceOverlay.style.cssText = `position:fixed;top:0;left:${aceLeft}px;width:${aceWidth}px;bottom:${navBottomOffset};z-index:499;overflow:hidden;pointer-events:none;background:var(--bg);`;
    // Topbar clone — frozen at previous-screen state (correct title, back-button visibility)
    if (prevTopbarHTML && prevTopbarRect) {
      const tbWrap = document.createElement("div");
      tbWrap.innerHTML = prevTopbarHTML;
      const tbEl = tbWrap.firstElementChild;
      if (tbEl) {
        tbEl.style.cssText = `display:flex;position:absolute;top:${prevTopbarRect.top}px;left:0;width:100%;height:${prevTopbarRect.height}px;overflow:hidden;pointer-events:none;box-sizing:border-box;`;
        aceOverlay.appendChild(tbEl);
      }
    }
    // Screen content below the topbar.
    // prevTopbarHTML is empty for home (no visible topbar), so use it to detect home.
    // Non-home .screen elements have CSS padding:10px 0 12px that backPeekHTML (innerHTML)
    // doesn't include — replicate it here so content position matches the original exactly.
    const aceHasTopbar = !!(prevTopbarHTML && prevTopbarRect);
    const aceContent = document.createElement("div");
    aceContent.style.cssText = `position:absolute;top:${prevAceViewTop}px;left:0;width:100%;bottom:0;overflow:hidden;${aceHasTopbar ? "padding:10px 0 12px;box-sizing:border-box;" : ""}`;
    if (prevAceScrollTop > 0) {
      aceContent.innerHTML = `<div style="margin-top:-${prevAceScrollTop}px">${backPeekHTML}</div>`;
    } else {
      aceContent.innerHTML = backPeekHTML;
    }
    aceOverlay.appendChild(aceContent);
    document.body.appendChild(aceOverlay);
  }

  // Build queen overlay (new screen) — covers full height from top:0 so the topbar
  // is included and slides in as one unit. This prevents the ace from showing through
  // above the screen area while the topbar animates in separately.
  const overlay = document.createElement("div");
  overlay.className = "viewSlideOverlay";
  overlay.style.top = "0";
  overlay.style.left = `${r.left}px`;
  overlay.style.width = `${r.width}px`;
  overlay.style.bottom = navBottomOffset;
  overlay.style.height = "";  // use bottom instead of explicit height
  overlay.style.transform = "translateX(100%)";
  overlay.style.transition = "none";

  // Topbar clone — included in the queen so it slides in with the screen content.
  if (topbar) {
    const tbRect = topbar.getBoundingClientRect();
    const tbClone = topbar.cloneNode(true);
    tbClone.style.cssText = `display:flex;position:absolute;top:${tbRect.top}px;left:0;width:100%;height:${tbRect.height}px;overflow:hidden;pointer-events:none;`;
    overlay.appendChild(tbClone);
  }

  // Screen content clone — positioned below the topbar.
  const screenWrap = document.createElement("div");
  screenWrap.style.cssText = `position:absolute;top:${r.top}px;left:0;width:100%;height:${r.height}px;overflow:hidden;`;
  screenWrap.innerHTML = el.outerHTML;
  overlay.appendChild(screenWrap);

  document.body.appendChild(overlay);

  // Hide the actual screen + topbar so they don't flash before the overlay animation.
  el.style.opacity = "0";
  if (topbar) { topbar.style.opacity = "0"; }

  // Force a synchronous reflow to commit translateX(100%) before animating.
  // eslint-disable-next-line no-unused-expressions
  overlay.offsetWidth;

  overlay.style.transition = "transform 0.28s cubic-bezier(.4,0,.2,1)";
  overlay.style.transform = "";

  overlay.addEventListener("transitionend", () => {
    overlay.remove();
    if (aceOverlay) { aceOverlay.remove(); aceOverlay = null; }
    el.style.opacity = "";
    if (topbar) { topbar.style.opacity = ""; }
  }, { once: true });
}

const headerTitle = $("#headerTitle");
const headerBackEl = document.getElementById("headerBack");
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
    inner.style.transition = "transform 220ms ease";
    inner.style.transform = `translateX(${flyTo})`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      ghost.style.transition = "transform 220ms ease";
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
      // Google Drive support
      if (v.driveFileId === undefined) v.driveFileId = null;
      if (v.driveWebViewLink === undefined) v.driveWebViewLink = "";
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
      // Multiple active (e.g. corrupted Drive state) — keep most recently updated, clear the rest
      const newest = activeVs.reduce((a, b) =>
        new Date(a.updatedAt || a.createdAt || 0) >= new Date(b.updatedAt || b.createdAt || 0) ? a : b
      );
      song.versions.forEach(v => { v.isActive = (v.id === newest.id); });
    }
    if (song.coverImageUrl === undefined) song.coverImageUrl = null;
    if (song.coverDriveFileId === undefined) song.coverDriveFileId = null;
  });
  // Player state (queue)
  state.player = state.player || {};
  state.player.queue = Array.isArray(state.player.queue) ? state.player.queue : [];
  state.player.repeatQueue = Array.isArray(state.player.repeatQueue) ? state.player.repeatQueue : [];
  state.player.nowPlaying = state.player.nowPlaying || null;

  // Playback toggles (persisted)
  if (typeof state.player.shuffle !== "boolean") state.player.shuffle = false;
  if (state.player.repeat !== true && state.player.repeat !== "one") state.player.repeat = false;
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

  // Priority 3b: Live fetch from Drive (gdriveFetchBlob handles silent token refresh)
  if (v.driveFileId && gdriveIsConnected()) {
    const blob = await gdriveFetchBlob(v.driveFileId);
    if (blob) {
      const url = URL.createObjectURL(blob);
      audioUrlCache.set(`drive:${v.driveFileId}`, url);
      putAudioBlob({ id: `gdrive:${v.driveFileId}`, blob, name: v.fileName || v.label || "audio", type: v.fileType || blob.type || "audio/*", size: blob.size }).catch(() => {});
      return url;
    }
    if (!v.link) return "drive-auth-required";
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

      // 🔥 Force-check on every load (beats the "24-hour SW update check" behavior)
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
  collab: "Collab",
  settings: "Settings",
};

let currentTab = "home";
let selectedSongId = null;
let songsView = "list";
let songsListScrollTop = 0; // scroll position saved when navigating into a song
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

// Show/hide the back button based on whether we're on a nested screen
const ROOT_TABS = new Set(["home", "player", "collab"]);
function syncBackButton() {
  if (!headerBackEl) return;
  // Collab is always a root — never show back button there
  if (currentTab === "collab") { headerBackEl.style.display = "none"; return; }
  const onRoot =
    ROOT_TABS.has(currentTab) &&
    !drawerView &&
    !selectedSongId &&
    !selectedVersionId &&
    !projectDetailScreen &&
    !releaseDetailId &&
    songsView !== "create";
  headerBackEl.style.display = onRoot ? "none" : "flex";
}

// Wire back button once
headerBackEl?.addEventListener("click", () => goBack({ animate: true }));

function syncTabs() {
  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === currentTab);
  });
}

function getSong(id) {
  return state.songs.find((s) => s.id === id);
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

// Create button in bottom nav
document.querySelector(".createNavBtn")?.addEventListener("click", () => openSheet("chooser"));

// Sal mascot button — opens help sheet
document.querySelector(".salNavBtn")?.addEventListener("click", () => openSalSheet());

function openSalSheet() {
  // Remove any existing Sal sheet
  document.getElementById("salSheetBackdrop")?.remove();
  document.getElementById("salSheet")?.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "salSheetBackdrop";
  backdrop.className = "actionSheetBackdrop";

  const sheet = document.createElement("div");
  sheet.id = "salSheet";
  sheet.className = "actionSheet";
  sheet.style.cssText = "padding: 0; overflow: hidden; border-radius: 22px;";
  sheet.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;padding:28px 24px 12px;gap:12px;">
      <img src="./sal.png" alt="Sal" style="width:80px;height:80px;object-fit:contain;filter:drop-shadow(0 4px 16px rgba(0,0,0,0.6));">
      <div style="font-size:22px;font-weight:900;color:#fff;letter-spacing:-0.4px;">Hey, I'm Sal!</div>
      <div style="font-size:14px;color:rgba(255,255,255,.55);text-align:center;line-height:1.6;max-width:280px;">
        Your RiffBank guide. I'll help you manage songs, projects, versions, and everything in between.
      </div>
    </div>
    <div style="height:1px;background:rgba(255,255,255,.08);margin:0 16px;"></div>
    <button class="actionSheetBtn" id="salClose">Got it</button>
  `;

  function close() { backdrop.remove(); sheet.remove(); }
  backdrop.addEventListener("click", close);
  sheet.querySelector("#salClose")?.addEventListener("click", close);

  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
}

// Tabs
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetTab = btn.dataset.tab || "home";
    songsBackTarget = null;
    navHistoryStack = [];
    navHistoryTopbarStack = [];
    navScrollStack = [];

    // Normal navigation
    drawerView = null;
    overlayView = null;
    selectedSongId = null;
    songsView = "list";
    songsListScrollTop = 0;

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
// iOS slide-back animation (back button)
// ---------------------
function slideBackTransition(renderUnderneath) {
  if (!activeScreenEl) return renderUnderneath();

  // Pop nav stack — animated back button pops here (swipe pops in touchend).
  if (navHistoryStack.length > 0) navHistoryStack.pop();
  if (navHistoryTopbarStack.length > 0) navHistoryTopbarStack.pop();
  if (navScrollStack.length > 0) navScrollStack.pop();

  const el = activeScreenEl;
  const tb = document.querySelector(".topbar");

  // Capture exact pixel rects BEFORE renderUnderneath() mutates the layout
  // (renderUnderneath() may toggle body.isHome which hides the topbar and resizes #view).
  const tbRect = tb ? tb.getBoundingClientRect() : null;
  const viewRect = el.getBoundingClientRect();

  // Build a fixed, full-viewport queen overlay that exactly replicates what is
  // currently on screen (topbar + active screen at their actual pixel positions).
  // Using position:fixed means the queen is immune to any layout shifts caused by
  // renderUnderneath() — it always covers the full viewport at z-index 500.
  const queenEl = document.createElement("div");
  queenEl.style.cssText = "position:fixed;inset:0;z-index:500;overflow:hidden;pointer-events:none;background:var(--bg);";

  if (tbRect && tb) {
    const tbClone = tb.cloneNode(true);
    // Force display:flex so body.isHome .topbar { display:none } cannot hide the clone
    // mid-transition (which would make the songs queen appear to shift up).
    tbClone.style.cssText = `display:flex;position:absolute;top:${tbRect.top}px;left:${tbRect.left}px;width:${tbRect.width}px;height:${tbRect.height}px;overflow:hidden;pointer-events:none;`;
    queenEl.appendChild(tbClone);
  }

  const screenWrap = document.createElement("div");
  screenWrap.style.cssText = `position:absolute;top:${viewRect.top}px;left:${viewRect.left}px;width:${viewRect.width}px;height:${viewRect.height}px;overflow:hidden;`;
  screenWrap.innerHTML = el.outerHTML;
  const snap = screenWrap.querySelector(".screen");
  if (snap && el) snap.scrollTop = el.scrollTop;
  queenEl.appendChild(screenWrap);

  document.body.appendChild(queenEl);

  // Render destination NOW, beneath the opaque queen.
  // If going to home this sets body.isHome, hides the topbar, and expands #view —
  // all invisible under the queen so the ace is never seen to shift.
  renderUnderneath();

  // Kill any homeWrap height transition for one rAF so the home screen is fully
  // settled at its correct size before the queen animation starts. Without this,
  // the homeWrap can briefly animate to its final height while the queen slides off,
  // causing a visible "stretched → snap" glitch on the home screen.
  const homeWrapEl = document.querySelector(".homeWrap");
  if (homeWrapEl) homeWrapEl.style.transition = "none";

  requestAnimationFrame(() => {
    if (homeWrapEl) homeWrapEl.style.transition = "";
    requestAnimationFrame(() => {
      queenEl.style.transition = "transform 0.28s cubic-bezier(.4,0,.2,1)";
      queenEl.style.transform = "translateX(100%)";
      queenEl.addEventListener("transitionend", () => queenEl.remove(), { once: true });
    });
  });
}

function goBack({ animate = false } = {}) {
  const doRender = () => {
    if (drawerOpen) { closeDrawer(); return; }

    // For non-animated backs (swipe commit), pop was already handled in touchend.
    // For animated backs (back button), slideBackTransition already popped.
    // So here we just pop if this is a plain goBack({ animate: false }) call
    // that did NOT come from a swipe (i.e., called directly without going through
    // slideBackTransition). Guard: only pop if the stack still has entries.
    if (!animate && navHistoryStack.length > 0) navHistoryStack.pop();
    if (!animate && navHistoryTopbarStack.length > 0) navHistoryTopbarStack.pop();
    if (!animate && navScrollStack.length > 0) navScrollStack.pop();

    if (overlayView) {
      overlayView = null;
      currentTab = "home";
      drawerView = null;
      selectedSongId = null;
      songsView = "list";
      navHistoryStack = [];
      navHistoryTopbarStack = [];
      navScrollStack = [];
      setHeader("RiffBank");
      syncTabs();
      render();
      return;
    }

    if (drawerView === "releases" && releaseDetailId) {
      releaseDetailId = null;
      render();
      return;
    }

    if (drawerView === "projects" && projectDetailScreen) {
      projectDetailScreen = null;
      render();
      return;
    }

    if (drawerView) {
      drawerView = null;
      navHistoryStack = [];
      navHistoryTopbarStack = [];
      navScrollStack = [];
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
      selectedVersionId = null;
      currentTab = "songs";
      songsView = "list";
      drawerView = null;
      overlayView = null;
      resetSongsFilters({ keepSort: true });
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
      drawerView = target;
      currentTab = "home";
      setHeader(TAB_TITLES[currentTab] || "RiffBank");
      syncTabs();
      render();
      return;
    }

    if (currentTab !== "home") {
      currentTab = "home";
      songsView = "list";
      selectedSongId = null;
      navHistoryStack = [];
      navHistoryTopbarStack = [];
      navScrollStack = [];
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
  // Player and Collab have nothing to go back to; bare home screen (no drawer) has nothing to go back to
  if (currentTab === "player" || currentTab === "collab") return;
  if (currentTab === "home" && !drawerView && !overlayView) return;

  touchTracking = true;
  const onHomeRoot = (currentTab === "home" && !drawerView && !overlayView);
  touchMode = onHomeRoot ? "open" : "back";
  touchStartX = t.clientX;
  touchStartY = t.clientY;

  // Pre-populate the peek layer so the previous screen is visible behind the swipe.
  // Use navHistoryStack for accurate depth; fall back to backPeekHTML.
  if (touchMode === "back") {
    const peekContent = navHistoryStack.length > 0
      ? navHistoryStack[navHistoryStack.length - 1]
      : backPeekHTML;

    // Compute the bottom boundary: stop at nav bar top so bottomNav stays visible.
    const bnEl = document.getElementById("bottomNav");
    const bnRect = bnEl?.getBoundingClientRect();
    const navBottomOffset = bnRect ? `${window.innerHeight - bnRect.top}px` : "0px";

    // Constrain ace to #view bounds — this matches exactly where .screen elements render.
    // Using .app would include its 16px horizontal padding, shifting home content to the left edge.
    const viewEl = document.getElementById("view");
    const viewRect = viewEl?.getBoundingClientRect();
    const aceLeft = viewRect ? viewRect.left : 0;
    const aceWidth = viewRect ? viewRect.width : window.innerWidth;

    // ACE (z:499): previous screen snapshot, spans top:0 so it covers the topbar region too.
    // Contains a frozen topbar clone (from navHistoryTopbarStack) + screen content below it.
    const peekTopbarHTML = navHistoryTopbarStack.length > 0
      ? navHistoryTopbarStack[navHistoryTopbarStack.length - 1]
      : prevTopbarHTML;
    const isHomeAce = peekContent && peekContent.includes("homeWrap");
    const swipeAceContentTop = isHomeAce ? 0 : (viewRect ? viewRect.top : 0);
    swipeAceEl = document.createElement("div");
    swipeAceEl.style.cssText = `position:fixed;top:0;left:${aceLeft}px;width:${aceWidth}px;bottom:${navBottomOffset};z-index:499;overflow:hidden;pointer-events:none;background:var(--bg);`;
    // Topbar clone for the ace (frozen previous-screen state)
    if (peekTopbarHTML) {
      const swipeTbCur = document.querySelector(".topbar");
      const swipeTbRect = swipeTbCur?.getBoundingClientRect();
      if (swipeTbRect && swipeTbRect.height > 0) {
        const tbWrap = document.createElement("div");
        tbWrap.innerHTML = peekTopbarHTML;
        const tbEl = tbWrap.firstElementChild;
        if (tbEl) {
          tbEl.style.cssText = `display:flex;position:absolute;top:${swipeTbRect.top}px;left:0;width:100%;height:${swipeTbRect.height}px;overflow:hidden;pointer-events:none;box-sizing:border-box;`;
          swipeAceEl.appendChild(tbEl);
        }
      }
    }
    // Screen content below topbar.
    // Non-home .screen elements have CSS padding:10px 0 12px that innerHTML doesn't include.
    const swipeAceContent = document.createElement("div");
    swipeAceContent.style.cssText = `position:absolute;top:${swipeAceContentTop}px;left:0;width:100%;bottom:0;overflow:hidden;${isHomeAce ? "" : "padding:10px 0 12px;box-sizing:border-box;"}`;
    const swipeAceScrollTop = navScrollStack.length > 0 ? navScrollStack[navScrollStack.length - 1] : prevAceScrollTop;
    swipeAceContent.innerHTML = swipeAceScrollTop > 0
      ? `<div style="margin-top:-${swipeAceScrollTop}px">${peekContent || ""}</div>`
      : (peekContent || "");
    swipeAceEl.appendChild(swipeAceContent);
    document.body.appendChild(swipeAceEl);

    // QUEEN (z:500): pixel-perfect snapshot of the current songs screen.
    // Solid dark background (gradient removed). Stops at nav bar top.
    swipeQueenEl = document.createElement("div");
    swipeQueenEl.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:${navBottomOffset};z-index:500;overflow:hidden;pointer-events:none;background:var(--bg);`;

    const swipeTb = document.querySelector(".topbar");
    if (swipeTb) {
      const tbRect = swipeTb.getBoundingClientRect();
      const tbClone = swipeTb.cloneNode(true);
      // Force display:flex so body.isHome .topbar { display:none } can't hide the clone.
      tbClone.style.cssText = `display:flex;position:absolute;top:${tbRect.top}px;left:${tbRect.left}px;width:${tbRect.width}px;height:${tbRect.height}px;overflow:hidden;pointer-events:none;`;
      swipeQueenEl.appendChild(tbClone);
    }

    let clonedScreen = null;
    const savedScrollTop = activeScreenEl ? activeScreenEl.scrollTop : 0;
    if (activeScreenEl) {
      const screenRect = activeScreenEl.getBoundingClientRect();
      const screenWrap = document.createElement("div");
      screenWrap.style.cssText = `position:absolute;top:${screenRect.top}px;left:${screenRect.left}px;width:${screenRect.width}px;height:${screenRect.height}px;overflow:hidden;`;
      // Use outerHTML so the .screen wrapper (with its padding:10px) is included —
      // otherwise the content appears 10px too high inside the swipe queen.
      screenWrap.innerHTML = activeScreenEl.outerHTML;
      swipeQueenEl.appendChild(screenWrap);
      clonedScreen = screenWrap.firstElementChild;
    }

    document.body.appendChild(swipeQueenEl);
    // Set scrollTop AFTER DOM attachment — browsers ignore scrollTop on detached elements.
    if (clonedScreen) clonedScreen.scrollTop = savedScrollTop;
  }
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

  if (touchMode === "back") {
    // Translate the queen overlay; the actual screen is never touched.
    const clamp = Math.max(0, dx);
    if (swipeQueenEl) swipeQueenEl.style.transform = `translateX(${clamp}px)`;
    return;
  }

  if (touchMode === "close" && dx <= -60) {
    closeDrawer();
    touchTracking = false;
    touchMode = null;
  }
}, { passive: true });

document.addEventListener("touchend", (e) => {
  if (!touchTracking) return;
  const t = e.changedTouches?.[0];

  if (touchMode === "back") {
    const dx = t ? t.clientX - touchStartX : 0;
    const threshold = window.innerWidth * 0.38;

    const cleanupSwipe = () => {
      if (swipeQueenEl) { swipeQueenEl.remove(); swipeQueenEl = null; }
      if (swipeAceEl) { swipeAceEl.remove(); swipeAceEl = null; }
    };

    if (dx >= threshold) {
      // Commit: slide queen off to the right, then navigate back.
      if (swipeQueenEl) {
        swipeQueenEl.style.transition = "transform 0.25s ease-out";
        swipeQueenEl.style.transform = `translateX(${window.innerWidth}px)`;
      }
      setTimeout(() => {
        // Render home while queen is off-screen (translateX = 100vw, invisible).
        goBack({ animate: false });
        // Wait 2 rAFs for body.isHome class + layout to fully settle before
        // removing the ace, so there's no flash of an intermediate home state.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            cleanupSwipe();
          });
        });
      }, 250);
    } else {
      // Cancel: snap queen back to its original position.
      if (swipeQueenEl) {
        swipeQueenEl.style.transition = "transform 0.22s ease-out";
        swipeQueenEl.style.transform = "translateX(0)";
      }
      setTimeout(cleanupSwipe, 220);
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
      const canGo = goingNext
        ? ((state.player?.queue || []).length > 0 || !!state.player?.repeat)
        : ((state.player?.playHistory || []).length > 0 || (globalAudio && globalAudio.currentTime > 3));
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
        const canGoForward = (state.player?.queue || []).length > 0 || !!state.player?.repeat;
        const canGoBack = ((state.player?.playHistory || []).length > 0) || (globalAudio && globalAudio.currentTime > 3);
        const isDead = goNext ? !canGoForward : !canGoBack;
        if (isDead) {
          // Rubber band spring back
          if (inner) { inner.style.transition = 'transform 360ms cubic-bezier(.36,.07,.19,.97)'; inner.style.transform = 'translateX(0)'; }
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
          if (globalAudio && globalAudio.currentTime > 3) {
            peekSong = getSong(state.player?.nowPlaying?.songId); // restart — same song
          } else {
            const prevRef = (state.player?.playHistory || []).at?.(-1);
            if (prevRef) peekSong = getSong(prevRef.songId);
          }
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
        if (inner) { inner.style.transition = 'transform 220ms ease'; inner.style.transform = `translateX(${flyTo})`; }
        requestAnimationFrame(() => requestAnimationFrame(() => {
          ghost.style.transition = 'transform 220ms ease';
          ghost.style.transform = 'translateX(0)';
        }));

        miniPlayerEl.dataset.suppressClick = "1";
        setTimeout(() => {
          if (goNext) advanceToNextTrack({ render: false });
          else        advanceToPrevTrack({ render: false });
          ghost.remove();
          if (inner) { inner.style.transition = 'none'; inner.style.transform = 'translateX(0)'; }
          syncMiniPlayerUI();
        }, 240);
      } else {
        if (inner) { inner.style.transition = 'transform 180ms ease'; inner.style.transform = 'translateX(0)'; }
      }
    } else {
      if (didDrag && dy > 12) { stopAndResetPlayback(); return; }
      miniPlayerEl.style.transition = "transform 160ms ease";
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

  prevTabBeforeFullPlayer = currentTab;
  prevSelectedSongIdBeforeFullPlayer = selectedSongId;

  // Clear any drawer/project state so the render router reaches the player
  drawerView = null;
  projectDetailScreen = null;

  currentTab = "player";
  playerScreen = "now";
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
  if (q.length) {
    if (state.player.nowPlaying) {
      if (!state.player.playHistory) state.player.playHistory = [];
      state.player.playHistory.push(state.player.nowPlaying);
    }
    _miniCarouselDir = 1; // forward → slide left
    state.player.nowPlaying = q.shift();
    saveState();
    playNowPlaying({ autoplay: true });
    if (doRender) render();
    return true;
  }
  // Queue exhausted — rebuild from repeatQueue if repeat-all is on
  if (state.player?.repeat === true) {
    const rq = state.player?.repeatQueue || [];
    if (rq.length) {
      if (state.player.nowPlaying) {
        if (!state.player.playHistory) state.player.playHistory = [];
        state.player.playHistory.push(state.player.nowPlaying);
      }
      _miniCarouselDir = 1; // forward → slide left
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

globalAudio?.addEventListener("ended", () => {
  if (!advanceToNextTrack({ render: fullPlayerOpen })) syncMiniPlayerUI();
});

// ---------------------
// Bottom sheet (GLOBAL)
// ---------------------
const sheet = $("#createSheet");
const sheetOverlay = $("#sheetOverlay");
const sheetContent = $("#sheetContent");
let sheetMode = "chooser"; // chooser | song | lyrics | release | songMenu | versionMenu | songFilters
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
    const existingProjects = [...new Set(
      state.songs.map(s => (s.project || "").trim()).filter(Boolean)
    )].sort();
    const defaultProj = state.settings.defaultProject || "";

    sheetContent.innerHTML = `
      <div class="sheetTitle">New song</div>

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

    $("#sheetSongProject")?.addEventListener("change", (e) => {
      const isNew = e.target.value === "__new__";
      const inp = $("#sheetNewProject");
      if (inp) { inp.style.display = isNew ? "block" : "none"; }
      if (isNew) setTimeout(() => $("#sheetNewProject")?.focus(), 0);
    });

    $("#sheetBack")?.addEventListener("click", () => openSheet("chooser"));

    $("#sheetCreateSong")?.addEventListener("click", () => {
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
      drawerView = "releases";
      releaseDetailId = null;
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
  // Snapshot current screen content so back-swipe peek can show it behind the next screen
  if (activeScreenEl?.innerHTML) {
    backPeekHTML = activeScreenEl.innerHTML;
    prevAceViewTop = activeScreenEl.getBoundingClientRect().top || 0;
    prevAceScrollTop = activeScreenEl.scrollTop || 0;
    // Capture topbar state BEFORE setHeader/syncBackButton change it, so the ace overlay
    // can show the correct previous-screen title and back-button state during the slide.
    const _tb = document.querySelector(".topbar");
    const _tbRect = _tb?.getBoundingClientRect();
    const _tbVisible = _tbRect && _tbRect.height > 0;
    prevTopbarHTML = _tbVisible ? (_tb?.outerHTML || "") : "";
    prevTopbarRect = _tbVisible ? { top: _tbRect.top, height: _tbRect.height } : null;
  }

  if (!view) return;

  syncTabs();
  syncBackButton();

    // ✅ Enforce fullscreen player state every render (no overlap, no reserved padding)
  setFullPlayerOpen(!!fullPlayerOpen);

  document.body.classList.toggle(
    "isHome",
    currentTab === "home" && !drawerView && !overlayView && !selectedSongId && !selectedVersionId
  );
  document.body.classList.toggle(
    "hasHeaderGrad",
    currentTab === "songs" ||
    currentTab === "player" ||
    currentTab === "collab" ||
    drawerView === "projects" ||
    drawerView === "releases" ||
    drawerView === "eps" ||
    drawerView === "collabs"
  );

  // Drawer screens
  if (drawerView === "projects") { setActiveScreen("drawer"); return projectDetailScreen ? renderProjectSongs(projectDetailScreen) : renderProjects(); }
  if (drawerView === "releases") { setActiveScreen("drawer"); return releaseDetailId ? renderReleaseDetail(releaseDetailId) : renderReleases(); }
  if (drawerView === "eps") { setActiveScreen("drawer"); return renderEPs(); }
  if (drawerView === "collabs") { setActiveScreen("drawer"); return renderCollaborators(); }
  if (drawerView === "importExport") { setActiveScreen("drawer"); return renderImportExport(); }
  if (drawerView === "about") { setActiveScreen("drawer"); return renderAbout(); }
  if (drawerView === "globalSearch") { setActiveScreen("drawer"); return renderGlobalSearch(); }

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
  if (currentTab === "collab") { setActiveScreen("collab"); return renderCollab(); }
  if (currentTab === "settings") { setActiveScreen("settings"); return renderSettings(); }
}

scheduleDockSpaceSync();

// Pre-fetch the active version's Drive audio for every song so first play is instant.
// Runs in the background after init — caches blobs in IndexedDB keyed by driveFileId.
async function preFetchDriveAudio() {
  // Only run when a token is already in memory — never triggers a sign-in popup
  if (!gdriveIsConnected() || !gdriveHasValidToken()) return;
  for (const song of (state.songs || [])) {
    for (const v of (song.versions || [])) {
      if (!v.driveFileId || v.fileId) continue; // no Drive file, or local copy already exists
      const dbKey = `gdrive:${v.driveFileId}`;
      const existing = await audioGet(dbKey);
      if (existing?.blob) continue; // already cached
      const blob = await gdriveFetchBlob(v.driveFileId);
      if (blob) {
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

async function init() {
  if (!DISABLE_SPLASH) {
    await runSplashSequence();
  } else {
    const splash = document.getElementById("splash");
    if (splash) splash.remove();
    await new Promise(r => requestAnimationFrame(r));
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

  let projQuery = "";

  const buildRows = (q) => projects
    .filter(p => !q || p.toLowerCase().includes(q.toLowerCase()))
    .map(p => {
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
    <div class="songsHead">
      <div class="songsBar">
        <input id="projSearch" type="text" placeholder="Search projects..." />
      </div>
    </div>
    <div id="projList" class="songsList">
      ${buildRows("") || `<div class="small">No projects yet.</div>`}
    </div>
  `;

  const projListEl = $("#projList");

  const applyProjFilter = () => {
    projQuery = ($("#projSearch")?.value || "");
    const html = buildRows(projQuery);
    projListEl.innerHTML = html || `<div class="small">No matches.</div>`;
    projListEl.querySelectorAll("[data-open-proj]").forEach(row => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("[data-proj-more]")) return;
        projectDetailScreen = row.getAttribute("data-open-proj");
        render();
        triggerForwardSlide();
      });
    });
    projListEl.querySelectorAll("[data-proj-more]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openProjectMenu(btn.getAttribute("data-proj-more"));
      });
    });
  };

  $("#projSearch")?.addEventListener("input", applyProjFilter);
  applyProjFilter();
}

function renderProjectSongs(projectName) {
  setHeader(projectName);

  if (activeScreenEl) activeScreenEl.scrollTop = 0;

  const songs = state.songs.filter(s => (s.project || "").trim() === projectName);

  const items = songs
    .filter(s => (s.versions || []).length)
    .map(s => {
      const vv = s.versions.find(v => v.isActive) || s.versions[0];
      return { songId: s.id, versionId: vv.id };
    });

  const fakeSong = { id: projectName, title: projectName, project: projectName, genre: "" };
  const heroCover = coverSvg(fakeSong);

  const rows = songs.map(s => {
    return `
      <div class="songRow" data-open-song="${s.id}">
        <div class="songThumb" aria-hidden="true">
          ${coverSvg(s, { lite: true })}
        </div>
        <div class="songMain">
          <div class="songTop">
            <div class="songTitleRow">
              <div class="songTitle">${escapeHtml(s.title || "Untitled")}</div>
            </div>
            <button class="songMore" data-proj-song-more="${s.id}" aria-label="Song menu">⋯</button>
          </div>
          <div class="songSub">${escapeHtml(s.genre || s.project || "—")}</div>
        </div>
      </div>
    `;
  }).join("");

  activeScreenEl.innerHTML = `
    <div class="albumHero">
      <div class="albumBg" aria-hidden="true">
        ${heroCover}
      </div>

      <div class="albumTop">
        <div class="albumArt" aria-hidden="true">
          ${heroCover}
        </div>
        <div class="albumText">
          <div class="albumTitle">${escapeHtml(projectName)}</div>
          <div class="albumMeta">${songs.length} song${songs.length === 1 ? "" : "s"}</div>
        </div>
      </div>

      <div class="albumActions">
        <button class="songHeroPlay" id="projPlayAll" ${!items.length ? "disabled" : ""}>▶ Play All</button>
        <button class="songHeroQueue" id="projShuffle" ${!items.length ? "disabled" : ""}>⇄ Shuffle</button>
      </div>
    </div>

    <div class="versionsWrap">
      <div class="versionsHeader">
        <div class="versionsTitle">Songs</div>
      </div>
      <div id="projSongList" class="versionsRows songsList">
        ${rows || `<div class="small" style="padding:12px 2px">No songs in this project yet.</div>`}
      </div>
    </div>
  `;

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
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-proj-song-more]")) return;
      const sid = row.getAttribute("data-open-song");
      projectDetailScreen = null;
      drawerView = null;
      currentTab = "songs";
      songsView = "detail";
      selectedSongId = sid;
      selectedVersionId = null;
      render();
      triggerForwardSlide();
    });
  });

  activeScreenEl.querySelectorAll("[data-proj-song-more]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openSongMenu(btn.getAttribute("data-proj-song-more"));
    });
  });
}

function renderReleases() {
  setHeader("Releases");

  const releases = state.releases || [];

  const fmtDate = (d) => {
    if (!d) return "No date set";
    const [y, m, day] = d.split("-");
    return new Date(+y, +m - 1, +day).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  const rows = releases.map(r => {
    const count = (r.songIds || []).length;
    const fakeSong = { id: r.id, title: r.title, project: r.artist, genre: "" };
    return `
      <div class="songRow" data-rel-open="${escapeHtml(r.id)}">
        <div class="songThumb" aria-hidden="true">${coverSvg(fakeSong, { lite: true })}</div>
        <div class="songMain">
          <div class="songTop">
            <div class="songTitleRow"><div class="songTitle">${escapeHtml(r.title)}</div></div>
          </div>
          <div class="songSub">${escapeHtml(r.artist || "—")} · ${escapeHtml(fmtDate(r.releaseDate))} · ${count} song${count === 1 ? "" : "s"}</div>
        </div>
      </div>
    `;
  }).join("");

  activeScreenEl.innerHTML = `
    <div class="songsHead">
      <div class="songsBar" style="justify-content:space-between;align-items:center">
        <span style="font-size:15px;font-weight:600;color:rgba(255,255,255,.6)">${releases.length} release${releases.length === 1 ? "" : "s"}</span>
        <button class="btn" id="addReleaseBtn" style="padding:6px 14px;font-size:13px">+ Add Release</button>
      </div>
    </div>
    <div class="songsList">
      ${rows || `<div class="small">No releases yet. Tap "+ Add Release" to plan your first drop.</div>`}
    </div>
  `;

  activeScreenEl.querySelectorAll("[data-rel-open]").forEach(row => {
    row.addEventListener("click", () => {
      releaseDetailId = row.getAttribute("data-rel-open");
      render();
      triggerForwardSlide();
    });
  });

  $("#addReleaseBtn")?.addEventListener("click", () => openSheet("release"));
}

function renderReleaseDetail(releaseId) {
  const release = (state.releases || []).find(r => r.id === releaseId);
  if (!release) { releaseDetailId = null; return renderReleases(); }

  setHeader(release.title);
  if (activeScreenEl) activeScreenEl.scrollTop = 0;

  const fmtDate = (d) => {
    if (!d) return "No date set";
    const [y, m, day] = d.split("-");
    return new Date(+y, +m - 1, +day).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  };

  const songs = (release.songIds || [])
    .map(id => state.songs.find(s => s.id === id))
    .filter(Boolean);

  const items = songs
    .filter(s => (s.versions || []).length)
    .map(s => {
      const vv = s.versions.find(v => v.isActive) || s.versions[0];
      return { songId: s.id, versionId: vv.id };
    });

  const fakeSong = { id: release.id, title: release.title, project: release.artist, genre: "" };
  const heroCover = coverSvg(fakeSong);

  const rows = songs.map(s => {
    return `
      <div class="songRow" data-open-song="${s.id}">
        <div class="songThumb" aria-hidden="true">${coverSvg(s, { lite: true })}</div>
        <div class="songMain">
          <div class="songTop">
            <div class="songTitleRow"><div class="songTitle">${escapeHtml(s.title || "Untitled")}</div></div>
          </div>
          <div class="songSub">${escapeHtml(s.genre || s.project || "—")}</div>
        </div>
      </div>
    `;
  }).join("");

  activeScreenEl.innerHTML = `
    <div class="albumHero">
      <div class="albumBg" aria-hidden="true">${heroCover}</div>
      <div class="albumTop">
        <div class="albumArt" aria-hidden="true">${heroCover}</div>
        <div class="albumText">
          <div class="albumTitle">${escapeHtml(release.title)}</div>
          <div class="albumMeta">${escapeHtml(release.artist || "—")} · ${escapeHtml(fmtDate(release.releaseDate))}</div>
        </div>
      </div>
      <div class="albumActions">
        <button class="songHeroPlay" id="relPlayAll" ${!items.length ? "disabled" : ""}>▶ Play All</button>
        <button class="songHeroQueue" id="relShuffle" ${!items.length ? "disabled" : ""}>⇄ Shuffle</button>
      </div>
    </div>

    <div class="versionsWrap">
      <div class="versionsHeader">
        <div class="versionsTitle">Songs (${songs.length})</div>
      </div>
      <div class="versionsRows songsList">
        ${rows || `<div class="small" style="padding:12px 2px">No songs linked to this release yet.</div>`}
      </div>
    </div>
  `;

  $("#relPlayAll")?.addEventListener("click", async () => {
    if (!items.length) return toast("No playable songs 😅");
    const all = [...items];
    state.player.nowPlaying = all[0];
    state.player.queue = all.slice(1);
    state.player.repeatQueue = all;
    saveState();
    await playNowPlaying({ autoplay: true });
    toast("Playing ▶️");
  });

  $("#relShuffle")?.addEventListener("click", async () => {
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
      releaseDetailId = null;
      drawerView = null;
      currentTab = "songs";
      songsView = "detail";
      selectedSongId = row.getAttribute("data-open-song");
      selectedVersionId = null;
      render();
      triggerForwardSlide();
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
      <div class="small">Pulled from song "Collaborators" field (comma-separated).</div>
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

  activeScreenEl.innerHTML = `
    <div class="homeWrap">
      <div class="homeTopbar">
        <div class="homeTopbarLeft">
          <span class="homeTopTitle">Build your sound</span>
        </div>
        <div class="homeTopbarRight">
          <button class="htbBtn" id="htbNotif" aria-label="Notifications">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
          </button>
          <button class="htbBtn" id="htbSearch" aria-label="Search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </button>
          <button class="htbBtn" id="htbSettings" aria-label="Settings">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/>
              <path d="M10.29 3.86a1 1 0 0 1 3.42 0l.38 1.32a7 7 0 0 1 1.73.99l1.32-.42a1 1 0 0 1 1.14.46l1.71 2.96a1 1 0 0 1-.26 1.31l-1.08.77c.04.25.05.5.05.75s-.01.5-.05.75l1.08.77a1 1 0 0 1 .26 1.31l-1.71 2.96a1 1 0 0 1-1.14.46l-1.32-.42a7 7 0 0 1-1.73.99l-.38 1.32a1 1 0 0 1-3.42 0l-.38-1.32a7 7 0 0 1-1.73-.99l-1.32.42a1 1 0 0 1-1.14-.46l-1.71-2.96a1 1 0 0 1 .26-1.31l1.08-.77A7.1 7.1 0 0 1 5.3 12c0-.25.01-.5.05-.75l-1.08-.77a1 1 0 0 1-.26-1.31l1.71-2.96a1 1 0 0 1 1.14-.46l1.32.42a7 7 0 0 1 1.73-.99l.38-1.32Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>

      <div class="homeScene">
        <div class="homeGrid">

          <!-- Songs — tall left card, spans 2 rows -->
          <button class="hCard hSongs" data-home="songs" aria-label="Songs">
            <div class="hArt"><img src="./songs-card.jpg" style="width:100%;height:100%;object-fit:cover;object-position:35% center;display:block;"></div>
            <div class="hGrad"></div>
            <div class="hBody">
              <div class="hLabel">Songs</div>
            </div>
          </button>

          <!-- Projects — small, right column top -->
          <button class="hCard hProjects" data-home="projects" aria-label="Projects">
            <div class="hArt"><img src="./projects-card.jpg" style="width:100%;height:100%;object-fit:cover;object-position:center 22%;display:block;"></div>
            <div class="hGrad"></div>
            <div class="hBody">
              <div class="hLabel">Projects</div>
            </div>
          </button>

          <!-- Releases — small, right column bottom -->
          <button class="hCard hPlayer" data-home="releases" aria-label="Releases">
            <div class="hArt"><img src="./releases-card.jpg" style="width:100%;height:100%;object-fit:cover;object-position:center 45%;display:block;"></div>
            <div class="hGrad"></div>
            <div class="hBody">
              <div class="hLabel">Releases</div>
            </div>
          </button>

          <!-- Lyrics — full width -->
          <button class="hCard hLyrics hWide" data-home="lyrics" aria-label="Lyrics">
            <div class="hArt"><img src="./lyrics-card.jpg" style="width:100%;height:150%;object-fit:cover;transform:scale(1.1);display:block;"></div>
            <div class="hGrad"></div>
            <div class="hBody">
              <div class="hLabel">Lyrics</div>
            </div>
          </button>

          <!-- Actions — full width -->
          <button class="hCard hNext hWide" data-home="next" aria-label="Actions">
            <div class="hArt"><img src="./actions-card.jpg" style="width:100%;height:100%;object-fit:cover;transform:scale(1.1);display:block;"></div>
            <div class="hGrad"></div>
            <div class="hBody">
              <div class="hLabel">Actions</div>
            </div>
          </button>

        </div>
      </div>
    </div>
  `;

  // Topbar button actions
  activeScreenEl.querySelector("#htbNotif")?.addEventListener("click", () => toast("Notifications coming soon"));
  activeScreenEl.querySelector("#htbSearch")?.addEventListener("click", () => {
    drawerView = "globalSearch";
    setActiveScreen("drawer");
    renderGlobalSearch();
  });
  activeScreenEl.querySelector("#htbSettings")?.addEventListener("click", () => {
    currentTab = "settings";
    setHeader("Settings");
    syncTabs();
    render();
  });

  // Card navigation
  activeScreenEl.querySelectorAll("[data-home]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-home");
      if (target === "songs") {
        resetSongsFilters({ keepSort: true });
        songsBackTarget = null;
        currentTab = "songs";
        songsView = "list";
        selectedSongId = null;
        setHeader("Songs");
        syncTabs();
        render();
        triggerForwardSlide();
        return;
      }
      if (target === "projects") { setDrawerView("projects"); triggerForwardSlide(); return; }
      if (target === "releases") { setDrawerView("releases"); triggerForwardSlide(); return; }
      if (target === "lyrics") return renderLyricsScratch();
      if (target === "next") return renderNextActions();
    });
  });

  // Card elastic stretch effect — cards stretch subtly in the swipe direction
  const homeGrid = activeScreenEl.querySelector(".homeGrid");
  if (homeGrid) {
    const cards = [...homeGrid.querySelectorAll(".hCard")];
    let hgStartX = 0, hgStartY = 0, hgDragged = false;

    homeGrid.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      hgStartX = e.touches[0].clientX;
      hgStartY = e.touches[0].clientY;
      hgDragged = false;
      cards.forEach(c => { c.style.transition = "none"; });
    }, { passive: true });

    homeGrid.addEventListener("touchmove", (e) => {
      if (e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - hgStartX;
      const dy = e.touches[0].clientY - hgStartY;
      // Mark as a drag once movement exceeds tap threshold
      if (!hgDragged && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
        hgDragged = true;
        homeGrid.classList.add("is-dragging");
      }
      const MAX = 0.038;
      const fy = Math.tanh(Math.abs(dy) / 110) * MAX;
      const fx = Math.tanh(Math.abs(dx) / 160) * MAX * 0.55;
      const originY = dy >= 0 ? "top" : "bottom";
      const originX = dx >= 0 ? "left" : "right";
      cards.forEach(c => {
        c.style.transformOrigin = `${originX} ${originY}`;
        c.style.transform = `scaleX(${1 + fx}) scaleY(${1 + fy})`;
      });
    }, { passive: true });

    const snapBack = () => {
      homeGrid.classList.remove("is-dragging");
      // If a drag occurred, intercept the upcoming synthetic click so cards don't navigate
      if (hgDragged) {
        homeGrid.addEventListener("click", e => { e.stopPropagation(); e.preventDefault(); }, { once: true, capture: true });
      }
      cards.forEach(c => {
        c.style.transition = "transform 0.5s cubic-bezier(.34,1.56,.64,1)";
        c.style.transform = "";
        c.addEventListener("transitionend", () => {
          c.style.transition = "";
          c.style.transformOrigin = "";
        }, { once: true });
      });
    };
    homeGrid.addEventListener("touchend", snapBack, { passive: true });
    homeGrid.addEventListener("touchcancel", () => {
      homeGrid.classList.remove("is-dragging");
      cards.forEach(c => { c.style.transition = ""; c.style.transform = ""; c.style.transformOrigin = ""; });
    }, { passive: true });
  }
}

function renderCollab() {
  setHeader("Collab");
  activeScreenEl.innerHTML = `
    <div style="padding: 40px 24px; text-align: center;">
      <div style="font-size: 48px; margin-bottom: 16px;">🤝</div>
      <div style="font-size: 22px; font-weight: 800; color: #fff; margin-bottom: 8px;">Collab</div>
      <div style="font-size: 14px; color: rgba(255,255,255,.5); line-height: 1.5;">Connect and collaborate with other artists.<br>Coming soon.</div>
    </div>
  `;
}

function renderGlobalSearch() {
  setHeader("Search");
  activeScreenEl.innerHTML = `
    <div class="gsWrap">
      <div class="gsTopbar">
        <div class="gsInputWrap">
          <span class="gsInputIcon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </span>
          <input id="gsInput" class="gsInput" type="text" placeholder="Songs, projects, lyrics..." autocomplete="off" autocorrect="off" spellcheck="false"/>
        </div>
        <button class="gsCancel" id="gsCancel">Cancel</button>
      </div>
      <div id="gsBody" class="gsBody">
        <div class="gsEmpty">
          <div class="gsEmptyTitle">Find what you need</div>
          <div class="gsEmptySub">Search for songs, projects, releases, lyrics, or collaborators.</div>
        </div>
      </div>
    </div>
  `;

  const input = activeScreenEl.querySelector("#gsInput");
  const body = activeScreenEl.querySelector("#gsBody");

  setTimeout(() => input?.focus(), 80);

  activeScreenEl.querySelector("#gsCancel").addEventListener("click", () => {
    drawerView = null;
    setHeader(TAB_TITLES[currentTab] || "RiffBank");
    render();
  });

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      body.innerHTML = `
        <div class="gsEmpty">
          <div class="gsEmptyTitle">Find what you need</div>
          <div class="gsEmptySub">Search for songs, projects, releases, lyrics, or collaborators.</div>
        </div>`;
      return;
    }
    renderSearchResults(q, body);
  });
}

function renderSearchResults(q, container) {
  const songs = state.songs || [];

  // Songs (by title or tags)
  const songMatches = songs.filter(s =>
    (s.title || "").toLowerCase().includes(q) ||
    (s.tags || "").toLowerCase().includes(q)
  );

  // Projects
  const allProjects = [...new Set(songs.map(s => (s.project || "").trim()).filter(Boolean))];
  const projMatches = allProjects.filter(p => p.toLowerCase().includes(q));

  // Collaborators
  const allCollabs = [...new Set(songs.flatMap(s =>
    (s.collaborators || "").split(",").map(c => c.trim()).filter(Boolean)
  ))];
  const collabMatches = allCollabs.filter(c => c.toLowerCase().includes(q));

  // Lyrics (songs where lyrics field matches but title doesn't)
  const lyricsMatches = songs.filter(s =>
    (s.lyrics || "").toLowerCase().includes(q) &&
    !(s.title || "").toLowerCase().includes(q)
  );

  if (!songMatches.length && !projMatches.length && !collabMatches.length && !lyricsMatches.length) {
    container.innerHTML = `<div class="gsEmpty"><div class="gsEmptyTitle">No results for "${escapeHtml(q)}"</div><div class="gsEmptySub">Try a different search term.</div></div>`;
    return;
  }

  let html = "";

  if (songMatches.length) {
    html += `<div class="gsSection"><div class="gsSectionTitle">Songs</div>${
      songMatches.slice(0, 6).map(s => `
        <button class="gsRow" data-type="song" data-id="${s.id}">
          <div class="gsRowArt">${coverSvg(s, { lite: true })}</div>
          <div class="gsRowMeta">
            <div class="gsRowTitle">${escapeHtml(s.title || "Untitled")}</div>
            <div class="gsRowSub">${escapeHtml(s.project || "")}</div>
          </div>
        </button>`).join("")
    }</div>`;
  }

  if (projMatches.length) {
    html += `<div class="gsSection"><div class="gsSectionTitle">Projects</div>${
      projMatches.slice(0, 5).map(p => `
        <button class="gsRow" data-type="project" data-id="${escapeHtml(p)}">
          <div class="gsRowIcon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
          </div>
          <div class="gsRowMeta">
            <div class="gsRowTitle">${escapeHtml(p)}</div>
            <div class="gsRowSub">${songs.filter(s => (s.project || "").trim() === p).length} songs</div>
          </div>
        </button>`).join("")
    }</div>`;
  }

  if (collabMatches.length) {
    html += `<div class="gsSection"><div class="gsSectionTitle">Collaborators</div>${
      collabMatches.slice(0, 5).map(c => `
        <button class="gsRow" data-type="collab" data-collab="${escapeHtml(c)}">
          <div class="gsRowIcon gsRowIconPurple">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </div>
          <div class="gsRowMeta">
            <div class="gsRowTitle">${escapeHtml(c)}</div>
            <div class="gsRowSub">${songs.filter(s => (s.collaborators || "").toLowerCase().includes(c.toLowerCase())).length} songs together</div>
          </div>
        </button>`).join("")
    }</div>`;
  }

  if (lyricsMatches.length) {
    html += `<div class="gsSection"><div class="gsSectionTitle">Lyrics</div>${
      lyricsMatches.slice(0, 4).map(s => `
        <button class="gsRow" data-type="song" data-id="${s.id}">
          <div class="gsRowIcon gsRowIconGreen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
          </div>
          <div class="gsRowMeta">
            <div class="gsRowTitle">${escapeHtml(s.title || "Untitled")}</div>
            <div class="gsRowSub">Lyrics match</div>
          </div>
        </button>`).join("")
    }</div>`;
  }

  container.innerHTML = html;

  container.querySelectorAll(".gsRow").forEach(btn => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.type;
      drawerView = null;
      if (type === "song") {
        currentTab = "songs";
        songsView = "list";
        selectedSongId = btn.dataset.id;
        selectedVersionId = null;
        setHeader("Song");
        syncTabs();
        render();
      } else if (type === "project") {
        drawerView = "projects";
        projectDetailScreen = btn.dataset.id;
        setActiveScreen("drawer");
        renderProjectSongs(projectDetailScreen);
      } else if (type === "collab") {
        resetSongsFilters({ keepSort: true });
        currentTab = "songs";
        songsView = "list";
        selectedSongId = null;
        setHeader("Songs");
        syncTabs();
        render();
        setTimeout(() => {
          const inp = document.querySelector(".songsBar input");
          if (inp) { inp.value = btn.dataset.collab; inp.dispatchEvent(new Event("input")); }
        }, 100);
      }
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
      triggerForwardSlide();
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
const generatingArtSongs = new Set(); // song IDs currently generating art

// Global handler: refresh cover image from Drive when cached URL expires
window._refreshCoverFromDrive = async (songId, driveFileId, imgEl) => {
  const url = await gdriveGetStreamUrl(driveFileId);
  if (url && imgEl) {
    imgEl.src = url;
    // Update song state so future renders use fresh URL
    const song = state.songs.find(s => s.id === songId);
    if (song) {
      song.coverImageUrl = url;
      coverCache.clear();
      saveState();
    }
  }
};
let artCooldownUntil = 0; // timestamp — global 10s cooldown after any art request
const bulkArtState = { running: false, done: 0, total: 0 }; // bulk art gen progress

function buildArtPrompt(song) {
  // Deterministic hash from song title + project to pick scene/style combos
  const seed = (song.title || "").length * 7 + (song.project || "").length * 13
    + (song.title || "").charCodeAt(0) * 31
    + ((song.title || "").charCodeAt(1) || 0) * 17;

  const scenes = [
    "vast mountain landscape at golden hour, dramatic peaks, alpine lake reflection, wildflowers in foreground, volumetric light rays through clouds",
    "deep ocean underwater scene, bioluminescent jellyfish, coral reef, shafts of sunlight through water, ethereal blue-green glow, floating particles",
    "abandoned industrial warehouse, shattered windows, overgrown vines reclaiming concrete, dramatic god-rays, dust particles in light beams",
    "dense enchanted forest, towering ancient trees, mystical fog, fireflies glowing, moss-covered roots, dappled moonlight filtering through canopy",
    "vast desert at twilight, sand dunes with wind ripples, lone joshua tree silhouette, purple-orange gradient sky, stars emerging",
    "futuristic neon cityscape from rooftop, holographic billboards, flying vehicles, rain-slicked streets far below, cyberpunk atmosphere, glowing windows",
    "frozen tundra landscape, northern lights aurora borealis, ice formations, starfield sky, teal and purple light dancing, snow-covered terrain",
    "lush tropical coastline at sunset, palm trees swaying, turquoise waves crashing, dramatic cloud formations, golden hour warmth, volcanic island in distance",
    "cosmic nebula scene, swirling galaxies, colorful interstellar gas clouds, distant stars, asteroid field, deep space, celestial wonder",
    "overgrown ancient temple ruins, jungle reclaiming stone architecture, shafts of green-tinted light, carved stone faces, hanging vines, mystical atmosphere",
    "stormy seascape, towering waves, lightning illuminating dark clouds, lighthouse beam cutting through rain, dramatic ocean spray, powerful nature",
    "cherry blossom garden at night, lantern-lit pathway, pink petals falling, koi pond reflection, misty atmosphere, Japanese aesthetic",
    "volcanic landscape, molten lava flows, dark rock formations, fiery orange glow against dark sky, smoke and ash, raw elemental power",
    "abstract fluid art, swirling metallic paint, iridescent colors blending, macro photography feel, glossy surface tension, mesmerizing patterns",
    "sunflower field stretching to horizon, dramatic cumulus clouds, warm afternoon light, single weathered barn, painted sky, rural serenity",
    "underground crystal cavern, massive amethyst and quartz formations, underground river, bioluminescent fungi, prismatic light reflections",
  ];

  const styles = [
    "cinematic photography",
    "oil painting, thick brushstrokes",
    "moody atmospheric digital art",
    "watercolor illustration, soft edges",
    "retro analog film grain aesthetic",
    "hyper-detailed digital matte painting",
    "minimalist graphic art, bold shapes",
    "dreamlike surrealist composition",
  ];

  const palettes = [
    "warm amber and deep crimson tones",
    "cool blues and silver moonlight",
    "vibrant teal and electric magenta",
    "muted earth tones, olive and rust",
    "pastel pink and lavender haze",
    "deep indigo and gold accents",
    "emerald green and copper highlights",
    "monochrome with one vivid accent color",
  ];

  const scene = scenes[seed % scenes.length];
  const style = styles[(seed * 3 + 5) % styles.length];
  const palette = palettes[(seed * 7 + 11) % palettes.length];

  return [
    "album cover art",
    song.genre ? `${song.genre} music mood` : null,
    scene,
    style,
    palette,
    "no text, no words, no letters, no numbers, no typography, no writing, no logos, no symbols, no watermarks, textless, wordless, purely visual composition, square format"
  ].filter(Boolean).join(", ");
}

async function generateArtForSong(song, apiKey) {
  const prompt = buildArtPrompt(song);
  const res = await fetch("https://riffbank-art.riffbank.workers.dev", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: { prompt, aspect_ratio: "1:1" } })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || data.title || JSON.stringify(data));
  if (!data.output) throw new Error("No image returned");
  const url = Array.isArray(data.output) ? data.output[0] : data.output;

  // Download image and upload to Google Drive for persistence
  try {
    const imgRes = await fetch(url);
    if (imgRes.ok) {
      const blob = await imgRes.blob();
      const driveResult = await gdriveUploadCoverArt({
        blob,
        project: song.project,
        songTitle: song.title,
      });
      if (driveResult.success) {
        song.coverDriveFileId = driveResult.driveFileId;
      }
    }
  } catch (e) {
    console.warn("Cover art Drive upload failed (art still saved as URL):", e);
  }

  song.coverImageUrl = url;
  song.updatedAt = nowStamp();
}

async function startBulkGenArt(onlyMissing) {
  if (bulkArtState.running) { toast("Bulk art generation already in progress"); return; }

  const apiKey = state.settings.replicateKey || "";
  if (!apiKey) { toast("Add your Replicate API key first"); return; }

  const songs = onlyMissing
    ? state.songs.filter(s => !s.coverImageUrl)
    : [...state.songs];

  if (!songs.length) { toast(onlyMissing ? "All songs already have art" : "No songs to generate art for"); return; }

  const label = onlyMissing ? "missing" : "all";
  if (!confirm(`Generate art for ${songs.length} ${label} song${songs.length === 1 ? "" : "s"}? This may take a while.`)) return;

  bulkArtState.running = true;
  bulkArtState.done = 0;
  bulkArtState.total = songs.length;
  for (const s of songs) generatingArtSongs.add(s.id);
  coverCache.clear();
  render();

  let succeeded = 0;
  let lastError = "";

  for (const song of songs) {
    try {
      await generateArtForSong(song, apiKey);
      succeeded++;
    } catch (e) {
      console.error(`Art gen failed for "${song.title}":`, e);
      lastError = e.message;
    }
    generatingArtSongs.delete(song.id);
    coverCache.clear();
    bulkArtState.done++;
    saveState();
    // Rate limit: wait 12s between requests (6 req/min limit)
    if (bulkArtState.done < bulkArtState.total) await new Promise(r => setTimeout(r, 12000));
    // Update settings buttons if they're currently visible
    const btnMissing = $("#genMissingArt");
    const btnAll = $("#regenAllArt");
    if (btnMissing || btnAll) {
      const txt = `${bulkArtState.done}/${bulkArtState.total} done…`;
      if (btnMissing) { btnMissing.disabled = true; btnMissing.textContent = txt; }
      if (btnAll) { btnAll.disabled = true; btnAll.textContent = txt; }
    }
  }

  bulkArtState.running = false;
  coverCache.clear();
  const total = bulkArtState.total;
  if (succeeded === 0) {
    toast(lastError ? `Art generation failed: ${lastError}` : "No art was generated");
  } else if (succeeded < total) {
    toast(`Generated art for ${succeeded}/${total} songs (${total - succeeded} failed)`);
  } else {
    toast(`Generated art for ${succeeded} song${succeeded === 1 ? "" : "s"} ✨`);
  }
  render();
}

function isIOSDevice(){
  // iPadOS can report as MacIntel with touch points
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function coverSvg(song, { lite = false } = {}) {
  const forceLite = lite || isIOSDevice();
  const key = `${song.id}|${song.title}|${song.project}|${song.genre}|${song.coverImageUrl || ""}|${forceLite ? "lite" : "full"}`;

  if (generatingArtSongs.has(song.id)) {
    return `<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:linear-gradient(135deg,#1a1a2e,#16213e);border-radius:inherit;color:#888;font-size:13px;gap:8px">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 2s linear infinite">
        <path d="M12 2a10 10 0 0 1 10 10" /><style>@keyframes spin{to{transform:rotate(360deg)}}</style>
      </svg>
      <span style="opacity:.6">Generating…</span>
    </div>`;
  }

  if (coverCache.has(key)) return coverCache.get(key);

  if (song.coverImageUrl) {
    const errHandler = song.coverDriveFileId
      ? ` onerror="this.onerror=null;window._refreshCoverFromDrive&&window._refreshCoverFromDrive('${escapeHtml(song.id)}','${escapeHtml(song.coverDriveFileId)}',this)"`
      : "";
    const img = `<img src="${escapeHtml(song.coverImageUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block" loading="lazy" alt=""${errHandler}>`;
    coverCache.set(key, img);
    return img;
  }

  const seed = hashStr(`${song.id}|${song.title}|${song.project}|${song.genre}`);
  const r = makeRng(seed);
  const u = (seed >>> 0).toString(36); // unique prefix for SVG IDs

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
      <linearGradient id="g${u}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${c1}" stop-opacity=".95"/>
        <stop offset=".55" stop-color="${c2}" stop-opacity=".85"/>
        <stop offset="1" stop-color="${c3}" stop-opacity=".9"/>
      </linearGradient>
      <radialGradient id="v${u}" cx="50%" cy="45%" r="70%">
        <stop offset="55%" stop-color="rgba(0,0,0,0)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,.28)"/>
      </radialGradient>
    </defs>

    <rect width="120" height="120" fill="url(#g${u})"/>
    ${b.map(x => `<circle cx="${x.x}" cy="${x.y}" r="${x.rad}" fill="${x.col}" opacity=".22"/>`).join("")}

    <path d="M ${sx1} ${sy1} C ${sx1+35} ${sy1-30}, ${sx2-35} ${sy2+30}, ${sx2} ${sy2}"
      stroke="rgba(255,255,255,.55)" stroke-width="5" stroke-linecap="round" opacity=".18"/>

    <rect width="120" height="120" fill="url(#v${u})"/>
  </svg>` : `
  <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g${u}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${c1}" stop-opacity=".95"/>
        <stop offset=".55" stop-color="${c2}" stop-opacity=".85"/>
        <stop offset="1" stop-color="${c3}" stop-opacity=".9"/>
      </linearGradient>

      <filter id="b${u}">
        <feGaussianBlur stdDeviation="12" />
      </filter>

      <filter id="n${u}">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
        <feColorMatrix type="matrix" values="
          1 0 0 0 0
          0 1 0 0 0
          0 0 1 0 0
          0 0 0 .12 0"/>
      </filter>

      <filter id="w${u}">
        <feGaussianBlur stdDeviation="3" result="b"/>
        <feMerge>
          <feMergeNode in="b"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>

      <radialGradient id="v${u}" cx="50%" cy="45%" r="70%">
        <stop offset="55%" stop-color="rgba(0,0,0,0)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,.35)"/>
      </radialGradient>
    </defs>

    <rect width="120" height="120" fill="url(#g${u})"/>

    <g filter="url(#b${u})" opacity=".9">
      ${b.map(x => `<circle cx="${x.x}" cy="${x.y}" r="${x.rad}" fill="${x.col}" opacity=".55"/>`).join("")}
    </g>

    <path d="M ${sx1} ${sy1} C ${sx1+35} ${sy1-30}, ${sx2-35} ${sy2+30}, ${sx2} ${sy2}"
      stroke="rgba(255,255,255,.65)" stroke-width="6" stroke-linecap="round" opacity=".22" filter="url(#w${u})"/>

    <rect width="120" height="120" fill="url(#v${u})"/>
    <rect width="120" height="120" filter="url(#n${u})" opacity=".55"/>
  </svg>`;

  coverCache.set(key, svg);
  return svg;
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

    <div id="songList"></div>
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

    if (!filtered.length) {
      listEl.innerHTML = `<div class="small">No matches.</div>`;
    } else {
      // Group by artist (project field), sorted A-Z
      const groups = {};
      for (const s of filtered) {
        const artist = (s.project || "").trim() || "Unknown";
        (groups[artist] ||= []).push(s);
      }
      const sortedArtists = Object.keys(groups).sort((a, b) => a.localeCompare(b));

      const cardHtml = (s) => {
        const vCount = s.versions?.length || 0;
        return `
          <div class="songCard" data-id="${s.id}">
            <div class="songCardStack">
              <div class="songCardLayer songCardLayer2"></div>
              <div class="songCardLayer songCardLayer1"></div>
              <div class="songCardFront">
                <div class="songCardArt">${coverSvg(s, { lite: true })}</div>
              </div>
            </div>
            <div class="songCardInfo">
              <div class="songCardTitle">${escapeHtml(s.title)}</div>
              <div class="songCardSub">${vCount} ver${vCount !== 1 ? "s" : ""}</div>
            </div>
            <button class="songCardMore" data-more="${s.id}" aria-label="Song menu">⋯</button>
          </div>
        `;
      };

      listEl.innerHTML = sortedArtists.map(artist => `
        <div class="songsGroup">
          <div class="songsGroupHead">${escapeHtml(artist)}</div>
          <div class="songsGroupLine"></div>
          <div class="songsList">${groups[artist].map(cardHtml).join("")}</div>
        </div>
      `).join("");
    }

    listEl.querySelectorAll(".songCard[data-id]").forEach((el) => {
      el.addEventListener("click", () => {
        songsListScrollTop = activeScreenEl.scrollTop;
        selectedSongId = el.getAttribute("data-id");
        render();
        triggerForwardSlide();
      });
    });

    listEl.querySelectorAll(".songCardMore[data-more]").forEach((btn) => {
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
  // Restore scroll position when returning from a song detail view
  if (songsListScrollTop > 0) {
    activeScreenEl.scrollTop = songsListScrollTop;
  }
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
      <button class="songHeroQueue" id="genArtBtn" title="Generate AI cover art" ${generatingArtSongs.has(song.id) || Date.now() < artCooldownUntil ? "disabled" : ""}>
        ${generatingArtSongs.has(song.id) ? "✨ Generating…" : Date.now() < artCooldownUntil ? "⏳ Please wait…" : song.coverImageUrl ? "🔄 Regen Art" : "✨ Gen Art"}
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

  $("#songBigPlay")?.addEventListener("click", async () => {
    if (!(fv?.link || fv?.fileId || fv?.localAudioId || fv?.driveFileId)) return toast("No playable audio yet 😅");
    // Play all versions: active first, then remaining sorted newest to oldest
    const allV = (song.versions || []).slice();
    const activeV = allV.find(v => v.isActive) || allV[0];
    const others = allV
      .filter(v => v.id !== activeV?.id)
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    const items = [activeV, ...others]
      .filter(v => v && isPlayable(v))
      .map(v => ({ songId: song.id, versionId: v.id }));
    if (!items.length) return toast("No playable audio yet 😅");
    state.player.nowPlaying = items[0];
    state.player.queue = items.slice(1);
    state.player.repeatQueue = items;
    state.player.shuffle = false;
    state.player.repeat = false;
    saveState();
    unlockAudioOnce();
    await playNowPlaying({ autoplay: true });
    syncMiniPlayerUI();
  });

  $("#songBigQueue")?.addEventListener("click", () => {
    if (!(fv?.link || fv?.fileId || fv?.localAudioId || fv?.driveFileId)) return toast("No playable audio yet 😅");
    addToQueue(song.id, fv.id);
  });

  // For now, keep your existing "Details" as the old long form screen:
  // We’ll implement it as: details = version detail of the featured? or a new view later.
  // For today: send you to the existing song form by reusing your old renderSongDetail UI? (we replaced it)
  // So: we’ll open the featured version detail as "Details" as a first step.
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

$("#genArtBtn")?.addEventListener("click", async () => {
  if (generatingArtSongs.has(song.id) || Date.now() < artCooldownUntil) return;

  const apiKey = state.settings.replicateKey || "";
  if (!apiKey) {
    toast("Add your Replicate API key in Settings first");
    return;
  }

  generatingArtSongs.add(song.id);
  artCooldownUntil = Date.now() + 10000;
  coverCache.clear();
  render();

  try {
    await generateArtForSong(song, apiKey);
    coverCache.clear();
    saveState();
    toast("Art generated ✨");
  } catch (e) {
    console.error("Art generation failed:", e);
    toast(e.message || "Art generation failed — try again");
  } finally {
    generatingArtSongs.delete(song.id);
    coverCache.clear();
    render();
    const remaining = artCooldownUntil - Date.now();
    if (remaining > 0) setTimeout(() => render(), remaining + 50);
  }
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
      triggerForwardSlide();
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

  const heroCover = coverSvg(song);

  activeScreenEl.innerHTML = `
    <div class="albumHero">
      <div class="albumBg" aria-hidden="true">${heroCover}</div>

      <div class="albumTop">
        <div class="albumArt" aria-hidden="true">${heroCover}</div>
        <div class="albumText">
          <div class="albumTitle">${escapeHtml(v.label || "Version")}</div>
          <div class="albumMeta">
            ${escapeHtml(song.title)} • ${escapeHtml(song.project || "—")}
            ${v.isActive ? ` • <span style="color:rgba(30,215,96,.9)">Active</span>` : ""}
          </div>
        </div>
      </div>

      <div class="albumActions">
        <button class="songHeroPlay" id="playThis" ${hasPlayable ? "" : "disabled"}>▶ Play</button>
        <button class="songHeroQueue" id="queueThis" ${hasPlayable ? "" : "disabled"}>+ Queue</button>
        <button class="songHeroDetails" id="saveVersion">Save</button>
      </div>
    </div>

    <div class="versionsWrap">
      <div class="versionsHeader">
        <div class="versionsTitle">Version Details</div>
        <div class="versionsHeaderRight">
          <button class="btn" id="deleteVersionBtn" style="background:rgba(255,60,60,.15); border-color:rgba(255,60,60,.3); color:rgba(255,120,120,1)">Delete</button>
        </div>
      </div>

      <div class="vDetailRows">

        <div class="vDetailRow">
          <div class="vDetailLabel">Label</div>
          <input id="vLabel" type="text" value="${escapeHtml(v.label || "")}" />
        </div>

        <div class="vDetailRow">
          <div class="vDetailLabel">Notes</div>
          <input id="vNotesEdit" type="text" value="${escapeHtml(v.notes || "")}" />
        </div>

        <div class="vDetailRow">
          <div class="vDetailLabel">Link (URL)</div>
          <input id="vLink" type="text" value="${escapeHtml(v.link || "")}" placeholder="Paste direct audio URL" />
        </div>

        <div class="vDetailRow">
          <div class="vDetailLabel">Local file</div>
          <div class="vDetailValue">
            ${hasLocal
              ? `<span style="opacity:.85">${escapeHtml(v.fileName || v.originalFileName || "audio file")}${v.fileSize ? ` • ${(v.fileSize/1024/1024).toFixed(1)} MB` : ""}</span>`
              : `<span style="opacity:.45">No local file attached.</span>`
            }
          </div>
        </div>

        ${hasDrive ? `
        <div class="vDetailRow">
          <div class="vDetailLabel">Drive</div>
          <div class="vDetailValue" style="color:#4ecdc4">
            ☁️ ${escapeHtml(v.fileName || v.originalFileName || "audio")}
            ${v.driveWebViewLink ? `<a href="${escapeHtml(v.driveWebViewLink)}" target="_blank" id="openLinkBtn" style="color:#4ecdc4; text-decoration:underline; margin-left:6px;">View ↗</a>` : ""}
          </div>
        </div>
        ` : driveConnected ? `
        <div class="vDetailRow">
          <div class="vDetailLabel">Drive</div>
          <div class="vDetailValue" style="opacity:.45">☁️ Not yet synced.</div>
        </div>
        ` : ""}

        <div class="vDetailRow">
          <div class="vDetailLabel">Status</div>
          <div class="vDetailValue">
            <button class="songHeroQueue" id="toggleActiveBtn" style="padding:6px 14px; font-size:13px">${v.isActive ? "✅ Active" : "Set Active"}</button>
          </div>
        </div>

        <div class="vDetailRow">
          <div class="vDetailLabel">Audio</div>
          <div class="vDetailValue" style="display:flex; gap:8px; flex-wrap:wrap">
            <button class="songHeroQueue" id="importAudioBtn" style="padding:6px 14px; font-size:13px">Import file 📁</button>
            ${hasLocal ? `<button class="songHeroQueue" id="clearLocalBtn" style="padding:6px 14px; font-size:13px">Remove local</button>` : ""}
            ${hasLocal && driveConnected && !hasDrive ? `<button class="songHeroQueue" id="uploadToDriveBtn" style="padding:6px 14px; font-size:13px">Upload ☁️</button>` : ""}
            ${v.link && !hasDrive ? `<button class="songHeroQueue" id="openLinkBtn" style="padding:6px 14px; font-size:13px">Open link ↗</button>` : ""}
          </div>
        </div>

      </div>
    </div>
  `;

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

  // Actions (above chips, Spotify-style) + chips + list
  activeScreenEl.innerHTML = `
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

              // Fallback if missing
              const title = it.songName || s?.title || "Untitled";
              const meta = s?.project || "—";
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
          + (items.length ? `<div style="text-align:center;padding:20px 0 8px;color:rgba(255,255,255,0.35);font-size:13px;">${items.length} song${items.length === 1 ? "" : "s"}</div>` : "")
          : `<div class="emptyState">No songs yet. Add songs from the Songs tab.</div>`
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

  // Play all — resets shuffle so songs play in order
  $("#playerPlayAll")?.addEventListener("click", async () => {
    if (!items.length) return toast("Playlist empty 😅");
    const all = items.map(x => ({ songId: x.songId, versionId: x.versionId }));
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
    const all = shuffleArray(items).map(x => ({ songId: x.songId, versionId: x.versionId }));
    state.player.nowPlaying = all[0];
    state.player.queue = all.slice(1);
    state.player.repeatQueue = all;
    state.player.shuffle = true;
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
  const isFirstOpen = !fullPlayerOpen;
  fullPlayerOpen = true;
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

      <nav class="fpBottomTabs" aria-label="Now playing tabs">
        <button class="fpTab is-active" type="button">UP NEXT</button>
        <button class="fpTab" type="button" disabled>LYRICS</button>
        <button class="fpTab" type="button" disabled>RELATED</button>
      </nav>
    </section>
  `;

  // Slide-up entrance animation — only when first opening, not on track change
  if (isFirstOpen) {
    const _fp = $("#fullPlayer");
    if (_fp) {
      _fp.style.transform = "translateY(100%)";
      _fp.style.transition = "none";
      requestAnimationFrame(() => requestAnimationFrame(() => {
        _fp.style.transition = "transform 0.44s cubic-bezier(.22,.9,.24,1)";
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
    fullPlayerOpen = false;
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
    if (e.target?.closest?.("button, input, a")) return;

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
      _savedPrevTab = prevTabBeforeFullPlayer;
      _savedPrevSongId = prevSelectedSongIdBeforeFullPlayer;

      // Move fp to body so it floats above everything
      document.body.appendChild(fp);

      // Restore previous screen underneath
      fullPlayerOpen = false;
      setFullPlayerOpen(false);
      playerScreen = "list";
      if (_savedPrevTab) {
        currentTab = _savedPrevTab;
        selectedSongId = _savedPrevSongId;
        prevTabBeforeFullPlayer = null;
        prevSelectedSongIdBeforeFullPlayer = null;
        setHeader(currentTab === "songs" && selectedSongId ? "Song" : TAB_TITLES[currentTab] || "RiffBank");
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
        fp.style.transition = "transform 280ms cubic-bezier(.32,0,.6,1), opacity 200ms ease";
        fp.style.transform = "translateY(100%)";
        fp.style.opacity = "0";
        fp.addEventListener("transitionend", () => fp.remove(), { once: true });
      } else {
        // Cancel: re-open full player
        fp.remove();
        fullPlayerOpen = true;
        setFullPlayerOpen(true);
        prevTabBeforeFullPlayer = _savedPrevTab;
        prevSelectedSongIdBeforeFullPlayer = _savedPrevSongId;
        currentTab = "player";
        playerScreen = "now-playing";
        syncTabs();
        render();
      }
      _peekReady = false;
    } else {
      fp.style.transition = "transform 180ms ease, opacity 180ms ease";
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
    if (!advanceToNextTrack({ render: true })) toast("Queue empty 😅");
  });

  $("#npPrev")?.addEventListener("click", () => {
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
      <h2>AI Art</h2>
      <div class="label">Replicate API key</div>
      <input id="replicateKey" type="password" value="${escapeHtml(state.settings.replicateKey || "")}" placeholder="r8_..." />
      <div class="small">Free at replicate.com — used for cover art generation (Imagen 4)</div>

      <div class="row" style="gap:10px; margin-top:14px">
        <button id="genMissingArt" class="btn" style="flex:1" ${bulkArtState.running ? "disabled" : ""}>${bulkArtState.running ? `${bulkArtState.done}/${bulkArtState.total} done…` : "Generate Missing Art"}</button>
        <button id="regenAllArt" class="btn" style="flex:1; background: rgba(255,200,50,.08); border-color: rgba(255,200,50,.2); color: #ffc832;" ${bulkArtState.running ? "disabled" : ""}>${bulkArtState.running ? `${bulkArtState.done}/${bulkArtState.total} done…` : "Regenerate All Art"}</button>
      </div>
      <div class="small" style="margin-top:4px">Generate art only for songs without cover art, or regenerate for every song.</div>

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

    // Resolve cover art Drive IDs into streamable URLs
    for (const song of songs) {
      if (song.coverDriveFileId) {
        const coverUrl = await gdriveGetStreamUrl(song.coverDriveFileId);
        if (coverUrl) song.coverImageUrl = coverUrl;
      }
    }

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
    state.settings.replicateKey = $("#replicateKey").value.trim() || "";
    saveState();
    toast("Saved ✅");
  });

  // Bulk art generation — sync buttons to global bulkArtState
  const syncBulkBtns = () => {
    const btnMissing = $("#genMissingArt");
    const btnAll = $("#regenAllArt");
    if (bulkArtState.running) {
      const txt = `${bulkArtState.done}/${bulkArtState.total} done…`;
      if (btnMissing) { btnMissing.disabled = true; btnMissing.textContent = txt; }
      if (btnAll) { btnAll.disabled = true; btnAll.textContent = txt; }
    }
  };
  syncBulkBtns();

  $("#genMissingArt")?.addEventListener("click", () => startBulkGenArt(true));
  $("#regenAllArt")?.addEventListener("click", () => startBulkGenArt(false));

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

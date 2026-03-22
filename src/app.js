// RiffBank v1.4 (Local-first PWA + Supabase cloud sync)
// - Song creation + editing
// - Version history + Best flag
// - Best-only Player (plays links)
// - Dashboard + Settings
// - Export / Import
// - Supabase integration (auth, cloud sync, audio/cover storage)

window.onerror = (m, src, line, col) => alert(`JS ERROR:\n${m}\n${line}:${col}`);

// Dev toggles: skip splash / welcome screen
 const DISABLE_SPLASH = true;
 const DISABLE_WELCOME = true;

// Debug: show cache version badge on every screen (toggle on/off)
const SHOW_BUILD_BADGE = true;

// ── Activity log (alerts bell) ──
// Each entry: { id, songTitle, status: "saving"|"compressing"|"uploading"|"syncing"|"done"|"failed", ts, message }
const activityLog = [];

// ── Persistent notification inbox (survives refresh, 30-day retention) ──
const NOTIF_STORAGE_KEY = "riffbank_notifications";
const NOTIF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

function addNotification({ title, body, type = "share" }) {
  const items = _loadNotifications();
  items.unshift({ id: crypto.randomUUID(), title, body, type, ts: Date.now(), read: false });
  if (items.length > 100) items.length = 100;
  _saveNotifications(items);
  _updateNotifBadge();
  if (drawerView === "alerts") renderAlerts();
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
  const total = unread + activityLog.filter(a => a.status !== "done" && a.status !== "failed").length;
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
  const existing = activityLog.find(a => a.id === id);
  if (existing) {
    existing.status = status;
    existing.message = message;
    existing.ts = Date.now();
  } else {
    activityLog.unshift({ id, songTitle, status, message, ts: Date.now() });
  }
  // Keep last 50
  if (activityLog.length > 50) activityLog.length = 50;
  updateBellBadge();
  // Live-update alerts view if open
  if (drawerView === "alerts") renderAlerts();
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

import { $ } from "./ui/dom.js";
import { runSplashSequence, replaySplash } from "./splash/splash.js";
import {
  SUPABASE_URL, SUPABASE_ANON_KEY,
  supabase, signUp, signIn, signOut, getSession, onAuthChange, verifyOtp, resendConfirmation,
  supabaseSyncStateSoon, supabasePushState, supabasePullState, supabasePullStateSilent,
  supabaseUploadAudio, supabaseFetchAudioBlob, supabaseDeleteAudio, supabaseDiscoverAudioPaths,
  supabaseUploadCover, supabaseFetchCoverBlob, supabaseCountUserSongs,
  createShareInvite, getShareInvite, acceptShareInvite,
  pullSharedProjects, pullSharedSongs, pullMySharedProjects, pullMySharedSongs,
  listMyInvites, deleteShareInvite,
  removeProjectMember, upsertProfile, searchUsers, shareWithUser,
  sendFriendRequest, acceptFriendRequest, removeFriendship,
  getMyFriends, getPendingFriendRequests, getPendingFriendCount,
  sendMessage, getMessages, getConversations, markMessagesRead, getUnreadMessageCount,
} from "./supabase.js";

const LS_KEY = "riffbank_v1";
const HAS_SAVED_STATE = !!localStorage.getItem(LS_KEY); // used to detect first-run seeding

let prevTabBeforeFullPlayer = null;
let prevSelectedSongIdBeforeFullPlayer = null;

let splashAlreadyRan = false;

// ---------------------
// Player view state
// ---------------------
let playerFilter = "all"; // all | playlists | projects | releases
let playerSort = "recent"; // recent | title
let playerQuery = "";
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
  songDetail: document.getElementById("screen-song-detail"),
  versionDetail: document.getElementById("screen-version-detail"),
  player: document.getElementById("screen-player"),
  settings: document.getElementById("screen-settings"),
  collab: document.getElementById("screen-collab"),
  drawer: document.getElementById("screen-drawer"),
  projectDetail: document.getElementById("screen-project-detail"),
};

// ---------------------
// Nav — centralized navigation transition engine
// ---------------------
// All forward/back slide transitions, swipe gestures, and nav history
// live here. Call nav.forward(screenEl) / nav.back(screenEl, renderFn)
// instead of wiring up transition logic at each call site.
class Nav {
  constructor() {
    this.stack = [];        // cloned DOM nodes (previous screens)
    this.topbarStack = [];  // topbar outerHTML strings
    this.scrollStack = [];  // scrollTop values
    this.stateStack = [];   // app state snapshots
    this.rectStack = [];    // { top, left, width, height } of screen at capture time
    this.paddingStack = []; // computed padding at capture time
    this.tbRectStack = [];  // topbar rect at capture time

    this.appStack = [];     // full-app captures for new transition system

    this.pendingBackState = null;
    this._isBackNav = false;
    this._transitionActive = false;
    this._restoredScrollTop = 0;

    // Snapshot state (captured at render() time, before DOM mutations)
    this.peekNode = null;
    this.aceViewTop = 0;
    this.aceScrollTop = 0;
    this.acePadding = "";
    this.aceRect = null;    // screen bounding rect at capture time
    this.topbarHTML = "";
    this.topbarRect = null;
    this.prevState = null;

    this.ACE_PARALLAX = 30;
  }

  get depth() { return this.stack.length; }

  // Capture current screen so back transitions can show it as the ace.
  // Call at the start of render() before any DOM mutations.
  snapshot(screenEl) {
    if (this._transitionActive) return; // slideTransition handles captures
    if (!screenEl?.innerHTML) return;
    this.peekNode = this._cloneDeep(screenEl);
    // Strip touch artifacts so snapshot shows natural (untouched) state
    this.peekNode.querySelectorAll(".hCard.is-touched").forEach(c => c.classList.remove("is-touched"));
    this.peekNode.querySelectorAll(".hDarken").forEach(d => d.style.opacity = 0);
    this.peekNode.querySelectorAll(".hArt").forEach(a => { a.style.transform = ""; a.style.scale = ""; });
    // Bake current animation state into inline styles so clones don't restart from keyframe 0%
    this._freezeAnimations(screenEl, this.peekNode);
    const r = screenEl.getBoundingClientRect();
    this.aceViewTop = r.top || 0;
    this.aceScrollTop = screenEl.scrollTop || 0;
    this.acePadding = getComputedStyle(screenEl).padding;
    this.aceRect = { top: r.top, left: r.left, width: r.width, height: r.height };

    const tb = document.querySelector(".topbar");
    const tbRect = tb?.getBoundingClientRect();
    const tbVisible = tbRect && tbRect.height > 0;
    if (tbVisible && tb) {
      // Bake computed styles into the snapshot so collapseTitle/pdActive context
      // isn't lost when the clone is placed outside .app in an overlay.
      const tbBg = getComputedStyle(tb).background;
      const prevTbStyle = tb.getAttribute("style") || "";
      tb.style.background = tbBg;

      // collapseTitle uses a ::after pseudo to extend the topbar 14px downward.
      // Flag via data attribute so the standalone CSS rule fires on the clone.
      const isCollapse = document.querySelector(".app")?.classList.contains("collapseTitle");
      if (isCollapse) {
        tb.dataset.tbExt = "";
      }

      const tbBlock = tb.querySelector(".titleblock");
      const h1Live = tbBlock?.querySelector("h1");
      let prevH1Style = "", prevBlockStyle = "";
      if (h1Live) {
        const cs = getComputedStyle(h1Live);
        prevH1Style = h1Live.getAttribute("style") || "";
        h1Live.style.fontSize = cs.fontSize;
        h1Live.style.fontWeight = cs.fontWeight;
        h1Live.style.letterSpacing = cs.letterSpacing;
      }
      if (tbBlock) {
        const bs = getComputedStyle(tbBlock);
        prevBlockStyle = tbBlock.getAttribute("style") || "";
        tbBlock.style.position = bs.position;
        tbBlock.style.left = bs.left;
        tbBlock.style.top = bs.top;
        tbBlock.style.height = bs.height;
        tbBlock.style.display = bs.display;
        tbBlock.style.alignItems = bs.alignItems;
      }
      this.topbarHTML = tb.outerHTML || "";
      // Restore original inline styles so live DOM isn't polluted
      if (isCollapse) delete tb.dataset.tbExt;
      tb.setAttribute("style", prevTbStyle);
      if (h1Live) h1Live.setAttribute("style", prevH1Style);
      if (tbBlock) tbBlock.setAttribute("style", prevBlockStyle);
    } else {
      this.topbarHTML = "";
    }
    this.topbarRect = tbVisible ? { top: tbRect.top, height: tbRect.height } : null;
  }

  // Capture app state BEFORE mutating state vars for forward navigation.
  captureState(stateObj) {
    this.prevState = { ...stateObj };
  }

  // Clear all stacks (used when navigating to root).
  clearStacks() {
    this.stack = [];
    this.topbarStack = [];
    this.scrollStack = [];
    this.stateStack = [];
    this.rectStack = [];
    this.paddingStack = [];
    this.tbRectStack = [];
    this.appStack = [];
  }

  // --- Shared helpers ---

  // Bake live CSS animation state (opacity, transform, background-position) into
  // inline styles on the clone, then kill the animation so it doesn't restart.
  _freezeAnimations(live, clone) {
    const animEls = live.querySelectorAll(".hShimmer, .hCard");
    const cloneEls = clone.querySelectorAll(".hShimmer, .hCard");
    animEls.forEach((el, i) => {
      const c = cloneEls[i];
      if (!c) return;
      const cs = getComputedStyle(el);
      if (el.classList.contains("hShimmer")) {
        c.style.opacity = cs.opacity;
        c.style.transform = cs.transform;
      }
      if (el.classList.contains("hCard")) {
        c.style.backgroundPosition = cs.backgroundPosition;
      }
      c.style.animation = "none";
    });
  }

  // Clone a DOM node, preserving canvas pixel data (cloneNode doesn't copy canvas content)
  _cloneDeep(node) {
    const clone = node.cloneNode(true);
    const origCanvases = node.querySelectorAll('canvas');
    const cloneCanvases = clone.querySelectorAll('canvas');
    origCanvases.forEach((orig, i) => {
      const c = cloneCanvases[i];
      if (c && orig.width > 0 && orig.height > 0) {
        c.width = orig.width;
        c.height = orig.height;
        try { const ctx = c.getContext('2d'); if (ctx) ctx.drawImage(orig, 0, 0); }
        catch (e) { /* tainted canvas */ }
      }
    });
    return clone;
  }

  _bottomOffset() {
    const bnEl = document.getElementById("bottomNav");
    const bnRect = bnEl?.getBoundingClientRect();
    return bnRect ? `${window.innerHeight - bnRect.top}px` : "0px";
  }

  // Bake context-dependent styles (collapseTitle, pdActive, etc.) into a
  // topbar clone so it renders correctly outside .app.
  // IMPORTANT: call AFTER setting cssText on tbClone so topbar-level
  // properties aren't wiped out.
  _bakeTopbarStyles(tbClone, tbLive) {
    // Topbar's own background (transparent in pdActive, solid otherwise)
    const tbBg = getComputedStyle(tbLive).background;
    tbClone.style.background = tbBg;

    // collapseTitle uses a ::after pseudo to extend the topbar 14px downward.
    // The clone loses .app ancestor context, so flag via data attribute to
    // trigger the standalone CSS rule (.topbar[data-tb-ext]::after).
    const isCollapse = document.querySelector(".app")?.classList.contains("collapseTitle");
    if (isCollapse) {
      tbClone.dataset.tbExt = "";
      tbClone.style.overflow = "visible";
    }

    const h1L = tbLive.querySelector(".titleblock h1");
    const h1C = tbClone.querySelector(".titleblock h1");
    if (h1L && h1C) {
      const cs = getComputedStyle(h1L);
      h1C.style.fontSize = cs.fontSize;
      h1C.style.fontWeight = cs.fontWeight;
      h1C.style.letterSpacing = cs.letterSpacing;
      if (!h1C.style.opacity) h1C.style.opacity = cs.opacity;
    }
    const blkL = tbLive.querySelector(".titleblock");
    const blkC = tbClone.querySelector(".titleblock");
    if (blkL && blkC) {
      const bs = getComputedStyle(blkL);
      blkC.style.position = bs.position;
      blkC.style.left = bs.left;
      blkC.style.top = bs.top;
      blkC.style.height = bs.height;
      blkC.style.display = bs.display;
      blkC.style.alignItems = bs.alignItems;
    }
  }

  // Lock a screen element into a context-independent frozen clone.
  // The clone renders pixel-perfect no matter where it's placed in the DOM
  // (immune to parent CSS classes like .app.pdActive, body.isHome, etc.).
  _freeze(el) {
    const rect = el.getBoundingClientRect();
    const computed = getComputedStyle(el);
    const clone = el.cloneNode(true);
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    clone.style.padding = computed.padding;
    clone.style.margin = "0";
    clone.style.boxSizing = "border-box";
    clone.style.overflow = "hidden";
    return clone;
  }

  // --- New centralized transition system ---
  // Captures the entire .app element as a pixel-perfect frozen clone.
  // Because the clone IS .app with all its CSS classes (pdActive, collapseTitle, etc.),
  // all context-dependent styles are automatically preserved — no manual baking needed
  // for most properties.
  _captureApp() {
    const appEl = document.querySelector(".app");
    if (!appEl) return null;

    const rect = appEl.getBoundingClientRect();
    const activeScreen = appEl.querySelector(".screen.is-active");
    const scrollTop = activeScreen ? activeScreen.scrollTop : 0;

    const clone = this._cloneDeep(appEl);

    // Strip non-visible content to reduce memory
    clone.querySelector("#drawer")?.remove();
    clone.querySelector("#drawerOverlay")?.remove();
    clone.querySelectorAll(".screen").forEach(s => {
      if (!s.classList.contains("is-active") && !s.querySelector(".homeWrap")) {
        s.innerHTML = "";
      }
    });

    // Strip touch artifacts
    clone.querySelectorAll(".hCard.is-touched").forEach(c => c.classList.remove("is-touched"));
    clone.querySelectorAll(".hDarken").forEach(d => d.style.opacity = 0);
    clone.querySelectorAll(".hArt").forEach(a => { a.style.transform = ""; a.style.scale = ""; });

    // Freeze CSS animations so they don't restart from frame 0
    if (activeScreen) {
      const cloneActive = clone.querySelector(".screen.is-active");
      if (cloneActive) this._freezeAnimations(activeScreen, cloneActive);
    }

    // Bake body-context-dependent styles that may change during mutations.
    // The clone retains .app classes (collapseTitle, pdActive), so most CSS works.
    // But body-level selectors (body.isHome, body.hasHeaderGrad, etc.) won't match
    // when the clone is displayed from a different screen context.
    const liveTb = appEl.querySelector(".topbar");
    const cloneTb = clone.querySelector(".topbar");
    if (liveTb && cloneTb) {
      const cs = getComputedStyle(liveTb);
      cloneTb.style.display = cs.display;
      cloneTb.style.background = cs.background;
      // Bake h1 styles (opacity is scroll-driven, may be lost)
      const h1L = liveTb.querySelector("h1");
      const h1C = cloneTb.querySelector("h1");
      if (h1L && h1C) {
        const h1cs = getComputedStyle(h1L);
        h1C.style.opacity = h1cs.opacity;
        h1C.style.transition = "none";
      }
    }

    // Bake active screen's computed styles (body.isHome sets padding:0, overflow:hidden
    // on #screen-home — these are lost when body class changes between screens)
    if (activeScreen) {
      const cloneActive = clone.querySelector(".screen.is-active");
      if (cloneActive) {
        const screenCS = getComputedStyle(activeScreen);
        cloneActive.style.padding = screenCS.padding;
        cloneActive.style.overflow = screenCS.overflow;
        cloneActive.style.overflowX = screenCS.overflowX;
        cloneActive.style.overflowY = screenCS.overflowY;
      }
    }

    // Bake body background onto clone (body.hasHeaderGrad sets gradient background)
    const bodyBg = getComputedStyle(document.body).background;
    if (bodyBg && bodyBg !== "none") {
      // Only bake if there's a meaningful gradient (not just the default solid bg)
      const cloneView = clone.querySelector(".view");
      if (cloneView && bodyBg.includes("gradient")) {
        cloneView.style.background = bodyBg;
      }
    }

    // Bake FAB from fixed → absolute position
    const liveFab = appEl.querySelector(".sdFab");
    const cloneFab = clone.querySelector(".sdFab");
    if (liveFab && cloneFab) {
      const fr = liveFab.getBoundingClientRect();
      cloneFab.style.position = "absolute";
      cloneFab.style.top = `${fr.top}px`;
      cloneFab.style.left = `${fr.left}px`;
      cloneFab.style.bottom = "auto";
      cloneFab.style.right = "auto";
    }

    // Kill all CSS transitions on the clone so nothing animates
    clone.style.transition = "none";
    clone.querySelectorAll("*").forEach(el => {
      if (getComputedStyle(el).transition !== "all 0s ease 0s") {
        el.style.transition = "none";
      }
    });

    return { clone, rect, scrollTop };
  }

  // Build a fixed-position overlay from a capture, ready for animation.
  // The clone IS .app — append it directly to body so all CSS rules
  // (body.isHome .topbar, etc.) work identically to the live DOM.
  _buildOverlay(capture, zIndex) {
    if (!capture) return null;
    const { clone, rect, scrollTop } = capture;

    // Position the clone exactly where .app sits, as a fixed overlay
    clone.style.cssText += `;position:fixed;top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px;z-index:${zIndex};overflow:hidden;pointer-events:none;margin:0;background:var(--bg);`;

    // Stash scrollTop so the caller can restore it AFTER appending to the DOM.
    // scrollTop has no effect on detached nodes.
    clone._deferredScrollTop = scrollTop;

    return clone;
  }

  // Restore scroll on a clone built by _buildOverlay. Call AFTER appendChild.
  _restoreOverlayScroll(clone) {
    if (clone && clone._deferredScrollTop != null) {
      const cloneScreen = clone.querySelector(".screen.is-active");
      if (cloneScreen) cloneScreen.scrollTop = clone._deferredScrollTop;
      delete clone._deferredScrollTop;
    }
  }

  // Centralized slide transition using the View Transitions API.
  // The browser captures pixel-perfect BITMAP screenshots of the before/after
  // states — no DOM cloning, no CSS context issues.
  //
  // direction: "forward" | "back" | "jumpHome"
  // mutate: function that performs all state changes + render()
  slideTransition({ direction, mutate }) {
    const vtClass = `vt-${direction}`;
    const docEl = document.documentElement;

    // Fallback for browsers without View Transitions API
    const noVT = !document.startViewTransition;

    if (direction === "forward") {
      // Snapshot the current screen BEFORE setting _transitionActive,
      // so that peekNode/topbarHTML/etc. are fresh when pushed to stacks.
      // snapshot() temporarily bakes styles then restores them, so the DOM
      // is clean by the time startViewTransition captures its bitmap.
      const currentScreen = document.querySelector(".screen.is-active");
      this.snapshot(currentScreen);

      // Capture full app clone for swipe-back ace (pixel-perfect, no hand-building)
      this.appStack.push(this._captureApp());

      // Now prevent render()'s snapshot() from overwriting our fresh capture
      this._transitionActive = true;
      if (this.peekNode) this.stack.push(this.peekNode);
      this.topbarStack.push(this.topbarHTML);
      this.scrollStack.push(this.aceScrollTop);
      this.rectStack.push(this.aceRect);
      this.paddingStack.push(this.acePadding);
      this.tbRectStack.push(this.topbarRect);
      if (this.prevState) this.stateStack.push(this.prevState);

      if (noVT) { this._transitionActive = false; mutate(); return; }

      docEl.classList.add(vtClass);
      const transition = document.startViewTransition(() => {
        mutate();
        this._transitionActive = false;
      });
      transition.finished.finally(() => docEl.classList.remove(vtClass));
    }

    else if (direction === "back") {
      // Pop stacks
      this.pendingBackState = this.stateStack.length > 0 ? this.stateStack.pop() : null;
      if (this.stack.length > 0) this.stack.pop();
      if (this.topbarStack.length > 0) this.topbarStack.pop();
      const aceScrollTop = this.scrollStack.length > 0 ? this.scrollStack.pop() : 0;
      if (this.rectStack.length > 0) this.rectStack.pop();
      if (this.paddingStack.length > 0) this.paddingStack.pop();
      if (this.tbRectStack.length > 0) this.tbRectStack.pop();
      if (this.appStack.length > 0) this.appStack.pop();

      if (noVT) { mutate(); return; }

      docEl.classList.add(vtClass);
      this._transitionActive = true;
      const transition = document.startViewTransition(() => {
        mutate();
        this._transitionActive = false;
        // Restore scroll so the API captures the correct scroll position
        const screen = document.querySelector(".screen.is-active");
        if (aceScrollTop && screen) screen.scrollTop = aceScrollTop;
      });
      transition.finished.finally(() => docEl.classList.remove(vtClass));
    }

    else if (direction === "jumpHome") {
      this.clearStacks();

      if (noVT) { mutate(); return; }

      docEl.classList.add(vtClass);
      const transition = document.startViewTransition(() => mutate());
      transition.finished.finally(() => docEl.classList.remove(vtClass));
    }
  }

  // --- Legacy forward slide ---
  // Slide new screen in from the right. Call AFTER render().
  // Kept for swipe gesture compatibility.

  forward(screenEl) {
    const topbar = document.querySelector(".topbar");
    if (!screenEl) return;

    // Push previous screen onto stacks
    if (this.peekNode) this.stack.push(this.peekNode);
    this.topbarStack.push(this.topbarHTML);
    this.scrollStack.push(this.aceScrollTop);
    this.rectStack.push(this.aceRect);
    this.paddingStack.push(this.acePadding);
    this.tbRectStack.push(this.topbarRect);
    if (this.prevState) this.stateStack.push(this.prevState);

    const navBottomOffset = this._bottomOffset();
    const r = screenEl.getBoundingClientRect();

    // Ace overlay (previous screen)
    let aceOverlay = null;
    if (this.peekNode) {
      const viewEl = document.getElementById("view");
      const viewRect = viewEl?.getBoundingClientRect();
      const aceLeft = viewRect ? viewRect.left : r.left;
      const aceWidth = viewRect ? viewRect.width : r.width;
      aceOverlay = document.createElement("div");
      aceOverlay.style.cssText = `position:fixed;top:0;left:${aceLeft}px;width:${aceWidth}px;bottom:${navBottomOffset};z-index:499;overflow:hidden;pointer-events:none;background:var(--bg);`;

      if (this.topbarHTML && this.topbarRect) {
        const tbWrap = document.createElement("div");
        tbWrap.innerHTML = this.topbarHTML;
        const tbEl = tbWrap.firstElementChild;
        if (tbEl) {
          tbEl.style.cssText = `display:flex;position:absolute;top:${this.topbarRect.top}px;left:0;width:100%;height:${this.topbarRect.height}px;overflow:visible;pointer-events:none;box-sizing:border-box;`;
          aceOverlay.appendChild(tbEl);
        }
      }

      const aceContent = document.createElement("div");
      aceContent.style.cssText = `position:absolute;top:${this.aceViewTop}px;left:0;width:100%;bottom:0;overflow:hidden;`;
      const aceScreenClone = this._cloneDeep(this.peekNode);
      aceScreenClone.style.padding = this.acePadding;
      aceContent.appendChild(aceScreenClone);
      aceOverlay.appendChild(aceContent);
      document.body.appendChild(aceOverlay);
      aceScreenClone.scrollTop = this.aceScrollTop;
    }

    // Queen overlay (new screen sliding in)
    const overlay = document.createElement("div");
    overlay.className = "viewSlideOverlay";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.width = "100%";
    overlay.style.bottom = navBottomOffset;
    overlay.style.height = "";
    overlay.style.transform = "translateX(100%)";
    overlay.style.transition = "none";

    if (topbar) {
      const tbRect = topbar.getBoundingClientRect();
      const tbClone = topbar.cloneNode(true);
      tbClone.style.cssText = `display:flex;position:absolute;top:${tbRect.top}px;left:${r.left}px;width:${r.width}px;height:${tbRect.height}px;overflow:visible;pointer-events:none;`;
      this._bakeTopbarStyles(tbClone, topbar);
      overlay.appendChild(tbClone);
    }

    const screenWrap = document.createElement("div");
    screenWrap.style.cssText = `position:absolute;top:${r.top}px;left:${r.left}px;width:${r.width}px;height:${r.height}px;overflow:hidden;`;
    screenWrap.appendChild(this._freeze(screenEl));
    overlay.appendChild(screenWrap);

    // Reposition FAB from fixed to absolute so it doesn't jump during slide
    const overlayFab = overlay.querySelector('.sdFab');
    if (overlayFab) {
      const liveFab = screenEl.querySelector('.sdFab');
      if (liveFab) {
        const fr = liveFab.getBoundingClientRect();
        overlayFab.style.position = 'absolute';
        overlayFab.style.top = `${fr.top}px`;
        overlayFab.style.left = `${fr.left}px`;
        overlayFab.style.bottom = 'auto';
        overlayFab.style.right = 'auto';
        overlay.appendChild(overlayFab);
      }
    }

    document.body.appendChild(overlay);

    screenEl.style.opacity = "0";
    if (topbar) topbar.style.opacity = "0";

    // Force reflow
    // eslint-disable-next-line no-unused-expressions
    overlay.offsetWidth;

    overlay.style.transition = "transform 0.3s cubic-bezier(.4,0,.2,1)";
    overlay.style.transform = "";

    if (aceOverlay) {
      aceOverlay.style.transition = "transform 0.3s cubic-bezier(.4,0,.2,1)";
      aceOverlay.style.transform = `translateX(-${this.ACE_PARALLAX}px)`;
    }

    overlay.addEventListener("transitionend", () => {
      overlay.remove();
      if (aceOverlay) { aceOverlay.remove(); aceOverlay = null; }
      screenEl.style.opacity = "";
      if (topbar) topbar.style.opacity = "";
    }, { once: true });
  }

  // --- Back slide ---
  // Both ace (previous screen) and queen (current screen) are frozen snapshots.
  // The live DOM renders invisibly underneath and is revealed when animation completes.

  back(screenEl, renderUnderneath) {
    if (!screenEl) return renderUnderneath();

    // Peek at stack BEFORE popping — we need the ace snapshot + its frozen dimensions
    const aceNode = this.stack.length > 0 ? this.stack[this.stack.length - 1] : this.peekNode;
    const aceTopbarHTML = this.topbarStack.length > 0
      ? this.topbarStack[this.topbarStack.length - 1]
      : this.topbarHTML;
    const aceScrollTop = this.scrollStack.length > 0
      ? this.scrollStack[this.scrollStack.length - 1]
      : this.aceScrollTop;
    const aceRect = this.rectStack.length > 0
      ? this.rectStack[this.rectStack.length - 1]
      : this.aceRect;
    const acePadding = this.paddingStack.length > 0
      ? this.paddingStack[this.paddingStack.length - 1]
      : this.acePadding;
    const aceTbRect = this.tbRectStack.length > 0
      ? this.tbRectStack[this.tbRectStack.length - 1]
      : this.topbarRect;

    // Now pop stacks
    if (this.stack.length > 0) this.stack.pop();
    if (this.topbarStack.length > 0) this.topbarStack.pop();
    if (this.scrollStack.length > 0) this.scrollStack.pop();
    if (this.rectStack.length > 0) this.rectStack.pop();
    if (this.paddingStack.length > 0) this.paddingStack.pop();
    if (this.tbRectStack.length > 0) this.tbRectStack.pop();
    this.pendingBackState = this.stateStack.length > 0 ? this.stateStack.pop() : null;

    const navBottomOffset = this._bottomOffset();
    const tb = document.querySelector(".topbar");
    const tbRect = tb ? tb.getBoundingClientRect() : null;
    const viewRect = screenEl.getBoundingClientRect();

    // --- Queen overlay (frozen current screen) ---
    const queenEl = document.createElement("div");
    queenEl.style.cssText = "position:fixed;inset:0;z-index:500;overflow:hidden;pointer-events:none;background:var(--bg);";

    if (tbRect && tb) {
      const tbClone = tb.cloneNode(true);
      tbClone.style.cssText = `display:flex;position:absolute;top:${tbRect.top}px;left:${tbRect.left}px;width:${tbRect.width}px;height:${tbRect.height}px;overflow:visible;pointer-events:none;`;
      this._bakeTopbarStyles(tbClone, tb);
      queenEl.appendChild(tbClone);
    }

    const screenWrap = document.createElement("div");
    screenWrap.style.cssText = `position:absolute;top:${viewRect.top}px;left:${viewRect.left}px;width:${viewRect.width}px;height:${viewRect.height}px;overflow:hidden;`;
    const queenClone = this._freeze(screenEl);
    const queenScrollTop = screenEl.scrollTop;
    screenWrap.appendChild(queenClone);
    queenEl.appendChild(screenWrap);

    // Bake fixed-position FAB into absolute pixel coords so it won't jump
    // when renderUnderneath() changes --dock-h
    const queenFab = queenEl.querySelector('.sdFab');
    if (queenFab) {
      const liveFab = document.querySelector('.sdFab');
      if (liveFab) {
        const fr = liveFab.getBoundingClientRect();
        queenFab.style.position = 'absolute';
        queenFab.style.top = `${fr.top}px`;
        queenFab.style.left = `${fr.left}px`;
        queenFab.style.bottom = 'auto';
        queenFab.style.right = 'auto';
        queenEl.appendChild(queenFab);
      }
    }

    // Queen goes on first — covers everything while we render + build ace
    document.body.appendChild(queenEl);
    // scrollTop must be set AFTER appendChild — no effect on detached nodes
    queenClone.scrollTop = queenScrollTop;

    // Hide live topbar — overlays have their own clones; prevents the live
    // topbar from peeking through the ace's parallax gap during animation.
    if (tb) tb.style.visibility = "hidden";

    // Render live DOM invisibly underneath the queen overlay.
    // This removes pdActive, restores normal .view dimensions, etc.
    // Note: do NOT set _isBackNav here — goBack's doRender() manages
    // that flag so setHeader(restoreState.headerTitle) isn't skipped.
    renderUnderneath();

    // Restore scroll position on the newly-rendered screen
    if (aceScrollTop && activeScreenEl) activeScreenEl.scrollTop = aceScrollTop;

    // --- Ace overlay (frozen previous screen from stack) ---
    // Uses stored pixel rect from capture time — no live DOM measurement needed.
    // The ace clone is dimension-locked just like the queen.
    let aceOverlay = null;
    if (aceNode && aceRect) {
      const isHomeAce = aceNode.querySelector(".homeWrap");

      aceOverlay = document.createElement("div");
      aceOverlay.style.cssText = `position:fixed;inset:0;bottom:${navBottomOffset};z-index:499;overflow:hidden;pointer-events:none;background:var(--bg);`;

      // Topbar clone for the ace (using stored HTML + rect from capture time)
      if (aceTopbarHTML && aceTbRect) {
        const tbWrap = document.createElement("div");
        tbWrap.innerHTML = aceTopbarHTML;
        const tbEl = tbWrap.firstElementChild;
        if (tbEl) {
          tbEl.style.cssText = `display:flex;position:absolute;top:${aceTbRect.top}px;left:${aceRect.left}px;width:${aceRect.width}px;height:${aceTbRect.height}px;overflow:visible;pointer-events:none;box-sizing:border-box;`;
          aceOverlay.appendChild(tbEl);
        }
      }

      // Screen content — frozen at exact capture-time dimensions
      const aceWrap = document.createElement("div");
      aceWrap.style.cssText = `position:absolute;top:${aceRect.top}px;left:${aceRect.left}px;width:${aceRect.width}px;height:${aceRect.height}px;overflow:hidden;`;
      const aceClone = this._cloneDeep(aceNode);
      aceClone.style.width = `${aceRect.width}px`;
      aceClone.style.height = `${aceRect.height}px`;
      aceClone.style.padding = isHomeAce ? "0" : acePadding;
      aceClone.style.margin = "0";
      aceClone.style.boxSizing = "border-box";
      aceClone.style.position = "relative";
      aceClone.style.inset = "auto";
      aceWrap.appendChild(aceClone);
      aceOverlay.appendChild(aceWrap);

      // Reposition FAB from fixed to absolute so it renders inside the ace overlay
      const aceFab = aceOverlay.querySelector('.sdFab');
      if (aceFab) {
        const liveFab = document.querySelector('.sdFab');
        if (liveFab) {
          const fr = liveFab.getBoundingClientRect();
          aceFab.style.position = 'absolute';
          aceFab.style.top = `${fr.top}px`;
          aceFab.style.left = `${fr.left}px`;
          aceFab.style.bottom = 'auto';
          aceFab.style.right = 'auto';
          aceOverlay.appendChild(aceFab);
        }
      }

      document.body.appendChild(aceOverlay);
      aceClone.scrollTop = aceScrollTop;
    }

    // Suppress homeWrap height transition so it settles instantly
    const homeWrapEl = document.querySelector(".homeWrap");
    if (homeWrapEl) homeWrapEl.style.transition = "none";

    // Parallax on the frozen ace overlay (NOT the live DOM)
    if (aceOverlay) {
      aceOverlay.style.transform = `translateX(-${this.ACE_PARALLAX}px)`;
      aceOverlay.style.transition = "none";
    }

    requestAnimationFrame(() => {
      if (homeWrapEl) homeWrapEl.style.transition = "";
      requestAnimationFrame(() => {
        queenEl.style.transition = "transform 0.3s cubic-bezier(.4,0,.2,1)";
        queenEl.style.transform = "translateX(100%)";

        if (aceOverlay) {
          aceOverlay.style.transition = "transform 0.3s cubic-bezier(.4,0,.2,1)";
          aceOverlay.style.transform = "";
        }

        queenEl.addEventListener("transitionend", () => {
          queenEl.remove();
          if (aceOverlay) aceOverlay.remove();
          if (tb) tb.style.visibility = "";
        }, { once: true });
      });
    });
  }

  // "Life jacket" transition: queen slides off to reveal freshly-rendered Home.
  // No ace overlay — Home renders live underneath the queen.
  jumpHome(screenEl, renderHome) {
    if (!screenEl) { renderHome(); return; }

    const tb = document.querySelector(".topbar");
    const tbRect = tb ? tb.getBoundingClientRect() : null;
    const viewRect = screenEl.getBoundingClientRect();

    // --- Queen overlay (frozen current screen) ---
    const queenEl = document.createElement("div");
    queenEl.style.cssText = "position:fixed;inset:0;z-index:500;overflow:hidden;pointer-events:none;background:var(--bg);";

    if (tbRect && tb) {
      const tbClone = tb.cloneNode(true);
      tbClone.style.cssText = `display:flex;position:absolute;top:${tbRect.top}px;left:${tbRect.left}px;width:${tbRect.width}px;height:${tbRect.height}px;overflow:visible;pointer-events:none;`;
      this._bakeTopbarStyles(tbClone, tb);
      queenEl.appendChild(tbClone);
    }

    const screenWrap = document.createElement("div");
    screenWrap.style.cssText = `position:absolute;top:${viewRect.top}px;left:${viewRect.left}px;width:${viewRect.width}px;height:${viewRect.height}px;overflow:hidden;`;
    const queenClone = this._freeze(screenEl);
    const jumpScrollTop = screenEl.scrollTop;
    screenWrap.appendChild(queenClone);
    queenEl.appendChild(screenWrap);

    // Reposition FAB from fixed to absolute so it doesn't jump during slide
    const jumpFab = queenEl.querySelector('.sdFab');
    if (jumpFab) {
      const liveFab = screenEl.querySelector('.sdFab');
      if (liveFab) {
        const fr = liveFab.getBoundingClientRect();
        jumpFab.style.position = 'absolute';
        jumpFab.style.top = `${fr.top}px`;
        jumpFab.style.left = `${fr.left}px`;
        jumpFab.style.bottom = 'auto';
        jumpFab.style.right = 'auto';
        queenEl.appendChild(jumpFab);
      }
    }

    document.body.appendChild(queenEl);
    // scrollTop must be set AFTER appendChild — no effect on detached nodes
    queenClone.scrollTop = jumpScrollTop;

    // Clear all stacks and render Home live underneath
    this.clearStacks();
    renderHome();

    // Slide queen off to the right
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        queenEl.style.transition = "transform 0.3s cubic-bezier(.4,0,.2,1)";
        queenEl.style.transform = "translateX(100%)";
        queenEl.addEventListener("transitionend", () => queenEl.remove(), { once: true });
      });
    });
  }

  // Pop stacks without animation (for non-animated goBack).
  popStacks() {
    if (this.stack.length > 0) this.stack.pop();
    if (this.topbarStack.length > 0) this.topbarStack.pop();
    this._restoredScrollTop = this.scrollStack.length > 0 ? this.scrollStack.pop() : 0;
    if (this.rectStack.length > 0) this.rectStack.pop();
    if (this.paddingStack.length > 0) this.paddingStack.pop();
    if (this.tbRectStack.length > 0) this.tbRectStack.pop();
    if (this.appStack.length > 0) this.appStack.pop();
    return this.stateStack.length > 0 ? this.stateStack.pop() : null;
  }

  // Consume pending back state (set by animated back).
  consumePendingState() {
    const s = this.pendingBackState;
    this.pendingBackState = null;
    return s;
  }

}

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
    currentTab, drawerView, projectDetailScreen, releaseDetailId,
    selectedSongId, selectedVersionId, songsView, overlayView, friendProfileId,
    songsBackTarget, lyricsEditSongId, collabMode, headerTitle: headerTitle?.textContent ?? "RiffBank"
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

// ---------------------
// Audio storage (IndexedDB) - Phase 1
// ---------------------
const AUDIO_DB = "riffbank_audio_v1";
const AUDIO_STORE = "files";
const audioUrlCache = new Map(); // localAudioId -> objectURL
const coverUrlCache = new Map(); // coverPath -> blob objectURL (persists via IndexedDB)

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

// ---------------------
// Cover art cache (IndexedDB) — survives app restarts
// ---------------------
async function putCoverBlob(coverPath, blob) {
  if (!coverPath || !blob) return;
  const id = `cover:${coverPath}`;
  await putAudioBlob({ id, blob, name: "cover", type: blob.type || "image/jpeg", size: blob.size });
}

async function getCoverBlobUrl(coverPath) {
  if (!coverPath) return null;
  if (coverUrlCache.has(coverPath)) return coverUrlCache.get(coverPath);
  const rec = await getAudioBlob(`cover:${coverPath}`);
  if (rec?.blob) {
    const url = URL.createObjectURL(rec.blob);
    coverUrlCache.set(coverPath, url);
    return url;
  }
  return null;
}

// Restore cover URLs from IndexedDB for all songs (call on startup, before render)
async function restoreCoverUrlsFromCache() {
  for (const song of (state.songs || [])) {
    if (song.coverPath) {
      let url = await getCoverBlobUrl(song.coverPath);
      if (!url) {
        // Try fetching from Supabase storage
        const blob = await supabaseFetchCoverBlob(song.coverPath).catch(() => null);
        if (blob) {
          await putCoverBlob(song.coverPath, blob);
          url = URL.createObjectURL(blob);
          coverUrlCache.set(song.coverPath, url);
        }
      }
      song.coverImageUrl = url || null;
    }
    // Restore user-uploaded cover URLs
    if (song.coverSource === "user" || song.userCoverPath) {
      const localKey = `user_${song.id}_cover.jpg`;
      // Try cloud path first, then local IndexedDB key
      let userUrl = song.userCoverPath ? await getCoverBlobUrl(song.userCoverPath) : null;
      if (!userUrl) userUrl = await getCoverBlobUrl(localKey);
      if (!userUrl && song.userCoverPath) {
        // Try fetching from Supabase storage
        const blob = await supabaseFetchCoverBlob(song.userCoverPath).catch(() => null);
        if (blob) {
          await putCoverBlob(song.userCoverPath, blob);
          userUrl = URL.createObjectURL(blob);
          coverUrlCache.set(song.userCoverPath, userUrl);
        }
      }
      if (userUrl) {
        song.userCoverImageUrl = userUrl;
        if (song.coverSource !== "user") song.coverSource = "user";
      }
    }
  }
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
  return !!(v?.link || v?.fileId || v?.localAudioId || v?.audioPath);
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

async function playNowPlaying({ autoplay = true } = {}){
  const now = state.player?.nowPlaying;
  if (!now || !globalAudio) return;

  const url = await getPlayableUrlForVersion(now.songId, now.versionId);
  if (!url) return toast("No playable audio 😅");
  if (url === "drive-auth-required") return toast("Could not load audio — check your connection");

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
      defaultProject: "",
      defaultGenre: "Metalcore",
      defaultSprint: "Unsorted",
      lyricsScratch: ""
    },
    songs: [],
    quickLog: [],
  };
}

let state = loadState();

// Shared content cache (runtime only, fetched from Supabase on Collab tab)
let sharedData = { projects: [], songs: [], invites: [], myProjects: [], mySongs: [], loaded: false };

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

normalizeState();

function ensureProjectInState(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return;
  if (!state.projects.includes(trimmed)) {
    state.projects.push(trimmed);
  }
}

function saveState() {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
  // Auto-sync to Supabase (debounced — pushes 5s after last save)
  supabaseSyncStateSoon(state);
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
// ---------------------
// Audio compression — shrink WAVs for cloud upload
// Decodes to AudioBuffer, mixes to mono, re-encodes as 16-bit WAV
// ---------------------
const COMPRESS_THRESHOLD = 40 * 1024 * 1024; // only compress files > 40MB

async function compressAudioForUpload(blob) {
  // Skip compression for files under 50MB (Supabase free tier limit)
  if (blob.size <= COMPRESS_THRESHOLD) return blob;

  // Encode to M4A/AAC (stereo, high quality) via MediaRecorder
  // Safari/iOS: audio/mp4 (AAC), Chrome: audio/webm (Opus) — both excellent quality
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuf = await blob.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuf);

    // Render at original sample rate and channel count (preserve stereo)
    const sampleRate = audioBuffer.sampleRate;
    const channels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const offline = new OfflineAudioContext(channels, length, sampleRate);
    const source = offline.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    ctx.close();

    // Pick best available container: M4A (Safari) > WebM/Opus (Chrome)
    const mimeType = MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4"
      : MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus"
      : null;

    if (!mimeType) {
      console.warn("[Compress] No supported audio encoder, uploading original");
      return blob;
    }

    // Play the rendered buffer through MediaRecorder to encode
    const dest = new AudioContext({ sampleRate });
    const bufferSource = dest.createBufferSource();
    bufferSource.buffer = rendered;
    const destNode = dest.createMediaStreamDestination();
    bufferSource.connect(destNode);

    const recorder = new MediaRecorder(destNode.stream, {
      mimeType,
      audioBitsPerSecond: 256000, // 256kbps — high quality
    });

    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    const encodedBlob = await new Promise((resolve) => {
      recorder.onstop = () => {
        const encoded = new Blob(chunks, { type: mimeType });
        resolve(encoded);
      };
      recorder.start();
      bufferSource.start(0);
      // Stop recording after the audio duration + small buffer
      setTimeout(() => {
        recorder.stop();
        bufferSource.stop();
        dest.close();
      }, (rendered.duration * 1000) + 200);
    });

    const ext = mimeType.includes("mp4") ? "m4a" : "webm";
    console.log(`[Compress] ${(blob.size / 1e6).toFixed(1)}MB → ${(encodedBlob.size / 1e6).toFixed(1)}MB (${ext}, ${channels}ch)`);
    return encodedBlob;
  } catch (e) {
    console.warn("[Compress] Failed, uploading original:", e);
    return blob;
  }
}

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

// List all blobs in IndexedDB (for recovery)
async function audioGetAll() {
  const db = await openAudioDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, "readonly");
    const req = tx.objectStore(AUDIO_STORE).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result || []); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

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
  // Clean up art_rate_limits entry
  try {
    await supabase.from("art_rate_limits").delete().eq("song_id", song.id);
  } catch (e) { console.warn("[Supabase] delete art_rate_limits:", e); }
}

// Recover lost audio refs: scan IndexedDB blobs, match to versions by filename,
// re-link fileId, and upload to Supabase Storage
async function recoverAndUploadAudio() {
  const allBlobs = await audioGetAll();
  if (!allBlobs.length) { toast("No audio blobs found in local storage"); return; }

  // Build lookups (skip supa: cached entries)
  const blobByName = new Map();
  const blobById = new Map();
  for (const rec of allBlobs) {
    if (rec.id.startsWith("supa:")) continue;
    if (rec.name) blobByName.set(rec.name, rec);
    blobById.set(rec.id, rec);
  }

  let relinked = 0, uploaded = 0, failed = 0;
  const errors = [];
  toast(`Found ${blobByName.size} local audio blobs — recovering…`);

  for (const song of (state.songs || [])) {
    for (const v of (song.versions || [])) {
      // Skip if already fully synced (has local audio AND cloud backup)
      if (v.audioPath && (v.fileId || v.localAudioId)) continue;

      // Find the blob: try bulk lookup first, then direct IndexedDB fetch by fileId
      let rec = blobById.get(v.fileId) || blobByName.get(v.fileName);
      if (!rec && v.fileId) {
        try { rec = await audioGet(v.fileId); } catch {}
      }
      if (!rec?.blob) continue;

      // Re-link fileId if missing
      if (!v.fileId) {
        v.fileId = rec.id;
        v.fileType = v.fileType || rec.type || "";
        v.fileSize = v.fileSize || rec.size || 0;
        relinked++;
      }

      // Upload to Supabase Storage if not already backed up
      if (v.audioPath) continue;
      try {
        toast(`Compressing ${song.title}…`);
        const uploadBlob = await compressAudioForUpload(rec.blob);
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
  alert(msg);
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

  alert(lines.join("\n"));
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

  // Priority 3a: IndexedDB-cached cloud blob — instant, no network
  if (v.audioPath) {
    const cacheKey = `supa:${v.audioPath}`;
    if (audioUrlCache.has(cacheKey)) return audioUrlCache.get(cacheKey);

    const cached = await audioGet(`supa:${v.audioPath}`);
    if (cached?.blob) {
      const url = URL.createObjectURL(cached.blob);
      audioUrlCache.set(cacheKey, url);
      return url;
    }
  }

  // Priority 3b: Live fetch from Supabase Storage
  if (v.audioPath) {
    const blob = await supabaseFetchAudioBlob(v.audioPath);
    if (blob) {
      const url = URL.createObjectURL(blob);
      audioUrlCache.set(`supa:${v.audioPath}`, url);
      putAudioBlob({ id: `supa:${v.audioPath}`, blob, name: v.fileName || v.label || "audio", type: v.fileType || blob.type || "audio/*", size: blob.size }).catch(() => {});
      return url;
    }
  }

  // Priority 4: Direct URL link
  if (v.link) {
    return normalizeAudioLink(v.link);
  }
  return null;
}

// In-memory set of audioPaths known to be cached in IndexedDB
const _cachedAudioPaths = new Set();

// Cache all cloud-only audio blobs into IndexedDB for offline playback.
async function cacheAllCloudAudio() {
  const cloudVersions = [];
  for (const song of (state.songs || [])) {
    for (const v of (song.versions || [])) {
      if (!v.audioPath) continue;
      if (v.fileId || v.localAudioId) continue;
      if (_cachedAudioPaths.has(v.audioPath)) continue;
      try {
        const existing = await audioGet(`supa:${v.audioPath}`);
        if (existing?.blob) { _cachedAudioPaths.add(v.audioPath); continue; }
      } catch {}
      cloudVersions.push({ song, v });
    }
  }

  if (!cloudVersions.length) {
    toast("All audio already cached locally");
    return;
  }

  let done = 0;
  let failed = 0;
  toast(`Caching audio: 0/${cloudVersions.length}…`);

  for (const { song, v } of cloudVersions) {
    try {
      const blob = await supabaseFetchAudioBlob(v.audioPath);
      if (blob) {
        await audioPut({
          id: `supa:${v.audioPath}`,
          blob,
          name: v.fileName || v.label || "audio",
          type: v.fileType || blob.type || "audio/*",
          size: blob.size,
        });
        _cachedAudioPaths.add(v.audioPath);
        done++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
    toast(`Caching audio: ${done + failed}/${cloudVersions.length}…`);
  }

  const msg = failed
    ? `Cached ${done}/${cloudVersions.length} (${failed} failed)`
    : `All ${done} tracks cached locally`;
  toast(msg);
}

// Upload all local-only audio blobs to Supabase cloud storage.
// Finds versions that have local audio (fileId/localAudioId or cached supa blob)
// but no audioPath (not yet backed up to cloud).
async function backupAllAudioToCloud() {
  const toUpload = [];
  for (const song of (state.songs || [])) {
    for (const v of (song.versions || [])) {
      if (v.audioPath) continue; // Already backed up
      if (!v.fileId && !v.localAudioId) continue; // No local audio to upload
      toUpload.push({ song, v });
    }
  }

  if (!toUpload.length) {
    toast("All audio is already backed up to the cloud");
    return { uploaded: 0, failed: 0 };
  }

  let uploaded = 0, failed = 0;
  toast(`Backing up audio: 0/${toUpload.length}…`);

  for (const { song, v } of toUpload) {
    // Find the local blob
    let blob = null;
    const tryIds = [v.fileId, v.localAudioId].filter(Boolean);
    for (const id of tryIds) {
      try {
        const rec = await audioGet(id);
        if (rec?.blob) { blob = rec.blob; break; }
      } catch {}
    }

    if (!blob) { failed++; continue; }

    try {
      const compressed = await compressAudioForUpload(blob);
      const fileName = v.fileName || v.label || "audio";
      const result = await supabaseUploadAudio({
        blob: new File([compressed], fileName, { type: compressed.type || v.fileType || "audio/*" }),
        songId: song.id,
        versionId: v.id,
        fileName,
      });
      if (result.success) {
        v.audioPath = result.audioPath;
        uploaded++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
    toast(`Backing up audio: ${uploaded + failed}/${toUpload.length}…`);
  }

  if (uploaded) {
    saveState();
    await supabasePushState(state).catch(console.warn);
    render();
  }

  const msg = failed
    ? `Backed up ${uploaded}/${toUpload.length} (${failed} failed)`
    : `All ${uploaded} tracks backed up to cloud`;
  toast(msg);
  return { uploaded, failed };
}

// Sync debug: check each version's audio availability
// Returns "green" (local + synced to cloud), "yellow" (local only, not backed up), "red" (no audio)
function getVersionSyncColor(v) {
  if (!v) return "red";
  const hasLocal = !!(v.fileId || v.localAudioId || v.link || _cachedAudioPaths.has(v.audioPath));
  const hasClouds = !!v.audioPath;
  if (hasLocal && hasClouds) return "green";
  if (hasLocal || hasClouds) return "yellow";
  return "red";
}

// Returns best-case sync color across versions that have audio.
// Versions with no audio at all are ignored (they're empty, not broken).
// Only returns "red" if NO version has any audio source.
function getSongSyncColor(song) {
  if (!song?.versions?.length) return "red";
  let best = "red";
  for (const v of song.versions) {
    const c = getVersionSyncColor(v);
    if (c === "green") return "green";
    if (c === "yellow") best = "yellow";
  }
  return best;
}

// Returns an HTML dot string for debug overlay (empty string if debug off)
function syncDot(song) {
  if (!window.RIFFBANK_DEBUG_SYNC) return "";
  const color = getSongSyncColor(song);
  const label = color === "green" ? "Synced" : color === "yellow" ? "Local only" : "No audio";
  return `<span class="syncDot syncDot--${color}" title="${label}"></span>`;
}

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
    const vv = s.versions.find(v => v.isActive) || s.versions[0];
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
  if (playerFilter === "projects") out = out.filter(x => x.project);
  // "playlists" and "releases" are future — show all for now
  // "all" = Riffs (default) — shows everything

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
        // Hide the app shell before reloading so the home screen doesn't
        // flash visible during the page transition (splash-flash bug).
        document.body.classList.add("splashing");
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
  profile: "Profile",
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
  ownerFilter: "all", // "all" | "mine" | "shared"
};

let projectsOwnerFilter = "all"; // "all" | "mine" | "shared"

let drawerView = null;
let songsBackTarget = null; // e.g. "projects" | "collabs"
let drawerOpen = false;
let overlayView = null;
let friendProfileId = null; // user ID for public profile view
let collabMode = false; // true when drilling into shared content from Collab tab

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
  if (currentTab === "profile") { headerBackEl.style.display = "none"; return; }
  // Collab root — no sidebar, hide back button
  const onCollabRoot = currentTab === "collab" && !overlayView && !selectedSongId && !projectDetailScreen && !drawerView;
  if (onCollabRoot) { headerBackEl.style.display = "none"; return; }
  const onRoot =
    ROOT_TABS.has(currentTab) &&
    !drawerView &&
    !overlayView &&
    !selectedSongId &&
    !selectedVersionId &&
    !projectDetailScreen &&
    !releaseDetailId &&
    songsView !== "create";
  headerBackEl.style.display = onRoot ? "none" : "flex";
}

// Wire back button once
headerBackEl?.addEventListener("click", () => {
  goBack({ animate: true });
});

function syncTabs() {
  const highlightTab = currentTab === "songs" ? "home" : currentTab;
  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === highlightTab);
  });
  syncProfileNavIcon();
}

function getSong(id) {
  return state.songs.find((s) => s.id === id)
    || (state._sharedSongsCache || []).find(s => s.id === id);
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

// Drawer controls
$("#drawerCloseBtn")?.addEventListener("click", closeDrawer);
$("#drawerOverlay")?.addEventListener("click", closeDrawer);

// Drawer menu items
document.querySelectorAll(".drawerItem").forEach((btn) => {
  btn.addEventListener("click", () => setDrawerView(btn.dataset.drawer));
});

// Create button in bottom nav
document.querySelector(".createNavBtn")?.addEventListener("click", () => openCreateOverlay());

// ── Sal SVG mascot ──────────────────────────────────────────────────
// Auto-traced from sal.png using vtracer. Transparent background.
// Returns an <img> tag pointing to the SVG file.
function salSvg(size = 140) {
  return `<img src="./sal.svg" alt="Sal" width="${size}" style="height:auto;">`;
}

// ── Onboarding cleanup — fades + removes all onboarding overlays ────
function dismissOnboarding() {
  document.querySelectorAll(".welcomeScreen, .driveScreen").forEach(el => {
    el.classList.add("welcomeOut");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  });
  document.body.classList.remove("welcoming");
}

// ── Welcome screen (Duolingo-style landing after splash) ────────────
// Returns a promise that resolves when user taps a button.
// result: "getStarted" or "hasAccount"
function showWelcomeScreen() {
  return new Promise(resolve => {
    document.body.classList.add("welcoming");
    const el = document.createElement("div");
    el.id = "welcomeScreen";
    // Start fully opaque so it seamlessly replaces the splash overlay
    el.className = "welcomeScreen welcomeIn";
    el.innerHTML = `
      <div class="welcomeSalWrap">
        ${salSvg(140)}
      </div>
      <div class="welcomeTitle">RiffBank</div>
      <div class="welcomeSub">Your music. Everywhere.</div>
      <div class="welcomeBtns">
        <button class="welcomeBtn welcomeBtnPrimary" data-action="getStarted">GET STARTED</button>
        <button class="welcomeBtn welcomeBtnSecondary" data-action="hasAccount">I ALREADY HAVE AN ACCOUNT</button>
      </div>
    `;

    el.addEventListener("click", e => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      // Resolve immediately — the overlay stays in place so the app shell
      // never flashes. init() will call dismissOnboarding() after render().
      resolve(btn.dataset.action);
    });

    document.body.appendChild(el);
    // Welcome is already opaque; now safe to unhide the app shell behind it
    document.body.classList.remove("splashing");
  });
}

// ── Drive connect screen (Duolingo-style, after welcome) ────────────
// Returns a promise: { action: "connected"|"skip"|"back", email?, homeFolderName? }
function showDriveScreen() {
  return new Promise(resolve => {
    const el = document.createElement("div");
    el.className = "driveScreen";
    el.innerHTML = `
      <button class="driveBackBtn" data-action="back">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
      </button>
      <div class="driveBubbleArea">
        <div class="driveBubble">
          <strong>RiffBank</strong> stores, manages, and releases all of your in-progress songs in the cloud.
        </div>
        <div class="driveSalWrap">${salSvg(120)}</div>
      </div>
      <div class="driveBtns">
        <button class="driveBtnConnect" data-action="connect">CONNECT GOOGLE DRIVE</button>
        <button class="driveBtnSkip" data-action="skip">Maybe later</button>
      </div>
    `;

    let _signedInEmail = "";
    let _existingFolderId = null;

    el.addEventListener("click", async e => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;

      if (action === "back" || action === "skip") {
        // Resolve immediately — overlay stays. init() cleans up after render().
        resolve({ action });
        return;
      }

      if (action === "connect" || action === "connectExisting" || action === "pick") {
        // Cloud auth handled by Supabase auth screen — skip legacy Drive flow
        resolve({ action: "skip" });
      }
    });

    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("welcomeIn"));
  });
}

// Profile nav button — inject user avatar into nav icon
function syncProfileNavIcon() {
  const navIcon = document.querySelector(".profileNavIcon");
  if (!navIcon) return;
  const avatarUrl = state.settings?.profileAvatarUrl;
  if (avatarUrl?.startsWith("preset:")) {
    const presetId = avatarUrl.replace("preset:", "");
    const preset = AVATAR_PRESETS.find(p => p.id === presetId);
    if (preset) navIcon.innerHTML = `<div class="profileNavImg" style="overflow:hidden;display:flex;align-items:center;justify-content:center">${renderAvatarPreset(preset)}</div>`;
  } else if (avatarUrl?.startsWith("http")) {
    navIcon.innerHTML = `<img class="profileNavImg" src="${avatarUrl}" />`;
  }
  // else keep the default SVG from HTML
}

// Unread message badge — updates Collab nav icon + Messages sidebar button
let _unreadMsgCount = 0;
let _prevUnreadMsgCount = 0;

// Request notification permission (called once on first message interaction)
let _notifPermissionAsked = false;
async function requestNotificationPermission() {
  if (_notifPermissionAsked) return;
  _notifPermissionAsked = true;
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
}

// Show a local push notification for new messages
function _showMessageNotification(newCount) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && overlayView === "chat") return; // user is in chat
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
    getPendingFriendCount().catch(() => 0),
  ]).then(([msgCount, friendCount]) => {
    // Show notification if new messages arrived since last check
    if (msgCount > _unreadMsgCount) {
      _showMessageNotification(msgCount);
    }
    _prevUnreadMsgCount = _unreadMsgCount;
    _unreadMsgCount = msgCount;
    _pendingFriendCount = friendCount;
    _applyAllBadges(msgCount, friendCount);
  });
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

// Poll shared data every 30s to detect new shares and show notifications
setInterval(() => { refreshSharedData().catch(() => {}); }, 30000);

// Also check when app comes back to foreground
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    syncMessageBadges();
    refreshSharedData().catch(() => {});
  }
});

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
      ${salSvg(80)}
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

// Sal first-time onboarding — auto-opens once for new users
function openSalOnboarding({ force = false } = {}) {
  if (!force && localStorage.getItem("salOnboardingDone")) return;
  if (!force && state.songs?.length) { localStorage.setItem("salOnboardingDone", "1"); return; }

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
    <div style="display:flex;flex-direction:column;align-items:center;padding:32px 24px 20px;gap:14px;">
      ${salSvg(96)}
      <div style="font-size:24px;font-weight:900;color:#fff;letter-spacing:-0.4px;">Welcome to RiffBank!</div>
      <div style="font-size:15px;color:rgba(255,255,255,.55);text-align:center;line-height:1.7;max-width:290px;">
        Hey, I'm <strong style="color:#fff;">Sal</strong>! I'll be your guide around here.<br><br>
        RiffBank keeps all your songs, versions, and projects safe in the <strong style="color:#fff;">cloud</strong> — record on any device and access your music anywhere.
      </div>
    </div>
    <div style="height:1px;background:rgba(255,255,255,.08);margin:0 16px;"></div>
    <div style="padding:8px 0 6px;display:flex;flex-direction:column;">
      <button class="actionSheetBtn" id="salDismiss" style="font-weight:700;">Got it, let's go!</button>
    </div>
  `;

  function close() { backdrop.remove(); sheet.remove(); localStorage.setItem("salOnboardingDone", "1"); }

  backdrop.addEventListener("click", close);
  sheet.querySelector("#salDismiss")?.addEventListener("click", close);

  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
}

// Tabs
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetTab = btn.dataset.tab || "home";

    // Already on home root with no overlays — nothing to do
    if (targetTab === "home" && currentTab === "home" && nav.depth === 0 && !drawerView && !overlayView) {
      return;
    }

    // If tapping home while deep in a nav stack, jump straight to home
    if (targetTab === "home" && nav.depth > 0) {
      nav.slideTransition({ direction: "jumpHome", mutate: () => {
        songsBackTarget = null;
        drawerView = null;
        overlayView = null;
        selectedSongId = null;
        selectedVersionId = null;
        projectDetailScreen = null;
        releaseDetailId = null;
        songsView = "list";
        songsListScrollTop = 0;
        collabMode = false;
        currentTab = "home";
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

    songsBackTarget = null;
    nav.clearStacks();

    // Normal navigation
    drawerView = null;
    overlayView = null;
    selectedSongId = null;
    selectedVersionId = null;
    projectDetailScreen = null;
    releaseDetailId = null;
    songsView = "list";
    songsListScrollTop = 0;
    collabMode = false;

    currentTab = targetTab;
    if (targetTab === "player") {
      playerScreen = "list";
    }

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
  const resetToHome = () => {
    drawerView = null;
    overlayView = null;
    selectedSongId = null;
    selectedVersionId = null;
    projectDetailScreen = null;
    releaseDetailId = null;
    songsView = "list";
    songsListScrollTop = 0;
    collabMode = false;
    currentTab = "home";
    songsBackTarget = null;
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
  if (currentTab === "home" && nav.depth > 0) {
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
  nav.slideTransition({ direction: "back", mutate: renderUnderneath });
}

function goBack({ animate = false } = {}) {
  // Prevent double-back while a View Transition is still in flight
  if (nav._transitionActive) return;
  const doRender = () => {
    if (drawerOpen) { closeDrawer(); return; }

    // Resolve the state to restore: animated backs already popped in slideTransition/nav.back()
    // (pendingBackState), non-animated backs pop here.
    let restoreState = animate ? nav.consumePendingState() : nav.popStacks();

    if (restoreState) {
      currentTab = restoreState.currentTab;
      drawerView = restoreState.drawerView;
      projectDetailScreen = restoreState.projectDetailScreen;
      releaseDetailId = restoreState.releaseDetailId;
      selectedSongId = restoreState.selectedSongId;
      selectedVersionId = restoreState.selectedVersionId;
      songsView = restoreState.songsView;
      overlayView = restoreState.overlayView;
      friendProfileId = restoreState.friendProfileId ?? null;
      songsBackTarget = restoreState.songsBackTarget;
      lyricsEditSongId = restoreState.lyricsEditSongId ?? null;
      collabMode = restoreState.collabMode ?? false;
      // Going back to home resets songs scroll so next visit starts fresh
      if (restoreState.currentTab === "home" && !restoreState.drawerView) songsListScrollTop = 0;
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
    if (overlayView) {
      overlayView = null;
      currentTab = "home";
      drawerView = null;
      selectedSongId = null;
      songsView = "list";
      songsListScrollTop = 0;
      nav.clearStacks();
      setHeader("RiffBank");
      syncTabs();
      render();
      return;
    }

    if (currentTab !== "home" || drawerView) {
      currentTab = "home";
      drawerView = null;
      projectDetailScreen = null;
      releaseDetailId = null;
      songsView = "list";
      songsListScrollTop = 0;
      selectedSongId = null;
      selectedVersionId = null;
      collabMode = false;
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

// Collab sidebar close gesture (sidebar open, touch anywhere)
if (_collabSidebarOpen && currentTab === "collab" && !projectDetailScreen && !selectedSongId && !overlayView) {
  _sidebarTouchStart(t);
  return;
}

// Left-edge gesture
if (!drawerOpen && t.clientX <= 24) {
  // Player has nothing to go back to; bare home/collab root has nothing to go back to
  if (currentTab === "player") return;
  if (currentTab === "collab" && !projectDetailScreen && !selectedSongId && !overlayView) { _sidebarTouchStart(t); return; }
  if (currentTab === "home" && !drawerView && !overlayView) return;

  touchTracking = true;
  const onHomeRoot = (currentTab === "home" && !drawerView && !overlayView);
  touchMode = onHomeRoot ? "open" : "back";
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

  // Drawer close gesture
  if (drawerOpen) {
    touchTracking = true;
    touchMode = "close";
    touchStartX = t.clientX;
    touchStartY = t.clientY;
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

  if (touchMode === "open" && dx >= 60) {
    openDrawer();
    touchTracking = false;
    touchMode = null;
  }

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

  if (touchMode === "close" && dx <= -60) {
    closeDrawer();
    touchTracking = false;
    touchMode = null;
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
        const audioId = uid();
        v.fileId = audioId;
        v.fileName = _sheetAudioFile.name || "audio";
        v.fileType = _sheetAudioFile.type || "audio/*";
        v.fileSize = _sheetAudioFile.size || 0;
        song.updatedAt = nowStamp();
        saveState();
        toast("Created with audio 🎸");

        // IndexedDB + cloud upload both run in background (non-blocking)
        audioPut({
          id: audioId,
          name: _sheetAudioFile.name || "audio",
          type: _sheetAudioFile.type || "audio/*",
          size: _sheetAudioFile.size || 0,
          blob: _sheetAudioFile,
          createdAt: nowStamp(),
        }).then(() => {
          attachSharedAudioCloud(song, v, _sheetAudioFile, _sheetAudioFile.name || "audio", _sheetAudioFile.type || "audio/*");
        }).catch(e => {
          console.warn("[audioPut bg] failed:", e);
          toast("Local save failed");
        });
      } else {
        saveState();
        toast("Created 🎸");
      }

      closeSheet();
      currentTab = "songs";
      songsView = "list";
      selectedSongId = song.id;
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
    lyricsEditSongId = null;
    overlayView = "lyrics";
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
      currentTab = "songs";
      songsView = "list";
      selectedSongId = song.id;
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
      currentTab = "songs";
      songsView = "list";
      selectedSongId = null;
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
        <button class="sheetChoice" id="sdmShare">
          Share Song
          <span class="sub">send to a collaborator</span>
        </button>
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
          selectedVersionId = first.id;
        });
        return;
      }
      navigateForward(() => {
        selectedVersionId = fv.id;
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
      artCooldownUntil = Date.now() + 10000;
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

    $("#sdmShare")?.addEventListener("click", () => {
      closeSheet();
      shareInviteSong(song.id);
    });

    $("#sdmDelete")?.addEventListener("click", async () => {
      if (!confirm(`Delete "${song.title}"?`)) return;
      state.songs = state.songs.filter(s => s.id !== song.id);
      saveState();
      closeSheet();
      selectedSongId = null;
      selectedVersionId = null;
      songsView = "list";
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
      if (projectDetailScreen === p) projectDetailScreen = trimmed;
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
      releaseDetailId = null;
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
    createOverlayEl.querySelector("#coCreateSong")?.addEventListener("click", async () => {
      const title = (createOverlayEl?.querySelector("#coTitle")?.value || "").trim();
      if (!title) return toast("Give it a title");

      let project = createSelectedProject;
      if (project === "__new__") {
        project = (createOverlayEl?.querySelector("#coNewProject")?.value || "").trim();
        if (!project) return toast("Enter a project name");
      }
      if (!project) return toast("Pick a project");

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
        const audioId = uid();
        v.fileId = audioId;
        v.fileName = createAudioFile.name || "audio";
        v.fileType = createAudioFile.type || "audio/*";
        v.fileSize = createAudioFile.size || 0;
        song.updatedAt = nowStamp();
        saveState();
        toast("Created with audio 🎸");

        // IndexedDB + cloud upload in background (don't block navigation)
        logActivity(v.id, song.title, "saving", "Saving locally…");
        audioPut({
          id: audioId,
          name: createAudioFile.name || "audio",
          type: createAudioFile.type || "audio/*",
          size: createAudioFile.size || 0,
          blob: createAudioFile,
          createdAt: nowStamp(),
        }).then(() => {
          attachSharedAudioCloud(song, v, createAudioFile, createAudioFile.name || "audio", createAudioFile.type || "audio/*");
        }).catch(e => {
          console.warn("[audioPut bg] failed:", e);
          logActivity(v.id, song.title, "failed", "Local save failed");
          toast("Local save failed");
        });
      } else {
        saveState();
        toast("Created");
      }

      // Remove overlay instantly (no CSS transition) so navigateForward captures Home underneath
      if (createOverlayEl) { createOverlayEl.remove(); createOverlayEl = null; }

      navigateForward(() => {
        currentTab = "songs";
        songsView = "list";
        selectedSongId = song.id;
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
  // Snapshot current screen so nav.forward()/nav.back() can show it as the ace
  nav.snapshot(activeScreenEl);

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

  // On forward navigation, reset scroll so screens always start at the top
  const _isBack = nav._isBackNav;

  // Drawer screens
  if (drawerView === "projects") {
    if (projectDetailScreen) {
      setActiveScreen("projectDetail");
      if (!_isBack) activeScreenEl.scrollTop = 0;
      return renderProjectSongs(projectDetailScreen);
    }
    setActiveScreen("drawer");
    if (!_isBack) activeScreenEl.scrollTop = 0;
    return renderProjects();
  }
  if (drawerView === "releases") { setActiveScreen("drawer"); if (!_isBack) activeScreenEl.scrollTop = 0; return releaseDetailId ? renderReleaseDetail(releaseDetailId) : renderReleases(); }
  if (drawerView === "eps") { setActiveScreen("drawer"); if (!_isBack) activeScreenEl.scrollTop = 0; return renderEPs(); }
  if (drawerView === "collabs") { setActiveScreen("drawer"); if (!_isBack) activeScreenEl.scrollTop = 0; return renderCollaborators(); }
  if (drawerView === "importExport") { setActiveScreen("drawer"); if (!_isBack) activeScreenEl.scrollTop = 0; return renderImportExport(); }
  if (drawerView === "about") { setActiveScreen("drawer"); if (!_isBack) activeScreenEl.scrollTop = 0; return renderAbout(); }
  if (drawerView === "globalSearch") { setActiveScreen("drawer"); if (!_isBack) activeScreenEl.scrollTop = 0; return renderGlobalSearch(); }
  if (drawerView === "alerts") { setActiveScreen("drawer"); if (!_isBack) activeScreenEl.scrollTop = 0; return renderAlerts(); }

  // Overlay screens (lyrics, friends, etc.)
  if (overlayView === "lyrics") {
    setActiveScreen("home");
    if (!_isBack) activeScreenEl.scrollTop = 0;
    return renderLyricsScratch();
  }
  if (overlayView === "friendRequests") {
    setActiveScreen("collab");
    if (!_isBack) activeScreenEl.scrollTop = 0;
    return renderFriendRequests();
  }
  if (overlayView === "friendsList") {
    setActiveScreen("collab");
    if (!_isBack) activeScreenEl.scrollTop = 0;
    return renderFriendsList();
  }
  if (overlayView === "addFriend") {
    setActiveScreen("collab");
    if (!_isBack) activeScreenEl.scrollTop = 0;
    return renderAddFriend();
  }
  if (overlayView === "friendProfile") {
    setActiveScreen("collab");
    if (!_isBack) activeScreenEl.scrollTop = 0;
    return renderFriendProfile(friendProfileId);
  }
  if (overlayView === "messages") {
    setActiveScreen("collab");
    if (!_isBack) activeScreenEl.scrollTop = 0;
    return renderMessages();
  }
  if (overlayView === "chat") {
    setActiveScreen("collab");
    if (!_isBack) activeScreenEl.scrollTop = 0;
    return renderChat(friendProfileId);
  }

  // Normal screens
  if (currentTab === "home") {
    setActiveScreen("home");
    if (!_isBack) activeScreenEl.scrollTop = 0;
    // On back-nav, reuse existing home if particles are still alive (avoids position jump)
    const existingGrid = activeScreenEl.querySelector(".homeGrid");
    if (_isBack && existingGrid && existingGrid._cleanupHome) return;
    return renderHome();
  }
  if (currentTab === "songs") {
    if (selectedSongId && selectedVersionId) {
      setActiveScreen("versionDetail");
      if (!_isBack) activeScreenEl.scrollTop = 0;
      return renderVersionDetail(selectedSongId, selectedVersionId);
    }
    if (selectedSongId) {
      setActiveScreen("songDetail");
      if (!_isBack) activeScreenEl.scrollTop = 0;
      return renderSongDetail(selectedSongId);
    }
    setActiveScreen("songs");
    if (!_isBack) activeScreenEl.scrollTop = 0;
    if (songsView === "create") return renderSongCreate();
    return renderSongsList();
  }
  if (currentTab === "player") {
    setActiveScreen("player");
    if (playerScreen === "now") return renderNowPlaying();
    return renderPlayer();
  }
  if (currentTab === "collab") {
    if (projectDetailScreen) {
      if (selectedSongId && selectedVersionId) {
        setActiveScreen("versionDetail");
        if (!_isBack) activeScreenEl.scrollTop = 0;
        return renderVersionDetail(selectedSongId, selectedVersionId);
      }
      if (selectedSongId) {
        setActiveScreen("songDetail");
        if (!_isBack) activeScreenEl.scrollTop = 0;
        return renderSongDetail(selectedSongId);
      }
      setActiveScreen("projectDetail");
      if (!_isBack) activeScreenEl.scrollTop = 0;
      return renderProjectSongs(projectDetailScreen);
    }
    if (selectedSongId && selectedVersionId) {
      setActiveScreen("versionDetail");
      if (!_isBack) activeScreenEl.scrollTop = 0;
      return renderVersionDetail(selectedSongId, selectedVersionId);
    }
    if (selectedSongId) {
      setActiveScreen("songDetail");
      if (!_isBack) activeScreenEl.scrollTop = 0;
      return renderSongDetail(selectedSongId);
    }
    setActiveScreen("collab");
    return renderCollab();
  }
  if (currentTab === "profile") { setActiveScreen("collab"); return renderProfile(); }
  if (currentTab === "settings") { setActiveScreen("settings"); return renderSettings(); }
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
      if (existing?.blob) { _cachedAudioPaths.add(v.audioPath); continue; }
      const blob = await supabaseFetchAudioBlob(v.audioPath);
      if (blob) {
        _cachedAudioPaths.add(v.audioPath);
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

    // Create version and attach audio — navigate immediately, storage in background
    const v = createVersion(song);
    const audioId = uid();
    v.fileId = audioId;
    v.fileName = fileName;
    v.fileType = fileType;
    v.fileSize = fileSize;
    song.updatedAt = nowStamp();
    saveState();

    closeSheet();
    toast("Created with audio 🎸");

    // IndexedDB + cloud both in background (iOS IndexedDB blob writes are slow)
    audioPut({ id: audioId, name: fileName, type: fileType, size: fileSize, blob, createdAt: nowStamp() })
      .then(() => attachSharedAudioCloud(song, v, blob, fileName, fileType))
      .catch(e => { console.warn("[audioPut bg] failed:", e); toast("Local save failed"); });

    currentTab = "songs";
    songsView = "list";
    selectedSongId = song.id;
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
      const audioId = uid();
      v.fileId = audioId;
      v.fileName = fileName;
      v.fileType = fileType;
      v.fileSize = fileSize;
      song.updatedAt = nowStamp();
      saveState();

      closeSheet();
      toast(`Added v${song.versions.length} to ${song.title} 🎸`);

      // IndexedDB + cloud both in background (iOS IndexedDB blob writes are slow)
      audioPut({ id: audioId, name: fileName, type: fileType, size: fileSize, blob, createdAt: nowStamp() })
        .then(() => attachSharedAudioCloud(song, v, blob, fileName, fileType))
        .catch(e => { console.warn("[audioPut bg] failed:", e); toast("Local save failed"); });

      currentTab = "songs";
      songsView = "list";
      selectedSongId = song.id;
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
    const compressed = await compressAudioForUpload(blob);
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
      toast("Local saved, cloud sync failed");
    }
  } catch (e) {
    console.warn("[attachSharedAudio] cloud upload failed:", e);
    toast("Local saved, cloud sync failed");
  }
}

// Cloud-only portion of attachSharedAudio (fire-and-forget for non-blocking uploads)
async function attachSharedAudioCloud(song, v, blob, fileName, fileType) {
  const logId = v.id || uid();
  const title = song.title || fileName;
  logActivity(logId, title, "saving", "Saving locally…");
  toast("Syncing to cloud…");
  try {
    logActivity(logId, title, "compressing", "Compressing audio…");
    const compressed = await compressAudioForUpload(blob);
    logActivity(logId, title, "uploading", "Uploading to cloud…");
    const result = await supabaseUploadAudio({
      blob: new File([compressed], fileName, { type: compressed.type || fileType }),
      songId: song.id,
      versionId: v.id,
      fileName,
    });
    if (result.success) {
      v.audioPath = result.audioPath;
      localStorage.setItem(LS_KEY, JSON.stringify(state));
      logActivity(logId, title, "syncing", "Syncing song record…");
      const pushOk = await supabasePushState(state).catch(e => { console.warn("[Push]", e); return false; });
      logActivity(logId, title, "done", pushOk ? "Synced to cloud" : "Audio uploaded, record sync failed");
      toast(pushOk ? "Synced to cloud" : "Audio uploaded, but song record failed to sync");
    } else {
      logActivity(logId, title, "failed", "Cloud upload failed");
      toast("Local saved, cloud sync failed");
    }
  } catch (e) {
    console.warn("[attachSharedAudioCloud] cloud upload failed:", e);
    logActivity(logId, title, "failed", "Cloud upload error");
    toast("Local saved, cloud sync failed");
  }
}

// ── Auth screen (card layout + Sal + OTP verification) ────────────
function showAuthScreen() {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.id = "authScreen";
    el.className = "authScreen";

    // Step 1: Login / Signup form
    // Render shell first WITHOUT inputs — iOS scans DOM on first paint for autofill.
    // Inputs are injected after a delay so iOS never sees a "login form".
    function renderForm() {
      el.innerHTML = `
        <div class="authCard">
          <div class="authSalWrap">${salSvg(80)}</div>
          <div class="authLogo">RiffBank</div>
          <div class="authToggle">
            <button class="authToggleBtn active" data-mode="login">Log In</button>
            <button class="authToggleBtn" data-mode="signup">Sign Up</button>
          </div>
          <form id="authForm" autocomplete="off">
            <div id="authInputs"></div>
            <div id="authError" class="authError"></div>
            <button id="authSubmit" type="submit" class="authSubmitBtn">Log In</button>
          </form>
        </div>
      `;
      // Inject inputs after iOS autofill scan completes
      setTimeout(() => {
        const slot = el.querySelector("#authInputs");
        if (!slot) return;
        slot.innerHTML = `
          <input id="authEmail" type="text" inputmode="email" placeholder="Email" required autocomplete="off" />
          <div class="authPassWrap">
            <input id="authPass" type="text" class="authPassMasked" placeholder="Password" required autocomplete="off" />
            <button type="button" class="authEyeBtn" id="authEye" aria-label="Show password">
              <svg class="authEyeOpen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              <svg class="authEyeClosed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            </button>
          </div>
        `;
        wireForm();
      }, 500);
    }

    // Step 2: OTP code entry (after signup)
    function renderOtp(email) {
      el.innerHTML = `
        <div class="authCard">
          <div class="authSalWrap">${salSvg(80)}</div>
          <div class="authLogo">Check Your Email</div>
          <div class="authOtpHint">
            We sent a 6-digit code to<br><strong>${email}</strong>
          </div>
          <form id="otpForm">
            <div class="authOtpRow">
              <input class="authOtpDigit" type="text" inputmode="numeric" maxlength="1" autocomplete="one-time-code" />
              <input class="authOtpDigit" type="text" inputmode="numeric" maxlength="1" />
              <input class="authOtpDigit" type="text" inputmode="numeric" maxlength="1" />
              <input class="authOtpDigit" type="text" inputmode="numeric" maxlength="1" />
              <input class="authOtpDigit" type="text" inputmode="numeric" maxlength="1" />
              <input class="authOtpDigit" type="text" inputmode="numeric" maxlength="1" />
            </div>
            <div id="authError" class="authError"></div>
            <button id="otpSubmit" type="submit" class="authSubmitBtn">Verify</button>
          </form>
          <div class="authOtpLinks">
            <button class="authLinkBtn" id="otpResend">Resend code</button>
            <button class="authLinkBtn" id="otpBack">Back to login</button>
          </div>
        </div>
      `;
      wireOtp(email);
    }

    function wireForm() {
      let mode = "login";
      const toggleBtns = el.querySelectorAll(".authToggleBtn");
      const submitBtn = el.querySelector("#authSubmit");
      const errorEl = el.querySelector("#authError");
      const passInput = el.querySelector("#authPass");
      const eyeBtn = el.querySelector("#authEye");

      // Password visibility toggle
      eyeBtn.addEventListener("click", () => {
        const showing = passInput.classList.contains("authPassMasked");
        passInput.classList.toggle("authPassMasked", !showing);
        eyeBtn.classList.toggle("showing", showing);
      });

      toggleBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          mode = btn.dataset.mode;
          toggleBtns.forEach((b) => b.classList.toggle("active", b === btn));
          submitBtn.textContent = mode === "login" ? "Log In" : "Create Account";
          errorEl.textContent = "";
        });
      });

      el.querySelector("#authForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = el.querySelector("#authEmail").value.trim();
        const pass = el.querySelector("#authPass").value;
        errorEl.textContent = "";
        errorEl.style.color = "";
        submitBtn.disabled = true;
        submitBtn.textContent = mode === "login" ? "Logging in..." : "Creating account...";

        try {
          if (mode === "signup") {
            const data = await signUp(email, pass);
            if (data.user && !data.session) {
              // Email confirmation required — show OTP screen
              renderOtp(email);
              return;
            }
            // Supabase returns a user with a fake session if the email already
            // exists but is unconfirmed — detect that and resend confirmation
            if (data.user && data.user.identities?.length === 0) {
              // User exists already — resend confirmation and go to OTP
              try { await resendConfirmation(email); } catch {}
              renderOtp(email);
              return;
            }
          } else {
            await signIn(email, pass);
          }
          el.classList.add("authFadeOut");
          setTimeout(() => { el.remove(); resolve(); }, 300);
        } catch (err) {
          const msg = err.message || "Something went wrong";
          // If login fails with "invalid credentials" it might be an unconfirmed account
          if (mode === "login" && msg.toLowerCase().includes("invalid")) {
            errorEl.style.color = "";
            errorEl.innerHTML = `Invalid credentials. Haven't confirmed your email? <button class="authInlineLink" id="authResendFromError">Resend code</button>`;
            const resendLink = el.querySelector("#authResendFromError");
            if (resendLink) {
              resendLink.addEventListener("click", async () => {
                resendLink.textContent = "Sending...";
                try {
                  await resendConfirmation(email);
                  renderOtp(email);
                } catch (e2) {
                  errorEl.textContent = e2.message || "Couldn't resend";
                }
              });
            }
          } else {
            errorEl.style.color = "";
            errorEl.textContent = msg;
          }
          submitBtn.disabled = false;
          submitBtn.textContent = mode === "login" ? "Log In" : "Create Account";
        }
      });
    }

    function wireOtp(email) {
      const digits = el.querySelectorAll(".authOtpDigit");
      const submitBtn = el.querySelector("#otpSubmit");
      const errorEl = el.querySelector("#authError");

      // Auto-focus first input
      digits[0].focus();

      // Auto-advance on input, support paste
      digits.forEach((input, i) => {
        input.addEventListener("input", () => {
          const val = input.value.replace(/\D/g, "");
          input.value = val.slice(0, 1);
          if (val && i < digits.length - 1) digits[i + 1].focus();
        });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Backspace" && !input.value && i > 0) {
            digits[i - 1].focus();
          }
        });
        input.addEventListener("paste", (e) => {
          e.preventDefault();
          const pasted = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 6);
          pasted.split("").forEach((ch, j) => {
            if (digits[j]) digits[j].value = ch;
          });
          if (pasted.length > 0) digits[Math.min(pasted.length, digits.length) - 1].focus();
        });
      });

      el.querySelector("#otpForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const code = Array.from(digits).map(d => d.value).join("");
        if (code.length !== 6) {
          errorEl.textContent = "Enter all 6 digits";
          return;
        }
        errorEl.textContent = "";
        submitBtn.disabled = true;
        submitBtn.textContent = "Verifying...";

        try {
          await verifyOtp(email, code);
          el.classList.add("authFadeOut");
          setTimeout(() => { el.remove(); resolve(); }, 300);
        } catch (err) {
          errorEl.textContent = err.message || "Invalid code — try again";
          submitBtn.disabled = false;
          submitBtn.textContent = "Verify";
        }
      });

      // Resend code
      const resendBtn = el.querySelector("#otpResend");
      resendBtn.addEventListener("click", async () => {
        resendBtn.disabled = true;
        resendBtn.textContent = "Sending...";
        try {
          await resendConfirmation(email);
          errorEl.style.color = "#22c55e";
          errorEl.textContent = "New code sent!";
          // Clear old digits
          digits.forEach(d => { d.value = ""; });
          digits[0].focus();
        } catch (err) {
          errorEl.style.color = "";
          errorEl.textContent = err.message || "Couldn't resend — try again";
        }
        resendBtn.disabled = false;
        resendBtn.textContent = "Resend code";
      });

      el.querySelector("#otpBack").addEventListener("click", () => renderForm());
    }

    document.body.appendChild(el);
    renderForm();

    // Prevent iOS from scrolling behind the auth overlay on any input focus
    el.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });

    if (window.visualViewport) {
      let lastH = window.visualViewport.height;
      const onResize = () => {
        const vv = window.visualViewport;
        lastH = vv.height;
        el.style.height = vv.height + "px";
        el.style.top = vv.offsetTop + "px";
        el.style.bottom = "auto";
        window.scrollTo(0, 0);
      };
      const onScroll = () => {
        const vv = window.visualViewport;
        el.style.top = vv.offsetTop + "px";
      };
      window.visualViewport.addEventListener("resize", onResize);
      window.visualViewport.addEventListener("scroll", onScroll);
      const obs = new MutationObserver(() => {
        if (!document.getElementById("authScreen")) {
          window.visualViewport.removeEventListener("resize", onResize);
          window.visualViewport.removeEventListener("scroll", onScroll);
          obs.disconnect();
        }
      });
      obs.observe(document.body, { childList: true });
    }
  });
}

// ── Sal Import Flow ──────────────────────────────────────────────
// Post-auth flow: checks cloud for existing songs, offers import,
// then optionally runs the onboarding walkthrough.

let _importFlowRan = false;

function showSalImportOffer(count) {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "salImportOffer";
    el.innerHTML = `
      <div class="salImportOfferCard">
        <div class="salImportOfferSal salBounce">${salSvg(96)}</div>
        <div class="salImportOfferMsg">
          Hey, welcome back! Looks like you've got <strong>${count} song${count !== 1 ? "s" : ""}</strong> floating in the cloud. Want me to grab ${count !== 1 ? "them" : "it"} for you?
        </div>
        <button class="salImportBtn" id="salImportGo">Let's go!</button>
        <button class="salImportSkipBtn" id="salImportSkip">Skip for now</button>
      </div>
    `;

    el.querySelector("#salImportGo").addEventListener("click", () => {
      el.classList.add("salImportFadeOut");
      setTimeout(() => { el.remove(); resolve("import"); }, 300);
    });
    el.querySelector("#salImportSkip").addEventListener("click", () => {
      el.classList.add("salImportFadeOut");
      setTimeout(() => { el.remove(); resolve("skip"); }, 300);
    });

    document.body.appendChild(el);
  });
}

function showSalImportScreen() {
  return new Promise(async (resolve) => {
    const el = document.createElement("div");
    el.className = "salImportScreen";

    // Pull full cloud state
    el.innerHTML = `
      <div class="salImportCard">
        <div class="salImportSalWrap"><div class="salIdle salBounce">${salSvg(80)}</div></div>
        <div class="salImportProgress">Preparing import...</div>
        <div class="salImportList"></div>
        <div class="salImportOverallBar"><div class="salImportOverallFill"></div></div>
      </div>
    `;
    document.body.appendChild(el);

    // Cycle Sal animations
    const salEl = el.querySelector(".salIdle");
    const salAnims = ["salBounce", "salSpin", "salSlide", "salPeek"];
    let salAnimIdx = 0;
    const salAnimTimer = setInterval(() => {
      salEl.classList.remove(...salAnims);
      salAnimIdx = (salAnimIdx + 1) % salAnims.length;
      salEl.classList.add(salAnims[salAnimIdx]);
    }, 4000);

    const listEl = el.querySelector(".salImportList");
    const progressEl = el.querySelector(".salImportProgress");
    const overallFill = el.querySelector(".salImportOverallFill");

    // Fetch cloud data
    const cloudState = await supabasePullStateSilent();
    if (!cloudState?.songs?.length) {
      clearInterval(salAnimTimer);
      el.classList.add("salImportFadeOut");
      setTimeout(() => { el.remove(); resolve({ succeeded: [], failed: [] }); }, 300);
      return;
    }

    // Merge cloud songs into local state
    state.songs = cloudState.songs;
    state.releases = cloudState.releases || state.releases;
    state.projects = cloudState.projects || state.projects;
    normalizeState();
    saveState();

    // Build a list of ALL songs, and track which versions need audio downloaded
    const allSongs = state.songs;
    const toDownload = []; // { song, version, row } — versions needing audio blobs
    let done = 0;
    const total = allSongs.length;

    // Phase 1: Show all songs, instantly check off metadata-only ones
    for (const song of allSongs) {
      done++;
      progressEl.textContent = `Importing ${done} of ${total}...`;
      overallFill.style.width = `${(done / total) * 100}%`;

      const row = document.createElement("div");
      row.className = "salImportItem";

      // Check if this song has any versions with cloud audio to download
      let needsAudio = false;
      for (const v of (song.versions || [])) {
        if (!v.audioPath) continue;
        try {
          const existing = await audioGet(`supa:${v.audioPath}`);
          if (existing?.blob) { _cachedAudioPaths.add(v.audioPath); continue; }
        } catch {}
        needsAudio = true;
        toDownload.push({ song, version: v, row });
      }

      const versionCount = (song.versions || []).length;
      const subtitle = needsAudio
        ? `${versionCount} version${versionCount !== 1 ? "s" : ""} — downloading audio...`
        : `${versionCount} version${versionCount !== 1 ? "s" : ""}`;

      row.innerHTML = `
        <div class="salImportArt">${coverSvg(song, { lite: true })}</div>
        <div class="salImportMeta">
          <div class="salImportTitle">${song.title || "Untitled"}</div>
          <div class="salImportSub">${subtitle}</div>
        </div>
        <div class="salImportStatus ${needsAudio ? "salImportSpinner" : "salImportCheck"}"></div>
      `;
      listEl.appendChild(row);

      // Small stagger so cards animate in visibly
      await new Promise(r => setTimeout(r, 60));
      listEl.scrollTop = listEl.scrollHeight;
    }

    // Phase 2: Download audio blobs for versions that need them
    const succeeded = [];
    const failed = [];

    if (toDownload.length) {
      let audioDone = 0;
      progressEl.textContent = `Downloading audio: 0 of ${toDownload.length}...`;

      for (const item of toDownload) {
        const { song, version: v, row } = item;
        audioDone++;
        progressEl.textContent = `Downloading audio: ${audioDone} of ${toDownload.length}...`;

        try {
          const blob = await supabaseFetchAudioBlob(v.audioPath);
          if (blob) {
            await putAudioBlob({
              id: `supa:${v.audioPath}`,
              blob,
              name: v.fileName || v.label || "audio",
              type: v.fileType || blob.type || "audio/*",
              size: blob.size,
            });
            _cachedAudioPaths.add(v.audioPath);
            succeeded.push(item);
          } else {
            failed.push(item);
          }
        } catch {
          failed.push(item);
        }

        // Update the row status — check if all versions for this song are done
        const songItems = toDownload.filter(d => d.song === song);
        const songDone = songItems.every(d => succeeded.includes(d) || failed.includes(d));
        if (songDone) {
          const anyFailed = songItems.some(d => failed.includes(d));
          row.querySelector(".salImportStatus").className = `salImportStatus ${anyFailed ? "salImportFail" : "salImportCheck"}`;
          const vCount = (song.versions || []).length;
          row.querySelector(".salImportSub").textContent = anyFailed
            ? `${vCount} version${vCount !== 1 ? "s" : ""} — some audio failed`
            : `${vCount} version${vCount !== 1 ? "s" : ""}`;
        }
      }
    }

    clearInterval(salAnimTimer);

    if (!failed.length) {
      // All succeeded
      salEl.classList.remove(...salAnims);
      salEl.classList.add("salBounce");
      progressEl.innerHTML = `<strong>All done — happy riffing!</strong>`;
      overallFill.style.width = "100%";
      setTimeout(() => {
        el.classList.add("salImportFadeOut");
        setTimeout(() => { el.remove(); resolve({ succeeded, failed }); }, 300);
      }, 1800);
    } else {
      // Some failed — show continue button, user will handle failures in retry screen
      progressEl.innerHTML = `Imported ${succeeded.length} of ${toDownload.length}. Some didn't make it.`;
      const contBtn = document.createElement("button");
      contBtn.className = "salImportBtn";
      contBtn.style.marginTop = "16px";
      contBtn.textContent = "Continue";
      el.querySelector(".salImportCard").appendChild(contBtn);
      contBtn.addEventListener("click", () => {
        el.classList.add("salImportFadeOut");
        setTimeout(() => { el.remove(); resolve({ succeeded, failed }); }, 300);
      });
    }
  });
}

function showSalImportRetry(failedItems) {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "salImportOffer";
    el.innerHTML = `
      <div class="salImportOfferCard">
        <div class="salImportOfferSal">${salSvg(72)}</div>
        <div class="salImportOfferMsg">
          Almost there! ${failedItems.length} song${failedItems.length !== 1 ? "s" : ""} didn't make it.
        </div>
        <div class="salRetryList" id="salRetryList"></div>
        <button class="salImportBtn" id="salRetryContinue">Continue to RiffBank</button>
      </div>
    `;

    const listEl = el.querySelector("#salRetryList");

    for (const item of failedItems) {
      const { song, version: v } = item;
      const row = document.createElement("div");
      row.className = "salRetryItem";
      row.innerHTML = `
        <div class="salImportMeta">
          <div class="salImportTitle">${song.title || "Untitled"}</div>
          <div class="salImportSub">${v.label || "Version"}</div>
        </div>
        <div class="salRetryActions">
          <button class="salRetryBtn" data-action="retry">Retry</button>
          <button class="salRetryBtn salRetryBtnDanger" data-action="delete">Delete</button>
        </div>
      `;

      row.querySelector('[data-action="retry"]').addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.textContent = "...";
        btn.disabled = true;
        try {
          const blob = await supabaseFetchAudioBlob(v.audioPath);
          if (blob) {
            await putAudioBlob({
              id: `supa:${v.audioPath}`,
              blob,
              name: v.fileName || v.label || "audio",
              type: v.fileType || blob.type || "audio/*",
              size: blob.size,
            });
            _cachedAudioPaths.add(v.audioPath);
            row.classList.add("salRetryDone");
            row.querySelector(".salRetryActions").innerHTML = `<span style="color:#22c55e;font-size:13px;font-weight:700;">Done!</span>`;
          } else {
            btn.textContent = "Retry";
            btn.disabled = false;
          }
        } catch {
          btn.textContent = "Retry";
          btn.disabled = false;
        }
      });

      row.querySelector('[data-action="delete"]').addEventListener("click", () => {
        // Remove audioPath from version so it's treated as metadata-only
        v.audioPath = null;
        saveState();
        row.classList.add("salRetryDone");
        row.querySelector(".salRetryActions").innerHTML = `<span style="color:var(--muted);font-size:13px;font-weight:700;">Removed</span>`;
      });

      listEl.appendChild(row);
    }

    el.querySelector("#salRetryContinue").addEventListener("click", () => {
      el.classList.add("salImportFadeOut");
      setTimeout(() => { el.remove(); resolve(); }, 300);
    });

    document.body.appendChild(el);
  });
}

function showSalRefresherPrompt() {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "actionSheetBackdrop";

    const sheet = document.createElement("div");
    sheet.className = "actionSheet";
    sheet.style.cssText = "padding: 0; overflow: hidden; border-radius: 22px;";
    sheet.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;padding:32px 24px 20px;gap:14px;">
        ${salSvg(72)}
        <div style="font-size:18px;font-weight:800;color:#fff;letter-spacing:-0.3px;text-align:center;">Want a refresher on how things work?</div>
        <div style="font-size:14px;color:rgba(255,255,255,.5);text-align:center;line-height:1.6;max-width:280px;">
          I can walk you through everything RiffBank has to offer.
        </div>
      </div>
      <div style="height:1px;background:rgba(255,255,255,.08);margin:0 16px;"></div>
      <div style="padding:8px 0 6px;display:flex;flex-direction:column;">
        <button class="actionSheetBtn" id="salRefresherYes" style="font-weight:700;color:#a78bfa;">Sure!</button>
        <button class="actionSheetBtn" id="salRefresherNo" style="font-weight:700;">I'm good</button>
      </div>
    `;

    function close() {
      backdrop.remove();
      sheet.remove();
      localStorage.setItem("salOnboardingDone", "1");
      resolve();
    }

    backdrop.addEventListener("click", close);
    sheet.querySelector("#salRefresherNo").addEventListener("click", close);
    sheet.querySelector("#salRefresherYes").addEventListener("click", () => {
      backdrop.remove();
      sheet.remove();
      openSalOnboarding({ force: true });
      // Resolve after a short delay so onboarding sheet is visible
      setTimeout(resolve, 100);
    });

    document.body.appendChild(backdrop);
    document.body.appendChild(sheet);
  });
}

// ── Avatar Picker Sheet ──────────────────────────

// Preset cartoon avatars — cute Sal-style characters
const AVATAR_PRESETS = [
  { id: "fox",      bg: "#f97316", emoji: "🦊", label: "Fox" },
  { id: "bear",     bg: "#a78bfa", emoji: "🐻", label: "Bear" },
  { id: "cat",      bg: "#f472b6", emoji: "🐱", label: "Cat" },
  { id: "dog",      bg: "#60a5fa", emoji: "🐶", label: "Dog" },
  { id: "rabbit",   bg: "#34d399", emoji: "🐰", label: "Rabbit" },
  { id: "panda",    bg: "#6b7280", emoji: "🐼", label: "Panda" },
  { id: "owl",      bg: "#8b5cf6", emoji: "🦉", label: "Owl" },
  { id: "penguin",  bg: "#38bdf8", emoji: "🐧", label: "Penguin" },
  { id: "lion",     bg: "#fbbf24", emoji: "🦁", label: "Lion" },
  { id: "koala",    bg: "#a3a3a3", emoji: "🐨", label: "Koala" },
  { id: "unicorn",  bg: "#e879f9", emoji: "🦄", label: "Unicorn" },
  { id: "hedgehog", bg: "#d97706", emoji: "🦔", label: "Hedgehog" },
];

function renderAvatarPreset(preset) {
  return `<div style="width:100%;height:100%;background:${preset.bg};display:flex;align-items:center;justify-content:center;font-size:28px;border-radius:inherit">${preset.emoji}</div>`;
}

/**
 * Opens an Instagram-style bottom sheet avatar picker.
 * @param {object} opts
 * @param {string|null} opts.currentSrc  - current avatar image URL
 * @param {function} opts.onPickFile     - called with File when user picks from library/camera
 * @param {function} opts.onPickPreset   - called with preset object { id, bg, emoji }
 * @param {function} opts.onRemove       - called when user removes current picture
 */
function openAvatarPicker({ currentSrc, onPickFile, onPickPreset, onRemove }) {
  // Remove any existing picker
  document.getElementById("avatarPickerBackdrop")?.remove();
  document.getElementById("avatarPickerSheet")?.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "avatarPickerBackdrop";
  backdrop.className = "avatarPickerBackdrop";

  const sheet = document.createElement("div");
  sheet.id = "avatarPickerSheet";
  sheet.className = "avatarPickerSheet";

  let activeTab = "photo"; // "photo" | "avatar"

  function renderSheet() {
    const initial = "?";
    const presetGrid = AVATAR_PRESETS.map(p => `
      <button class="avPresetBtn" data-preset="${p.id}">
        ${renderAvatarPreset(p)}
      </button>
    `).join("");

    sheet.innerHTML = `
      <div class="avPickerHandle"></div>
      <div class="avPickerTabs">
        <button class="avPickerTab ${activeTab === "photo" ? "active" : ""}" data-tab="photo">
          ${currentSrc
            ? `<img src="${currentSrc}" class="avPickerTabImg" />`
            : `<div class="avPickerTabFallback">${escapeHtml(initial)}</div>`
          }
        </button>
        <button class="avPickerTab ${activeTab === "avatar" ? "active" : ""}" data-tab="avatar">
          <div class="avPickerTabFallback" style="font-size:18px">🦔</div>
        </button>
      </div>

      ${activeTab === "photo" ? `
        <div class="avPickerOptions">
          <button class="avPickerOption" data-action="pick">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
            <span>Choose photo</span>
          </button>
          ${currentSrc ? `
            <button class="avPickerOption avPickerOptionDanger" data-action="remove">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3,6 5,6 21,6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
              <span>Remove current picture</span>
            </button>
          ` : ""}
        </div>
      ` : `
        <div class="avPresetGrid">
          ${presetGrid}
        </div>
      `}
    `;

    // Wire tabs
    sheet.querySelectorAll(".avPickerTab").forEach(tab => {
      tab.addEventListener("click", () => {
        activeTab = tab.dataset.tab;
        renderSheet();
      });
    });

    // Wire "Choose photo" — iOS will show its native Photo Library / Take Photo / Files menu
    sheet.querySelector("[data-action='pick']")?.addEventListener("click", () => {
      let input = document.getElementById("_imagePicker");
      if (!input) {
        input = document.createElement("input");
        input.id = "_imagePicker";
        input.type = "file";
        input.accept = "image/*";
        input.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none";
        document.body.appendChild(input);
      }
      input.value = "";
      const handler = async () => {
        input.removeEventListener("change", handler);
        const file = input.files?.[0];
        if (!file) return;
        close();
        // Open crop overlay before passing to callback
        const cropped = await openAvatarCrop(file);
        if (cropped) onPickFile?.(cropped.file, cropped.previewUrl);
      };
      input.addEventListener("change", handler);
      input.click();
    });

    sheet.querySelector("[data-action='remove']")?.addEventListener("click", () => {
      close();
      onRemove?.();
    });

    // Wire preset avatars
    sheet.querySelectorAll(".avPresetBtn").forEach(btn => {
      btn.addEventListener("click", () => {
        const preset = AVATAR_PRESETS.find(p => p.id === btn.dataset.preset);
        if (preset) { close(); onPickPreset?.(preset); }
      });
    });
  }

  function close() {
    sheet.classList.remove("open");
    backdrop.classList.remove("open");
    setTimeout(() => { backdrop.remove(); sheet.remove(); }, 300);
  }

  backdrop.addEventListener("click", close);

  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
  renderSheet();
  requestAnimationFrame(() => { backdrop.classList.add("open"); sheet.classList.add("open"); });
}

// Helper: render an avatar from a URL or preset: string
function renderAvatarHtml(src, size, fallbackInitial) {
  if (src?.startsWith("preset:")) {
    const presetId = src.replace("preset:", "");
    const preset = AVATAR_PRESETS.find(p => p.id === presetId);
    if (preset) return `<div style="width:${size}px;height:${size}px;border-radius:50%;overflow:hidden">${renderAvatarPreset(preset)}</div>`;
  }
  if (src?.startsWith("http")) {
    const fb = fallbackInitial || "?";
    return `<img style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;display:block" src="${src}" onerror="this.outerHTML='<div style=\\'width:${size}px;height:${size}px;border-radius:50%;background:linear-gradient(135deg,#a78bfa,#f472b6);display:flex;align-items:center;justify-content:center;font-weight:900;font-size:${Math.round(size * 0.4)}px;color:#fff\\'>${fb}</div>'" />`;
  }
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:linear-gradient(135deg,#a78bfa,#f472b6);display:flex;align-items:center;justify-content:center;font-family:'Montserrat',sans-serif;font-weight:900;font-size:${Math.round(size * 0.4)}px;color:#fff">${fallbackInitial || "?"}</div>`;
}

/**
 * Opens a circular avatar crop overlay.
 * @param {File} file - image file to crop
 * @returns {Promise<{file: File, previewUrl: string} | null>} cropped result or null if cancelled
 */
function openAvatarCrop(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const imageSrc = reader.result;

      document.querySelector(".avatarCropOverlay")?.remove();

      const overlay = document.createElement("div");
      overlay.className = "avatarCropOverlay";
      overlay.innerHTML = `
        <div class="avCropHeader">
          <button class="avCropCancel">Cancel</button>
          <span class="avCropTitle">Move and Scale</span>
          <button class="avCropDone">Done</button>
        </div>
        <div class="avCropBody">
          <div class="avCropFrame">
            <img class="avCropImg" src="${imageSrc}" draggable="false" />
            <div class="avCropMask"></div>
          </div>
        </div>
        <div class="avCropControls">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
          <input type="range" class="avCropZoom" min="100" max="500" value="100" />
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </div>
      `;

      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add("open"));

      const img = overlay.querySelector(".avCropImg");
      const frame = overlay.querySelector(".avCropFrame");
      const zoomSlider = overlay.querySelector(".avCropZoom");

      let baseScale = 1, userZoom = 1, tx = 0, ty = 0;
      let isDragging = false, startX = 0, startY = 0, startTx = 0, startTy = 0;
      // Pinch zoom state
      let pinchStartDist = 0, pinchStartZoom = 1;

      const totalScale = () => baseScale * userZoom;

      function applyTransform() {
        img.style.width = img.naturalWidth + "px";
        img.style.height = img.naturalHeight + "px";
        img.style.transform = `translate(${tx}px, ${ty}px) scale(${totalScale()})`;
      }

      function clampPosition() {
        const size = frame.clientWidth; // square
        const s = totalScale();
        const imgW = img.naturalWidth * s;
        const imgH = img.naturalHeight * s;
        if (imgW >= size) tx = Math.min(0, Math.max(size - imgW, tx));
        else tx = (size - imgW) / 2;
        if (imgH >= size) ty = Math.min(0, Math.max(size - imgH, ty));
        else ty = (size - imgH) / 2;
      }

      function initLayout() {
        const size = frame.clientWidth;
        const nw = img.naturalWidth, nh = img.naturalHeight;
        if (!nw || !nh || !size) return;
        baseScale = Math.max(size / nw, size / nh);
        tx = (size - nw * totalScale()) / 2;
        ty = (size - nh * totalScale()) / 2;
        applyTransform();
      }

      img.onload = () => initLayout();
      if (img.complete && img.naturalWidth) initLayout();

      // Zoom slider
      zoomSlider.addEventListener("input", () => {
        const oldZoom = userZoom;
        userZoom = parseInt(zoomSlider.value) / 100;
        const size = frame.clientWidth;
        const ratio = userZoom / oldZoom;
        tx = size / 2 - ratio * (size / 2 - tx);
        ty = size / 2 - ratio * (size / 2 - ty);
        clampPosition();
        applyTransform();
      });

      // Drag
      frame.addEventListener("touchstart", (e) => {
        if (e.touches.length === 2) {
          // Pinch start
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          pinchStartDist = Math.hypot(dx, dy);
          pinchStartZoom = userZoom;
          return;
        }
        isDragging = true;
        startX = e.touches[0].clientX; startY = e.touches[0].clientY;
        startTx = tx; startTy = ty;
        e.preventDefault();
      }, { passive: false });

      frame.addEventListener("touchmove", (e) => {
        if (e.touches.length === 2 && pinchStartDist > 0) {
          // Pinch zoom
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          const dist = Math.hypot(dx, dy);
          const newZoom = Math.max(1, Math.min(5, pinchStartZoom * (dist / pinchStartDist)));
          const oldZoom = userZoom;
          userZoom = newZoom;
          zoomSlider.value = Math.round(userZoom * 100);
          const size = frame.clientWidth;
          const ratio = userZoom / oldZoom;
          tx = size / 2 - ratio * (size / 2 - tx);
          ty = size / 2 - ratio * (size / 2 - ty);
          clampPosition();
          applyTransform();
          e.preventDefault();
          return;
        }
        if (!isDragging) return;
        const pt = e.touches[0];
        tx = startTx + (pt.clientX - startX);
        ty = startTy + (pt.clientY - startY);
        clampPosition();
        applyTransform();
        e.preventDefault();
      }, { passive: false });

      frame.addEventListener("touchend", () => { isDragging = false; pinchStartDist = 0; });
      frame.addEventListener("touchcancel", () => { isDragging = false; pinchStartDist = 0; });

      // Mouse drag fallback
      frame.addEventListener("mousedown", (e) => {
        isDragging = true; startX = e.clientX; startY = e.clientY; startTx = tx; startTy = ty;
      });
      window.addEventListener("mousemove", (e) => {
        if (!isDragging) return;
        tx = startTx + (e.clientX - startX);
        ty = startTy + (e.clientY - startY);
        clampPosition(); applyTransform();
      });
      window.addEventListener("mouseup", () => { isDragging = false; });

      function dismiss() {
        overlay.classList.remove("open");
        setTimeout(() => overlay.remove(), 300);
      }

      // Cancel
      overlay.querySelector(".avCropCancel").addEventListener("click", () => { dismiss(); resolve(null); });

      // Done — render cropped image to canvas
      overlay.querySelector(".avCropDone").addEventListener("click", () => {
        const size = frame.clientWidth;
        const s = totalScale();
        const canvas = document.createElement("canvas");
        const outputSize = 512; // hi-res output
        canvas.width = outputSize;
        canvas.height = outputSize;
        const ctx = canvas.getContext("2d");

        // Map frame coordinates to source image coordinates
        const srcX = -tx / s;
        const srcY = -ty / s;
        const srcSize = size / s;

        ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, outputSize, outputSize);

        canvas.toBlob((blob) => {
          if (!blob) { dismiss(); resolve(null); return; }
          const croppedFile = new File([blob], "avatar.jpg", { type: "image/jpeg" });
          const previewUrl = URL.createObjectURL(blob);
          dismiss();
          resolve({ file: croppedFile, previewUrl });
        }, "image/jpeg", 0.92);
      });
    };
    reader.readAsDataURL(file);
  });
}

// ── Profile Setup (shown once after first signup) ──

async function showProfileSetupIfNeeded() {
  if (localStorage.getItem("profileSetupDone")) return;

  try {
    const { data: userData } = await supabase.auth.getUser();
    const uid = userData?.user?.id;
    if (!uid) return;

    // Check if profile already exists in DB — skip setup if so
    const { data: existing } = await supabase
      .from("profiles").select("id, display_name").eq("id", uid).maybeSingle();
    if (existing?.display_name) {
      localStorage.setItem("profileSetupDone", "1");
      return;
    }
  } catch {
    // profiles table may not exist yet — still show setup
  }

  await showProfileSetup();
}

function showProfileSetup() {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "profileSetup";
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("open"));

    // Collected data across steps
    const profile = { firstName: "", lastName: "", username: "", location: "", avatarBlob: null, avatarPreview: null, avatarPreset: null, instrument: "", genre: "" };
    let checkTimer = null;

    // ── Step 1: Name + Profile Picture ──
    function renderStep1() {
      el.innerHTML = `
        <div class="profileSetupInner">
          <div class="profileSetupSal">${salSvg(80)}</div>
          <div class="profileSetupTitle">What's your name?</div>
          <div class="profileSetupSub">This is how other musicians will see you</div>

          <div class="profileSetupForm">
            <button class="psAvatarPicker" id="psAvatarPicker">
              <div class="psAvatarPreview" id="psAvatarPreview">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
              </div>
              <div class="psAvatarLabel">Add photo</div>
            </button>

            <div class="profileSetupRow">
              <div class="profileSetupField">
                <label class="profileSetupLabel">First Name</label>
                <input id="psFirstName" class="profileSetupInput" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other" />
              </div>
              <div class="profileSetupField">
                <label class="profileSetupLabel">Last Name</label>
                <input id="psLastName" class="profileSetupInput" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other" />
              </div>
            </div>
          </div>

          <button class="profileSetupBtn" id="psNext1">Continue</button>
          <button class="profileSetupSkip" id="psSkip">Skip for now</button>
        </div>
      `;

      // Restore values if going back
      if (profile.firstName) $("#psFirstName").value = profile.firstName;
      if (profile.lastName) $("#psLastName").value = profile.lastName;
      if (profile.avatarPreview) {
        const prev = $("#psAvatarPreview");
        prev.innerHTML = `<img src="${profile.avatarPreview}" />`;
        prev.classList.add("hasImg");
      } else if (profile.avatarPreset) {
        const prev = $("#psAvatarPreview");
        prev.innerHTML = renderAvatarPreset(profile.avatarPreset);
        prev.classList.add("hasImg");
      }

      // Avatar picker — opens bottom sheet
      $("#psAvatarPicker")?.addEventListener("click", () => {
        openAvatarPicker({
          currentSrc: profile.avatarPreview,
          onPickFile: (file, previewUrl) => {
            profile.avatarBlob = file;
            profile.avatarPreset = null;
            profile.avatarPreview = previewUrl || URL.createObjectURL(file);
            const prev = $("#psAvatarPreview");
            if (prev) { prev.innerHTML = `<img src="${profile.avatarPreview}" />`; prev.classList.add("hasImg"); }
          },
          onPickPreset: (preset) => {
            profile.avatarPreset = preset;
            profile.avatarBlob = null;
            profile.avatarPreview = null;
            const prev = $("#psAvatarPreview");
            if (prev) { prev.innerHTML = renderAvatarPreset(preset); prev.classList.add("hasImg"); }
          },
          onRemove: () => {
            profile.avatarBlob = null;
            profile.avatarPreset = null;
            profile.avatarPreview = null;
            const prev = $("#psAvatarPreview");
            if (prev) {
              prev.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>`;
              prev.classList.remove("hasImg");
            }
          },
        });
      });

      $("#psNext1")?.addEventListener("click", () => {
        profile.firstName = ($("#psFirstName")?.value || "").trim();
        profile.lastName = ($("#psLastName")?.value || "").trim();
        renderStep2();
      });

      $("#psSkip")?.addEventListener("click", () => finishSetup(true));
    }

    // ── Step 2: Username ──
    function renderStep2() {
      el.innerHTML = `
        <div class="profileSetupInner">
          <div class="profileSetupSal">${salSvg(80)}</div>
          <div class="profileSetupTitle">Pick a username</div>
          <div class="profileSetupSub">This is your unique handle on RiffBank</div>

          <div class="profileSetupForm">
            <div class="profileSetupField">
              <div class="profileSetupInputWrap">
                <span class="profileSetupAt">@</span>
                <input id="psUsername" class="profileSetupInput profileSetupInputAt" type="text" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" data-form-type="other" />
              </div>
              <div class="psUsernameStatus" id="psUsernameStatus"></div>
            </div>
          </div>

          <button class="profileSetupBtn" id="psNext2" disabled>Continue</button>
          <button class="profileSetupSkip" id="psBack2">Back</button>
        </div>
      `;

      if (profile.username) {
        $("#psUsername").value = profile.username;
      }

      let usernameValid = false;

      const checkUsername = async (raw) => {
        const statusEl = $("#psUsernameStatus");
        const nextBtn = $("#psNext2");
        const cleaned = raw.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();

        // Update input to cleaned value
        const input = $("#psUsername");
        if (input && input.value !== cleaned) {
          input.value = cleaned;
        }

        if (!cleaned || cleaned.length < 2) {
          statusEl.textContent = "";
          statusEl.className = "psUsernameStatus";
          nextBtn.disabled = true;
          usernameValid = false;
          return;
        }

        statusEl.textContent = "Checking...";
        statusEl.className = "psUsernameStatus checking";
        nextBtn.disabled = true;
        usernameValid = false;

        try {
          // Check if username is taken by someone else (allow own username)
          const { data: userData } = await supabase.auth.getUser();
          const myUid = userData?.user?.id;

          const { data } = await supabase
            .from("profiles")
            .select("id")
            .eq("display_name", cleaned)
            .maybeSingle();

          // Check if input changed while we were checking
          if (($("#psUsername")?.value || "").toLowerCase().replace(/[^a-zA-Z0-9_]/g, "") !== cleaned) return;

          if (data && data.id !== myUid) {
            statusEl.textContent = "Sorry, that username is taken";
            statusEl.className = "psUsernameStatus taken";
            nextBtn.disabled = true;
            usernameValid = false;
          } else if (data && data.id === myUid) {
            statusEl.textContent = "Existing profile found — new values will overwrite";
            statusEl.className = "psUsernameStatus existing";
            nextBtn.disabled = false;
            usernameValid = true;
          } else {
            statusEl.textContent = "Available!";
            statusEl.className = "psUsernameStatus available";
            nextBtn.disabled = false;
            usernameValid = true;
          }
        } catch {
          // If profiles table doesn't exist, just allow it
          statusEl.textContent = "Looks good!";
          statusEl.className = "psUsernameStatus available";
          nextBtn.disabled = false;
          usernameValid = true;
        }
      };

      $("#psUsername")?.addEventListener("input", (e) => {
        clearTimeout(checkTimer);
        checkTimer = setTimeout(() => checkUsername(e.target.value), 400);
      });

      // If we already had a username, re-check it
      if (profile.username) {
        checkUsername(profile.username);
      }

      setTimeout(() => $("#psUsername")?.focus(), 150);

      $("#psNext2")?.addEventListener("click", () => {
        if (!usernameValid) return;
        profile.username = ($("#psUsername")?.value || "").trim().toLowerCase().replace(/[^a-zA-Z0-9_]/g, "");
        renderStep3();
      });

      $("#psBack2")?.addEventListener("click", () => renderStep1());
    }

    // ── Step 3: Location, Instrument + Genre ──
    function renderStep3() {
      el.innerHTML = `
        <div class="profileSetupInner">
          <div class="profileSetupSal">${salSvg(80)}</div>
          <div class="profileSetupTitle">Tell us more</div>
          <div class="profileSetupSub">Help others find musicians like you</div>

          <div class="profileSetupForm">
            <div class="profileSetupField">
              <label class="profileSetupLabel">Location</label>
              <input id="psLocation" class="profileSetupInput" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other" />
            </div>

            <div class="profileSetupField">
              <label class="profileSetupLabel">Primary Instrument</label>
              <input id="psInstrument" class="profileSetupInput" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other" />
            </div>

            <div class="profileSetupField">
              <label class="profileSetupLabel">Favorite Genre</label>
              <input id="psGenre" class="profileSetupInput" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other" />
            </div>
          </div>

          <button class="profileSetupBtn" id="psFinish">Let's Go!</button>
          <button class="profileSetupSkip" id="psBack3">Back</button>
        </div>
      `;

      if (profile.location) $("#psLocation").value = profile.location;
      if (profile.instrument) $("#psInstrument").value = profile.instrument;
      if (profile.genre) $("#psGenre").value = profile.genre;

      setTimeout(() => $("#psLocation")?.focus(), 150);

      $("#psFinish")?.addEventListener("click", () => {
        profile.location = ($("#psLocation")?.value || "").trim();
        profile.instrument = ($("#psInstrument")?.value || "").trim();
        profile.genre = ($("#psGenre")?.value || "").trim();
        finishSetup(false);
      });

      $("#psBack3")?.addEventListener("click", () => {
        profile.location = ($("#psLocation")?.value || "").trim();
        profile.instrument = ($("#psInstrument")?.value || "").trim();
        profile.genre = ($("#psGenre")?.value || "").trim();
        renderStep2();
      });
    }

    // ── Save & Close ──
    async function finishSetup(skipped) {
      if (!skipped) {
        const displayName = profile.username || [profile.firstName, profile.lastName].filter(Boolean).join(" ") || "RiffBanker";

        try {
          const { data: userData } = await supabase.auth.getUser();
          const uid = userData?.user?.id;
          if (uid) {
            const row = {
              id: uid,
              first_name: profile.firstName || null,
              last_name: profile.lastName || null,
              display_name: displayName,
              location: profile.location || null,
              instrument: profile.instrument || null,
              genre: profile.genre || null,
              bio: null,
              updated_at: new Date().toISOString(),
            };
            console.log("[ProfileSetup] Saving profile:", row);
            const { error } = await supabase.from("profiles").upsert(row, { onConflict: "id" });
            if (error) console.error("[ProfileSetup] Upsert error:", error);

            // Upload avatar or save preset
            if (profile.avatarBlob) {
              try {
                const ext = profile.avatarBlob.name?.split(".").pop() || "jpg";
                const path = `${uid}/avatar.${ext}`;
                const { error: uploadErr } = await supabase.storage.from("covers").upload(path, profile.avatarBlob, { upsert: true, contentType: profile.avatarBlob.type || "image/jpeg" });
                if (uploadErr) { console.warn("[ProfileSetup] Avatar upload failed:", uploadErr); }
                else {
                  // Use signed URL (1 year) — public URL returns 400 if bucket isn't public
                  const { data: signedData, error: signErr } = await supabase.storage.from("covers").createSignedUrl(path, 60 * 60 * 24 * 365);
                  const avatarUrl = signedData?.signedUrl;
                  if (avatarUrl) {
                    await supabase.from("profiles").update({ avatar_url: avatarUrl }).eq("id", uid);
                    state.settings.profileAvatarUrl = avatarUrl;
                  } else {
                    console.warn("[ProfileSetup] Signed URL failed:", signErr);
                  }
                }
              } catch (e) { console.warn("[ProfileSetup] Avatar upload failed:", e); }
            } else if (profile.avatarPreset) {
              // Save preset as avatar_url with special prefix
              const presetUrl = `preset:${profile.avatarPreset.id}`;
              await supabase.from("profiles").update({ avatar_url: presetUrl }).eq("id", uid);
              state.settings.profileAvatarUrl = presetUrl;
            }
          }
        } catch (e) {
          console.warn("[ProfileSetup] Failed to save:", e);
        }

        state.settings.displayName = displayName;
        saveState();
      }

      localStorage.setItem("profileSetupDone", "1");
      el.classList.remove("open");
      setTimeout(() => { el.remove(); resolve(); }, 300);
    }

    // Start at step 1
    renderStep1();
  });
}

async function runSalImportFlow() {
  // Only run once per session
  if (_importFlowRan) return;
  _importFlowRan = true;

  // Only run on first login (fresh install / after wipe). Skip on subsequent launches.
  if (localStorage.getItem("salImportFlowDone")) return;

  // Check if this is a fresh login (no local songs yet) and cloud has data
  const cloudCount = await supabaseCountUserSongs();
  console.log("[ImportFlow] cloudCount =", cloudCount);

  if (cloudCount === 0) {
    // New user — run existing onboarding
    localStorage.setItem("salImportFlowDone", "1");
    openSalOnboarding({ force: true });
    return;
  }

  // Returning user with cloud songs
  const userChoice = await showSalImportOffer(cloudCount);

  if (userChoice === "import") {
    const result = await showSalImportScreen();
    if (result.failed.length) {
      await showSalImportRetry(result.failed);
    }
  } else {
    // User skipped — set nudge flag
    localStorage.setItem("salImportSkipped", JSON.stringify({
      count: cloudCount,
      skippedAt: Date.now(),
    }));
  }

  // Mark import flow as complete so it doesn't re-run on next launch
  localStorage.setItem("salImportFlowDone", "1");
}

async function init() {
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
  }

  // Profile setup — show once after signup if no profile exists
  await showProfileSetupIfNeeded();

  // If local state is empty, pull from Supabase before showing the app
  // (on fresh install / cache wipe, localStorage has no songs yet)
  if (!state.songs.length) {
    try {
      await incrementalSyncFromSupabase();
      _importFlowRan = true; // skip the background re-sync later
    } catch (e) { console.warn("[Init] sync failed:", e); }
  }

  // ── Boot overlay: reuse splash look while data syncs ──
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
  // Force paint so overlay is visible before we remove splashing
  bootOverlay.offsetHeight;
  document.body.classList.remove("splashing");

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

  // ── Await critical data tasks (with timeout so app never freezes) ──
  const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(r, ms))]);

  await withTimeout(Promise.all([
    restoreCoverUrlsFromCache().then(() => render()).catch(() => {}),
    (!_importFlowRan
      ? incrementalSyncFromSupabase().then(() => {
          preFetchCloudAudio().catch(console.warn);
        }).catch(console.warn)
      : Promise.resolve()),
    refreshSharedData().catch(console.warn),
  ]), 8000); // 8s max — don't block the app forever

  // Scan cached audio blobs (non-blocking, doesn't affect rendering)
  (async () => {
    for (const song of (state.songs || [])) {
      for (const v of (song.versions || [])) {
        if (!v.audioPath || v.fileId || v.localAudioId) continue;
        try {
          const rec = await audioGet(`supa:${v.audioPath}`);
          if (rec?.blob) _cachedAudioPaths.add(v.audioPath);
        } catch {}
      }
    }
  })();

  // Final render with all data in place
  render();
  syncMiniPlayerUI();

  // Transition subtext, then fade out
  const bootSubText = bootOverlay.querySelector("#splashSubText");
  if (bootSubText) bootSubText.textContent = "Entering RiffBank...";
  await new Promise(r => setTimeout(r, 600));

  bootOverlay.classList.add("hide");
  bootOverlay.addEventListener("transitionend", () => bootOverlay.remove());

  // Sync unread message badges
  syncMessageBadges();

  // Request notification permission early so share notifications work
  requestNotificationPermission();

  // Update notification bell badge on startup
  _updateNotifBadge();

  // Check for Web Share Target file
  checkSharedAudioFile();
}

// Incremental sync: pull Supabase state and merge only new/changed songs
async function incrementalSyncFromSupabase() {
  const cloudState = await supabasePullStateSilent();
  if (!cloudState?.songs?.length) return;

  const localHasSongs = state.songs && state.songs.length > 0;

  if (!localHasSongs) {
    // Local is empty — adopt cloud state wholesale
    state.songs = cloudState.songs;
    state.releases = cloudState.releases || state.releases;
    state.projects = cloudState.projects || state.projects;
    normalizeState();
    await restoreCoverUrlsFromCache();
    saveState();
    coverCache.clear();
    render();
    toast("Loaded library from cloud");
    return;
  }

  // Build lookup of local songs by title+project (stable identity)
  const localByKey = new Map();
  for (const s of state.songs) {
    localByKey.set(`${(s.title || "").trim()}|${(s.project || "").trim()}`, s);
  }

  let added = 0, updated = 0;

  for (const cs of cloudState.songs) {
    const key = `${(cs.title || "").trim()}|${(cs.project || "").trim()}`;
    const local = localByKey.get(key);

    if (!local) {
      state.songs.push(cs);
      added++;
    } else {
      const localTime = new Date(local.updatedAt || 0).getTime();
      const cloudTime = new Date(cs.updatedAt || 0).getTime();
      if (cloudTime > localTime) {
        const preserveFields = ["_coverResolving", "_userCoverResolving"];
        for (const f of preserveFields) {
          if (local[f] !== undefined) cs[f] = local[f];
        }
        // Preserve local cover blob URLs (cloud doesn't store blob URLs)
        if (local.userCoverImageUrl && !cs.userCoverImageUrl) cs.userCoverImageUrl = local.userCoverImageUrl;
        if (local.coverImageUrl && !cs.coverImageUrl) cs.coverImageUrl = local.coverImageUrl;
        // Keep user coverSource if local has a user cover
        if (local.coverSource === "user" && local.userCoverPath) cs.coverSource = "user";
        Object.assign(local, cs);
        updated++;
      }
      if (!local.coverPath && cs.coverPath) {
        local.coverPath = cs.coverPath;
        updated++;
      }
    }
  }

  // Merge cloud project names into local state
  if (cloudState.projects?.length) {
    for (const p of cloudState.projects) {
      if (p && !state.projects.includes(p)) state.projects.push(p);
    }
  }

  if (added || updated || cloudState.projects?.length) {
    normalizeState();
    await restoreCoverUrlsFromCache();
    saveState();
    coverCache.clear();
    render();
    if (added && updated) toast(`Synced: ${added} new, ${updated} updated`);
    else if (added) toast(`Synced: ${added} new song${added > 1 ? "s" : ""}`);
    else toast(`Synced: ${updated} song${updated > 1 ? "s" : ""} updated`);
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
  const appEl = document.querySelector(".app");
  appEl?.classList.add("collapseTitle");
  const h1 = appEl?.querySelector(".titleblock h1");
  if (h1) h1.style.opacity = "0";

  // Shared projects
  const sharedProjectNames = (sharedData.projects || []).map(sp => sp.projectName).filter(Boolean);
  const _sharedProjSet = new Set(sharedProjectNames);

  const pOwner = projectsOwnerFilter || "all";

  const ownProjects = Array.from(
    new Set([
      ...(state.settings?.defaultProject ? [state.settings.defaultProject.trim()] : []),
      ...(state.projects || []).map(p => p.trim()).filter(Boolean),
      ...state.songs.map(s => (s.project || "").trim()).filter(Boolean)
    ])
  );

  let projects;
  if (pOwner === "mine") {
    projects = ownProjects.filter(p => !_sharedProjSet.has(p)).sort((a, b) => a.localeCompare(b));
  } else if (pOwner === "shared") {
    projects = [..._sharedProjSet].sort((a, b) => a.localeCompare(b));
  } else {
    projects = Array.from(new Set([...ownProjects, ...sharedProjectNames])).sort((a, b) => a.localeCompare(b));
  }

  let projQuery = "";

  // Get shared songs for a project name
  const _sharedSongsForProj = (projName) => {
    const sp = (sharedData.projects || []).find(sp => sp.projectName === projName);
    return sp?.songs || [];
  };

  const buildCards = (q) => projects
    .filter(p => !q || p.toLowerCase().includes(q.toLowerCase()))
    .map((p, i) => {
      const ownProjSongs = state.songs.filter(s => (s.project || "").trim() === p);
      const sharedProjSongs = _sharedSongsForProj(p);
      const projSongs = [...ownProjSongs, ...sharedProjSongs.filter(s => !ownProjSongs.find(o => o.id === s.id))];
      const count = projSongs.length;
      const repSong = projSongs.slice().sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0]
        || { id: p, title: p, project: p, genre: "" };
      // Build mini song list for sleeve reveal (up to 4 songs)
      const sleeveItems = projSongs.slice(0, 4).map(s =>
        `<div class="pSleeveSong">${escapeHtml(s.title || "Untitled")}</div>`
      ).join("") + (projSongs.length > 4 ? `<div class="pSleeveSong pSleeveMore">+${projSongs.length - 4} more</div>` : "");

      return `
        <div class="pCard${nav._isBackNav ? " noAnim" : ""}" data-open-proj="${escapeHtml(p)}" style="${nav._isBackNav ? "" : `animation-delay:${i * 60}ms`}">
          <div class="pCardInner">
            <div class="pSleeve">
              <div class="pSleeveContent">
                ${sleeveItems || `<div class="pSleeveSong" style="opacity:.4">No songs yet</div>`}
              </div>
            </div>
            <div class="pArt">
              ${coverSvg(repSong, { lite: true })}
              <div class="pShimmer"></div>
            </div>
            <div class="pInfo">
              <div class="pName">${escapeHtml(p)}</div>
              <div class="pMeta">
                <span>${count} song${count === 1 ? "" : "s"}</span>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join("");

  const pOwnerLabels = { all: "All", mine: "Mine", shared: "Shared" };
  const pChevronDown = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

  activeScreenEl.innerHTML = `
    <div class="songsTitleRow">
      <div class="songsPageTitle">Projects</div>
      <div class="ownerDropWrap">
        <button class="ownerDropBtn">${pOwnerLabels[pOwner]}${pChevronDown}</button>
      </div>
    </div>
    <div class="songsHead">
      <div class="songsBar">
        <input id="projSearch" type="text" placeholder="Search projects..." />
      </div>
    </div>
    <div id="projList" class="pGrid">
      ${buildCards("") || `<div class="small" style="grid-column:1/-1">No projects yet.</div>`}
    </div>
    <button class="sdFab" id="projAddFab" aria-label="Add project">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
  `;

  const projListEl = $("#projList");

  /* ── Touch tilt / lift interaction ── */
  function attachCardPhysics(card) {
    const inner = card.querySelector(".pCardInner");
    const art = card.querySelector(".pArt");
    let rect, startX, startY, sleeveRevealed = false, isSwiping = false;
    let longPressTimer = null, longPressFired = false;

    card.addEventListener("touchstart", (e) => {
      rect = card.getBoundingClientRect();
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      isSwiping = false;
      sleeveRevealed = false;
      longPressFired = false;
      longPressTimer = setTimeout(() => {
        longPressFired = true;
        card._longPressFired = true;
        if (navigator.vibrate) navigator.vibrate(30);
        resetCard();
        const projName = card.getAttribute("data-open-proj");
        if (projName) openProjectMenu(projName);
      }, 500);
      inner.style.transition = "transform .15s ease-out, box-shadow .15s ease-out";
      inner.style.transform = "scale(1.03) translateY(-3px)";
      inner.style.boxShadow = "0 12px 32px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.08)";
      card.classList.add("pCardActive");
    }, { passive: true });

    card.addEventListener("touchmove", (e) => {
      if (!rect) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) { clearTimeout(longPressTimer); longPressTimer = null; }
      // Detect horizontal swipe for sleeve reveal
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        isSwiping = true;
        const slide = Math.max(-60, Math.min(0, dx));
        art.style.transition = "none";
        art.style.transform = `translateX(${slide}px)`;
        if (slide < -30) sleeveRevealed = true;
        e.preventDefault();
        return;
      }
      // Tilt toward finger
      const cx = (e.touches[0].clientX - rect.left) / rect.width - 0.5;
      const cy = (e.touches[0].clientY - rect.top) / rect.height - 0.5;
      const rotY = cx * 8;
      const rotX = -cy * 6;
      inner.style.transition = "none";
      inner.style.transform = `scale(1.03) translateY(-3px) perspective(400px) rotateX(${rotX}deg) rotateY(${rotY}deg)`;
    }, { passive: false });

    const resetCard = () => {
      clearTimeout(longPressTimer); longPressTimer = null;
      inner.style.transition = "transform .35s cubic-bezier(.25,.46,.45,.94), box-shadow .35s ease";
      inner.style.transform = "";
      inner.style.boxShadow = "";
      card.classList.remove("pCardActive");
      if (isSwiping) {
        art.style.transition = "transform .35s cubic-bezier(.25,.46,.45,.94)";
        art.style.transform = "";
      }
      rect = null;
    };

    card.addEventListener("touchend", resetCard, { passive: true });
    card.addEventListener("touchcancel", resetCard, { passive: true });
  }

  /* ── Card-expand tap transition ── */
  function openProject(card, projName) {
    const rect = card.getBoundingClientRect();
    const clone = card.cloneNode(true);
    clone.className = "pCardExpanding";
    clone.style.cssText = `
      position:fixed; z-index:9999;
      left:${rect.left}px; top:${rect.top}px;
      width:${rect.width}px; height:${rect.height}px;
      transition: all .3s cubic-bezier(.25,.46,.45,.94);
      pointer-events:none;
    `;
    document.body.appendChild(clone);
    requestAnimationFrame(() => {
      clone.style.left = "0";
      clone.style.top = "0";
      clone.style.width = "100vw";
      clone.style.height = "100vh";
      clone.style.borderRadius = "0";
      clone.style.opacity = "0";
    });
    setTimeout(() => {
      clone.remove();
    }, 320);
    // Navigate after short delay so animation is visible
    setTimeout(() => {
      navigateForward(() => {
        projectDetailScreen = projName;
      });
    }, 120);
  }

  const applyProjFilter = () => {
    projQuery = ($("#projSearch")?.value || "");
    const html = buildCards(projQuery);
    projListEl.innerHTML = html || `<div class="small" style="grid-column:1/-1">No matches.</div>`;
    projListEl.querySelectorAll(".pCard").forEach(card => {
      attachCardPhysics(card);
      card.addEventListener("click", (e) => {
        if (card._longPressFired) { card._longPressFired = false; return; }
        openProject(card, card.getAttribute("data-open-proj"));
      });
    });
  };

  $("#projSearch")?.addEventListener("input", applyProjFilter);
  applyProjFilter();

  // Owner filter dropdown
  const pDropBtn = activeScreenEl.querySelector(".ownerDropBtn");
  const pDropWrap = activeScreenEl.querySelector(".ownerDropWrap");
  pDropBtn?.addEventListener("click", () => {
    const existing = pDropWrap?.querySelector(".ownerDropMenu");
    if (existing) { existing.remove(); return; }
    const menu = document.createElement("div");
    menu.className = "ownerDropMenu";
    menu.innerHTML = ["all", "mine", "shared"].map(v =>
      `<button class="ownerDropItem${pOwner === v ? " active" : ""}" data-owner="${v}">${pOwnerLabels[v]}</button>`
    ).join("");
    pDropWrap?.appendChild(menu);
    menu.querySelectorAll(".ownerDropItem").forEach(item => {
      item.addEventListener("click", () => {
        menu.remove();
        projectsOwnerFilter = item.getAttribute("data-owner") || "all";
        renderProjects();
      });
    });
    const close = (e) => {
      if (!menu.contains(e.target) && e.target !== pDropBtn) { menu.remove(); document.removeEventListener("pointerdown", close); }
    };
    setTimeout(() => document.addEventListener("pointerdown", close), 0);
  });

  $("#projAddFab")?.addEventListener("click", () => {
    const name = prompt("New project name:");
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    if ((state.projects || []).includes(trimmed)) return toast("Already exists");
    ensureProject(trimmed);
    saveState();
    coverCache.clear();
    render();
    toast("Project created");
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

function renderProjectSongs(projectName) {
  setHeader(projectName);
  // Hide topbar title — the hero has its own large title
  const _tbH1 = document.querySelector(".topbar h1");
  if (_tbH1) _tbH1.textContent = "";
  const appEl = document.querySelector(".app");
  appEl?.classList.add("pdActive");
  appEl?.classList.remove("pdScrolled");
  // Kill screen bottom padding so sticky panel can't scroll past top
  activeScreenEl.style.paddingBottom = "0px";
  // Measure topbar height so sticky panel sits below it
  const topbarEl = document.querySelector(".topbar");
  const topbarH = topbarEl ? topbarEl.offsetHeight : 0;
  activeScreenEl.style.setProperty("--pd-topbar-h", topbarH + "px");

  activeScreenEl.style.overflowY = "scroll";

  // In collab mode, pull songs from the shared project data; otherwise use local state
  const songs = collabMode
    ? (sharedData.projects.find(sp => sp.projectName === projectName)?.songs || [])
    : state.songs.filter(s => (s.project || "").trim() === projectName);

  // Ensure shared songs are in the cache so getSong() can find them
  if (collabMode) {
    if (!state._sharedSongsCache) state._sharedSongsCache = [];
    for (const s of songs) {
      if (!state._sharedSongsCache.find(cs => cs.id === s.id)) {
        state._sharedSongsCache.push(s);
      }
    }
  }

  const items = songs
    .filter(s => (s.versions || []).length)
    .map(s => {
      const vv = s.versions.find(v => v.isActive) || s.versions[0];
      return { songId: s.id, versionId: vv.id };
    });

  // Use the most recently updated song for album art (matches Projects grid)
  const repSong = songs.slice().sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0]
    || { id: projectName, title: projectName, project: projectName, genre: "" };
  const heroCover = coverSvg(repSong);

  const songRows = songs.map((s, i) => {
    return `
      <div class="pdSongRow" data-open-song="${s.id}">
        <span class="pdSongNum">${i + 1}</span>
        <div class="songThumb" aria-hidden="true">
          ${coverSvg(s, { lite: true })}
        </div>
        <div class="songMain">
          <div class="songTop">
            <div class="songTitleRow">
              ${syncDot(s)}
              <div class="songTitle">${escapeHtml(s.title || "Untitled")}</div>
            </div>
            <button class="songMore" data-proj-song-more="${s.id}" aria-label="Song menu">&#x22EF;</button>
          </div>
          <div class="songSub">${escapeHtml(s.genre || "—")}</div>
        </div>
      </div>
    `;
  }).join("");

  activeScreenEl.innerHTML = `
    <div class="pdHero">
      <div class="pdHeroBg" aria-hidden="true">${heroCover}</div>
      <div class="pdHeroContent">
        <div class="pdHeroTitle">${escapeHtml(projectName)}</div>
        <div class="pdHeroMeta">${songs.length} song${songs.length === 1 ? "" : "s"}</div>
      </div>
    </div>

    <div class="pdActions">
      <button class="pdPlayBtn" id="projPlayAll" ${!items.length ? "disabled" : ""}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <button class="pdShuffleBtn" id="projShuffle" ${!items.length ? "disabled" : ""}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
      </button>
      <button class="pdMoreBtn" id="projMoreMenu" aria-label="Project menu">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
      </button>
    </div>

    <div class="pdSticky">
      <div class="pdTabs">
        <button class="pdTab pdTabActive" data-pd-tab="songs">Songs</button>
        <button class="pdTab" data-pd-tab="versions">Versions</button>
        <button class="pdTab" data-pd-tab="releases">Releases</button>
      </div>
      <div class="pdTabBody" id="pdTabBody">
        <div class="pdSongList">
          ${songRows || `<div class="small" style="padding:24px 0; text-align:center">No songs in this project yet.</div>`}
        </div>
      </div>
    </div>
  `;

  // Reset scroll AFTER innerHTML so the hero is visible on load
  activeScreenEl.scrollTop = 0;

  /* ── Tab switching ── */
  const tabBody = $("#pdTabBody");
  activeScreenEl.querySelectorAll(".pdTab").forEach(tab => {
    tab.addEventListener("click", () => {
      activeScreenEl.querySelectorAll(".pdTab").forEach(t => t.classList.remove("pdTabActive"));
      tab.classList.add("pdTabActive");
      const which = tab.getAttribute("data-pd-tab");
      if (which === "songs") {
        tabBody.innerHTML = `<div class="pdSongList">${songRows || `<div class="small" style="padding:24px 0; text-align:center">No songs yet.</div>`}</div>`;
        attachSongListeners();
      } else if (which === "versions") {
        tabBody.innerHTML = `<div class="pdPlaceholder"><div class="pdPlaceholderIcon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><line x1="9" y1="3" x2="9" y2="21"/></svg></div><div class="pdPlaceholderTitle">Versions</div><div class="pdPlaceholderSub">Coming soon</div></div>`;
      } else {
        tabBody.innerHTML = `<div class="pdPlaceholder"><div class="pdPlaceholderIcon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div><div class="pdPlaceholderTitle">Releases</div><div class="pdPlaceholderSub">Coming soon</div></div>`;
      }
    });
  });

  /* ── Play / Shuffle ── */
  $("#projPlayAll")?.addEventListener("click", async () => {
    if (!items.length) return toast("No playable songs");
    const all = [...items];
    state.player.nowPlaying = all[0];
    state.player.queue = all.slice(1);
    state.player.repeatQueue = all;
    saveState();
    await playNowPlaying({ autoplay: true });
  });

  $("#projShuffle")?.addEventListener("click", async () => {
    if (!items.length) return toast("No playable songs");
    const all = shuffleArray([...items]);
    state.player.nowPlaying = all[0];
    state.player.queue = all.slice(1);
    state.player.repeatQueue = all;
    saveState();
    await playNowPlaying({ autoplay: true });
  });

  $("#projMoreMenu")?.addEventListener("click", () => {
    openProjectMenu(projectName);
  });

  /* ── Song row listeners ── */
  function attachSongListeners() {
    activeScreenEl.querySelectorAll("[data-open-song]").forEach(row => {
      let longPressTimer = null;
      let didLongPress = false;

      row.addEventListener("touchstart", () => {
        didLongPress = false;
        longPressTimer = setTimeout(() => {
          didLongPress = true;
          navigator.vibrate?.(30);
          const sid = row.getAttribute("data-open-song");
          if (sid) openSongMenu(sid);
        }, 500);
      }, { passive: true });
      row.addEventListener("touchend", () => { clearTimeout(longPressTimer); });
      row.addEventListener("touchmove", () => { clearTimeout(longPressTimer); });
      row.addEventListener("touchcancel", () => { clearTimeout(longPressTimer); });

      row.addEventListener("click", async (e) => {
        if (didLongPress) return;
        if (e.target.closest("[data-proj-song-more]")) return;
        const sid = row.getAttribute("data-open-song");
        // Play from this song onwards (active version of each)
        const idx = items.findIndex(it => it.songId === sid);
        if (idx < 0) return toast("No playable version");
        const fromHere = [...items.slice(idx), ...items.slice(0, idx)];
        state.player.nowPlaying = fromHere[0];
        state.player.queue = fromHere.slice(1);
        state.player.repeatQueue = fromHere;
        saveState();
        await playNowPlaying({ autoplay: true });
      });
    });

    activeScreenEl.querySelectorAll("[data-proj-song-more]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openSongMenu(btn.getAttribute("data-proj-song-more"));
      });
    });
  }

  attachSongListeners();

  /* ── Fade hero + actions to black, solid topbar as user scrolls ── */
  const heroEl = activeScreenEl.querySelector(".pdHero");
  const heroBgEl = heroEl?.querySelector(".pdHeroBg");
  const heroContentEl = heroEl?.querySelector(".pdHeroContent");
  const actionsEl = activeScreenEl.querySelector(".pdActions");
  const stickyEl = activeScreenEl.querySelector(".pdSticky");
  if (stickyEl && heroEl) {
    let maxScroll = 0;
    const FADE_PX = 200;
    requestAnimationFrame(() => {
      maxScroll = activeScreenEl.scrollHeight - activeScreenEl.clientHeight;
    });

    activeScreenEl.addEventListener("scroll", () => {
      const scrolled = activeScreenEl.scrollTop;
      // Fade hero content + art + actions to black as they scroll away
      if (maxScroll > 0) {
        const remaining = maxScroll - scrolled;
        const opacity = remaining < FADE_PX ? Math.max(0, remaining / FADE_PX) : 1;
        if (heroBgEl) heroBgEl.style.opacity = opacity;
        if (heroContentEl) heroContentEl.style.opacity = opacity;
        if (actionsEl) actionsEl.querySelectorAll("button").forEach(b => b.style.opacity = opacity);
      }
      // Show/hide solid topbar
      if (appEl) {
        const heroBottom = heroEl.getBoundingClientRect().bottom;
        const screenTop = activeScreenEl.getBoundingClientRect().top;
        if (heroBottom - screenTop < 60) {
          appEl.classList.add("pdScrolled");
        } else {
          appEl.classList.remove("pdScrolled");
        }
      }
    }, { passive: true });
  }
}

function renderReleases() {
  setHeader("Releases");
  const appEl = document.querySelector(".app");
  appEl?.classList.add("collapseTitle");
  const h1 = appEl?.querySelector(".titleblock h1");
  if (h1) h1.style.opacity = "0";

  const releases = state.releases || [];

  const fmtDate = (d) => {
    if (!d) return "No date set";
    const [y, m, day] = d.split("-");
    return new Date(+y, +m - 1, +day).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  const releaseCompositeArt = (r, lite) => {
    const songs = (r.songIds || []).map(id => state.songs.find(s => s.id === id)).filter(Boolean);
    if (!songs.length) {
      const fakeSong = { id: r.id, title: r.title, project: r.artist, genre: "" };
      return coverSvg(fakeSong, { lite });
    }
    if (songs.length === 1) return coverSvg(songs[0], { lite });
    // 2 → side by side, 3 → top-left big + right column, 4+ → 2×2 grid
    const cells = songs.slice(0, 4);
    const cls = `relMosaic relMosaic${Math.min(cells.length, 4)}`;
    return `<div class="${cls}">${cells.map(s => `<div class="relMosaicCell">${coverSvg(s, { lite })}</div>`).join("")}</div>`;
  };

  const releaseCard = (r, span) => {
    const count = (r.songIds || []).length;
    const spanStyle = span > 1 ? ` style="grid-column:span ${span}"` : "";
    return `
      <div class="songCard" data-rel-open="${escapeHtml(r.id)}"${spanStyle}>
        <div class="songCardStack">
          <div class="songCardLayer songCardLayer2"></div>
          <div class="songCardLayer songCardLayer1"></div>
          <div class="songCardFront">
            <div class="songCardArt">${releaseCompositeArt(r, true)}</div>
          </div>
        </div>
        <div class="songCardInfo">
          <div class="songCardTitle">${escapeHtml(r.title)}</div>
          <div class="songCardSub">${escapeHtml(r.artist || "—")} · ${count} song${count !== 1 ? "s" : ""}</div>
        </div>
      </div>
    `;
  };

  const buildRelGrid = (items) => {
    const count = items.length;
    if (count === 0) return "";
    if (count === 1) return releaseCard(items[0], 3);
    if (count === 2) return releaseCard(items[0], 2) + releaseCard(items[1], 1);
    const remainder = count % 3;
    if (remainder === 0) return items.map(r => releaseCard(r, 1)).join("");
    const fullCount = count - (remainder === 1 ? 4 : remainder);
    let html = items.slice(0, fullCount).map(r => releaseCard(r, 1)).join("");
    const tail = items.slice(fullCount);
    if (remainder === 2) {
      html += releaseCard(tail[0], 2) + releaseCard(tail[1], 1);
    } else {
      // remainder === 1 → take last 4, two rows of span 2 + span 1 (alternating)
      html += releaseCard(tail[0], 2) + releaseCard(tail[1], 1);
      html += releaseCard(tail[2], 1) + releaseCard(tail[3], 2);
    }
    return html;
  };

  activeScreenEl.innerHTML = `
    <div class="songsPageTitle">Releases</div>
    <div class="songsHead">
      <div class="songsBar" style="justify-content:space-between;align-items:center">
        <span style="font-size:13px;font-weight:600;color:rgba(255,255,255,.4)">${releases.length} release${releases.length === 1 ? "" : "s"}</span>
      </div>
    </div>
    <div class="songsList">
      ${buildRelGrid(releases) || `<div class="small" style="grid-column:1/-1">No releases yet. Tap the + button to plan your first drop.</div>`}
    </div>
    <button class="sdFab" id="addReleaseBtn" aria-label="Add release">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
  `;

  activeScreenEl.querySelectorAll(".songCard[data-rel-open]").forEach(el => {
    let longPressTimer = null;
    let didLongPress = false;

    el.addEventListener("touchstart", () => {
      didLongPress = false;
      longPressTimer = setTimeout(() => {
        didLongPress = true;
        navigator.vibrate?.(30);
        const rid = el.getAttribute("data-rel-open");
        if (rid) openReleaseMenu(rid);
      }, 500);
    }, { passive: true });
    el.addEventListener("touchend", () => { clearTimeout(longPressTimer); });
    el.addEventListener("touchmove", () => { clearTimeout(longPressTimer); });
    el.addEventListener("touchcancel", () => { clearTimeout(longPressTimer); });

    el.addEventListener("click", () => {
      if (didLongPress) return;
      navigateForward(() => {
        releaseDetailId = el.getAttribute("data-rel-open");
      });
    });
  });

  $("#addReleaseBtn")?.addEventListener("click", () => openSheet("release"));

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

function renderReleaseDetail(releaseId) {
  const release = (state.releases || []).find(r => r.id === releaseId);
  if (!release) { releaseDetailId = null; return renderReleases(); }

  setHeader(release.title);
  // Hide topbar title — the hero has its own large title
  const _tbH1 = document.querySelector(".topbar h1");
  if (_tbH1) _tbH1.textContent = "";
  const appEl = document.querySelector(".app");
  appEl?.classList.add("pdActive");
  appEl?.classList.remove("pdScrolled");
  activeScreenEl.style.paddingBottom = "0px";
  const topbarEl = document.querySelector(".topbar");
  const topbarH = topbarEl ? topbarEl.offsetHeight : 0;
  activeScreenEl.style.setProperty("--pd-topbar-h", topbarH + "px");
  activeScreenEl.style.overflowY = "scroll";

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

  // Composite art for release hero
  const releaseHeroArt = (rel, lite) => {
    const rSongs = (rel.songIds || []).map(id => state.songs.find(s => s.id === id)).filter(Boolean);
    if (!rSongs.length) {
      const fake = { id: rel.id, title: rel.title, project: rel.artist, genre: "" };
      return coverSvg(fake, { lite });
    }
    if (rSongs.length === 1) return coverSvg(rSongs[0], { lite });
    const cells = rSongs.slice(0, 4);
    const cls = `relMosaic relMosaic${Math.min(cells.length, 4)}`;
    return `<div class="${cls}">${cells.map(s => `<div class="relMosaicCell">${coverSvg(s, { lite })}</div>`).join("")}</div>`;
  };
  const heroCover = releaseHeroArt(release, false);

  const songRows = songs.map((s, i) => {
    return `
      <div class="pdSongRow" data-open-song="${s.id}">
        <span class="pdSongNum">${i + 1}</span>
        <div class="songThumb" aria-hidden="true">
          ${coverSvg(s, { lite: true })}
        </div>
        <div class="songMain">
          <div class="songTop">
            <div class="songTitleRow">
              <div class="songTitle">${escapeHtml(s.title || "Untitled")}</div>
            </div>
            <button class="songMore" data-rel-song-more="${s.id}" aria-label="Song menu">&#x22EF;</button>
          </div>
          <div class="songSub">${escapeHtml(s.genre || s.project || "—")}</div>
        </div>
      </div>
    `;
  }).join("");

  activeScreenEl.innerHTML = `
    <div class="pdHero">
      <div class="pdHeroBg" aria-hidden="true">${heroCover}</div>
      <div class="pdHeroContent">
        <div class="pdHeroTitle">${escapeHtml(release.title)}</div>
        <div class="pdHeroMeta">${escapeHtml(release.artist || "—")} · ${escapeHtml(fmtDate(release.releaseDate))}</div>
      </div>
    </div>

    <div class="pdActions">
      <button class="pdPlayBtn" id="relPlayAll" ${!items.length ? "disabled" : ""}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <button class="pdShuffleBtn" id="relShuffle" ${!items.length ? "disabled" : ""}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
      </button>
      <button class="pdMoreBtn" id="relMoreMenu" aria-label="Release menu">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
      </button>
    </div>

    <div class="pdSticky">
      <div class="pdTabs">
        <button class="pdTab pdTabActive">Songs</button>
      </div>
      <div class="pdTabBody" id="pdTabBody">
        <div class="pdSongList">
          ${songRows || `<div class="small" style="padding:24px 0; text-align:center">No songs linked to this release yet.</div>`}
        </div>
      </div>
    </div>
  `;

  // Reset scroll AFTER innerHTML so the hero is visible on load
  activeScreenEl.scrollTop = 0;

  /* ── Play / Shuffle ── */
  $("#relPlayAll")?.addEventListener("click", async () => {
    if (!items.length) return toast("No playable songs");
    const all = [...items];
    state.player.nowPlaying = all[0];
    state.player.queue = all.slice(1);
    state.player.repeatQueue = all;
    saveState();
    await playNowPlaying({ autoplay: true });
  });

  $("#relShuffle")?.addEventListener("click", async () => {
    if (!items.length) return toast("No playable songs");
    const all = shuffleArray([...items]);
    state.player.nowPlaying = all[0];
    state.player.queue = all.slice(1);
    state.player.repeatQueue = all;
    saveState();
    await playNowPlaying({ autoplay: true });
  });

  $("#relMoreMenu")?.addEventListener("click", () => {
    openReleaseMenu(releaseId);
  });

  /* ── Song row listeners ── */
  function attachSongListeners() {
    activeScreenEl.querySelectorAll("[data-open-song]").forEach(row => {
      let longPressTimer = null;
      let didLongPress = false;

      row.addEventListener("touchstart", () => {
        didLongPress = false;
        longPressTimer = setTimeout(() => {
          didLongPress = true;
          navigator.vibrate?.(30);
          const sid = row.getAttribute("data-open-song");
          if (sid) openSongMenu(sid);
        }, 500);
      }, { passive: true });
      row.addEventListener("touchend", () => { clearTimeout(longPressTimer); });
      row.addEventListener("touchmove", () => { clearTimeout(longPressTimer); });
      row.addEventListener("touchcancel", () => { clearTimeout(longPressTimer); });

      row.addEventListener("click", (e) => {
        if (didLongPress) return;
        if (e.target.closest("[data-rel-song-more]")) return;
        const sid = row.getAttribute("data-open-song");
        navigateForward(() => {
          releaseDetailId = null;
          drawerView = null;
          currentTab = "songs";
          songsView = "detail";
          selectedSongId = sid;
          selectedVersionId = null;
        });
      });
    });

    activeScreenEl.querySelectorAll("[data-rel-song-more]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openSongMenu(btn.getAttribute("data-rel-song-more"));
      });
    });
  }

  attachSongListeners();

  /* ── Fade hero + actions to black, solid topbar as user scrolls ── */
  const heroEl = activeScreenEl.querySelector(".pdHero");
  const heroBgEl = heroEl?.querySelector(".pdHeroBg");
  const heroContentEl = heroEl?.querySelector(".pdHeroContent");
  const actionsEl = activeScreenEl.querySelector(".pdActions");
  const stickyEl = activeScreenEl.querySelector(".pdSticky");
  if (stickyEl && heroEl) {
    let maxScroll = 0;
    const FADE_PX = 200;
    requestAnimationFrame(() => {
      maxScroll = activeScreenEl.scrollHeight - activeScreenEl.clientHeight;
    });

    activeScreenEl.addEventListener("scroll", () => {
      const scrolled = activeScreenEl.scrollTop;
      if (maxScroll > 0) {
        const remaining = maxScroll - scrolled;
        const opacity = remaining < FADE_PX ? Math.max(0, remaining / FADE_PX) : 1;
        if (heroBgEl) heroBgEl.style.opacity = opacity;
        if (heroContentEl) heroContentEl.style.opacity = opacity;
        if (actionsEl) actionsEl.querySelectorAll("button").forEach(b => b.style.opacity = opacity);
      }
      if (appEl) {
        const heroBottom = heroEl.getBoundingClientRect().bottom;
        const screenTop = activeScreenEl.getBoundingClientRect().top;
        if (heroBottom - screenTop < 60) {
          appEl.classList.add("pdScrolled");
        } else {
          appEl.classList.remove("pdScrolled");
        }
      }
    }, { passive: true });
  }
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
  // Cleanup previous particle system if re-rendering
  const prevGrid = activeScreenEl.querySelector(".homeGrid");
  if (prevGrid && prevGrid._cleanupHome) prevGrid._cleanupHome();

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
          <div class="hCard hSongs" role="button" tabindex="0" data-home="songs" aria-label="Songs">
            <div class="hArt"><img src="./songs-card.jpg" style="width:100%;height:100%;object-fit:cover;object-position:35% center;display:block;"></div>
            <canvas class="hWarp"></canvas>
            <canvas class="hParticles"></canvas>
            <div class="hShimmer"></div>
            <div class="hGrad"></div>
            <div class="hDarken"></div>
            <div class="hBody">
              <div class="hLabel">Songs</div>
            </div>
          </div>

          <!-- Projects — small, right column top -->
          <div class="hCard hProjects" role="button" tabindex="0" data-home="projects" aria-label="Projects">
            <div class="hArt"><img src="./projects-card.jpg" style="width:100%;height:100%;object-fit:cover;object-position:center 22%;display:block;"></div>
            <canvas class="hWarp"></canvas>
            <canvas class="hParticles"></canvas>
            <div class="hShimmer"></div>
            <div class="hGrad"></div>
            <div class="hDarken"></div>
            <div class="hBody">
              <div class="hLabel">Projects</div>
            </div>
          </div>

          <!-- Releases — small, right column bottom -->
          <div class="hCard hPlayer" role="button" tabindex="0" data-home="releases" aria-label="Releases">
            <div class="hArt"><img src="./releases-card.jpg" style="width:100%;height:100%;object-fit:cover;object-position:center 45%;display:block;"></div>
            <canvas class="hWarp"></canvas>
            <canvas class="hParticles"></canvas>
            <div class="hShimmer"></div>
            <div class="hGrad"></div>
            <div class="hDarken"></div>
            <div class="hBody">
              <div class="hLabel">Releases</div>
            </div>
          </div>

          <!-- Lyrics — full width -->
          <div class="hCard hLyrics hWide" role="button" tabindex="0" data-home="lyrics" aria-label="Lyrics">
            <div class="hArt"><img src="./lyrics-card.jpg" style="width:100%;height:150%;object-fit:cover;transform:scale(1.1);display:block;"></div>
            <canvas class="hWarp"></canvas>
            <canvas class="hParticles"></canvas>
            <div class="hShimmer"></div>
            <div class="hGrad"></div>
            <div class="hDarken"></div>
            <div class="hBody">
              <div class="hLabel">Lyrics</div>
            </div>
          </div>

          <!-- Actions — full width -->
          <div class="hCard hNext hWide" role="button" tabindex="0" data-home="next" aria-label="Actions">
            <div class="hArt"><img src="./actions-card.jpg" style="width:100%;height:100%;object-fit:cover;transform:scale(1.1);display:block;"></div>
            <canvas class="hWarp"></canvas>
            <canvas class="hParticles"></canvas>
            <div class="hShimmer"></div>
            <div class="hGrad"></div>
            <div class="hDarken"></div>
            <div class="hBody">
              <div class="hLabel">Actions</div>
            </div>
          </div>

        </div>
      </div>
    </div>
  `;

  // Topbar button actions
  activeScreenEl.querySelector("#htbNotif")?.addEventListener("click", () => {
    navigateForward(() => {
      drawerView = "alerts";
      setHeader("Alerts");
      syncTabs();
    });
  });
  activeScreenEl.querySelector("#htbSearch")?.addEventListener("click", () => {
    drawerView = "globalSearch";
    setActiveScreen("drawer");
    renderGlobalSearch();
  });
  activeScreenEl.querySelector("#htbSettings")?.addEventListener("click", () => {
    navigateForward(() => {
      currentTab = "settings";
    });
  });

  // Card navigation
  activeScreenEl.querySelectorAll("[data-home]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-home");
      if (target === "songs") {
        navigateForward(() => {
          resetSongsFilters({ keepSort: true });
          songsBackTarget = null;
          songsListScrollTop = 0;
          currentTab = "songs";
          songsView = "list";
          selectedSongId = null;
        });
        return;
      }
      if (target === "projects") {
        navigateForward(() => {
          drawerView = "projects";
          closeDrawer();
          selectedSongId = null;
        });
        return;
      }
      if (target === "releases") {
        navigateForward(() => {
          drawerView = "releases";
          closeDrawer();
          selectedSongId = null;
        });
        return;
      }
      if (target === "lyrics") {
        navigateForward(() => {
          lyricsEditSongId = null;
          overlayView = "lyrics";
          setHeader("Lyrics");
          renderLyricsScratch();
        });
        return;
      }
      if (target === "next") return renderNextActions();
    });
  });

  // === Sal nudge for users who skipped import ===
  const skipData = JSON.parse(localStorage.getItem("salImportSkipped") || "null");
  if (skipData && !document.querySelector(".salNudge")) {
    const daysSince = (Date.now() - skipData.skippedAt) / 86400000;
    const dismissed = localStorage.getItem("salNudgeDismissed");
    const secondDismissed = localStorage.getItem("salNudgeSecondDismissed");
    const showNudge = !dismissed || (!secondDismissed && daysSince >= 7);

    if (showNudge) {
      const nudge = document.createElement("div");
      nudge.className = "salNudge salNudgeIn";
      nudge.innerHTML = `
        <div class="salNudgeBubble">
          <button class="salNudgeClose" aria-label="Dismiss">&times;</button>
          <div style="display:flex;align-items:center;gap:10px;">
            ${salSvg(32)}
            <span>Still got ${skipData.count} song${skipData.count !== 1 ? "s" : ""} in the cloud whenever you're ready.</span>
          </div>
        </div>
      `;

      nudge.querySelector(".salNudgeBubble").addEventListener("click", (e) => {
        if (e.target.closest(".salNudgeClose")) return;
        nudge.classList.add("salNudgeOut");
        localStorage.removeItem("salImportSkipped");
        setTimeout(() => { nudge.remove(); runSalImportFlow(); }, 300);
      });

      nudge.querySelector(".salNudgeClose").addEventListener("click", () => {
        nudge.classList.add("salNudgeOut");
        if (!dismissed) {
          localStorage.setItem("salNudgeDismissed", String(Date.now()));
        } else {
          localStorage.setItem("salNudgeSecondDismissed", String(Date.now()));
        }
        setTimeout(() => nudge.remove(), 300);
      });

      // Delay entrance slightly so home screen paints first
      setTimeout(() => document.body.appendChild(nudge), 1500);
    }
  }

  // === Portal energy system: particles + magnetic touch ===
  const homeGrid = activeScreenEl.querySelector(".homeGrid");
  if (homeGrid) {
    const cards = [...homeGrid.querySelectorAll(".hCard")];

    // Stranger Things upside-down particle palettes per card
    const particlePalettes = {
      hSongs:    { core: [220,38,38],  mid: [239,68,68],  hi: [252,165,165], dim: [153,27,27]  },  // Red
      hProjects: { core: [147,51,234], mid: [168,85,247], hi: [216,180,254], dim: [88,28,135]  },  // Purple
      hPlayer:   { core: [37,99,235],  mid: [59,130,246], hi: [147,197,253], dim: [30,64,175]  },  // Blue
      hLyrics:   { core: [234,179,8],  mid: [250,204,21], hi: [254,240,138], dim: [161,98,7]   },  // Gold
      hNext:     { core: [234,88,12],  mid: [249,115,22], hi: [253,186,116], dim: [154,52,18]  },  // Orange
    };

    function getPalette(card) {
      for (const cls of Object.keys(particlePalettes)) {
        if (card.classList.contains(cls)) return particlePalettes[cls];
      }
      return { core: [255,255,255], mid: [200,200,200], hi: [255,255,255], dim: [120,120,120] };
    }

    // Per-card personality — each card has its own river speed/direction/touch feel
    const cardPersonality = {
      hSongs:    { flowAngle: -80, flowSpeed: 0.35, wobble: 0.5, touchRadius: 55, touchStrength: 0.12 },
      hProjects: { flowAngle: -95, flowSpeed: 0.25, wobble: 0.6, touchRadius: 50, touchStrength: 0.10 },
      hPlayer:   { flowAngle: -70, flowSpeed: 0.30, wobble: 0.45, touchRadius: 60, touchStrength: 0.14 },
      hLyrics:   { flowAngle: -110, flowSpeed: 0.20, wobble: 0.7, touchRadius: 45, touchStrength: 0.09 },
      hNext:     { flowAngle: -85, flowSpeed: 0.40, wobble: 0.4, touchRadius: 55, touchStrength: 0.13 },
    };

    function getPersonality(card) {
      for (const cls of Object.keys(cardPersonality)) {
        if (card.classList.contains(cls)) return cardPersonality[cls];
      }
      return { flowAngle: -90, flowSpeed: 0.3, wobble: 0.5, touchRadius: 50, touchStrength: 0.11 };
    }

    // Per-card particle systems
    const cardSystems = cards.map(card => {
      const canvas = card.querySelector(".hParticles");
      const ctx = canvas.getContext("2d");
      const pal = getPalette(card);
      const persona = getPersonality(card);
      const particles = [];
      const COUNT = 75;
      let w = 0, h = 0;
      let touchX = -1, touchY = -1, isTouched = false;
      let warpIntensity = 0; // 0→1 ramp over ~1.2s

      // Convert flow angle to velocity components
      const flowRad = persona.flowAngle * Math.PI / 180;
      const baseFlowVx = Math.cos(flowRad) * persona.flowSpeed;
      const baseFlowVy = Math.sin(flowRad) * persona.flowSpeed;

      function rgba([r,g,b], a) { return `rgba(${r},${g},${b},${a})`; }

      // === Mesh warp system ===
      const warpCanvas = card.querySelector(".hWarp");
      const warpCtx = warpCanvas.getContext("2d");
      const imgEl = card.querySelector(".hArt img");
      let warpReady = false;
      let warpSrc = null; // offscreen canvas with the visible image portion
      const WARP_COLS = 14, WARP_ROWS = 18;
      const WARP_STRENGTH = 0.07;

      function initWarp() {
        if (!imgEl || !imgEl.naturalWidth || !w || !h) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        warpCanvas.width = w * dpr;
        warpCanvas.height = h * dpr;
        warpCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Compute the visible source rect (object-fit:cover math)
        const artEl = card.querySelector(".hArt");
        const cardRect = card.getBoundingClientRect();
        const artRect = artEl.getBoundingClientRect();
        const imgW = imgEl.naturalWidth, imgH = imgEl.naturalHeight;
        const artW = artRect.width, artH = artRect.height;

        // Parse object-position
        const style = imgEl.getAttribute("style") || "";
        let posX = 0.5, posY = 0.5;
        const posMatch = style.match(/object-position:\s*([^\s;]+)\s+([^\s;]+)/);
        if (posMatch) {
          posX = posMatch[1] === "center" ? 0.5 : parseFloat(posMatch[1]) / 100;
          posY = posMatch[2] === "center" ? 0.5 : parseFloat(posMatch[2]) / 100;
        }

        // How img covers the art element
        const imgAspect = imgW / imgH, artAspect = artW / artH;
        let cropSx, cropSy, cropSw, cropSh;
        if (imgAspect > artAspect) {
          cropSh = imgH; cropSw = imgH * artAspect;
          cropSx = (imgW - cropSw) * posX; cropSy = 0;
        } else {
          cropSw = imgW; cropSh = imgW / artAspect;
          cropSx = 0; cropSy = (imgH - cropSh) * posY;
        }

        // Offset for card viewport within the larger art
        const offX = cardRect.left - artRect.left;
        const offY = cardRect.top - artRect.top;
        const scaleX = cropSw / artW, scaleY = cropSh / artH;

        // Pre-render the visible portion to an offscreen canvas
        const off = document.createElement("canvas");
        off.width = w * dpr; off.height = h * dpr;
        const offCtx = off.getContext("2d");
        offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        offCtx.drawImage(imgEl,
          cropSx + offX * scaleX, cropSy + offY * scaleY,
          cardRect.width * scaleX, cardRect.height * scaleY,
          0, 0, w, h
        );
        warpSrc = off;
        warpReady = true;
      }

      // Wait for image load then init warp
      if (imgEl) {
        if (imgEl.complete && imgEl.naturalWidth) setTimeout(initWarp, 50);
        else imgEl.addEventListener("load", () => setTimeout(initWarp, 50), { once: true });
      }

      function drawWarp(tx, ty) {
        if (!warpReady) return;
        // Ramp intensity up over ~1.2s (~72 frames at 60fps)
        warpIntensity = Math.min(1, warpIntensity + 1 / 72);
        const intensity = warpIntensity;

        const cellW = w / WARP_COLS, cellH = h / WARP_ROWS;
        const srcCW = warpSrc.width / WARP_COLS, srcCH = warpSrc.height / WARP_ROWS;
        const radius = Math.min(w, h) * 0.7;
        // Overlap margin to eliminate grid seams
        const m = 2;

        warpCtx.clearRect(0, 0, w, h);
        for (let row = 0; row < WARP_ROWS; row++) {
          for (let col = 0; col < WARP_COLS; col++) {
            const destX = col * cellW, destY = row * cellH;
            const cenX = destX + cellW / 2, cenY = destY + cellH / 2;
            const dx = tx - cenX, dy = ty - cenY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            let offX = 0, offY = 0;
            if (dist < radius && dist > 0.5) {
              const t = 1 - dist / radius;
              const pull = t * t * WARP_STRENGTH * intensity;
              offX = -dx * pull;
              offY = -dy * pull;
            }

            warpCtx.drawImage(warpSrc,
              col * srcCW - m, row * srcCH - m, srcCW + m * 2, srcCH + m * 2,
              destX + offX - m, destY + offY - m, cellW + m * 2, cellH + m * 2
            );
          }
        }
      }

      function clearWarp() {
        warpCtx.clearRect(0, 0, w, h);
      }

      function resize() {
        const rect = card.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        w = rect.width; h = rect.height;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // Re-init warp source on resize
        warpReady = false;
        initWarp();
      }

      function makeParticle(respawnEdge) {
        const roll = Math.random();
        let r, spdMult, baseAlpha, type;
        if (roll < 0.50) {
          type = "dust";
          r = Math.random() * 1.2 + 0.3;
          spdMult = 0.6 + Math.random() * 0.8;
          baseAlpha = Math.random() * 0.35 + 0.12;
        } else if (roll < 0.85) {
          type = "ember";
          r = Math.random() * 2 + 0.8;
          spdMult = 0.8 + Math.random() * 0.6;
          baseAlpha = Math.random() * 0.5 + 0.18;
        } else {
          type = "orb";
          r = Math.random() * 3.5 + 2;
          spdMult = 0.3 + Math.random() * 0.3;
          baseAlpha = Math.random() * 0.25 + 0.08;
        }

        const colors = type === "orb" ? [pal.core, pal.mid] :
                       type === "ember" ? [pal.core, pal.mid, pal.hi] :
                       [pal.mid, pal.hi, pal.dim];
        const color = colors[Math.floor(Math.random() * colors.length)];

        // River flow + individual variance
        const vx = baseFlowVx * spdMult + (Math.random() - 0.5) * 0.1;
        const vy = baseFlowVy * spdMult + (Math.random() - 0.5) * 0.1;

        // Spawn position: either random (init) or from the bottom/side edge (respawn)
        let x, y;
        if (respawnEdge) {
          // Respawn from the downstream edge so the river keeps flowing
          x = Math.random() * (w || 200);
          y = (h || 300) + Math.random() * 30;
        } else {
          x = Math.random() * (w || 200);
          y = Math.random() * (h || 300);
        }

        return {
          x, y, vx, vy, r, color, baseAlpha, type,
          // Store base velocity for restoring after touch
          bvx: vx, bvy: vy,
          phase: Math.random() * Math.PI * 2,
          flicker: type === "ember" ? 0.002 + Math.random() * 0.003 : 0.0008 + Math.random() * 0.0006,
          wobAmp: persona.wobble * (type === "orb" ? 1.4 : type === "ember" ? 0.8 : 0.5) + Math.random() * 0.3,
          // Absorption state: when a particle reaches the finger it fades and respawns
          absorb: 0, // 0 = normal, ramps to 1 = fully absorbed
        };
      }

      function initParticles() {
        resize();
        particles.length = 0;
        for (let i = 0; i < COUNT; i++) particles.push(makeParticle(false));
      }

      function draw(time) {
        // Draw localized mesh warp when touched — ramps in with intensity
        if (isTouched && touchX >= 0 && warpReady) {
          drawWarp(touchX, touchY);
          // Fade warp canvas in and original img out in sync with intensity
          warpCanvas.style.opacity = warpIntensity;
          if (imgEl) imgEl.style.opacity = 1 - warpIntensity;
        }

        ctx.clearRect(0, 0, w, h);
        for (let i = 0; i < particles.length; i++) {
          const p = particles[i];

          // Move along river flow
          p.x += p.vx;
          p.y += p.vy;

          // Off-screen? Respawn from downstream edge
          if (p.y < -15 || p.y > h + 20 || p.x < -15 || p.x > w + 20) {
            particles[i] = makeParticle(true);
            continue;
          }

          // If fully absorbed, respawn
          if (p.absorb >= 1) {
            particles[i] = makeParticle(true);
            continue;
          }

          // Sine wobble
          const wobX = Math.sin(time * 0.0005 + p.phase) * p.wobAmp;
          const wobY = Math.cos(time * 0.00045 + p.phase * 1.3) * p.wobAmp * 0.8;

          let drawX = p.x + wobX;
          let drawY = p.y + wobY;
          let drawR = p.r;

          // Flicker/breathe
          const breathe = 0.5 + 0.5 * Math.sin(time * p.flicker + p.phase);
          let alpha = p.baseAlpha * (0.4 + 0.6 * breathe);

          // Touch interaction — nearby fish drift toward finger, absorb on arrival
          if (isTouched && touchX >= 0) {
            const dx = touchX - drawX;
            const dy = touchY - drawY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < persona.touchRadius) {
              // Nearby particle: gently steer toward finger
              const t = 1 - dist / persona.touchRadius; // 0 at edge, 1 at finger
              p.vx += (dx / (dist + 10)) * persona.touchStrength;
              p.vy += (dy / (dist + 10)) * persona.touchStrength;
              // Dampen slightly so approach is smooth, not jittery
              p.vx *= 0.96;
              p.vy *= 0.96;
              // Brighten as it approaches
              alpha = Math.min(1, alpha + t * 0.3);
              drawR *= 1 + t * 0.6;

              // Very close to finger — start absorbing (fade out)
              if (dist < 14) {
                p.absorb += 0.06;
                alpha *= (1 - p.absorb);
                drawR *= (1 - p.absorb * 0.5);
              }
            } else {
              // Far away fish — keep swimming, don't care about finger
              // Gently restore to base river velocity
              p.vx += (p.bvx - p.vx) * 0.02;
              p.vy += (p.bvy - p.vy) * 0.02;
            }
          } else {
            // No touch — restore to river flow
            p.vx += (p.bvx - p.vx) * 0.03;
            p.vy += (p.bvy - p.vy) * 0.03;
            // Reset any partial absorption
            if (p.absorb > 0) p.absorb = Math.max(0, p.absorb - 0.04);
          }

          if (alpha <= 0.01) continue;

          // Draw particle
          ctx.beginPath();
          ctx.arc(drawX, drawY, drawR, 0, Math.PI * 2);
          ctx.fillStyle = rgba(p.color, alpha);
          ctx.fill();

          // Glow halo
          const glowMult = p.type === "orb" ? 4.5 : p.type === "ember" ? 3 : 2;
          const glowAlpha = p.type === "orb" ? alpha * 0.12 : alpha * 0.1;
          if (drawR > 0.5) {
            ctx.beginPath();
            ctx.arc(drawX, drawY, drawR * glowMult, 0, Math.PI * 2);
            ctx.fillStyle = rgba(p.color, glowAlpha);
            ctx.fill();
          }
        }
      }

      // Darken overlay — animated manually in rAF, not CSS
      const darkenEl = card.querySelector(".hDarken");
      let darkenOpacity = 0;
      const DARKEN_MAX = 0.10;      // noticeable but not heavy
      const DARKEN_RATE = 0.0005;   // per-frame increment (~3.3s to reach max at 60fps)
      const DARKEN_FADE = 0.002;    // fade-out ~1s

      function updateDarken() {
        if (isTouched) {
          darkenOpacity = Math.min(DARKEN_MAX, darkenOpacity + DARKEN_RATE);
        } else if (darkenOpacity > 0) {
          darkenOpacity = Math.max(0, darkenOpacity - DARKEN_FADE);
        }
        if (darkenEl) darkenEl.style.opacity = darkenOpacity;
      }

      initParticles();
      return { card, canvas, ctx, draw, resize, particles, initParticles, updateDarken,
        clearWarp() { clearWarp(); warpIntensity = 0; warpCanvas.style.opacity = 0; if (imgEl) imgEl.style.opacity = ""; },
        setTouch(x, y) { if (!isTouched) warpIntensity = 0; touchX = x; touchY = y; isTouched = true; },
        clearTouch() { touchX = -1; touchY = -1; isTouched = false; },
        get warpIntensity() { return warpIntensity; }
      };
    });

    // Animation loop — single rAF for all cards
    let homeAnimId = null;
    function animLoop(time) {
      for (const sys of cardSystems) { sys.draw(time); sys.updateDarken(); }
      homeAnimId = requestAnimationFrame(animLoop);
    }

    // Observe visibility to pause when off-screen
    const observer = new IntersectionObserver(entries => {
      const visible = entries.some(e => e.isIntersecting);
      if (visible && !homeAnimId) homeAnimId = requestAnimationFrame(animLoop);
      if (!visible && homeAnimId) { cancelAnimationFrame(homeAnimId); homeAnimId = null; }
    }, { threshold: 0.1 });
    observer.observe(homeGrid);
    homeAnimId = requestAnimationFrame(animLoop);

    // Resize handler
    let resizeTimer;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => cardSystems.forEach(s => s.resize()), 150);
    };
    window.addEventListener("resize", onResize);

    // === Magnetic touch interaction ===
    let hgStartX = 0, hgStartY = 0, hgDragged = false;
    let activeCard = null;

    // Smooth interpolation — art/card position eases toward target each frame
    const smoothEase = "transform 0.15s cubic-bezier(.25,.46,.45,.94)";

    homeGrid.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      hgStartX = e.touches[0].clientX;
      hgStartY = e.touches[0].clientY;
      hgDragged = false;

      // Find which card was touched
      const touch = e.touches[0];
      activeCard = null;
      for (const sys of cardSystems) {
        const rect = sys.card.getBoundingClientRect();
        if (touch.clientX >= rect.left && touch.clientX <= rect.right &&
            touch.clientY >= rect.top && touch.clientY <= rect.bottom) {
          activeCard = sys;
          const lx = touch.clientX - rect.left;
          const ly = touch.clientY - rect.top;
          sys.setTouch(lx, ly);
          sys.card.classList.add("is-touched");

          // Subtle global tilt transition
          const art = sys.card.querySelector(".hArt");
          if (art) art.style.transition = "transform 0.6s cubic-bezier(.25,.46,.45,.94), scale 8s cubic-bezier(.25,.46,.45,.94)";
          const pCanvas = sys.card.querySelector(".hParticles");
          if (pCanvas) pCanvas.style.transition = smoothEase;

          // Shimmer: shift toward touch point (portal energy drawn to finger)
          const shimmer = sys.card.querySelector(".hShimmer");
          if (shimmer) {
            const cx = rect.width / 2, cy = rect.height / 2;
            const sNormX = (lx - cx) / cx;
            const sNormY = (ly - cy) / cy;
            shimmer.style.transform = `translate(${sNormX * 15}%, ${sNormY * 15}%) scale(1.10)`;
          }
          break;
        }
      }
    }, { passive: true });

    homeGrid.addEventListener("touchmove", (e) => {
      if (e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - hgStartX;
      const dy = e.touches[0].clientY - hgStartY;
      if (!hgDragged && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
        hgDragged = true;
        homeGrid.classList.add("is-dragging");
      }

      if (activeCard) {
        const rect = activeCard.card.getBoundingClientRect();
        const lx = e.touches[0].clientX - rect.left;
        const ly = e.touches[0].clientY - rect.top;
        activeCard.setTouch(lx, ly);

        const cx = rect.width / 2, cy = rect.height / 2;
        const normX = (lx - cx) / cx; // -1 to 1
        const normY = (ly - cy) / cy; // -1 to 1

        // Localized warp is handled by canvas in the draw loop (reads touchX/Y)
        // Subtle global tilt + parallax — scaled by warp ramp so nothing moves instantly
        const wi = activeCard.warpIntensity;
        const art = activeCard.card.querySelector(".hArt");
        if (art) art.style.transform = `perspective(1400px) rotateX(${-normY * 1.5 * wi}deg) rotateY(${normX * 2 * wi}deg) translate(${normX * 2 * wi}px, ${normY * 2 * wi}px)`;

        const pCanvas = activeCard.card.querySelector(".hParticles");
        if (pCanvas) pCanvas.style.transform = `translate(${normX * 2 * wi}px, ${normY * 2 * wi}px)`;

        // Shimmer: energy drawn toward finger
        const shimmer = activeCard.card.querySelector(".hShimmer");
        if (shimmer) shimmer.style.transform = `translate(${normX * 18 * wi}%, ${normY * 18 * wi}%) scale(${1 + 0.12 * wi})`;
      }
    }, { passive: true });

    const releaseCard = () => {
      homeGrid.classList.remove("is-dragging");
      if (hgDragged) {
        homeGrid.addEventListener("click", e => { e.stopPropagation(); e.preventDefault(); }, { once: true, capture: true });
      }
      if (activeCard) {
        activeCard.clearTouch();
        activeCard.clearWarp();
        activeCard.card.classList.remove("is-touched");

        const ease = "transform 0.5s cubic-bezier(.22,1,.36,1)";

        // Spring art tilt back
        const art = activeCard.card.querySelector(".hArt");
        if (art) {
          art.style.transition = ease + ", scale 4s cubic-bezier(.25,.46,.45,.94)";
          art.style.transform = "";
        }

        // Spring particles canvas back
        const pCanvas = activeCard.card.querySelector(".hParticles");
        if (pCanvas) {
          pCanvas.style.transition = ease;
          pCanvas.style.transform = "";
        }

        // Spring shimmer back to center (CSS animation resumes via removing .is-touched)
        const shimmer = activeCard.card.querySelector(".hShimmer");
        if (shimmer) {
          shimmer.style.transition = "transform 0.6s cubic-bezier(.22,1,.36,1), opacity 0.5s ease, filter 0.5s ease";
          shimmer.style.transform = "";
        }

        // Clean up inline transitions after spring completes
        const artRef = art, pRef = pCanvas, shimRef = shimmer;
        const onEnd = () => {
          if (artRef) artRef.style.transition = "";
          if (pRef) pRef.style.transition = "";
          if (shimRef) shimRef.style.transition = "";
        };
        (art || pCanvas)?.addEventListener("transitionend", onEnd, { once: true });
        activeCard = null;
      }
    };

    homeGrid.addEventListener("touchend", releaseCard, { passive: true });
    homeGrid.addEventListener("touchcancel", releaseCard, { passive: true });

    // Pause/resume — freeze particle positions AND CSS animations when home goes off-screen
    homeGrid._pauseHome = () => {
      if (homeAnimId) { cancelAnimationFrame(homeAnimId); homeAnimId = null; }
      homeGrid.querySelectorAll(".hShimmer, .hCard").forEach(el => {
        el.style.animationPlayState = "paused";
      });
    };
    homeGrid._resumeHome = () => {
      if (!homeAnimId) homeAnimId = requestAnimationFrame(animLoop);
      homeGrid.querySelectorAll(".hShimmer, .hCard").forEach(el => {
        el.style.animationPlayState = "";
      });
    };

    // Cleanup when navigating away
    const cleanupHome = () => {
      if (homeAnimId) { cancelAnimationFrame(homeAnimId); homeAnimId = null; }
      observer.disconnect();
      window.removeEventListener("resize", onResize);
    };
    homeGrid._cleanupHome = cleanupHome;
  }
}

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

// Full-screen share overlay — Player-style user search + role picker
let shareOverlayEl = null;

function openShareOverlay({ projectId, projectName, songId, songTitle }) {
  const targetLabel = projectName || songTitle || "content";
  let selectedUser = null;
  let searchTimer = null;

  // Create overlay
  if (shareOverlayEl) shareOverlayEl.remove();
  shareOverlayEl = document.createElement("div");
  shareOverlayEl.className = "shareOverlay";
  document.body.appendChild(shareOverlayEl);
  requestAnimationFrame(() => shareOverlayEl.classList.add("open"));

  const renderOverlay = () => {
    shareOverlayEl.innerHTML = `
      <div class="shareOverlayHeader">
        <button class="shareOverlayClose" id="shareClose">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
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
      ` : ""}

      <div class="shareResults" id="shareResults">
        <div class="shareResultsEmpty"><div class="collabSpinner"></div></div>
      </div>
    `;

    // Wire close
    $("#shareClose")?.addEventListener("click", closeShareOverlay);

    // Load friends as default list
    const resultsDefault = $("#shareResults");
    if (resultsDefault && !selectedUser) {
      getMyFriends().then(friends => {
        const cur = $("#shareResults");
        if (!cur || $("#shareSearch")?.value?.trim()) return; // user already typed
        if (!friends.length) {
          cur.innerHTML = `<div class="shareResultsEmpty">Search for people or add friends from the Collab tab</div>`;
          return;
        }
        cur.innerHTML = `<div class="shareRoleLabel" style="padding:0 4px 8px;font-size:12px">Your Friends</div><div class="shareResultsList">${friends.map(f => {
          const u = f.profile || {};
          const meta = [u.instrument, u.genre, u.location].filter(Boolean).join(" · ");
          return `
            <button class="shareUserRow" data-uid="${u.id}">
              ${u.avatar_url && !u.avatar_url.startsWith("preset:")
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
        cur.querySelectorAll(".shareUserRow").forEach(row => {
          row.addEventListener("click", () => {
            const uid = row.getAttribute("data-uid");
            selectedUser = friends.find(f => f.profile?.id === uid)?.profile;
            renderOverlay();
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

          if (!q) {
            // Re-show friends list
            renderOverlay();
            return;
          }

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
              renderOverlay();
            });
          });
        }, 300);
      });

      if (!selectedUser) setTimeout(() => searchInput.focus(), 150);
    }

    // Wire clear selection
    $("#shareClearUser")?.addEventListener("click", () => {
      selectedUser = null;
      renderOverlay();
    });

    // Wire role buttons
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
          closeShareOverlay();
        } catch (e) {
          console.error("Share failed:", e);
          toast(e.message || "Failed to share");
          btn.style.opacity = "1";
          btn.disabled = false;
        }
      });
    });
  };

  renderOverlay();
}

function closeShareOverlay() {
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
      && !(document.visibilityState === "visible" && currentTab === "collab")) {
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

async function refreshSharedData() {
  try {
    const [projects, songs, invites, myProjects, mySongs] = await Promise.all([
      pullSharedProjects(),
      pullSharedSongs(),
      listMyInvites(),
      pullMySharedProjects(),
      pullMySharedSongs(),
    ]);

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

    sharedData = { projects: projects || [], songs: songs || [], invites: invites || [], myProjects: myProjects || [], mySongs: mySongs || [], loaded: true };
  } catch (e) {
    console.warn("[Collab] Failed to fetch shared data:", e);
    if (!sharedData.loaded) sharedData = { projects: [], songs: [], invites: [], myProjects: [], mySongs: [], loaded: true };
  }
}

// ── Friends sidebar state ──
let _collabSidebarOpen = false;
let _friendsOverlayEl = null;
let _pendingFriendCount = 0;

function renderCollab() {
  setHeader("Collab");
  const appEl = document.querySelector(".app");
  appEl?.classList.add("collapseTitle");
  const h1 = appEl?.querySelector(".titleblock h1");
  if (h1) h1.style.opacity = "0";

  // Apply cached badge counts immediately (no lag), then refresh in background
  _applyAllBadges(_unreadMsgCount, _pendingFriendCount);
  syncMessageBadges();

  // Build badge subtitles
  const friendBadge = _pendingFriendCount ? `${_pendingFriendCount} pending` : "";
  const msgBadge = _unreadMsgCount ? `${_unreadMsgCount} unread` : "";
  const sharedCount = (sharedData.songs?.length || 0) + (sharedData.projects || []).reduce((n, p) => n + (p.songs?.length || 0), 0);

  activeScreenEl.innerHTML = `
    <div class="songsPageTitle">Collab</div>

    <div class="collabGrid">
      <div class="hCard hCollabFriends hWide" role="button" tabindex="0" data-collab-nav="friends" aria-label="Friends">
        <div class="hShimmer"></div>
        <div class="hGrad"></div>
        <div class="hBody">
          <div class="hLabel">Friends</div>
          ${friendBadge ? `<div class="hSub">${friendBadge}</div>` : ""}
        </div>
      </div>

      <div class="hCard hCollabSongs hWide" role="button" tabindex="0" data-collab-nav="songs" aria-label="Songs">
        <div class="hShimmer"></div>
        <div class="hGrad"></div>
        <div class="hBody">
          <div class="hLabel">Songs</div>
          ${sharedCount ? `<div class="hSub">${sharedCount} shared</div>` : ""}
        </div>
      </div>

      <div class="hCard hCollabMessages hWide" role="button" tabindex="0" data-collab-nav="messages" aria-label="Messages">
        <div class="hShimmer"></div>
        <div class="hGrad"></div>
        <div class="hBody">
          <div class="hLabel">Messages</div>
          ${msgBadge ? `<div class="hSub">${msgBadge}</div>` : ""}
        </div>
      </div>

      <div class="hCard hCollabAdd hWide" role="button" tabindex="0" data-collab-nav="add" aria-label="Add Friend">
        <div class="hShimmer"></div>
        <div class="hGrad"></div>
        <div class="hBody">
          <div class="hLabel">Add Friend</div>
          <div class="hSub">Find &amp; invite people</div>
        </div>
      </div>
    </div>
  `;

  // Wire card taps
  activeScreenEl.querySelectorAll("[data-collab-nav]").forEach(card => {
    card.addEventListener("click", () => {
      const target = card.getAttribute("data-collab-nav");
      if (target === "friends") {
        navigateForward(() => { openFriendsList(); });
      } else if (target === "songs") {
        navigateForward(() => {
          songsListState.ownerFilter = "shared";
          currentTab = "songs";
          songsView = "list";
          selectedSongId = null;
        });
      } else if (target === "messages") {
        navigateForward(() => { openMessages(); });
      } else if (target === "add") {
        navigateForward(() => { openAddFriend(); });
      }
    });
  });

  // Refresh shared data & badges in background
  refreshSharedData().catch(() => {});

  // Collapse title scroll handler
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

function _updateCollabBadges(friendCount, msgCount) {
  _applyAllBadges(friendCount, msgCount);
}

function _collabInlineBackHTML() {
  const total = (_unreadMsgCount || 0) + (_pendingFriendCount || 0);
  const badgeDisplay = total ? "flex" : "none";
  return `
    <button class="collabInlineBack" id="collabInlineBack" aria-label="Menu">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="24" height="24"><polyline points="15 18 9 12 15 6"/></svg>
      <span class="collabInlineBadge" style="display:${badgeDisplay}">${total || ""}</span>
    </button>
  `;
}

function _wireCollabInlineBack() {
  $("#collabInlineBack")?.addEventListener("click", () => {
    _finishSidebarSwipe(!_collabSidebarOpen);
  });
}

function _collabSidebarHTML() {
  const friendBadgeDisplay = _pendingFriendCount ? "flex" : "none";
  const msgBadgeDisplay = _unreadMsgCount ? "flex" : "none";
  return `
    <button class="collabSidebarBtn" data-sidebar="requests">
      <span class="friendsBadge" style="display:${friendBadgeDisplay}">${_pendingFriendCount || ""}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
      Requests
    </button>
    <button class="collabSidebarBtn" data-sidebar="friends">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
      Friends
    </button>
    <button class="collabSidebarBtn" data-sidebar="messages">
      <span class="msgBadge" style="display:${msgBadgeDisplay}">${_unreadMsgCount || ""}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
      Messages
    </button>
    <button class="collabSidebarBtn" data-sidebar="add">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Add
    </button>
  `;
}

// ── Collab sidebar swipe (document-level, same sensitivity as nav back) ──
let _sidebarSwipe = { tracking: false, decided: false, startX: 0, startY: 0, lastX: 0, lastTime: 0 };
const _SIDEBAR_W = 72;

function _getCollabEls() {
  const shell = document.querySelector(".collabShell");
  if (!shell) return null;
  return { shell, mainEl: shell.querySelector(".collabMain"), sidebarEl: shell.querySelector(".collabSidebar") };
}

function _finishSidebarSwipe(commit) {
  const els = _getCollabEls();
  if (!els) return;
  const { shell, mainEl, sidebarEl } = els;
  const dur = 200;
  const ease = "cubic-bezier(.4,0,.2,1)";
  mainEl.style.transition = `transform ${dur}ms ${ease}`;
  sidebarEl.style.transition = `opacity ${dur}ms ${ease}`;

  if (commit) {
    mainEl.style.transform = `translateX(${_SIDEBAR_W}px)`;
    sidebarEl.style.opacity = "1";
    sidebarEl.style.pointerEvents = "auto";
    _collabSidebarOpen = true;
    shell.classList.add("sidebarOpen");
  } else {
    mainEl.style.transform = "translateX(0)";
    sidebarEl.style.opacity = "0";
    sidebarEl.style.pointerEvents = "none";
    _collabSidebarOpen = false;
    shell.classList.remove("sidebarOpen");
  }

  setTimeout(() => {
    mainEl.style.transition = "";
    sidebarEl.style.transition = "";
    if (!_collabSidebarOpen) {
      mainEl.style.transform = "";
      sidebarEl.style.opacity = "";
      sidebarEl.style.pointerEvents = "";
    }
  }, dur);
}

// Hooked into existing document touchstart/move/end below
function _sidebarTouchStart(t) {
  // Only on collab root (no drill-in, no overlay)
  if (currentTab !== "collab" || projectDetailScreen || selectedSongId || overlayView) return false;
  const els = _getCollabEls();
  if (!els) return false;

  const { mainEl, sidebarEl } = els;
  // Open: left edge (same <= 24 as nav back). Close: anywhere while open.
  if (t.clientX <= 24 && !_collabSidebarOpen) {
    _sidebarSwipe = { tracking: true, decided: false, startX: t.clientX, startY: t.clientY, lastX: t.clientX, lastTime: Date.now() };
    mainEl.style.transition = "none";
    sidebarEl.style.transition = "none";
    return true;
  }
  if (_collabSidebarOpen) {
    _sidebarSwipe = { tracking: true, decided: true, startX: t.clientX, startY: t.clientY, lastX: t.clientX, lastTime: Date.now() };
    mainEl.style.transition = "none";
    sidebarEl.style.transition = "none";
    return true;
  }
  return false;
}

function _sidebarTouchMove(t) {
  if (!_sidebarSwipe.tracking) return;
  const sw = _sidebarSwipe;
  const dx = t.clientX - sw.startX;
  const dy = Math.abs(t.clientY - sw.startY);

  if (!sw.decided) {
    if (Math.abs(dx) < 6 && dy < 6) return;
    if (dy > Math.abs(dx)) { sw.tracking = false; return; }
    sw.decided = true;
  }

  sw.lastX = t.clientX; sw.lastTime = Date.now();

  let offset;
  if (_collabSidebarOpen) {
    offset = Math.max(0, Math.min(_SIDEBAR_W, _SIDEBAR_W + dx));
  } else {
    offset = Math.max(0, Math.min(_SIDEBAR_W, dx));
  }

  const els = _getCollabEls();
  if (!els) return;
  const ratio = offset / _SIDEBAR_W;
  els.mainEl.style.transform = `translateX(${offset}px)`;
  els.sidebarEl.style.opacity = String(ratio);
}

function _sidebarTouchEnd(t) {
  if (!_sidebarSwipe.tracking) return;
  const sw = _sidebarSwipe;
  sw.tracking = false;

  if (!sw.decided) {
    if (_collabSidebarOpen) _finishSidebarSwipe(false);
    return;
  }

  const dx = t ? t.clientX - sw.startX : 0;
  const velocity = t ? (t.clientX - sw.lastX) / Math.max(1, Date.now() - sw.lastTime) : 0;

  let offset;
  if (_collabSidebarOpen) {
    offset = Math.max(0, Math.min(_SIDEBAR_W, _SIDEBAR_W + dx));
  } else {
    offset = Math.max(0, Math.min(_SIDEBAR_W, dx));
  }

  const ratio = offset / _SIDEBAR_W;

  if (_collabSidebarOpen) {
    const close = ratio < 0.5 || velocity < -0.3;
    _finishSidebarSwipe(!close);
  } else {
    const open = ratio > 0.5 || velocity > 0.3;
    _finishSidebarSwipe(open);
  }
}

function _wireCollabSidebar() {
  const shell = activeScreenEl.querySelector(".collabShell");
  if (!shell) return;

  // Tap on shifted main content → close sidebar
  const mainEl = shell.querySelector(".collabMain");
  mainEl.addEventListener("click", (e) => {
    if (_collabSidebarOpen) {
      e.preventDefault(); e.stopPropagation();
      _finishSidebarSwipe(false);
    }
  }, true);

  // Sidebar button taps
  shell.querySelectorAll("[data-sidebar]").forEach(btn => {
    btn.addEventListener("click", () => {
      const action = btn.getAttribute("data-sidebar");
      // Navigate first — forward slide captures the ace with sidebar still visible
      if (action === "requests") openFriendsRequests();
      else if (action === "friends") openFriendsList();
      else if (action === "messages") openMessages();
      else if (action === "add") openAddFriend();
      // Reset sidebar state AFTER capture so back-nav renders it closed
      _collabSidebarOpen = false;
    });
  });
}

function renderCollabContent() {
  const { projects: sharedProjects, songs: sharedSongs, invites, myProjects, mySongs } = sharedData;

  // Gather local collaborators from songs
  const counts = {};
  state.songs.forEach(s => {
    const raw = (s.collaborators || "").split(",").map(x => x.trim()).filter(Boolean);
    raw.forEach(name => { counts[name] = (counts[name] || 0) + 1; });
  });

  const collabRows = Object.entries(counts)
    .sort((a,b) => b[1] - a[1])
    .map(([name, count]) => `
      <div class="collabRow" data-collab-name="${escapeHtml(name)}">
        <div class="collabAvatar">${escapeHtml(name.charAt(0).toUpperCase())}</div>
        <div class="collabInfo">
          <div class="collabName">${escapeHtml(name)}</div>
          <div class="collabMeta">${count} song${count === 1 ? "" : "s"}</div>
        </div>
      </div>
    `).join("");

  // Shared projects cards
  const sharedProjCards = sharedProjects.map(sp => {
    const count = sp.songs.length;
    const repSong = sp.songs[0] || { id: sp.projectId, title: sp.projectName, project: sp.projectName, genre: "" };
    const roleBadge = sp.role === "collaborator"
      ? `<span class="sharedRoleBadge collab">Collaborator</span>`
      : `<span class="sharedRoleBadge viewer">Viewer</span>`;
    return `
      <div class="sharedCard" data-shared-proj="${escapeHtml(sp.projectId)}">
        <div class="sharedCardArt">${coverSvg(repSong, { lite: true })}</div>
        <div class="sharedCardBody">
          <div class="sharedCardTitle">${escapeHtml(sp.projectName)}</div>
          <div class="sharedCardMeta">from ${escapeHtml(sp.ownerName)} · ${count} song${count !== 1 ? "s" : ""}</div>
          ${roleBadge}
        </div>
      </div>
    `;
  }).join("");

  // Shared individual songs
  const sharedSongCards = sharedSongs.map(ss => {
    const s = ss.song;
    const roleBadge = ss.role === "collaborator"
      ? `<span class="sharedRoleBadge collab">Collaborator</span>`
      : `<span class="sharedRoleBadge viewer">Viewer</span>`;
    return `
      <div class="sharedCard" data-shared-song="${escapeHtml(s.id)}">
        <div class="sharedCardArt">${coverSvg(s, { lite: true })}</div>
        <div class="sharedCardBody">
          <div class="sharedCardTitle">${escapeHtml(s.title)}</div>
          <div class="sharedCardMeta">from ${escapeHtml(ss.ownerName)} · ${s.project ? escapeHtml(s.project) : "No project"}</div>
          ${roleBadge}
        </div>
      </div>
    `;
  }).join("");

  // Pending invites you've sent
  const pendingInvites = invites.filter(i => !i.accepted && !i.expired);
  const pendingHtml = pendingInvites.map(inv => `
    <div class="collabRow" style="align-items:flex-start">
      <div class="collabAvatar" style="background:linear-gradient(135deg,#6366f1,#a78bfa);font-size:13px">
        ${inv.targetType === "project" ? "P" : "S"}
      </div>
      <div class="collabInfo" style="flex:1">
        <div class="collabName">${escapeHtml(inv.targetName || "Unknown")}</div>
        <div class="collabMeta">${escapeHtml(inv.role)} · pending</div>
      </div>
      <button class="sharedDeleteInvite" data-del-invite="${inv.id}" aria-label="Delete invite" style="background:none;border:none;color:rgba(255,255,255,.4);font-size:18px;cursor:pointer;padding:4px 8px">&times;</button>
    </div>
  `).join("");

  const hasShared = sharedProjects.length || sharedSongs.length;

  // "Shared By Me" cards — projects & songs the user has shared with others
  const mySharedProjCards = myProjects.map(mp => `
    <div class="collabRow">
      <div class="collabAvatar" style="background:linear-gradient(135deg,#8b5cf6,#a78bfa);font-size:13px">P</div>
      <div class="collabInfo" style="flex:1">
        <div class="collabName">${escapeHtml(mp.projectName)}</div>
        <div class="collabMeta">to ${escapeHtml(mp.recipientName)} · ${escapeHtml(mp.role)}</div>
      </div>
    </div>
  `).join("");

  const mySharedSongCards = mySongs.map(ms => `
    <div class="collabRow">
      <div class="collabAvatar" style="background:linear-gradient(135deg,#8b5cf6,#a78bfa);font-size:13px">S</div>
      <div class="collabInfo" style="flex:1">
        <div class="collabName">${escapeHtml(ms.songTitle)}</div>
        <div class="collabMeta">to ${escapeHtml(ms.recipientName)} · ${escapeHtml(ms.role)}</div>
      </div>
    </div>
  `).join("");

  const hasMyShared = myProjects.length || mySongs.length;

  activeScreenEl.innerHTML = `
    <div class="collabShell">
      <div class="collabSidebar">${_collabSidebarHTML()}</div>
      <div class="collabMain">
        <div class="collabWrap">
          <div class="songsPageTitle">Collab</div>
          ${hasShared ? `
            <!-- Shared With Me -->
            <div class="collabSection">
              <div class="collabSectionTitle">Shared With Me</div>
              ${sharedProjCards}
              ${sharedSongCards}
            </div>
          ` : `
            <div class="collabSection">
              <div class="collabSectionTitle">Shared With Me</div>
              <div class="collabEmpty">
                Nothing shared with you yet. When someone shares a project or song, it'll appear here.
              </div>
            </div>
          `}

          <!-- Shared By Me -->
          <div class="collabSection">
            <div class="collabSectionTitle">Shared By Me</div>
            ${hasMyShared ? `${mySharedProjCards}${mySharedSongCards}` : `
              <div class="collabEmpty">
                You haven't shared anything yet. Tap the share button to send a project or song to a collaborator.
              </div>
            `}
          </div>

          ${pendingInvites.length ? `
            <div class="collabSection">
              <div class="collabSectionTitle">Pending Invites</div>
              ${pendingHtml}
            </div>
          ` : ""}

          <!-- Your Collaborators -->
          <div class="collabSection">
            <div class="collabSectionTitle">Your Collaborators</div>
            ${collabRows || `
              <div class="collabEmpty">
                No collaborators yet. Add names to the "Collaborators" field on any song, or send an invite!
              </div>
            `}
          </div>
        </div>

      </div>
    </div>
    <button class="sdFab" id="collabShareFab" aria-label="Share">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="24" height="24">
        <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
        <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
      </svg>
    </button>
  `;

  // Wire sidebar swipe + buttons
  _wireCollabSidebar();

  // Wire FAB → share picker
  $("#collabShareFab")?.addEventListener("click", () => {
    // Open a sheet to pick what to share
    openCollabSharePicker();
  });

  // Wire shared project taps → drill into project songs (reuses renderProjectSongs)
  activeScreenEl.querySelectorAll("[data-shared-proj]").forEach(card => {
    card.addEventListener("click", () => {
      const projId = card.getAttribute("data-shared-proj");
      const sp = sharedProjects.find(p => p.projectId === projId);
      if (!sp) return;
      navigateForward(() => {
        collabMode = true;
        projectDetailScreen = sp.projectName;
      });
    });
  });

  // Wire shared song taps → drill into song detail (reuses renderSongDetail)
  activeScreenEl.querySelectorAll("[data-shared-song]").forEach(card => {
    card.addEventListener("click", () => {
      const songId = card.getAttribute("data-shared-song");
      const ss = sharedSongs.find(s => s.song.id === songId);
      if (!ss) return;
      // Ensure the shared song is in the cache so getSong() can find it
      if (!state._sharedSongsCache) state._sharedSongsCache = [];
      if (!state._sharedSongsCache.find(s => s.id === ss.song.id)) {
        state._sharedSongsCache.push(ss.song);
      }
      navigateForward(() => {
        collabMode = true;
        selectedSongId = ss.song.id;
      });
    });
  });

  // Wire delete invite buttons
  activeScreenEl.querySelectorAll("[data-del-invite]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-del-invite");
      if (!confirm("Delete this invite?")) return;
      try {
        await deleteShareInvite(id);
        sharedData.invites = sharedData.invites.filter(i => i.id !== id);
        renderCollabContent();
        toast("Invite deleted");
      } catch (e) { toast(e.message || "Failed"); }
    });
  });

  // Wire collab row taps → filter songs
  activeScreenEl.querySelectorAll(".collabRow[data-collab-name]").forEach(row => {
    row.addEventListener("click", () => {
      const name = row.getAttribute("data-collab-name");
      if (!name) return;
      currentTab = "songs";
      songsView = "list";
      selectedSongId = null;
      drawerView = null;
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

  // Pull fresh data in background if stale
  if (sharedData.loaded) {
    refreshSharedData().then(() => {
      // Only re-render if data actually changed
    }).catch(() => {});
  }
}

// ── Friends Overlays ─────────────────────────────

function _closeFriendsOverlay() {
  if (!_friendsOverlayEl) return;
  _friendsOverlayEl.classList.remove("open");
  setTimeout(() => { _friendsOverlayEl?.remove(); _friendsOverlayEl = null; }, 300);
}

function _friendAvatarHTML(profile) {
  if (!profile) return `<div class="friendAvatar">?</div>`;
  if (profile.avatar_url) {
    const src = profile.avatar_url.startsWith("preset:")
      ? "" : escapeHtml(profile.avatar_url);
    if (src) return `<div class="friendAvatar"><img src="${src}" alt=""></div>`;
  }
  const initial = (profile.display_name || "?").charAt(0).toUpperCase();
  return `<div class="friendAvatar">${escapeHtml(initial)}</div>`;
}

function _friendMetaText(profile) {
  if (!profile) return "";
  const parts = [profile.instrument, profile.genre, profile.location].filter(Boolean);
  return parts.length ? escapeHtml(parts.join(" · ")) : "";
}

// ── Friend Requests View ──
function _collapseSidebarInAce() {
  // Patch the swipe-back ace snapshot so Collab appears with sidebar closed
  const entry = nav.appStack[nav.appStack.length - 1];
  if (!entry?.clone) return;
  const shell = entry.clone.querySelector(".collabShell");
  if (!shell) return;
  shell.classList.remove("sidebarOpen");
  const main = shell.querySelector(".collabMain");
  const side = shell.querySelector(".collabSidebar");
  if (main) { main.style.transform = ""; main.style.transition = ""; }
  if (side) { side.style.opacity = "0"; side.style.transition = ""; side.style.pointerEvents = "none"; }
}

function openFriendsRequests() {
  navigateForward(() => { overlayView = "friendRequests"; });
  _collapseSidebarInAce();
}

function renderFriendRequests() {
  setHeader("Friend Requests");
  activeScreenEl.innerHTML = `
    <div class="friendsBody" style="padding:16px 16px 40px; display:flex; flex-direction:column; gap:10px;">
      <div class="friendsEmpty"><div class="collabSpinner"></div><div style="margin-top:12px">Loading...</div></div>
    </div>
  `;

  getPendingFriendRequests().then(requests => {
    const body = activeScreenEl.querySelector(".friendsBody");
    if (!body) return;
    if (!requests.length) {
      body.innerHTML = `<div class="friendsEmpty">No pending friend requests.</div>`;
      return;
    }
    body.innerHTML = requests.map(r => `
      <div class="friendRow" data-req-id="${r.id}">
        ${_friendAvatarHTML(r.profile)}
        <div class="friendInfo">
          <div class="friendName">${escapeHtml(r.profile?.display_name || "Unknown")}</div>
          <div class="friendMeta">${_friendMetaText(r.profile)}</div>
        </div>
        <div class="friendActions">
          <button class="friendAcceptBtn" data-accept="${r.id}">Accept</button>
          <button class="friendDeclineBtn" data-decline="${r.id}">Decline</button>
        </div>
      </div>
    `).join("");

    body.querySelectorAll("[data-accept]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-accept");
        btn.textContent = "...";
        try {
          await acceptFriendRequest(id);
          const row = btn.closest(".friendRow");
          row.style.opacity = ".4";
          setTimeout(() => row.remove(), 300);
          toast("Friend request accepted!");
          _pendingFriendCount = Math.max(0, _pendingFriendCount - 1);
        } catch (err) { toast(err.message || "Failed"); }
      });
    });

    body.querySelectorAll("[data-decline]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-decline");
        btn.textContent = "...";
        try {
          await removeFriendship(id);
          const row = btn.closest(".friendRow");
          row.style.opacity = ".4";
          setTimeout(() => row.remove(), 300);
          toast("Request declined");
          _pendingFriendCount = Math.max(0, _pendingFriendCount - 1);
        } catch (err) { toast(err.message || "Failed"); }
      });
    });
  }).catch(() => {
    const body = activeScreenEl.querySelector(".friendsBody");
    if (body) body.innerHTML = `<div class="friendsEmpty">Failed to load requests.</div>`;
  });
}

// ── Friends List View ──
function openFriendsList() {
  navigateForward(() => { overlayView = "friendsList"; });
  _collapseSidebarInAce();
}

function renderFriendsList() {
  setHeader("Friends");
  activeScreenEl.innerHTML = `
    <div class="friendsBody" style="padding:16px 16px 40px; display:flex; flex-direction:column; gap:10px;">
      <div class="friendsEmpty"><div class="collabSpinner"></div><div style="margin-top:12px">Loading...</div></div>
    </div>
  `;

  getMyFriends().then(friends => {
    const body = activeScreenEl.querySelector(".friendsBody");
    if (!body) return;
    if (!friends.length) {
      body.innerHTML = `<div class="friendsEmpty">No friends yet. Swipe right on the Collab tab and tap <strong>Add</strong> to find people.</div>`;
      return;
    }
    body.innerHTML = friends.map(f => {
      const name = f.profile?.display_name || "Unknown";
      const fullName = [f.profile?.first_name, f.profile?.last_name].filter(Boolean).join(" ");
      return `
        <div class="friendRow" data-friend-id="${f.id}">
          ${_friendAvatarHTML(f.profile)}
          <div class="friendInfo">
            <div class="friendName">${escapeHtml(name)}</div>
            ${fullName ? `<div class="friendMeta">${escapeHtml(fullName)}</div>` : ""}
          </div>
          <button class="friendMsgBtn" data-msg="${f.friendId}" aria-label="Message">Message</button>
          <button class="friendRemoveBtn" data-remove="${f.id}" aria-label="Remove friend">&times;</button>
        </div>
      `;
    }).join("");

    body.querySelectorAll("[data-remove]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-remove");
        if (!confirm("Remove this friend?")) return;
        try {
          await removeFriendship(id);
          const row = btn.closest(".friendRow");
          row.style.opacity = ".4";
          setTimeout(() => row.remove(), 300);
          toast("Friend removed");
        } catch (err) { toast(err.message || "Failed"); }
      });
    });

    // Message button → open chat
    body.querySelectorAll(".friendMsgBtn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const uid = btn.getAttribute("data-msg");
        if (uid) openChat(uid);
      });
    });

    // Tap friend row → open public profile
    body.querySelectorAll(".friendRow[data-friend-id]").forEach(row => {
      row.addEventListener("click", () => {
        const fId = row.getAttribute("data-friend-id");
        const friend = friends.find(f => String(f.id) === fId);
        if (!friend) return;
        navigateForward(() => {
          friendProfileId = friend.friendId;
          overlayView = "friendProfile";
        });
      });
    });
  }).catch(() => {
    const body = activeScreenEl.querySelector(".friendsBody");
    if (body) body.innerHTML = `<div class="friendsEmpty">Failed to load friends.</div>`;
  });
}

// ── Public Profile View (friend/user profile) ──
function renderFriendProfile(userId) {
  if (!userId) return;
  setHeader("Profile");
  // Hide topbar title — the hero has its own large title (same as song detail)
  const _tbH1 = document.querySelector(".topbar h1");
  if (_tbH1) _tbH1.textContent = "";
  const appEl = document.querySelector(".app");
  appEl?.classList.add("pdActive");
  appEl?.classList.remove("pdScrolled");

  activeScreenEl.innerHTML = `
    <div class="profileWrap">
      <div class="collabSpinner" style="margin:80px auto 0"></div>
    </div>
  `;

  // Fetch profile + shared data in parallel
  Promise.all([
    supabase.from("profiles").select("id, first_name, last_name, display_name, avatar_url, location, instrument, genre, bio").eq("id", userId).maybeSingle(),
    _getSharedWithUser(userId),
  ]).then(([{ data: profile }, shared]) => {
    if (!profile) {
      activeScreenEl.innerHTML = `<div class="profileWrap"><div class="friendsEmpty">Profile not found.</div></div>`;
      return;
    }
    _renderFriendProfileContent(profile, shared);
  }).catch(() => {
    activeScreenEl.innerHTML = `<div class="profileWrap"><div class="friendsEmpty">Failed to load profile.</div></div>`;
  });
}

// Gather songs shared between current user and this friend
async function _getSharedWithUser(friendId) {
  const { projects, songs, myProjects, mySongs } = sharedData;

  // Songs they shared WITH me (from sharedData.songs and sharedData.projects)
  const fromThem = [];
  for (const sp of projects) {
    if (sp.ownerId === friendId) {
      for (const s of sp.songs) fromThem.push(s);
    }
  }
  for (const ss of songs) {
    if (ss.ownerId === friendId) fromThem.push(ss.song);
  }

  // Songs I shared WITH them (from sharedData.myProjects and sharedData.mySongs)
  const fromMe = [];
  for (const mp of myProjects) {
    if (mp.recipientId === friendId) {
      // Find matching songs from my own library
      const matching = state.songs.filter(s => (s.project || "").trim() === mp.projectName);
      fromMe.push(...matching);
    }
  }
  for (const ms of mySongs) {
    if (ms.recipientId === friendId) {
      const s = state.songs.find(x => x.id === ms.songId);
      if (s) fromMe.push(s);
    }
  }

  return { fromThem, fromMe };
}

function _renderFriendProfileContent(profile, shared) {
  // Match song detail screen setup: sticky topbar height, no padding, scrollable
  const topbarEl = document.querySelector(".topbar");
  const topbarH = topbarEl ? topbarEl.offsetHeight : 0;
  activeScreenEl.style.setProperty("--pd-topbar-h", topbarH + "px");
  activeScreenEl.style.paddingBottom = "0px";
  activeScreenEl.style.overflowY = "scroll";

  const displayName = profile.display_name || "RiffBanker";
  const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(" ");
  const avatarSrc = profile.avatar_url || null;
  const initial = (displayName || "?").charAt(0).toUpperCase();

  const { fromThem, fromMe } = shared;
  // Deduplicate
  const seenIds = new Set();
  const allSongs = [];
  for (const s of [...fromThem, ...fromMe]) {
    if (!seenIds.has(s.id)) { seenIds.add(s.id); allSongs.push(s); }
  }
  const fromThemCount = fromThem.length;
  const fromMeCount = fromMe.length;
  const totalCount = allSongs.length;

  // Hero image — use avatar as full-bleed background
  const heroImg = avatarSrc?.startsWith("http")
    ? `<img src="${avatarSrc}" style="width:100%;height:100%;object-fit:cover;display:block" onerror="this.style.display='none'" />`
    : `<div style="width:100%;height:100%;background:linear-gradient(135deg,#a78bfa,#f472b6)"></div>`;

  // Song rows builder — matches song detail compact row style
  const songRow = (s, i) => {
    const art = coverSvg(s, { lite: true });
    return `
      <div class="pdSongRow" data-fp-song="${escapeHtml(s.id)}">
        <span class="pdSongNum">${i + 1}</span>
        <div class="songThumb" aria-hidden="true">${art}</div>
        <div class="songMain">
          <div class="songTop">
            <div class="songTitleRow">
              <div class="songTitle">${escapeHtml(s.title || "Untitled")}</div>
            </div>
          </div>
          <div class="songSub">${escapeHtml(s.project || "No project")}</div>
        </div>
      </div>
    `;
  };

  const sharedWithMeRows = fromThem.length
    ? fromThem.map(songRow).join("")
    : `<div class="small" style="padding:24px 0;text-align:center;opacity:.5">Nothing shared with you yet.</div>`;
  const mySharedRows = fromMe.length
    ? fromMe.map(songRow).join("")
    : `<div class="small" style="padding:24px 0;text-align:center;opacity:.5">You haven't shared anything with ${escapeHtml(displayName)}.</div>`;
  const allRows = allSongs.length
    ? allSongs.map(songRow).join("")
    : `<div class="small" style="padding:24px 0;text-align:center;opacity:.5">No songs shared between you.</div>`;

  activeScreenEl.innerHTML = `
    <div class="pdHero">
      <div class="pdHeroBg" aria-hidden="true">${heroImg}</div>
      <div class="pdHeroContent">
        <div class="pdHeroTitle">${escapeHtml(displayName)}</div>
        <div class="pdHeroMeta">${escapeHtml(fullName || "—")} · ${totalCount} shared song${totalCount !== 1 ? "s" : ""}</div>
      </div>
    </div>

    <div class="pdActions">
      <button class="pdPlayBtn" id="fpPlay" ${!allSongs.length ? "disabled" : ""}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <button class="pdShuffleBtn" id="fpShuffle" ${!allSongs.length ? "disabled" : ""}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
      </button>
      <button class="pdMoreBtn" id="fpMore" aria-label="Options">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
      </button>
    </div>

    <div class="pdSticky">
      <div class="pdTabs">
        <button class="pdTab pdTabActive" data-fp-tab="all">All</button>
        <button class="pdTab" data-fp-tab="my-shared">My Shared</button>
        <button class="pdTab" data-fp-tab="shared-with-me">Shared With Me</button>
      </div>
      <div class="pdTabBody" id="fpTabBody">
        <div class="pdSongList">${allRows}</div>
      </div>
    </div>
  `;

  activeScreenEl.scrollTop = 0;

  // Tab switching
  const tabBody = $("#fpTabBody");
  activeScreenEl.querySelectorAll(".pdTab").forEach(tab => {
    tab.addEventListener("click", () => {
      activeScreenEl.querySelectorAll(".pdTab").forEach(t => t.classList.remove("pdTabActive"));
      tab.classList.add("pdTabActive");
      const which = tab.getAttribute("data-fp-tab");
      if (which === "shared-with-me") tabBody.innerHTML = `<div class="pdSongList">${sharedWithMeRows}</div>`;
      else if (which === "my-shared") tabBody.innerHTML = `<div class="pdSongList">${mySharedRows}</div>`;
      else tabBody.innerHTML = `<div class="pdSongList">${allRows}</div>`;
      _wireFpSongRows();
    });
  });

  // Play all shared songs
  $("#fpPlay")?.addEventListener("click", async () => {
    const items = _fpPlayableItems(allSongs);
    if (!items.length) return toast("No playable songs");
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

  // Shuffle
  $("#fpShuffle")?.addEventListener("click", async () => {
    const items = shuffleArray(_fpPlayableItems(allSongs));
    if (!items.length) return toast("No playable songs");
    state.player.nowPlaying = items[0];
    state.player.queue = items.slice(1);
    state.player.repeatQueue = items;
    state.player.shuffle = true;
    state.player.repeat = false;
    saveState();
    unlockAudioOnce();
    await playNowPlaying({ autoplay: true });
    syncMiniPlayerUI();
  });

  // More menu — share profile
  $("#fpMore")?.addEventListener("click", async () => {
    const text = `Check out ${displayName} on RiffBank!`;
    if (navigator.share) {
      try { await navigator.share({ title: "RiffBank Profile", text }); return; } catch {}
    }
    try { await navigator.clipboard.writeText(text); toast("Copied!"); } catch { toast("Couldn't copy"); }
  });

  _wireFpSongRows();

  // Fade hero + actions to black, solid topbar as user scrolls (same as song detail)
  const heroEl = activeScreenEl.querySelector(".pdHero");
  const heroBgEl = heroEl?.querySelector(".pdHeroBg");
  const heroContentEl = heroEl?.querySelector(".pdHeroContent");
  const actionsEl = activeScreenEl.querySelector(".pdActions");
  const stickyEl = activeScreenEl.querySelector(".pdSticky");
  const appEl = document.querySelector(".app");
  if (stickyEl && heroEl) {
    let maxScroll = 0;
    const FADE_PX = 200;
    requestAnimationFrame(() => {
      maxScroll = activeScreenEl.scrollHeight - activeScreenEl.clientHeight;
    });
    activeScreenEl.addEventListener("scroll", () => {
      const scrolled = activeScreenEl.scrollTop;
      if (maxScroll > 0) {
        const remaining = maxScroll - scrolled;
        const opacity = remaining < FADE_PX ? Math.max(0, remaining / FADE_PX) : 1;
        if (heroBgEl) heroBgEl.style.opacity = opacity;
        if (heroContentEl) heroContentEl.style.opacity = opacity;
        if (actionsEl) actionsEl.querySelectorAll("button").forEach(b => b.style.opacity = opacity);
      }
      if (appEl) {
        const heroBottom = heroEl.getBoundingClientRect().bottom;
        const screenTop = activeScreenEl.getBoundingClientRect().top;
        if (heroBottom - screenTop < 60) {
          appEl.classList.add("pdScrolled");
        } else {
          appEl.classList.remove("pdScrolled");
        }
      }
    }, { passive: true });
  }
}

// Build playable queue items from shared songs
function _fpPlayableItems(songs) {
  const items = [];
  for (const s of songs) {
    const active = (s.versions || []).find(v => v.isActive) || (s.versions || [])[0];
    if (active && active.audioPath) {
      items.push({ songId: s.id, versionId: active.id, title: s.title, project: s.project, label: active.label, audioPath: active.audioPath });
    }
  }
  return items;
}

// Wire click on song rows to drill into song detail
function _wireFpSongRows() {
  document.querySelectorAll("[data-fp-song]").forEach(row => {
    row.addEventListener("click", () => {
      const songId = row.getAttribute("data-fp-song");
      // Check if it's a shared song (in sharedData) or a local song
      const localSong = state.songs.find(s => s.id === songId);
      const sharedSong = sharedData.songs.find(ss => ss.song.id === songId)?.song
        || sharedData.projects.flatMap(sp => sp.songs).find(s => s.id === songId);
      if (localSong) {
        navigateForward(() => {
          selectedSongId = songId;
          selectedVersionId = null;
        });
      } else if (sharedSong) {
        // Temporarily inject into state for viewing
        if (!state._sharedSongsCache) state._sharedSongsCache = {};
        state._sharedSongsCache[songId] = sharedSong;
        navigateForward(() => {
          selectedSongId = songId;
          selectedVersionId = null;
          collabMode = true;
        });
      }
    });
  });
}

// ── Messages ──────────────────────────────────────

function openMessages() {
  requestNotificationPermission();
  navigateForward(() => { overlayView = "messages"; });
  _collapseSidebarInAce();
}

function openChat(userId) {
  navigateForward(() => { friendProfileId = userId; overlayView = "chat"; });
}

let _msgPollTimer = null;

function renderMessages() {
  setHeader("Messages");
  activeScreenEl.innerHTML = `
    <div class="msgBody" style="padding:16px 16px 40px; display:flex; flex-direction:column; gap:0;">
      <div class="friendsEmpty"><div class="collabSpinner"></div><div style="margin-top:12px">Loading...</div></div>
    </div>
  `;

  getConversations().then(convos => {
    const body = activeScreenEl.querySelector(".msgBody");
    if (!body) return;
    if (!convos.length) {
      body.innerHTML = `<div class="friendsEmpty">No messages yet. Tap a friend's <strong>Message</strong> button to start a conversation.</div>`;
      return;
    }
    _renderConvoList(body, convos);
  }).catch(() => {
    const body = activeScreenEl.querySelector(".msgBody");
    if (body) body.innerHTML = `<div class="friendsEmpty">Failed to load messages.</div>`;
  });
}

function _renderConvoList(body, convos) {
  body.innerHTML = convos.map(c => {
    const name = c.profile?.display_name || "Unknown";
    const avatar = _friendAvatarHTML(c.profile);
    const preview = c.body?.length > 40 ? c.body.slice(0, 40) + "..." : (c.body || "");
    const prefix = c.isFromMe ? "You: " : "";
    const unread = c.unreadCount ? `<span class="msgUnread">${c.unreadCount}</span>` : "";
    const time = _relativeTime(c.created_at);
    return `
      <div class="msgConvoRow" data-chat-user="${c.partnerId}">
        ${avatar}
        <div class="msgConvoInfo">
          <div class="msgConvoTop">
            <div class="msgConvoName${c.unreadCount ? " msgConvoBold" : ""}">${escapeHtml(name)}</div>
            <div class="msgConvoTime">${time}</div>
          </div>
          <div class="msgConvoPreview${c.unreadCount ? " msgConvoBold" : ""}">
            ${escapeHtml(prefix + preview)}
            ${unread}
          </div>
        </div>
      </div>
    `;
  }).join("");

  body.querySelectorAll("[data-chat-user]").forEach(row => {
    row.addEventListener("click", () => {
      const userId = row.getAttribute("data-chat-user");
      openChat(userId);
    });
  });
}

function _relativeTime(isoStr) {
  if (!isoStr) return "";
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return mins + "m";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h";
  const days = Math.floor(hrs / 24);
  if (days < 7) return days + "d";
  return new Date(isoStr).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Chat View ──

function renderChat(userId) {
  if (!userId) return;
  setHeader("Chat");

  activeScreenEl.innerHTML = `
    <div class="chatWrap">
      <div class="chatMessages" id="chatMessages">
        <div class="collabSpinner" style="margin:40px auto"></div>
      </div>
      <div class="chatInputBar">
        <input class="chatInput" id="chatInput" type="text" placeholder="Message..." autocomplete="off" autocorrect="off" />
        <button class="chatSendBtn" id="chatSend" aria-label="Send">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
    </div>
  `;

  // Fetch partner profile for header
  supabase.from("profiles").select("display_name, avatar_url").eq("id", userId).maybeSingle().then(({ data: prof }) => {
    if (prof?.display_name) setHeader(prof.display_name);
  });

  const messagesEl = $("#chatMessages");
  const inputEl = $("#chatInput");
  let _chatUserId = userId;

  // Load messages
  async function loadMessages() {
    const msgs = await getMessages(_chatUserId);
    if (!messagesEl) return;
    await markMessagesRead(_chatUserId);
    syncMessageBadges();

    if (!msgs.length) {
      messagesEl.innerHTML = `<div class="chatEmpty">No messages yet. Say hello!</div>`;
    } else {
      _renderChatMessages(messagesEl, msgs);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  loadMessages();

  // Poll for new messages every 5s
  if (_msgPollTimer) clearInterval(_msgPollTimer);
  _msgPollTimer = setInterval(async () => {
    if (overlayView !== "chat" || friendProfileId !== _chatUserId) {
      clearInterval(_msgPollTimer);
      _msgPollTimer = null;
      return;
    }
    const msgs = await getMessages(_chatUserId);
    if (msgs.length && messagesEl) {
      const wasAtBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
      _renderChatMessages(messagesEl, msgs);
      if (wasAtBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
      markMessagesRead(_chatUserId);
    }
  }, 5000);

  // Send message
  async function doSend() {
    const text = inputEl?.value?.trim();
    if (!text) return;
    inputEl.value = "";
    const msg = await sendMessage(_chatUserId, text);
    if (msg) {
      const msgs = await getMessages(_chatUserId);
      _renderChatMessages(messagesEl, msgs);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else {
      toast("Failed to send");
    }
  }

  $("#chatSend")?.addEventListener("click", doSend);
  inputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
  });

  // Focus input after render
  setTimeout(() => inputEl?.focus(), 350);
}

async function _getCurrentUserId() {
  const { data } = await supabase.auth.getUser();
  return data?.user?.id || null;
}

let _cachedCurrentUserId = null;

function _renderChatMessages(container, msgs) {
  // Get current user ID synchronously from cache, or kick off async
  if (!_cachedCurrentUserId) {
    _getCurrentUserId().then(id => {
      _cachedCurrentUserId = id;
      _renderChatMessages(container, msgs);
    });
    return;
  }
  const uid = _cachedCurrentUserId;

  container.innerHTML = msgs.map(m => {
    const isMine = m.sender_id === uid;
    return `<div class="chatBubble ${isMine ? "chatBubbleMine" : "chatBubbleTheirs"}">${escapeHtml(m.body)}</div>`;
  }).join("");
}

// Wire "Message" buttons on friend list to open chat
function _wireFriendMsgButtons() {
  document.querySelectorAll(".friendMsgBtn[data-msg]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openChat(btn.getAttribute("data-msg"));
    });
  });
}

// ── Invite Share Screen (Venmo-style QR + share) ──
async function openInviteShareScreen() {
  const inviteUrl = `${location.origin}/invite.html`;
  const displayName = state.settings?.displayName || "RiffBank User";
  const avatarUrl = state.settings?.profileAvatarUrl || "";
  const initial = displayName.charAt(0).toUpperCase();

  const overlay = document.createElement("div");
  overlay.className = "inviteShareScreen";
  overlay.innerHTML = `
    <div class="issHeader">
      <button class="issCloseBtn" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="24" height="24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>

    <div class="issBody">
      <div class="issAvatar">
        ${avatarUrl && !avatarUrl.startsWith("preset:")
          ? `<img src="${escapeHtml(avatarUrl)}" alt="">`
          : escapeHtml(initial)
        }
      </div>
      <div class="issName">${escapeHtml(displayName)}</div>
      <div class="issSub">Scan to add me on RiffBank</div>

      <div class="issQrCard">
        <canvas id="issQrCanvas" width="220" height="220"></canvas>
      </div>

      <div class="issUrl">${escapeHtml(inviteUrl)}</div>
    </div>

    <div class="issActions">
      <button class="issActionBtn" id="issCopyBtn">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        Copy
      </button>
      <button class="issActionBtn" id="issShareBtn">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
        Share
      </button>
    </div>
  `;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("open"));

  // Close
  const close = () => {
    overlay.classList.remove("open");
    setTimeout(() => overlay.remove(), 300);
  };
  overlay.querySelector(".issCloseBtn").addEventListener("click", close);

  // Generate QR code on canvas
  try {
    const { default: QRCode } = await import("https://esm.sh/qrcode@1.5.4");
    const canvas = overlay.querySelector("#issQrCanvas");
    await QRCode.toCanvas(canvas, inviteUrl, {
      width: 220,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
      errorCorrectionLevel: "M",
    });
  } catch (e) {
    console.warn("QR generation failed:", e);
    const card = overlay.querySelector(".issQrCard");
    card.innerHTML = `<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px">QR code unavailable</div>`;
  }

  // Copy link
  overlay.querySelector("#issCopyBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      const btn = overlay.querySelector("#issCopyBtn");
      btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
      setTimeout(() => {
        btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy`;
      }, 2000);
    } catch {
      toast("Couldn't copy");
    }
  });

  // Share
  overlay.querySelector("#issShareBtn").addEventListener("click", async () => {
    const msg = `Join me on RiffBank! ${inviteUrl}`;
    if (navigator.share) {
      try { await navigator.share({ title: "Join RiffBank", text: msg, url: inviteUrl }); } catch {}
    } else {
      await navigator.clipboard.writeText(inviteUrl);
      toast("Link copied!");
    }
  });
}

// ── Add Friend View ──
function openAddFriend() {
  navigateForward(() => { overlayView = "addFriend"; });
  _collapseSidebarInAce();
}

function renderAddFriend() {
  setHeader("Add Friend");
  activeScreenEl.innerHTML = `
    <div class="friendSearchWrap" style="padding:16px;">
      <button class="friendInviteBtn" id="friendInvitePhone">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
        Share a Link
      </button>
      <input class="friendSearchInput" type="text" placeholder="Search by name..." autocomplete="off" />
    </div>
    <div class="friendsBody" style="padding:0 16px 40px; display:flex; flex-direction:column; gap:10px;">
      <div class="friendsEmpty">Search for someone to add as a friend.</div>
    </div>
  `;

  activeScreenEl.querySelector("#friendInvitePhone")?.addEventListener("click", () => {
    openInviteShareScreen();
  });

  const input = activeScreenEl.querySelector(".friendSearchInput");
  const body = activeScreenEl.querySelector(".friendsBody");
  let searchTimer = null;

  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) {
      body.innerHTML = `<div class="friendsEmpty">Search for someone to add as a friend.</div>`;
      return;
    }
    if (q.length < 2) return;
    searchTimer = setTimeout(async () => {
      body.innerHTML = `<div class="friendsEmpty"><div class="collabSpinner"></div></div>`;
      try {
        const results = await searchUsers(q);
        if (!results.length) {
          body.innerHTML = `<div class="friendsEmpty">No users found for "${escapeHtml(q)}"</div>`;
          return;
        }
        body.innerHTML = results.map(u => `
          <div class="friendRow" data-add-uid="${u.id}">
            ${_friendAvatarHTML(u)}
            <div class="friendInfo">
              <div class="friendName">${escapeHtml(u.display_name || "Unknown")}</div>
              <div class="friendMeta">${_friendMetaText(u)}</div>
            </div>
            <button class="friendAcceptBtn" data-send="${u.id}">Add</button>
          </div>
        `).join("");

        body.querySelectorAll("[data-send]").forEach(btn => {
          btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const uid = btn.getAttribute("data-send");
            btn.textContent = "...";
            btn.disabled = true;
            try {
              const result = await sendFriendRequest(uid);
              if (result.status === "accepted") {
                btn.textContent = "Friends";
                btn.style.background = "rgba(34,197,94,.2)";
                btn.style.color = "#22c55e";
              } else {
                btn.textContent = "Sent!";
                btn.style.background = "rgba(255,255,255,.08)";
                btn.style.color = "var(--muted)";
              }
            } catch (err) {
              btn.textContent = "Add";
              btn.disabled = false;
              toast(err.message || "Failed");
            }
          });
        });
      } catch (err) {
        body.innerHTML = `<div class="friendsEmpty">Search failed. Try again.</div>`;
      }
    }, 300);
  });

  setTimeout(() => input.focus(), 350);
}

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
          <div class="profHeroStats">${songCount} song${songCount !== 1 ? "s" : ""} · ${projectCount} project${projectCount !== 1 ? "s" : ""}</div>
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
    try { await signOut(); location.reload(); } catch (e) { toast(e.message || "Sign out failed"); }
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

function renderAlerts() {
  setHeader("Alerts");

  // Mark all inbox notifications as read when viewing
  markNotificationsRead();

  const statusIcon = (s) => {
    if (s === "done") return `<span style="color:#22c55e">&#10003;</span>`;
    if (s === "failed") return `<span style="color:#f43f5e">&#10007;</span>`;
    return `<span class="alertSpinner"></span>`;
  };

  const notifIcon = (type) => {
    if (type === "share") return `<span style="color:#a855f7"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg></span>`;
    return `<span style="color:#888">&#x1F514;</span>`;
  };

  const timeAgo = (ts) => {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  // Notification inbox items (shares, etc.)
  const notifications = _loadNotifications();
  const notifHTML = notifications.length
    ? notifications.map(n => `
      <div class="alertRow${n.read ? "" : " alertUnread"}">
        <div class="alertIcon">${notifIcon(n.type)}</div>
        <div class="alertBody">
          <div class="alertTitle">${escapeHtml(n.title)}</div>
          <div class="alertMsg">${escapeHtml(n.body)}</div>
        </div>
        <div class="alertTime">${timeAgo(n.ts)}</div>
      </div>
    `).join("")
    : "";

  // Activity log items (uploads, syncs)
  const activityHTML = activityLog.length
    ? activityLog.map(a => `
      <div class="alertRow">
        <div class="alertIcon">${statusIcon(a.status)}</div>
        <div class="alertBody">
          <div class="alertTitle">${escapeHtml(a.songTitle)}</div>
          <div class="alertMsg">${escapeHtml(a.message)}</div>
        </div>
        <div class="alertTime">${timeAgo(a.ts)}</div>
      </div>
    `).join("")
    : "";

  const hasContent = notifications.length || activityLog.length;

  activeScreenEl.innerHTML = `
    <div style="padding:16px">
      ${notifications.length ? `<div class="alertSectionLabel">Notifications</div>${notifHTML}` : ""}
      ${activityLog.length ? `<div class="alertSectionLabel" style="${notifications.length ? "margin-top:20px" : ""}">Activity</div>${activityHTML}` : ""}
      ${!hasContent ? `<div style="padding:40px 20px;text-align:center;color:#666">No notifications yet</div>` : ""}
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
        setActiveScreen("projectDetail");
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

// ── Lyrics view ──
let lyricsQuery = "";
let lyricsEditSongId = null; // when set, we show the edit view

function renderLyricsScratch() {
  if (lyricsEditSongId) return renderLyricsEdit(lyricsEditSongId);

  overlayView = "lyrics";
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
        lyricsEditSongId = sid;
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
        lyricsEditSongId = song.id;
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
    lyricsEditSongId = null;
    return renderLyricsScratch();
  }

  overlayView = "lyrics";
  lyricsEditSongId = songId;
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
      lyricsEditSongId = sid;
      navigateForward(() => renderLyricsEdit(sid));
    });
  });

  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
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
      navigateForward(() => {
        currentTab = "songs";
        selectedSongId = el.getAttribute("data-open-song");
      });
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

// Auto-generate art for a newly created song (fire-and-forget)
function autoGenerateArt(song) {
  if (song.coverImageUrl || song.coverPath) return;
  generatingArtSongs.add(song.id);
  coverCache.clear();
  render();
  generateArtForSong(song)
    .then(() => { coverCache.clear(); saveState(); })
    .catch(e => console.warn("Auto art generation failed:", e))
    .finally(() => { generatingArtSongs.delete(song.id); coverCache.clear(); render(); });
}

// Global handler: refresh cover image from cloud when cached URL expires
window._refreshCoverFromCloud = async (songId, coverPath, imgEl) => {
  let url = await getCoverBlobUrl(coverPath);
  if (!url) {
    const blob = await supabaseFetchCoverBlob(coverPath);
    if (blob) {
      await putCoverBlob(coverPath, blob);
      url = URL.createObjectURL(blob);
      coverUrlCache.set(coverPath, url);
    }
  }
  if (url && imgEl) {
    imgEl.onerror = () => {
      imgEl.onerror = null;
      window._clearBrokenCover && window._clearBrokenCover(songId, imgEl);
    };
    imgEl.src = url;
    const song = state.songs.find(s => s.id === songId);
    if (song) {
      song.coverImageUrl = url;
      coverCache.clear();
      saveState();
    }
  } else if (imgEl) {
    const song = state.songs.find(s => s.id === songId);
    if (song) {
      song.coverImageUrl = null;
      coverCache.clear();
    }
    if (imgEl.parentElement) {
      imgEl.parentElement.innerHTML = coverSvg(song || { id: songId, title: "", project: "", genre: "" }, { lite: true });
    }
  }
};
// Fallback: if cover URL is broken (expired URL, no cloud backup), clear it so SVG art shows
window._clearBrokenCover = (songId, imgEl) => {
  const song = state.songs.find(s => s.id === songId);
  if (song) {
    song.coverImageUrl = null;
    coverCache.clear();
    saveState();
  }
  if (imgEl?.parentElement) {
    imgEl.parentElement.innerHTML = coverSvg(song || { id: songId, title: "", project: "", genre: "" }, { lite: true });
  }
};
window._refreshUserCoverFromCloud = async (songId, userCoverPath, imgEl) => {
  let url = await getCoverBlobUrl(userCoverPath);
  if (!url) {
    const blob = await supabaseFetchCoverBlob(userCoverPath);
    if (blob) {
      await putCoverBlob(userCoverPath, blob);
      url = URL.createObjectURL(blob);
      coverUrlCache.set(userCoverPath, url);
    }
  }
  if (url && imgEl) {
    imgEl.onerror = () => {
      imgEl.onerror = null;
      window._clearBrokenUserCover && window._clearBrokenUserCover(songId, imgEl);
    };
    imgEl.src = url;
    const song = state.songs.find(s => s.id === songId);
    if (song) {
      song.userCoverImageUrl = url;
      coverCache.clear();
      saveState();
    }
  } else if (imgEl) {
    const song = state.songs.find(s => s.id === songId);
    if (song) {
      song.coverSource = "ai"; // fall back to AI art
      song.userCoverImageUrl = null;
      coverCache.clear();
      saveState();
    }
    if (imgEl.parentElement) {
      imgEl.parentElement.innerHTML = coverSvg(song || { id: songId, title: "", project: "", genre: "" }, { lite: true });
    }
  }
};
window._clearBrokenUserCover = (songId, imgEl) => {
  const song = state.songs.find(s => s.id === songId);
  if (song) {
    song.coverSource = "ai";
    song.userCoverImageUrl = null;
    coverCache.clear();
    saveState();
  }
  if (imgEl?.parentElement) {
    imgEl.parentElement.innerHTML = coverSvg(song || { id: songId, title: "", project: "", genre: "" }, { lite: true });
  }
};
// ── Cover crop overlay ──────────────────────────────
function openCoverCropOverlay(songId) {
  const song = getSong(songId);
  if (!song) return;

  // Show action sheet: Choose from Gallery / Take Photo
  document.querySelectorAll(".actionSheetBackdrop, .actionSheet").forEach(el => el.remove());

  const backdrop = document.createElement("div");
  backdrop.className = "actionSheetBackdrop";
  const sheet = document.createElement("div");
  sheet.className = "actionSheet";
  sheet.innerHTML = `
    <div class="actionSheetHeader">Cover Photo</div>
    <button class="actionSheetBtn" data-act="gallery">Choose from Gallery</button>
    <button class="actionSheetBtn" data-act="camera">Take Photo</button>
    <button class="actionSheetBtn" data-act="cancel">Cancel</button>
  `;
  document.body.append(backdrop, sheet);
  requestAnimationFrame(() => { backdrop.classList.add("show"); sheet.classList.add("show"); });

  function dismiss() {
    backdrop.classList.remove("show");
    sheet.classList.remove("show");
    setTimeout(() => { backdrop.remove(); sheet.remove(); }, 300);
  }

  function pickFile(useCamera) {
    dismiss();
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    if (useCamera) fileInput.setAttribute("capture", "environment");
    fileInput.style.display = "none";
    document.body.appendChild(fileInput);

    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      fileInput.remove();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => showCropOverlay(songId, reader.result);
      reader.readAsDataURL(file);
    });

    fileInput.click();
  }

  sheet.querySelector('[data-act="gallery"]').addEventListener("click", () => pickFile(false));
  sheet.querySelector('[data-act="camera"]').addEventListener("click", () => pickFile(true));
  sheet.querySelector('[data-act="cancel"]').addEventListener("click", dismiss);
  backdrop.addEventListener("click", dismiss);
}

function showCropOverlay(songId, imageSrc) {
  // Remove any existing overlay
  document.querySelector(".cropOverlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "cropOverlay";
  overlay.innerHTML = `
    <div class="cropHeader">
      <button class="cropCancel">Cancel</button>
      <span class="cropTitle">Crop Cover</span>
      <button class="cropDone">Done</button>
    </div>
    <div class="cropArea">
      <div class="cropFrame">
        <img class="cropImg" src="${imageSrc}" draggable="false" />
      </div>
    </div>
    <div class="cropControls">
      <svg class="cropZoomIcon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
      <input type="range" class="cropZoom" min="100" max="400" value="100" />
      <svg class="cropZoomIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
    </div>
  `;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("cropVisible"));

  const img = overlay.querySelector(".cropImg");
  const frame = overlay.querySelector(".cropFrame");
  const zoomSlider = overlay.querySelector(".cropZoom");

  // baseScale: fits image to "cover" the square frame. userZoom: extra zoom [1..4]
  let baseScale = 1;
  let userZoom = 1;
  let tx = 0, ty = 0;
  let isDragging = false;
  let startX = 0, startY = 0, startTx = 0, startTy = 0;

  function totalScale() { return baseScale * userZoom; }

  function applyTransform() {
    const s = totalScale();
    img.style.width = img.naturalWidth + "px";
    img.style.height = img.naturalHeight + "px";
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  }

  function initLayout() {
    const fw = frame.clientWidth;
    const fh = frame.clientHeight;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!nw || !nh || !fw || !fh) return;
    baseScale = Math.max(fw / nw, fh / nh);
    tx = (fw - nw * totalScale()) / 2;
    ty = (fh - nh * totalScale()) / 2;
    applyTransform();
  }

  function clampPosition() {
    const fw = frame.clientWidth;
    const fh = frame.clientHeight;
    const s = totalScale();
    const imgW = img.naturalWidth * s;
    const imgH = img.naturalHeight * s;
    // Image must always cover the frame
    if (imgW >= fw) {
      tx = Math.min(0, Math.max(fw - imgW, tx));
    } else {
      tx = (fw - imgW) / 2;
    }
    if (imgH >= fh) {
      ty = Math.min(0, Math.max(fh - imgH, ty));
    } else {
      ty = (fh - imgH) / 2;
    }
  }

  img.onload = () => initLayout();
  if (img.complete && img.naturalWidth) initLayout();

  // Zoom slider
  zoomSlider.addEventListener("input", () => {
    const oldZoom = userZoom;
    userZoom = parseInt(zoomSlider.value) / 100;
    // Zoom toward center of frame
    const fw = frame.clientWidth;
    const fh = frame.clientHeight;
    const ratio = userZoom / oldZoom;
    tx = fw / 2 - ratio * (fw / 2 - tx);
    ty = fh / 2 - ratio * (fh / 2 - ty);
    clampPosition();
    applyTransform();
  });

  // Mouse/touch drag
  function onPointerDown(e) {
    if (e.touches && e.touches.length > 1) return;
    isDragging = true;
    const pt = e.touches ? e.touches[0] : e;
    startX = pt.clientX;
    startY = pt.clientY;
    startTx = tx;
    startTy = ty;
    e.preventDefault();
  }
  function onPointerMove(e) {
    if (!isDragging) return;
    if (e.touches && e.touches.length > 1) return;
    const pt = e.touches ? e.touches[0] : e;
    tx = startTx + (pt.clientX - startX);
    ty = startTy + (pt.clientY - startY);
    clampPosition();
    applyTransform();
    e.preventDefault();
  }
  function onPointerUp() {
    isDragging = false;
  }

  frame.addEventListener("mousedown", onPointerDown);
  frame.addEventListener("touchstart", onPointerDown, { passive: false });
  window.addEventListener("mousemove", onPointerMove);
  window.addEventListener("touchmove", onPointerMove, { passive: false });
  window.addEventListener("mouseup", onPointerUp);
  window.addEventListener("touchend", onPointerUp);

  // Pinch to zoom
  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  frame.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      isDragging = false;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchStartDist = Math.hypot(dx, dy);
      pinchStartZoom = userZoom;
    }
  }, { passive: true });
  frame.addEventListener("touchmove", (e) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const oldZoom = userZoom;
      userZoom = Math.max(1, Math.min(4, pinchStartZoom * (dist / pinchStartDist)));
      zoomSlider.value = Math.round(userZoom * 100);
      // Zoom toward pinch center
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const frameRect = frame.getBoundingClientRect();
      const px = midX - frameRect.left;
      const py = midY - frameRect.top;
      const ratio = userZoom / oldZoom;
      tx = px - ratio * (px - tx);
      ty = py - ratio * (py - ty);
      clampPosition();
      applyTransform();
    }
  }, { passive: true });

  function cleanup() {
    window.removeEventListener("mousemove", onPointerMove);
    window.removeEventListener("touchmove", onPointerMove);
    window.removeEventListener("mouseup", onPointerUp);
    window.removeEventListener("touchend", onPointerUp);
    overlay.classList.remove("cropVisible");
    setTimeout(() => overlay.remove(), 250);
  }

  // Cancel
  overlay.querySelector(".cropCancel").addEventListener("click", cleanup);

  // Done — crop and save
  overlay.querySelector(".cropDone").addEventListener("click", async () => {
    const fw = frame.clientWidth;
    const fh = frame.clientHeight;
    const s = totalScale();

    const canvas = document.createElement("canvas");
    const SIZE = 800; // output resolution
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");

    // tx, ty = pixel offset of scaled image top-left relative to frame top-left
    const sx = -tx / s;
    const sy = -ty / s;
    const sw = fw / s;
    const sh = fh / s;

    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, SIZE, SIZE);

    canvas.toBlob(async (blob) => {
      if (!blob) { cleanup(); return; }

      const song = getSong(songId);
      if (!song) { cleanup(); return; }

      // Save to IndexedDB + Supabase
      const userCoverPath = `user_${song.id}_cover.jpg`;
      await putCoverBlob(userCoverPath, blob);
      const url = URL.createObjectURL(blob);
      coverUrlCache.set(userCoverPath, url);

      song.userCoverImageUrl = url;
      song.userCoverPath = userCoverPath;
      song.coverSource = "user";
      coverCache.clear();
      saveState();
      render();
      toast("Cover photo saved");

      // Upload to Supabase in background and store the cloud path
      supabaseUploadCover({ blob, songId: song.id, pathOverride: `user_cover` }).then((result) => {
        if (result?.success && result.coverPath) {
          // Also cache under the Supabase storage path so pull can find it
          putCoverBlob(result.coverPath, blob).catch(() => {});
          coverUrlCache.set(result.coverPath, url);
          // Update song's userCoverPath to the cloud path for cross-device sync
          song.userCoverPath = result.coverPath;
          saveState();
          supabaseSyncStateSoon(state);
        }
      }).catch(() => {});

      cleanup();
    }, "image/jpeg", 0.92);
  });
}

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

async function generateArtForSong(song) {
  const session = await getSession();
  if (!session?.access_token) throw new Error("Sign in to generate art");
  const prompt = buildArtPrompt(song);
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 20000);
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/generate-art`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ input: { prompt, aspect_ratio: "1:1" } }),
      signal: ac.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Art generation timed out — try again");
    throw e;
  } finally {
    clearTimeout(timeout);
  }
  const data = await res.json();
  console.log("[ArtGen] Worker response:", res.status, data);
  if (!res.ok) throw new Error(data.detail || data.title || JSON.stringify(data));
  if (!data.output) throw new Error("No image returned");
  let url = Array.isArray(data.output) ? data.output[0] : data.output;
  console.log("[ArtGen] Image URL:", url);

  // Download image and upload to Supabase Storage for persistence
  try {
    const imgAc = new AbortController();
    const imgTimeout = setTimeout(() => imgAc.abort(), 15000);
    let imgRes;
    try {
      imgRes = await fetch(url, { signal: imgAc.signal });
    } finally {
      clearTimeout(imgTimeout);
    }
    if (imgRes.ok) {
      const blob = await imgRes.blob();
      const coverResult = await Promise.race([
        supabaseUploadCover({ blob, songId: song.id }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Cover upload timed out")), 15000)),
      ]);
      if (coverResult.success) {
        song.coverPath = coverResult.coverPath;
        await putCoverBlob(coverResult.coverPath, blob);
        const cachedUrl = URL.createObjectURL(blob);
        coverUrlCache.set(coverResult.coverPath, cachedUrl);
        url = cachedUrl;
      }
    }
  } catch (e) {
    console.warn("Cover art cloud upload failed (art still saved as URL):", e);
  }

  song.coverImageUrl = url;
  song.updatedAt = nowStamp();
}

async function startBulkGenArt(onlyMissing) {
  if (bulkArtState.running) { toast("Bulk art generation already in progress"); return; }

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
      await generateArtForSong(song);
      succeeded++;
    } catch (e) {
      console.error(`Art gen failed for "${song.title}":`, e);
      lastError = e.message;
    }
    generatingArtSongs.delete(song.id);
    coverCache.clear();
    bulkArtState.done++;
    saveState();
    // Live-update the song card art if songs list is visible
    const cardArtEl = document.querySelector(`.songCard[data-id="${song.id}"] .songCardArt`);
    if (cardArtEl) cardArtEl.innerHTML = coverSvg(song, { lite: true });
    // Also update song detail hero if viewing this song
    const heroArt = document.querySelector(".albumArt");
    if (heroArt && selectedSongId === song.id) heroArt.innerHTML = coverSvg(song);
    // Live-update project row thumbnail if projects view is visible
    if (song.project) {
      const projThumb = document.querySelector(`[data-proj-thumb="${CSS.escape(song.project.trim())}"]`);
      if (projThumb) projThumb.innerHTML = coverSvg(song, { lite: true });
    }
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
  const key = `${song.id}|${song.title}|${song.project}|${song.genre}|${song.coverImageUrl || ""}|${song.userCoverImageUrl || ""}|${song.coverSource || "ai"}|${forceLite ? "lite" : "full"}`;

  if (generatingArtSongs.has(song.id)) {
    return `<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:linear-gradient(135deg,#1a1a2e,#16213e);border-radius:inherit;color:#888;font-size:13px;gap:8px">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 2s linear infinite">
        <path d="M12 2a10 10 0 0 1 10 10" /><style>@keyframes spin{to{transform:rotate(360deg)}}</style>
      </svg>
      <span style="opacity:.6">Generating…</span>
    </div>`;
  }

  if (coverCache.has(key)) return coverCache.get(key);

  // User-uploaded cover takes priority when coverSource is "user"
  if (song.coverSource === "user" && song.userCoverImageUrl) {
    const errHandler = song.userCoverPath
      ? ` onerror="this.onerror=null;window._refreshUserCoverFromCloud&&window._refreshUserCoverFromCloud('${escapeHtml(song.id)}','${escapeHtml(song.userCoverPath)}',this)"`
      : ` onerror="this.onerror=null;window._clearBrokenUserCover&&window._clearBrokenUserCover('${escapeHtml(song.id)}',this)"`;

    const img = `<img src="${escapeHtml(song.userCoverImageUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block" decoding="sync" alt=""${errHandler}>`;
    coverCache.set(key, img);
    return img;
  }

  // Resolve user cover from cache/cloud if path exists but URL doesn't
  if (song.coverSource === "user" && !song.userCoverImageUrl && !song._userCoverResolving) {
    song._userCoverResolving = true;
    (async () => {
      const localKey = `user_${song.id}_cover.jpg`;
      let url = song.userCoverPath ? await getCoverBlobUrl(song.userCoverPath) : null;
      if (!url) url = await getCoverBlobUrl(localKey);
      if (!url && song.userCoverPath) {
        const blob = await supabaseFetchCoverBlob(song.userCoverPath).catch(() => null);
        if (blob) {
          await putCoverBlob(song.userCoverPath, blob);
          url = URL.createObjectURL(blob);
          coverUrlCache.set(song.userCoverPath, url);
        }
      }
      song._userCoverResolving = false;
      if (url) {
        song.userCoverImageUrl = url;
        coverCache.clear();
        saveState();
        render();
      }
    })().catch(() => { song._userCoverResolving = false; });
  }

  if (song.coverImageUrl) {
    const errHandler = song.coverPath
      ? ` onerror="this.onerror=null;window._refreshCoverFromCloud&&window._refreshCoverFromCloud('${escapeHtml(song.id)}','${escapeHtml(song.coverPath)}',this)"`
      : ` onerror="this.onerror=null;window._clearBrokenCover&&window._clearBrokenCover('${escapeHtml(song.id)}',this)"`;

    const img = `<img src="${escapeHtml(song.coverImageUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block" decoding="sync" alt=""${errHandler}>`;
    coverCache.set(key, img);
    return img;
  }

  // coverImageUrl is missing but cloud path exists — resolve from IDB cache or Supabase
  if (song.coverPath && !song._coverResolving) {
    song._coverResolving = true;
    (async () => {
      let url = await getCoverBlobUrl(song.coverPath);
      if (!url) {
        const blob = await supabaseFetchCoverBlob(song.coverPath);
        if (blob) {
          await putCoverBlob(song.coverPath, blob);
          url = URL.createObjectURL(blob);
          coverUrlCache.set(song.coverPath, url);
        }
      }
      song._coverResolving = false;
      if (url) {
        song.coverImageUrl = url;
        coverCache.clear();
        saveState();
        render();
      }
    })().catch(() => { song._coverResolving = false; });
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
  const appEl = document.querySelector(".app");
  appEl?.classList.add("collapseTitle");
  // Hide h1 immediately so it doesn't flash centered during slide transition
  const h1 = appEl?.querySelector(".titleblock h1");
  if (h1) h1.style.opacity = "0";

  // Merge own songs + shared songs
  const sharedSongs = (sharedData.songs || []).map(ss => ({ ...ss.song, _shared: true, _sharedBy: ss.ownerName || "Someone" }));
  const sharedProjectSongs = (sharedData.projects || []).flatMap(sp =>
    (sp.songs || []).map(s => ({ ...s, _shared: true, _sharedBy: sp.ownerName || "Someone" }))
  );
  const allSharedSongs = [...sharedSongs, ...sharedProjectSongs].filter(s => !state.songs.find(own => own.id === s.id));

  // Ensure shared songs are in the lookup cache so getSong() finds them
  if (!state._sharedSongsCache) state._sharedSongsCache = [];
  for (const s of allSharedSongs) {
    if (!state._sharedSongsCache.find(c => c.id === s.id)) {
      state._sharedSongsCache.push(s);
    }
  }

  const ownSongs = state.songs.map(s => ({ ...s, _shared: false }));
  const allSongs = [...ownSongs, ...allSharedSongs];

  const ownerFilter = songsListState.ownerFilter || "all";
  const songs = ownerFilter === "mine" ? ownSongs
    : ownerFilter === "shared" ? allSharedSongs
    : allSongs;

  const projects = Array.from(
    new Set([
      ...(state.settings?.defaultProject ? [state.settings.defaultProject.trim()] : []),
      ...songs.map((s) => (s.project || "").trim()).filter(Boolean),
    ])
  ).sort((a, b) => a.localeCompare(b));

  const ownerLabels = { all: "All", mine: "Mine", shared: "Shared" };
  const chevronDown = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

  activeScreenEl.innerHTML = `
    <div class="songsTitleRow">
      <div class="songsPageTitle">Songs</div>
      <div class="ownerDropWrap">
        <button class="ownerDropBtn">${ownerLabels[ownerFilter]}${chevronDown}</button>
      </div>
    </div>
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
    <button class="sdFab" id="songsAddFab" aria-label="Add song">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
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

      const cardHtml = (s, span) => {
        const vCount = s.versions?.length || 0;
        const spanStyle = span > 1 ? ` style="grid-column:span ${span}"` : "";
        return `
          <div class="songCard" data-id="${s.id}"${spanStyle}>
            <div class="songCardStack">
              <div class="songCardLayer songCardLayer2"></div>
              <div class="songCardLayer songCardLayer1"></div>
              <div class="songCardFront">
                <div class="songCardArt">${coverSvg(s, { lite: true })}</div>
              </div>
            </div>
            <div class="songCardInfo">
              ${syncDot(s)}
              <div class="songCardTitle">${escapeHtml(s.title)}</div>
              <div class="songCardSub">${vCount} ver${vCount !== 1 ? "s" : ""}</div>
            </div>
          </div>
        `;
      };

      const groupCardsHtml = (artistSongs) => {
        const count = artistSongs.length;
        if (count === 1) return cardHtml(artistSongs[0], 3);
        if (count === 2) {
          const sorted = [...artistSongs].sort((a, b) =>
            (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || "")
          );
          return cardHtml(sorted[0], 2) + cardHtml(sorted[1], 1);
        }
        // For 3+, fill complete rows; if remainder, last row gets adjusted spans
        const remainder = count % 3;
        if (remainder === 0) return artistSongs.map(s => cardHtml(s, 1)).join("");
        // Full rows first
        const fullCount = count - (remainder === 1 ? 4 : remainder);
        let html = artistSongs.slice(0, fullCount).map(s => cardHtml(s, 1)).join("");
        const tail = artistSongs.slice(fullCount);
        if (remainder === 2) {
          // 2 left over → span 2 + span 1
          html += cardHtml(tail[0], 2) + cardHtml(tail[1], 1);
        } else {
          // remainder === 1 → take last 4 songs, make two rows of span 2 + span 1 (alternating)
          html += cardHtml(tail[0], 2) + cardHtml(tail[1], 1);
          html += cardHtml(tail[2], 1) + cardHtml(tail[3], 2);
        }
        return html;
      };

      listEl.innerHTML = sortedArtists.map(artist => `
        <div class="songsGroup">
          <div class="songsGroupHead" data-artist="${escapeHtml(artist)}" style="cursor:pointer">${escapeHtml(artist)}</div>
          <div class="songsGroupLine"></div>
          <div class="songsList">${groupCardsHtml(groups[artist])}</div>
        </div>
      `).join("");
    }

    listEl.querySelectorAll(".songCard[data-id]").forEach((el) => {
      let longPressTimer = null;
      let didLongPress = false;

      el.addEventListener("touchstart", () => {
        didLongPress = false;
        longPressTimer = setTimeout(() => {
          didLongPress = true;
          navigator.vibrate?.(30);
          const id = el.getAttribute("data-id");
          if (id) openSongMenu(id);
        }, 500);
      }, { passive: true });

      el.addEventListener("touchend", () => { clearTimeout(longPressTimer); });
      el.addEventListener("touchmove", () => { clearTimeout(longPressTimer); });
      el.addEventListener("touchcancel", () => { clearTimeout(longPressTimer); });

      el.addEventListener("click", () => {
        if (didLongPress) return;
        songsListScrollTop = activeScreenEl.scrollTop;
        navigateForward(() => {
          selectedSongId = el.getAttribute("data-id");
        });
      });
    });

    listEl.querySelectorAll(".songsGroupHead[data-artist]").forEach((el) => {
      el.addEventListener("click", () => {
        const artist = el.getAttribute("data-artist");
        if (!artist) return;
        navigateForward(() => {
          drawerView = "projects";
          projectDetailScreen = artist;
        });
      });
    });
  };

  $("#q").addEventListener("input", applyFilter);

  $("#openSongFilters")?.addEventListener("click", openSongFilters);

  // Owner filter dropdown
  const dropBtn = activeScreenEl.querySelector(".ownerDropBtn");
  const dropWrap = activeScreenEl.querySelector(".ownerDropWrap");
  dropBtn?.addEventListener("click", () => {
    const existing = dropWrap?.querySelector(".ownerDropMenu");
    if (existing) { existing.remove(); return; }
    const menu = document.createElement("div");
    menu.className = "ownerDropMenu";
    menu.innerHTML = ["all", "mine", "shared"].map(v =>
      `<button class="ownerDropItem${ownerFilter === v ? " active" : ""}" data-owner="${v}">${ownerLabels[v]}</button>`
    ).join("");
    dropWrap?.appendChild(menu);
    menu.querySelectorAll(".ownerDropItem").forEach(item => {
      item.addEventListener("click", () => {
        menu.remove();
        songsListState.ownerFilter = item.getAttribute("data-owner") || "all";
        songsListScrollTop = 0;
        renderSongsList();
      });
    });
    const close = (e) => {
      if (!menu.contains(e.target) && e.target !== dropBtn) { menu.remove(); document.removeEventListener("pointerdown", close); }
    };
    setTimeout(() => document.addEventListener("pointerdown", close), 0);
  });

  $("#songsAddFab")?.addEventListener("click", () => openCreateOverlay());

  applyFilter();

  // Restore scroll position when returning from a song detail view
  if (songsListScrollTop > 0) {
    activeScreenEl.scrollTop = songsListScrollTop;
  }

  // Collapse title: fade small title in proportion to big title scrolling behind topbar
  // Remove any previous listener to avoid stacking
  if (activeScreenEl._collapseTitleScroll) {
    activeScreenEl.removeEventListener("scroll", activeScreenEl._collapseTitleScroll);
    activeScreenEl._collapseTitleScroll = null;
  }
  const _screen = activeScreenEl;
  const _sm = document.querySelector(".app.collapseTitle .titleblock h1");
  if (_sm) {
    // Measure once after layout is complete — no getBoundingClientRect in the handler
    requestAnimationFrame(() => {
      const bt = _screen.querySelector(".songsPageTitle");
      if (!bt) return;
      const topbarEl = document.querySelector(".topbar");
      // Screen's top edge in viewport (fixed — doesn't change with scroll)
      const screenTop = _screen.getBoundingClientRect().top;
      const topbarBottom = topbarEl ? topbarEl.getBoundingClientRect().bottom : 80;
      // bt.offsetTop = big title's position within the scroll content
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
function openSongDetailMenu(songId) {
  sheetSongMenuId = songId;
  openSheet("songDetailMenu");
}

function songReleaseLabel(song) {
  const rel = (state.releases || []).find(r => (r.songIds || []).includes(song.id));
  if (!rel) {
    const vCount = song.versions?.length || 0;
    return `${vCount} version${vCount === 1 ? "" : "s"}`;
  }
  const today = new Date(); today.setHours(0,0,0,0);
  const rd = rel.releaseDate ? new Date(rel.releaseDate + "T00:00:00") : null;
  return rd && rd <= today ? "Released" : "Upcoming";
}

function renderSongDetail(id) {
  const song = getSong(id);
  if (!song) {
    selectedSongId = null;
    selectedVersionId = null;
    return render();
  }

  setHeader(song.title);
  // Hide topbar title — the hero has its own large title
  const _tbH1 = document.querySelector(".topbar h1");
  if (_tbH1) _tbH1.textContent = "";
  const appEl = document.querySelector(".app");
  appEl?.classList.add("pdActive");
  appEl?.classList.remove("pdScrolled");
  activeScreenEl.style.paddingBottom = "0px";
  const topbarEl = document.querySelector(".topbar");
  const topbarH = topbarEl ? topbarEl.offsetHeight : 0;
  activeScreenEl.style.setProperty("--pd-topbar-h", topbarH + "px");

  activeScreenEl.style.overflowY = "scroll";

  const fv = featuredVersion(song);
  const heroCover = coverSvg(song);
  const rowCover = coverSvg(song, { lite: true });

  // Build playable items list for play/shuffle
  const allV = (song.versions || []).slice();
  const activeV = allV.find(v => v.isActive) || allV[0];
  const others = allV
    .filter(v => v.id !== activeV?.id)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const items = [activeV, ...others]
    .filter(v => v && isPlayable(v))
    .map(v => ({ songId: song.id, versionId: v.id }));

  const versions = (song.versions || []).slice();

  // Purple checkmark SVG for active versions
  const activeCheck = `<svg class="sdActiveCheck" viewBox="0 0 20 20" fill="none" width="14" height="14"><path d="M3.5 10.5l4.5 4.5 8.5-9" stroke="#a855f7" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const versionRows = versions.map((v, i) => {
    const hasAudio = !!(v.fileId || v.localAudioId || v.audioPath || v.link);
    const noAudioTag = hasAudio ? "" : `<span style="color:rgba(255,90,90,.8);font-size:11px;margin-left:6px">No audio</span>`;
    const sub = v.isActive
      ? `${activeCheck}<span style="color:#a855f7;font-weight:600">Active</span>${v.notes ? ` · ${escapeHtml(v.notes)}` : ""}`
      : `${escapeHtml(v.createdAt || "—")}${v.notes ? ` · ${escapeHtml(v.notes)}` : ""}`;

    return `
      <div class="pdSongRow" data-vrow="${v.id}" ${hasAudio ? "" : `style="opacity:.5"`}>
        <span class="pdSongNum">${i + 1}</span>
        <div class="songThumb" aria-hidden="true">
          ${rowCover}
        </div>
        <div class="songMain">
          <div class="songTop">
            <div class="songTitleRow">
              <div class="songTitle">${escapeHtml(v.label || "Version")}${noAudioTag}</div>
            </div>
            <button class="songMore" data-vmore="${v.id}" aria-label="Version menu">&#x22EF;</button>
          </div>
          <div class="songSub sdVersionSub">${sub}</div>
        </div>
      </div>
    `;
  }).join("");

  activeScreenEl.innerHTML = `
    <div class="pdHero">
      <div class="pdHeroBg" aria-hidden="true">${heroCover}</div>
      <div class="pdHeroContent">
        <div class="pdHeroTitle">${escapeHtml(song.title)}</div>
        <div class="pdHeroMeta">${escapeHtml(song.project || "—")} · ${songReleaseLabel(song)}</div>
      </div>
    </div>

    <div class="pdActions">
      <button class="pdPlayBtn" id="songBigPlay" ${!items.length ? "disabled" : ""}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <button class="pdShuffleBtn" id="songShuffle" ${!items.length ? "disabled" : ""}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
      </button>
      <button class="pdMoreBtn" id="songMoreMenu" aria-label="Song menu">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
      </button>
    </div>

    <div class="pdSticky">
      <div class="pdTabs">
        <button class="pdTab pdTabActive" data-sd-tab="list">List</button>
        <button class="pdTab" data-sd-tab="evolution">Evolution</button>
      </div>
      <div class="pdTabBody" id="pdTabBody">
        <div class="pdSongList">
          ${versionRows || `<div class="small" style="padding:24px 0; text-align:center">No versions yet.</div>`}
        </div>
      </div>
    </div>

    <button class="sdFab" id="sdAddVersion" aria-label="Add version">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
  `;

  // Reset scroll AFTER innerHTML so the hero is visible on load
  activeScreenEl.scrollTop = 0;


  /* ── Tab switching ── */
  const tabBody = $("#pdTabBody");
  activeScreenEl.querySelectorAll(".pdTab").forEach(tab => {
    tab.addEventListener("click", () => {
      activeScreenEl.querySelectorAll(".pdTab").forEach(t => t.classList.remove("pdTabActive"));
      tab.classList.add("pdTabActive");
      const which = tab.getAttribute("data-sd-tab");
      if (which === "list") {
        tabBody.innerHTML = `<div class="pdSongList">${versionRows || `<div class="small" style="padding:24px 0; text-align:center">No versions yet.</div>`}</div>`;
        attachVersionListeners();
      } else {
        tabBody.innerHTML = `<div id="evolutionView"></div>`;
        renderEvolutionView($("#evolutionView"), song);
      }
    });
  });

  /* ── Play all ── */
  $("#songBigPlay")?.addEventListener("click", async () => {
    if (!items.length) return toast("No playable versions");
    const all = [...items];
    state.player.nowPlaying = all[0];
    state.player.queue = all.slice(1);
    state.player.repeatQueue = all;
    state.player.shuffle = false;
    state.player.repeat = false;
    saveState();
    unlockAudioOnce();
    await playNowPlaying({ autoplay: true });
    syncMiniPlayerUI();
  });

  /* ── Shuffle ── */
  $("#songShuffle")?.addEventListener("click", async () => {
    if (!items.length) return toast("No playable versions");
    const all = shuffleArray([...items]);
    state.player.nowPlaying = all[0];
    state.player.queue = all.slice(1);
    state.player.repeatQueue = all;
    saveState();
    unlockAudioOnce();
    await playNowPlaying({ autoplay: true });
    syncMiniPlayerUI();
  });

  /* ── Song more menu (Details, Regen Art, Delete) ── */
  $("#songMoreMenu")?.addEventListener("click", () => {
    openSongDetailMenu(song.id);
  });

  /* ── FAB: Add version ── */
  $("#sdAddVersion")?.addEventListener("click", () => {
    const newV = createVersion(song);
    if (!newV) return toast("Couldn’t create version");
    navigateForward(() => {
      selectedVersionId = newV.id;
    });
  });

  /* ── Version row listeners ── */
  function attachVersionListeners() {
    activeScreenEl.querySelectorAll("[data-vrow]").forEach(row => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("[data-vmore]")) return;
        navigateForward(() => {
          selectedVersionId = row.getAttribute("data-vrow");
        });
      });
    });

    activeScreenEl.querySelectorAll("[data-vmore]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openVersionMenu(song.id, btn.getAttribute("data-vmore"));
      });
    });
  }

  attachVersionListeners();

  /* ── Fade hero + actions to black, solid topbar as user scrolls ── */
  const heroEl = activeScreenEl.querySelector(".pdHero");
  const heroBgEl = heroEl?.querySelector(".pdHeroBg");
  const heroContentEl = heroEl?.querySelector(".pdHeroContent");
  const actionsEl = activeScreenEl.querySelector(".pdActions");
  const stickyEl = activeScreenEl.querySelector(".pdSticky");
  if (stickyEl && heroEl) {
    let maxScroll = 0;
    const FADE_PX = 200;
    requestAnimationFrame(() => {
      maxScroll = activeScreenEl.scrollHeight - activeScreenEl.clientHeight;
    });

    activeScreenEl.addEventListener("scroll", () => {
      const scrolled = activeScreenEl.scrollTop;
      if (maxScroll > 0) {
        const remaining = maxScroll - scrolled;
        const opacity = remaining < FADE_PX ? Math.max(0, remaining / FADE_PX) : 1;
        if (heroBgEl) heroBgEl.style.opacity = opacity;
        if (heroContentEl) heroContentEl.style.opacity = opacity;
        if (actionsEl) actionsEl.querySelectorAll("button").forEach(b => b.style.opacity = opacity);
      }
      if (appEl) {
        const heroBottom = heroEl.getBoundingClientRect().bottom;
        const screenTop = activeScreenEl.getBoundingClientRect().top;
        if (heroBottom - screenTop < 60) {
          appEl.classList.add("pdScrolled");
        } else {
          appEl.classList.remove("pdScrolled");
        }
      }
    }, { passive: true });
  }
}

// ── Evolution View — constellation visualization ──

function renderEvolutionView(container, song) {
  const versions = (song.versions || []).slice();
  const n = versions.length;

  if (!n) {
    container.innerHTML = `<div class="evoCanvas"><div class="evoEmpty">No versions yet</div></div>`;
    return;
  }

  // Determine visual stage
  let stage = "dark";        // 1 version
  if (n >= 7)      stage = "complete";
  else if (n >= 4) stage = "nebula";
  else if (n >= 2) stage = "constellation";

  const W = 400, H = 400;

  // Layout: simple force-directed positioning
  const nodes = versions.map((v, i) => ({
    id: v.id,
    label: v.label || `v${i + 1}`,
    isActive: !!v.isActive,
    x: W / 2 + (Math.cos(i * 2.4 + 0.5) * (60 + i * 28)),
    y: H / 2 + (Math.sin(i * 2.4 + 0.5) * (60 + i * 28)),
    vx: 0, vy: 0,
  }));

  // Edges: chain sequential + connect to parent if exists
  const edges = [];
  for (let i = 1; i < nodes.length; i++) {
    edges.push([i - 1, i]);
  }

  // Simple force simulation (run synchronously, ~60 iterations)
  for (let iter = 0; iter < 60; iter++) {
    // Repulsion between all pairs
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        let dx = nodes[j].x - nodes[i].x;
        let dy = nodes[j].y - nodes[i].y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        let force = 1200 / (dist * dist);
        let fx = (dx / dist) * force;
        let fy = (dy / dist) * force;
        nodes[i].vx -= fx; nodes[i].vy -= fy;
        nodes[j].vx += fx; nodes[j].vy += fy;
      }
    }

    // Attraction along edges
    for (const [a, b] of edges) {
      let dx = nodes[b].x - nodes[a].x;
      let dy = nodes[b].y - nodes[a].y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      let force = (dist - 80) * 0.04;
      let fx = (dx / dist) * force;
      let fy = (dy / dist) * force;
      nodes[a].vx += fx; nodes[a].vy += fy;
      nodes[b].vx -= fx; nodes[b].vy -= fy;
    }

    // Center gravity
    for (const nd of nodes) {
      nd.vx += (W / 2 - nd.x) * 0.01;
      nd.vy += (H / 2 - nd.y) * 0.01;
      nd.x += nd.vx * 0.4;
      nd.y += nd.vy * 0.4;
      nd.vx *= 0.7;
      nd.vy *= 0.7;
      // Clamp to bounds
      nd.x = Math.max(40, Math.min(W - 40, nd.x));
      nd.y = Math.max(40, Math.min(H - 40, nd.y));
    }
  }

  // Generate background stars
  let starsHtml = "";
  const starCount = stage === "dark" ? 30 : stage === "constellation" ? 60 : 120;
  for (let i = 0; i < starCount; i++) {
    const sx = Math.random() * W;
    const sy = Math.random() * H;
    const sr = 0.3 + Math.random() * 1;
    const so = 0.15 + Math.random() * 0.5;
    starsHtml += `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${sr.toFixed(1)}" fill="white" opacity="${so.toFixed(2)}"/>`;
  }

  // Generate edges SVG
  let edgesHtml = "";
  if (n >= 2) {
    for (const [a, b] of edges) {
      edgesHtml += `<line class="evoLine" x1="${nodes[a].x.toFixed(1)}" y1="${nodes[a].y.toFixed(1)}" x2="${nodes[b].x.toFixed(1)}" y2="${nodes[b].y.toFixed(1)}"/>`;
    }
  }

  // Generate nodes SVG
  let nodesHtml = "";
  const coreR = n === 1 ? 7 : 5;
  const glowR = n === 1 ? 20 : 14;

  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    const delay = i * 0.12;
    const activeClass = nd.isActive ? " is-active" : "";
    const nodeColor = nd.isActive ? "#7cacff" : "#a0b8e8";
    const truncLabel = nd.label.length > 14 ? nd.label.slice(0, 12) + ".." : nd.label;

    nodesHtml += `
      <g class="evoNode${activeClass}" data-evo-node="${nd.id}" style="animation-delay:${delay}s" transform="translate(${nd.x.toFixed(1)},${nd.y.toFixed(1)})">
        ${nd.isActive ? `<circle class="evoNodePulse" r="${glowR}" fill="${nodeColor}" opacity=".2"/>` : ""}
        <circle class="evoNodeGlow" r="${glowR}" fill="rgba(140,170,255,.06)"/>
        <circle class="evoNodeCore" r="${coreR}" fill="${nodeColor}" opacity=".9"/>
        <text class="evoNodeLabel" dy="${coreR + 16}">${escapeHtml(truncLabel)}</text>
      </g>`;
  }

  // Nebula gradient overlay (canvas-drawn radial blobs)
  let nebulaHtml = "";
  if (stage === "nebula" || stage === "complete") {
    const nebulaOpacity = stage === "complete" ? 0.25 : 0.12;
    nebulaHtml = `<div class="evoNebula" style="opacity:${nebulaOpacity};background:
      radial-gradient(ellipse at 30% 35%, rgba(90,60,180,${nebulaOpacity}) 0%, transparent 60%),
      radial-gradient(ellipse at 70% 60%, rgba(50,100,200,${nebulaOpacity}) 0%, transparent 55%),
      radial-gradient(ellipse at 55% 80%, rgba(120,50,160,${nebulaOpacity * 0.7}) 0%, transparent 50%)
    "></div>`;
  }

  container.innerHTML = `
    <div class="evoCanvas stage-${stage}">
      ${nebulaHtml}
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
        ${starsHtml}
        ${edgesHtml}
        ${nodesHtml}
      </svg>
    </div>`;

  // ── Node interactions ──
  let longPressTimer = null;
  let didLongPress = false;

  container.querySelectorAll("[data-evo-node]").forEach((nodeEl) => {
    const vid = nodeEl.getAttribute("data-evo-node");

    // Tap → play that version
    nodeEl.addEventListener("click", (e) => {
      if (didLongPress) { didLongPress = false; return; }
      e.stopPropagation();
      const v = song.versions.find(vv => vv.id === vid);
      if (!v || !isPlayable(v)) return toast("No audio for this version");
      state.player.nowPlaying = { songId: song.id, versionId: vid };
      state.player.queue = [];
      state.player.repeatQueue = [{ songId: song.id, versionId: vid }];
      saveState();
      unlockAudioOnce();
      playNowPlaying({ autoplay: true }).then(() => syncMiniPlayerUI());
    });

    // Long press → action menu
    const startPress = (e) => {
      didLongPress = false;
      longPressTimer = setTimeout(() => {
        didLongPress = true;
        showEvoActionMenu(container, nodeEl, song, vid);
      }, 500);
    };
    const cancelPress = () => { clearTimeout(longPressTimer); };

    nodeEl.addEventListener("pointerdown", startPress);
    nodeEl.addEventListener("pointerup", cancelPress);
    nodeEl.addEventListener("pointerleave", cancelPress);
    nodeEl.addEventListener("pointercancel", cancelPress);
  });

  // Dismiss action menu on background tap
  container.querySelector(".evoCanvas").addEventListener("click", () => {
    const menu = container.querySelector(".evoActionMenu");
    if (menu) menu.remove();
  });
}

function showEvoActionMenu(container, nodeEl, song, versionId) {
  // Remove any existing menu
  container.querySelector(".evoActionMenu")?.remove();

  const rect = nodeEl.getBoundingClientRect();
  const containerRect = container.querySelector(".evoCanvas").getBoundingClientRect();
  let left = rect.left - containerRect.left + rect.width / 2;
  let top = rect.top - containerRect.top + rect.height + 8;

  // Clamp to container bounds
  left = Math.max(10, Math.min(containerRect.width - 170, left - 80));
  if (top + 180 > containerRect.height) top = rect.top - containerRect.top - 180;

  const menu = document.createElement("div");
  menu.className = "evoActionMenu";
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  menu.innerHTML = `
    <button data-evo-action="play">Play</button>
    <button data-evo-action="addVersion">Add new version</button>
    <button data-evo-action="rename">Rename version</button>
    <button data-evo-action="notes">Add notes</button>
  `;

  container.querySelector(".evoCanvas").appendChild(menu);

  menu.addEventListener("click", (e) => {
    e.stopPropagation();
    const action = e.target.getAttribute("data-evo-action");
    menu.remove();

    if (action === "play") {
      const v = song.versions.find(vv => vv.id === versionId);
      if (!v || !isPlayable(v)) return toast("No audio for this version");
      state.player.nowPlaying = { songId: song.id, versionId };
      state.player.queue = [];
      state.player.repeatQueue = [{ songId: song.id, versionId }];
      saveState();
      unlockAudioOnce();
      playNowPlaying({ autoplay: true }).then(() => syncMiniPlayerUI());
    } else if (action === "addVersion") {
      const newV = createVersion(song);
      if (!newV) return toast("Couldn't create version");
      selectedVersionId = newV.id;
      render();
    } else if (action === "rename") {
      navigateForward(() => { selectedVersionId = versionId; });
    } else if (action === "notes") {
      navigateForward(() => { selectedVersionId = versionId; });
    }
  });
}

function renderVersionDetail(songId, versionId) {
  const song = getSong(songId);
  const v = getVersion(song, versionId);

  if (!song || !v) {
    selectedVersionId = null;
    return render();
  }

  setHeader("Version");

    // ✅ Fix: entering Version detail should not inherit prior scroll position
  if (activeScreenEl) activeScreenEl.scrollTop = 0;
  try { window.scrollTo(0, 0); } catch {}
  try { document.documentElement.scrollTop = 0; } catch {}
  try { document.body.scrollTop = 0; } catch {}
  requestAnimationFrame(() => { if (screens.home) screens.home.scrollTop = 0; });

  const hasPlayable = !!(v.link || v.fileId || v.localAudioId || v.audioPath);
  const hasLocal = !!(v.fileId || v.localAudioId);
  const hasCloud = !!v.audioPath;

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
          <div class="vDetailLabel">Status</div>
          <div class="vDetailValue">
            <button class="vdChip ${v.isActive ? "vdChipActive" : ""}" id="toggleActiveBtn">${v.isActive ? "Active" : "Set Active"}</button>
          </div>
        </div>

      </div>

      <div class="vdAudioSection">
        ${hasLocal || hasCloud || v.link ? `
          <div class="vdAudioCard">
            <div class="vdAudioIcon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
            </div>
            <div class="vdAudioInfo">
              <div class="vdAudioName">${escapeHtml(v.fileName || v.originalFileName || "audio file")}</div>
              <div class="vdAudioMeta">
                ${v.fileSize ? `${(v.fileSize/1024/1024).toFixed(1)} MB` : ""}
                ${hasLocal ? `<span class="vdAudioBadge vdBadgeLocal">Local</span>` : ""}
                ${hasCloud ? `<span class="vdAudioBadge vdBadgeDrive">Cloud</span>` : ""}
                ${v.link ? `<span class="vdAudioBadge vdBadgeLink">URL</span>` : ""}
              </div>
            </div>
            <div class="vdAudioActions">
              <button class="vdAudioActionBtn" id="importAudioBtn" aria-label="Replace file">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              </button>
              ${hasLocal ? `<button class="vdAudioActionBtn vdAudioDanger" id="clearLocalBtn" aria-label="Remove local"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>` : ""}
              ${hasLocal && !hasCloud ? `<button class="vdAudioActionBtn vdAudioCloud" id="uploadToCloudBtn" aria-label="Upload to cloud"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg></button>` : ""}
              ${v.link ? `<button class="vdAudioActionBtn" id="openLinkBtn" aria-label="Open link"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>` : ""}
            </div>
          </div>
        ` : `
          <button class="vdUploadBtn" id="importAudioBtn">
            <div class="vdUploadIcon">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            </div>
            <div class="vdUploadLabel">Upload Song</div>
            <div class="vdUploadSub">WAV, MP3, M4A, AIFF, FLAC, OGG</div>
          </button>
        `}
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

  // Import audio (local + cloud)
  $("#importAudioBtn")?.addEventListener("click", async () => {
    try {
      const file = await pickAudioFile();
      if (!file) return;

      const id = uid();

      // Store locally first (fast, offline)
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
      toast("Imported locally");

      // Upload to Supabase Storage in background (compress large files first)
      toast("Syncing to cloud…");
      const compressed = await compressAudioForUpload(file);
      const result = await supabaseUploadAudio({
        blob: new File([compressed], file.name || "audio", { type: compressed.type || file.type || "audio/*" }),
        songId: song.id,
        versionId: v.id,
        fileName: file.name || "audio",
      });

      if (result.success) {
        v.audioPath = result.audioPath;
        saveState();
        toast("Synced to cloud");
      } else {
        console.warn("Cloud upload failed:", result.error);
        toast("Local saved, cloud sync failed");
      }

      renderVersionDetail(songId, versionId);
    } catch (err) {
      console.error(err);
      toast("Import failed");
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
  // Upload to Cloud (manual push for local-only files)
  $("#uploadToCloudBtn")?.addEventListener("click", async () => {
    let blob = null;
    let fileName = v.fileName || v.originalFileName || "audio.wav";

    if (v.fileId) {
      const rec = await audioGet(v.fileId);
      if (rec?.blob) blob = rec.blob;
    } else if (v.localAudioId) {
      const rec = await getAudioBlob(v.localAudioId);
      if (rec?.blob) blob = rec.blob;
    }

    if (!blob) return toast("No local file to upload");

    toast("Compressing & uploading…");
    const compressed = await compressAudioForUpload(blob);
    const result = await supabaseUploadAudio({
      blob: new File([compressed], fileName, { type: compressed.type || blob.type || "audio/*" }),
      songId: song.id,
      versionId: v.id,
      fileName,
    });

    if (result.success) {
      v.audioPath = result.audioPath;
      song.updatedAt = nowStamp();
      saveState();
      toast("Uploaded to cloud");
      renderVersionDetail(songId, versionId);
    } else {
      toast("Upload failed: " + (result.error || "unknown"));
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

    // Also delete from cloud storage if synced
    if (v.audioPath) {
      supabaseDeleteAudio(v.audioPath).catch(() => {});
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
    render();
  });
}

// ---------------------
// Player
// ---------------------
function renderPlayer() {
  setHeader("");

  // Build playlist rows (one row per version where playerYes === true)
  const allItems = playerItems(state); // uses playerFilter/playerSort globals

  // Apply search filter
  const pq = playerQuery.toLowerCase();
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
        value="${escapeHtml(playerQuery)}"
      />
    </div>

    <div class="playerChipsSticky">
      <div class="chipsRow" aria-label="Player filters">
        <button class="chip ${playerFilter === "all" ? "active" : ""}" data-pf="all">Riffs</button>
        <button class="chip ${playerFilter === "playlists" ? "active" : ""}" data-pf="playlists">Playlists</button>
        <button class="chip ${playerFilter === "projects" ? "active" : ""}" data-pf="projects">Projects</button>
        <button class="chip ${playerFilter === "releases" ? "active" : ""}" data-pf="releases">Releases</button>
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
      playerQuery = searchInput.value;
      renderPlayer();
      // Re-focus and restore cursor position
      const el = $("#playerSearch");
      if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; }
    });
  }

  // Filter chips (single-select mode filters)
  activeScreenEl.querySelectorAll("[data-pf]").forEach(btn => {
    btn.addEventListener("click", () => {
      playerFilter = btn.getAttribute("data-pf") || "all";
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
        fp.style.transition = "transform 300ms cubic-bezier(.32,0,.6,1), opacity 214ms ease";
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
function renderSettings() {
  setHeader("Settings");

  activeScreenEl.innerHTML = `
    <div class="card">
      <h2>Settings</h2>

      <div style="
        background: rgba(78,205,196,.08);
        border: 1px solid rgba(78,205,196,.25);
        border-radius: 12px;
        padding: 16px;
        margin-bottom: 16px;
      ">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4ecdc4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>
          <span style="font-weight:900; font-size:15px;">Cloud Sync</span>
          <span style="
            background: rgba(78,205,196,.15);
            color: #4ecdc4;
            font-size: 11px;
            font-weight: 700;
            padding: 2px 8px;
            border-radius: 6px;
            margin-left: auto;
          ">Connected</span>
        </div>

        <div class="small" style="margin-bottom:10px; opacity:.7">
          Audio imports are automatically synced to the cloud. Files also stay on this device for offline playback.
        </div>
        <div class="row" style="gap:10px">
          <button id="cloudSyncPush" class="btn" style="flex:1">Push to cloud</button>
          <button id="cloudSyncPull" class="btn" style="flex:1">Pull from cloud</button>
        </div>
        <div class="row" style="gap:10px; margin-top:10px">
          <button id="cloudBackupAll" class="btn" style="flex:1; background: rgba(78,205,196,.08); border-color: rgba(78,205,196,.2); color: #4ecdc4;">Backup all audio to cloud</button>
          <button id="cloudCacheAll" class="btn" style="flex:1">Cache all audio locally</button>
        </div>
        <div class="small" style="margin-top:4px; opacity:.7">Backup uploads local-only audio to the cloud. Cache downloads cloud audio to this device.</div>
        <div class="row" style="gap:10px; margin-top:10px">
          <button id="cloudRecoverAudio" class="btn" style="flex:1; background: rgba(255,184,77,.08); border-color: rgba(255,184,77,.2); color: #ffb84d;">Recover Audio</button>
        </div>
        <div class="row" style="margin-top:6px">
          <button id="debugRecoveryBtn" class="btn" style="flex:1; background: rgba(150,150,150,.06); border-color: rgba(150,150,150,.15); color: #888; font-size:12px;">Debug Recovery</button>
        </div>
        <div class="row" style="gap:10px; margin-top:10px">
          <button id="cloudSignOut" class="btn" style="flex:1; background: rgba(255,92,119,.08); border-color: rgba(255,92,119,.2); color: #ff5c77;">Sign Out</button>
        </div>
      </div>

      <div class="hr"></div>
      <h2>AI Art</h2>

      <div class="row" style="gap:10px">
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
      <h2>Debug Tools</h2>
      <div class="row" style="gap:10px; align-items:center">
        <button id="toggleSyncDebug" class="btn" style="flex:1; ${window.RIFFBANK_DEBUG_SYNC ? "background:rgba(78,205,196,.12); border-color:rgba(78,205,196,.3); color:#4ecdc4" : ""}">${window.RIFFBANK_DEBUG_SYNC ? "Sync Debug: ON" : "Sync Debug: OFF"}</button>
        <button id="runSyncAudit" class="btn" style="flex:1">Run Sync Audit</button>
      </div>
      <div class="small" style="margin-top:4px">
        Sync Debug shows colored dots on song cards:
        <span style="color:#4ade80">●</span> local audio
        <span style="color:#facc15">●</span> cloud-only
        <span style="color:#f87171">●</span> no audio
      </div>

      <div class="hr"></div>
      <h2>Danger zone</h2>
      <button id="wipe" class="btn">Wipe local data</button>
      <div class="small">This only affects this device/browser. Export first if you care.</div>
    </div>
  `;

  // Cloud: Push state now
  $("#cloudSyncPush")?.addEventListener("click", async () => {
    toast("Pushing to cloud…");
    const ok = await supabasePushState(state);
    toast(ok ? "Pushed to cloud" : "Push failed");
  });

  // Cloud: Pull state now
  $("#cloudSyncPull")?.addEventListener("click", async () => {
    toast("Pulling from cloud…");
    const cloudState = await supabasePullState();
    if (cloudState?.songs) {
      if (!confirm(`Found ${cloudState.songs.length} songs in cloud. This will wipe all local data and replace it with cloud data. Continue?`)) return;

      // Wipe local audio/cover blobs from IndexedDB
      toast("Clearing local data…");
      audioUrlCache.clear();
      try {
        const db = await openAudioDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(AUDIO_STORE, "readwrite");
          tx.objectStore(AUDIO_STORE).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (e) { console.warn("[Pull] IDB clear failed:", e); }

      state = cloudState;
      normalizeState();

      // Discover audio files in Supabase Storage for versions missing audio_path
      const missingCount = state.songs.reduce((n, s) => n + (s.versions || []).filter(v => !v.audioPath).length, 0);
      if (missingCount) {
        toast(`Discovering audio for ${missingCount} versions…`);
        const discovered = await supabaseDiscoverAudioPaths(state.songs);
        toast(`Found ${discovered.length}/${missingCount} audio files in storage`);
      }

      localStorage.setItem(LS_KEY, JSON.stringify(state));
      render();
      toast("Caching cloud audio…");

      // Push back so discovered audioPath values make it to the DB
      await supabasePushState(state).catch(console.warn);
      // Download cloud audio + covers to local cache
      await cacheAllCloudAudio();
      await restoreCoverUrlsFromCache();
    } else {
      toast("No data found in cloud");
    }
  });

  // Cloud: Backup all local audio to cloud
  $("#cloudBackupAll")?.addEventListener("click", async () => {
    await backupAllAudioToCloud();
  });

  // Cloud: Cache all audio locally
  $("#cloudCacheAll")?.addEventListener("click", async () => {
    await cacheAllCloudAudio();
  });

  // Cloud: Recover audio — scan IndexedDB, re-link, re-upload
  $("#cloudRecoverAudio")?.addEventListener("click", async () => {
    await recoverAndUploadAudio();
  });

  // Debug recovery
  $("#debugRecoveryBtn")?.addEventListener("click", () => debugRecovery());

  // Cloud: Sign out
  $("#cloudSignOut")?.addEventListener("click", async () => {
    if (!confirm("Sign out? Your local data stays on this device.")) return;
    await signOut();
    window.location.reload();
  });

  // Save settings
  $("#saveSettings").addEventListener("click", () => {
    state.settings.defaultProject = $("#defProject").value.trim() || "";
    state.settings.defaultGenre = $("#defGenre").value.trim() || "";
    state.settings.defaultSprint = $("#defSprint").value.trim() || "";
    saveState();
    toast("Saved");
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

  $("#toggleSyncDebug")?.addEventListener("click", () => {
    window.RIFFBANK_DEBUG_SYNC = !window.RIFFBANK_DEBUG_SYNC;
    toast(`Sync debug ${window.RIFFBANK_DEBUG_SYNC ? "ON" : "OFF"}`);
    renderSettings();
  });

  $("#runSyncAudit")?.addEventListener("click", async () => {
    toast("Running sync audit…");
    const results = await window.auditSync();
    const reds = results.filter(r => r.status === "red");
    const yellows = results.filter(r => r.status === "yellow");
    const greens = results.length - reds.length - yellows.length;
    let msg = `${results.length} versions: ${greens} synced, ${yellows.length} local only, ${reds.length} no audio`;
    if (reds.length) msg += `\n\nBroken:\n${reds.map(r => `• ${r.song} / ${r.version}`).join("\n")}`;
    alert(msg);
  });

  $("#wipe").addEventListener("click", async () => {
    if (!confirm("Wipe all local RiffBank data and sign out? This is like deleting and reinstalling the app.")) return;

    // 1. Clear all localStorage (app state, onboarding flags, nudge flags, etc.)
    localStorage.clear();

    // 2. Delete IndexedDB (cached audio blobs, cover blobs) — must await completion
    async function deleteIDB(name) {
      return new Promise((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });
    }
    try {
      if (indexedDB.databases) {
        const dbs = await indexedDB.databases();
        for (const db of dbs) {
          if (db.name) await deleteIDB(db.name);
        }
      } else {
        await deleteIDB(AUDIO_DB);
      }
    } catch {
      try { await deleteIDB(AUDIO_DB); } catch {}
    }

    // 3. Sign out of Supabase
    try { await signOut(); } catch {}

    // 4. Hard reload — cleanest way to get back to a fresh state
    window.location.reload();
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

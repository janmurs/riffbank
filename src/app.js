// RiffBank v1.3 (Local-first PWA + Google Drive sync)
// - Song creation + editing
// - Upload Helper (suggested filename + Drive path)
// - Version history + Best flag
// - Best-only Player (plays links)
// - Dashboard + Settings
// - Export / Import
// - Google Drive integration (auto-sync uploads, stream playback)

window.onerror = (m, src, line, col) => alert(`JS ERROR:\n${m}\n${line}:${col}`);

// Dev toggles: skip splash / welcome screen
 const DISABLE_SPLASH = true;
 const DISABLE_WELCOME = true;

// Debug toggle: highlight sync status on song cards
// Toggle via console: toggleSyncDebug()
window.RIFFBANK_DEBUG_SYNC = false;
window.toggleSyncDebug = () => {
  window.RIFFBANK_DEBUG_SYNC = !window.RIFFBANK_DEBUG_SYNC;
  console.log(`[RiffBank] Sync debug ${window.RIFFBANK_DEBUG_SYNC ? "ON" : "OFF"}`);
  render();
};

// console.log("RIFFBANK APP.JS LOADED ✅", new Date().toISOString());
// alert("RIFFBANK APP.JS LOADED ✅ " + new Date().toISOString());

import { $ } from "./ui/dom.js";
import { runSplashSequence, replaySplash } from "./splash/splash.js";
import {
  gdriveLoadGIS,
  gdriveIsConnected,
  gdriveHasValidToken,
  gdriveGetConfig,
  gdriveConnect,
  gdriveSignIn,
  gdrivePickHome,
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
  gdriveFindExisting,
  gdriveConnectToFolder,
} from "./gdrive.js";

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
  player: document.getElementById("screen-player"),
  settings: document.getElementById("screen-settings"),
  collab: document.getElementById("screen-collab"),
  drawer: document.getElementById("screen-drawer"),
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

    this.pendingBackState = null;
    this._isBackNav = false;
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

    // Swipe overlay references
    this.swipeAceEl = null;
    this.swipeQueenEl = null;

    this.ACE_PARALLAX = 30;
  }

  get depth() { return this.stack.length; }

  // Capture current screen so back transitions can show it as the ace.
  // Call at the start of render() before any DOM mutations.
  snapshot(screenEl) {
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
    this.topbarHTML = tbVisible ? (tb?.outerHTML || "") : "";
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

  // --- Forward slide ---
  // Slide new screen in from the right. Call AFTER render().

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
          tbEl.style.cssText = `display:flex;position:absolute;top:${this.topbarRect.top}px;left:0;width:100%;height:${this.topbarRect.height}px;overflow:hidden;pointer-events:none;box-sizing:border-box;`;
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
      tbClone.style.cssText = `display:flex;position:absolute;top:${tbRect.top}px;left:${r.left}px;width:${r.width}px;height:${tbRect.height}px;overflow:hidden;pointer-events:none;`;
      overlay.appendChild(tbClone);
    }

    const screenWrap = document.createElement("div");
    screenWrap.style.cssText = `position:absolute;top:${r.top}px;left:${r.left}px;width:${r.width}px;height:${r.height}px;overflow:hidden;`;
    screenWrap.appendChild(this._freeze(screenEl));
    overlay.appendChild(screenWrap);

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
      tbClone.style.cssText = `display:flex;position:absolute;top:${tbRect.top}px;left:${tbRect.left}px;width:${tbRect.width}px;height:${tbRect.height}px;overflow:hidden;pointer-events:none;`;
      queenEl.appendChild(tbClone);
    }

    const screenWrap = document.createElement("div");
    screenWrap.style.cssText = `position:absolute;top:${viewRect.top}px;left:${viewRect.left}px;width:${viewRect.width}px;height:${viewRect.height}px;overflow:hidden;`;
    const queenClone = this._freeze(screenEl);
    queenClone.scrollTop = screenEl.scrollTop;
    screenWrap.appendChild(queenClone);
    queenEl.appendChild(screenWrap);

    // Queen goes on first — covers everything while we render + build ace
    document.body.appendChild(queenEl);

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
          tbEl.style.cssText = `display:flex;position:absolute;top:${aceTbRect.top}px;left:${aceRect.left}px;width:${aceRect.width}px;height:${aceTbRect.height}px;overflow:hidden;pointer-events:none;box-sizing:border-box;`;
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
      tbClone.style.cssText = `display:flex;position:absolute;top:${tbRect.top}px;left:${tbRect.left}px;width:${tbRect.width}px;height:${tbRect.height}px;overflow:hidden;pointer-events:none;`;
      queenEl.appendChild(tbClone);
    }

    const screenWrap = document.createElement("div");
    screenWrap.style.cssText = `position:absolute;top:${viewRect.top}px;left:${viewRect.left}px;width:${viewRect.width}px;height:${viewRect.height}px;overflow:hidden;`;
    const queenClone = this._freeze(screenEl);
    queenClone.scrollTop = screenEl.scrollTop;
    screenWrap.appendChild(queenClone);
    queenEl.appendChild(screenWrap);

    document.body.appendChild(queenEl);

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
    return this.stateStack.length > 0 ? this.stateStack.pop() : null;
  }

  // Consume pending back state (set by animated back).
  consumePendingState() {
    const s = this.pendingBackState;
    this.pendingBackState = null;
    return s;
  }

  // --- Swipe gesture helpers ---

  swipeStart(screenEl) {
    const navBottomOffset = this._bottomOffset();

    const peekNode = this.stack.length > 0 ? this.stack[this.stack.length - 1] : this.peekNode;
    const peekTopbarHTML = this.topbarStack.length > 0
      ? this.topbarStack[this.topbarStack.length - 1]
      : this.topbarHTML;
    const peekRect = this.rectStack.length > 0
      ? this.rectStack[this.rectStack.length - 1]
      : this.aceRect;
    const peekPadding = this.paddingStack.length > 0
      ? this.paddingStack[this.paddingStack.length - 1]
      : this.acePadding;
    const peekTopbarRect = this.topbarRect;
    const isHomeAce = peekNode && peekNode.querySelector(".homeWrap");
    const swipeAceScrollTop = this.scrollStack.length > 0 ? this.scrollStack[this.scrollStack.length - 1] : this.aceScrollTop;

    // ACE overlay (frozen previous screen using stored dimensions)
    this.swipeAceEl = document.createElement("div");
    this.swipeAceEl.style.cssText = `position:fixed;inset:0;bottom:${navBottomOffset};z-index:499;overflow:hidden;pointer-events:none;background:var(--bg);`;

    if (peekTopbarHTML && peekTopbarRect && peekRect) {
      const tbWrap = document.createElement("div");
      tbWrap.innerHTML = peekTopbarHTML;
      const tbEl = tbWrap.firstElementChild;
      if (tbEl) {
        tbEl.style.cssText = `display:flex;position:absolute;top:${peekTopbarRect.top}px;left:${peekRect.left}px;width:${peekRect.width}px;height:${peekTopbarRect.height}px;overflow:hidden;pointer-events:none;box-sizing:border-box;`;
        this.swipeAceEl.appendChild(tbEl);
      }
    }

    if (peekNode && peekRect) {
      const aceWrap = document.createElement("div");
      aceWrap.style.cssText = `position:absolute;top:${peekRect.top}px;left:${peekRect.left}px;width:${peekRect.width}px;height:${peekRect.height}px;overflow:hidden;`;
      const aceScreenClone = this._cloneDeep(peekNode);
      aceScreenClone.style.width = `${peekRect.width}px`;
      aceScreenClone.style.height = `${peekRect.height}px`;
      aceScreenClone.style.padding = isHomeAce ? "0" : peekPadding;
      aceScreenClone.style.margin = "0";
      aceScreenClone.style.boxSizing = "border-box";
      aceScreenClone.style.position = "relative";
      aceScreenClone.style.inset = "auto";
      aceWrap.appendChild(aceScreenClone);
      this.swipeAceEl.appendChild(aceWrap);
      document.body.appendChild(this.swipeAceEl);
      aceScreenClone.scrollTop = swipeAceScrollTop;
    } else {
      document.body.appendChild(this.swipeAceEl);
    }

    // QUEEN overlay (current screen)
    this.swipeQueenEl = document.createElement("div");
    this.swipeQueenEl.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:${navBottomOffset};z-index:500;overflow:hidden;pointer-events:none;background:var(--bg);`;

    const swipeTb = document.querySelector(".topbar");
    if (swipeTb) {
      const tbRect = swipeTb.getBoundingClientRect();
      const tbClone = swipeTb.cloneNode(true);
      tbClone.style.cssText = `display:flex;position:absolute;top:${tbRect.top}px;left:${tbRect.left}px;width:${tbRect.width}px;height:${tbRect.height}px;overflow:hidden;pointer-events:none;`;
      this.swipeQueenEl.appendChild(tbClone);
    }

    let clonedScreen = null;
    const savedScrollTop = screenEl ? screenEl.scrollTop : 0;
    if (screenEl) {
      const screenRect = screenEl.getBoundingClientRect();
      const screenWrap = document.createElement("div");
      screenWrap.style.cssText = `position:absolute;top:${screenRect.top}px;left:${screenRect.left}px;width:${screenRect.width}px;height:${screenRect.height}px;overflow:hidden;`;
      clonedScreen = this._freeze(screenEl);
      screenWrap.appendChild(clonedScreen);
      this.swipeQueenEl.appendChild(screenWrap);
    }

    document.body.appendChild(this.swipeQueenEl);
    if (clonedScreen) clonedScreen.scrollTop = savedScrollTop;

    if (this.swipeAceEl) this.swipeAceEl.style.transform = `translateX(-${this.ACE_PARALLAX}px)`;
  }

  swipeMove(dx) {
    const clamp = Math.max(0, dx);
    if (this.swipeQueenEl) this.swipeQueenEl.style.transform = `translateX(${clamp}px)`;
    if (this.swipeAceEl) {
      const ratio = Math.min(clamp / window.innerWidth, 1);
      this.swipeAceEl.style.transform = `translateX(${-this.ACE_PARALLAX * (1 - ratio)}px)`;
    }
  }

  swipeCommit(goBackFn) {
    if (this.swipeQueenEl) {
      this.swipeQueenEl.style.transition = "transform 268ms ease-out";
      this.swipeQueenEl.style.transform = `translateX(${window.innerWidth}px)`;
    }
    if (this.swipeAceEl) {
      this.swipeAceEl.style.transition = "transform 268ms ease-out";
      this.swipeAceEl.style.transform = "translateX(0)";
    }
    setTimeout(() => {
      goBackFn();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          this._cleanupSwipe();
        });
      });
    }, 268);
  }

  swipeCancel() {
    if (this.swipeQueenEl) {
      this.swipeQueenEl.style.transition = "transform 236ms ease-out";
      this.swipeQueenEl.style.transform = "translateX(0)";
    }
    if (this.swipeAceEl) {
      this.swipeAceEl.style.transition = "transform 236ms ease-out";
      this.swipeAceEl.style.transform = `translateX(-${this.ACE_PARALLAX}px)`;
    }
    setTimeout(() => this._cleanupSwipe(), 236);
  }

  _cleanupSwipe() {
    if (this.swipeQueenEl) { this.swipeQueenEl.remove(); this.swipeQueenEl = null; }
    if (this.swipeAceEl) { this.swipeAceEl.remove(); this.swipeAceEl = null; }
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
function captureNavState() {
  nav.captureState({
    currentTab, drawerView, projectDetailScreen, releaseDetailId,
    selectedSongId, selectedVersionId, songsView, overlayView,
    songsBackTarget, headerTitle: headerTitle?.textContent ?? "RiffBank"
  });
}
function triggerForwardSlide() { nav.forward(activeScreenEl); }

const headerTitle = $("#headerTitle");
const headerBackEl = document.getElementById("headerBack");
const toastEl = $("#toast");

// ---------------------
// Audio storage (IndexedDB) - Phase 1
// ---------------------
const AUDIO_DB = "riffbank_audio_v1";
const AUDIO_STORE = "files";
const audioUrlCache = new Map(); // localAudioId -> objectURL
const coverUrlCache = new Map(); // coverDriveFileId -> blob objectURL (persists via IndexedDB)

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
async function putCoverBlob(driveFileId, blob) {
  if (!driveFileId || !blob) return;
  const id = `cover:${driveFileId}`;
  await putAudioBlob({ id, blob, name: "cover", type: blob.type || "image/jpeg", size: blob.size });
}

async function getCoverBlobUrl(driveFileId) {
  if (!driveFileId) return null;
  if (coverUrlCache.has(driveFileId)) return coverUrlCache.get(driveFileId);
  const rec = await getAudioBlob(`cover:${driveFileId}`);
  if (rec?.blob) {
    const url = URL.createObjectURL(rec.blob);
    coverUrlCache.set(driveFileId, url);
    return url;
  }
  return null;
}

// Restore cover URLs from IndexedDB for all songs (call on startup, before render)
async function restoreCoverUrlsFromCache() {
  for (const song of (state.songs || [])) {
    if (!song.coverDriveFileId) continue;
    const url = await getCoverBlobUrl(song.coverDriveFileId);
    if (url) {
      song.coverImageUrl = url;
    } else {
      // Blob URL from previous session is dead — clear it so SVG shows instead of broken img
      if (song.coverImageUrl) song.coverImageUrl = null;
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

// In-memory set of driveFileIds known to be cached in IndexedDB
const _cachedDriveIds = new Set();

// Cache all Drive-only audio blobs into IndexedDB so they play offline forever.
// Called automatically after pull/rebuild. Shows progress toasts.
async function cacheAllDriveAudio() {
  const driveVersions = [];
  for (const song of (state.songs || [])) {
    for (const v of (song.versions || [])) {
      if (!v.driveFileId) continue;
      // Skip if already cached locally
      if (v.fileId || v.localAudioId) continue;
      if (_cachedDriveIds.has(v.driveFileId)) continue;
      try {
        const existing = await audioGet(`gdrive:${v.driveFileId}`);
        if (existing?.blob) { _cachedDriveIds.add(v.driveFileId); continue; }
      } catch {}
      driveVersions.push({ song, v });
    }
  }

  if (!driveVersions.length) {
    toast("All audio already cached locally ✅");
    return;
  }

  let done = 0;
  let failed = 0;
  toast(`Caching audio: 0/${driveVersions.length}…`);

  for (const { song, v } of driveVersions) {
    try {
      const blob = await gdriveFetchBlob(v.driveFileId);
      if (blob) {
        await audioPut({
          id: `gdrive:${v.driveFileId}`,
          blob,
          name: v.fileName || v.label || "audio",
          type: v.fileType || blob.type || "audio/*",
          size: blob.size,
        });
        _cachedDriveIds.add(v.driveFileId);
        done++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
    toast(`Caching audio: ${done + failed}/${driveVersions.length}…`);
  }

  const msg = failed
    ? `Cached ${done}/${driveVersions.length} (${failed} failed)`
    : `All ${done} tracks cached locally ✅`;
  toast(msg);
}

// Sync debug: check each version's audio availability (sync, not async — metadata only)
// Returns "green" (has local blob), "yellow" (Drive-only, needs network), "red" (no source)
function getVersionSyncColor(v) {
  if (!v) return "red";
  if (v.fileId || v.localAudioId) return "green";
  if (v.driveFileId) {
    if (_cachedDriveIds.has(v.driveFileId)) return "green";
    return "yellow";
  }
  if (v.link) return "green";
  return "red";
}

// Returns worst-case sync color across all versions of a song
function getSongSyncColor(song) {
  if (!song?.versions?.length) return "red";
  let worst = "green"; // green > yellow > red
  for (const v of song.versions) {
    const c = getVersionSyncColor(v);
    if (c === "red") return "red";
    if (c === "yellow") worst = "yellow";
  }
  return worst;
}

// Returns an HTML dot string for debug overlay (empty string if debug off)
function syncDot(song) {
  if (!window.RIFFBANK_DEBUG_SYNC) return "";
  const color = getSongSyncColor(song);
  const label = color === "green" ? "Local" : color === "yellow" ? "Drive-only" : "No audio";
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
        driveFileId: v.driveFileId ? "yes" : "",
        link: v.link ? "yes" : "",
        localBlobOk: "",
        driveCacheOk: "",
        status: getVersionSyncColor(v),
      };
      // Check if local blob actually exists in IndexedDB
      if (v.fileId) {
        try { const r = await audioGet(v.fileId); row.localBlobOk = r?.blob ? "yes" : "MISSING"; } catch { row.localBlobOk = "ERROR"; }
        if (row.localBlobOk === "MISSING") row.status = "red";
      }
      if (v.localAudioId) {
        try { const r = await getAudioBlob(v.localAudioId); row.localBlobOk = r?.blob ? "yes" : "MISSING"; } catch { row.localBlobOk = "ERROR"; }
        if (row.localBlobOk === "MISSING" && !v.fileId) row.status = v.driveFileId ? "yellow" : "red";
      }
      // Check if Drive blob is cached locally
      if (v.driveFileId) {
        try { const r = await audioGet(`gdrive:${v.driveFileId}`); row.driveCacheOk = r?.blob ? "yes" : "no"; } catch { row.driveCacheOk = "no"; }
      }
      results.push(row);
    }
  }
  console.table(results);
  const reds = results.filter(r => r.status === "red");
  const yellows = results.filter(r => r.status === "yellow");
  console.log(`[RiffBank Sync Audit] ${results.length} versions: ${reds.length} broken, ${yellows.length} Drive-only, ${results.length - reds.length - yellows.length} local`);
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
  // During back-nav, goBack() already set the header — skip redundant DOM churn
  if (nav._isBackNav) return;
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
  const highlightTab = currentTab === "songs" ? "home" : currentTab;
  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === highlightTab);
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
          <strong>RiffBank</strong> uses your <strong>Google Drive</strong> to store, manage, and release all of your in-progress songs.
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

      if (action === "connect") {
        // ── Sign in to Google ──
        btn.textContent = "SIGNING IN…";
        btn.style.pointerEvents = "none";
        btn.style.opacity = "0.6";

        await gdriveLoadGIS();
        const signIn = await gdriveSignIn();
        if (!signIn.success) {
          btn.textContent = "CONNECT GOOGLE DRIVE";
          btn.style.pointerEvents = "";
          btn.style.opacity = "";
          toast(signIn.error || "Sign-in failed — try again!");
          return;
        }

        _signedInEmail = signIn.email || "";

        // Check if there's already a RiffBank folder on Drive
        el.querySelector(".driveBubble").innerHTML =
          `Checking your <strong>Google Drive</strong>…`;
        btn.textContent = "CHECKING…";

        const existing = await gdriveFindExisting();

        if (existing.found) {
          // Existing RiffBank folder found!
          _existingFolderId = existing.folderId;
          el.querySelector(".driveBubble").innerHTML =
            `Hey, I found a <strong>RiffBank</strong> folder on your Drive! Want me to connect to it?`;
          btn.textContent = "CONNECT TO MY RIFFBANK";
          btn.style.pointerEvents = "";
          btn.style.opacity = "";
          btn.dataset.action = "connectExisting";

          const skipBtn = el.querySelector('[data-action="skip"]');
          if (skipBtn) {
            skipBtn.textContent = "Pick a different folder";
            skipBtn.dataset.action = "pick";
          }
        } else {
          // No existing folder — let user pick
          el.querySelector(".driveBubble").innerHTML =
            `Nice! Now pick a spot for your <strong>RiffBank</strong> folder — this is where all your songs, versions, and projects will live.`;
          btn.textContent = "PICK A FOLDER";
          btn.style.pointerEvents = "";
          btn.style.opacity = "";
          btn.dataset.action = "pick";

          const skipBtn = el.querySelector('[data-action="skip"]');
          if (skipBtn) skipBtn.textContent = "Skip for now";
        }
        return;
      }

      if (action === "connectExisting") {
        // ── Connect to the found RiffBank folder ──
        btn.textContent = "CONNECTING…";
        btn.style.pointerEvents = "none";
        btn.style.opacity = "0.6";

        const result = await gdriveConnectToFolder(_existingFolderId, "RiffBank", _signedInEmail);
        if (result.success) {
          resolve({ action: "connected", homeFolderName: result.homeFolderName });
        } else {
          btn.textContent = "CONNECT TO MY RIFFBANK";
          btn.style.pointerEvents = "";
          btn.style.opacity = "";
          toast(result.error || "Connection failed — try again!");
        }
        return;
      }

      if (action === "pick") {
        // ── Open folder picker (full screen) ──
        btn.textContent = "OPENING PICKER…";
        btn.style.pointerEvents = "none";
        btn.style.opacity = "0.6";

        // Hide ALL overlays + app chrome so picker is full screen
        const welcomeEl = document.getElementById("welcomeScreen");
        const topBar = document.querySelector(".topBar");
        const bottomNav = document.querySelector(".bottomNav");
        el.style.display = "none";
        if (welcomeEl) welcomeEl.style.display = "none";
        if (topBar) topBar.style.display = "none";
        if (bottomNav) bottomNav.style.display = "none";

        // Show Sal PiP floating overlay while picker is open
        const pip = document.createElement("div");
        pip.className = "salPip";
        pip.innerHTML = `
          <div class="salPipBubble">Pick a folder for <strong>RiffBank</strong>!</div>
          ${salSvg(56)}
        `;
        document.body.appendChild(pip);
        requestAnimationFrame(() => pip.classList.add("salPipIn"));

        const result = await gdrivePickHome(_signedInEmail);

        // Restore everything
        el.style.display = "";
        if (welcomeEl) welcomeEl.style.display = "";
        if (topBar) topBar.style.display = "";
        if (bottomNav) bottomNav.style.display = "";

        // Remove PiP
        pip.classList.add("salPipOut");
        pip.addEventListener("animationend", () => pip.remove(), { once: true });

        if (result.success) {
          resolve({ action: "connected", homeFolderName: result.homeFolderName });
        } else {
          // User cancelled picker — let them try again
          btn.textContent = "PICK A FOLDER";
          btn.style.pointerEvents = "";
          btn.style.opacity = "";
        }
      }
    });

    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("welcomeIn"));
  });
}

// Sal mascot button — opens help sheet
document.querySelector(".salNavBtn")?.addEventListener("click", () => openSalSheet());
// Inject Sal PNG into nav icon
{ const navIcon = document.querySelector(".salNavIcon");
  if (navIcon) navIcon.innerHTML = salSvg(26); }

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
function openSalOnboarding() {
  if (localStorage.getItem("salOnboardingDone")) return;
  if (state.songs?.length) { localStorage.setItem("salOnboardingDone", "1"); return; }

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
        RiffBank keeps all your songs, versions, and projects safe in <strong style="color:#fff;">Google Drive</strong> — record on any device and access your music anywhere.
      </div>
    </div>
    <div style="height:1px;background:rgba(255,255,255,.08);margin:0 16px;"></div>
    <div style="padding:8px 0 6px;display:flex;flex-direction:column;">
      <button class="actionSheetBtn" id="salConnectDrive" style="font-weight:700;">Hi Sal! Yes, connect my Google Drive!</button>
      <button class="actionSheetBtn" id="salDismiss" style="color:rgba(255,255,255,.4);font-size:13px;">Hi Sal! I don't need you, I can do this MYSELF</button>
    </div>
  `;

  function close() { backdrop.remove(); sheet.remove(); localStorage.setItem("salOnboardingDone", "1"); }

  backdrop.addEventListener("click", close);

  sheet.querySelector("#salConnectDrive")?.addEventListener("click", async () => {
    toast("Connecting to Google Drive…");
    const result = await gdriveConnect();
    if (result.success) {
      state.settings.driveRoot = result.homeFolderName || "RiffBank";
      saveState();
      toast("Connected to Google Drive! Sal approves.");
      close();
      // Kick off sync now that we're connected
      incrementalSyncFromDrive().then(() => {
        render();
        syncMiniPlayerUI();
        preFetchDriveAudio().catch(console.warn);
      }).catch(console.warn);
    } else {
      toast(result.error || "Connection failed — try again!");
    }
  });

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
      nav.jumpHome(activeScreenEl, () => {
        songsBackTarget = null;
        drawerView = null;
        overlayView = null;
        selectedSongId = null;
        selectedVersionId = null;
        projectDetailScreen = null;
        releaseDetailId = null;
        songsView = "list";
        songsListScrollTop = 0;
        currentTab = "home";
        if (screens.home) screens.home.scrollTop = 0;
        try { window.scrollTo(0, 0); } catch {}
        try { document.documentElement.scrollTop = 0; } catch {}
        try { document.body.scrollTop = 0; } catch {}
        syncTabs();
        setHeader("RiffBank");
        render();
      });
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
    nav.jumpHome(activeScreenEl, resetToHome);
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
  nav.back(activeScreenEl, renderUnderneath);
}

function goBack({ animate = false } = {}) {
  const doRender = () => {
    if (drawerOpen) { closeDrawer(); return; }

    // Resolve the state to restore: animated backs already popped in nav.back()
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
      songsBackTarget = restoreState.songsBackTarget;
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

  if (touchMode === "back") {
    nav.swipeStart(activeScreenEl);
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
    nav.swipeMove(dx);
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

    if (dx >= threshold) {
      nav.swipeCommit(() => goBack({ animate: false }));
    } else {
      nav.swipeCancel();
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

  if (sheetMode === "songDetailMenu") {
    const song = getSong(sheetSongMenuId);
    if (!song) { closeSheet(); return; }
    const fv = featuredVersion(song);
    const title = song?.title || "Song";
    const canGenArt = !generatingArtSongs.has(song.id) && Date.now() >= artCooldownUntil;
    const artLabel = generatingArtSongs.has(song.id) ? "Generating..." : song.coverImageUrl ? "Regen Art" : "Gen Art";
    const hasApiKey = !!(state.settings.replicateKey || "");

    sheetContent.innerHTML = `
      <div class="sheetTitle">${escapeHtml(title)}</div>

      <div class="sheetForm" style="gap:10px">
        <button class="sheetChoice" id="sdmDetails">Details</button>
        <button class="sheetChoice" id="sdmQueue" ${(fv?.link || fv?.fileId || fv?.localAudioId || fv?.driveFileId) ? "" : "disabled"}>Add to Queue</button>
        <button class="sheetChoice" id="sdmGenArt" ${canGenArt && hasApiKey ? "" : "disabled"}>${escapeHtml(artLabel)}</button>
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
        captureNavState();
        selectedVersionId = first.id;
        render();
        triggerForwardSlide();
        return;
      }
      captureNavState();
      selectedVersionId = fv.id;
      render();
      triggerForwardSlide();
    });

    $("#sdmQueue")?.addEventListener("click", () => {
      if (fv) addToQueue(song.id, fv.id);
      closeSheet();
    });

    $("#sdmGenArt")?.addEventListener("click", async () => {
      if (!canGenArt) return;
      const apiKey = state.settings.replicateKey || "";
      if (!apiKey) { toast("Add your Replicate API key in Settings first"); return; }

      closeSheet();
      generatingArtSongs.add(song.id);
      artCooldownUntil = Date.now() + 10000;
      coverCache.clear();
      render();

      try {
        await generateArtForSong(song, apiKey);
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

    $("#sdmDelete")?.addEventListener("click", () => {
      if (!confirm(`Delete "${song.title}"?`)) return;
      state.songs = state.songs.filter(s => s.id !== song.id);
      saveState();
      toast("Deleted");
      closeSheet();
      selectedSongId = null;
      selectedVersionId = null;
      songsView = "list";
      setHeader("Songs");
      render();
    });

    $("#sdmCancel")?.addEventListener("click", () => closeSheet());

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

function openCreateOverlay() {
  if (createOverlayEl) return;

  createTab = "song";
  createGenreSearch = "";
  createSelectedGenres = [];
  createSelectedProject = "";
  createGenreDropdownOpen = false;

  createOverlayEl = document.createElement("div");
  createOverlayEl.id = "createOverlay";
  createOverlayEl.className = "createOverlay";
  document.body.appendChild(createOverlayEl);

  requestAnimationFrame(() => {
    createOverlayEl?.classList.add("open");
  });

  renderCreateOverlay();
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

  const existingProjects = [...new Set(
    state.songs.map(s => (s.project || "").trim()).filter(Boolean)
  )].sort();

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

    contentHTML = `
      <div class="coField">
        <label class="coLabel">Title</label>
        <input id="coTitle" class="coInput" type="text" placeholder="e.g. Dinosaur Uprising" autocomplete="off" />
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
    createOverlayEl.querySelector("#coCreateSong")?.addEventListener("click", () => {
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

      state.songs.unshift(song);
      saveState();
      toast("Created");

      closeCreateOverlay();
      currentTab = "songs";
      songsView = "list";
      selectedSongId = song.id;
      setHeader("Song");
      syncTabs();
      render();
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
  if (drawerView === "projects") { setActiveScreen("drawer"); if (!_isBack) activeScreenEl.scrollTop = 0; return projectDetailScreen ? renderProjectSongs(projectDetailScreen) : renderProjects(); }
  if (drawerView === "releases") { setActiveScreen("drawer"); if (!_isBack) activeScreenEl.scrollTop = 0; return releaseDetailId ? renderReleaseDetail(releaseDetailId) : renderReleases(); }
  if (drawerView === "eps") { setActiveScreen("drawer"); if (!_isBack) activeScreenEl.scrollTop = 0; return renderEPs(); }
  if (drawerView === "collabs") { setActiveScreen("drawer"); if (!_isBack) activeScreenEl.scrollTop = 0; return renderCollaborators(); }
  if (drawerView === "importExport") { setActiveScreen("drawer"); if (!_isBack) activeScreenEl.scrollTop = 0; return renderImportExport(); }
  if (drawerView === "about") { setActiveScreen("drawer"); if (!_isBack) activeScreenEl.scrollTop = 0; return renderAbout(); }
  if (drawerView === "globalSearch") { setActiveScreen("drawer"); if (!_isBack) activeScreenEl.scrollTop = 0; return renderGlobalSearch(); }

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
    setActiveScreen("songs");
    if (!_isBack) activeScreenEl.scrollTop = 0;
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
      if (existing?.blob) { _cachedDriveIds.add(v.driveFileId); continue; }
      const blob = await gdriveFetchBlob(v.driveFileId);
      if (blob) {
        _cachedDriveIds.add(v.driveFileId);
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

  // Welcome screen (after splash, before app loads)
  if (!DISABLE_WELCOME) {
    let welcomeAction = await showWelcomeScreen();

    // "GET STARTED" → show Drive connect screen (handles sign-in + picker)
    let driveConnected = false;
    let driveFolderName = "";
    if (welcomeAction === "getStarted") {
      let driveResult = { action: "back" };
      while (driveResult.action === "back") {
        driveResult = await showDriveScreen();
        if (driveResult.action === "back") {
          welcomeAction = await showWelcomeScreen();
          if (welcomeAction === "hasAccount") break;
        }
      }
      if (driveResult.action === "connected") {
        driveConnected = true;
        driveFolderName = driveResult.homeFolderName || "RiffBank";
      }
    }

    localStorage.setItem("salOnboardingDone", "1");
    if (welcomeAction === "hasAccount" && !driveConnected) {
      // "I already have an account" — use original connect flow
      gdriveLoadGIS();
      toast("Connecting to Google Drive…");
      const result = await gdriveConnect();
      if (result.success) {
        state.settings.driveRoot = result.homeFolderName || "RiffBank";
        saveState();
        toast("Connected! Syncing your library…");
      }
    } else if (driveConnected) {
      // Already connected via drive screen
      state.settings.driveRoot = driveFolderName;
      saveState();
      toast("Connected! Syncing your library…");
      gdriveLoadGIS();
    } else {
      gdriveLoadGIS();
    }
  } else {
    // No welcome screen — remove splashing class so app shell is visible
    document.body.classList.remove("splashing");
    // Load Google Identity Services (non-blocking, for Drive integration)
    gdriveLoadGIS();
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

  // Render immediately so user sees the home screen right after welcome
  setHeader("RiffBank");
  syncTabs();
  render();
  syncMiniPlayerUI();

  // Now that the home screen is painted, fade out any remaining onboarding overlays
  dismissOnboarding();

  // Background: restore cover art, scan cached blobs, sync Drive (non-blocking)
  restoreCoverUrlsFromCache().then(() => render()).catch(() => {});

  (async () => {
    for (const song of (state.songs || [])) {
      for (const v of (song.versions || [])) {
        if (!v.driveFileId || v.fileId || v.localAudioId) continue;
        try {
          const rec = await audioGet(`gdrive:${v.driveFileId}`);
          if (rec?.blob) _cachedDriveIds.add(v.driveFileId);
        } catch {}
      }
    }
  })();

  if (gdriveIsConnected()) {
    incrementalSyncFromDrive().then(() => {
      preFetchDriveAudio().catch(console.warn);
    }).catch(console.warn);
  }
}

// Incremental sync: pull Drive state JSON and merge only new/changed songs
async function incrementalSyncFromDrive() {
  const driveState = await gdrivePullStateSilent();
  if (!driveState?.songs?.length) return;

  const localHasSongs = state.songs && state.songs.length > 0;

  if (!localHasSongs) {
    // Local is empty — adopt Drive state wholesale
    state.songs = driveState.songs;
    state.releases = driveState.releases || state.releases;
    normalizeState();
    await restoreCoverUrlsFromCache();
    saveState();
    coverCache.clear();
    render();
    toast("Loaded library from Drive");
    return;
  }

  // Build lookup of local songs by title+project (stable identity)
  const localByKey = new Map();
  for (const s of state.songs) {
    localByKey.set(`${(s.title || "").trim()}|${(s.project || "").trim()}`, s);
  }

  let added = 0, updated = 0;

  for (const ds of driveState.songs) {
    const key = `${(ds.title || "").trim()}|${(ds.project || "").trim()}`;
    const local = localByKey.get(key);

    if (!local) {
      // New song from Drive — add it
      state.songs.push(ds);
      added++;
    } else {
      // Existing song — check if Drive version is newer
      const localTime = new Date(local.updatedAt || 0).getTime();
      const driveTime = new Date(ds.updatedAt || 0).getTime();
      if (driveTime > localTime) {
        // Merge: update metadata but preserve local-only fields
        const preserveFields = ["_coverResolving"];
        for (const f of preserveFields) {
          if (local[f] !== undefined) ds[f] = local[f];
        }
        Object.assign(local, ds);
        updated++;
      }
      // Merge cover art if local is missing it
      if (!local.coverDriveFileId && ds.coverDriveFileId) {
        local.coverDriveFileId = ds.coverDriveFileId;
        updated++;
      }
    }
  }

  if (added || updated) {
    normalizeState();
    // Restore covers for any newly added songs
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

  const projects = Array.from(
    new Set([
      ...(state.settings?.defaultProject ? [state.settings.defaultProject.trim()] : []),
      ...state.songs.map(s => (s.project || "").trim()).filter(Boolean)
    ])
  ).sort((a, b) => a.localeCompare(b));

  let projQuery = "";

  const buildCards = (q) => projects
    .filter(p => !q || p.toLowerCase().includes(q.toLowerCase()))
    .map((p, i) => {
      const projSongs = state.songs.filter(s => (s.project || "").trim() === p);
      const count = projSongs.length;
      const isDefault = (state.settings.defaultProject || "").trim() === p;
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
                ${isDefault ? `<span class="pill good">Default</span>` : ""}
              </div>
            </div>
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
    <div id="projList" class="pGrid">
      ${buildCards("") || `<div class="small" style="grid-column:1/-1">No projects yet.</div>`}
    </div>
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
      captureNavState();
      projectDetailScreen = projName;
      render();
      triggerForwardSlide();
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
}

function renderProjectSongs(projectName) {
  setHeader(projectName);
  const appEl = document.querySelector(".app");
  appEl?.classList.add("pdActive");
  appEl?.classList.remove("pdScrolled");
  // Kill screen bottom padding so sticky panel can't scroll past top
  activeScreenEl.style.paddingBottom = "0px";
  // Measure topbar height so sticky panel sits below it
  const topbarEl = document.querySelector(".topbar");
  const topbarH = topbarEl ? topbarEl.offsetHeight : 0;
  activeScreenEl.style.setProperty("--pd-topbar-h", topbarH + "px");

  if (activeScreenEl) {
    activeScreenEl.scrollTop = 0;
    activeScreenEl.style.overflowY = "scroll";
  }

  const songs = state.songs.filter(s => (s.project || "").trim() === projectName);

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
      row.addEventListener("click", (e) => {
        if (e.target.closest("[data-proj-song-more]")) return;
        captureNavState();
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
      // Force pdTabBody content to overflow so iOS elastic scroll works
      const tb = activeScreenEl.querySelector(".pdTabBody");
      const sl = tb?.querySelector(".pdSongList, .pdPlaceholder");
      if (tb && sl) sl.style.minHeight = (tb.clientHeight + 1) + "px";
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
      captureNavState();
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
      captureNavState();
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
  activeScreenEl.querySelector("#htbNotif")?.addEventListener("click", () => toast("Notifications coming soon"));
  activeScreenEl.querySelector("#htbSearch")?.addEventListener("click", () => {
    drawerView = "globalSearch";
    setActiveScreen("drawer");
    renderGlobalSearch();
  });
  activeScreenEl.querySelector("#htbSettings")?.addEventListener("click", () => {
    captureNavState();
    currentTab = "settings";
    setHeader("Settings");
    syncTabs();
    render();
    triggerForwardSlide();
  });

  // Card navigation
  activeScreenEl.querySelectorAll("[data-home]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-home");
      captureNavState();
      if (target === "songs") {
        resetSongsFilters({ keepSort: true });
        songsBackTarget = null;
        songsListScrollTop = 0;
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
      captureNavState();
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
  // Try IndexedDB cache first (no auth needed)
  let url = await getCoverBlobUrl(driveFileId);
  // Fall back to fetching from Drive and caching
  if (!url) {
    const blob = await gdriveFetchBlob(driveFileId);
    if (blob) {
      await putCoverBlob(driveFileId, blob);
      url = URL.createObjectURL(blob);
      coverUrlCache.set(driveFileId, url);
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
// Fallback: if cover URL is broken (expired Replicate URL, no Drive backup), clear it so SVG art shows
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
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 60000);
  let res;
  try {
    res = await fetch("https://riffbank-art.riffbank.workers.dev", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { prompt, aspect_ratio: "1:1" } }),
      signal: ac.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Request timed out — try again");
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

  // Download image and upload to Google Drive for persistence
  try {
    console.log("[ArtGen] Fetching image...");
    const imgRes = await fetch(url);
    console.log("[ArtGen] Image fetch done:", imgRes.status);
    if (imgRes.ok) {
      const blob = await imgRes.blob();
      console.log("[ArtGen] Uploading to Drive...");
      const driveResult = await gdriveUploadCoverArt({
        blob,
        project: song.project,
        songTitle: song.title,
      });
      console.log("[ArtGen] Drive upload result:", driveResult);
      if (driveResult.success) {
        song.coverDriveFileId = driveResult.driveFileId;
        // Cache the blob locally so it persists across restarts
        await putCoverBlob(driveResult.driveFileId, blob);
        const cachedUrl = URL.createObjectURL(blob);
        coverUrlCache.set(driveResult.driveFileId, cachedUrl);
        url = cachedUrl;
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
      : ` onerror="this.onerror=null;window._clearBrokenCover&&window._clearBrokenCover('${escapeHtml(song.id)}',this)"`;

    const img = `<img src="${escapeHtml(song.coverImageUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block" decoding="sync" alt=""${errHandler}>`;
    coverCache.set(key, img);
    return img;
  }

  // coverImageUrl is missing but Drive file exists — resolve from IDB cache or Drive
  if (song.coverDriveFileId && !song._coverResolving) {
    song._coverResolving = true;
    (async () => {
      // Try local IndexedDB cache first (no auth needed)
      let url = await getCoverBlobUrl(song.coverDriveFileId);
      // Fall back to fetching from Drive and caching
      if (!url) {
        const blob = await gdriveFetchBlob(song.coverDriveFileId);
        if (blob) {
          await putCoverBlob(song.coverDriveFileId, blob);
          url = URL.createObjectURL(blob);
          coverUrlCache.set(song.coverDriveFileId, url);
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

  const songs = [...state.songs];
  const projects = Array.from(
    new Set([
      ...(state.settings?.defaultProject ? [state.settings.defaultProject.trim()] : []),
      ...state.songs.map((s) => (s.project || "").trim()).filter(Boolean),
    ])
  ).sort((a, b) => a.localeCompare(b));

  activeScreenEl.innerHTML = `
    <div class="songsPageTitle">Songs</div>
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
        captureNavState();
        songsListScrollTop = activeScreenEl.scrollTop;
        selectedSongId = el.getAttribute("data-id");
        render();
        triggerForwardSlide();
      });
    });

    listEl.querySelectorAll(".songsGroupHead[data-artist]").forEach((el) => {
      el.addEventListener("click", () => {
        const artist = el.getAttribute("data-artist");
        if (!artist) return;
        captureNavState();
        drawerView = "projects";
        projectDetailScreen = artist;
        render();
        triggerForwardSlide();
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

function renderSongDetail(id) {
  const song = getSong(id);
  if (!song) {
    selectedSongId = null;
    selectedVersionId = null;
    return renderSongsList();
  }

  setHeader(song.title);
  const appEl = document.querySelector(".app");
  appEl?.classList.add("pdActive");
  appEl?.classList.remove("pdScrolled");
  activeScreenEl.style.paddingBottom = "0px";
  const topbarEl = document.querySelector(".topbar");
  const topbarH = topbarEl ? topbarEl.offsetHeight : 0;
  activeScreenEl.style.setProperty("--pd-topbar-h", topbarH + "px");

  if (activeScreenEl) {
    activeScreenEl.scrollTop = 0;
    activeScreenEl.style.overflowY = "scroll";
  }

  const fv = featuredVersion(song);
  const vCount = song.versions?.length || 0;
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
    const sub = v.isActive
      ? `${activeCheck}<span style="color:#a855f7;font-weight:600">Active</span>${v.notes ? ` · ${escapeHtml(v.notes)}` : ""}`
      : `${escapeHtml(v.createdAt || "—")}${v.notes ? ` · ${escapeHtml(v.notes)}` : ""}`;

    return `
      <div class="pdSongRow" data-vrow="${v.id}">
        <span class="pdSongNum">${i + 1}</span>
        <div class="songThumb" aria-hidden="true">
          ${rowCover}
        </div>
        <div class="songMain">
          <div class="songTop">
            <div class="songTitleRow">
              <div class="songTitle">${escapeHtml(v.label || "Version")}</div>
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
        <div class="pdHeroMeta">${escapeHtml(song.project || "—")} · ${vCount} version${vCount === 1 ? "" : "s"}</div>
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
    captureNavState();
    selectedVersionId = newV.id;
    render();
    triggerForwardSlide();
  });

  /* ── Version row listeners ── */
  function attachVersionListeners() {
    activeScreenEl.querySelectorAll("[data-vrow]").forEach(row => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("[data-vmore]")) return;
        captureNavState();
        selectedVersionId = row.getAttribute("data-vrow");
        render();
        triggerForwardSlide();
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
      const tb = activeScreenEl.querySelector(".pdTabBody");
      const sl = tb?.querySelector(".pdSongList, .pdPlaceholder");
      if (tb && sl) sl.style.minHeight = (tb.clientHeight + 1) + "px";
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
      selectedVersionId = versionId;
      render();
      triggerForwardSlide();
    } else if (action === "notes") {
      selectedVersionId = versionId;
      render();
      triggerForwardSlide();
    }
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
      <h2>Debug Tools</h2>
      <div class="row" style="gap:10px; align-items:center">
        <button id="toggleSyncDebug" class="btn" style="flex:1; ${window.RIFFBANK_DEBUG_SYNC ? "background:rgba(78,205,196,.12); border-color:rgba(78,205,196,.3); color:#4ecdc4" : ""}">${window.RIFFBANK_DEBUG_SYNC ? "Sync Debug: ON" : "Sync Debug: OFF"}</button>
        <button id="runSyncAudit" class="btn" style="flex:1">Run Sync Audit</button>
      </div>
      <div class="small" style="margin-top:4px">
        Sync Debug shows colored dots on song cards:
        <span style="color:#4ade80">●</span> local audio
        <span style="color:#facc15">●</span> Drive-only
        <span style="color:#f87171">●</span> no audio
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
      toast("Synced from Drive — caching audio…");
      render();
      await cacheAllDriveAudio();
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

    // Merge cover art from saved state JSON for songs missing cover.jpg on disk
    try {
      const driveState = await gdrivePullStateSilent();
      if (driveState && driveState.songs) {
        for (const song of songs) {
          if (song.coverDriveFileId) continue; // folder scan found cover.jpg
          const match = driveState.songs.find(
            s => s.title === song.title && s.project === song.project
          );
          if (match) {
            if (match.coverDriveFileId) song.coverDriveFileId = match.coverDriveFileId;
            if (match.coverImageUrl) song.coverImageUrl = match.coverImageUrl;
          }
        }
      }
    } catch (e) {
      console.warn("Could not merge cover art from state JSON:", e);
    }

    // Resolve cover art Drive IDs — try local cache first, then fetch & cache
    for (const song of songs) {
      if (song.coverDriveFileId) {
        let url = await getCoverBlobUrl(song.coverDriveFileId);
        if (!url) {
          const blob = await gdriveFetchBlob(song.coverDriveFileId);
          if (blob) {
            await putCoverBlob(song.coverDriveFileId, blob);
            url = URL.createObjectURL(blob);
            coverUrlCache.set(song.coverDriveFileId, url);
          }
        }
        if (url) song.coverImageUrl = url;
      }
    }

    state.songs = songs;
    normalizeState();
    saveState();
    toast(`Rebuilt ${songs.length} songs — caching audio…`);
    render();
    await cacheAllDriveAudio();
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
    let msg = `${results.length} versions: ${greens} local, ${yellows.length} Drive-only, ${reds.length} broken`;
    if (reds.length) msg += `\n\nBroken:\n${reds.map(r => `• ${r.song} / ${r.version}`).join("\n")}`;
    alert(msg);
  });

  $("#wipe").addEventListener("click", async () => {
    if (!confirm("Wipe all local RiffBank data on this browser?")) return;

    localStorage.removeItem(LS_KEY);
    localStorage.removeItem("salOnboardingDone");
    state = loadState();
    normalizeState();
    // Save locally only — do NOT sync empty state to Drive
    localStorage.setItem(LS_KEY, JSON.stringify(state));

    currentTab = "home";
    drawerView = null;
    overlayView = null;
    setHeader("RiffBank");

    if (screens.home) screens.home.scrollTop = 0;
    try { window.scrollTo(0, 0); } catch {}
    try { document.documentElement.scrollTop = 0; } catch {}
    try { document.body.scrollTop = 0; } catch {}

    render();

    // Replay splash like a fresh start, then show Sal onboarding
    await replaySplash();
    document.body.classList.remove("splashing");
    openSalOnboarding();
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

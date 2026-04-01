// Nav class — manages all screen transitions, swipe gestures, and nav history
// Extracted from app.js — pure DOM manipulation, no app-level dependencies

// ---------------------
// All forward/back slide transitions, swipe gestures, and nav history
// live here. Call nav.forward(screenEl) / nav.back(screenEl, renderFn)
// instead of wiring up transition logic at each call site.
export class Nav {
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
      console.log("[VT] starting forward transition");
      const transition = document.startViewTransition(() => {
        console.log("[VT] mutate callback running");
        mutate();
        this._transitionActive = false;
        console.log("[VT] mutate done");
      });
      transition.ready.then(() => console.log("[VT] ready — animating")).catch(e => console.warn("[VT] ready rejected:", e.message));
      transition.finished.then(() => console.log("[VT] finished OK")).catch(e => console.warn("[VT] finished rejected:", e.message)).finally(() => docEl.classList.remove(vtClass));
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
      console.log("[VT] starting back transition");
      const transition = document.startViewTransition(() => {
        console.log("[VT] back mutate running");
        mutate();
        this._transitionActive = false;
        console.log("[VT] back mutate done");
        // Restore scroll so the API captures the correct scroll position
        const screen = document.querySelector(".screen.is-active");
        if (aceScrollTop && screen) screen.scrollTop = aceScrollTop;
      });
      transition.ready.then(() => console.log("[VT] back ready — animating")).catch(e => console.warn("[VT] back ready rejected:", e.message));
      transition.finished.then(() => console.log("[VT] back finished OK")).catch(e => console.warn("[VT] back finished rejected:", e.message)).finally(() => docEl.classList.remove(vtClass));
    }

    else if (direction === "jumpHome") {
      this.clearStacks();

      if (noVT) { mutate(); return; }

      docEl.classList.add(vtClass);
      const transition = document.startViewTransition(() => mutate());
      transition.finished.catch(() => {}).finally(() => docEl.classList.remove(vtClass));
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
    const restoredScreen = document.querySelector(".screen.is-active");
    if (aceScrollTop && restoredScreen) restoredScreen.scrollTop = aceScrollTop;

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


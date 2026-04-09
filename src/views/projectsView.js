import { R } from "../router.js";
import { ctx } from "../appContext.js";
import { state, saveState, getSong, isPlayable, sharedData } from "../state.js";
import { toast } from "../ui/toast.js";
import { $, escapeHtml } from "../ui/dom.js";
import { coverSvg } from "../ui/coverArt.js";
import { sharedBadge, sharedBadgeProject, syncDot } from "../ui/syncBadges.js";

export function renderProjects() {
  ctx.setHeader("Projects");
  const appEl = document.querySelector(".app");
  appEl?.classList.add("collapseTitle");
  const h1 = appEl?.querySelector(".titleblock h1");
  if (h1) h1.style.opacity = "0";

  // Shared projects — include projects from individually shared songs too
  const sharedProjectNames = Array.from(new Set([
    ...(sharedData.projects || []).map(sp => sp.projectName).filter(Boolean),
    ...(sharedData.songs || []).map(ss => (ss.song?.project || "").trim()).filter(Boolean),
  ]));
  const _sharedProjSet = new Set(sharedProjectNames);

  const pOwner = ctx.getProjectsOwnerFilter() || "all";

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

  // Get shared songs for a project name (from shared projects + individually shared songs)
  const _sharedSongsForProj = (projName) => {
    const fromProj = (sharedData.projects || []).find(sp => sp.projectName === projName)?.songs || [];
    const fromSongs = (sharedData.songs || [])
      .filter(ss => (ss.song?.project || "").trim() === projName)
      .map(ss => ss.song);
    // Dedupe by id
    const seen = new Set(fromProj.map(s => s.id));
    return [...fromProj, ...fromSongs.filter(s => !seen.has(s.id))];
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
        <div class="pCard${ctx.nav._isBackNav ? " noAnim" : ""}" data-open-proj="${escapeHtml(p)}" style="${ctx.nav._isBackNav ? "" : `animation-delay:${i * 60}ms`}">
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
              <div class="pNameRow"><div class="pName">${escapeHtml(p)}</div>${sharedBadgeProject(p)}</div>
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

  ctx.getActiveScreenEl().innerHTML = `
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
      ctx.navigateForward(() => {
        R.projectDetailScreen = projName;
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
  const pDropBtn = ctx.getActiveScreenEl().querySelector(".ownerDropBtn");
  const pDropWrap = ctx.getActiveScreenEl().querySelector(".ownerDropWrap");
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
        ctx.setProjectsOwnerFilter(item.getAttribute("data-owner") || "all");
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
    ctx.render();
    toast("Project created");
  });

  // Collapse title: fade small title in as big title scrolls behind topbar
  if (ctx.getActiveScreenEl()._collapseTitleScroll) {
    ctx.getActiveScreenEl().removeEventListener("scroll", ctx.getActiveScreenEl()._collapseTitleScroll);
    ctx.getActiveScreenEl()._collapseTitleScroll = null;
  }
  const _screen = ctx.getActiveScreenEl();
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

export function renderProjectSongs(projectName) {
  ctx.setHeader(projectName);
  // Hide topbar title — the hero has its own large title
  const _tbH1 = document.querySelector(".topbar h1");
  if (_tbH1) _tbH1.textContent = "";
  const appEl = document.querySelector(".app");
  appEl?.classList.add("pdActive");
  appEl?.classList.remove("pdScrolled");
  // Kill screen bottom padding so sticky panel can't scroll past top
  ctx.getActiveScreenEl().style.paddingBottom = "0px";
  // Measure topbar height so sticky panel sits below it
  const topbarEl = document.querySelector(".topbar");
  const topbarH = topbarEl ? topbarEl.offsetHeight : 0;
  ctx.getActiveScreenEl().style.setProperty("--pd-topbar-h", topbarH + "px");

  ctx.getActiveScreenEl().style.overflowY = "scroll";

  // In collab mode, merge songs from all shared sources for this project; otherwise use local + shared songs
  let songs;
  if (R.collabMode) {
    const _seen = new Set();
    const _merged = [];
    // Songs from projects shared WITH me
    for (const sp of (sharedData.projects || [])) {
      if (sp.projectName === projectName) {
        for (const s of sp.songs) { if (!_seen.has(s.id)) { _seen.add(s.id); _merged.push({ ...s, _shared: true, _sharedBy: sp.ownerName || "Someone" }); } }
      }
    }
    // Individual songs shared WITH me
    for (const ss of (sharedData.songs || [])) {
      if ((ss.song?.project || "").trim() === projectName && !_seen.has(ss.song.id)) {
        _seen.add(ss.song.id); _merged.push({ ...ss.song, _shared: true, _sharedBy: ss.ownerName || "Someone" });
      }
    }
    // Songs from projects I shared (local songs)
    for (const mp of (sharedData.myProjects || [])) {
      if (mp.projectName === projectName) {
        for (const s of state.songs.filter(x => (x.project || "").trim() === projectName)) {
          if (!_seen.has(s.id)) { _seen.add(s.id); _merged.push(s); }
        }
      }
    }
    // Individual songs I shared
    for (const ms of (sharedData.mySongs || [])) {
      if ((ms.projectName || "").trim() === projectName) {
        const s = state.songs.find(x => x.id === ms.songId);
        if (s && !_seen.has(s.id)) { _seen.add(s.id); _merged.push(s); }
      }
    }
    songs = _merged;
  } else {
    const ownSongs = state.songs.filter(s => (s.project || "").trim() === projectName);
    const ownIds = new Set(ownSongs.map(s => s.id));
    const sharedSongsForProj = [
      ...(sharedData.songs || []).filter(ss => (ss.song?.project || "").trim() === projectName).map(ss => ({ ...ss.song, _shared: true, _sharedBy: ss.ownerName || "Someone" })),
      ...(sharedData.projects || []).filter(sp => sp.projectName === projectName).flatMap(sp => (sp.songs || []).map(s => ({ ...s, _shared: true, _sharedBy: sp.ownerName || "Someone" }))),
    ].filter(s => !ownIds.has(s.id));
    songs = [...ownSongs, ...sharedSongsForProj];
  }

  // Ensure shared songs are in the cache so getSong() can find them
  {
    if (!state._sharedSongsCache) state._sharedSongsCache = [];
    for (const s of songs) {
      if (s._shared && !state._sharedSongsCache.find(cs => cs.id === s.id)) {
        state._sharedSongsCache.push(s);
      }
    }
  }

  const items = songs
    .filter(s => (s.versions || []).length)
    .map(s => {
      const vv = s.versions.find(v => v.isActive && isPlayable(v))
              || s.versions.find(v => isPlayable(v))
              || s.versions[0];
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
              <div class="songTitleBadge"><div class="songTitle">${escapeHtml(s.title || "Untitled")}</div>${sharedBadge(s)}</div>
            </div>
            <button class="songMore" data-proj-song-more="${s.id}" aria-label="Song menu">&#x22EF;</button>
          </div>
          <div class="songSub">${escapeHtml(s.genre || "—")}</div>
        </div>
      </div>
    `;
  }).join("");

  ctx.getActiveScreenEl().innerHTML = `
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
  ctx.getActiveScreenEl().scrollTop = 0;

  /* ── Tab switching ── */
  const tabBody = $("#pdTabBody");
  ctx.getActiveScreenEl().querySelectorAll(".pdTab").forEach(tab => {
    tab.addEventListener("click", () => {
      ctx.getActiveScreenEl().querySelectorAll(".pdTab").forEach(t => t.classList.remove("pdTabActive"));
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
    ctx.getActiveScreenEl().querySelectorAll("[data-open-song]").forEach(row => {
      let longPressTimer = null;
      let didLongPress = false;

      row.addEventListener("touchstart", () => {
        didLongPress = false;
        longPressTimer = setTimeout(() => {
          didLongPress = true;
          navigator.vibrate?.(30);
          const sid = row.getAttribute("data-open-song");
          if (sid) ctx.openSongMenu(sid);
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

    ctx.getActiveScreenEl().querySelectorAll("[data-proj-song-more]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        ctx.openSongMenu(btn.getAttribute("data-proj-song-more"));
      });
    });
  }

  attachSongListeners();

  /* ── Fade hero + actions to black, solid topbar as user scrolls ── */
  const heroEl = ctx.getActiveScreenEl().querySelector(".pdHero");
  const heroBgEl = heroEl?.querySelector(".pdHeroBg");
  const heroContentEl = heroEl?.querySelector(".pdHeroContent");
  const actionsEl = ctx.getActiveScreenEl().querySelector(".pdActions");
  const stickyEl = ctx.getActiveScreenEl().querySelector(".pdSticky");
  if (stickyEl && heroEl) {
    let maxScroll = 0;
    const FADE_PX = 200;
    requestAnimationFrame(() => {
      maxScroll = ctx.getActiveScreenEl().scrollHeight - ctx.getActiveScreenEl().clientHeight;
    });

    ctx.getActiveScreenEl().addEventListener("scroll", () => {
      const scrolled = ctx.getActiveScreenEl().scrollTop;
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
        const screenTop = ctx.getActiveScreenEl().getBoundingClientRect().top;
        if (heroBottom - screenTop < 60) {
          appEl.classList.add("pdScrolled");
        } else {
          appEl.classList.remove("pdScrolled");
        }
      }
    }, { passive: true });
  }
}

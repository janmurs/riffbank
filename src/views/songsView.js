import { R } from "../router.js";
import { ctx } from "../appContext.js";
import { state, saveState, getSong, getVersion, featuredVersion, isPlayable } from "../state.js";
import { toast } from "../ui/toast.js";
import { $, escapeHtml, uid, nowStamp, shuffleArray } from "../ui/dom.js";
import { coverSvg, coverCache } from "../ui/coverArt.js";
import { sharedBadge, sharedBadgeProject, syncDot } from "../ui/syncBadges.js";
import { sharedData } from "../state.js";
import { autoGenerateArt } from "../ui/coverArtOps.js";
import { audioPut, audioGet, audioDelete, getAudioBlob, putAudioBlob, compressAudioForUpload } from "../audio/audioDB.js";
import { supabaseUploadAudio, supabaseDeleteAudio } from "../supabase.js";

export function renderSongsList() {
  console.log("[renderSongsList] START, ownerFilter:", ctx.getSongsListState().ownerFilter);
  ctx.setHeader("Songs");
  const appEl = document.querySelector(".app");
  appEl?.classList.add("collapseTitle");
  // Hide h1 immediately so it doesn't flash centered during slide transition
  const h1 = appEl?.querySelector(".titleblock h1");
  if (h1) h1.style.opacity = "0";

  // Merge own songs + shared songs — use stable cached objects to preserve cover resolution flags
  if (!state._sharedSongsCache) state._sharedSongsCache = [];
  const _sharedRaw = [
    ...(sharedData.songs || []).map(ss => ({ ...ss.song, _shared: true, _sharedBy: ss.ownerName || "Someone" })),
    ...(sharedData.projects || []).flatMap(sp =>
      (sp.songs || []).map(s => ({ ...s, _shared: true, _sharedBy: sp.ownerName || "Someone" }))
    ),
  ].filter(s => !state.songs.find(own => own.id === s.id));

  // Upsert into stable cache — same object reference across renders
  for (const s of _sharedRaw) {
    const existing = state._sharedSongsCache.find(c => c.id === s.id);
    if (existing) {
      // Update data but keep the same object reference (preserves _coverResolving etc)
      for (const k of Object.keys(s)) {
        if (k !== "_coverResolving" && k !== "_userCoverResolving" && k !== "coverImageUrl" && k !== "userCoverImageUrl") {
          existing[k] = s[k];
        }
      }
      // Only set cover URLs if not already resolved
      if (!existing.coverImageUrl && s.coverImageUrl) existing.coverImageUrl = s.coverImageUrl;
      if (!existing.userCoverImageUrl && s.userCoverImageUrl) existing.userCoverImageUrl = s.userCoverImageUrl;
    } else {
      state._sharedSongsCache.push(s);
    }
  }
  // Use cached objects (stable references)
  const allSharedSongs = state._sharedSongsCache.filter(s => s._shared);

  const ownSongs = state.songs.map(s => ({ ...s, _shared: false }));
  const allSongs = [...ownSongs, ...allSharedSongs];

  const ownerFilter = ctx.getSongsListState().ownerFilter || "all";
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

  ctx.getActiveScreenEl().innerHTML = `
    <div class="songsTitleRow">
      <div class="songsPageTitle">${R.songsFromCollab ? "Shared Songs" : "Songs"}</div>
      ${R.songsFromCollab ? "" : `<div class="ownerDropWrap">
        <button class="ownerDropBtn">${ownerLabels[ownerFilter]}${chevronDown}</button>
      </div>`}
    </div>
    <div class="songsHead">
      <div class="songsBar">
        <input
          id="q"
          type="text"
          placeholder="Search songs..."
          value="${escapeHtml(ctx.getSongsListState().query)}"
        />
        <button class="filterBtn" id="ctx.openSongFilters" aria-label="Filters">
          ${iconFilter()}
        </button>
      </div>
    </div>

    <div id="songList"></div>
    <button class="sdFab" id="songsAddFab" aria-label="Add song">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
  `;

  // Show loading hint if shared data hasn't loaded yet and user might see shared songs
  if (!sharedData.loaded && ownerFilter !== "mine") {
    const hint = document.createElement("div");
    hint.className = "sharedLoadingHint";
    hint.textContent = "Loading shared songs…";
    $("#songList")?.prepend(hint);
  }

  console.log("[renderSongsList] innerHTML set, building list...");
  const listEl = $("#songList");

  const applyFilter = () => {
    const qValue = $("#q")?.value || "";
    const q = qValue.toLowerCase();

    // filters now come from state (set by the filter sheet)
    const sf = ctx.getSongsListState().statusFilter || "";
    const pf = ctx.getSongsListState().projectFilter || "";

    ctx.getSongsListState().query = qValue;

    const filtered = songs
      .filter((s) => {
        const hay = `${s.title} ${s.project} ${s.genre} ${s.sprint} ${s.instrumentation} ${s.collaborators} ${s.vibes} ${s.lyrics} ${s.notes}`.toLowerCase();
        const qOk = !q || hay.includes(q);
        const sOk = !sf || s.status === sf;
        const pOk = !pf || (s.project || "").trim() === pf;
        return qOk && sOk && pOk;
      })
      .sort((a, b) => {
        if (ctx.getSongsListState().sortMode === "title") return (a.title || "").localeCompare(b.title || "");
        if (ctx.getSongsListState().sortMode === "status") {
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
              <div class="songCardTitleRow"><div class="songCardTitle">${escapeHtml(s.title)}</div>${sharedBadge(s)}</div>
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
          <div class="songsGroupHead" data-artist="${escapeHtml(artist)}" style="cursor:pointer">${escapeHtml(artist)}${sharedBadgeProject(artist)}</div>
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
          if (id) ctx.openSongMenu(id);
        }, 500);
      }, { passive: true });

      el.addEventListener("touchend", () => { clearTimeout(longPressTimer); });
      el.addEventListener("touchmove", () => { clearTimeout(longPressTimer); });
      el.addEventListener("touchcancel", () => { clearTimeout(longPressTimer); });

      el.addEventListener("click", () => {
        if (didLongPress) return;
        R.songsListScrollTop = ctx.getActiveScreenEl().scrollTop;
        ctx.navigateForward(() => {
          R.selectedSongId = el.getAttribute("data-id");
        });
      });
    });

    listEl.querySelectorAll(".songsGroupHead[data-artist]").forEach((el) => {
      el.addEventListener("click", () => {
        const artist = el.getAttribute("data-artist");
        if (!artist) return;
        ctx.navigateForward(() => {
          R.drawerView = "projects";
          R.projectDetailScreen = artist;
        });
      });
    });
  };

  $("#q").addEventListener("input", applyFilter);

  $("#ctx.openSongFilters")?.addEventListener("click", ctx.openSongFilters);

  // Owner filter dropdown
  const dropBtn = ctx.getActiveScreenEl().querySelector(".ownerDropBtn");
  const dropWrap = ctx.getActiveScreenEl().querySelector(".ownerDropWrap");
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
        ctx.getSongsListState().ownerFilter = item.getAttribute("data-owner") || "all";
        R.songsListScrollTop = 0;
        renderSongsList();
      });
    });
    const close = (e) => {
      if (!menu.contains(e.target) && e.target !== dropBtn) { menu.remove(); document.removeEventListener("pointerdown", close); }
    };
    setTimeout(() => document.addEventListener("pointerdown", close), 0);
  });

  $("#songsAddFab")?.addEventListener("click", () => ctx.openCreateOverlay());

  applyFilter();

  // Restore scroll position when returning from a song detail view
  if (R.songsListScrollTop > 0) {
    ctx.getActiveScreenEl().scrollTop = R.songsListScrollTop;
  }

  // Collapse title: fade small title in proportion to big title scrolling behind topbar
  // Remove any previous listener to avoid stacking
  if (ctx.getActiveScreenEl()._collapseTitleScroll) {
    ctx.getActiveScreenEl().removeEventListener("scroll", ctx.getActiveScreenEl()._collapseTitleScroll);
    ctx.getActiveScreenEl()._collapseTitleScroll = null;
  }
  const _screen = ctx.getActiveScreenEl();
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
  ctx.setHeader("Upload Song");
  ctx.getActiveScreenEl().innerHTML = `
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
  ctx.openSheet("songDetailMenu");
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

export function renderSongDetail(id) {
  const song = getSong(id);
  if (!song) {
    R.selectedSongId = null;
    R.selectedVersionId = null;
    return ctx.render();
  }

  ctx.setHeader(song.title);
  // Hide topbar title — the hero has its own large title
  const _tbH1 = document.querySelector(".topbar h1");
  if (_tbH1) _tbH1.textContent = "";
  const appEl = document.querySelector(".app");
  appEl?.classList.add("pdActive");
  appEl?.classList.remove("pdScrolled");
  ctx.getActiveScreenEl().style.paddingBottom = "0px";
  const topbarEl = document.querySelector(".topbar");
  const topbarH = topbarEl ? topbarEl.offsetHeight : 0;
  ctx.getActiveScreenEl().style.setProperty("--pd-topbar-h", topbarH + "px");

  ctx.getActiveScreenEl().style.overflowY = "scroll";

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

  ctx.getActiveScreenEl().innerHTML = `
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
      <button class="pdShareBtn" id="songShare" aria-label="Share song">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
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
  ctx.getActiveScreenEl().scrollTop = 0;


  /* ── Tab switching ── */
  const tabBody = $("#pdTabBody");
  ctx.getActiveScreenEl().querySelectorAll(".pdTab").forEach(tab => {
    tab.addEventListener("click", () => {
      ctx.getActiveScreenEl().querySelectorAll(".pdTab").forEach(t => t.classList.remove("pdTabActive"));
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
    ctx.unlockAudioOnce();
    await ctx.playNowPlaying({ autoplay: true });
    ctx.syncMiniPlayerUI();
  });

  /* ── Shuffle ── */
  $("#songShuffle")?.addEventListener("click", async () => {
    if (!items.length) return toast("No playable versions");
    const all = shuffleArray([...items]);
    state.player.nowPlaying = all[0];
    state.player.queue = all.slice(1);
    state.player.repeatQueue = all;
    saveState();
    ctx.unlockAudioOnce();
    await ctx.playNowPlaying({ autoplay: true });
    ctx.syncMiniPlayerUI();
  });

  /* ── Share ── */
  $("#songShare")?.addEventListener("click", () => {
    ctx.shareInviteSong(song.id);
  });

  /* ── Song more menu (Details, Regen Art, Delete) ── */
  $("#songMoreMenu")?.addEventListener("click", () => {
    openSongDetailMenu(song.id);
  });

  /* ── FAB: Add version ── */
  $("#sdAddVersion")?.addEventListener("click", () => {
    const newV = ctx.createVersion(song);
    if (!newV) return toast("Couldn’t create version");
    ctx.navigateForward(() => {
      R.selectedVersionId = newV.id;
    });
  });

  /* ── Version row listeners ── */
  function attachVersionListeners() {
    ctx.getActiveScreenEl().querySelectorAll("[data-vrow]").forEach(row => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("[data-vmore]")) return;
        const vid = row.getAttribute("data-vrow");
        ctx.playVersion(song.id, vid, { goPlayer: false });
      });
    });

    ctx.getActiveScreenEl().querySelectorAll("[data-vmore]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        ctx.openVersionMenu(song.id, btn.getAttribute("data-vmore"));
      });
    });
  }

  attachVersionListeners();

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
      if (maxScroll > 0) {
        const remaining = maxScroll - scrolled;
        const opacity = remaining < FADE_PX ? Math.max(0, remaining / FADE_PX) : 1;
        if (heroBgEl) heroBgEl.style.opacity = opacity;
        if (heroContentEl) heroContentEl.style.opacity = opacity;
        if (actionsEl) actionsEl.querySelectorAll("button").forEach(b => b.style.opacity = opacity);
      }
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
      ctx.unlockAudioOnce();
      ctx.playNowPlaying({ autoplay: true }).then(() => ctx.syncMiniPlayerUI());
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
      ctx.unlockAudioOnce();
      ctx.playNowPlaying({ autoplay: true }).then(() => ctx.syncMiniPlayerUI());
    } else if (action === "addVersion") {
      const newV = ctx.createVersion(song);
      if (!newV) return toast("Couldn't create version");
      R.selectedVersionId = newV.id;
      ctx.render();
    } else if (action === "rename") {
      ctx.navigateForward(() => { R.selectedVersionId = versionId; });
    } else if (action === "notes") {
      ctx.navigateForward(() => { R.selectedVersionId = versionId; });
    }
  });
}

export function renderVersionDetail(songId, versionId) {
  const song = getSong(songId);
  const v = getVersion(song, versionId);

  if (!song || !v) {
    R.selectedVersionId = null;
    return ctx.render();
  }

  ctx.setHeader("Version");

    // ✅ Fix: entering Version detail should not inherit prior scroll position
  if (ctx.getActiveScreenEl()) ctx.getActiveScreenEl().scrollTop = 0;
  try { window.scrollTo(0, 0); } catch {}
  try { document.documentElement.scrollTop = 0; } catch {}
  try { document.body.scrollTop = 0; } catch {}
  requestAnimationFrame(() => { if (screens.home) screens.home.scrollTop = 0; });

  const hasPlayable = !!(v.link || v.fileId || v.localAudioId || v.audioPath);
  const hasLocal = !!(v.fileId || v.localAudioId);
  const hasCloud = !!v.audioPath;

  const heroCover = coverSvg(song);

  ctx.getActiveScreenEl().innerHTML = `
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
      const file = await ctx.pickAudioFile();
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
      const compressed = await compressAudioForUpload(file, ctx.getGlobalAudio());
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
        toast("Cloud sync failed — will retry on next launch");
      }

      renderVersionDetail(songId, versionId);
    } catch (err) {
      console.error(err);
      toast("Import failed — will retry cloud sync on next launch");
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
  $("#playThis")?.addEventListener("click", () => ctx.playVersion(songId, versionId, { goPlayer: false }));
  $("#queueThis")?.addEventListener("click", () => ctx.addToQueue(songId, versionId));

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
    const compressed = await compressAudioForUpload(blob, ctx.getGlobalAudio());
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
    ctx.setActive(songId, versionId);
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

    R.selectedVersionId = null;
    ctx.render();
  });
}

// ---------------------
// Player

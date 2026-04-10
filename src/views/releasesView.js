import { R } from "../router.js";
import { ctx } from "../appContext.js";
import { state, saveState, isPlayable } from "../state.js";
import { toast } from "../ui/toast.js";
import { $, escapeHtml } from "../ui/dom.js";
import { coverSvg } from "../ui/coverArt.js";

export function renderReleases() {
  ctx.setHeader("Releases");
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

  ctx.getActiveScreenEl().innerHTML = `
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

  ctx.getActiveScreenEl().querySelectorAll(".songCard[data-rel-open]").forEach(el => {
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
      ctx.navigateForward(() => {
        R.releaseDetailId = el.getAttribute("data-rel-open");
      });
    });
  });

  $("#addReleaseBtn")?.addEventListener("click", () => ctx.openSheet("release"));

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

export function renderReleaseDetail(releaseId) {
  const release = (state.releases || []).find(r => r.id === releaseId);
  if (!release) { R.releaseDetailId = null; return renderReleases(); }

  ctx.setHeader(release.title);
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
      const vv = s.versions.find(v => v.isActive && isPlayable(v))
              || s.versions.find(v => isPlayable(v))
              || s.versions[0];
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

  ctx.getActiveScreenEl().innerHTML = `
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
  ctx.getActiveScreenEl().scrollTop = 0;

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

      row.addEventListener("click", (e) => {
        if (didLongPress) return;
        if (e.target.closest("[data-rel-song-more]")) return;
        const sid = row.getAttribute("data-open-song");
        ctx.navigateForward(() => {
          R.releaseDetailId = null;
          R.drawerView = null;
          R.currentTab = "songs";
          R.songsView = "detail";
          R.selectedSongId = sid;
          R.selectedVersionId = null;
        });
      });
    });

    ctx.getActiveScreenEl().querySelectorAll("[data-rel-song-more]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        ctx.openSongMenu(btn.getAttribute("data-rel-song-more"));
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


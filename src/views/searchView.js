import { R } from "../router.js";
import { ctx } from "../appContext.js";
import { state } from "../state.js";
import { TAB_TITLES } from "../constants.js";
import { escapeHtml } from "../ui/dom.js";
import { coverSvg } from "../ui/coverArt.js";
import { renderProjectSongs } from "./projectsView.js";

export function renderGlobalSearch() {
  const activeScreenEl = ctx.getActiveScreenEl();
  ctx.setHeader("Search");
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
    R.drawerView = null;
    ctx.setHeader(TAB_TITLES[R.currentTab] || "RiffBank");
    ctx.render();
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

  const songMatches = songs.filter(s =>
    (s.title || "").toLowerCase().includes(q) ||
    (s.tags || "").toLowerCase().includes(q)
  );

  const allProjects = [...new Set(songs.map(s => (s.project || "").trim()).filter(Boolean))];
  const projMatches = allProjects.filter(p => p.toLowerCase().includes(q));

  const allCollabs = [...new Set(songs.flatMap(s =>
    (s.collaborators || "").split(",").map(c => c.trim()).filter(Boolean)
  ))];
  const collabMatches = allCollabs.filter(c => c.toLowerCase().includes(q));

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
      R.drawerView = null;
      if (type === "song") {
        R.currentTab = "songs";
        R.songsView = "list";
        R.selectedSongId = btn.dataset.id;
        R.selectedVersionId = null;
        ctx.setHeader("Song");
        ctx.syncTabs();
        ctx.render();
      } else if (type === "project") {
        R.drawerView = "projects";
        R.projectDetailScreen = btn.dataset.id;
        ctx.setActiveScreen("projectDetail");
        renderProjectSongs(R.projectDetailScreen);
      } else if (type === "collab") {
        ctx.resetSongsFilters({ keepSort: true });
        R.currentTab = "songs";
        R.songsView = "list";
        R.selectedSongId = null;
        ctx.setHeader("Songs");
        ctx.syncTabs();
        ctx.render();
        setTimeout(() => {
          const inp = document.querySelector(".songsBar input");
          if (inp) { inp.value = btn.dataset.collab; inp.dispatchEvent(new Event("input")); }
        }, 100);
      }
    });
  });
}

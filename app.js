// RiffBank v1.2 (Local-only PWA)
// - Song creation + editing
// - Upload Helper (suggested filename + Drive path)
// - Version history + Best flag
// - Best-only Player (plays links)
// - Dashboard + Settings
// - Export / Import

const LS_KEY = "riffbank_v1";
const $ = (sel) => document.querySelector(sel);

const view = $("#view");
const headerTitle = $("#headerTitle");
const toastEl = $("#toast");

function toast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 1400);
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
    });
  });
}

normalizeState();

function saveState() {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}

// PWA SW register
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
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

const songsListState = {
  sortMode: "updated",
  query: "",
  statusFilter: "",
  projectFilter: "",
};

let drawerView = null;
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
  return song.versions.find((v) => v.isBest) || song.versions[0];
}

function drivePathFor(song) {
  const root = slug(state.settings.driveRoot || "RiffBank");
  const project = slug(song.project || "Project");
  const sprint = slug(song.sprint || "Unsorted");
  const title = slug(song.title || "Untitled");
  return `${root}/${project}/${sprint}/${title}/Versions`;
}

function suggestedFileName(song, originalFileName, makeBest) {
  const extMatch = (originalFileName || "").match(/\.([a-z0-9]+)$/i);
  const ext = extMatch ? extMatch[1] : "wav";
  const title = slug(song.title || "Untitled");
  const vNum = (song.versions?.length || 0) + 1;
  const stamp = nowStamp();
  const bestTag = makeBest ? " (BEST)" : "";
  return `${title} - v${vNum} - ${stamp}${bestTag}.${ext}`;
}

function copyText(txt) {
  if (!txt) return;
  navigator.clipboard?.writeText(txt).then(
    () => toast("Copied 📋"),
    () => {
      const ta = document.createElement("textarea");
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      toast("Copied 📋");
    }
  );
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

// Tabs (Player + Settings only)
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    drawerView = null;
    overlayView = null;
    selectedSongId = null;
    songsView = "list";

    currentTab = btn.dataset.tab || "home";
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
  syncTabs();
  setHeader("RiffBank");
  render();
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

    if (selectedSongId) {
      selectedSongId = null;
      currentTab = "songs";
      songsView = "list";
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

// ---------------------
// Bottom sheet (GLOBAL)
// ---------------------
const sheet = $("#createSheet");
const sheetOverlay = $("#sheetOverlay");
const sheetContent = $("#sheetContent");
let sheetMode = "chooser"; // chooser | song | lyrics

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
}

$("#createFab")?.addEventListener("click", () => openSheet("chooser"));
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
$("#exportBtn")?.addEventListener("click", () => {
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
});

$("#importFile")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const txt = await file.text();
  try {
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
    e.target.value = "";
  }
});

// ---------------------
// Render router
// ---------------------
function render() {
  if (!view) return;

  syncTabs();
  document.body.classList.toggle("isHome", currentTab === "home" && !drawerView && !overlayView);

  // Drawer screens
  if (drawerView === "projects") return renderProjects();
  if (drawerView === "eps") return renderEPs();
  if (drawerView === "collabs") return renderCollaborators();
  if (drawerView === "importExport") return renderImportExport();
  if (drawerView === "about") return renderAbout();

  // Normal screens
  if (currentTab === "home") return renderHome();
  if (currentTab === "songs") {
    if (selectedSongId) return renderSongDetail(selectedSongId);
    if (songsView === "create") return renderSongCreate();
    return renderSongsList();
  }
  if (currentTab === "player") return renderPlayer();
  if (currentTab === "settings") return renderSettings();
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
  ).sort((a,b) => a.localeCompare(b));

  const rows = projects.map(p => {
    const count = state.songs.filter(s => (s.project || "").trim() === p).length;
    const isDefault = (state.settings.defaultProject || "").trim() === p;
    return `
      <div class="item" style="cursor:default">
        <div class="row" style="justify-content:space-between; align-items:center">
          <div class="title"><b>${escapeHtml(p)}</b></div>
          <div class="row" style="gap:8px; justify-content:flex-end">
            ${isDefault ? `<span class="badge good">Default</span>` : `<span class="badge">—</span>`}
          </div>
        </div>
        <div class="meta">${count} song${count === 1 ? "" : "s"}</div>
        <div class="row" style="margin-top:10px; gap:8px; flex-wrap:wrap">
          <button class="btn" data-set-default="${escapeHtml(p)}">Set default</button>
          <button class="btn" data-filter="${escapeHtml(p)}">View songs</button>
        </div>
      </div>
    `;
  }).join("");

  view.innerHTML = `
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
      <div class="list">
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

  view.querySelectorAll("[data-set-default]").forEach(btn => {
    btn.addEventListener("click", () => {
      const p = btn.getAttribute("data-set-default");
      state.settings.defaultProject = p;
      saveState();
      toast("Default set ✅");
      renderProjects();
    });
  });

  view.querySelectorAll("[data-filter]").forEach(btn => {
    btn.addEventListener("click", () => {
      const p = btn.getAttribute("data-filter");
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
          q.value = p;
          q.dispatchEvent(new Event("input"));
          toast(`Showing: ${p}`);
        }
      }, 0);
    });
  });
}

function renderEPs() {
  setHeader("EPs");
  view.innerHTML = `
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

  view.innerHTML = `
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

  view.querySelectorAll("[data-filter-collab]").forEach(btn => {
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

  view.innerHTML = `
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

  view.innerHTML = `
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

// ---------------------
// Home
// ---------------------
function renderHome() {
  overlayView = null;
  currentTab = "home";
  setHeader("RiffBank");

  const songCount = state.songs.length;

  view.innerHTML = `
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

  view.querySelectorAll("[data-home]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-home");
      if (target === "songs") {
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
  view.innerHTML = `
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
  view.innerHTML = `
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
  view.querySelectorAll("[data-open-song]").forEach((el) =>
    el.addEventListener("click", () => {
      currentTab = "songs";
      selectedSongId = el.getAttribute("data-open-song");
      setHeader("Song");
      render();
    })
  );
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

  view.innerHTML = `
    <div class="songsHead">
      <div class="segTabs" role="tablist" aria-label="Sort">
        <button class="segTab ${songsListState.sortMode === "updated" ? "active" : ""}" data-sort="updated">updated</button>
        <button class="segTab ${songsListState.sortMode === "title" ? "active" : ""}" data-sort="title">title</button>
        <button class="segTab ${songsListState.sortMode === "status" ? "active" : ""}" data-sort="status">status</button>
      </div>

      <div class="songsFilters">
        <input id="q" type="text" placeholder="Search title / lyrics / notes / collaborators..." value="${escapeHtml(songsListState.query)}" />
        <select id="statusFilter">
          <option value="">All statuses</option>
          ${["Idea","Demo","Arrange","Mix","Master","Ready","Done","Released"].map(
            (s) => `<option value="${s}" ${songsListState.statusFilter === s ? "selected" : ""}>${s}</option>`
          ).join("")}
        </select>
        <select id="projectFilter">
          <option value="">All projects</option>
          ${projects.map(
            (p) => `<option value="${escapeHtml(p)}" ${songsListState.projectFilter === p ? "selected" : ""}>${escapeHtml(p)}</option>`
          ).join("")}
        </select>
      </div>
    </div>

    <div id="songList" class="songsList"></div>
    <div class="small">Tip: use the center “New record” button to create.</div>
  `;

  const listEl = $("#songList");

  const applyFilter = () => {
    const qValue = $("#q").value || "";
    const q = qValue.toLowerCase();
    const sf = $("#statusFilter").value;
    const pf = $("#projectFilter").value;

    songsListState.query = qValue;
    songsListState.statusFilter = sf;
    songsListState.projectFilter = pf;

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
          const stuckBadge =
            s.stuckState === "Stuck"
              ? `<span class="badge bad">🧊 Stuck</span>`
              : s.stuckState === "Parked"
              ? `<span class="badge warn">💤 Parked</span>`
              : `<span class="badge">✅ Active</span>`;

          return `
            <div class="songRow" data-id="${s.id}">
              <div class="row" style="justify-content:space-between; align-items:center">
                <div class="title"><b>${escapeHtml(s.title)}</b></div>
                <div class="row" style="gap:8px; justify-content:flex-end">
                  ${badgeForStatus(s.status)}
                  ${stuckBadge}
                </div>
              </div>
              <div class="meta">${escapeHtml(s.project)} • ${escapeHtml(s.genre || "—")} • Sprint: ${escapeHtml(s.sprint || "—")} • Versions: ${vCount}</div>
              ${s.nextAction ? `<div class="meta">Next: ${escapeHtml(s.nextAction)}</div>` : ""}
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
  };

  view.querySelectorAll(".segTab").forEach((btn) => {
    btn.addEventListener("click", () => {
      songsListState.sortMode = btn.getAttribute("data-sort") || "updated";
      view.querySelectorAll(".segTab").forEach((t) => t.classList.toggle("active", t === btn));
      applyFilter();
    });
  });

  $("#q").addEventListener("input", applyFilter);
  $("#statusFilter").addEventListener("change", applyFilter);
  $("#projectFilter").addEventListener("change", applyFilter);

  applyFilter();
}

function renderSongCreate() {
  setHeader("Upload Song");
  view.innerHTML = `
    <div class="card">
      <h2>Upload Song</h2>
      <div class="small">Use the center New Record button instead — this screen is legacy.</div>
    </div>
  `;
}

// ---------------------
// Song detail
// ---------------------
function renderSongDetail(id) {
  const song = getSong(id);
  if (!song) {
    selectedSongId = null;
    return renderSongsList();
  }

  const bv = bestVersion(song);
  const drivePath = drivePathFor(song);

  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between; align-items:center">
        <h2>${escapeHtml(song.title)}</h2>
        <div class="row" style="gap:8px; justify-content:flex-end">
          <button id="back" class="ghost">Back</button>
          <button id="delSong" class="btn">Delete</button>
        </div>
      </div>
      <div class="small">Updated: <b>${escapeHtml(song.updatedAt || song.createdAt || "")}</b></div>
      <div class="hr"></div>

      <div class="row">
        <div class="col">
          <div class="label">Title</div>
          <input id="title" type="text" value="${escapeHtml(song.title)}"/>
        </div>
        <div class="col">
          <div class="label">Project</div>
          <input id="project" type="text" value="${escapeHtml(song.project)}"/>
        </div>
      </div>

      <div class="row" style="margin-top:10px">
        <div class="col">
          <div class="label">Genre</div>
          <input id="genre" type="text" value="${escapeHtml(song.genre)}"/>
        </div>
        <div class="col">
          <div class="label">Sprint</div>
          <input id="sprint" type="text" value="${escapeHtml(song.sprint)}"/>
        </div>
      </div>

      <div class="row" style="margin-top:10px">
        <div class="col">
          <div class="label">Instrumentation</div>
          <input id="inst" type="text" placeholder="e.g. Drop G# 7-string, synth pads" value="${escapeHtml(song.instrumentation)}"/>
        </div>
        <div class="col">
          <div class="label">Collaborators</div>
          <input id="collab" type="text" placeholder="e.g. Darian, Mason" value="${escapeHtml(song.collaborators)}"/>
        </div>
      </div>

      <div class="row" style="margin-top:10px">
        <div class="col">
          <div class="label">Status</div>
          <select id="status">
            ${["Idea","Demo","Arrange","Mix","Master","Ready","Done","Released"]
              .map((s) => `<option ${song.status === s ? "selected" : ""}>${s}</option>`)
              .join("")}
          </select>
        </div>
        <div class="col">
          <div class="label">Stuck state</div>
          <select id="stuck">
            ${["Active","Stuck","Parked"]
              .map((s) => `<option ${song.stuckState === s ? "selected" : ""}>${s}</option>`)
              .join("")}
          </select>
        </div>
      </div>

      <div class="row" style="margin-top:10px">
        <div class="col">
          <div class="label">Next action</div>
          <input id="nextAction" type="text" placeholder="e.g. Write verse 2 / re-track guitars" value="${escapeHtml(song.nextAction || "")}"/>
        </div>
      </div>

      <div class="row" style="margin-top:10px">
        <button id="saveSong" class="btn primary">Save</button>
      </div>
    </div>

    <div class="card">
      <h2>Vibes</h2>
      <textarea id="vibes" placeholder="What should this feel like?">${escapeTextarea(song.vibes)}</textarea>
      <div class="hr"></div>
      <h2>Lyrics</h2>
      <textarea id="lyrics" placeholder="Draft lyrics / fragments…">${escapeTextarea(song.lyrics)}</textarea>
      <div class="hr"></div>
      <h2>Notes</h2>
      <textarea id="notes" placeholder="Mix notes, arrangement notes…">${escapeTextarea(song.notes)}</textarea>
      <div class="row" style="margin-top:10px">
        <button id="saveText" class="btn primary">Save text</button>
      </div>
    </div>

    <div class="card">
      <h2>Versions</h2>
      <div class="small">Drive folder suggestion: <span class="mono">${escapeHtml(drivePath)}</span></div>
      <div class="row" style="margin-top:10px">
        <button class="btn" id="copyPath">Copy Drive path</button>
      </div>

      <div class="hr"></div>

      <h2>Add version (Upload Helper)</h2>
      <div class="row">
        <div class="col">
          <div class="label">Choose file (for extension + name)</div>
          <input id="pickFile" type="file" />
        </div>
        <div class="col">
          <div class="label">Make Best?</div>
          <div id="makeBest" class="pill on"><span class="dot"></span><span>Yes</span></div>
          <div class="small">Newest version defaults to Best.</div>
        </div>
      </div>

      <div class="row" style="margin-top:10px">
        <div class="col">
          <div class="label">Suggested filename</div>
          <input id="suggestedName" type="text" readonly value="Pick a file…" />
        </div>
        <div class="col">
          <div class="label">Drive link (optional)</div>
          <input id="driveLink" type="text" placeholder="Paste Drive link (or direct audio URL)" />
        </div>
      </div>

      <div class="row" style="margin-top:10px">
        <div class="col">
          <div class="label">Version notes</div>
          <input id="vNotes" type="text" placeholder="e.g. bass good, top end too sharp" />
        </div>
        <div class="col" style="display:flex; align-items:flex-end; gap:10px">
          <button id="copyName" class="btn">Copy filename</button>
          <button id="addVersion" class="btn primary">Add version</button>
        </div>
      </div>

      <div class="hr"></div>
      <h2>History</h2>
      <div id="versionsList" class="list"></div>
    </div>

    <div class="card">
      <h2>Best version preview</h2>
      ${
        bv ? `
          <div class="small">Best: <b>${escapeHtml(bv.label)}</b></div>
          <div style="margin-top:10px">
            <audio controls style="width:100%" ${bv.link ? `src="${escapeHtml(bv.link)}"` : ""}></audio>
          </div>
          <div class="small" style="margin-top:10px">
            ${bv.link ? "If it doesn’t play, use a direct audio URL." : "Paste a link on the version to enable playback."}
          </div>
        ` : `<div class="small">No versions yet.</div>`
      }
    </div>
  `;

  $("#back").addEventListener("click", () => goBack({ animate: true }));

  $("#delSong").addEventListener("click", () => {
    if (!confirm(`Delete "${song.title}"?`)) return;
    state.songs = state.songs.filter((s) => s.id !== song.id);
    saveState();
    toast("Deleted 🗑️");
    selectedSongId = null;
    currentTab = "songs";
    setHeader("Songs");
    render();
  });

  $("#copyPath").addEventListener("click", () => copyText(drivePath));

  const saveSongFields = () => {
    song.title = $("#title").value.trim() || song.title;
    song.project = $("#project").value.trim();
    song.genre = $("#genre").value.trim();
    song.sprint = $("#sprint").value.trim();
    song.instrumentation = $("#inst").value.trim();
    song.collaborators = $("#collab").value.trim();
    song.status = $("#status").value;
    song.stuckState = $("#stuck").value;
    song.nextAction = $("#nextAction").value.trim();
    song.updatedAt = nowStamp();
    saveState();
    toast("Saved ✅");
  };

  $("#saveSong").addEventListener("click", saveSongFields);

  $("#saveText").addEventListener("click", () => {
    song.vibes = $("#vibes").value;
    song.lyrics = $("#lyrics").value;
    song.notes = $("#notes").value;
    song.updatedAt = nowStamp();
    saveState();
    toast("Saved ✅");
  });

  // Upload Helper
  let makeBest = true;
  const makeBestEl = $("#makeBest");
  const suggestedNameEl = $("#suggestedName");
  const pickFileEl = $("#pickFile");

  makeBestEl.addEventListener("click", () => {
    makeBest = !makeBest;
    makeBestEl.classList.toggle("on", makeBest);
    makeBestEl.querySelector("span:last-child").textContent = makeBest ? "Yes" : "No";
    const f = pickFileEl.files?.[0];
    if (f) suggestedNameEl.value = suggestedFileName(song, f.name, makeBest);
  });

  pickFileEl.addEventListener("change", () => {
    const f = pickFileEl.files?.[0];
    if (!f) return;
    suggestedNameEl.value = suggestedFileName(song, f.name, makeBest);
  });

  $("#copyName").addEventListener("click", () => copyText(suggestedNameEl.value));

  $("#addVersion").addEventListener("click", () => {
    const f = pickFileEl.files?.[0];
    const link = $("#driveLink").value.trim();
    const notes = $("#vNotes").value.trim();

    const label = f
      ? suggestedFileName(song, f.name, makeBest)
      : `Version - ${nowStamp()}${makeBest ? " (BEST)" : ""}`;

    const v = {
      id: uid(),
      createdAt: nowStamp(),
      label,
      notes,
      link,
      isBest: makeBest,
      isActive: true,
    };

    song.versions = song.versions || [];
    if (makeBest) song.versions.forEach((x) => (x.isBest = false));
    song.versions.unshift(v);
    if (!song.versions.some((x) => x.isBest)) song.versions[0].isBest = true;

    song.updatedAt = nowStamp();
    saveState();

    $("#vNotes").value = "";
    $("#driveLink").value = "";
    pickFileEl.value = "";
    suggestedNameEl.value = "Pick a file…";

    toast("Version added 🎧");
    renderSongDetail(song.id);
  });

  renderVersionsList(song);

  if (pendingScrollToUpload) {
    pendingScrollToUpload = false;
    setTimeout(() => $("#pickFile")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }
}

function renderVersionsList(song) {
  const listEl = $("#versionsList");
  const versions = song.versions || [];

  listEl.innerHTML = versions.length
    ? versions.map((v) => `
      <div class="item" style="cursor:default">
        <div class="row" style="justify-content:space-between; align-items:center">
          <div class="title">${escapeHtml(v.label)}</div>
          <div class="row" style="gap:8px; justify-content:flex-end">
            ${v.isBest ? `<span class="badge good">⭐ Best</span>` : `<span class="badge">—</span>`}
          </div>
        </div>
        <div class="meta">Created: ${escapeHtml(v.createdAt)}${v.notes ? ` • Notes: ${escapeHtml(v.notes)}` : ""}</div>
        <div class="row" style="margin-top:10px; gap:8px; flex-wrap:wrap">
          <button class="btn" data-best="${v.id}">${v.isBest ? "Best ✅" : "Set Best ⭐"}</button>
          <button class="btn" data-active="${v.id}">${v.isActive ? "Active ✅" : "Set Active 🎧"}</button>
          <button class="btn" data-copy="${v.id}">Copy name</button>
          <button class="btn" data-open="${v.id}" ${v.link ? "" : "disabled"}>Open link</button>
          <button class="btn" data-del="${v.id}">Delete</button>
        </div>
        ${
          v.link
            ? `<div class="small" style="margin-top:8px">Link: <span class="mono">${escapeHtml(v.link)}</span></div>`
            : `<div class="small" style="margin-top:8px"><i>No link yet</i> (paste after uploading)</div>`
        }
      </div>
    `).join("")
    : `<div class="small">No versions yet. Add one above.</div>`;

  listEl.querySelectorAll("[data-best]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.getAttribute("data-best");
      song.versions.forEach((x) => (x.isBest = x.id === id));
      song.updatedAt = nowStamp();
      saveState();
      toast("Best updated ⭐");
      renderSongDetail(song.id);
    })
  );

  listEl.querySelectorAll("[data-active]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.getAttribute("data-active");
      const v = song.versions.find((x) => x.id === id);
      if (!v) return;
      v.isActive = !v.isActive;
      song.updatedAt = nowStamp();
      saveState();
      toast("Active updated 🎧");
      renderSongDetail(song.id);
    })
  );

  listEl.querySelectorAll("[data-copy]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.getAttribute("data-copy");
      const v = song.versions.find((x) => x.id === id);
      if (v) copyText(v.label);
    })
  );

  listEl.querySelectorAll("[data-open]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.getAttribute("data-open");
      const v = song.versions.find((x) => x.id === id);
      if (v?.link) window.open(v.link, "_blank");
    })
  );

  listEl.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.getAttribute("data-del");
      const v = song.versions.find((x) => x.id === id);
      if (!v) return;
      if (!confirm(`Delete version "${v.label}"?`)) return;
      song.versions = song.versions.filter((x) => x.id !== id);
      if (song.versions.length && !song.versions.some((x) => x.isBest)) song.versions[0].isBest = true;
      song.updatedAt = nowStamp();
      saveState();
      toast("Deleted 🗑️");
      renderSongDetail(song.id);
    })
  );
}

// ---------------------
// Player
// ---------------------
function renderPlayer() {
  setHeader("Player");
  const activeVersions = state.songs
    .flatMap((song) => (song.versions || []).map((v) => ({ song, v })))
    .filter(({ v }) => v.link && v.isActive === true);

  view.innerHTML = `
    <div class="card">
      <h2>Active versions player</h2>
      <div class="small">Your personal Spotify fed by active versions.</div>
      <div class="hr"></div>
      ${
        activeVersions.length
          ? `<div class="list">
              ${activeVersions.map(({ song, v }) => `
                <div class="item">
                  <div class="row" style="justify-content:space-between; align-items:center">
                    <div class="title"><b>${escapeHtml(song.title)}</b></div>
                    <button class="btn" data-open-song="${song.id}">Open</button>
                  </div>
                  <div class="meta">${escapeHtml(song.project || "—")} • ${escapeHtml(v.label || "Version")}</div>
                  <audio controls style="width:100%; margin-top:10px" src="${escapeHtml(v.link)}"></audio>
                </div>
              `).join("")}
            </div>`
          : `<div class="small">No active versions yet. Mark versions Active in a song.</div>`
      }
    </div>
  `;

  view.querySelectorAll("[data-open-song]").forEach((b) =>
    b.addEventListener("click", () => {
      selectedSongId = b.getAttribute("data-open-song");
      currentTab = "songs";
      setHeader("Song");
      render();
    })
  );
}

// ---------------------
// Settings
// ---------------------
function renderSettings() {
  setHeader("Settings");

  view.innerHTML = `
    <div class="card">
      <h2>Settings</h2>

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

  $("#saveSettings").addEventListener("click", () => {
    state.settings.driveRoot = $("#driveRoot").value.trim() || "RiffBank";
    state.settings.defaultProject = $("#defProject").value.trim() || "";
    state.settings.defaultGenre = $("#defGenre").value.trim() || "";
    state.settings.defaultSprint = $("#defSprint").value.trim() || "";
    saveState();
    toast("Saved ✅");
  });

  $("#wipe").addEventListener("click", () => {
    if (!confirm("Wipe all local RiffBank data on this browser?")) return;
    localStorage.removeItem(LS_KEY);
    state = loadState();
    normalizeState();
    toast("Wiped 🧼");
    currentTab = "home";
    setHeader("RiffBank");
    render();
  });
}

// ---------------------
// Prevent rubber band scroll
// ---------------------
function preventRubberBandScroll(container) {
  if (!container) return;
  let startY = 0;

  container.addEventListener("touchstart", (e) => {
    if (e.touches && e.touches.length > 1) return;
    startY = e.touches?.[0]?.clientY ?? 0;
  }, { passive: true });

  container.addEventListener("touchmove", (e) => {
    const tag = (e.target?.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "input" || tag === "select") return;

    const y = e.touches?.[0]?.clientY ?? 0;
    const dy = y - startY;

    const atTop = container.scrollTop <= 0;
    const atBottom =
      Math.ceil(container.scrollTop + container.clientHeight) >= container.scrollHeight;

    if ((atTop && dy > 0) || (atBottom && dy < 0)) e.preventDefault();
  }, { passive: false });
}

// ---------------------
// Splash logic (GLOBAL, runs once)
// ---------------------
function hideSplash() {
  const s = document.getElementById("splash");
  if (!s) return;
  s.classList.add("hide");
  setTimeout(() => s.remove(), 350);
}

window.addEventListener("load", () => {
  const MIN_SPLASH_TIME = 2600; // longer loading feel
  setTimeout(hideSplash, MIN_SPLASH_TIME);
});

// ---------------------
// Boot
// ---------------------
setHeader("RiffBank");
syncTabs();
render();
preventRubberBandScroll(view);
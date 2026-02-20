// RiffBank V1 (Local-only PWA)
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

// For HTML attributes / innerHTML
function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// For textarea inner content (don't escape quotes)
function escapeTextarea(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ✅ UUID helper (fixes crypto.randomUUID not supported on some browsers/PWA contexts)
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
    try {
      return JSON.parse(raw);
    } catch {}
  }
  return {
    version: 1,
    settings: {
      driveRoot: "RiffBank",
      defaultProject: "SkeletonDanceParty",
      defaultGenre: "Metalcore",
      defaultSprint: "Unsorted",
    },
    songs: [],
  };
}

let state = loadState();

function normalizeState() {
  state.settings = state.settings || {};
  state.songs = Array.isArray(state.songs) ? state.songs : [];
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
  home: "Home",
  songs: "Songs",
  player: "Player",
  settings: "Settings",
};

let currentTab = "home";
let selectedSongId = null;
let songsView = "list"; // "list" | "create"
let pendingScrollToUpload = false;
const songsListState = {
  sortMode: "updated",
  query: "",
  statusFilter: "",
  projectFilter: "",
};

let drawerView = null;     // "projects" | "eps" | "collabs" | "importExport" | "about" | null
let drawerOpen = false;

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
  // Header title will be set inside the renderers
  render();
}

function setHeader(t) {
  if (headerTitle) headerTitle.textContent = t;
}

function syncTabs() {
  document
    .querySelectorAll(".tab")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === currentTab));
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

// Drawer open/close
$("#drawerCloseBtn")?.addEventListener("click", closeDrawer);
$("#drawerOverlay")?.addEventListener("click", closeDrawer);

// Tabs
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    drawerView = null;
    currentTab = btn.dataset.tab;
    selectedSongId = null;
    songsView = "list";

    syncTabs();

    setHeader(TAB_TITLES[currentTab] || "RiffBank");
    render();
  });
});

$("#uploadSongBtn")?.addEventListener("click", () => {
  drawerView = null;
  selectedSongId = null;
  songsView = "create";
  currentTab = "songs";
  setHeader("Upload Song");
  render();
});

let touchStartX = 0;
let touchStartY = 0;
let touchTracking = false;
let touchMode = null;

document.addEventListener("touchstart", (e) => {
  const t = e.changedTouches?.[0];
  if (!t) return;

  if (!drawerOpen && t.clientX <= 24) {
    touchTracking = true;
    touchMode = "open";
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    return;
  }

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

// Drawer menu items
document.querySelectorAll(".drawerItem").forEach((btn) => {
  btn.addEventListener("click", () => {
    const v = btn.dataset.drawer;
    setDrawerView(v);
  });
});

// Export / Import
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
    if (!confirm("Import will replace your current data on this device. Continue?"))
      return;
    state = incoming;
    saveState();
    toast("Imported ✅");
    render();
  } catch {
    alert("Could not parse that JSON file.");
  } finally {
    e.target.value = "";
  }
});

function render() {
  if (!view) return;
  syncTabs();

  const uploadSongBtn = $("#uploadSongBtn");
  if (uploadSongBtn) {
    const onSongsListScreen =
      currentTab === "songs" &&
      !drawerView &&
      !selectedSongId &&
      songsView === "list";
    const onHomeScreen = currentTab === "home" && !drawerView;
    uploadSongBtn.style.display = onSongsListScreen || onHomeScreen ? "none" : "";
  }

  // Drawer screens take precedence
  if (drawerView === "projects") return renderProjects();
  if (drawerView === "eps") return renderEPs();
  if (drawerView === "collabs") return renderCollaborators();
  if (drawerView === "importExport") return renderImportExport();
  if (drawerView === "about") return renderAbout();

  // Normal tabs
  if (currentTab === "home") return renderHome();
  if (currentTab === "songs") {
    if (selectedSongId) return renderSongDetail(selectedSongId);
    if (songsView === "create") return renderSongCreate();
    return renderSongsList();
  }
  if (currentTab === "player") return renderPlayer();
  if (currentTab === "settings") return renderSettings();
}

function renderProjects() {
  setHeader("Projects");

  // safer:
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
    state.settings.defaultProject = name; // this “creates” it by making it default
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

      // Jump to songs tab and prefill search with project name
      drawerView = null;
      currentTab = "songs";
      songsView = "list";
      setHeader("Songs");
      renderSongsList();

      // after render, fill search box
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
      <div class="small">This is ready for the next step: define EPs and assign songs to them.</div>
      <div class="hr"></div>
      <div class="small">Want EPs to be:</div>
      <ul class="small">
        <li>A named collection of songs</li>
        <li>With artwork + track order</li>
        <li>And a “release status”</li>
      </ul>
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

  // Parse collaborators from songs.collaborators (comma separated)
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
      <div class="small">Pulled automatically from your song “Collaborators” field (comma-separated).</div>
      <div class="hr"></div>

      <div class="list">
        ${rows || `<div class="small">No collaborators yet. Add names on songs (ex: "Darian, Mason").</div>`}
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
      setHeader("Songs");
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
      <div class="small">Use the top-right buttons anytime. This screen is just a friendly hub.</div>
      <div class="hr"></div>
      <div class="row" style="gap:10px">
        <button id="doExport" class="btn primary">Export backup</button>
        <button id="doImport" class="btn">Import backup</button>
      </div>
      <div class="small" style="margin-top:10px">
        Import replaces local data on this device. Export first if you care.
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

function renderHome() {
  setHeader("Home");
  view.innerHTML = `
    <div class="homeWrap">
      <div class="tileGrid">
        <button class="tile" data-home="songs"><div class="tileIcon">🎵</div><div class="tileLabel">Songs</div></button>
        <button class="tile" data-home="projects"><div class="tileIcon">📁</div><div class="tileLabel">Projects</div></button>
        <button class="tile" data-home="browse"><div class="tileIcon">🔎</div><div class="tileLabel">Browse</div></button>
        <button class="tile" data-home="lyrics"><div class="tileIcon">✍️</div><div class="tileLabel">Lyrics</div></button>
      </div>
      <button class="tile tileCenter" data-home="next"><div class="tileIcon">✅</div><div class="tileLabel">Next Actions</div></button>
      <div class="homeActions">
        <button class="ctaSmall" id="quickLogBtn">⚡ Quick log</button>
        <button class="ctaBig" id="startSessionBtn">Start a session</button>
      </div>
    </div>
  `;

  view.querySelectorAll('[data-home]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-home');
      if (target === 'songs') {
        currentTab = 'songs';
        songsView = 'list';
        selectedSongId = null;
        setHeader('Songs');
        render();
        return;
      }
      if (target === 'projects') {
        setDrawerView('projects');
        return;
      }
      if (target === 'browse') {
        currentTab = 'songs';
        songsView = 'list';
        selectedSongId = null;
        setHeader('Songs');
        render();
        setTimeout(() => $('#q')?.focus(), 0);
        return;
      }
      if (target === 'lyrics') {
        renderLyricsScratch();
        return;
      }
      if (target === 'next') {
        renderNextActions();
      }
    });
  });

  $('#quickLogBtn')?.addEventListener('click', () => {
    const val = prompt('Quick log');
    if (!val || !val.trim()) return;
    state.quickLog = Array.isArray(state.quickLog) ? state.quickLog : [];
    state.quickLog.unshift({ id: uid(), text: val.trim(), at: nowStamp() });
    saveState();
    toast('Logged ⚡');
  });

  $('#startSessionBtn')?.addEventListener('click', () => {
    const active = [...state.songs]
      .filter((song) => (song.stuckState || 'Active') === 'Active')
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
    const pick = active || [...state.songs].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
    if (!pick) return toast('Add a song first 🎵');
    currentTab = 'songs';
    selectedSongId = pick.id;
    songsView = 'list';
    render();
  });
}

function renderLyricsScratch() {
  setHeader('Lyrics');
  const value = state.settings.lyricsScratch || '';
  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between; align-items:center">
        <h2>Lyrics scratch</h2>
        <button id="closeLyrics" class="ghost">Close</button>
      </div>
      <textarea id="lyricsScratch" placeholder="Capture lyric ideas...">${escapeTextarea(value)}</textarea>
      <div class="row" style="margin-top:10px"><button id="saveLyricsScratch" class="btn primary">Save</button></div>
    </div>
  `;
  $('#closeLyrics')?.addEventListener('click', renderHome);
  $('#saveLyricsScratch')?.addEventListener('click', () => {
    state.settings.lyricsScratch = $('#lyricsScratch').value;
    saveState();
    toast('Lyrics saved ✍️');
  });
}

function renderNextActions() {
  setHeader('Next Actions');
  const songs = state.songs.filter((s) => (s.nextAction || '').trim());
  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between; align-items:center">
        <h2>Next Actions</h2>
        <button id="closeNextActions" class="ghost">Close</button>
      </div>
      <div class="songsList">
        ${songs.length ? songs.map((s) => `<div class="songRow" data-open-song="${s.id}"><div class="title">${escapeHtml(s.title)}</div><div class="meta">${escapeHtml(s.nextAction || '')}</div></div>`).join('') : '<div class="small" style="padding:12px 0">No next actions yet.</div>'}
      </div>
    </div>
  `;
  $('#closeNextActions')?.addEventListener('click', renderHome);
  view.querySelectorAll('[data-open-song]').forEach((el) => el.addEventListener('click', () => {
    currentTab = 'songs';
    selectedSongId = el.getAttribute('data-open-song');
    render();
  }));
}

// ----------------------
// Songs list + creation
// ----------------------
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
          ${["Idea", "Demo", "Arrange", "Mix", "Master", "Ready", "Done", "Released"]
            .map(
              (s) =>
                `<option value="${s}" ${songsListState.statusFilter === s ? "selected" : ""}>${s}</option>`
            )
            .join("")}
        </select>
        <select id="projectFilter">
          <option value="">All projects</option>
          ${projects
            .map(
              (p) =>
                `<option value="${escapeHtml(p)}" ${songsListState.projectFilter === p ? "selected" : ""}>${escapeHtml(p)}</option>`
            )
            .join("")}
        </select>
      </div>
    </div>

    <div id="songList" class="songsList"></div>

    <button id="fabAddSong" class="fab" aria-label="Add song">+</button>
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
        if (songsListState.sortMode === "title") {
          return (a.title || "").localeCompare(b.title || "");
        }
        if (songsListState.sortMode === "status") {
          const statusSort = (a.status || "").localeCompare(b.status || "");
          if (statusSort !== 0) return statusSort;
          return (b.updatedAt || "").localeCompare(a.updatedAt || "");
        }
        return (b.updatedAt || "").localeCompare(a.updatedAt || "");
      });

    listEl.innerHTML = filtered.length
      ? filtered
          .map((s) => {
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
              <div class="meta">${escapeHtml(s.project)} • ${escapeHtml(
              s.genre || "—"
            )} • Sprint: ${escapeHtml(s.sprint || "—")} • Versions: ${vCount}</div>
              ${s.nextAction ? `<div class="meta">Next: ${escapeHtml(s.nextAction)}</div>` : ""}
            </div>
          `;
          })
          .join("")
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
      view
        .querySelectorAll(".segTab")
        .forEach((t) => t.classList.toggle("active", t === btn));
      applyFilter();
    });
  });

  $("#q").addEventListener("input", applyFilter);
  $("#statusFilter").addEventListener("change", applyFilter);
  $("#projectFilter").addEventListener("change", applyFilter);

  $("#fabAddSong")?.addEventListener("click", () => {
    drawerView = null;
    selectedSongId = null;
    songsView = "create";
    currentTab = "songs";
    setHeader("Upload Song");
    render();
  });

  applyFilter();
}

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
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "textarea" || tag === "input" || tag === "select") return;

      const y = e.touches?.[0]?.clientY ?? 0;
      const dy = y - startY;

      const atTop = container.scrollTop <= 0;
      const atBottom =
        Math.ceil(container.scrollTop + container.clientHeight) >=
        container.scrollHeight;

      if ((atTop && dy > 0) || (atBottom && dy < 0)) e.preventDefault();
    },
    { passive: false }
  );
}

function renderSongCreate() {
  setHeader("Upload Song");

  view.innerHTML = `
    <div class="card">
      <h2>Upload Song</h2>
      <div class="row">
        <div class="col">
          <div class="label">Title</div>
          <input id="newTitle" type="text" placeholder="e.g. Internal (FFND)" />
        </div>
        <div class="col">
          <div class="label">Project</div>
          <input id="newProject" type="text" value="${escapeHtml(
            state.settings.defaultProject
          )}" />
        </div>
      </div>
      <div class="row" style="margin-top:10px">
        <div class="col">
          <div class="label">Genre</div>
          <input id="newGenre" type="text" value="${escapeHtml(
            state.settings.defaultGenre
          )}" />
        </div>
        <div class="col">
          <div class="label">Sprint</div>
          <input id="newSprint" type="text" value="${escapeHtml(
            state.settings.defaultSprint
          )}" />
        </div>
      </div>
      <div class="row" style="margin-top:10px">
        <button id="createSong" class="btn primary">Create & Upload</button>
        <button id="backToList" class="ghost">Back</button>
      </div>
    </div>
  `;

  $("#backToList").addEventListener("click", () => {
    songsView = "list";
    setHeader("Songs");
    render();
  });

  $("#createSong").addEventListener("click", () => {
    const title = $("#newTitle").value.trim();
    if (!title) return toast("Give it a title 🙂");

    const song = {
      id: uid(),
      title,
      project: $("#newProject").value.trim() || "Project",
      genre: $("#newGenre").value.trim() || "",
      sprint: $("#newSprint").value.trim() || "Unsorted",
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
    selectedSongId = song.id;
    songsView = "list";
    pendingScrollToUpload = true;
    setHeader("Song");
    render();
  });
}

// ----------------------
// Song detail
// ----------------------
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
      <div class="small">Updated: <b>${escapeHtml(song.updatedAt)}</b></div>
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
          <input id="inst" type="text" placeholder="e.g. Drop G# 7-string, synth pads" value="${escapeHtml(
            song.instrumentation
          )}"/>
        </div>
        <div class="col">
          <div class="label">Collaborators</div>
          <input id="collab" type="text" placeholder="e.g. Darian, Mason" value="${escapeHtml(
            song.collaborators
          )}"/>
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
          <input id="nextAction" type="text" placeholder="e.g. Write verse 2 / re-track guitars" value="${escapeHtml(
            song.nextAction || ""
          )}"/>
        </div>
      </div>

      <div class="row" style="margin-top:10px">
        <button id="saveSong" class="btn primary">Save</button>
      </div>
    </div>

    <div class="card">
      <h2>Vibes</h2>
      <textarea id="vibes" placeholder="What should this feel like?">${escapeTextarea(
        song.vibes
      )}</textarea>
      <div class="hr"></div>
      <h2>Lyrics</h2>
      <textarea id="lyrics" placeholder="Draft lyrics / fragments…">${escapeTextarea(
        song.lyrics
      )}</textarea>
      <div class="hr"></div>
      <h2>Notes</h2>
      <textarea id="notes" placeholder="Mix notes, arrangement notes…">${escapeTextarea(
        song.notes
      )}</textarea>
      <div class="row" style="margin-top:10px">
        <button id="saveText" class="btn primary">Save text</button>
      </div>
    </div>

    <div class="card">
      <h2>Versions</h2>
      <div class="small">Drive folder suggestion: <span class="mono">${escapeHtml(
        drivePath
      )}</span></div>
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
        bv
          ? `
        <div class="small">Best: <b>${escapeHtml(bv.label)}</b></div>
        <div style="margin-top:10px">
          <audio controls style="width:100%" ${
            bv.link ? `src="${escapeHtml(bv.link)}"` : ""
          }></audio>
        </div>
        <div class="small" style="margin-top:10px">${
          bv.link
            ? "If it doesn’t play, use a direct audio URL."
            : "Paste a link on the version to enable playback."
        }</div>
      `
          : `<div class="small">No versions yet.</div>`
      }
    </div>
  `;

  $("#back").addEventListener("click", () => {
    selectedSongId = null;
    setHeader("Songs");
    render();
  });

  $("#delSong").addEventListener("click", () => {
    if (!confirm(`Delete "${song.title}"?`)) return;
    state.songs = state.songs.filter((s) => s.id !== song.id);
    saveState();
    toast("Deleted 🗑️");
    selectedSongId = null;
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
    makeBestEl.querySelector("span:last-child").textContent = makeBest
      ? "Yes"
      : "No";
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
      id: uid(), // ✅ fixed
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
    setTimeout(() => {
      $("#pickFile")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }
}

function renderVersionsList(song) {
  const listEl = $("#versionsList");
  const versions = song.versions || [];

  listEl.innerHTML = versions.length
    ? versions
        .map(
          (v) => `
        <div class="item" style="cursor:default">
          <div class="row" style="justify-content:space-between; align-items:center">
            <div class="title">${escapeHtml(v.label)}</div>
            <div class="row" style="gap:8px; justify-content:flex-end">
              ${v.isBest ? `<span class="badge good">⭐ Best</span>` : `<span class="badge">—</span>`}
            </div>
          </div>
          <div class="meta">Created: ${escapeHtml(v.createdAt)}${
            v.notes ? ` • Notes: ${escapeHtml(v.notes)}` : ""
          }</div>
          <div class="row" style="margin-top:10px; gap:8px; flex-wrap:wrap">
            <button class="btn" data-best="${v.id}">${v.isBest ? "Best ✅" : "Set Best ⭐"}</button>
            <button class="btn" data-active="${v.id}">${v.isActive ? "Active ✅" : "Set Active 🎧"}</button>
            <button class="btn" data-copy="${v.id}">Copy name</button>
            <button class="btn" data-open="${v.id}" ${v.link ? "" : "disabled"}>Open link</button>
            <button class="btn" data-del="${v.id}">Delete</button>
          </div>
          ${
            v.link
              ? `<div class="small" style="margin-top:8px">Link: <span class="mono">${escapeHtml(
                  v.link
                )}</span></div>`
              : `<div class="small" style="margin-top:8px"><i>No link yet</i> (paste after uploading)</div>`
          }
        </div>
      `
        )
        .join("")
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
      if (song.versions.length && !song.versions.some((x) => x.isBest))
        song.versions[0].isBest = true;
      song.updatedAt = nowStamp();
      saveState();
      toast("Deleted 🗑️");
      renderSongDetail(song.id);
    })
  );
}

// ----------------------
// Player (best-only)
// ----------------------
function renderPlayer() {
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
            ${activeVersions
              .map(
                ({ song, v }) => `
              <div class="item">
                <div class="row" style="justify-content:space-between; align-items:center">
                  <div class="title"><b>${escapeHtml(song.title)}</b></div>
                  <button class="btn" data-open-song="${song.id}">Open</button>
                </div>
                <div class="meta">${escapeHtml(song.project || "—")} • ${escapeHtml(v.label || "Version")}</div>
                <audio controls style="width:100%; margin-top:10px" src="${escapeHtml(v.link)}"></audio>
              </div>`
              )
              .join("")}
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

// ----------------------
// Dashboard
// ----------------------
function renderDashboard() {
  const total = state.songs.length;
  const byStatus = {};
  const byProject = {};
  const stuck = { Active: 0, Stuck: 0, Parked: 0 };

  state.songs.forEach((s) => {
    byStatus[s.status] = (byStatus[s.status] || 0) + 1;
    byProject[s.project] = (byProject[s.project] || 0) + 1;
    stuck[s.stuckState || "Active"] = (stuck[s.stuckState || "Active"] || 0) + 1;
  });

  const rows = (obj) =>
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .map(
        ([k, v]) =>
          `<div class="row" style="justify-content:space-between"><div>${escapeHtml(
            k
          )}</div><div><b>${v}</b></div></div>`
      )
      .join("");

  view.innerHTML = `
    <div class="card">
      <h2>Dashboard</h2>
      <div class="row" style="justify-content:space-between">
        <div>Total songs</div>
        <div style="font-size:22px"><b>${total}</b></div>
      </div>
      <div class="hr"></div>
      <h2>By status</h2>
      ${rows(byStatus) || `<div class="small">No songs yet.</div>`}
      <div class="hr"></div>
      <h2>By project</h2>
      ${rows(byProject) || `<div class="small">No songs yet.</div>`}
      <div class="hr"></div>
      <h2>Stuck state</h2>
      ${rows(stuck)}
    </div>
  `;
}

// ----------------------
// Settings
// ----------------------
function renderSettings() {
  view.innerHTML = `
    <div class="card">
      <h2>Settings</h2>

      <div class="label">Drive root folder name</div>
      <input id="driveRoot" type="text" value="${escapeHtml(
        state.settings.driveRoot || "RiffBank"
      )}" />
      <div class="small">Used to suggest where files should live in Google Drive/iCloud/etc.</div>

      <div class="hr"></div>
      <h2>Defaults</h2>

      <div class="row">
        <div class="col">
          <div class="label">Default project</div>
          <input id="defProject" type="text" value="${escapeHtml(
            state.settings.defaultProject || ""
          )}" />
        </div>
        <div class="col">
          <div class="label">Default genre</div>
          <input id="defGenre" type="text" value="${escapeHtml(
            state.settings.defaultGenre || ""
          )}" />
        </div>
      </div>

      <div class="row" style="margin-top:10px">
        <div class="col">
          <div class="label">Default sprint</div>
          <input id="defSprint" type="text" value="${escapeHtml(
            state.settings.defaultSprint || ""
          )}" />
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
    toast("Wiped 🧼");
    render();
  });
}

// Boot
setHeader("Home");
render();
preventRubberBandScroll(view);

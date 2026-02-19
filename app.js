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

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

function saveState() {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}

// PWA SW register
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

const TAB_TITLES = {
  songs: "Songs",
  player: "Player",
  dashboard: "Dashboard",
  settings: "Settings",
};

let currentTab = "songs";
let selectedSongId = null;

function setHeader(t) {
  if (headerTitle) headerTitle.textContent = t;
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
  if (s === "done" || s === "released") return `<span class="badge good">✅ ${escapeHtml(status)}</span>`;
  if (s === "mix" || s === "master" || s === "ready") return `<span class="badge warn">⚡ ${escapeHtml(status)}</span>`;
  return `<span class="badge">🎧 ${escapeHtml(status || "Idea")}</span>`;
}

// Tabs
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    currentTab = btn.dataset.tab;
    selectedSongId = null;
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    setHeader(TAB_TITLES[currentTab] || "RiffBank");
    render();
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
    if (!confirm("Import will replace your current data on this device. Continue?")) return;
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
  if (currentTab === "songs") {
    if (selectedSongId) return renderSongDetail(selectedSongId);
    return renderSongsList();
  }
  if (currentTab === "player") return renderPlayer();
  if (currentTab === "dashboard") return renderDashboard();
  if (currentTab === "settings") return renderSettings();
}

// ----------------------
// Songs list + creation
// ----------------------
function renderSongsList() {
  const songs = [...state.songs].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));

  view.innerHTML = `
    <div class="card">
      <h2>New song</h2>
      <div class="row">
        <div class="col">
          <div class="label">Title</div>
          <input id="newTitle" type="text" placeholder="e.g. Internal (FFND)" />
        </div>
        <div class="col">
          <div class="label">Project</div>
          <input id="newProject" type="text" value="${escapeHtml(state.settings.defaultProject)}" />
        </div>
      </div>
      <div class="row" style="margin-top:10px">
        <div class="col">
          <div class="label">Genre</div>
          <input id="newGenre" type="text" value="${escapeHtml(state.settings.defaultGenre)}" />
        </div>
        <div class="col">
          <div class="label">Sprint</div>
          <input id="newSprint" type="text" value="${escapeHtml(state.settings.defaultSprint)}" />
        </div>
      </div>
      <div class="row" style="margin-top:10px">
        <button id="createSong" class="btn primary">Create</button>
      </div>
      <div class="small" style="margin-top:10px">Local-only. Export backups anytime.</div>
    </div>

    <div class="card">
      <h2>Search</h2>
      <div class="row">
        <div class="col">
          <input id="q" type="text" placeholder="Search title / lyrics / notes / collaborators..." />
        </div>
        <div class="col">
          <select id="statusFilter">
            <option value="">All statuses</option>
            ${["Idea","Demo","Arrange","Mix","Master","Ready","Done","Released"].map(s => `<option value="${s}">${s}</option>`).join("")}
          </select>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Your songs (${songs.length})</h2>
      <div id="songList" class="list"></div>
    </div>
  `;

  $("#createSong").addEventListener("click", () => {
    const title = $("#newTitle").value.trim();
    if (!title) return toast("Give it a title 🙂");

    const song = {
      id: crypto.randomUUID(),
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
    $("#newTitle").value = "";
    toast("Created 🎸");
    renderSongsList();
  });

  const listEl = $("#songList");

  const applyFilter = () => {
    const q = ($("#q").value || "").toLowerCase();
    const sf = $("#statusFilter").value;

    const filtered = songs.filter((s) => {
      const hay = `${s.title} ${s.project} ${s.genre} ${s.sprint} ${s.instrumentation} ${s.collaborators} ${s.vibes} ${s.lyrics} ${s.notes}`.toLowerCase();
      const qOk = !q || hay.includes(q);
      const sOk = !sf || s.status === sf;
      return qOk && sOk;
    });

    listEl.innerHTML = filtered.length
      ? filtered.map((s) => {
          const vCount = s.versions?.length || 0;
          const stuckBadge =
            s.stuckState === "Stuck" ? `<span class="badge bad">🧊 Stuck</span>` :
            s.stuckState === "Parked" ? `<span class="badge warn">💤 Parked</span>` :
            `<span class="badge">✅ Active</span>`;

          return `
            <div class="item" data-id="${s.id}">
              <div class="row" style="justify-content:space-between; align-items:center">
                <div class="title"><b>${escapeHtml(s.title)}</b></div>
                <div class="row" style="gap:8px; justify-content:flex-end">
                  ${badgeForStatus(s.status)}
                  ${stuckBadge}
                </div>
              </div>
              <div class="meta">${escapeHtml(s.project)} • ${escapeHtml(s.genre || "—")} • Sprint: ${escapeHtml(s.sprint || "—")} • Versions: ${vCount}</div>
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

  $("#q").addEventListener("input", applyFilter);
  $("#statusFilter").addEventListener("change", applyFilter);
  applyFilter();
}

// ----------------------
// Song detail
// ----------------------
function renderSongDetail(id) {
  const song = getSong(id);
  if (!song) { selectedSongId = null; return renderSongsList(); }

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
            ${["Idea","Demo","Arrange","Mix","Master","Ready","Done","Released"].map(s => `<option ${song.status===s?'selected':''}>${s}</option>`).join("")}
          </select>
        </div>
        <div class="col">
          <div class="label">Stuck state</div>
          <select id="stuck">
            ${["Active","Stuck","Parked"].map(s => `<option ${song.stuckState===s?'selected':''}>${s}</option>`).join("")}
          </select>
        </div>
      </div>

      <div class="row" style="margin-top:10px">
        <div class="col">
          <div class="label">Next action</div>
          <input id="nextAction" type="text" placeholder="e.g. Write verse 2 / re-track guitars" value="${escapeHtml(song.nextAction||"")}"/>
        </div>
      </div>

      <div class="row" style="margin-top:10px">
        <button id="saveSong" class="btn primary">Save</button>
      </div>
    </div>

    <div class="card">
      <h2>Vibes</h2>
      <textarea id="vibes" placeholder="What should this feel like?">${escapeHtml(song.vibes)}</textarea>
      <div class="hr"></div>
      <h2>Lyrics</h2>
      <textarea id="lyrics" placeholder="Draft lyrics / fragments…">${escapeHtml(song.lyrics)}</textarea>
      <div class="hr"></div>
      <h2>Notes</h2>
      <textarea id="notes" placeholder="Mix notes, arrangement notes…">${escapeHtml(song.notes)}</textarea>
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
      ${bv ? `
        <div class="small">Best: <b>${escapeHtml(bv.label)}</b></div>
        <div style="margin-top:10px">
          <audio controls style="width:100%" ${bv.link ? `src="${escapeHtml(bv.link)}"` : ""}></audio>
        </div>
        <div class="small" style="margin-top:10px">${bv.link ? "If it doesn’t play, use a direct audio URL." : "Paste a link on the version to enable playback."}</div>
      ` : `<div class="small">No versions yet.</div>`}
    </div>
  `;

  $("#back").addEventListener("click", () => { selectedSongId = null; setHeader("Songs"); render(); });

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
    makeBestEl.querySelector("span:last-child").textContent = makeBest ? "Yes" : "No";
    // refresh suggested filename if file already chosen
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

    const label = f ? suggestedFileName(song, f.name, makeBest) : `Version - ${nowStamp()}${makeBest ? " (BEST)" : ""}`;

    const v = {
      id: crypto.randomUUID(),
      createdAt: nowStamp(),
      label,
      notes,
      link,
      isBest: makeBest,
    };

    song.versions = song.versions || [];

    // if this is best, clear best from others
    if (makeBest) song.versions.forEach((x) => (x.isBest = false));
    song.versions.unshift(v);

    // ensure at least one best exists
    if (!song.versions.some((x) => x.isBest)) song.versions[0].isBest = true;

    song.updatedAt = nowStamp();
    saveState();

    // reset UI
    $("#vNotes").value = "";
    $("#driveLink").value = "";
    pickFileEl.value = "";
    suggestedNameEl.value = "Pick a file…";

    toast("Version added 🎧");
    renderSongDetail(song.id);
  });

  renderVersionsList(song);
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
            <button class="btn" data-copy="${v.id}">Copy name</button>
            <button class="btn" data-open="${v.id}" ${v.link ? "" : "disabled"}>Open link</button>
            <button class="btn" data-del="${v.id}">Delete</button>
          </div>
          ${v.link
            ? `<div class="small" style="margin-top:8px">Link: <span class="mono">${escapeHtml(v.link)}</span></div>`
            : `<div class="small" style="margin-top:8px"><i>No link yet</i> (paste after uploading)</div>`
          }
        </div>
      `).join("")
    : `<div class="small">No versions yet. Add one above.</div>`;

  // handlers
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

// ----------------------
// Player (best-only)
// ----------------------
function renderPlayer() {
  const bests = state.songs
    .map((s) => ({ song: s, best: bestVersion(s) }))
    .filter((x) => x.best && x.best.link);

  view.innerHTML = `
    <div class="card">
      <h2>Best-only player</h2>
      <div class="small">Plays the best version links you’ve pasted.</div>
      <div class="hr"></div>
      ${bests.length ? `
        <div class="list">
          ${bests.map(({song, best}) => `
            <div class="item">
              <div class="row" style="justify-content:space-between; align-items:center">
                <div class="title"><b>${escapeHtml(song.title)}</b></div>
                <button class="btn" data-open-song="${song.id}">Open</button>
              </div>
              <div class="meta">${escapeHtml(song.project)} • ${escapeHtml(song.genre || "—")} • ${escapeHtml(best.label)}</div>
              <audio controls style="width:100%; margin-top:10px" src="${escapeHtml(best.link)}"></audio>
            </div>
          `).join("")}
        </div>
      ` : `<div class="small">No playable best versions yet. Add a link to a version.</div>`}
    </div>
  `;

  view.querySelectorAll("[data-open-song]").forEach((b) =>
    b.addEventListener("click", () => {
      selectedSongId = b.getAttribute("data-open-song");
      currentTab = "songs";
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === "songs"));
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

  const rows = (obj) => Object.entries(obj).sort((a,b) => b[1]-a[1])
    .map(([k,v]) => `<div class="row" style="justify-content:space-between"><div>${escapeHtml(k)}</div><div><b>${v}</b></div></div>`).join("");

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
      <input id="driveRoot" type="text" value="${escapeHtml(state.settings.driveRoot || "RiffBank")}" />
      <div class="small">Used to suggest where files should live in Google Drive/iCloud/etc.</div>

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
    toast("Wiped 🧼");
    render();
  });
}

// Boot
setHeader("Songs");
render();

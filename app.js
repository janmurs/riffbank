// RiffBank v1.2 (Local-only PWA)
// - Song creation + editing
// - Upload Helper (suggested filename + Drive path)
// - Version history + Best flag
// - Best-only Player (plays links)
// - Dashboard + Settings
// - Export / Import

const LS_KEY = "riffbank_v1";
const $ = (sel) => document.querySelector(sel);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let splashAlreadyRan = false;

// -----------------------------
// Splash animation sequence (awaitable)
// -----------------------------
async function runSplashSequence() {
  const splash = document.getElementById("splash");
  const title = document.getElementById("splashTitle");
  const subWrap = document.getElementById("splashSub");       // wrapper div (IMPORTANT)
  const subText = document.getElementById("splashSubText");   // text span
  const spinner = document.getElementById("splashSpinner");

  if (!splash) return;

  document.body.classList.add("splashing");

  // Add shimmer to title (CSS handles the effect)
  if (title) title.classList.add("shimmer");

  // ✅ IMPORTANT: NO built-in "…" here — the dancing dots handle that inline
  const lines = [
    "Indexing your universe",
    "Syncing sessions",
    "Entering RiffBank",
  ];

  // ---- timing knobs (premium, not rushed) ----
  const HOLD_1 = 2400;
  const HOLD_2 = 2400;
  const HOLD_3 = 900;

  // Read jump duration from CSS var if available (fallback to 520)
  const cssJump = (() => {
    try {
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue("--splash-jump-ms")
        .trim();
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : 520;
    } catch {
      return 520;
    }
  })();

  const JUMP_MS = cssJump;
  const JUMP_IN_SETTLE = 80;

  // Ensure initial DOM text is correct (DON’T wipe children)
  if (subText) subText.textContent = lines[0];

  // Start hidden; CSS should manage actual opacity/position
  // ✅ Jump classes belong on the WRAPPER (#splashSub) because CSS animates #splashSub
  if (subWrap) subWrap.classList.remove("show", "churn", "jumpIn", "jumpOut", "static");

  // Hide spinner until after the 1.2s logo moment
  if (spinner) spinner.classList.remove("show");

  // --- 1.2s “logo shine” moment ---
  await sleep(1200);

  // Slide title up + fade in spinner/sub area
  splash.classList.add("phase1");
  if (spinner) spinner.classList.add("show");

  if (subWrap) subWrap.classList.add("show", "churn", "static"); // phrase 1 = stable display

  // Let the title slide animation complete before we start text transitions
  await sleep(550);

  async function jumpSwap(nextText) {
    if (!subWrap || !subText) return;

    // ✅ FIX: "static" disables animation via CSS (!important),
    // so remove it during the jump, then restore after.
    subWrap.classList.remove("static");

    // OUT current phrase
    subWrap.classList.remove("jumpIn", "jumpOut");
    void subWrap.offsetHeight;          // ✅ restart animation reliably
    subWrap.classList.add("jumpOut");
    await sleep(JUMP_MS);

    // swap text
    subWrap.classList.remove("jumpOut");
    void subWrap.offsetHeight;          // ✅ restart animation reliably
    subText.textContent = nextText;

    // IN next phrase
    subWrap.classList.add("jumpIn");
    await sleep(JUMP_MS);

    subWrap.classList.remove("jumpIn");

    // ✅ restore static "stable" state after jump completes
    subWrap.classList.add("static");
  }

  // ---- Hold PHRASE 1 ----
  await sleep(HOLD_1);

  // ✅ Phrase 1 -> Phrase 2 (JUMP)
  await jumpSwap(lines[1]);

  // ---- Hold PHRASE 2 ----
  await sleep(HOLD_2);

  // ✅ Phrase 2 -> Phrase 3 (JUMP)
  // ✅ AND: no "jump" after phrase 3 (only hold + fade out)
  await jumpSwap(lines[2]);

  // Hold briefly while app finishes rendering
  await sleep(HOLD_3);

  // Hide splash (no extra jump here)
  splash.classList.add("hide");
  splash.setAttribute("aria-hidden", "true");
  await sleep(420);
  splash.remove();

  document.body.classList.remove("splashing");
}

const view = $("#view");
if (!view) {
  console.error("RiffBank: #view not found. Check index.html structure.");
}
const headerTitle = $("#headerTitle");
const toastEl = $("#toast");

// ---------------------
// Audio storage (IndexedDB) - Phase 1
// ---------------------
const AUDIO_DB = "riffbank_audio_v1";
const AUDIO_STORE = "files";
const audioUrlCache = new Map(); // localAudioId -> objectURL

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
const miniTitleEl = document.getElementById("miniTitle");
const miniSubEl = document.getElementById("miniSub");
const miniToggleEl = document.getElementById("miniToggle");
const miniNextEl = document.getElementById("miniNext");
const miniPrevEl = document.getElementById("miniPrev");

function isPlayable(v){
  return !!(v?.link || v?.fileId || v?.localAudioId);
}

async function syncMiniPlayerUI() {
  if (!miniPlayerEl) return;

  const now = state.player?.nowPlaying;
  if (!now) {
    miniPlayerEl.classList.add("hidden");
    miniPlayerEl.classList.remove("visible");
    miniPlayerEl.setAttribute("aria-hidden", "true");
    document.body.classList.remove("hasMiniPlayer");
    return;
  }

  const song = getSong(now.songId);
  const v = song ? getVersion(song, now.versionId) : null;

  if (!song || !v || !isPlayable(v)) {
    miniPlayerEl.classList.add("hidden");
    miniPlayerEl.classList.remove("visible");
    miniPlayerEl.setAttribute("aria-hidden", "true");
    document.body.classList.remove("hasMiniPlayer");
    return;
  }

  // show
  miniPlayerEl.classList.remove("hidden");
  miniPlayerEl.setAttribute("aria-hidden", "false");
  document.body.classList.add("hasMiniPlayer");

  // optional "animate in"
  requestAnimationFrame(() => miniPlayerEl.classList.add("visible"));

  miniTitleEl.textContent = song.title || "Untitled";
  miniSubEl.textContent = v.label || "Version";
  miniToggleEl.textContent = globalAudio?.paused ? "▶" : "⏸";

  const qb = document.getElementById("miniQueueBadge");
  const qCount = (state.player?.queue || []).length;
  if (qb) {
    qb.style.display = qCount ? "inline-flex" : "none";
    qb.textContent = String(qCount);
  }
}

const miniScrubEl = document.getElementById("miniScrub");

function syncMiniScrub(){
  if (!miniScrubEl || !globalAudio) return;
  if (Number.isFinite(globalAudio.duration) && globalAudio.duration > 0) {
    miniScrubEl.value = String(Math.floor((globalAudio.currentTime / globalAudio.duration) * 1000));
  } else {
    miniScrubEl.value = "0";
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
    });
    // ✅ new: featured version pointer
    if (song.featuredVersionId === undefined) song.featuredVersionId = null;
  });
  // Player state (queue)
  state.player = state.player || {};
  state.player.queue = Array.isArray(state.player.queue) ? state.player.queue : [];
  state.player.nowPlaying = state.player.nowPlaying || null;
}

normalizeState();

function saveState() {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
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

// Turn a version into a playable URL (blob or link)
async function getPlayableUrlForVersion(songId, versionId) {
  const song = getSong(songId);
  const v = getVersion(song, versionId);
  if (!song || !v) return null;

  // Local file (fileId) beats link
  if (v.fileId) {
    const rec = await audioGet(v.fileId);
    if (!rec?.blob) return null;
    return URL.createObjectURL(rec.blob);
  }

  // Local file (localAudioId) fallback
  if (v.localAudioId) {
    const url = await getLocalObjectUrl(v.localAudioId);
    if (url) return url;
  }

  if (v.link) return v.link;
  return null;
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
let selectedVersionId = null; // ✅ new: when you tap a specific version row

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

function getVersion(song, versionId){
  return (song?.versions || []).find(v => v.id === versionId) || null;
}

function createVersion(song, { makeBest = true } = {}) {
  if (!song) return null;

  const vNum = (song.versions?.length || 0) + 1;

  const v = {
    id: uid(),
    label: `${song.title || "Song"} - v${vNum}`,
    notes: "",
    link: "",
    isBest: false,
    isActive: true,
    createdAt: nowStamp(),
  };

  song.versions = Array.isArray(song.versions) ? song.versions : [];
  song.versions.unshift(v);

  // First version defaults
  if (makeBest) {
    song.versions.forEach(x => x.isBest = (x.id === v.id));
  }
  song.featuredVersionId = v.id;
  song.updatedAt = nowStamp();

  saveState();
  return v;
}

function featuredVersion(song){
  if (!song) return null;

  // 1) Explicit featured
  if (song.featuredVersionId) {
    const fv = getVersion(song, song.featuredVersionId);
    if (fv) return fv;
  }

  // 2) Best
  const bv = bestVersion(song);
  if (bv) return bv;

  // 3) Most recent active
  const av = (song.versions || []).find(v => v.isActive);
  if (av) return av;

  // 4) Anything
  return (song.versions || [])[0] || null;
}

function playVersion(songId, versionId, { goPlayer = true } = {}) {
  const song = getSong(songId);
  const v = getVersion(song, versionId);
  if (!song || !v || (!v.link && !v.fileId && !v.localAudioId))
    return toast("No playable audio for that version 😅");

  state.player.nowPlaying = { songId, versionId };
  saveState();
  toast("Playing ▶️");

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
  if (!song || !v || (!v.link && !v.fileId && !v.localAudioId))
  return toast("No playable audio for that version 😅");

  state.player.queue.push({ songId, versionId });
  saveState();
  toast("Queued ➕");
}

function setFeatured(songId, versionId){
  const song = getSong(songId);
  const v = getVersion(song, versionId);
  if (!song || !v) return;
  song.featuredVersionId = versionId;
  song.updatedAt = nowStamp();
  saveState();
  toast("Featured ⭐");
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

// Tabs (Player + Home + Settings)
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetTab = btn.dataset.tab || "home";
    songsBackTarget = null;

    // If you tap Home while already on the true Home root, open Create sheet
    if (targetTab === "home" && isHomeRoot()) {
      openSheet("chooser");
      return;
    }

    // Otherwise: normal navigation
    drawerView = null;
    overlayView = null;
    selectedSongId = null;
    songsView = "list";

    currentTab = targetTab;
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
  songsBackTarget = null;
  syncTabs();
  setHeader("RiffBank");
  render();
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

    // ✅ If you're in a version detail view, back goes to the song page
    if (selectedSongId && selectedVersionId) {
      selectedVersionId = null;
      currentTab = "songs";
      setHeader("Song");
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

    // If Songs list was opened from a drawer view (e.g. Projects -> View songs),
    // going back from the Songs list should return to that drawer view.
    if (
      currentTab === "songs" &&
      songsView === "list" &&
      !selectedSongId &&
      songsBackTarget
    ) {
      const target = songsBackTarget;
      songsBackTarget = null;

      overlayView = null;
      drawerView = target;     // ✅ back to Projects screen
      currentTab = "home";     // keep bottom nav unselected
      setHeader(TAB_TITLES[currentTab] || "RiffBank");
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

miniToggleEl?.addEventListener("click", async (e) => {
  e.stopPropagation();
  if (!globalAudio) return;

  if (globalAudio.paused) {
    await playNowPlaying({ autoplay: true });
  } else {
    globalAudio.pause();
    syncMiniPlayerUI();
  }
});

miniNextEl?.addEventListener("click", (e) => {
  e.stopPropagation();
  const q = state.player?.queue || [];
  if (!q.length) return toast("Queue empty 😅");
  state.player.nowPlaying = q.shift();
  saveState();
  playNowPlaying({ autoplay: true });
});

miniPrevEl?.addEventListener("click", (e) => {
  e.stopPropagation();
  // simple behavior: restart track
  if (!globalAudio) return;
  globalAudio.currentTime = 0;
});

miniPlayerEl?.addEventListener("click", () => {
  // tap bar opens full player view
  currentTab = "player";
  drawerView = null;
  overlayView = null;
  selectedSongId = null;
  selectedVersionId = null;
  setHeader("Player");
  syncTabs();
  render();
});

globalAudio?.addEventListener("play", syncMiniPlayerUI);
globalAudio?.addEventListener("pause", syncMiniPlayerUI);
globalAudio?.addEventListener("ended", () => {
  // auto-next if queue exists
  const q = state.player?.queue || [];
  if (q.length) {
    state.player.nowPlaying = q.shift();
    saveState();
    playNowPlaying({ autoplay: true });
  } else {
    syncMiniPlayerUI();
  }
});

// ---------------------
// Bottom sheet (GLOBAL)
// ---------------------
const sheet = $("#createSheet");
const sheetOverlay = $("#sheetOverlay");
const sheetContent = $("#sheetContent");
let sheetMode = "chooser"; // chooser | song | lyrics | songMenu | versionMenu | songFilters
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

    const playable = !!(v.link || v.fileId || v.localAudioId);

    sheetContent.innerHTML = `
      <div class="sheetTitle">${escapeHtml(song.title)}</div>
      <div class="small" style="margin-top:-6px; opacity:.75">${escapeHtml(v.label || "Version")}</div>

      <div class="sheetForm" style="gap:10px; margin-top:12px">
        <button class="sheetChoice" id="vmPlay" ${playable ? "" : "disabled"}>Play</button>
        <button class="sheetChoice" id="vmQueue" ${playable ? "" : "disabled"}>Add to Queue</button>
        <button class="sheetChoice" id="vmFeatured">Set as Featured ⭐</button>
        <button class="sheetChoice" id="vmToggleActive">${v.isActive ? "Active ✅ (toggle)" : "Set Active 🎧"}</button>
        <button class="sheetChoice" id="vmSetBest">${v.isBest ? "Best ✅" : "Set Best ⭐"}</button>
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
      playVersion(song.id, v.id, { goPlayer: true });
    });

    $("#vmQueue")?.addEventListener("click", () => {
      addToQueue(song.id, v.id);
      closeSheet();
    });

    $("#vmFeatured")?.addEventListener("click", () => {
      setFeatured(song.id, v.id);
      closeSheet();
      render(); // refresh UI
    });

    $("#vmToggleActive")?.addEventListener("click", () => {
      v.isActive = !v.isActive;
      song.updatedAt = nowStamp();
      saveState();
      toast("Active updated 🎧");
      closeSheet();
      render();
    });

    $("#vmSetBest")?.addEventListener("click", () => {
      song.versions.forEach(x => x.isBest = (x.id === v.id));
      song.updatedAt = nowStamp();
      saveState();
      toast("Best updated ⭐");
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
      song.versions = (song.versions || []).filter(x => x.id !== v.id);

      // If featured got deleted, clear it
      if (song.featuredVersionId === v.id) song.featuredVersionId = null;

      // Ensure at least one best remains if versions exist
      if (song.versions.length && !song.versions.some(x => x.isBest)) song.versions[0].isBest = true;

      song.updatedAt = nowStamp();
      saveState();
      toast("Deleted 🗑️");
      closeSheet();
      render();
    });

    $("#vmCancel")?.addEventListener("click", closeSheet);
    return;
  }
}

let sheetVersionMenu = { songId: null, versionId: null };

function openVersionMenu(songId, versionId){
  sheetVersionMenu = { songId, versionId };
  openSheet("versionMenu");
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
    if (selectedSongId && selectedVersionId) return renderVersionDetail(selectedSongId, selectedVersionId);
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

    songsBackTarget = "projects"; // ✅ remember where we came from

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
        resetSongsFilters({ keepSort: true }); // ✅ clear filters when opening Songs fresh
        songsBackTarget = null;               // optional: prevents weird “back target” reuse

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
        resetSongsFilters({ keepSort: true }); // ✅ browse starts clean too
        songsBackTarget = null;

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

function coverSvg(song){
  const seed = hashStr(`${song.id}|${song.title}|${song.project}|${song.genre}`);
  const r = makeRng(seed);

  // Neon palette via HSL
  const h1 = Math.floor(r()*360);
  const h2 = (h1 + 90 + Math.floor(r()*90)) % 360;
  const h3 = (h2 + 90 + Math.floor(r()*90)) % 360;

  const c1 = `hsl(${h1} 95% 60%)`;
  const c2 = `hsl(${h2} 95% 58%)`;
  const c3 = `hsl(${h3} 95% 62%)`;

  // Blob positions/sizes
  const b = Array.from({length: 3}).map(() => ({
    x: Math.floor(r()*120),
    y: Math.floor(r()*120),
    rad: Math.floor(40 + r()*55),
    col: [c1,c2,c3][Math.floor(r()*3)]
  }));

  // Streak
  const sx1 = Math.floor(r()*40);
  const sy1 = Math.floor(30 + r()*60);
  const sx2 = Math.floor(90 + r()*40);
  const sy2 = Math.floor(20 + r()*80);

  return `
  <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${c1}" stop-opacity=".95"/>
        <stop offset=".55" stop-color="${c2}" stop-opacity=".85"/>
        <stop offset="1" stop-color="${c3}" stop-opacity=".9"/>
      </linearGradient>

      <filter id="blur">
        <feGaussianBlur stdDeviation="12" />
      </filter>

      <filter id="grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
        <feColorMatrix type="matrix" values="
          1 0 0 0 0
          0 1 0 0 0
          0 0 1 0 0
          0 0 0 .12 0"/>
      </filter>

      <filter id="glow">
        <feGaussianBlur stdDeviation="3" result="b"/>
        <feMerge>
          <feMergeNode in="b"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    </defs>

    <!-- Base -->
    <rect width="120" height="120" fill="url(#g)"/>

    <!-- Neon blobs -->
    <g filter="url(#blur)" opacity=".9">
      ${b.map(x => `<circle cx="${x.x}" cy="${x.y}" r="${x.rad}" fill="${x.col}" opacity=".55"/>`).join("")}
    </g>

    <!-- Light streak -->
    <path d="M ${sx1} ${sy1} C ${sx1+35} ${sy1-30}, ${sx2-35} ${sy2+30}, ${sx2} ${sy2}"
          stroke="rgba(255,255,255,.65)" stroke-width="6" stroke-linecap="round" opacity=".22" filter="url(#glow)"/>

    <!-- Subtle vignette -->
    <radialGradient id="vig" cx="50%" cy="45%" r="70%">
      <stop offset="55%" stop-color="rgba(0,0,0,0)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,.35)"/>
    </radialGradient>
    <rect width="120" height="120" fill="url(#vig)"/>

    <!-- Grain -->
    <rect width="120" height="120" filter="url(#grain)" opacity=".55"/>
  </svg>`;
}

function parseStamp(stamp){
  // "YYYY-MM-DD HHMM"
  if (!stamp) return null;
  const [d, hm] = String(stamp).split(" ");
  if (!d || !hm || hm.length < 4) return null;
  const [yyyy, mm, dd] = d.split("-").map(Number);
  const hh = Number(hm.slice(0,2));
  const mi = Number(hm.slice(2,4));
  if (!yyyy || !mm || !dd) return null;
  return new Date(yyyy, mm-1, dd, hh, mi, 0, 0);
}

function timeAgo(stamp){
  const dt = parseStamp(stamp);
  if (!dt) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - dt.getTime()) / 1000));
  const min = Math.floor(sec/60);
  const hr = Math.floor(min/60);
  const day = Math.floor(hr/24);
  if (day >= 1) return `${day}d`;
  if (hr >= 1) return `${hr}h`;
  if (min >= 1) return `${min}m`;
  return "now";
}

function shortBestLabel(song){
  const bv = bestVersion(song);
  if (!bv?.label) return "—";
  const m = bv.label.match(/\bv(\d+(\.\d+)?)\b/i);
  if (m) return `v${m[1]}`;
  return "Best";
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

    <div id="songList" class="songsList"></div>
    <div class="small">Tip: use the center “New record” button to create.</div>
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

    listEl.innerHTML = filtered.length
      ? filtered.map((s) => {
                    const vCount = s.versions?.length || 0;
          const bestLbl = shortBestLabel(s);
          const updated = timeAgo(s.updatedAt || s.createdAt);

          const statusPill =
            (s.status || "").toLowerCase() === "done" || (s.status || "").toLowerCase() === "released"
              ? `pill good`
              : (s.status || "").toLowerCase() === "mix" || (s.status || "").toLowerCase() === "master" || (s.status || "").toLowerCase() === "ready"
              ? `pill warn`
              : `pill`;

          const stuckPill =
            s.stuckState === "Stuck" ? `pill bad`
            : s.stuckState === "Parked" ? `pill warn`
            : `pill`;

          const sub = `${s.genre || "—"} • ${(s.vibes || "").trim() ? (s.vibes || "").trim() : (s.nextAction || "").trim() ? `Next: ${s.nextAction}` : (s.project || "")}`.trim();

          return `
            <div class="songRow" data-id="${s.id}">
              <div class="songThumb" aria-hidden="true">
                ${coverSvg(s)}
                <div class="songDur">—:—</div>
              </div>

              <div class="songMain">
                <div class="songTop">
                  <div class="songTitleRow">
                    <div class="songTitle">${escapeHtml(s.title)}</div>
                    <div class="songPills">
                      <span class="${statusPill}">${escapeHtml(s.status || "Idea")}</span>
                      <span class="${stuckPill}">${escapeHtml(s.stuckState || "Active")}</span>
                    </div>
                  </div>

                  <button class="songMore" data-more="${s.id}" aria-label="Song menu">⋯</button>
                </div>

                <div class="songSub">${escapeHtml(sub)}</div>

                <div class="songMetaRow">
                  <span>🎧 ${vCount}</span>
                  <span class="sep">•</span>
                  <span>⭐ ${escapeHtml(bestLbl)}</span>
                  <span class="sep">•</span>
                  <span>🕒 ${escapeHtml(updated)}</span>
                </div>
              </div>
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

        listEl.querySelectorAll("[data-more]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-more");
        if (id) openSongMenu(id);
      });
    });
  };

  $("#q").addEventListener("input", applyFilter);

  $("#openSongFilters")?.addEventListener("click", openSongFilters);

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
function renderSongDetail(id) {
  const song = getSong(id);
  if (!song) {
    selectedSongId = null;
    selectedVersionId = null;
    return renderSongsList();
  }

  setHeader("Song");

  const fv = featuredVersion(song);
  const vCount = song.versions?.length || 0;

  // hero cover uses your neon generator
  const heroCover = coverSvg(song);

  const featuredTag = fv?.isBest ? "⭐ Best" : fv?.isActive ? "🎧 Active" : "Featured";
  const featuredSub = fv
    ? `${escapeHtml(fv.label || "Version")} ${fv.notes ? `• ${escapeHtml(fv.notes)}` : ""}`
    : "No versions yet — add one below";

  view.innerHTML = `
    <div class="songHero">
      <button class="songHeroBack" id="songHeroBack" aria-label="Back">←</button>

      <div class="songHeroCover">
        ${heroCover}
      </div>

      <div class="songHeroTitle">${escapeHtml(song.title)}</div>
      <div class="songHeroMeta">${escapeHtml(song.project || "—")} • ${escapeHtml(song.genre || "—")} • ${vCount} version${vCount===1?"":"s"}</div>

      <div class="songFeatured">
        <div class="songFeaturedTag">${escapeHtml(featuredTag)}</div>
        <div class="songFeaturedSub">${featuredSub}</div>

        <div class="songHeroActions">
          <button class="songHeroPlay" id="songBigPlay" ${(fv?.link || fv?.fileId || fv?.localAudioId) ? "" : "disabled"}>
            ▶ Play
          </button>
          <button class="songHeroQueue" id="songBigQueue" ${(fv?.link || fv?.fileId || fv?.localAudioId) ? "" : "disabled"}>
            + Queue
          </button>
          <button class="songHeroDetails" id="songDetailsBtn">
            Details
          </button>
        </div>
      </div>
    </div>

    <div class="versionsWrap">
      <div class="versionsHeader">
        <div class="versionsTitle">Versions</div>
        <button class="btn" id="addVersionJump">Add version</button>
      </div>

      <div id="versionsRows" class="versionsRows"></div>
    </div>
  `;

  $("#songHeroBack")?.addEventListener("click", () => goBack({ animate: true }));

  $("#songBigPlay")?.addEventListener("click", () => {
    if (!(fv?.link || fv?.fileId || fv?.localAudioId)) return toast("No playable audio yet 😅");
    playVersion(song.id, fv.id, { goPlayer: true });
  });

  $("#songBigQueue")?.addEventListener("click", () => {
    if (!(fv?.link || fv?.fileId || fv?.localAudioId)) return toast("No playable audio yet 😅");
    addToQueue(song.id, fv.id);
  });

  // For now, keep your existing “Details” as the old long form screen:
  // We’ll implement it as: details = version detail of the featured? or a new view later.
  // For today: send you to the existing song form by reusing your old renderSongDetail UI? (we replaced it)
  // So: we’ll open the featured version detail as “Details” as a first step.
$("#songDetailsBtn")?.addEventListener("click", () => {
  // If no versions yet, create the first one and open it
  if (!fv) {
    const first = createVersion(song, { makeBest: true });
    if (!first) return toast("Couldn’t create version 😅");
    selectedVersionId = first.id;
    render();
    return;
  }

  selectedVersionId = fv.id;
  render();
});

$("#addVersionJump")?.addEventListener("click", () => {
  // Always create a brand new version (even if versions already exist)
  const newV = createVersion(song, { makeBest: false });
  if (!newV) return toast("Couldn’t create version 😅");
  selectedVersionId = newV.id;
  render();
});

  // Render version rows
  const rowsEl = $("#versionsRows");
  const versions = (song.versions || []).slice();

  rowsEl.innerHTML = versions.length
    ? versions.map((v) => {
        const pillBest = v.isBest ? `<span class="vPill good">Best</span>` : "";
        const pillActive = v.isActive ? `<span class="vPill">Active</span>` : "";
        const pillFeatured = song.featuredVersionId === v.id ? `<span class="vPill warn">Featured</span>` : "";

        const sub = `${escapeHtml(v.createdAt || "")}${v.notes ? ` • ${escapeHtml(v.notes)}` : ""}`;

        return `
          <div class="vRow" data-vrow="${v.id}">
            <div class="vThumb">${coverSvg(song)}<div class="vDur">—:—</div></div>

            <div class="vMain">
              <div class="vTop">
                <div class="vTitle">${escapeHtml(v.label || "Version")}</div>
                <div class="vPills">${pillFeatured}${pillBest}${pillActive}</div>
              </div>
              <div class="vSub">${sub}</div>
            </div>

            <button class="vMore" data-vmore="${v.id}" aria-label="Version menu">⋯</button>
          </div>
        `;
      }).join("")
    : `<div class="small" style="padding:12px 2px">No versions yet. Add one from Details.</div>`;

  rowsEl.querySelectorAll("[data-vrow]").forEach((row) => {
    row.addEventListener("click", () => {
      selectedVersionId = row.getAttribute("data-vrow");
      render();
    });
  });

  rowsEl.querySelectorAll("[data-vmore]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const vid = btn.getAttribute("data-vmore");
      openVersionMenu(song.id, vid);
    });
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

  const isFeatured = song.featuredVersionId === v.id;
  const hasPlayable = !!(v.link || v.fileId);

  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between; align-items:center">
        <h2>${escapeHtml(song.title)}</h2>
        <button class="ghost" id="backToSong">Back</button>
      </div>
      <div class="small">${escapeHtml(song.project || "—")} • ${escapeHtml(song.genre || "—")}</div>

      <div class="hr"></div>

      <div class="row" style="gap:10px; align-items:center; flex-wrap:wrap">
        <div class="badge ${isFeatured ? "warn" : ""}">${isFeatured ? "⭐ Featured" : "Featured —"}</div>
        <div class="badge ${v.isBest ? "good" : ""}">${v.isBest ? "⭐ Best" : "Best —"}</div>
        <div class="badge ${v.isActive ? "good" : ""}">${v.isActive ? "🎧 Active" : "Active —"}</div>
      </div>

      <div class="hr"></div>

      <div class="label">Label</div>
      <input id="vLabel" type="text" value="${escapeHtml(v.label || "")}" />

      <div class="label" style="margin-top:10px">Notes</div>
      <input id="vNotesEdit" type="text" value="${escapeHtml(v.notes || "")}" />

      <div class="label" style="margin-top:10px">Link (URL)</div>
      <input id="vLink" type="text" value="${escapeHtml(v.link || "")}" placeholder="Paste direct audio URL" />

      <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap">
        <button class="btn" id="importAudioBtn">Import audio (Files) 📁</button>
        <button class="btn" id="clearLocalBtn" ${v.fileId ? "" : "disabled"}>Remove local file</button>
      </div>

      ${v.fileId ? `
        <div class="small" style="margin-top:8px">
          Local: <b>${escapeHtml(v.fileName || "audio file")}</b>
          ${v.fileSize ? ` • ${(v.fileSize/1024/1024).toFixed(1)} MB` : ""}
        </div>
      ` : `<div class="small" style="margin-top:8px">No local file attached.</div>`}

      <div class="row" style="margin-top:12px; gap:10px; flex-wrap:wrap">
        <button class="btn primary" id="saveVersion">Save</button>
        <button class="btn" id="playThis" ${hasPlayable ? "" : "disabled"}>Play</button>
        <button class="btn" id="queueThis" ${hasPlayable ? "" : "disabled"}>Queue</button>
      </div>

      <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap">
        <button class="btn" id="setFeaturedBtn">Set Featured ⭐</button>
        <button class="btn" id="toggleActiveBtn">${v.isActive ? "Active ✅ (toggle)" : "Set Active 🎧"}</button>
        <button class="btn" id="setBestBtn">${v.isBest ? "Best ✅" : "Set Best ⭐"}</button>
        <button class="btn" id="openLinkBtn" ${v.link ? "" : "disabled"}>Open link</button>
        <button class="btn" id="deleteVersionBtn">Delete</button>
      </div>
    </div>
  `;

  // Back
  $("#backToSong")?.addEventListener("click", () => goBack({ animate: true }));

  // Save
  $("#saveVersion")?.addEventListener("click", () => {
    v.label = ($("#vLabel")?.value || "").trim();
    v.notes = ($("#vNotesEdit")?.value || "").trim();
    v.link = ($("#vLink")?.value || "").trim();

    song.updatedAt = nowStamp();
    saveState();
    toast("Saved ✅");
    renderVersionDetail(songId, versionId);
  });
}

  // Import audio (local file)
  $("#importAudioBtn")?.addEventListener("click", async () => {
    try {
      const file = await pickAudioFile();
      if (!file) return;

      const fileId = uid();
      await audioPut({
        id: fileId,
        name: file.name || "audio",
        type: file.type || "audio/*",
        size: file.size || 0,
        blob: file,
        createdAt: nowStamp(),
      });

      v.fileId = fileId;
      v.fileName = file.name || "audio";
      v.fileType = file.type || "audio/*";
      v.fileSize = file.size || 0;

      song.updatedAt = nowStamp();
      saveState();
      toast("Imported ✅");
      renderVersionDetail(songId, versionId);
    } catch (err) {
      console.error(err);
      toast("Import failed 😅");
    }
  });

  // Remove local file
  $("#clearLocalBtn")?.addEventListener("click", async () => {
    if (!v.fileId) return;
    if (!confirm("Remove local audio from this device?")) return;
    try { await audioDelete(v.fileId); } catch {}

    v.fileId = null;
    v.fileName = "";
    v.fileType = "";
    v.fileSize = 0;

    song.updatedAt = nowStamp();
    saveState();
    toast("Removed 🧼");
    renderVersionDetail(songId, versionId);
  });

  // Play / Queue
  $("#playThis")?.addEventListener("click", () => playVersion(songId, versionId, { goPlayer: true }));
  $("#queueThis")?.addEventListener("click", () => addToQueue(songId, versionId));

  // Featured / Active / Best
  $("#setFeaturedBtn")?.addEventListener("click", () => {
    setFeatured(songId, versionId);
    renderVersionDetail(songId, versionId);
  });

  $("#toggleActiveBtn")?.addEventListener("click", () => {
    v.isActive = !v.isActive;
    song.updatedAt = nowStamp();
    saveState();
    toast("Active updated 🎧");
    renderVersionDetail(songId, versionId);
  });

  $("#setBestBtn")?.addEventListener("click", () => {
    song.versions.forEach(x => x.isBest = (x.id === versionId));
    song.updatedAt = nowStamp();
    saveState();
    toast("Best updated ⭐");
    renderVersionDetail(songId, versionId);
  });

  // Open link
  $("#openLinkBtn")?.addEventListener("click", () => {
    if (v.link) window.open(v.link, "_blank");
  });

  // Delete
  $("#deleteVersionBtn")?.addEventListener("click", () => {
    if (!confirm("Delete this version?")) return;

    song.versions = (song.versions || []).filter(x => x.id !== versionId);

    if (song.featuredVersionId === versionId) song.featuredVersionId = null;
    if (song.versions.length && !song.versions.some(x => x.isBest)) song.versions[0].isBest = true;

    song.updatedAt = nowStamp();
    saveState();
    toast("Deleted 🗑️");

    selectedVersionId = null;
    renderSongDetail(songId);
  });

// ---------------------
// Player
// ---------------------
function renderPlayer() {
  setHeader("Player");

  const now = state.player?.nowPlaying;
  const queue = state.player?.queue || [];

  const nowSong = now ? getSong(now.songId) : null;
  const nowV = nowSong ? getVersion(nowSong, now.versionId) : null;

  view.innerHTML = `
    <div class="card">
      <h2>Now playing</h2>
      ${
        nowSong && nowV && (nowV.link || nowV.fileId || nowV.localAudioId)
          ? `
            <div class="small"><b>${escapeHtml(nowSong.title)}</b> • ${escapeHtml(nowV.label || "Version")}</div>

            <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap">
              <button class="btn" id="playerToggle">Play/Pause</button>
              <button class="btn" id="nextFromQueue" ${queue.length ? "" : "disabled"}>Next ▶</button>
              <button class="btn" id="clearQueue">Clear queue</button>
            </div>

            <div class="row" style="margin-top:10px; gap:10px; align-items:center">
              <span class="small" id="playerTime">0:00</span>
              <input id="playerScrub" type="range" min="0" max="1000" value="0" style="flex:1" />
              <span class="small" id="playerDur">0:00</span>
            </div>
          `
          : `<div class="small">Nothing playing yet. Play a version from a song.</div>`
      }
    </div>

    <div class="card">
      <h2>Queue</h2>
      ...
    </div>
  `;

$("#playerToggle")?.addEventListener("click", async () => {
  if (!globalAudio) return;
  if (globalAudio.paused) await playNowPlaying({ autoplay: true });
  else globalAudio.pause();
});

function fmtTime(sec){
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec/60);
  const s = String(sec%60).padStart(2,"0");
  return `${m}:${s}`;
}

function syncPlayerScrub(){
  const t = $("#playerTime");
  const d = $("#playerDur");
  const r = $("#playerScrub");
  if (!t || !d || !r || !globalAudio) return;

  t.textContent = fmtTime(globalAudio.currentTime);
  d.textContent = fmtTime(globalAudio.duration);

  if (Number.isFinite(globalAudio.duration) && globalAudio.duration > 0) {
    r.value = String(Math.floor((globalAudio.currentTime / globalAudio.duration) * 1000));
  }
}

globalAudio?.addEventListener("timeupdate", syncPlayerScrub);
globalAudio?.addEventListener("loadedmetadata", syncPlayerScrub);
globalAudio?.addEventListener("play", syncPlayerScrub);
globalAudio?.addEventListener("pause", syncPlayerScrub);

$("#playerScrub")?.addEventListener("input", (e) => {
  if (!globalAudio) return;
  const val = Number(e.target.value || 0) / 1000;
  if (Number.isFinite(globalAudio.duration) && globalAudio.duration > 0) {
    globalAudio.currentTime = val * globalAudio.duration;
  }
});
  
  $("#openNowSong")?.addEventListener("click", () => {
    if (!nowSong) return;
    currentTab = "songs";
    selectedSongId = nowSong.id;
    selectedVersionId = null;
    setHeader("Song");
    syncTabs();
    render();
  });

  $("#nextFromQueue")?.addEventListener("click", () => {
    if (!queue.length) return;
    const next = queue.shift();
    state.player.nowPlaying = next;
    saveState();
    renderPlayer();
  });

  $("#clearQueue")?.addEventListener("click", () => {
    state.player.queue = [];
    saveState();
    toast("Queue cleared 🧼");
    renderPlayer();
  });

  view.querySelectorAll("[data-qplay]").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-qplay"));
      const item = queue[idx];
      if (!item) return;
      state.player.nowPlaying = item;
      // remove it from queue when you play it
      state.player.queue = queue.filter((_, i) => i !== idx);
      saveState();
      renderPlayer();
    });
  });

  view.querySelectorAll("[data-qrm]").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-qrm"));
      state.player.queue = queue.filter((_, i) => i !== idx);
      saveState();
      toast("Removed");
      renderPlayer();
    });
  });
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

      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "textarea" || tag === "input" || tag === "select") return;

      const y = e.touches?.[0]?.clientY ?? 0;
      const dy = y - startY;

      // ✅ Allow small finger wiggles so taps still register
      if (Math.abs(dy) < 10) return;

      const atTop = container.scrollTop <= 0;
      const atBottom =
        Math.ceil(container.scrollTop + container.clientHeight) >= container.scrollHeight;

      if ((atTop && dy > 0) || (atBottom && dy < 0)) e.preventDefault();
    },
    { passive: false }
  );
}

// ---------------------
// Boot (wait for splash)
// ---------------------
window.addEventListener("DOMContentLoaded", async () => {
  await runSplashSequence();

  setHeader("RiffBank");
  syncTabs();
  render();
  preventRubberBandScroll(view);
  syncMiniPlayerUI();
});

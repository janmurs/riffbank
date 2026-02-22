// RiffBank v1.2 (Local-only PWA)
// - Song creation + editing
// - Upload Helper (suggested filename + Drive path)
// - Version history + Best flag
// - Best-only Player (plays links)
// - Dashboard + Settings
// - Export / Import

import { $ } from "./ui/dom.js";
import { runSplashSequence } from "./splash/splash.js";

const LS_KEY = "riffbank_v1";
const HAS_SAVED_STATE = !!localStorage.getItem(LS_KEY); // used to detect first-run seeding

// Dev toggle: skip splash animation
const DISABLE_SPLASH = true;

let splashAlreadyRan = false;

// ---------------------
// Player view state
// ---------------------
let playerFilter = "all"; // all | fav
let playerSort = "recent"; // recent | title
let playerQueue = []; // array of { songId, versionId }
let sheetState = null; // { songId, versionId }
let lastTabBeforeFullPlayer = null;
let fullPlayerOpen = false;

// NEW: fullscreen player UI state (single source of truth)
let isFullPlayerOpen = false;

function setFullPlayerOpen(on) {
  isFullPlayerOpen = !!on;

  // One CSS toggle so fullscreen can take the whole space
  document.body.classList.toggle("fullplayer-open", isFullPlayerOpen);

  // Hard guarantee: never show both at once
  if (miniPlayerEl) {
    miniPlayerEl.classList.toggle("hidden", isFullPlayerOpen);
    miniPlayerEl.classList.toggle("visible", !isFullPlayerOpen);
    miniPlayerEl.setAttribute("aria-hidden", isFullPlayerOpen ? "true" : "false");
  }

  // Also remove the extra bottom padding that reserves space for mini player
  if (isFullPlayerOpen) {
    document.body.classList.remove("hasMiniPlayer");
  }
}

const view = $("#view");
if (!view) {
  console.error("RiffBank: #view not found. Check index.html structure.");
} else {
  // ✅ Ensure CSS that targets `.view` applies to `#view`
  view.classList.add("view");
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
  el.style.display = "none";         // hidden by default
  el.style.background = "transparent"; // your CSS handles background vibes
  document.body.appendChild(el);
  return el;
}

function openNowPlaying() {
  if (fullPlayerOpen) return;

  lastTabBeforeFullPlayer = getActiveTab(); // 👈 remember where we were
  fullPlayerOpen = true;

  document.body.classList.add("fullplayer-open");

  const overlay = ensureNowPlayingOverlay();
  overlay.style.display = "block";
  overlay.innerHTML = renderNowPlayingHTML(); // 👈 you’ll add this next

  wireNowPlayingEvents(overlay); // 👈 hook buttons
}

function closeNowPlaying() {
  if (!fullPlayerOpen) return;

  fullPlayerOpen = false;
  document.body.classList.remove("fullplayer-open");

  const overlay = document.getElementById("nowPlayingOverlay");
  if (overlay) {
    overlay.style.display = "none";
    overlay.innerHTML = "";
  }

  // ✅ DO NOT navigate anywhere.
  // ✅ Optional: just re-highlight the tab we were on (purely cosmetic)
  if (lastTabBeforeFullPlayer) setActiveTab(lastTabBeforeFullPlayer);
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
const miniArtEl    = document.getElementById("miniArt");
const miniToggleEl = document.getElementById("miniToggle");
const miniNextEl   = document.getElementById("miniNext");
const miniPrevEl   = document.getElementById("miniPrev");
const miniScrubEl  = document.getElementById("miniScrub");
const miniTitleEl  = document.getElementById("miniTitle");
const miniSubEl    = document.getElementById("miniSub");

function isPlayable(v){
  return !!(v?.link || v?.fileId || v?.localAudioId);
}

async function syncMiniPlayerUI() {
    // ✅ If fullscreen Now Playing is open, mini player must never appear
  if (document.body.classList.contains("fullplayer-open")) {
    miniPlayerEl.classList.add("hidden");
    miniPlayerEl.classList.remove("visible");
    miniPlayerEl.setAttribute("aria-hidden", "true");
    document.body.classList.remove("hasMiniPlayer");
    return;
  }

  if (!miniPlayerEl) return;

// Guard: older builds may not define isNowPlayingFullscreen
if (typeof isNowPlayingFullscreen !== "undefined" && isNowPlayingFullscreen) {
  miniPlayerEl.classList.add("hidden");
  miniPlayerEl.classList.remove("visible");
  miniPlayerEl.setAttribute("aria-hidden", "true");
  document.body.classList.remove("hasMiniPlayer");
  return;
}

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
  requestAnimationFrame(() => miniPlayerEl.classList.add("visible"));

  // album art
  if (miniArtEl) {
    // Use your existing neon cover generator (lite for speed)
    miniArtEl.innerHTML = coverSvg(song, { lite: true });
  }

// title / subtitle (set first so text always shows even if art generation fails)
if (miniTitleEl) miniTitleEl.textContent = song.title || "Untitled";
if (miniSubEl) miniSubEl.textContent = v.label || "";

// album art
if (miniArtEl) {
  try {
    miniArtEl.innerHTML = coverSvg(song, { lite: true });
  } catch (e) {
    console.warn("mini coverSvg failed:", e);
    miniArtEl.innerHTML = "";
  }
}

  // play/pause icon
  if (miniToggleEl) miniToggleEl.textContent = globalAudio?.paused ? "▶" : "⏸";

  // keep scrub in sync
  syncMiniScrub();
}

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
            // Player playlist flags
      if (typeof v.playerYes !== "boolean") v.playerYes = false;
      if (typeof v.favorite !== "boolean") v.favorite = false;
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
    const fileUrl = normalizeFileUrl(v?.file || v?.url || v?.path || "");
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
    index = await fetchJson("./library/index.json");
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
    for (const vv of (s.versions || [])) {
      const v = ensureVersionFlags(vv);
      if (v.playerYes) {
        items.push({
          songId: s.id,
          versionId: v.id,
          songName: s.title || "Untitled",
          artistName: s.artist || "You",
          coverUrl: pickCoverUrl(s, v),
          favorite: !!v.favorite,
          updatedAt: v.updatedAt || v.stamp || "",
          label: versionLabel(v)
        });
      }
    }
  }

  // filter
  let out = items;
  if (playerFilter === "fav") out = out.filter(x => x.favorite);

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
      const reg = await navigator.serviceWorker.register("/sw.js");

      // If a new SW activates, reload once so we’re on the newest cached assets
      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloaded) return;
        reloaded = true;
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

      // 🔥 Force-check on every load (beats the “24-hour SW update check” behavior)
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
  settings: "Settings",
};

let currentTab = "home";
let selectedSongId = null;
let songsView = "list";
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
    if (targetTab === "player") {
      playerScreen = "list";
    }
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

miniPlayerEl?.addEventListener("click", (e) => {
  // If user tapped a control button or scrubber, do NOT open fullscreen player
  const isControl = e.target.closest("#miniPrev, #miniToggle, #miniNext, #miniScrub");
  if (isControl) return;

  // If nothing is playing, do nothing (or fallback to Player list)
  if (!state.player?.nowPlaying) return;

  // Open full-screen Now Playing
  currentTab = "player";
  playerScreen = "now";

  setFullPlayerOpen(true); // ✅ hide mini instantly before render

  drawerView = null;
  overlayView = null;
  selectedSongId = null;
  selectedVersionId = null;

  setHeader("Now Playing");
  syncTabs();
  render();
});

miniScrubEl?.addEventListener("pointerdown", (e) => e.stopPropagation());
miniScrubEl?.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

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

    // ✅ Enforce fullscreen player state every render (no overlap, no reserved padding)
  setFullPlayerOpen(currentTab === "player" && playerScreen === "now");

  document.body.classList.toggle(
    "isHome",
    currentTab === "home" && !drawerView && !overlayView && !selectedSongId && !selectedVersionId
  );

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
  if (currentTab === "player") {
  if (playerScreen === "now") return renderNowPlaying();
    return renderPlayer();
  }
  if (currentTab === "settings") return renderSettings();
}

window.addEventListener("DOMContentLoaded", async () => {
  if (!DISABLE_SPLASH) {
  await runSplashSequence();
} else {
  const splash = document.getElementById("splash");
  if (splash) splash.remove();
}

  // Seed default library on first run (or if user wiped data)
  const seeded = await seedDefaultLibraryIfNeeded({ force: false });
  if (seeded) toast("Seeded library 🎧");

  setHeader("RiffBank");
  syncTabs();
  render();

  preventRubberBandScroll(view);
  syncMiniPlayerUI();
});

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

// --- Cover caching + iOS "lite" mode ---
const coverCache = new Map();

function isIOSDevice(){
  // iPadOS can report as MacIntel with touch points
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function coverSvg(song, { lite = false } = {}) {
  const forceLite = lite || isIOSDevice();
  const key = `${song.id}|${song.title}|${song.project}|${song.genre}|${forceLite ? "lite" : "full"}`;

  if (coverCache.has(key)) return coverCache.get(key);

  const seed = hashStr(`${song.id}|${song.title}|${song.project}|${song.genre}`);
  const r = makeRng(seed);

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
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${c1}" stop-opacity=".95"/>
        <stop offset=".55" stop-color="${c2}" stop-opacity=".85"/>
        <stop offset="1" stop-color="${c3}" stop-opacity=".9"/>
      </linearGradient>
      <radialGradient id="vig" cx="50%" cy="45%" r="70%">
        <stop offset="55%" stop-color="rgba(0,0,0,0)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,.28)"/>
      </radialGradient>
    </defs>

    <rect width="120" height="120" fill="url(#g)"/>
    ${b.map(x => `<circle cx="${x.x}" cy="${x.y}" r="${x.rad}" fill="${x.col}" opacity=".22"/>`).join("")}

    <path d="M ${sx1} ${sy1} C ${sx1+35} ${sy1-30}, ${sx2-35} ${sy2+30}, ${sx2} ${sy2}"
      stroke="rgba(255,255,255,.55)" stroke-width="5" stroke-linecap="round" opacity=".18"/>

    <rect width="120" height="120" fill="url(#vig)"/>
  </svg>` : `
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

      <radialGradient id="vig" cx="50%" cy="45%" r="70%">
        <stop offset="55%" stop-color="rgba(0,0,0,0)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,.35)"/>
      </radialGradient>
    </defs>

    <rect width="120" height="120" fill="url(#g)"/>

    <g filter="url(#blur)" opacity=".9">
      ${b.map(x => `<circle cx="${x.x}" cy="${x.y}" r="${x.rad}" fill="${x.col}" opacity=".55"/>`).join("")}
    </g>

    <path d="M ${sx1} ${sy1} C ${sx1+35} ${sy1-30}, ${sx2-35} ${sy2+30}, ${sx2} ${sy2}"
      stroke="rgba(255,255,255,.65)" stroke-width="6" stroke-linecap="round" opacity=".22" filter="url(#glow)"/>

    <rect width="120" height="120" fill="url(#vig)"/>
    <rect width="120" height="120" filter="url(#grain)" opacity=".55"/>
  </svg>`;

  coverCache.set(key, svg);
  return svg;
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
                ${coverSvg(s, { lite: true })}
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
  const rowCover  = coverSvg(song, { lite: true }); // always lite for version rows

  const featuredTag = fv?.isBest ? "⭐ Best" : fv?.isActive ? "🎧 Active" : "Featured";
  const featuredSub = fv
    ? `${escapeHtml(fv.label || "Version")} ${fv.notes ? `• ${escapeHtml(fv.notes)}` : ""}`
    : "No versions yet — add one below";

view.innerHTML = `
  <div class="albumHero">
    <button class="songHeroBack" id="songHeroBack" aria-label="Back">←</button>

    <div class="albumBg" aria-hidden="true">
      ${heroCover}
    </div>

    <div class="albumTop">
      <div class="albumArt" aria-hidden="true">
        ${heroCover}
      </div>

      <div class="albumText">
        <div class="albumTitle">${escapeHtml(song.title)}</div>
        <div class="albumMeta">
          ${escapeHtml(song.project || "—")} • ${escapeHtml(song.genre || "—")} •
          ${vCount} version${vCount===1?"":"s"}
        </div>
      </div>
    </div>

    <div class="albumActions">
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
            <div class="vThumb">${rowCover}<div class="vDur">—:—</div></div>

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
  const hasPlayable = !!(v.link || v.fileId || v.localAudioId);

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
        <button class="btn" id="clearLocalBtn" ${(v.fileId || v.localAudioId) ? "" : "disabled"}>Remove local file</button>
      </div>

      ${(v.fileId || v.localAudioId) ? `
        <div class="small" style="margin-top:8px">
          Local: <b>${escapeHtml(v.fileName || v.originalFileName || "audio file")}</b>
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
    v.link  = ($("#vLink")?.value || "").trim();

    song.updatedAt = nowStamp();
    saveState();
    toast("Saved ✅");
    renderVersionDetail(songId, versionId);
  });

  // Import audio (local file)
  $("#importAudioBtn")?.addEventListener("click", async () => {
    try {
      const file = await pickAudioFile();
      if (!file) return;

      const id = uid();

      // store into IndexedDB (your audioPut)
      await audioPut({
        id,
        name: file.name || "audio",
        type: file.type || "audio/*",
        size: file.size || 0,
        blob: file,
        createdAt: nowStamp(),
      });

      // use fileId path for this screen
      v.fileId = id;
      v.fileName = file.name || "audio";
      v.fileType = file.type || "audio/*";
      v.fileSize = file.size || 0;

      // clear old localAudioId if you want (optional)
      // v.localAudioId = null;

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
}

// ---------------------
// Player
// ---------------------
function renderPlayer() {
  setHeader("Player");

  // Build playlist rows (one row per version where playerYes === true)
  const items = playerItems(state); // uses playerFilter/playerSort globals

  const now = state.player?.nowPlaying || null;

  function isNowPlayingRow(songId, versionId) {
    return !!(now && now.songId === songId && now.versionId === versionId);
  }

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

  // Header + chips + list
  view.innerHTML = `
    <div class="playerHeader">
      <div class="playerTitleRow">
        <div>
          <div class="small">Playlist</div>
          <h2 class="playerTitle">Liked Versions</h2>
          <div class="playerCount">${items.length} version${items.length === 1 ? "" : "s"}</div>
        </div>

        <div class="playerActions">
          <button class="playerShuffleBtn" id="playerShuffle" aria-label="Shuffle">⤮</button>
          <button class="playerPlayBtn" id="playerPlayAll" aria-label="Play">▶</button>
        </div>
      </div>
    </div>

    <div class="chipsRow" aria-label="Player filters">
      <button class="chip ${playerFilter === "all" ? "active" : ""}" data-pf="all">All</button>
      <button class="chip ${playerFilter === "fav" ? "active" : ""}" data-pf="fav">Favorites</button>

      <span style="width:10px; flex:0 0 auto;"></span>

      <button class="chip ${playerSort === "recent" ? "active" : ""}" data-ps="recent">Recent</button>
      <button class="chip ${playerSort === "title" ? "active" : ""}" data-ps="title">Title</button>
    </div>

    <div class="playerList">
      ${
        items.length
          ? items.map((it) => {
              const s = getSong(it.songId);
              const v = s ? getVersion(s, it.versionId) : null;

              // Fallback if missing
              const title = it.songName || s?.title || "Untitled";
              const meta = it.label || v?.label || "Version";
              const fav = !!it.favorite;

              const cover = s ? coverSvg(s, { lite: true }) : "";

              return `
                <div class="playerRow ${isNowPlayingRow(it.songId, it.versionId) ? "playing" : ""}"
                     data-pr-song="${it.songId}"
                     data-pr-ver="${it.versionId}">
                  <div class="playerCover" aria-hidden="true">${cover}</div>

                  <div class="playerMain">
                    <div class="playerName">${escapeHtml(title)}</div>
                    <div class="playerMeta">
                      <span>${escapeHtml(meta)}</span>
                      ${fav ? `<span class="playerBadge fav">♥</span>` : ``}
                      ${
                        isNowPlayingRow(it.songId, it.versionId)
                          ? `<span class="playerBadge">Now</span>`
                          : ``
                      }
                    </div>
                  </div>

                  <button class="playerMore" data-pr-more="1" aria-label="More">⋯</button>
                </div>
              `;
            }).join("")
          : `<div class="emptyState">No playlist versions yet. Mark a version as “Player ✅” to add it here.</div>`
      }
    </div>

    <div class="card" style="margin-top:12px">
      <div class="row" style="justify-content:space-between; align-items:center">
        <h2 style="margin:0">Queue</h2>
        <button class="ghost" id="clearQueueMini">Clear</button>
      </div>
      <div class="small" style="margin-top:6px">${(state.player?.queue || []).length} item(s)</div>
    </div>
  `;

  // Filter chips
  view.querySelectorAll("[data-pf]").forEach(btn => {
    btn.addEventListener("click", () => {
      playerFilter = btn.getAttribute("data-pf") || "all";
      renderPlayer();
    });
  });
  view.querySelectorAll("[data-ps]").forEach(btn => {
    btn.addEventListener("click", () => {
      playerSort = btn.getAttribute("data-ps") || "recent";
      renderPlayer();
    });
  });

  // Play all (in current filter/sort order)
  $("#playerPlayAll")?.addEventListener("click", async () => {
    if (!items.length) return toast("Playlist empty 😅");

    // Set queue to remaining items after the first
    state.player.nowPlaying = { songId: items[0].songId, versionId: items[0].versionId };
    state.player.queue = items.slice(1).map(x => ({ songId: x.songId, versionId: x.versionId }));
    saveState();

    await playNowPlaying({ autoplay: true });
    toast("Playing ▶️");
    renderPlayer();
  });

  // Shuffle
  $("#playerShuffle")?.addEventListener("click", async () => {
    if (!items.length) return toast("Playlist empty 😅");
    const shuffled = shuffleArray(items);

    state.player.nowPlaying = { songId: shuffled[0].songId, versionId: shuffled[0].versionId };
    state.player.queue = shuffled.slice(1).map(x => ({ songId: x.songId, versionId: x.versionId }));
    saveState();

    await playNowPlaying({ autoplay: true });
    toast("Shuffled ▶️");
    renderPlayer();
  });

  // Row interactions
  view.querySelectorAll(".playerRow").forEach(row => {
    row.addEventListener("click", async (e) => {
      const isMore = e.target.closest(".playerMore");
      const songId = row.getAttribute("data-pr-song");
      const versionId = row.getAttribute("data-pr-ver");
      if (!songId || !versionId) return;

      const item = items.find(x => x.songId === songId && x.versionId === versionId);
      if (!item) return;

      if (isMore) {
        e.stopPropagation();
        openPlayerActionSheet(item);
        return;
      }

      // Tap row = play immediately (Spotify-ish)
      state.player.nowPlaying = { songId, versionId };
      saveState();
      await playNowPlaying({ autoplay: true });
      toast("Playing ▶️");
      renderPlayer();
    });
  });

  // Queue clear
  $("#clearQueueMini")?.addEventListener("click", () => {
    state.player.queue = [];
    saveState();
    toast("Queue cleared 🧼");
    renderPlayer();
  });
}

function renderNowPlaying() {
  const now = state.player?.nowPlaying;
  if (!now) {
    playerScreen = "list";
    return renderPlayer();
  }

  const song = getSong(now.songId);
  const v = song ? getVersion(song, now.versionId) : null;
  if (!song || !v) {
    playerScreen = "list";
    return renderPlayer();
  }

  setHeader("Now Playing");

  setFullPlayerOpen(true);

  const title = song.title || "Untitled";
  const subtitle = v.label || "Version";
  const art = coverSvg(song); // full-quality cover is fine here

  view.innerHTML = `
    <div class="npWrap">
      <button class="npBack" id="npBackBtn">←</button>

      <div class="npArt" aria-hidden="true">${art}</div>

      <div class="npText">
        <div class="npTitle">${escapeHtml(title)}</div>
        <div class="npSub">${escapeHtml(subtitle)}</div>
      </div>

      <input id="npScrub" class="npScrub" type="range" min="0" max="1000" value="0" aria-label="Progress" />

      <div class="npControls" role="group" aria-label="Playback controls">
        <button class="npBtn" id="npPrev">⏮</button>
        <button class="npBtn npPlay" id="npToggle">${globalAudio?.paused ? "▶" : "⏸"}</button>
        <button class="npBtn" id="npNext">⏭</button>
      </div>

      <div class="npActions">
        <button class="btn" id="npGoSong">Go to Song</button>
        <button class="btn" id="npGoList">Playlist</button>
      </div>
    </div>
  `;

  const npScrub = $("#npScrub");

  function syncNowScrub() {
    if (!npScrub || !globalAudio) return;
    if (Number.isFinite(globalAudio.duration) && globalAudio.duration > 0) {
      npScrub.value = String(Math.floor((globalAudio.currentTime / globalAudio.duration) * 1000));
    } else {
      npScrub.value = "0";
    }
    $("#npToggle").textContent = globalAudio?.paused ? "▶" : "⏸";
  }

  // Initial sync + live sync
  syncNowScrub();
  globalAudio?.addEventListener("timeupdate", syncNowScrub);
  globalAudio?.addEventListener("loadedmetadata", syncNowScrub);
  globalAudio?.addEventListener("play", syncNowScrub);
  globalAudio?.addEventListener("pause", syncNowScrub);

  // Clean up listeners when we navigate away (simple pattern)
  // (Because you're not using a framework, we remove them on next render)
  const cleanup = () => {
    globalAudio?.removeEventListener("timeupdate", syncNowScrub);
    globalAudio?.removeEventListener("loadedmetadata", syncNowScrub);
    globalAudio?.removeEventListener("play", syncNowScrub);
    globalAudio?.removeEventListener("pause", syncNowScrub);
  };

  // Back = go to playlist list (or whatever you prefer)
  $("#npBackBtn")?.addEventListener("click", () => {
    cleanup();
    setFullPlayerOpen(false);
    playerScreen = "list";
    setHeader("Player");
    render();
  });

  // Scrub input
  npScrub?.addEventListener("input", (e) => {
    if (!globalAudio) return;
    const val = Number(e.target.value || 0) / 1000;
    if (Number.isFinite(globalAudio.duration) && globalAudio.duration > 0) {
      globalAudio.currentTime = val * globalAudio.duration;
    }
  });

  // Controls
  $("#npToggle")?.addEventListener("click", async () => {
    if (!globalAudio) return;
    if (globalAudio.paused) await playNowPlaying({ autoplay: true });
    else globalAudio.pause();
    syncMiniPlayerUI();
  });

  $("#npNext")?.addEventListener("click", () => {
    const q = state.player?.queue || [];
    if (!q.length) return toast("Queue empty 😅");
    state.player.nowPlaying = q.shift();
    saveState();
    playNowPlaying({ autoplay: true });
  });

  $("#npPrev")?.addEventListener("click", () => {
    if (!globalAudio) return;
    globalAudio.currentTime = 0;
  });

  // Actions
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

  $("#wipe").addEventListener("click", async () => {
    if (!confirm("Wipe all local RiffBank data on this browser?")) return;

    localStorage.removeItem(LS_KEY);
    state = loadState();
    normalizeState();

    // Re-seed the default library so Reset gives you a usable test catalog
    await seedDefaultLibraryIfNeeded({ force: true });

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

import {
  safeString, normalizeFileUrl, extFromPath, yyyymmddFromDate,
  guessNumericSuffixFromTitle, titleizeFromSlug, basenameNoExt,
  uid, nowStamp,
} from "./ui/dom.js";
import { state, setState, loadState, normalizeState, saveState } from "./state.js";

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

function resolveSeedLibraryUrl({ bandId, songSlug, verObj }) {
  const raw = safeString(verObj?.file || verObj?.url || verObj?.path || "");
  const normalized = normalizeFileUrl(raw);
  const band = safeString(bandId);
  const slug = safeString(songSlug);

  if (!band || !slug) return normalized;

  if (normalized.includes(`/library/${band}/${slug}/`)) return normalized;

  const ext =
    extFromPath(raw) ||
    extFromPath(normalized) ||
    safeString(verObj?.format).toLowerCase() ||
    "wav";

  const rawBase = String(raw || "").split("/").pop() || "";
  const normBase = String(normalized || "").split("/").pop() || "";
  const id = safeString(verObj?.id);

  const candidates = [];
  if (rawBase && rawBase.toLowerCase().startsWith(slug.toLowerCase() + "_")) candidates.push(rawBase);
  if (normBase && normBase.toLowerCase().startsWith(slug.toLowerCase() + "_")) candidates.push(normBase);

  if (id && id.toLowerCase().startsWith(slug.toLowerCase())) candidates.push(`${id}.${ext}`);

  const ds = yyyymmddFromDate(verObj?.date || verObj?.createdAt);
  if (ds) {
    const suffix = guessNumericSuffixFromTitle(verObj?.title || verObj?.name || "");
    if (suffix) candidates.push(`${slug}_${ds}_${suffix}.${ext}`);
    candidates.push(`${slug}_${ds}.${ext}`);
  }

  if (rawBase) candidates.push(rawBase);
  if (normBase) candidates.push(normBase);
  candidates.push(`${slug}.${ext}`);

  const seen = new Set();
  const filename = candidates.find((c) => {
    const key = String(c || "").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return `./library/${band}/${slug}/${filename}`;
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

export function buildSeedSong({ bandId, bandName, songObj }) {
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
    const fileUrl = resolveSeedLibraryUrl({ bandId, songSlug: songObj?.slug, verObj: v });
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

export async function seedDefaultLibraryIfNeeded({ force = false, hasSavedState = false } = {}) {
  if (!force && hasSavedState) return false;
  if (!force && Array.isArray(state?.songs) && state.songs.length) return false;

  let index;
  try {
    try {
      index = await fetchJson("/library/index.json");
    } catch {
      index = await fetchJson("./library/index.json");
    }
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

  setState(loadState());
  state.songs = seeded;
  state.quickLog = [];
  state.player = { queue: [], nowPlaying: null };
  normalizeState();
  saveState();
  return true;
}

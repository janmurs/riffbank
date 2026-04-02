import { AUDIO_DB, AUDIO_STORE } from "../constants.js";
import { nowStamp } from "../ui/dom.js";

// ── Runtime caches ──
export const audioUrlCache = new Map(); // localAudioId -> objectURL
export const coverUrlCache = new Map(); // coverPath -> blob objectURL (persists via IndexedDB)
export const cachedAudioPaths = new Set(); // audioPaths known to be cached in IndexedDB

// ── Primary IndexedDB helpers (used by putAudioBlob / getAudioBlob) ──

export function openAudioDB() {
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

export async function putAudioBlob({ id, blob, name, type, size }) {
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

export async function getAudioBlob(id) {
  const db = await openAudioDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, "readonly");
    const req = tx.objectStore(AUDIO_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// ── Cover art cache (IndexedDB) — survives app restarts ──

export async function putCoverBlob(coverPath, blob) {
  if (!coverPath || !blob) return;
  const id = `cover:${coverPath}`;
  await putAudioBlob({ id, blob, name: "cover", type: blob.type || "image/jpeg", size: blob.size });
}

export async function getCoverBlobUrl(coverPath) {
  if (!coverPath) return null;
  if (coverUrlCache.has(coverPath)) return coverUrlCache.get(coverPath);
  const rec = await getAudioBlob(`cover:${coverPath}`);
  if (rec?.blob) {
    const url = URL.createObjectURL(rec.blob);
    coverUrlCache.set(coverPath, url);
    return url;
  }
  return null;
}

// Restore cover URLs from IndexedDB for all songs (call on startup, before render)
export async function restoreCoverUrlsFromCache(songs, fetchCoverBlobFn) {
  for (const song of (songs || [])) {
    if (song.coverPath) {
      let url = await getCoverBlobUrl(song.coverPath);
      if (!url) {
        // Try fetching from Supabase storage
        const blob = await fetchCoverBlobFn(song.coverPath).catch(() => null);
        if (blob) {
          await putCoverBlob(song.coverPath, blob);
          url = URL.createObjectURL(blob);
          coverUrlCache.set(song.coverPath, url);
        }
      }
      song.coverImageUrl = url || null;
    }
    // Restore user-uploaded cover URLs
    if (song.coverSource === "user" || song.userCoverPath) {
      const localKey = `user_${song.id}_cover.jpg`;
      // Try cloud path first, then local IndexedDB key
      let userUrl = song.userCoverPath ? await getCoverBlobUrl(song.userCoverPath) : null;
      if (!userUrl) userUrl = await getCoverBlobUrl(localKey);
      if (!userUrl && song.userCoverPath) {
        // Try fetching from Supabase storage
        const blob = await fetchCoverBlobFn(song.userCoverPath).catch(() => null);
        if (blob) {
          await putCoverBlob(song.userCoverPath, blob);
          userUrl = URL.createObjectURL(blob);
          coverUrlCache.set(song.userCoverPath, userUrl);
        }
      }
      if (userUrl) {
        song.userCoverImageUrl = userUrl;
        if (song.coverSource !== "user") song.coverSource = "user";
      }
    }
  }
}

// ── Audio compression — shrink large files for cloud upload ──

const COMPRESS_THRESHOLD = 40 * 1024 * 1024; // only compress files > 40MB

export async function compressAudioForUpload(blob, globalAudioEl) {
  // Skip compression for files under 50MB (Supabase free tier limit)
  if (blob.size <= COMPRESS_THRESHOLD) return blob;

  // Skip compression while audio is playing — real-time MediaRecorder encoding
  // creates a competing AudioContext that causes playback glitches
  if (globalAudioEl && !globalAudioEl.paused) {
    console.log("[Compress] Skipping — audio is playing, avoiding playback glitches");
    return blob;
  }

  // Encode to M4A/AAC (stereo, high quality) via MediaRecorder
  // Safari/iOS: audio/mp4 (AAC), Chrome: audio/webm (Opus) — both excellent quality
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuf = await blob.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuf);

    // Render at original sample rate and channel count (preserve stereo)
    const sampleRate = audioBuffer.sampleRate;
    const channels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const offline = new OfflineAudioContext(channels, length, sampleRate);
    const source = offline.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    ctx.close();

    // Pick best available container: M4A (Safari) > WebM/Opus (Chrome)
    const mimeType = MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4"
      : MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus"
      : null;

    if (!mimeType) {
      console.warn("[Compress] No supported audio encoder, uploading original");
      return blob;
    }

    // Play the rendered buffer through MediaRecorder to encode
    const dest = new AudioContext({ sampleRate });
    const bufferSource = dest.createBufferSource();
    bufferSource.buffer = rendered;
    const destNode = dest.createMediaStreamDestination();
    bufferSource.connect(destNode);

    const recorder = new MediaRecorder(destNode.stream, {
      mimeType,
      audioBitsPerSecond: 256000, // 256kbps — high quality
    });

    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    const encodedBlob = await new Promise((resolve) => {
      recorder.onstop = () => {
        const encoded = new Blob(chunks, { type: mimeType });
        resolve(encoded);
      };
      recorder.start();
      bufferSource.start(0);
      // Stop recording after the audio duration + small buffer
      setTimeout(() => {
        recorder.stop();
        bufferSource.stop();
        dest.close();
      }, (rendered.duration * 1000) + 200);
    });

    const ext = mimeType.includes("mp4") ? "m4a" : "webm";
    console.log(`[Compress] ${(blob.size / 1e6).toFixed(1)}MB → ${(encodedBlob.size / 1e6).toFixed(1)}MB (${ext}, ${channels}ch)`);
    return encodedBlob;
  } catch (e) {
    console.warn("[Compress] Failed, uploading original:", e);
    return blob;
  }
}

// ── Secondary IndexedDB helpers (close DB after each op) ──

export function openAudioDb() {
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

export async function audioPut(fileRecord) {
  const db = await openAudioDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, "readwrite");
    tx.objectStore(AUDIO_STORE).put(fileRecord);
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function audioGet(id) {
  const db = await openAudioDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, "readonly");
    const req = tx.objectStore(AUDIO_STORE).get(id);
    req.onsuccess = () => { db.close(); resolve(req.result || null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

export async function audioDelete(id) {
  const db = await openAudioDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, "readwrite");
    tx.objectStore(AUDIO_STORE).delete(id);
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// List all blobs in IndexedDB (for recovery)
export async function audioGetAll() {
  const db = await openAudioDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, "readonly");
    const req = tx.objectStore(AUDIO_STORE).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result || []); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

import { state, saveState } from "../state.js";
import { toast } from "../ui/toast.js";
import { yieldToMain } from "../ui/dom.js";
import { audioGet, audioPut, cachedAudioPaths, compressAudioForUpload } from "./audioDB.js";
import { supabaseFetchAudioBlob, supabaseUploadAudio, supabasePushState } from "../supabase.js";

// ── Dependencies injected via initCloudSync() ──
let _globalAudio = null;
let _render = null;

export function initCloudSync({ globalAudio, render }) {
  _globalAudio = globalAudio;
  _render = render;
}

function waitForAudioIdle() {
  if (!_globalAudio || _globalAudio.paused) return Promise.resolve();
  return new Promise(resolve => {
    const onPause = () => { cleanup(); resolve(); };
    const onEnded = () => { cleanup(); resolve(); };
    const timer = setInterval(() => {
      if (_globalAudio.paused) { cleanup(); resolve(); }
    }, 2000);
    const timeout = setTimeout(() => { cleanup(); resolve(); }, 5 * 60 * 1000);
    function cleanup() {
      _globalAudio.removeEventListener("pause", onPause);
      _globalAudio.removeEventListener("ended", onEnded);
      clearInterval(timer);
      clearTimeout(timeout);
    }
    _globalAudio.addEventListener("pause", onPause, { once: true });
    _globalAudio.addEventListener("ended", onEnded, { once: true });
  });
}

// Cache all cloud-only audio blobs into IndexedDB for offline playback.
export async function cacheAllCloudAudio() {
  const cloudVersions = [];
  for (const song of (state.songs || [])) {
    for (const v of (song.versions || [])) {
      if (!v.audioPath) continue;
      if (v.fileId || v.localAudioId) continue;
      if (cachedAudioPaths.has(v.audioPath)) continue;
      try {
        const existing = await audioGet(`supa:${v.audioPath}`);
        if (existing?.blob) { cachedAudioPaths.add(v.audioPath); continue; }
      } catch {}
      cloudVersions.push({ song, v });
    }
  }

  if (!cloudVersions.length) {
    toast("All audio already cached locally");
    return;
  }

  let done = 0;
  let failed = 0;
  toast(`Caching audio: 0/${cloudVersions.length}…`);

  for (const { song, v } of cloudVersions) {
    try {
      const blob = await supabaseFetchAudioBlob(v.audioPath);
      if (blob) {
        await audioPut({
          id: `supa:${v.audioPath}`,
          blob,
          name: v.fileName || v.label || "audio",
          type: v.fileType || blob.type || "audio/*",
          size: blob.size,
        });
        cachedAudioPaths.add(v.audioPath);
        done++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
    toast(`Caching audio: ${done + failed}/${cloudVersions.length}…`);
  }

  const msg = failed
    ? `Cached ${done}/${cloudVersions.length} (${failed} failed)`
    : `All ${done} tracks cached locally`;
  toast(msg);
}

// Upload all local-only audio blobs to Supabase cloud storage.
export async function backupAllAudioToCloud() {
  const toUpload = [];
  for (const song of (state.songs || [])) {
    for (const v of (song.versions || [])) {
      if (v.audioPath) continue;
      if (!v.fileId && !v.localAudioId) continue;
      toUpload.push({ song, v });
    }
  }

  if (!toUpload.length) {
    toast("All audio is already backed up to the cloud");
    return { uploaded: 0, failed: 0 };
  }

  let uploaded = 0, failed = 0;
  toast(`Backing up audio: 0/${toUpload.length}…`);

  for (const { song, v } of toUpload) {
    let blob = null;
    const tryIds = [v.fileId, v.localAudioId].filter(Boolean);
    for (const id of tryIds) {
      try {
        const rec = await audioGet(id);
        if (rec?.blob) { blob = rec.blob; break; }
      } catch {}
    }

    if (!blob) { failed++; continue; }

    try {
      if (_globalAudio && !_globalAudio.paused) await waitForAudioIdle();
      await yieldToMain();
      const compressed = await compressAudioForUpload(blob, _globalAudio);
      await yieldToMain();
      if (_globalAudio && !_globalAudio.paused) await waitForAudioIdle();
      const fileName = v.fileName || v.label || "audio";
      const result = await supabaseUploadAudio({
        blob: new File([compressed], fileName, { type: compressed.type || v.fileType || "audio/*" }),
        songId: song.id,
        versionId: v.id,
        fileName,
      });
      await yieldToMain();
      if (result.success) {
        v.audioPath = result.audioPath;
        uploaded++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
    toast(`Backing up audio: ${uploaded + failed}/${toUpload.length}…`);
  }

  if (uploaded) {
    saveState();
    await supabasePushState(state).catch(console.warn);
    if (_render) _render();
  }

  const msg = failed
    ? `Backed up ${uploaded}/${toUpload.length} (${failed} failed)`
    : `All ${uploaded} tracks backed up to cloud`;
  toast(msg);
  return { uploaded, failed };
}

// Auto-sweep: upload any local-only audio to Supabase cloud storage.
// Runs silently in the background on startup.
export async function ensureAllAudioInCloud() {
  const toUpload = [];
  for (const song of (state.songs || [])) {
    for (const v of (song.versions || [])) {
      if (v.audioPath) continue;
      if (!v.fileId && !v.localAudioId) continue;
      toUpload.push({ song, v });
    }
  }
  if (!toUpload.length) return;

  console.log(`[AutoSync] ${toUpload.length} version(s) missing cloud audio — uploading`);
  let uploaded = 0, failed = 0;

  for (const { song, v } of toUpload) {
    if (_globalAudio && !_globalAudio.paused) await waitForAudioIdle();
    await yieldToMain();

    let blob = null;
    for (const id of [v.fileId, v.localAudioId].filter(Boolean)) {
      try { const rec = await audioGet(id); if (rec?.blob) { blob = rec.blob; break; } } catch {}
    }
    if (!blob) { failed++; continue; }

    try {
      const compressed = await compressAudioForUpload(blob, _globalAudio);
      await yieldToMain();
      if (_globalAudio && !_globalAudio.paused) await waitForAudioIdle();
      const fileName = v.fileName || v.label || "audio";
      const result = await supabaseUploadAudio({
        blob: new File([compressed], fileName, { type: compressed.type || v.fileType || "audio/*" }),
        songId: song.id,
        versionId: v.id,
        fileName,
      });
      if (result.success) {
        v.audioPath = result.audioPath;
        uploaded++;
      } else {
        console.warn(`[AutoSync] Upload failed for "${song.title}":`, result.error);
        failed++;
      }
    } catch (e) {
      console.warn(`[AutoSync] Upload error for "${song.title}":`, e);
      failed++;
    }
    await yieldToMain();
  }

  if (uploaded) {
    saveState();
    await supabasePushState(state).catch(console.warn);
    console.log(`[AutoSync] Uploaded ${uploaded} track(s) to cloud`);
  }
  if (failed) {
    toast(`${failed} track${failed > 1 ? "s" : ""} failed to sync to cloud`);
  }
}

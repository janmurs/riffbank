import { state, normalizeState, saveState } from "./state.js";
import { toast } from "./ui/toast.js";
import { coverCache } from "./ui/coverArt.js";
import { restoreCoverUrlsFromCache } from "./audio/audioDB.js";
import { supabasePullStateSilent, supabaseFetchCoverBlob } from "./supabase.js";

// ── Dependencies injected via initSync() ──
let _render = null;
let _getImportQueueRunning = null;
let _getImportQueue = null;

export function initSync({ render, getImportQueueRunning, getImportQueue }) {
  _render = render;
  _getImportQueueRunning = getImportQueueRunning;
  _getImportQueue = getImportQueue;
}

export async function incrementalSyncFromSupabase() {
  const importQueueRunning = _getImportQueueRunning ? _getImportQueueRunning() : false;
  const importQueue = _getImportQueue ? _getImportQueue() : [];

  // Never sync while bulk import is running — cloud has partial/stale data
  // and merging it would delete or overwrite the songs being imported.
  if (importQueueRunning) {
    console.log("[Sync] Skipping — bulk import in progress");
    return;
  }

  const cloudState = await supabasePullStateSilent();
  if (!cloudState) return; // network failure — don't touch local state

  // Re-check after async pull — import may have started while pull was in-flight
  if (_getImportQueueRunning && _getImportQueueRunning()) {
    console.log("[Sync] Skipping merge — bulk import started during pull");
    return;
  }

  const localHasSongs = state.songs && state.songs.length > 0;
  const cloudHasSongs = cloudState.songs && cloudState.songs.length > 0;

  // Cloud is empty — adopt that as truth (library was cleared on another device)
  if (!cloudHasSongs) {
    if (localHasSongs) {
      state.songs = [];
      state.projects = cloudState.projects || [];
      state.releases = [];
      normalizeState();
      saveState();
      coverCache.clear();
      if (_render) _render();
      toast("Library synced from cloud (empty)");
    }
    return;
  }

  if (!localHasSongs) {
    // Local is empty — adopt cloud state wholesale
    state.songs = cloudState.songs;
    state.releases = cloudState.releases || state.releases;
    state.projects = cloudState.projects || state.projects;
    normalizeState();
    await restoreCoverUrlsFromCache(state.songs, supabaseFetchCoverBlob);
    saveState();
    coverCache.clear();
    if (_render) _render();
    toast("Loaded library from cloud");
    return;
  }

  // Build lookup of cloud songs by ID for deletion detection
  const cloudSongIds = new Set(cloudState.songs.map(s => s.id));

  // Remove local songs that no longer exist in the cloud.
  // Protect songs from any import queue item that isn't old.
  const RECENT_MS = 5 * 60 * 1000; // 5 minutes
  const importingIds = new Set(importQueue
    .filter(q => q.status === "waiting" || q.status === "uploading"
              || (q.status === "done" && q.ts && Date.now() - q.ts < RECENT_MS))
    .map(q => q.existingSongId || q.id)
  );
  const beforeCount = state.songs.length;
  let removed = 0;
  if (!importQueueRunning) {
    state.songs = state.songs.filter(s => cloudSongIds.has(s.id) || importingIds.has(s.id));
    removed = beforeCount - state.songs.length;
  }

  // Build lookup of local songs by title+project (stable identity)
  const localByKey = new Map();
  for (const s of state.songs) {
    localByKey.set(`${(s.title || "").trim()}|${(s.project || "").trim()}`, s);
  }

  let added = 0, updated = 0;

  for (const cs of cloudState.songs) {
    const key = `${(cs.title || "").trim()}|${(cs.project || "").trim()}`;
    const local = localByKey.get(key);

    if (!local) {
      state.songs.push(cs);
      added++;
    } else {
      const localTime = new Date(local.updatedAt || 0).getTime();
      const cloudTime = new Date(cs.updatedAt || 0).getTime();
      if (cloudTime > localTime) {
        const preserveFields = ["_coverResolving", "_userCoverResolving"];
        for (const f of preserveFields) {
          if (local[f] !== undefined) cs[f] = local[f];
        }
        // Preserve local cover blob URLs (cloud doesn't store blob URLs)
        if (local.userCoverImageUrl && !cs.userCoverImageUrl) cs.userCoverImageUrl = local.userCoverImageUrl;
        if (local.coverImageUrl && !cs.coverImageUrl) cs.coverImageUrl = local.coverImageUrl;
        if (local.coverSource === "user" && local.userCoverPath) cs.coverSource = "user";

        // Preserve local-only audio fields that cloud doesn't store.
        const localVersionsById = new Map();
        for (const lv of (local.versions || [])) localVersionsById.set(lv.id, lv);
        for (const cv of (cs.versions || [])) {
          const lv = localVersionsById.get(cv.id);
          if (lv) {
            if (lv.fileId && !cv.fileId && !cv.audioPath) cv.fileId = lv.fileId;
            if (lv.localAudioId && !cv.localAudioId && !cv.audioPath) cv.localAudioId = lv.localAudioId;
          }
        }

        Object.assign(local, cs);
        updated++;
      }
      if (!local.coverPath && cs.coverPath) {
        local.coverPath = cs.coverPath;
        updated++;
      }
    }
  }

  // Sync project list from cloud (cloud is truth)
  if (cloudState.projects?.length) {
    state.projects = [...cloudState.projects];
  } else {
    state.projects = [];
  }

  if (added || updated || removed) {
    normalizeState();
    await restoreCoverUrlsFromCache(state.songs, supabaseFetchCoverBlob);
    saveState();
    coverCache.clear();
    if (_render) _render();
    const parts = [];
    if (added) parts.push(`${added} new`);
    if (updated) parts.push(`${updated} updated`);
    if (removed) parts.push(`${removed} removed`);
    toast(`Synced: ${parts.join(", ")}`);
  }
}

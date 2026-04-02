import { sharedData } from "../state.js";
import { cachedAudioPaths } from "../audio/audioDB.js";

export function getVersionSyncColor(v) {
  if (!v) return "red";
  const hasLocal = !!(v.fileId || v.localAudioId || v.link || cachedAudioPaths.has(v.audioPath));
  const hasClouds = !!v.audioPath;
  if (hasLocal && hasClouds) return "green";
  if (hasLocal || hasClouds) return "yellow";
  return "red";
}

// Returns best-case sync color across versions that have audio.
// Versions with no audio at all are ignored (they're empty, not broken).
// Only returns "red" if NO version has any audio source.
export function getSongSyncColor(song) {
  if (!song?.versions?.length) return "red";
  let best = "red";
  for (const v of song.versions) {
    const c = getVersionSyncColor(v);
    if (c === "green") return "green";
    if (c === "yellow") best = "yellow";
  }
  return best;
}

// Shared badge icons — purple outbound (I shared), green inbound (shared with me)
export function sharedBadge(song) {
  if (song._shared) {
    // Inbound — shared with me (green left arrow)
    return `<span class="sharedBadge sharedBadgeIn" title="Shared with you"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 5 5 12 12 19"/></svg></span>`;
  }
  // Outbound — I shared this song or its project
  const mySongIds = new Set((sharedData.mySongs || []).map(ms => ms.songId));
  const myProjNames = new Set((sharedData.myProjects || []).map(mp => mp.projectName));
  if (mySongIds.has(song.id) || myProjNames.has((song.project || "").trim())) {
    return `<span class="sharedBadge sharedBadgeOut" title="Shared by you"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></span>`;
  }
  return "";
}

// Project-level shared badge — also checks if any individual songs in this project are shared
export function sharedBadgeProject(projectName) {
  const myProjNames = new Set((sharedData.myProjects || []).map(mp => mp.projectName));
  const mySongProjs = new Set((sharedData.mySongs || []).map(ms => ms.projectName).filter(Boolean));
  const sharedProjNames = new Set((sharedData.projects || []).map(sp => sp.projectName));
  const sharedSongProjs = new Set([
    ...(sharedData.songs || []).map(ss => (ss.song?.project || "").trim()).filter(Boolean),
    ...(sharedData.projects || []).flatMap(sp => (sp.songs || []).map(s => (s.project || "").trim())).filter(Boolean),
  ]);
  if (myProjNames.has(projectName) || mySongProjs.has(projectName)) {
    return `<span class="sharedBadge sharedBadgeOut" title="Shared by you"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></span>`;
  }
  if (sharedProjNames.has(projectName) || sharedSongProjs.has(projectName)) {
    return `<span class="sharedBadge sharedBadgeIn" title="Shared with you"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 5 5 12 12 19"/></svg></span>`;
  }
  return "";
}

// Returns an HTML dot string for debug overlay (empty string if debug off)
export function syncDot(song) {
  const color = getSongSyncColor(song);
  // Always show red dot for songs with no audio — users need to know
  if (color === "red") {
    return `<span class="syncDot syncDot--red" title="No audio"></span>`;
  }
  // Debug-only for green/yellow states
  if (!window.RIFFBANK_DEBUG_SYNC) return "";
  const label = color === "green" ? "Synced" : "Local only";
  return `<span class="syncDot syncDot--${color}" title="${label}"></span>`;
}

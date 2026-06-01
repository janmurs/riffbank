// ── Dev toggles ──
export const DISABLE_SPLASH = true;
export const DISABLE_WELCOME = true;

// Debug: show cache version badge on every screen
export const SHOW_BUILD_BADGE = false;

// ── Local storage keys ──
export const LS_KEY = "riffbank_v1";
export const IMPORT_QUEUE_KEY = "riffbank_import_queue";
export const NOTIF_STORAGE_KEY = "riffbank_notifications";
export const NOTIF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── IndexedDB ──
export const AUDIO_DB = "riffbank_audio_v2";
export const AUDIO_STORE = "files";

// ── Tab titles (used by setHeader when switching back to a default header) ──
export const TAB_TITLES = {
  home: "RiffBank",
  songs: "Songs",
  player: "Player",
  collab: "Collab",
  profile: "Profile",
  settings: "Settings",
};

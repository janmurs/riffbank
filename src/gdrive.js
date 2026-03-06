// ============================================================
// RiffBank – Google Drive Integration Module
// ============================================================
// Drop-in module that adds Google Drive folder-based storage
// to your existing local-only PWA.
//
// SETUP:
//   1. Create a Google Cloud project at https://console.cloud.google.com
//   2. Enable the Google Drive API AND the Google Picker API
//   3. Create OAuth 2.0 Client ID (Web application)
//      - Add your domain(s) to Authorized JavaScript origins
//      - No redirect URI needed (we use the popup/token flow)
//   4. Create an API Key (for the Picker)
//   5. Paste your Client ID and API Key below
//
// HOW IT WORKS:
//   - User signs in via Google Identity Services (GIS) popup
//   - User picks an existing folder (or creates one) via Google Picker
//   - When uploading audio, RiffBank creates subfolders:
//       {HomeFolder}/{Project}/{SongTitle}/Versions/
//   - Audio files are uploaded to that folder
//   - The Drive file ID is stored on the version object (v.driveFileId)
//   - Playback streams directly from Drive when no local file exists
//   - Streaming NEVER triggers a sign-in popup (silent fallback)
//   - Folder IDs are cached in localStorage for speed
// ============================================================

// ⚠️  PASTE YOUR GOOGLE CLOUD CREDENTIALS HERE
const GDRIVE_CLIENT_ID = "1025030239095-qe87ahu4e7e0b9cnf5lliraltp7usros.apps.googleusercontent.com";
const GDRIVE_API_KEY = "AIzaSyDF8E1aRZWBCIEMwYuRpe4TRzo4-iUScVY"; // for Google Picker only

// Scopes: drive.file for creating/managing our files,
// drive.readonly so the Picker can browse existing folders
const GDRIVE_SCOPES = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly";

// localStorage key for persisted Drive config
const GDRIVE_LS_KEY = "riffbank_gdrive_v1";

// Folder MIME type
const FOLDER_MIME = "application/vnd.google-apps.folder";

// In-memory cache of folder paths → folder IDs (also persisted)
let _folderCache = {};

// Current access token (refreshed via GIS on expiry)
let _accessToken = null;
let _tokenExpiry = 0; // epoch ms

// GIS token client reference
let _tokenClient = null;

// Whether external scripts have loaded
let _gisLoaded = false;
let _pickerLoaded = false;

// Pending resolve for token request (GIS callback)
let _tokenResolve = null;

// ---------------------
// Persistence helpers
// ---------------------
function _loadConfig() {
  try {
    const raw = localStorage.getItem(GDRIVE_LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {
    connected: false,
    homeFolderId: null,
    homeFolderName: "",
    userEmail: "",
    folderCache: {},
  };
}

function _saveConfig(cfg) {
  localStorage.setItem(GDRIVE_LS_KEY, JSON.stringify(cfg));
}

let _config = _loadConfig();
_folderCache = _config.folderCache || {};

// ---------------------
// Public API
// ---------------------

/**
 * Is the user currently connected to Google Drive?
 */
export function gdriveIsConnected() {
  return !!(_config.connected && _config.homeFolderId);
}

/**
 * Does the app already have a valid in-memory token?
 * Use this to avoid triggering a sign-in popup unexpectedly.
 */
export function gdriveHasValidToken() {
  return !!(_accessToken && Date.now() < _tokenExpiry);
}

/**
 * Get current config (read-only snapshot)
 */
export function gdriveGetConfig() {
  return { ..._config };
}

/**
 * Load the Google Identity Services + Picker scripts (call once on app init)
 */
export function gdriveLoadGIS() {
  // Load GIS
  const gisPromise = new Promise((resolve) => {
    if (_gisLoaded) return resolve();
    if (document.querySelector('script[src*="accounts.google.com/gsi/client"]')) {
      _gisLoaded = true;
      return resolve();
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => { _gisLoaded = true; resolve(); };
    script.onerror = () => { console.warn("RiffBank: Failed to load GIS"); resolve(); };
    document.head.appendChild(script);
  });

  // Load Google Picker API
  const pickerPromise = new Promise((resolve) => {
    if (_pickerLoaded) return resolve();
    if (document.querySelector('script[src*="apis.google.com/js/api.js"]')) {
      _pickerLoaded = true;
      return resolve();
    }

    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.defer = true;
    script.onload = () => {
      window.gapi.load("picker", () => {
        _pickerLoaded = true;
        resolve();
      });
    };
    script.onerror = () => { console.warn("RiffBank: Failed to load Picker API"); resolve(); };
    document.head.appendChild(script);
  });

  return Promise.all([gisPromise, pickerPromise]);
}

/**
 * Connect to Google Drive by picking an EXISTING folder.
 * Opens Google sign-in, then Google Picker to browse folders.
 * Returns { success, email, homeFolderId, homeFolderName } or { success: false, error }
 */
export async function gdriveConnect() {
  if (!_gisLoaded) await gdriveLoadGIS();

  if (!window.google?.accounts?.oauth2) {
    return { success: false, error: "Google Identity Services not loaded. Check your internet connection." };
  }

  // Step 1: Request token via popup
  const token = await _requestToken();
  if (!token) {
    return { success: false, error: "Sign-in cancelled or failed." };
  }

  // Step 2: Get user email
  let email = "";
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const info = await res.json();
    email = info.email || "";
  } catch {}

  // Step 3: Let user pick a folder via Google Picker
  const folder = await _pickFolder(token);
  if (!folder) {
    return { success: false, error: "No folder selected." };
  }

  // Persist
  _config.connected = true;
  _config.homeFolderId = folder.id;
  _config.homeFolderName = folder.name;
  _config.userEmail = email;
  _config.folderCache = _folderCache;
  _saveConfig(_config);

  return { success: true, email, homeFolderId: folder.id, homeFolderName: folder.name };
}

/**
 * Connect to Google Drive by CREATING a new folder at the root.
 *
 * @param {string} folderName - Name for the new folder at Drive root
 * Returns { success, email, homeFolderId, homeFolderName } or { success: false, error }
 */
export async function gdriveConnectNewFolder(folderName = "RiffBank") {
  if (!_gisLoaded) await gdriveLoadGIS();

  if (!window.google?.accounts?.oauth2) {
    return { success: false, error: "Google Identity Services not loaded. Check your internet connection." };
  }

  const token = await _requestToken();
  if (!token) {
    return { success: false, error: "Sign-in cancelled or failed." };
  }

  let email = "";
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const info = await res.json();
    email = info.email || "";
  } catch {}

  const homeFolderId = await _findOrCreateFolder(folderName, "root");
  if (!homeFolderId) {
    return { success: false, error: "Could not create home folder on Drive." };
  }

  _config.connected = true;
  _config.homeFolderId = homeFolderId;
  _config.homeFolderName = folderName;
  _config.userEmail = email;
  _config.folderCache = _folderCache;
  _saveConfig(_config);

  return { success: true, email, homeFolderId, homeFolderName: folderName };
}

/**
 * Disconnect from Google Drive (clear tokens + config).
 */
export function gdriveDisconnect() {
  if (_accessToken && window.google?.accounts?.oauth2) {
    try { google.accounts.oauth2.revoke(_accessToken); } catch {}
  }

  _accessToken = null;
  _tokenExpiry = 0;
  _tokenClient = null;
  _folderCache = {};

  _config = {
    connected: false,
    homeFolderId: null,
    homeFolderName: "",
    userEmail: "",
    folderCache: {},
  };
  _saveConfig(_config);
}

/**
 * Upload an audio file (Blob/File) to Drive under the correct folder path.
 *
 * @param {Object} opts
 * @param {File|Blob} opts.file       - The audio file
 * @param {string}    opts.fileName   - Desired filename on Drive
 * @param {string}    opts.project    - Song's project name
 * @param {string}    opts.songTitle  - Song title
 *
 * @returns {Object} { success, driveFileId, driveWebViewLink } or { success: false, error }
 */
export async function gdriveUploadAudio({ file, fileName, project, songTitle }) {
  if (!gdriveIsConnected()) {
    return { success: false, error: "Not connected to Google Drive." };
  }

  const token = await _ensureToken();
  if (!token) return { success: false, error: "Auth expired. Please reconnect." };

  // Build folder path: Home / Project / SongTitle / Versions
  const homeId = _config.homeFolderId;
  const projId = await _findOrCreateFolder(_sanitize(project || "Project"), homeId);
  const songId = await _findOrCreateFolder(_sanitize(songTitle || "Untitled"), projId);
  const versionsId = await _findOrCreateFolder("Versions", songId);

  if (!versionsId) {
    return { success: false, error: "Could not create folder structure on Drive." };
  }

  try {
    const metadata = {
      name: fileName || "audio.wav",
      parents: [versionsId],
    };

    const form = new FormData();
    form.append(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" })
    );
    form.append("file", file);

    const res = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error("Drive upload failed:", res.status, errText);
      return { success: false, error: `Upload failed (${res.status})` };
    }

    const data = await res.json();

    _config.folderCache = _folderCache;
    _saveConfig(_config);

    return {
      success: true,
      driveFileId: data.id,
      driveWebViewLink: data.webViewLink || "",
    };
  } catch (err) {
    console.error("Drive upload error:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Upload (or replace) a cover art image for a song on Drive.
 * Saves it as "cover.jpg" in the song's folder: Home / Project / SongTitle /
 *
 * @param {{ blob: Blob, project: string, songTitle: string }} opts
 * @returns {{ success: boolean, driveFileId?: string, error?: string }}
 */
export async function gdriveUploadCoverArt({ blob, project, songTitle }) {
  if (!gdriveIsConnected()) {
    return { success: false, error: "Not connected to Google Drive." };
  }

  const token = await _ensureToken();
  if (!token) return { success: false, error: "Auth expired. Please reconnect." };

  const homeId = _config.homeFolderId;
  const projId = await _findOrCreateFolder(_sanitize(project || "Project"), homeId);
  const songFolderId = await _findOrCreateFolder(_sanitize(songTitle || "Untitled"), projId);

  if (!songFolderId) {
    return { success: false, error: "Could not create folder structure on Drive." };
  }

  try {
    // Check if cover.jpg already exists — if so, delete it first
    const existing = await _listChildren(songFolderId, token, false);
    const oldCover = existing.find(f => /^cover\.(jpg|png|webp)$/i.test(f.name));
    if (oldCover) {
      await gdriveDeleteFile(oldCover.id);
    }

    const metadata = {
      name: "cover.jpg",
      parents: [songFolderId],
    };

    const form = new FormData();
    form.append(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" })
    );
    form.append("file", blob);

    const res = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error("Drive cover upload failed:", res.status, errText);
      return { success: false, error: `Upload failed (${res.status})` };
    }

    const data = await res.json();
    return { success: true, driveFileId: data.id };
  } catch (err) {
    console.error("Drive cover upload error:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Get a streamable download URL for a Drive file.
 * If the token is missing or expired, attempts a silent refresh via GIS
 * (uses prompt:"" so no disruptive popup if the user has an active session).
 *
 * @param {string} driveFileId
 * @returns {string|null}
 */
export async function gdriveGetStreamUrl(driveFileId) {
  if (!driveFileId) return null;

  const token = _accessToken && Date.now() < _tokenExpiry
    ? _accessToken
    : await _ensureToken();
  if (!token) return null;

  // Fetch via Authorization header (works even when query-param tokens get 403)
  // and return a blob URL that <img> / <audio> can use directly
  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

/**
 * Fetch a Drive file as a Blob (for caching locally).
 *
 * @param {string} driveFileId
 * @returns {Blob|null}
 */
export async function gdriveFetchBlob(driveFileId) {
  if (!driveFileId) return null;

  const token = await _ensureToken();
  if (!token) return null;

  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

/**
 * Delete a file from Drive.
 *
 * @param {string} driveFileId
 * @returns {boolean}
 */
export async function gdriveDeleteFile(driveFileId) {
  if (!driveFileId) return false;

  const token = await _ensureToken();
  if (!token) return false;

  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${driveFileId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/**
 * List all files inside a specific folder path relative to home.
 *
 * @param {string} relativePath - e.g. "ProjectName/SongTitle/Versions"
 * @returns {Array} list of { id, name, mimeType, size, modifiedTime }
 */
export async function gdriveListFiles(relativePath = "") {
  if (!gdriveIsConnected()) return [];

  const token = await _ensureToken();
  if (!token) return [];

  let folderId = _config.homeFolderId;

  if (relativePath) {
    const parts = relativePath.split("/").filter(Boolean);
    for (const part of parts) {
      const childId = await _findFolder(part, folderId);
      if (!childId) return [];
      folderId = childId;
    }
  }

  try {
    const q = `'${folderId}' in parents and trashed = false`;
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,modifiedTime)&pageSize=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.files || [];
  } catch {
    return [];
  }
}


/**
 * Rebuild song metadata by walking the Drive folder structure.
 * Reads: HomeFolder/{Project}/{SongTitle}/Versions/{audiofiles}
 * Returns an array of song objects ready to merge into app state.
 * Skips the .riffbank-state.json file and any non-folder items at project level.
 *
 * @returns {Array} songs array, or empty array on failure
 */
export async function gdriveRebuildFromFolders() {
  if (!gdriveIsConnected()) return [];

  const token = await _ensureToken();
  if (!token) return [];

  const homeId = _config.homeFolderId;
  const songs = [];

  try {
    // Level 1: list projects (folders in home)
    const projects = await _listChildren(homeId, token, true);

    for (const project of projects) {
      // Level 2: list songs (folders in project)
      const songFolders = await _listChildren(project.id, token, true);

      for (const songFolder of songFolders) {
        // Level 3: list ALL children (folders + files) to find Versions subfolder and cover art
        const songChildren = await _listChildren(songFolder.id, token, false);
        const versionsFolder = songChildren.find(f => f.mimeType === FOLDER_MIME && f.name === "Versions");
        const coverFile = songChildren.find(f => /^cover\.(jpg|png|webp)$/i.test(f.name));

        const versions = [];

        if (versionsFolder) {
          // Level 4: list audio files in Versions
          const audioFiles = await _listChildren(versionsFolder.id, token, false);

          for (const file of audioFiles) {
            // Skip non-audio files
            if (file.mimeType && file.mimeType.startsWith("application/")) continue;

            const versionId = "v_" + Math.random().toString(36).slice(2, 10);
            versions.push({
              id: versionId,
              label: file.name.replace(/\.[^.]+$/, ""), // strip extension for label
              fileName: file.name,
              originalFileName: file.name,
              fileSize: parseInt(file.size || "0", 10),
              fileType: file.mimeType || "audio/*",
              link: "",
              fileId: null,
              localAudioId: null,
              driveFileId: file.id,
              driveWebViewLink: "",
              notes: "",
              isBest: false,
              isActive: true,
              playerYes: false,
              favorite: false,
              createdAt: file.modifiedTime || new Date().toISOString(),
            });
          }
        }

        if (versions.length === 0) continue; // skip empty songs

        const songId = "s_" + Math.random().toString(36).slice(2, 10);
        songs.push({
          id: songId,
          title: songFolder.name,
          project: project.name,
          genre: "",
          sprint: "",
          notes: "",
          status: "idea",
          featuredVersionId: versions.length > 0 ? versions[0].id : null,
          versions,
          coverDriveFileId: coverFile ? coverFile.id : null,
          createdAt: songFolder.modifiedTime || new Date().toISOString(),
          updatedAt: songFolder.modifiedTime || new Date().toISOString(),
        });
      }
    }

    return songs;
  } catch (err) {
    console.error("RiffBank: Rebuild from Drive failed", err);
    return [];
  }
}

/**
 * List children of a folder by ID.
 * @param {string} parentId - Drive folder ID
 * @param {string} token - access token
 * @param {boolean} foldersOnly - if true, only return folders
 * @returns {Array} list of { id, name, mimeType, size, modifiedTime }
 */
async function _listChildren(parentId, token, foldersOnly = false) {
  try {
    let q = `'${parentId}' in parents and trashed = false`;
    if (foldersOnly) q += ` and mimeType = '${FOLDER_MIME}'`;

    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,modifiedTime)&pageSize=200`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.files || [];
  } catch {
    return [];
  }
}


// ============================================================
// STATE SYNC — save/load app state JSON to/from Drive
// ============================================================

const STATE_FILENAME = ".riffbank-state.json";

// Cached state file ID so we don't search every time
let _stateFileId = null;

// Debounce timer for auto-save
let _syncTimer = null;
const SYNC_DEBOUNCE_MS = 5000; // 5 seconds after last save

/**
 * Save app state JSON to Drive (debounced).
 * Call this every time saveState() fires.
 * Silently skips if not connected or no token.
 *
 * @param {Object} stateObj - The full app state object
 */
export function gdriveSyncStateSoon(stateObj) {
  if (!gdriveIsConnected()) return;

  // Debounce: wait 5s after last call before actually pushing
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => {
    _pushState(stateObj);
  }, SYNC_DEBOUNCE_MS);
}

/**
 * Force-push state to Drive immediately (no debounce).
 * Use for critical saves like before closing the app.
 *
 * @param {Object} stateObj
 * @returns {boolean} success
 */
export async function gdriveSyncStateNow(stateObj) {
  if (!gdriveIsConnected()) return false;
  return await _pushState(stateObj);
}

/**
 * Pull app state from Drive (ACTIVE — will prompt for sign-in if needed).
 * Use this for the manual "Pull" button.
 * Returns the parsed state object, or null if not found / not connected.
 */
export async function gdrivePullState() {
  if (!gdriveIsConnected()) return null;

  // Active token request — will prompt sign-in if expired
  const token = await _ensureToken();
  if (!token) return null;

  try {
    // Find the state file in the home folder
    const fileId = await _findStateFile();
    if (!fileId) return null;

    // Download contents
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!res.ok) return null;

    const stateObj = await res.json();
    return stateObj;
  } catch (err) {
    console.warn("RiffBank: Failed to pull state from Drive", err);
    return null;
  }
}

/**
 * Pull app state from Drive (SILENT — will NOT prompt for sign-in).
 * Use this for auto-load on startup.
 * Returns the parsed state object, or null if not found / token expired.
 */
export async function gdrivePullStateSilent() {
  if (!gdriveIsConnected()) return null;

  // Silent check — don't prompt just for loading state
  if (!_accessToken || Date.now() >= _tokenExpiry) return null;

  try {
    const fileId = await _findStateFile();
    if (!fileId) return null;

    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${_accessToken}` } }
    );

    if (!res.ok) return null;

    const stateObj = await res.json();
    return stateObj;
  } catch (err) {
    console.warn("RiffBank: Failed to pull state from Drive", err);
    return null;
  }
}

/**
 * Get the timestamp of the state file on Drive.
 * Returns ISO string or null. SILENT (no auth popup).
 */
export async function gdriveGetStateTimestamp() {
  if (!gdriveIsConnected()) return null;
  if (!_accessToken || Date.now() >= _tokenExpiry) return null;

  try {
    const fileId = await _findStateFile();
    if (!fileId) return null;

    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=modifiedTime`,
      { headers: { Authorization: `Bearer ${_accessToken}` } }
    );

    if (!res.ok) return null;
    const data = await res.json();
    return data.modifiedTime || null;
  } catch {
    return null;
  }
}


// ---------------------
// State sync internals
// ---------------------

async function _pushState(stateObj) {
  // Need a valid token — will prompt if expired
  const token = await _ensureToken();
  if (!token) return false;

  try {
    const jsonStr = JSON.stringify(stateObj);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const homeId = _config.homeFolderId;

    // Check if state file already exists
    let fileId = await _findStateFile();

    if (fileId) {
      // UPDATE existing file (PATCH)
      const res = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: blob,
        }
      );
      if (!res.ok) {
        console.warn("RiffBank: State sync update failed", res.status);
        return false;
      }
    } else {
      // CREATE new file
      const metadata = {
        name: STATE_FILENAME,
        parents: [homeId],
        mimeType: "application/json",
      };

      const form = new FormData();
      form.append(
        "metadata",
        new Blob([JSON.stringify(metadata)], { type: "application/json" })
      );
      form.append("file", blob);

      const res = await fetch(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        }
      );

      if (!res.ok) {
        console.warn("RiffBank: State sync create failed", res.status);
        return false;
      }

      const data = await res.json();
      _stateFileId = data.id;
    }

    console.log("RiffBank: State synced to Drive ✅");
    return true;
  } catch (err) {
    console.warn("RiffBank: State sync error", err);
    return false;
  }
}

async function _findStateFile() {
  if (_stateFileId) return _stateFileId;

  const token = _accessToken;
  if (!token) return null;

  const homeId = _config.homeFolderId;
  if (!homeId) return null;

  try {
    const q = `name = '${STATE_FILENAME}' and '${homeId}' in parents and trashed = false`;
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!res.ok) return null;
    const data = await res.json();
    const id = data.files?.[0]?.id || null;
    if (id) _stateFileId = id;
    return id;
  } catch {
    return null;
  }
}


// ============================================================
// INTERNAL HELPERS
// ============================================================

function _sanitize(name) {
  return String(name || "")
    .trim()
    .replace(/[\/\\:*?"<>|#%{}[\]^`]/g, "")
    .replace(/\s+/g, " ")
    .trim() || "Untitled";
}

/**
 * Request an access token via GIS popup.
 */
function _requestToken() {
  return new Promise((resolve) => {
    if (!window.google?.accounts?.oauth2) return resolve(null);

    if (!_tokenClient) {
      _tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GDRIVE_CLIENT_ID,
        scope: GDRIVE_SCOPES,
        callback: (response) => {
          if (response.error) {
            console.warn("GIS token error:", response.error);
            if (_tokenResolve) _tokenResolve(null);
            _tokenResolve = null;
            return;
          }

          _accessToken = response.access_token;
          _tokenExpiry = Date.now() + (response.expires_in - 60) * 1000;

          if (_tokenResolve) _tokenResolve(_accessToken);
          _tokenResolve = null;
        },
      });
    }

    _tokenResolve = resolve;
    _tokenClient.requestAccessToken({ prompt: "" });
  });
}

/**
 * Ensure we have a valid token, refresh if expired.
 * Loads GIS if not yet loaded so this is safe to call at any time.
 */
async function _ensureToken() {
  if (_accessToken && Date.now() < _tokenExpiry) return _accessToken;
  if (!_gisLoaded) await gdriveLoadGIS();
  return await _requestToken();
}

/**
 * Open the Google Picker to let the user select a folder.
 * Returns { id, name } or null if cancelled.
 */
function _pickFolder(token) {
  return new Promise((resolve) => {
    if (!window.google?.picker || !_pickerLoaded) {
      console.warn("Google Picker not loaded");
      resolve(null);
      return;
    }

    try {
      const folderView = new google.picker.DocsView()
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true)
        .setMimeTypes(FOLDER_MIME)
        .setParent("root");

      const picker = new google.picker.PickerBuilder()
        .setTitle("Choose a home folder for RiffBank")
        .addView(folderView)
        .setOAuthToken(token)
        .setDeveloperKey(GDRIVE_API_KEY)
        .setCallback((data) => {
          if (data.action === google.picker.Action.PICKED) {
            const doc = data.docs?.[0];
            if (doc) {
              resolve({ id: doc.id, name: doc.name || "Selected Folder" });
            } else {
              resolve(null);
            }
          } else if (data.action === google.picker.Action.CANCEL) {
            resolve(null);
          }
        })
        .setSize(600, 500)
        .build();

      picker.setVisible(true);
    } catch (err) {
      console.error("Picker error:", err);
      resolve(null);
    }
  });
}

/**
 * Find a folder by name inside a parent. Returns folder ID or null.
 */
async function _findFolder(name, parentId) {
  const cacheKey = `${parentId}/${name}`;
  if (_folderCache[cacheKey]) return _folderCache[cacheKey];

  const token = await _ensureToken();
  if (!token) return null;

  try {
    const q = `name = '${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!res.ok) return null;
    const data = await res.json();
    const folderId = data.files?.[0]?.id || null;

    if (folderId) {
      _folderCache[cacheKey] = folderId;
    }

    return folderId;
  } catch {
    return null;
  }
}

/**
 * Find or create a folder inside a parent.
 */
async function _findOrCreateFolder(name, parentId) {
  const existing = await _findFolder(name, parentId);
  if (existing) return existing;

  const token = await _ensureToken();
  if (!token) return null;

  try {
    const res = await fetch("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME,
        parents: [parentId],
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const folderId = data.id;

    const cacheKey = `${parentId}/${name}`;
    _folderCache[cacheKey] = folderId;

    return folderId;
  } catch {
    return null;
  }
}

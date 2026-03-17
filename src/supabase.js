// Supabase client for RiffBank
// Auth + CRUD + Storage (replaces Google Drive)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const SUPABASE_URL = "https://hbgaoejdslftbwuhggtv.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_txkI4NbwclNsBW_geDj_bw_xQNL4vqO";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Auth helpers ──────────────────────────────────────

export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

export function getUser() {
  return supabase.auth.getUser();
}

export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange(callback);
}

export async function verifyOtp(email, token) {
  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token,
    type: "signup",
  });
  if (error) throw error;
  return data;
}

export async function resendConfirmation(email) {
  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
  });
  if (error) throw error;
}

// ── Internal helpers ──────────────────────────────────

async function getUserId() {
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}

async function ensureProject(name, userId) {
  const { data } = await supabase
    .from("projects")
    .select("id")
    .eq("owner_id", userId)
    .eq("name", name)
    .maybeSingle();
  if (data) return data.id;

  const { data: created, error } = await supabase
    .from("projects")
    .insert({ owner_id: userId, name })
    .select("id")
    .single();
  if (error) throw error;
  return created.id;
}

// ── State sync ────────────────────────────────────────

let _syncTimer = null;

export function supabaseSyncStateSoon(state) {
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => supabasePushState(state).catch(console.warn), 5000);
}

export async function supabasePushState(state) {
  const userId = await getUserId();
  if (!userId) return false;

  const songs = state.songs || [];

  try {
    // 1. Projects — find or create
    const projectNames = [...new Set(songs.map(s => s.project).filter(Boolean))];
    const projectMap = {};
    for (const name of projectNames) {
      projectMap[name] = await ensureProject(name, userId);
    }

    // 2. Upsert songs
    const songRows = songs.map(s => ({
      id: s.id,
      project_id: s.project ? (projectMap[s.project] || null) : null,
      title: s.title || "",
      lyrics: s.lyrics || null,
      genre: s.genre || null,
      sprint: s.sprint || null,
      instrumentation: s.instrumentation || null,
      collaborators: s.collaborators || null,
      status: s.status || null,
      stuck_state: s.stuckState || null,
      next_action: s.nextAction || null,
      vibes: s.vibes || null,
      notes: s.notes || null,
      featured_version_id: s.featuredVersionId || null,
      cover_path: s.coverPath || null,
      user_cover_path: s.userCoverPath || null,
      cover_source: s.coverSource || "ai",
      created_at: s.createdAt,
      updated_at: s.updatedAt || new Date().toISOString(),
    }));

    if (songRows.length) {
      const { error } = await supabase.from("songs").upsert(songRows, { onConflict: "id" });
      if (error) { console.warn("[Supabase] songs upsert:", error); return false; }
    }

    // 3. Upsert versions
    const versionRows = [];
    for (const s of songs) {
      for (const v of (s.versions || [])) {
        versionRows.push({
          id: v.id,
          song_id: s.id,
          label: v.label || null,
          audio_path: v.audioPath || null,
          duration_ms: null,
          is_active: !!v.isActive,
          notes: v.notes || null,
          link: v.link || null,
          file_name: v.fileName || null,
          file_type: v.fileType || null,
          file_size: v.fileSize || null,
          is_best: !!v.isBest,
          player_yes: !!v.playerYes,
          favorite: !!v.favorite,
          created_at: v.createdAt,
          updated_at: v.updatedAt || new Date().toISOString(),
        });
      }
    }

    if (versionRows.length) {
      const { error } = await supabase.from("versions").upsert(versionRows, { onConflict: "id" });
      if (error) { console.warn("[Supabase] versions upsert:", error); return false; }
    }

    // 4. Cleanup: remove songs/versions deleted locally
    const localSongIds = songs.map(s => s.id);
    const userProjectIds = Object.values(projectMap);

    if (userProjectIds.length) {
      const { data: dbSongs } = await supabase
        .from("songs")
        .select("id")
        .in("project_id", userProjectIds);
      const toDelete = (dbSongs || []).map(s => s.id).filter(id => !localSongIds.includes(id));
      if (toDelete.length) {
        await supabase.from("versions").delete().in("song_id", toDelete);
        await supabase.from("songs").delete().in("id", toDelete);
      }
    }

    const localVersionIds = versionRows.map(v => v.id);
    if (localSongIds.length) {
      const { data: dbVersions } = await supabase
        .from("versions")
        .select("id")
        .in("song_id", localSongIds);
      const toDeleteV = (dbVersions || []).map(v => v.id).filter(id => !localVersionIds.includes(id));
      if (toDeleteV.length) {
        await supabase.from("versions").delete().in("id", toDeleteV);
      }
    }

    return true;
  } catch (e) {
    console.warn("[Supabase] Push failed:", e);
    return false;
  }
}

export async function supabasePullState() {
  const userId = await getUserId();
  if (!userId) return null;

  const { data: projects } = await supabase
    .from("projects")
    .select("id, name")
    .eq("owner_id", userId);

  const projectMap = {};
  for (const p of (projects || [])) projectMap[p.id] = p.name;

  const projectIds = Object.keys(projectMap);
  if (!projectIds.length) return { songs: [], releases: [] };

  const { data: dbSongs } = await supabase
    .from("songs")
    .select("*, versions(*)")
    .in("project_id", projectIds);

  const songs = (dbSongs || []).map(s => ({
    id: s.id,
    title: s.title || "",
    project: projectMap[s.project_id] || "",
    genre: s.genre || "",
    sprint: s.sprint || "",
    instrumentation: s.instrumentation || "",
    collaborators: s.collaborators || "",
    status: s.status || "",
    stuckState: s.stuck_state || "",
    nextAction: s.next_action || "",
    vibes: s.vibes || "",
    lyrics: s.lyrics || "",
    notes: s.notes || "",
    featuredVersionId: s.featured_version_id || null,
    coverPath: s.cover_path || null,
    coverImageUrl: null,
    userCoverPath: s.user_cover_path || null,
    userCoverImageUrl: null,
    coverSource: s.cover_source || "ai",
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    versions: (s.versions || []).map(v => ({
      id: v.id,
      label: v.label || "",
      notes: v.notes || "",
      link: v.link || "",
      fileName: v.file_name || "",
      fileType: v.file_type || "",
      fileSize: v.file_size || 0,
      fileId: null,
      localAudioId: null,
      audioPath: v.audio_path || null,
      isActive: !!v.is_active,
      isBest: !!v.is_best,
      playerYes: !!v.player_yes,
      favorite: !!v.favorite,
      createdAt: v.created_at,
      updatedAt: v.updated_at,
    })),
  }));

  return { songs, releases: [] };
}

export async function supabasePullStateSilent() {
  try { return await supabasePullState(); }
  catch (e) { console.warn("[Supabase] Silent pull failed:", e); return null; }
}

// ── Audio storage ─────────────────────────────────────

export async function supabaseUploadAudio({ blob, songId, versionId, fileName }) {
  const userId = await getUserId();
  if (!userId) return { success: false, error: "Not authenticated" };

  const safeName = (fileName || "audio").replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${userId}/${songId}/${versionId}/${safeName}`;

  const { error } = await supabase.storage
    .from("audio")
    .upload(path, blob, { upsert: true, contentType: blob.type || "audio/*" });

  if (error) return { success: false, error: error.message };
  return { success: true, audioPath: path };
}

export async function supabaseFetchAudioBlob(audioPath) {
  if (!audioPath) return null;
  const { data, error } = await supabase.storage.from("audio").download(audioPath);
  if (error) { console.warn("[Supabase] audio download failed:", audioPath, error.message); return null; }
  if (!data) return null;
  return data;
}

// Discover audio files in storage for versions missing audio_path in the DB.
// Reconstructs path from the known upload pattern: userId/songId/versionId/safeName
export async function supabaseDiscoverAudioPaths(songs) {
  const userId = await getUserId();
  if (!userId) return [];

  const fixes = [];
  for (const song of songs) {
    for (const v of (song.versions || [])) {
      if (v.audioPath) continue;
      const safeName = (v.fileName || "audio").replace(/[^a-zA-Z0-9._-]/g, "_");
      const guessedPath = `${userId}/${song.id}/${v.id}/${safeName}`;
      const { data, error } = await supabase.storage.from("audio").download(guessedPath);
      if (data && !error) {
        v.audioPath = guessedPath;
        fixes.push({ versionId: v.id, audioPath: guessedPath });
      }
    }
  }
  return fixes;
}

export async function supabaseDeleteAudio(audioPath) {
  if (!audioPath) return;
  await supabase.storage.from("audio").remove([audioPath]);
}

// ── Cover storage ─────────────────────────────────────

export async function supabaseUploadCover({ blob, songId, pathOverride }) {
  const userId = await getUserId();
  if (!userId) return { success: false, error: "Not authenticated" };

  const filename = pathOverride ? `${pathOverride}.jpg` : "cover.jpg";
  const path = `${userId}/${songId}/${filename}`;
  const { error } = await supabase.storage
    .from("covers")
    .upload(path, blob, { upsert: true, contentType: blob.type || "image/jpeg" });

  if (error) return { success: false, error: error.message };
  return { success: true, coverPath: path };
}

export async function supabaseFetchCoverBlob(coverPath) {
  if (!coverPath) return null;
  const { data, error } = await supabase.storage.from("covers").download(coverPath);
  if (error || !data) return null;
  return data;
}

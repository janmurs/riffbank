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
  if (!userId) { console.warn("[Supabase] Push: no userId"); return false; }

  const songs = state.songs || [];
  console.log(`[Supabase] Push: ${songs.length} songs, userId=${userId}`);

  try {
    // 1. Projects — find or create (include standalone projects from state.projects)
    const projectNames = [...new Set([
      ...(state.projects || []).filter(Boolean),
      ...songs.map(s => s.project).filter(Boolean),
    ])];
    const projectMap = {};
    for (const name of projectNames) {
      projectMap[name] = await ensureProject(name, userId);
    }
    console.log("[Supabase] Push: projects resolved", projectMap);

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
      user_cover_path: (s.userCoverPath && s.userCoverPath.includes('/')) ? s.userCoverPath : null,
      cover_source: s.coverSource || "ai",
      created_at: s.createdAt,
      updated_at: s.updatedAt || new Date().toISOString(),
    }));

    if (songRows.length) {
      console.log("[Supabase] Push: upserting songs", songRows.map(s => ({ id: s.id, title: s.title, project_id: s.project_id })));
      const { error } = await supabase.from("songs").upsert(songRows, { onConflict: "id" });
      if (error) { console.warn("[Supabase] songs upsert FAILED:", error.message, error.details, error.hint, error.code); return false; }
      console.log("[Supabase] Push: songs upsert OK");
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

    // NOTE: No cleanup/delete logic here. Server is source of truth.
    // Deletions happen explicitly via deleteSongEverywhere().

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
  const projectNames = Object.values(projectMap).filter(Boolean);
  if (!projectIds.length) return { songs: [], releases: [], projects: projectNames };

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

  return { songs, releases: [], projects: projectNames };
}

export async function supabasePullStateSilent() {
  try { return await supabasePullState(); }
  catch (e) { console.warn("[Supabase] Silent pull failed:", e); return null; }
}

// ── Cloud song count (lightweight check for import flow) ──

export async function supabaseCountUserSongs() {
  const userId = await getUserId();
  console.log("[CountSongs] userId =", userId);
  if (!userId) return 0;
  const { data: projects, error: projErr } = await supabase
    .from("projects").select("id").eq("owner_id", userId);
  console.log("[CountSongs] projects =", projects?.length, "err =", projErr?.message);
  if (!projects?.length) return 0;
  const { count, error } = await supabase
    .from("songs").select("id", { count: "exact", head: true })
    .in("project_id", projects.map(p => p.id));
  console.log("[CountSongs] count =", count, "err =", error?.message);
  if (error) return 0;
  return count || 0;
}

// ── Audio storage ─────────────────────────────────────

export async function supabaseUploadAudio({ blob, songId, versionId }) {
  const userId = await getUserId();
  if (!userId) return { success: false, error: "Not authenticated" };

  // Always use "audio" as filename — prevents duplicate blobs from varying filenames
  const path = `${userId}/${songId}/${versionId}/audio`;

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

// ── Sharing & Collaboration ──────────────────────────

// Create an invite token for a project or song
export async function createShareInvite({ projectId, songId, role }) {
  const userId = await getUserId();
  if (!userId) throw new Error("Not authenticated");

  const row = {
    from_user: userId,
    role: role || "viewer",
  };
  if (projectId) row.project_id = projectId;
  if (songId) row.song_id = songId;

  const { data, error } = await supabase
    .from("share_invites")
    .insert(row)
    .select("token, role, project_id, song_id, expires_at")
    .single();

  if (error) throw error;
  return data;
}

// Look up an invite by token (for the accept page)
export async function getShareInvite(token) {
  const { data, error } = await supabase
    .from("share_invites")
    .select(`
      id, token, role, accepted, expires_at,
      from_user, project_id, song_id
    `)
    .eq("token", token)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  // Fetch sharer's display name
  let fromName = null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", data.from_user)
    .maybeSingle();
  if (profile) fromName = profile.display_name;

  // Fetch project/song name for display
  let targetName = null;
  let targetType = null;
  if (data.project_id) {
    targetType = "project";
    const { data: proj } = await supabase
      .from("projects").select("name").eq("id", data.project_id).maybeSingle();
    if (proj) targetName = proj.name;
  } else if (data.song_id) {
    targetType = "song";
    const { data: song } = await supabase
      .from("songs").select("title").eq("id", data.song_id).maybeSingle();
    if (song) targetName = song.title;
  }

  return {
    ...data,
    fromName,
    targetType,
    targetName,
  };
}

// Accept an invite — creates project_members or song_shares row
export async function acceptShareInvite(token) {
  const userId = await getUserId();
  if (!userId) throw new Error("Not authenticated");

  // 1. Fetch the invite
  const { data: invite, error: fetchErr } = await supabase
    .from("share_invites")
    .select("*")
    .eq("token", token)
    .maybeSingle();

  if (fetchErr) throw fetchErr;
  if (!invite) throw new Error("Invite not found");
  if (invite.accepted) throw new Error("Invite already used");
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) throw new Error("Invite expired");
  if (invite.from_user === userId) throw new Error("Cannot accept your own invite");

  // 2. Create membership
  if (invite.project_id) {
    const { error } = await supabase.from("project_members").upsert({
      project_id: invite.project_id,
      user_id: userId,
      role: invite.role,
      invited_by: invite.from_user,
    }, { onConflict: "project_id,user_id" });
    if (error) throw error;
  } else if (invite.song_id) {
    const { error } = await supabase.from("song_shares").upsert({
      song_id: invite.song_id,
      user_id: userId,
      role: invite.role,
      invited_by: invite.from_user,
    }, { onConflict: "song_id,user_id" });
    if (error) throw error;
  }

  // 3. Mark invite as accepted
  await supabase.from("share_invites")
    .update({ accepted: true, accepted_by: userId, accepted_at: new Date().toISOString() })
    .eq("id", invite.id);

  // 4. Ensure acceptor has a profile row
  await supabase.from("profiles").upsert({
    id: userId,
    updated_at: new Date().toISOString(),
  }, { onConflict: "id" });

  return { role: invite.role, projectId: invite.project_id, songId: invite.song_id };
}

// Fetch all projects shared WITH the current user (+ their songs)
export async function pullSharedProjects() {
  const userId = await getUserId();
  if (!userId) return [];

  // Get memberships
  const { data: memberships, error: memErr } = await supabase
    .from("project_members")
    .select("project_id, role, invited_by")
    .eq("user_id", userId);

  if (memErr || !memberships?.length) return [];

  const projectIds = memberships.map(m => m.project_id);

  // Fetch projects
  const { data: projects } = await supabase
    .from("projects")
    .select("id, name, owner_id")
    .in("id", projectIds);

  if (!projects?.length) return [];

  // Fetch songs + versions for those projects
  const { data: dbSongs } = await supabase
    .from("songs")
    .select("*, versions(*)")
    .in("project_id", projectIds);

  // Fetch owner profiles
  const ownerIds = [...new Set(projects.map(p => p.owner_id))];
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, display_name")
    .in("id", ownerIds);
  const profileMap = {};
  for (const p of (profiles || [])) profileMap[p.id] = p.display_name;

  // Build project map
  const projectMap = {};
  for (const p of projects) projectMap[p.id] = p;

  // Map songs to app format
  const mapSong = (s) => ({
    id: s.id,
    title: s.title || "",
    project: projectMap[s.project_id]?.name || "",
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
  });

  // Group by project
  return memberships.map(m => {
    const proj = projectMap[m.project_id];
    if (!proj) return null;
    const songs = (dbSongs || []).filter(s => s.project_id === m.project_id).map(mapSong);
    return {
      projectId: m.project_id,
      projectName: proj.name,
      ownerName: profileMap[proj.owner_id] || "Someone",
      ownerId: proj.owner_id,
      role: m.role,
      songs,
    };
  }).filter(Boolean);
}

// Fetch individual songs shared directly with the current user
export async function pullSharedSongs() {
  const userId = await getUserId();
  if (!userId) return [];

  const { data: shares, error } = await supabase
    .from("song_shares")
    .select("song_id, role, invited_by")
    .eq("user_id", userId);

  if (error || !shares?.length) return [];

  const songIds = shares.map(s => s.song_id);

  const { data: dbSongs } = await supabase
    .from("songs")
    .select("*, versions(*), project_id")
    .in("id", songIds);

  if (!dbSongs?.length) return [];

  // Get project names & owner profiles
  const projectIds = [...new Set(dbSongs.map(s => s.project_id).filter(Boolean))];
  const { data: projects } = await supabase
    .from("projects").select("id, name, owner_id").in("id", projectIds);
  const projMap = {};
  const ownerIds = new Set();
  for (const p of (projects || [])) { projMap[p.id] = p; ownerIds.add(p.owner_id); }

  const { data: profiles } = await supabase
    .from("profiles").select("id, display_name").in("id", [...ownerIds]);
  const profileMap = {};
  for (const p of (profiles || [])) profileMap[p.id] = p.display_name;

  const shareMap = {};
  for (const s of shares) shareMap[s.song_id] = s;

  return dbSongs.map(s => {
    const share = shareMap[s.id];
    const proj = projMap[s.project_id];
    return {
      song: {
        id: s.id,
        title: s.title || "",
        project: proj?.name || "",
        genre: s.genre || "",
        lyrics: s.lyrics || "",
        notes: s.notes || "",
        coverPath: s.cover_path || null,
        coverImageUrl: null,
        coverSource: s.cover_source || "ai",
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        versions: (s.versions || []).map(v => ({
          id: v.id,
          label: v.label || "",
          notes: v.notes || "",
          link: v.link || "",
          audioPath: v.audio_path || null,
          isActive: !!v.is_active,
          favorite: !!v.favorite,
          createdAt: v.created_at,
          updatedAt: v.updated_at,
        })),
      },
      role: share.role,
      ownerId: share.invited_by || (proj ? proj.owner_id : null),
      ownerName: proj ? (profileMap[proj.owner_id] || "Someone") : "Someone",
    };
  });
}

// Fetch projects the current user has shared with others
export async function pullMySharedProjects() {
  const userId = await getUserId();
  if (!userId) return [];

  const { data: memberships, error } = await supabase
    .from("project_members")
    .select("project_id, user_id, role")
    .eq("invited_by", userId);

  if (error || !memberships?.length) return [];

  const projectIds = [...new Set(memberships.map(m => m.project_id))];
  const recipientIds = [...new Set(memberships.map(m => m.user_id))];

  const [{ data: projects }, { data: profiles }] = await Promise.all([
    supabase.from("projects").select("id, name").in("id", projectIds),
    supabase.from("profiles").select("id, display_name").in("id", recipientIds),
  ]);

  const projMap = {};
  for (const p of (projects || [])) projMap[p.id] = p.name;
  const profileMap = {};
  for (const p of (profiles || [])) profileMap[p.id] = p.display_name;

  return memberships.map(m => ({
    projectId: m.project_id,
    projectName: projMap[m.project_id] || "Unknown",
    recipientName: profileMap[m.user_id] || "Someone",
    recipientId: m.user_id,
    role: m.role,
  }));
}

// Fetch individual songs the current user has shared with others
export async function pullMySharedSongs() {
  const userId = await getUserId();
  if (!userId) return [];

  const { data: shares, error } = await supabase
    .from("song_shares")
    .select("song_id, user_id, role")
    .eq("invited_by", userId);

  if (error || !shares?.length) return [];

  const songIds = [...new Set(shares.map(s => s.song_id))];
  const recipientIds = [...new Set(shares.map(s => s.user_id))];

  const [{ data: dbSongs }, { data: profiles }] = await Promise.all([
    supabase.from("songs").select("id, title, project_id").in("id", songIds),
    supabase.from("profiles").select("id, display_name").in("id", recipientIds),
  ]);

  const songMap = {};
  for (const s of (dbSongs || [])) songMap[s.id] = s;
  const profileMap = {};
  for (const p of (profiles || [])) profileMap[p.id] = p.display_name;

  // Get project names
  const projectIds = [...new Set((dbSongs || []).map(s => s.project_id).filter(Boolean))];
  const projMap = {};
  if (projectIds.length) {
    const { data: projects } = await supabase.from("projects").select("id, name").in("id", projectIds);
    for (const p of (projects || [])) projMap[p.id] = p.name;
  }

  return shares.map(sh => {
    const song = songMap[sh.song_id];
    return {
      songId: sh.song_id,
      songTitle: song?.title || "Unknown",
      projectName: song ? (projMap[song.project_id] || "") : "",
      recipientName: profileMap[sh.user_id] || "Someone",
      recipientId: sh.user_id,
      role: sh.role,
    };
  });
}

// List pending invites sent by the current user
export async function listMyInvites() {
  const userId = await getUserId();
  if (!userId) return [];

  const { data, error } = await supabase
    .from("share_invites")
    .select("id, token, role, accepted, created_at, expires_at, project_id, song_id")
    .eq("from_user", userId)
    .order("created_at", { ascending: false });

  if (error || !data?.length) return [];

  // Enrich with project/song names
  const projectIds = [...new Set(data.map(d => d.project_id).filter(Boolean))];
  const songIds = [...new Set(data.map(d => d.song_id).filter(Boolean))];

  const projMap = {};
  if (projectIds.length) {
    const { data: projs } = await supabase.from("projects").select("id, name").in("id", projectIds);
    for (const p of (projs || [])) projMap[p.id] = p.name;
  }
  const songMap = {};
  if (songIds.length) {
    const { data: songs } = await supabase.from("songs").select("id, title").in("id", songIds);
    for (const s of (songs || [])) songMap[s.id] = s.title;
  }

  return data.map(inv => ({
    ...inv,
    targetName: inv.project_id ? projMap[inv.project_id] : songMap[inv.song_id],
    targetType: inv.project_id ? "project" : "song",
    expired: inv.expires_at && new Date(inv.expires_at) < new Date(),
  }));
}

// Delete an invite
export async function deleteShareInvite(inviteId) {
  const { error } = await supabase.from("share_invites").delete().eq("id", inviteId);
  if (error) throw error;
}

// Remove a member from a project (owner action) or leave
export async function removeProjectMember(projectId, userId) {
  const { error } = await supabase
    .from("project_members")
    .delete()
    .eq("project_id", projectId)
    .eq("user_id", userId);
  if (error) throw error;
}

// Ensure user profile exists with display name (+ optional extra fields)
export async function upsertProfile({ displayName, location, instrument, genre, bio, avatarUrl } = {}) {
  const userId = await getUserId();
  if (!userId) return;
  const row = { id: userId, updated_at: new Date().toISOString() };
  if (displayName !== undefined) row.display_name = displayName;
  if (location !== undefined) row.location = location;
  if (instrument !== undefined) row.instrument = instrument;
  if (genre !== undefined) row.genre = genre;
  if (bio !== undefined) row.bio = bio;
  if (avatarUrl !== undefined) row.avatar_url = avatarUrl;
  await supabase.from("profiles").upsert(row, { onConflict: "id" });
}

// Search users by display name (for in-app share picker)
export async function searchUsers(query) {
  const userId = await getUserId();
  if (!userId || !query?.trim()) return [];

  const { data, error } = await supabase
    .from("profiles")
    .select("id, display_name, avatar_url, location, instrument, genre, bio")
    .neq("id", userId)
    .ilike("display_name", `%${query.trim()}%`)
    .limit(10);

  if (error) { console.warn("[Supabase] searchUsers:", error); return []; }
  return data || [];
}

// Share directly with a user (no invite token needed)
export async function shareWithUser({ targetUserId, projectId, songId, role }) {
  const userId = await getUserId();
  if (!userId) throw new Error("Not authenticated");
  if (targetUserId === userId) throw new Error("Can't share with yourself");

  if (projectId) {
    const { error } = await supabase.from("project_members").upsert({
      project_id: projectId,
      user_id: targetUserId,
      role: role || "viewer",
      invited_by: userId,
    }, { onConflict: "project_id,user_id" });
    if (error) throw error;
  } else if (songId) {
    const { error } = await supabase.from("song_shares").upsert({
      song_id: songId,
      user_id: targetUserId,
      role: role || "viewer",
      invited_by: userId,
    }, { onConflict: "song_id,user_id" });
    if (error) throw error;
  }

  // Auto-friend: send a friend request if not already friends
  try { await sendFriendRequest(targetUserId); } catch {}
}

// ── Friendships ──────────────────────────────────────────────────────

// Send a friend request (or no-op if already friends/pending)
export async function sendFriendRequest(targetUserId) {
  const userId = await getUserId();
  if (!userId) throw new Error("Not authenticated");
  if (targetUserId === userId) throw new Error("Can't friend yourself");

  // Check if friendship already exists in either direction
  const { data: existing } = await supabase
    .from("friendships")
    .select("id, status")
    .or(`and(requester_id.eq.${userId},recipient_id.eq.${targetUserId}),and(requester_id.eq.${targetUserId},recipient_id.eq.${userId})`)
    .maybeSingle();

  if (existing) return existing; // already pending or accepted

  const { data, error } = await supabase
    .from("friendships")
    .insert({ requester_id: userId, recipient_id: targetUserId, status: "pending" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Accept a friend request
export async function acceptFriendRequest(friendshipId) {
  const { data, error } = await supabase
    .from("friendships")
    .update({ status: "accepted", accepted_at: new Date().toISOString() })
    .eq("id", friendshipId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Decline a friend request or remove a friend
export async function removeFriendship(friendshipId) {
  const { error } = await supabase
    .from("friendships")
    .delete()
    .eq("id", friendshipId);
  if (error) throw error;
}

// Get all accepted friends (with profile data)
export async function getMyFriends() {
  const userId = await getUserId();
  if (!userId) return [];

  const { data, error } = await supabase
    .from("friendships")
    .select("id, requester_id, recipient_id, created_at, accepted_at")
    .eq("status", "accepted")
    .or(`requester_id.eq.${userId},recipient_id.eq.${userId}`)
    .order("accepted_at", { ascending: false });

  if (error) { console.warn("[Supabase] getMyFriends:", error); return []; }
  if (!data?.length) return [];

  // Resolve friend profile IDs
  const friendIds = data.map(f => f.requester_id === userId ? f.recipient_id : f.requester_id);
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, first_name, last_name, display_name, avatar_url, location, instrument, genre")
    .in("id", friendIds);

  const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));
  return data.map(f => {
    const friendId = f.requester_id === userId ? f.recipient_id : f.requester_id;
    return { ...f, friendId, profile: profileMap[friendId] || null };
  });
}

// Get pending incoming friend requests (with requester profile)
export async function getPendingFriendRequests() {
  const userId = await getUserId();
  if (!userId) return [];

  const { data, error } = await supabase
    .from("friendships")
    .select("id, requester_id, created_at")
    .eq("status", "pending")
    .eq("recipient_id", userId)
    .order("created_at", { ascending: false });

  if (error) { console.warn("[Supabase] getPendingFriendRequests:", error); return []; }
  if (!data?.length) return [];

  const requesterIds = data.map(f => f.requester_id);
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, display_name, avatar_url, location, instrument, genre")
    .in("id", requesterIds);

  const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));
  return data.map(f => ({ ...f, profile: profileMap[f.requester_id] || null }));
}

// Get count of pending incoming requests (for badge)
export async function getPendingFriendCount() {
  const userId = await getUserId();
  if (!userId) return 0;

  const { count, error } = await supabase
    .from("friendships")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending")
    .eq("recipient_id", userId);

  if (error) return 0;
  return count || 0;
}

// Get shared songs between current user and a specific friend
// Returns { sharedWithMe: [...], myShared: [...] }
export async function getSharedSongsBetween(friendUserId) {
  const userId = await getUserId();
  if (!userId || !friendUserId) return { sharedWithMe: [], myShared: [] };

  // Songs friend shared with me, and songs I shared with friend
  const [{ data: theirShares }, { data: myShares }] = await Promise.all([
    supabase.from("song_shares").select("song_id, role").eq("user_id", userId).eq("invited_by", friendUserId),
    supabase.from("song_shares").select("song_id, role").eq("user_id", friendUserId).eq("invited_by", userId),
  ]);

  const allSongIds = [
    ...new Set([
      ...((theirShares || []).map(s => s.song_id)),
      ...((myShares || []).map(s => s.song_id)),
    ])
  ];

  if (!allSongIds.length) return { sharedWithMe: [], myShared: [] };

  const { data: dbSongs } = await supabase
    .from("songs")
    .select("*, versions(*), project_id")
    .in("id", allSongIds);

  if (!dbSongs?.length) return { sharedWithMe: [], myShared: [] };

  const projectIds = [...new Set(dbSongs.map(s => s.project_id).filter(Boolean))];
  const projMap = {};
  if (projectIds.length) {
    const { data: projects } = await supabase.from("projects").select("id, name").in("id", projectIds);
    for (const p of (projects || [])) projMap[p.id] = p.name;
  }

  const songMap = {};
  for (const s of dbSongs) songMap[s.id] = s;

  function mapSong(s) {
    return {
      id: s.id,
      title: s.title || "",
      project: projMap[s.project_id] || "",
      genre: s.genre || "",
      coverPath: s.cover_path || null,
      coverImageUrl: null,
      coverSource: s.cover_source || "ai",
      createdAt: s.created_at,
      versions: (s.versions || []).map(v => ({
        id: v.id,
        label: v.label || "",
        notes: v.notes || "",
        link: v.link || "",
        audioPath: v.audio_path || null,
        isActive: !!v.is_active,
        favorite: !!v.favorite,
        createdAt: v.created_at,
      })),
    };
  }

  const sharedWithMe = (theirShares || [])
    .map(sh => songMap[sh.song_id] ? mapSong(songMap[sh.song_id]) : null)
    .filter(Boolean);

  const myShared = (myShares || [])
    .map(sh => songMap[sh.song_id] ? mapSong(songMap[sh.song_id]) : null)
    .filter(Boolean);

  return { sharedWithMe, myShared };
}

// ── Direct Messages ──────────────────────────────

// Send a message to a user
export async function sendMessage(recipientId, body) {
  const userId = await getUserId();
  if (!userId || !recipientId || !body?.trim()) return null;
  const { data, error } = await supabase
    .from("messages")
    .insert({ sender_id: userId, recipient_id: recipientId, body: body.trim() })
    .select()
    .single();
  if (error) { console.warn("[Supabase] sendMessage:", error); return null; }
  return data;
}

// Get messages between current user and another user (most recent first, paginated)
export async function getMessages(otherUserId, { limit = 50, before = null } = {}) {
  const userId = await getUserId();
  if (!userId || !otherUserId) return [];
  let query = supabase
    .from("messages")
    .select("id, sender_id, recipient_id, body, created_at, read_at")
    .or(`and(sender_id.eq.${userId},recipient_id.eq.${otherUserId}),and(sender_id.eq.${otherUserId},recipient_id.eq.${userId})`)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (before) query = query.lt("created_at", before);
  const { data, error } = await query;
  if (error) { console.warn("[Supabase] getMessages:", error); return []; }
  return (data || []).reverse(); // oldest first for display
}

// Get conversation list — latest message per unique user
export async function getConversations() {
  const userId = await getUserId();
  if (!userId) return [];

  // Get all messages involving current user, ordered by newest first
  const { data, error } = await supabase
    .from("messages")
    .select("id, sender_id, recipient_id, body, created_at, read_at")
    .or(`sender_id.eq.${userId},recipient_id.eq.${userId}`)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error || !data?.length) return [];

  // Deduplicate: keep only the latest message per conversation partner
  const seen = new Map();
  for (const msg of data) {
    const partnerId = msg.sender_id === userId ? msg.recipient_id : msg.sender_id;
    if (!seen.has(partnerId)) {
      seen.set(partnerId, { ...msg, partnerId, isFromMe: msg.sender_id === userId });
    }
  }

  // Count unread per partner
  const convos = [...seen.values()];
  for (const c of convos) {
    c.unreadCount = data.filter(m => m.sender_id === c.partnerId && m.recipient_id === userId && !m.read_at).length;
  }

  // Fetch partner profiles
  const partnerIds = convos.map(c => c.partnerId);
  if (!partnerIds.length) return [];
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, first_name, last_name, display_name, avatar_url")
    .in("id", partnerIds);
  const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));
  for (const c of convos) c.profile = profileMap[c.partnerId] || null;

  return convos;
}

// Mark messages from a sender as read
export async function markMessagesRead(senderId) {
  const userId = await getUserId();
  if (!userId || !senderId) return;
  await supabase
    .from("messages")
    .update({ read_at: new Date().toISOString() })
    .eq("sender_id", senderId)
    .eq("recipient_id", userId)
    .is("read_at", null);
}

// Get total unread message count (for badge)
export async function getUnreadMessageCount() {
  const userId = await getUserId();
  if (!userId) return 0;
  const { count, error } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("recipient_id", userId)
    .is("read_at", null);
  if (error) return 0;
  return count || 0;
}

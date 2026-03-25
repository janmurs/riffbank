-- ============================================================
-- RiffBank Storage Bucket Policies — Shared Access
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================
-- Audio files are stored at: {ownerUserId}/{songId}/{versionId}/audio
-- Cover files are stored at: {ownerUserId}/{songId}/cover.jpg
-- By default only the owner can download. These policies grant
-- download access to users the song/project has been shared with.
-- ============================================================

-- ── Audio Bucket ─────────────────────────────────────

-- Allow song-share recipients to download audio
CREATE POLICY "Shared song recipients can download audio"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'audio'
  AND EXISTS (
    SELECT 1 FROM song_shares ss
    WHERE ss.song_id = (string_to_array(name, '/'))[2]::uuid
    AND ss.user_id = auth.uid()
  )
);

-- Allow project members to download audio for songs in shared projects
CREATE POLICY "Project members can download audio"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'audio'
  AND EXISTS (
    SELECT 1 FROM songs s
    JOIN project_members pm ON pm.project_id = s.project_id
    WHERE s.id = (string_to_array(name, '/'))[2]::uuid
    AND pm.user_id = auth.uid()
  )
);

-- ── Covers Bucket ────────────────────────────────────

-- Allow song-share recipients to download cover art
CREATE POLICY "Shared song recipients can download covers"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'covers'
  AND EXISTS (
    SELECT 1 FROM song_shares ss
    WHERE ss.song_id = (string_to_array(name, '/'))[2]::uuid
    AND ss.user_id = auth.uid()
  )
);

-- Allow project members to download cover art for songs in shared projects
CREATE POLICY "Project members can download covers"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'covers'
  AND EXISTS (
    SELECT 1 FROM songs s
    JOIN project_members pm ON pm.project_id = s.project_id
    WHERE s.id = (string_to_array(name, '/'))[2]::uuid
    AND pm.user_id = auth.uid()
  )
);

-- ── Projects Table RLS ───────────────────────────────
-- Allow shared users to read project details (name, owner)
-- so shared songs show the correct project name.

CREATE POLICY "Shared song recipients can read parent project"
ON projects FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM songs s
    JOIN song_shares ss ON ss.song_id = s.id
    WHERE s.project_id = projects.id
    AND ss.user_id = auth.uid()
  )
);

CREATE POLICY "Project members can read project"
ON projects FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM project_members pm
    WHERE pm.project_id = projects.id
    AND pm.user_id = auth.uid()
  )
);

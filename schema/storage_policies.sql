-- ============================================================
-- RiffBank Storage Bucket Policies — Shared Audio Access
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================
-- Audio files are stored at: {ownerUserId}/{songId}/{versionId}/audio
-- By default only the owner can download. These policies grant
-- download access to users the song/project has been shared with.
-- ============================================================

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

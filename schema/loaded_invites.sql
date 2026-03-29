-- ============================================================
-- RiffBank Loaded Invites Schema
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- 1. Table — bundled invite with multiple projects/songs
CREATE TABLE IF NOT EXISTS loaded_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token       text UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  from_user   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'viewer' CHECK (role IN ('collaborator', 'viewer')),
  -- Bundled items
  project_ids uuid[] NOT NULL DEFAULT '{}',
  song_ids    uuid[] NOT NULL DEFAULT '{}',
  -- State
  claimed     boolean NOT NULL DEFAULT false,
  claimed_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  claimed_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz DEFAULT (now() + interval '30 days'),
  -- At least one item must be included
  CONSTRAINT loaded_invite_has_items CHECK (
    array_length(project_ids, 1) > 0 OR array_length(song_ids, 1) > 0
  )
);

CREATE INDEX IF NOT EXISTS idx_loaded_invites_token ON loaded_invites(token);
CREATE INDEX IF NOT EXISTS idx_loaded_invites_from  ON loaded_invites(from_user);

ALTER TABLE loaded_invites ENABLE ROW LEVEL SECURITY;

-- ── RLS policies ──

-- Creator can view and manage own invites
CREATE POLICY "Users can view own loaded invites"
  ON loaded_invites FOR SELECT
  USING (auth.uid() = from_user);

-- Anyone can read by token (for preview page — no auth needed via RPC)
CREATE POLICY "Anyone can read loaded invite by token"
  ON loaded_invites FOR SELECT
  USING (true);

CREATE POLICY "Users can create loaded invites"
  ON loaded_invites FOR INSERT
  WITH CHECK (auth.uid() = from_user);

CREATE POLICY "Users can update own loaded invites"
  ON loaded_invites FOR UPDATE
  USING (auth.uid() = from_user);

CREATE POLICY "Authenticated users can claim loaded invites"
  ON loaded_invites FOR UPDATE
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (claimed = true AND claimed_by = auth.uid());

CREATE POLICY "Users can delete own loaded invites"
  ON loaded_invites FOR DELETE
  USING (auth.uid() = from_user);

-- ============================================================
-- RPC: get_loaded_invite_preview (no auth required)
-- Returns sender profile + item details for the preview page
-- ============================================================
CREATE OR REPLACE FUNCTION get_loaded_invite_preview(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_invite loaded_invites%ROWTYPE;
  v_sender jsonb;
  v_projects jsonb;
  v_songs jsonb;
BEGIN
  -- Fetch invite
  SELECT * INTO v_invite FROM loaded_invites WHERE token = p_token;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  -- Check states
  IF v_invite.claimed THEN
    RETURN jsonb_build_object('error', 'already_claimed');
  END IF;
  IF v_invite.expires_at IS NOT NULL AND v_invite.expires_at < now() THEN
    RETURN jsonb_build_object('error', 'expired');
  END IF;

  -- Sender profile
  SELECT jsonb_build_object(
    'display_name', COALESCE(p.display_name, split_part(u.email, '@', 1)),
    'avatar_url', p.avatar_url
  ) INTO v_sender
  FROM auth.users u
  LEFT JOIN profiles p ON p.id = u.id
  WHERE u.id = v_invite.from_user;

  -- Projects with song counts
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', pr.id,
    'name', pr.name,
    'song_count', (SELECT count(*) FROM songs s WHERE s.project_id = pr.id)
  )), '[]'::jsonb) INTO v_projects
  FROM projects pr
  WHERE pr.id = ANY(v_invite.project_ids);

  -- Individual songs with cover info
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'title', s.title,
    'project_name', COALESCE(pr.name, ''),
    'cover_path', s.cover_path,
    'cover_source', s.cover_source
  )), '[]'::jsonb) INTO v_songs
  FROM songs s
  LEFT JOIN projects pr ON pr.id = s.project_id
  WHERE s.id = ANY(v_invite.song_ids);

  RETURN jsonb_build_object(
    'token', v_invite.token,
    'role', v_invite.role,
    'expires_at', v_invite.expires_at,
    'created_at', v_invite.created_at,
    'sender', v_sender,
    'projects', v_projects,
    'songs', v_songs
  );
END;
$$;

-- ============================================================
-- RPC: claim_loaded_invite
-- Atomically: creates friendship, shares all items, marks claimed
-- ============================================================
CREATE OR REPLACE FUNCTION claim_loaded_invite(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_invite loaded_invites%ROWTYPE;
  v_user_id uuid := auth.uid();
  v_pid uuid;
  v_sid uuid;
  v_project_count int := 0;
  v_song_count int := 0;
  v_sender_name text;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_authenticated');
  END IF;

  -- Fetch and lock the invite
  SELECT * INTO v_invite FROM loaded_invites WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_invite.claimed THEN
    RETURN jsonb_build_object('error', 'already_claimed');
  END IF;
  IF v_invite.expires_at IS NOT NULL AND v_invite.expires_at < now() THEN
    RETURN jsonb_build_object('error', 'expired');
  END IF;
  IF v_invite.from_user = v_user_id THEN
    RETURN jsonb_build_object('error', 'self_claim');
  END IF;

  -- Create friendship (auto-accepted, upsert both directions)
  INSERT INTO friendships (requester_id, recipient_id, status, accepted_at)
  VALUES (v_invite.from_user, v_user_id, 'accepted', now())
  ON CONFLICT (requester_id, recipient_id)
  DO UPDATE SET status = 'accepted', accepted_at = COALESCE(friendships.accepted_at, now());

  -- Share projects
  IF v_invite.project_ids IS NOT NULL THEN
    FOREACH v_pid IN ARRAY v_invite.project_ids LOOP
      INSERT INTO project_members (project_id, user_id, role, invited_by)
      VALUES (v_pid, v_user_id, v_invite.role, v_invite.from_user)
      ON CONFLICT (project_id, user_id)
      DO UPDATE SET role = EXCLUDED.role;
      v_project_count := v_project_count + 1;
    END LOOP;
  END IF;

  -- Share individual songs
  IF v_invite.song_ids IS NOT NULL THEN
    FOREACH v_sid IN ARRAY v_invite.song_ids LOOP
      INSERT INTO song_shares (song_id, user_id, role, invited_by)
      VALUES (v_sid, v_user_id, v_invite.role, v_invite.from_user)
      ON CONFLICT (song_id, user_id)
      DO UPDATE SET role = EXCLUDED.role;
      v_song_count := v_song_count + 1;
    END LOOP;
  END IF;

  -- Mark invite as claimed
  UPDATE loaded_invites
  SET claimed = true, claimed_by = v_user_id, claimed_at = now()
  WHERE id = v_invite.id;

  -- Get sender name for the toast
  SELECT COALESCE(p.display_name, split_part(u.email, '@', 1))
  INTO v_sender_name
  FROM auth.users u
  LEFT JOIN profiles p ON p.id = u.id
  WHERE u.id = v_invite.from_user;

  RETURN jsonb_build_object(
    'success', true,
    'sender_name', v_sender_name,
    'project_count', v_project_count,
    'song_count', v_song_count,
    'role', v_invite.role
  );
END;
$$;

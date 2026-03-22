-- ============================================================
-- RiffBank Sharing & Collaboration Schema
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- 1. Share invites — tokens that link a sharer to a project/song + role
CREATE TABLE IF NOT EXISTS share_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token       text UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  from_user   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- What is being shared (one of these will be set)
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  song_id     uuid REFERENCES songs(id) ON DELETE CASCADE,
  -- Role granted on accept
  role        text NOT NULL DEFAULT 'viewer' CHECK (role IN ('collaborator', 'viewer')),
  -- State
  accepted    boolean NOT NULL DEFAULT false,
  accepted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz DEFAULT (now() + interval '30 days'),
  -- At least one target must be set
  CONSTRAINT share_target CHECK (project_id IS NOT NULL OR song_id IS NOT NULL)
);

-- 2. Project members — who has access to a project and at what level
CREATE TABLE IF NOT EXISTS project_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'viewer' CHECK (role IN ('collaborator', 'viewer')),
  invited_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, user_id)
);

-- 3. Song shares — individual song-level sharing (when not sharing whole project)
CREATE TABLE IF NOT EXISTS song_shares (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  song_id     uuid NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'viewer' CHECK (role IN ('collaborator', 'viewer')),
  invited_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(song_id, user_id)
);

-- 4. User profiles — display names for showing who shared what
-- (Only create if you don't already have a profiles table)
CREATE TABLE IF NOT EXISTS profiles (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  first_name    text,
  last_name     text,
  display_name  text,
  avatar_url    text,
  location      text,
  instrument    text,
  genre         text,
  bio           text,
  updated_at    timestamptz DEFAULT now()
);

-- ============================================================
-- Indexes for performance
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_project_members_user    ON project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_song_shares_user        ON song_shares(user_id);
CREATE INDEX IF NOT EXISTS idx_song_shares_song        ON song_shares(song_id);
CREATE INDEX IF NOT EXISTS idx_share_invites_token      ON share_invites(token);
CREATE INDEX IF NOT EXISTS idx_share_invites_from       ON share_invites(from_user);

-- ============================================================
-- Row Level Security (RLS)
-- ============================================================

-- Enable RLS on all new tables
ALTER TABLE share_invites  ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE song_shares     ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles        ENABLE ROW LEVEL SECURITY;

-- ── share_invites ──
-- Creator can see & manage their invites
CREATE POLICY "Users can view own invites"
  ON share_invites FOR SELECT
  USING (auth.uid() = from_user);

CREATE POLICY "Users can create invites for own projects/songs"
  ON share_invites FOR INSERT
  WITH CHECK (auth.uid() = from_user);

CREATE POLICY "Users can delete own invites"
  ON share_invites FOR DELETE
  USING (auth.uid() = from_user);

-- Anyone can read an invite by token (for accepting)
CREATE POLICY "Anyone can read invite by token"
  ON share_invites FOR SELECT
  USING (true);

-- Accepting: anyone authenticated can update (accept) an invite
CREATE POLICY "Authenticated users can accept invites"
  ON share_invites FOR UPDATE
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (accepted = true AND accepted_by = auth.uid());

-- ── project_members ──
-- Users can see memberships they're part of
CREATE POLICY "Users can view own memberships"
  ON project_members FOR SELECT
  USING (auth.uid() = user_id);

-- Project owners can see all members of their projects
CREATE POLICY "Owners can view project members"
  ON project_members FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM projects WHERE projects.id = project_members.project_id
      AND projects.owner_id = auth.uid()
    )
  );

-- Allow insert (from accept-invite flow via service or direct)
CREATE POLICY "Authenticated users can join projects"
  ON project_members FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Owners can remove members
CREATE POLICY "Owners can remove project members"
  ON project_members FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM projects WHERE projects.id = project_members.project_id
      AND projects.owner_id = auth.uid()
    )
  );

-- Members can leave
CREATE POLICY "Members can leave projects"
  ON project_members FOR DELETE
  USING (auth.uid() = user_id);

-- ── song_shares ──
CREATE POLICY "Users can view own song shares"
  ON song_shares FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Song owners can view shares"
  ON song_shares FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM songs s
      JOIN projects p ON s.project_id = p.id
      WHERE s.id = song_shares.song_id AND p.owner_id = auth.uid()
    )
  );

CREATE POLICY "Authenticated users can accept song shares"
  ON song_shares FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Song owners can remove shares"
  ON song_shares FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM songs s
      JOIN projects p ON s.project_id = p.id
      WHERE s.id = song_shares.song_id AND p.owner_id = auth.uid()
    )
  );

CREATE POLICY "Users can leave song shares"
  ON song_shares FOR DELETE
  USING (auth.uid() = user_id);

-- ── profiles ──
CREATE POLICY "Users can view all profiles"
  ON profiles FOR SELECT
  USING (true);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile"
  ON profiles FOR INSERT
  WITH CHECK (auth.uid() = id);

-- ============================================================
-- RLS policies for existing tables: allow shared access
-- ============================================================

-- Allow members to read projects shared with them
CREATE POLICY "Members can read shared projects"
  ON projects FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM project_members
      WHERE project_members.project_id = projects.id
      AND project_members.user_id = auth.uid()
    )
  );

-- Allow members to read songs in shared projects
CREATE POLICY "Members can read shared project songs"
  ON songs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM project_members
      WHERE project_members.project_id = songs.project_id
      AND project_members.user_id = auth.uid()
    )
  );

-- Allow direct song share recipients to read songs
CREATE POLICY "Users can read directly shared songs"
  ON songs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM song_shares
      WHERE song_shares.song_id = songs.id
      AND song_shares.user_id = auth.uid()
    )
  );

-- Allow collaborators to update songs in shared projects
CREATE POLICY "Collaborators can update shared project songs"
  ON songs FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM project_members
      WHERE project_members.project_id = songs.project_id
      AND project_members.user_id = auth.uid()
      AND project_members.role = 'collaborator'
    )
  );

-- Allow collaborators to insert songs into shared projects
CREATE POLICY "Collaborators can add songs to shared projects"
  ON songs FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM project_members
      WHERE project_members.project_id = songs.project_id
      AND project_members.user_id = auth.uid()
      AND project_members.role = 'collaborator'
    )
  );

-- Allow collaborators to read/write versions in shared songs
CREATE POLICY "Members can read shared song versions"
  ON versions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM songs s
      JOIN project_members pm ON pm.project_id = s.project_id
      WHERE s.id = versions.song_id AND pm.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM song_shares ss
      WHERE ss.song_id = versions.song_id AND ss.user_id = auth.uid()
    )
  );

CREATE POLICY "Collaborators can update shared song versions"
  ON versions FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM songs s
      JOIN project_members pm ON pm.project_id = s.project_id
      WHERE s.id = versions.song_id
      AND pm.user_id = auth.uid()
      AND pm.role = 'collaborator'
    )
  );

CREATE POLICY "Collaborators can add versions to shared songs"
  ON versions FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM songs s
      JOIN project_members pm ON pm.project_id = s.project_id
      WHERE s.id = versions.song_id
      AND pm.user_id = auth.uid()
      AND pm.role = 'collaborator'
    )
  );

-- ============================================================
-- Auto-create profile on signup (trigger)
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, updated_at)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)),
    now()
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop if exists to avoid duplicate trigger errors
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

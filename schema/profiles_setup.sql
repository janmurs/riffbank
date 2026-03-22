-- ============================================================
-- Profiles table setup
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor)
-- Safe to run multiple times — uses IF NOT EXISTS / IF EXISTS
-- ============================================================

-- Create profiles table if it doesn't exist
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

-- If table already exists but is missing new columns, add them
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='first_name') THEN
    ALTER TABLE profiles ADD COLUMN first_name text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='last_name') THEN
    ALTER TABLE profiles ADD COLUMN last_name text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='location') THEN
    ALTER TABLE profiles ADD COLUMN location text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='instrument') THEN
    ALTER TABLE profiles ADD COLUMN instrument text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='genre') THEN
    ALTER TABLE profiles ADD COLUMN genre text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='bio') THEN
    ALTER TABLE profiles ADD COLUMN bio text;
  END IF;
END $$;

-- Enable RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- RLS policies (drop first to avoid duplicates)
DROP POLICY IF EXISTS "Users can view all profiles" ON profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;

CREATE POLICY "Users can view all profiles"
  ON profiles FOR SELECT USING (true);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile"
  ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- Auto-create profile on signup
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

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Backfill: create profile rows for existing users who don't have one
INSERT INTO profiles (id, display_name, updated_at)
SELECT id, COALESCE(raw_user_meta_data->>'display_name', split_part(email, '@', 1)), now()
FROM auth.users
WHERE id NOT IN (SELECT id FROM profiles)
ON CONFLICT (id) DO NOTHING;

-- Messages table for DMs between users
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)

-- 1. Create the table
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (char_length(body) > 0 AND char_length(body) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);

-- 2. Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(sender_id, recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(recipient_id, read_at) WHERE read_at IS NULL;

-- 3. Enable RLS
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies

-- Users can read messages they sent or received
CREATE POLICY "Users can read own messages"
  ON messages FOR SELECT
  USING (auth.uid() = sender_id OR auth.uid() = recipient_id);

-- Users can send messages (insert where they are the sender)
CREATE POLICY "Users can send messages"
  ON messages FOR INSERT
  WITH CHECK (auth.uid() = sender_id);

-- Recipients can mark messages as read (update read_at only)
CREATE POLICY "Recipients can mark messages read"
  ON messages FOR UPDATE
  USING (auth.uid() = recipient_id)
  WITH CHECK (auth.uid() = recipient_id);

-- Users can delete their own sent messages
CREATE POLICY "Users can delete own sent messages"
  ON messages FOR DELETE
  USING (auth.uid() = sender_id);

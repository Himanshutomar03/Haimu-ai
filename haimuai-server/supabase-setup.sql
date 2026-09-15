-- ================================================================
-- HaimuAI — Supabase Database Setup
-- Run this SQL in your Supabase project: SQL Editor → New Query
-- ================================================================

-- Licenses table
CREATE TABLE IF NOT EXISTS licenses (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  key           TEXT UNIQUE NOT NULL,
  user_email    TEXT,
  user_name     TEXT,
  active        BOOLEAN DEFAULT true NOT NULL,
  plan          TEXT DEFAULT 'basic' NOT NULL,
  hwid          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  expires_at    TIMESTAMPTZ,
  last_seen     TIMESTAMPTZ,
  usage_count   INTEGER DEFAULT 0 NOT NULL,
  gemini_api_key TEXT  -- dedicated Gemini key for this license (required)
);

-- Add gemini_api_key to existing tables (safe to run on already-created DB)
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS gemini_api_key TEXT;

-- Index for fast key lookups
CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(key);
CREATE INDEX IF NOT EXISTS idx_licenses_active ON licenses(active);

-- Enable Row Level Security (RLS) — only service role can access
ALTER TABLE licenses ENABLE ROW LEVEL SECURITY;

-- Only the service role (your server) can read/write
-- No policy = no access for anon/authenticated roles
-- Your server uses SUPABASE_SERVICE_KEY which bypasses RLS

-- Helper function to increment usage count atomically
CREATE OR REPLACE FUNCTION increment(x integer)
RETURNS integer AS $$
  SELECT x + 1
$$ LANGUAGE sql IMMUTABLE;

-- View for admin stats (optional, for dashboard)
CREATE OR REPLACE VIEW license_stats AS
SELECT
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE active = true AND (expires_at IS NULL OR expires_at > NOW())) AS active_count,
  COUNT(*) FILTER (WHERE active = false) AS revoked_count,
  COUNT(*) FILTER (WHERE last_seen > NOW() - INTERVAL '24 hours') AS seen_24h,
  SUM(usage_count) AS total_requests
FROM licenses;

-- Atomic usage counter (called from server on every AI request)
CREATE OR REPLACE FUNCTION increment_usage(license_key TEXT)
RETURNS void AS $$
  UPDATE licenses
  SET usage_count = usage_count + 1,
      last_seen   = NOW()
  WHERE key = license_key;
$$ LANGUAGE sql;

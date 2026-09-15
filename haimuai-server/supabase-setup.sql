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
  usage_count   INTEGER DEFAULT 0 NOT NULL
);

-- ================================================================
-- Per-license Gemini API keys table
-- Each license can have MULTIPLE Gemini API keys (key pool per user)
-- ================================================================
CREATE TABLE IF NOT EXISTS license_api_keys (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  license_key TEXT NOT NULL REFERENCES licenses(key) ON DELETE CASCADE,
  api_key     TEXT NOT NULL,
  label       TEXT DEFAULT 'Key',   -- optional label e.g. "Primary", "Backup"
  active      BOOLEAN DEFAULT true NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_licenses_key       ON licenses(key);
CREATE INDEX IF NOT EXISTS idx_licenses_active    ON licenses(active);
CREATE INDEX IF NOT EXISTS idx_lic_api_keys_lic   ON license_api_keys(license_key);
CREATE INDEX IF NOT EXISTS idx_lic_api_keys_active ON license_api_keys(license_key, active);

-- Enable Row Level Security (RLS) — only service role can access
ALTER TABLE licenses         ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_api_keys ENABLE ROW LEVEL SECURITY;

-- Helper function to increment usage count atomically
CREATE OR REPLACE FUNCTION increment(x integer)
RETURNS integer AS $$
  SELECT x + 1
$$ LANGUAGE sql IMMUTABLE;

-- View for admin stats
CREATE OR REPLACE VIEW license_stats AS
SELECT
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE active = true AND (expires_at IS NULL OR expires_at > NOW())) AS active_count,
  COUNT(*) FILTER (WHERE active = false) AS revoked_count,
  COUNT(*) FILTER (WHERE last_seen > NOW() - INTERVAL '24 hours') AS seen_24h,
  SUM(usage_count) AS total_requests
FROM licenses;

-- Atomic usage counter
CREATE OR REPLACE FUNCTION increment_usage(license_key TEXT)
RETURNS void AS $$
  UPDATE licenses
  SET usage_count = usage_count + 1,
      last_seen   = NOW()
  WHERE key = license_key;
$$ LANGUAGE sql;

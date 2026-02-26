-- Migration: Rate limiting table for D1-based rate limiting
-- Issue: In-memory Map doesn't work in Cloudflare Workers (stateless)
-- Solution: Persist rate limit attempts in D1

CREATE TABLE IF NOT EXISTS rate_limit (
  email TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_rate_limit_email ON rate_limit(email);

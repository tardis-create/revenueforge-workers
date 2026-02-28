-- Rollback: Rate limiting table
DROP INDEX IF EXISTS idx_rate_limit_email;
DROP TABLE IF EXISTS rate_limit;

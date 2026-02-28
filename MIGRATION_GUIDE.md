# D1 Schema Migration System

RevenueForge uses a custom migration CLI to manage Cloudflare D1 database schema changes in a controlled, reversible way.

## Commands

```bash
# Show migration status (applied/pending)
node scripts/migrate.js status

# Apply all pending migrations
node scripts/migrate.js up

# Rollback the last applied migration
node scripts/migrate.js rollback

# Mark all existing migrations as applied (for pre-existing databases)
node scripts/migrate.js baseline

# Create a new timestamped migration file
node scripts/migrate.js create <name>
```

Or use npm scripts:
```bash
npm run migrate:status
npm run migrate:up
npm run migrate:rollback
```

## Remote D1 (Production)

Add `--remote` flag to target production:
```bash
node scripts/migrate.js status --remote
node scripts/migrate.js up --remote
```

## Migration Files

Migrations live in `/migrations/` with version-prefixed naming:

```
migrations/
  0000_schema_migrations.sql          # Tracking table (bootstrap)
  0001_rate_limit_table.sql           # Migration SQL
  0001_rate_limit_table.rollback.sql  # Rollback SQL
  0002_leads_crm_tables.sql
  ...
  20260228123456_add_invoices.sql     # Timestamp-named (created via CLI)
  20260228123456_add_invoices.rollback.sql
```

- **Numbered migrations** (0001_, 0002_, ...): Legacy/bootstrap order
- **Timestamp migrations** (YYYYMMDDHHMMSS_...): Created via `migrate.js create`

## Schema Version Tracking

The `schema_migrations` table in D1 tracks all applied migrations:

```sql
CREATE TABLE schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  checksum TEXT,
  rolled_back INTEGER NOT NULL DEFAULT 0
);
```

## Rollback

Each migration should have a companion `.rollback.sql` file. If it exists, rollback runs it. If not, the migration is only marked as rolled-back in the tracking table (schema changes are NOT reversed).

## Bootstrapping Existing Databases

If the D1 database already has tables (applied manually or via wrangler), use:
```bash
node scripts/migrate.js baseline
```
This marks all migration files as applied without re-running the SQL.

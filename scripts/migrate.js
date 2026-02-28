#!/usr/bin/env node
/**
 * RF-B14: D1 Schema Migration CLI
 *
 * Commands:
 *   node scripts/migrate.js status   - Show applied/pending migrations
 *   node scripts/migrate.js up       - Apply all pending migrations
 *   node scripts/migrate.js rollback - Rollback the last applied migration
 *   node scripts/migrate.js create <name> - Create a new timestamped migration file
 */

import { spawnSync } from 'child_process'
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const MIGRATIONS_DIR = join(ROOT, 'migrations')

const args = process.argv.slice(2)
const command = args[0]
const isRemote = args.includes('--remote')
const migrationName = args[1] && !args[1].startsWith('--') ? args[1] : null

function d1Execute(sql, label) {
  const envFlag = isRemote ? '--remote' : '--local'
  if (label) process.stdout.write(`  ${label}... `)
  const result = spawnSync('npx', ['wrangler', 'd1', 'execute', 'revenueforge-db', envFlag, '--command', sql], {
    cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8',
  })
  if (result.status !== 0) {
    if (label) console.log('FAIL')
    console.error('Error:', result.stderr || result.stdout)
    process.exit(1)
  }
  if (label) console.log('OK')
  return result.stdout
}

function d1ExecuteFile(filePath, label) {
  const envFlag = isRemote ? '--remote' : '--local'
  if (label) process.stdout.write(`  ${label}... `)
  const result = spawnSync('npx', ['wrangler', 'd1', 'execute', 'revenueforge-db', envFlag, '--file', filePath], {
    cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8',
  })
  if (result.status !== 0) {
    if (label) console.log('FAIL')
    console.error('Error:', result.stderr || result.stdout)
    process.exit(1)
  }
  if (label) console.log('OK')
  return result.stdout
}

function d1Query(sql) {
  const envFlag = isRemote ? '--remote' : '--local'
  const result = spawnSync('npx', ['wrangler', 'd1', 'execute', 'revenueforge-db', envFlag, '--command', sql, '--json'], {
    cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8',
  })
  if (result.status !== 0) return []
  try {
    const parsed = JSON.parse(result.stdout)
    return Array.isArray(parsed) && parsed[0]?.results ? parsed[0].results : []
  } catch { return [] }
}

function ensureMigrationsTable() {
  d1Execute(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL UNIQUE, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')), checksum TEXT, rolled_back INTEGER NOT NULL DEFAULT 0);",
    'Ensuring schema_migrations table'
  )
}

function getMigrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql') && !f.startsWith('.') && !f.includes('.rollback'))
    .sort()
    .map(filename => {
      const match = filename.match(/^(\d+)_(.+)\.sql$/)
      if (!match) return null
      return { filename, version: match[1], name: match[2], path: join(MIGRATIONS_DIR, filename) }
    }).filter(Boolean)
}

function getAppliedMigrations() {
  return d1Query('SELECT version, name, applied_at, rolled_back FROM schema_migrations ORDER BY version ASC')
}

function checksum(content) {
  const clean = content.replace(/\s+/g, ' ').trim()
  return String(clean.length)
}

function cmdStatus() {
  console.log('\n📊 Migration Status (' + (isRemote ? 'REMOTE' : 'LOCAL') + ' D1)\n')
  ensureMigrationsTable()
  const files = getMigrationFiles()
  const applied = getAppliedMigrations()
  const appliedVersions = new Set(applied.filter(r => !r.rolled_back).map(r => r.version))
  let pendingCount = 0
  for (const file of files) {
    const isApplied = appliedVersions.has(file.version)
    const record = applied.find(r => r.version === file.version)
    const status = isApplied ? '[applied]' : '[pending]'
    const date = record ? '  (' + record.applied_at + ')' : ''
    console.log('  ' + status + '  ' + file.filename + date)
    if (!isApplied) pendingCount++
  }
  console.log('\n  Total: ' + files.length + ' | Applied: ' + (files.length - pendingCount) + ' | Pending: ' + pendingCount + '\n')
}

function cmdUp() {
  console.log('\n🚀 Applying migrations (' + (isRemote ? 'REMOTE' : 'LOCAL') + ' D1)\n')
  ensureMigrationsTable()
  const files = getMigrationFiles()
  const applied = getAppliedMigrations()
  const appliedVersions = new Set(applied.filter(r => !r.rolled_back).map(r => r.version))
  const pending = files.filter(f => !appliedVersions.has(f.version))
  if (pending.length === 0) {
    console.log('  All migrations already applied. Nothing to do.\n')
    return
  }
  for (const migration of pending) {
    const sql = readFileSync(migration.path, 'utf8')
    const cs = checksum(sql)
    console.log('  Applying ' + migration.filename)
    d1ExecuteFile(migration.path, 'Running SQL')
    d1Execute(
      "INSERT OR REPLACE INTO schema_migrations (version, name, applied_at, checksum, rolled_back) VALUES ('" + migration.version + "', '" + migration.name.replace(/'/g, "''") + "', datetime('now'), '" + cs + "', 0);",
      'Recording version ' + migration.version
    )
    console.log('  Applied: ' + migration.filename + '\n')
  }
  console.log('  Done: Applied ' + pending.length + ' migration(s).\n')
}

function cmdRollback() {
  console.log('\n⏪ Rolling back last migration (' + (isRemote ? 'REMOTE' : 'LOCAL') + ' D1)\n')
  ensureMigrationsTable()
  const applied = getAppliedMigrations().filter(r => !r.rolled_back)
  if (applied.length === 0) {
    console.log('  No migrations to roll back.\n')
    return
  }
  const last = applied[applied.length - 1]
  const rollbackFile = join(MIGRATIONS_DIR, last.version + '_' + last.name + '.rollback.sql')
  if (existsSync(rollbackFile)) {
    console.log('  Found rollback file: ' + last.version + '_' + last.name + '.rollback.sql')
    d1ExecuteFile(rollbackFile, 'Running rollback SQL')
  } else {
    console.log('  WARNING: No rollback SQL file found for ' + last.version + '_' + last.name)
    console.log('  Expected: migrations/' + last.version + '_' + last.name + '.rollback.sql')
    console.log('  Marking as rolled back in tracking table only (schema NOT reversed).\n')
  }
  d1Execute("UPDATE schema_migrations SET rolled_back = 1 WHERE version = '" + last.version + "';", 'Updating status')
  console.log('\n  Rolled back: ' + last.version + '_' + last.name + '\n')
}

function cmdCreate(name) {
  if (!name) {
    console.error('  ERROR: Please provide a name: node scripts/migrate.js create <name>')
    process.exit(1)
  }
  const now = new Date()
  const ts = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '_')
  const filename = ts + '_' + safeName + '.sql'
  const rollbackFilename = ts + '_' + safeName + '.rollback.sql'
  const filePath = join(MIGRATIONS_DIR, filename)
  const rollbackPath = join(MIGRATIONS_DIR, rollbackFilename)
  writeFileSync(filePath, '-- Migration: ' + name + '\n-- Created: ' + now.toISOString() + '\n-- Version: ' + ts + '\n\n-- Write your forward migration SQL here\n')
  writeFileSync(rollbackPath, '-- Rollback: ' + name + '\n-- Reverses: ' + filename + '\n\n-- Write your rollback SQL here\n')
  console.log('\n  Created: ' + filename)
  console.log('  Created: ' + rollbackFilename + '\n')
}

const HELP = `
D1 Schema Migration CLI - RevenueForge

Commands:
  status          Show applied/pending migrations
  up              Apply all pending migrations
  rollback        Rollback the last applied migration
  baseline        Mark all existing migrations as applied (for pre-existing databases)
  create <name>   Create a new timestamped migration file

Flags:
  --remote        Target remote D1 (production)

Examples:
  node scripts/migrate.js status
  node scripts/migrate.js up
  node scripts/migrate.js up --remote
  node scripts/migrate.js rollback
  node scripts/migrate.js baseline
  node scripts/migrate.js create add_invoices_table
`

switch (command) {
  case 'status': cmdStatus(); break
  case 'up': cmdUp(); break
  case 'rollback': cmdRollback(); break
  case 'baseline': cmdBaseline(); break
  case 'create': cmdCreate(migrationName); break
  default: console.log(HELP); break
}

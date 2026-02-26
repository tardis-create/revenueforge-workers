-- Migration: Email Templates and Dealers Tables
-- RF-B06: Email Templates API
-- RF-B08: Dealers API

-- Email Templates Table
CREATE TABLE IF NOT EXISTS email_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT DEFAULT 'general',
  variables TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_templates_type ON email_templates(type);
CREATE INDEX IF NOT EXISTS idx_email_templates_is_active ON email_templates(is_active);

-- Dealers Table
CREATE TABLE IF NOT EXISTS dealers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  territory TEXT,
  commission_rate REAL DEFAULT 0,
  status TEXT DEFAULT 'active',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_dealers_status ON dealers(status);
CREATE INDEX IF NOT EXISTS idx_dealers_email ON dealers(email);
CREATE INDEX IF NOT EXISTS idx_dealers_deleted_at ON dealers(deleted_at);

-- Add dealer_id to leads table if not exists
-- SQLite doesn't support IF NOT EXISTS for columns, so we use a safe approach
ALTER TABLE leads ADD COLUMN dealer_id TEXT REFERENCES dealers(id);

-- Create index for dealer_id on leads
CREATE INDEX IF NOT EXISTS idx_leads_dealer_id ON leads(dealer_id);

-- Orders table for dealer stats (simplified - tracks orders attributed to dealers)
CREATE TABLE IF NOT EXISTS dealer_orders (
  id TEXT PRIMARY KEY,
  dealer_id TEXT NOT NULL,
  quote_id TEXT,
  lead_id TEXT,
  amount REAL DEFAULT 0,
  status TEXT DEFAULT 'pending',
  order_date TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (dealer_id) REFERENCES dealers(id) ON DELETE SET NULL,
  FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE SET NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_dealer_orders_dealer_id ON dealer_orders(dealer_id);
CREATE INDEX IF NOT EXISTS idx_dealer_orders_status ON dealer_orders(status);
CREATE INDEX IF NOT EXISTS idx_dealer_orders_order_date ON dealer_orders(order_date);

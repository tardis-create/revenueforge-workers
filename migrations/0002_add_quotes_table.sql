-- Migration: Add quotes table
-- Version: 0002
-- Creates table for quotation management

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  rfq_id TEXT,
  company_name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  validity_days INTEGER NOT NULL DEFAULT 30,
  valid_until TEXT NOT NULL,
  terms TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  pdf_url TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  accepted_at TEXT,
  rejected_at TEXT,
  FOREIGN KEY (rfq_id) REFERENCES leads(id)
);

CREATE TABLE IF NOT EXISTS quote_items (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL,
  product_id TEXT,
  description TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  total_price REAL NOT NULL DEFAULT 0,
  product_name TEXT,
  FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quotes_rfq_id ON quotes(rfq_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
CREATE INDEX IF NOT EXISTS idx_quote_items_quote_id ON quote_items(quote_id);

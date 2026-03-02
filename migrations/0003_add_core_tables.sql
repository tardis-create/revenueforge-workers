-- Migration: Add core tables (users, products, templates, dealers, commissions)
-- Version: 0003
-- Creates tables for user management, product catalog, email templates, dealer management, and commissions

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'dealer', 'admin')),
  phone TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- Products table
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  industry TEXT,
  price REAL NOT NULL DEFAULT 0,
  in_stock INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  image_url TEXT,
  technical_specs TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_is_active ON products(is_active);

-- Email templates table
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('rfq', 'invoice', 'quote', 'followup', 'welcome', 'notification')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_templates_slug ON templates(slug);
CREATE INDEX IF NOT EXISTS idx_templates_type ON templates(type);

-- Dealers table
CREATE TABLE IF NOT EXISTS dealers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  company_name TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  region TEXT,
  territory TEXT,
  commission_rate REAL NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dealers_email ON dealers(email);
CREATE INDEX IF NOT EXISTS idx_dealers_region ON dealers(region);
CREATE INDEX IF NOT EXISTS idx_dealers_is_active ON dealers(is_active);

-- Commissions table
CREATE TABLE IF NOT EXISTS commissions (
  id TEXT PRIMARY KEY,
  dealer_id TEXT NOT NULL,
  lead_id TEXT,
  rfq_id TEXT,
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'rejected')),
  notes TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (dealer_id) REFERENCES dealers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_commissions_dealer_id ON commissions(dealer_id);
CREATE INDEX IF NOT EXISTS idx_commissions_lead_id ON commissions(lead_id);
CREATE INDEX IF NOT EXISTS idx_commissions_status ON commissions(status);

-- Additional CRM tables used by the API

-- RFQ submissions table
CREATE TABLE IF NOT EXISTS rfq_submissions (
  id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  service_type TEXT,
  project_description TEXT,
  estimated_budget TEXT,
  timeline TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'quoted', 'won', 'lost')),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rfq_submissions_status ON rfq_submissions(status);
CREATE INDEX IF NOT EXISTS idx_rfq_submissions_email ON rfq_submissions(email);

-- Leads table
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost')),
  assigned_to TEXT,
  source TEXT,
  estimated_value REAL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_to ON leads(assigned_to);

-- Lead activities table
CREATE TABLE IF NOT EXISTS lead_activities (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('call', 'email', 'meeting', 'note', 'status_change')),
  description TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lead_activities_lead_id ON lead_activities(lead_id);

-- Follow-ups table
CREATE TABLE IF NOT EXISTS follow_ups (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  notes TEXT,
  completed INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_follow_ups_lead_id ON follow_ups(lead_id);
CREATE INDEX IF NOT EXISTS idx_follow_ups_scheduled_at ON follow_ups(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_follow_ups_completed ON follow_ups(completed);

-- Settings table (white-label configuration)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  type TEXT NOT NULL DEFAULT 'string' CHECK (type IN ('string', 'number', 'boolean', 'json')),
  category TEXT NOT NULL DEFAULT 'general',
  description TEXT,
  is_editable INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_settings_category ON settings(category);

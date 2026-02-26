-- Initial schema for RevenueForge API

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  role TEXT DEFAULT 'user',
  phone TEXT,
  is_active INTEGER DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Products table
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  base_price REAL DEFAULT 0,
  cost_price REAL,
  unit TEXT DEFAULT 'pcs',
  stock_quantity INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  specifications TEXT,
  image_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- RFQ Submissions table
CREATE TABLE IF NOT EXISTS rfq_submissions (
  id TEXT PRIMARY KEY,
  company_name TEXT,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  service_type TEXT,
  project_description TEXT,
  estimated_budget TEXT,
  timeline TEXT,
  status TEXT DEFAULT 'new',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Leads table
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  company_name TEXT,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  status TEXT DEFAULT 'new',
  assigned_to TEXT,
  source TEXT,
  estimated_value REAL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Lead Activities table
CREATE TABLE IF NOT EXISTS lead_activities (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  type TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);

-- Follow-ups table
CREATE TABLE IF NOT EXISTS follow_ups (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  notes TEXT,
  completed INTEGER DEFAULT 0,
  completed_at TEXT,
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);

-- Settings table (for white-label configuration)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  type TEXT DEFAULT 'string',
  category TEXT DEFAULT 'general',
  description TEXT,
  is_editable INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Insert default settings
INSERT OR IGNORE INTO settings (key, value, type, category, description, is_editable, created_at, updated_at) VALUES
  ('site_name', 'RevenueForge', 'string', 'branding', 'Site name displayed in header and title', 1, datetime('now'), datetime('now')),
  ('site_tagline', 'B2B Service Marketplace', 'string', 'branding', 'Site tagline/subtitle', 1, datetime('now'), datetime('now')),
  ('logo_url', '/logo.svg', 'string', 'branding', 'URL to site logo', 1, datetime('now'), datetime('now')),
  ('primary_color', '#3B82F6', 'string', 'branding', 'Primary brand color (hex)', 1, datetime('now'), datetime('now')),
  ('contact_email', 'contact@revenueforge.com', 'string', 'contact', 'Primary contact email', 1, datetime('now'), datetime('now')),
  ('contact_phone', '', 'string', 'contact', 'Primary contact phone', 1, datetime('now'), datetime('now')),
  ('social_linkedin', '', 'string', 'social', 'LinkedIn URL', 1, datetime('now'), datetime('now')),
  ('social_twitter', '', 'string', 'social', 'Twitter/X URL', 1, datetime('now'), datetime('now')),
  ('social_facebook', '', 'string', 'social', 'Facebook URL', 1, datetime('now'), datetime('now')),
  ('maintenance_mode', 'false', 'boolean', 'system', 'Enable maintenance mode', 1, datetime('now'), datetime('now')),
  ('default_currency', 'USD', 'string', 'system', 'Default currency code', 1, datetime('now'), datetime('now')),
  ('timezone', 'UTC', 'string', 'system', 'Default timezone', 1, datetime('now'), datetime('now')),
  ('rfq_auto_email', 'true', 'boolean', 'features', 'Send automatic RFQ confirmation emails', 1, datetime('now'), datetime('now')),
  ('lead_notifications', 'true', 'boolean', 'features', 'Send new lead notifications', 1, datetime('now'), datetime('now'));

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_settings_category ON settings(category);

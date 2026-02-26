-- Migration: Leads/CRM Pipeline Management
-- RF-B03: Complete leads, activities, and follow-ups tables with soft-delete support

-- Leads table
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  company_name TEXT,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  status TEXT DEFAULT 'new',
  assigned_to TEXT,
  dealer_id TEXT,
  source TEXT,
  estimated_value REAL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_to ON leads(assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_dealer_id ON leads(dealer_id);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);
CREATE INDEX IF NOT EXISTS idx_leads_deleted_at ON leads(deleted_at);

-- Lead activities table
CREATE TABLE IF NOT EXISTS lead_activities (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lead_activities_lead_id ON lead_activities(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_activities_created_at ON lead_activities(created_at);

-- Follow-ups table
CREATE TABLE IF NOT EXISTS follow_ups (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  notes TEXT,
  completed INTEGER DEFAULT 0,
  completed_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_follow_ups_lead_id ON follow_ups(lead_id);
CREATE INDEX IF NOT EXISTS idx_follow_ups_scheduled_at ON follow_ups(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_follow_ups_completed ON follow_ups(completed);

-- RFQ submissions table
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
  lead_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_rfq_submissions_status ON rfq_submissions(status);
CREATE INDEX IF NOT EXISTS idx_rfq_submissions_created_at ON rfq_submissions(created_at);
CREATE INDEX IF NOT EXISTS idx_rfq_submissions_lead_id ON rfq_submissions(lead_id);

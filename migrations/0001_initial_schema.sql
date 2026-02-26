-- Migration: RF-B14 - Initial Schema Setup
-- Created: 2026-02-26
-- Description: Creates all core tables for RevenueForge CRM

-- ============================================
-- USERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'manager', 'sales', 'user')),
    phone TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    last_login_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index on email for fast lookup
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ============================================
-- DEALERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS dealers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT UNIQUE,
    contact_person TEXT,
    email TEXT,
    phone TEXT,
    address TEXT,
    city TEXT,
    state TEXT,
    zip_code TEXT,
    country TEXT DEFAULT 'India',
    commission_rate REAL DEFAULT 0.00,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- PRODUCTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    sku TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    category TEXT,
    base_price REAL NOT NULL DEFAULT 0.00,
    cost_price REAL DEFAULT 0.00,
    unit TEXT DEFAULT 'pcs',
    stock_quantity INTEGER DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    specifications TEXT, -- JSON string for flexible specs
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index on category for filtering
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);

-- ============================================
-- TEMPLATES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('email', 'whatsapp', 'quote', 'rfq', 'contract')),
    subject TEXT,
    content TEXT NOT NULL,
    variables TEXT, -- JSON array of variable names
    is_default INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_by TEXT REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index on type for filtering
CREATE INDEX IF NOT EXISTS idx_templates_type ON templates(type);

-- ============================================
-- LEADS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL, -- website, referral, cold_call, etc.
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'archived')),
    priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    
    -- Contact Information
    company_name TEXT,
    contact_name TEXT NOT NULL,
    contact_email TEXT,
    contact_phone TEXT,
    contact_whatsapp TEXT,
    
    -- Address
    address TEXT,
    city TEXT,
    state TEXT,
    zip_code TEXT,
    country TEXT DEFAULT 'India',
    
    -- Assignment
    assigned_to TEXT REFERENCES users(id),
    dealer_id TEXT REFERENCES dealers(id),
    
    -- Metadata
    notes TEXT,
    estimated_value REAL,
    expected_close_date DATE,
    
    -- Timestamps
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes on leads
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_dealer_id ON leads(dealer_id);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_to ON leads(assigned_to);

-- ============================================
-- LEAD_ACTIVITIES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS lead_activities (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    activity_type TEXT NOT NULL CHECK (activity_type IN ('note', 'call', 'email', 'meeting', 'whatsapp', 'status_change', 'assigned', 'quote_sent', 'rfq_received')),
    description TEXT NOT NULL,
    performed_by TEXT REFERENCES users(id),
    metadata TEXT, -- JSON for additional data
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes on lead_activities
CREATE INDEX IF NOT EXISTS idx_lead_activities_lead_id ON lead_activities(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_activities_created_at ON lead_activities(created_at);

-- ============================================
-- RFQS TABLE (Request for Quotation)
-- ============================================
CREATE TABLE IF NOT EXISTS rfqs (
    id TEXT PRIMARY KEY,
    rfq_number TEXT NOT NULL UNIQUE,
    lead_id TEXT REFERENCES leads(id),
    dealer_id TEXT REFERENCES dealers(id),
    
    -- Status
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'received', 'under_review', 'quoted', 'expired', 'cancelled')),
    
    -- Request Details
    requested_by TEXT,
    request_date DATE NOT NULL DEFAULT CURRENT_DATE,
    expiry_date DATE,
    
    -- Technical Requirements
    delivery_location TEXT,
    delivery_timeline TEXT,
    payment_terms TEXT,
    special_requirements TEXT,
    
    -- Totals
    total_items INTEGER DEFAULT 0,
    estimated_total REAL DEFAULT 0.00,
    
    -- Documents
    attachment_url TEXT,
    
    -- Metadata
    notes TEXT,
    created_by TEXT REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes on RFQs
CREATE INDEX IF NOT EXISTS idx_rfqs_status ON rfqs(status);
CREATE INDEX IF NOT EXISTS idx_rfqs_lead_id ON rfqs(lead_id);
CREATE INDEX IF NOT EXISTS idx_rfqs_created_at ON rfqs(created_at);

-- ============================================
-- RFQ_ITEMS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS rfq_items (
    id TEXT PRIMARY KEY,
    rfq_id TEXT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
    product_id TEXT REFERENCES products(id),
    
    -- Item Details
    description TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 1,
    unit TEXT DEFAULT 'pcs',
    
    -- Specifications requested
    specifications TEXT, -- JSON for custom specs
    
    -- Notes
    notes TEXT,
    
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rfq_items_rfq_id ON rfq_items(rfq_id);

-- ============================================
-- QUOTES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS quotes (
    id TEXT PRIMARY KEY,
    quote_number TEXT NOT NULL UNIQUE,
    lead_id TEXT REFERENCES leads(id),
    rfq_id TEXT REFERENCES rfqs(id),
    dealer_id TEXT REFERENCES dealers(id),
    
    -- Status
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired', 'revised')),
    
    -- Validity
    issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
    valid_until DATE,
    
    -- Financial Summary
    subtotal REAL NOT NULL DEFAULT 0.00,
    discount_amount REAL DEFAULT 0.00,
    discount_percent REAL DEFAULT 0.00,
    tax_amount REAL DEFAULT 0.00,
    tax_percent REAL DEFAULT 18.00, -- GST default
    shipping_amount REAL DEFAULT 0.00,
    total_amount REAL NOT NULL DEFAULT 0.00,
    
    -- Terms
    payment_terms TEXT DEFAULT 'Net 30',
    delivery_terms TEXT,
    warranty_terms TEXT,
    
    -- Documents
    attachment_url TEXT,
    
    -- Metadata
    notes TEXT,
    internal_notes TEXT,
    created_by TEXT REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes on quotes
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
CREATE INDEX IF NOT EXISTS idx_quotes_lead_id ON quotes(lead_id);
CREATE INDEX IF NOT EXISTS idx_quotes_created_at ON quotes(created_at);

-- ============================================
-- QUOTE_ITEMS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS quote_items (
    id TEXT PRIMARY KEY,
    quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    product_id TEXT REFERENCES products(id),
    
    -- Item Details
    description TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 1,
    unit TEXT DEFAULT 'pcs',
    
    -- Pricing
    unit_price REAL NOT NULL DEFAULT 0.00,
    discount_percent REAL DEFAULT 0.00,
    line_total REAL NOT NULL DEFAULT 0.00,
    
    -- Specifications
    specifications TEXT, -- JSON for line item specs
    
    -- Notes
    notes TEXT,
    
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_quote_items_quote_id ON quote_items(quote_id);

-- ============================================
-- COMMISSIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS commissions (
    id TEXT PRIMARY KEY,
    dealer_id TEXT NOT NULL REFERENCES dealers(id),
    quote_id TEXT REFERENCES quotes(id),
    lead_id TEXT REFERENCES leads(id),
    
    -- Commission Details
    commission_type TEXT NOT NULL DEFAULT 'percentage' CHECK (commission_type IN ('percentage', 'fixed', 'tiered')),
    commission_rate REAL NOT NULL,
    commission_amount REAL NOT NULL,
    
    -- Sale Details
    sale_amount REAL NOT NULL,
    sale_date DATE NOT NULL,
    
    -- Status
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'disputed', 'cancelled')),
    
    -- Payment
    paid_at DATETIME,
    paid_by TEXT REFERENCES users(id),
    payment_reference TEXT,
    
    -- Notes
    notes TEXT,
    
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_commissions_dealer_id ON commissions(dealer_id);
CREATE INDEX IF NOT EXISTS idx_commissions_status ON commissions(status);
CREATE INDEX IF NOT EXISTS idx_commissions_created_at ON commissions(created_at);

-- ============================================
-- NOTIFICATIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    
    -- Notification Content
    type TEXT NOT NULL CHECK (type IN ('lead_assigned', 'quote_accepted', 'rfq_received', 'commission_paid', 'system', 'reminder')),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    
    -- Related Entity
    entity_type TEXT, -- lead, quote, rfq, commission
    entity_id TEXT,
    
    -- Status
    is_read INTEGER NOT NULL DEFAULT 0,
    read_at DATETIME,
    
    -- Channels
    sent_email INTEGER DEFAULT 0,
    sent_whatsapp INTEGER DEFAULT 0,
    sent_push INTEGER DEFAULT 0,
    
    -- Metadata
    action_url TEXT,
    metadata TEXT, -- JSON for extra data
    
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);

-- ============================================
-- AUDIT_LOG TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    
    -- Action Details
    action TEXT NOT NULL, -- CREATE, UPDATE, DELETE, LOGIN, LOGOUT, etc.
    entity_type TEXT NOT NULL, -- table name or entity type
    entity_id TEXT,
    
    -- Who performed the action
    user_id TEXT REFERENCES users(id),
    user_email TEXT,
    ip_address TEXT,
    user_agent TEXT,
    
    -- Change Tracking
    old_values TEXT, -- JSON
    new_values TEXT, -- JSON
    
    -- Metadata
    description TEXT,
    
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);

-- ============================================
-- SETTINGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS settings (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    type TEXT DEFAULT 'string' CHECK (type IN ('string', 'number', 'boolean', 'json')),
    category TEXT DEFAULT 'general',
    description TEXT,
    is_editable INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- SEED DATA
-- ============================================

-- Admin User (password: admin123 - change in production!)
-- Password hash is a placeholder - use proper bcrypt hash in production
INSERT INTO users (id, email, password_hash, first_name, last_name, role, is_active) VALUES
('usr_admin_001', 'admin@revenueforge.com', '$2a$10$YourHashedPasswordHere', 'System', 'Administrator', 'admin', 1);

-- Sample Products (8 products)
INSERT INTO products (id, sku, name, description, category, base_price, cost_price, unit, stock_quantity, is_active) VALUES
('prod_001', 'SS-SINK-001', 'Stainless Steel Kitchen Sink - Single Bowl', 'Premium grade 304 stainless steel single bowl kitchen sink with satin finish', 'Kitchen Sinks', 8500.00, 5100.00, 'pcs', 50, 1),
('prod_002', 'SS-SINK-002', 'Stainless Steel Kitchen Sink - Double Bowl', 'Premium grade 304 stainless steel double bowl kitchen sink with drainboard', 'Kitchen Sinks', 12500.00, 7500.00, 'pcs', 35, 1),
('prod_003', 'SS-TAP-001', 'Pull-Out Kitchen Faucet', 'Modern pull-out spray kitchen faucet with ceramic disc cartridge', 'Faucets', 4200.00, 2520.00, 'pcs', 100, 1),
('prod_004', 'SS-TAP-002', 'Sensor Touchless Faucet', 'Automatic sensor faucet for commercial and residential use', 'Faucets', 8500.00, 5100.00, 'pcs', 25, 1),
('prod_005', 'SS-DRAIN-001', 'Floor Drain with Cockroach Trap', 'Stainless steel floor drain with Jali and cockroach trap mechanism', 'Drainage', 1200.00, 720.00, 'pcs', 200, 1),
('prod_006', 'SS-DRAIN-002', 'Shower Drain Linear', 'Linear shower drain with hair catcher and removable grate', 'Drainage', 3500.00, 2100.00, 'pcs', 75, 1),
('prod_007', 'SS-BASIN-001', 'Countertop Wash Basin', 'Elegant oval countertop wash basin with overflow', 'Basins', 6500.00, 3900.00, 'pcs', 40, 1),
('prod_008', 'SS-BASIN-002', 'Wall Hung Basin', 'Compact wall hung wash basin for small bathrooms', 'Basins', 3800.00, 2280.00, 'pcs', 60, 1);

-- Sample Templates
INSERT INTO templates (id, name, type, subject, content, variables, is_default, is_active, created_by) VALUES
('tmpl_email_001', 'Welcome Email', 'email', 'Welcome to RevenueForge!', 
'Hello {{contact_name}},

Thank you for your interest in our products. We are excited to work with you.

Best regards,
RevenueForge Team',
'["contact_name"]', 1, 1, 'usr_admin_001'),

('tmpl_email_002', 'Quote Follow-up', 'email', 'Following up on your quotation {{quote_number}}',
'Dear {{contact_name}},

I hope this email finds you well. I wanted to follow up on the quotation {{quote_number}} we sent on {{issue_date}}.

Please let me know if you have any questions.

Best regards',
'["contact_name", "quote_number", "issue_date"]', 1, 1, 'usr_admin_001'),

('tmpl_wa_001', 'New Lead WhatsApp', 'whatsapp', NULL,
'Hi {{contact_name}}, thank you for reaching out to us! We have received your inquiry and will get back to you shortly. - RevenueForge',
'["contact_name"]', 1, 1, 'usr_admin_001'),

('tmpl_quote_001', 'Standard Quote Template', 'quote', 'Quotation {{quote_number}}',
'Please find attached our quotation {{quote_number}} valid until {{valid_until}}.

Total Amount: ₹{{total_amount}}

We look forward to your business!',
'["quote_number", "valid_until", "total_amount"]', 1, 1, 'usr_admin_001');

-- Default Settings
INSERT INTO settings (id, key, value, type, category, description) VALUES
('set_001', 'company_name', 'RevenueForge', 'string', 'company', 'Company name displayed in documents'),
('set_002', 'company_address', 'Mumbai, India', 'string', 'company', 'Company address'),
('set_003', 'company_phone', '+91-XXXXXXXXXX', 'string', 'company', 'Company phone number'),
('set_004', 'company_email', 'info@revenueforge.com', 'string', 'company', 'Company email address'),
('set_005', 'default_currency', 'INR', 'string', 'finance', 'Default currency code'),
('set_006', 'default_tax_percent', '18', 'number', 'finance', 'Default tax percentage (GST)'),
('set_007', 'quote_validity_days', '30', 'number', 'sales', 'Number of days quotes remain valid'),
('set_008', 'email_notifications_enabled', 'true', 'boolean', 'notifications', 'Enable email notifications'),
('set_009', 'whatsapp_notifications_enabled', 'true', 'boolean', 'notifications', 'Enable WhatsApp notifications');

-- Seed Data for RevenueForge
-- Migration 0005: Initial seed data for development and testing

-- Insert admin users (password: admin123)
-- Password hash generated with bcryptjs for: admin123
INSERT OR IGNORE INTO users (id, email, password_hash, first_name, last_name, role, is_active, created_at, updated_at)
VALUES 
  ('usr_admin_001', 'admin@revenueforge.local', '$2b$10$PNLOJssQkpK0SNkBVMXmsuafMvHNmjuIG2FjpAAxgXC.O7kQxveRa', 'System', 'Admin', 'admin', 1, datetime('now'), datetime('now')),
  ('usr_dealer_001', 'dealer@revenueforge.local', '$2b$10$PNLOJssQkpK0SNkBVMXmsuafMvHNmjuIG2FjpAAxgXC.O7kQxveRa', 'Demo', 'Dealer', 'dealer', 1, datetime('now'), datetime('now')),
  ('usr_viewer_001', 'viewer@revenueforge.local', '$2b$10$PNLOJssQkpK0SNkBVMXmsuafMvHNmjuIG2FjpAAxgXC.O7kQxveRa', 'Demo', 'Viewer', 'viewer', 1, datetime('now'), datetime('now'));

-- Insert sample RFQ submissions
INSERT OR IGNORE INTO rfq_submissions (id, company_name, contact_name, email, phone, service_type, project_description, estimated_budget, timeline, status, created_at, updated_at)
VALUES 
  ('rfq_001', 'Acme Manufacturing', 'John Smith', 'john.smith@acme.com', '+1-555-0101', 'Equipment Supply', 'Need industrial sensors for new production line', '$50,000 - $100,000', '3 months', 'reviewing', datetime('now', '-7 days'), datetime('now', '-7 days')),
  ('rfq_002', 'TechCorp Industries', 'Sarah Johnson', 'sarah.j@techcorp.com', '+1-555-0102', 'System Integration', 'Looking for complete automation solution for warehouse', '$200,000 - $500,000', '6 months', 'new', datetime('now', '-3 days'), datetime('now', '-3 days')),
  ('rfq_003', 'Global Dynamics LLC', 'Mike Chen', 'mike.chen@globald.com', '+1-555-0103', 'Maintenance Services', 'Annual maintenance contract for existing equipment', '$20,000 - $30,000', 'Ongoing', 'quoted', datetime('now', '-14 days'), datetime('now', '-10 days'));

-- Insert sample quotes
INSERT OR IGNORE INTO quotes (id, quote_number, rfq_id, lead_id, company_name, contact_name, email, phone, status, valid_until, notes, terms, subtotal, discount, tax, total, created_at, updated_at)
VALUES 
  ('quote_001', 'QT-2026-001', 'rfq_003', NULL, 'Global Dynamics LLC', 'Mike Chen', 'mike.chen@globald.com', '+1-555-0103', 'sent', datetime('now', '+30 days'), 'Annual maintenance package', 'Net 30', 25000.00, 0, 2250.00, 27250.00, datetime('now', '-10 days'), datetime('now', '-10 days')),
  ('quote_002', 'QT-2026-002', NULL, NULL, 'Acme Manufacturing', 'John Smith', 'john.smith@acme.com', '+1-555-0101', 'draft', datetime('now', '+30 days'), 'Initial quote for sensors', 'Net 30', 75000.00, 5000.00, 6300.00, 76300.00, datetime('now', '-2 days'), datetime('now', '-2 days'));

-- Insert sample quote items
INSERT OR IGNORE INTO quote_items (id, quote_id, description, quantity, unit_price, discount, total, sort_order, created_at)
VALUES 
  ('item_001', 'quote_001', 'Annual Maintenance - Basic Package', 1, 12000.00, 0, 12000.00, 1, datetime('now', '-10 days')),
  ('item_002', 'quote_001', 'Emergency Support (24/7)', 1, 8000.00, 0, 8000.00, 2, datetime('now', '-10 days')),
  ('item_003', 'quote_001', 'Parts Replacement Coverage', 1, 5000.00, 0, 5000.00, 3, datetime('now', '-10 days')),
  ('item_004', 'quote_002', 'Industrial Sensor Pro (ISP-001)', 50, 650.00, 0, 32500.00, 1, datetime('now', '-2 days')),
  ('item_005', 'quote_002', 'Smart Valve Controller (SVC-002)', 20, 1500.00, 0, 30000.00, 2, datetime('now', '-2 days')),
  ('item_006', 'quote_002', 'Installation Services', 1, 7500.00, 0, 7500.00, 3, datetime('now', '-2 days'));

-- Insert sample dealers
INSERT OR IGNORE INTO dealers (id, name, email, phone, company, territory, commission_rate, status, notes, created_at, updated_at)
VALUES 
  ('dealer_001', 'Robert Wilson', 'robert.wilson@partner.com', '+1-555-0201', 'Wilson Industrial Solutions', 'Northeast US', 0.15, 'active', 'Top performing dealer in Northeast region', datetime('now', '-90 days'), datetime('now', '-90 days')),
  ('dealer_002', 'Jennifer Lee', 'jennifer.lee@partner.com', '+1-555-0202', 'Lee Automation Partners', 'West Coast', 0.12, 'active', 'Specializes in manufacturing sector', datetime('now', '-60 days'), datetime('now', '-60 days')),
  ('dealer_003', 'David Brown', 'david.brown@partner.com', '+1-555-0203', 'Brown & Associates', 'Southeast US', 0.10, 'active', 'New dealer, started Q1 2026', datetime('now', '-30 days'), datetime('now', '-30 days'));

-- Insert sample email templates
INSERT OR IGNORE INTO email_templates (id, name, subject, body, type, variables, is_active, created_at, updated_at)
VALUES 
  ('tpl_001', 'Quote Created', 'Your Quote from RevenueForge', 'Dear {customer_name},\n\nThank you for your interest in our products. Please find attached your quote #{quote_number}.\n\nValid until: {valid_until}\nTotal: {total}\n\nIf you have any questions, please don''t hesitate to contact us.\n\nBest regards,\nRevenueForge Team', 'quote', '["customer_name", "quote_number", "valid_until", "total"]', 1, datetime('now'), datetime('now')),
  ('tpl_002', 'RFQ Received', 'We Received Your Request', 'Dear {contact_name},\n\nThank you for submitting your request for quote. Our team will review your requirements and get back to you within 24-48 hours.\n\nReference: {rfq_id}\n\nBest regards,\nRevenueForge Team', 'rfq', '["contact_name", "rfq_id"]', 1, datetime('now'), datetime('now')),
  ('tpl_003', 'Lead Assigned', 'New Lead Assigned', 'Dear {dealer_name},\n\nA new lead has been assigned to you:\n\nCompany: {company_name}\nContact: {contact_name}\nEmail: {email}\nPhone: {phone}\n\nPlease follow up within 24 hours.\n\nBest regards,\nRevenueForge Team', 'lead', '["dealer_name", "company_name", "contact_name", "email", "phone"]', 1, datetime('now'), datetime('now'));

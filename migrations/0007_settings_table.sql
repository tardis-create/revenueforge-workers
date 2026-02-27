-- Migration: RF-B13 - Settings Table Seeding (API Required Fields)
-- Created: 2026-02-27
-- Description: Seed settings table with branding fields required by the /api/settings endpoint
-- Note: The settings table already exists with key as PRIMARY KEY (no id column)

-- ============================================
-- BRANDING FIELDS REQUIRED BY API
-- (BRANDING_FIELDS array in index.ts)
-- ============================================

-- Company/Branding Settings
INSERT OR IGNORE INTO settings (key, value, type, category, description, is_editable, created_at, updated_at) VALUES
('company_name', 'RevenueForge', 'string', 'branding', 'Company name displayed in UI and documents', 1, datetime('now'), datetime('now')),
('company_address', 'Mumbai, India', 'string', 'branding', 'Company address for documents', 1, datetime('now'), datetime('now')),
('company_phone', '+91-22-12345678', 'string', 'branding', 'Company phone number', 1, datetime('now'), datetime('now')),
('company_email', 'info@revenueforge.com', 'string', 'branding', 'Company email address', 1, datetime('now'), datetime('now')),
('logo_url', '/logo.svg', 'string', 'branding', 'Company logo URL for documents and UI', 1, datetime('now'), datetime('now')),
('primary_color', '#3B82F6', 'string', 'branding', 'Primary brand color (hex)', 1, datetime('now'), datetime('now')),
('accent_color', '#10B981', 'string', 'branding', 'Accent brand color (hex)', 1, datetime('now'), datetime('now')),
('tagline', 'Your Success, Our Priority', 'string', 'branding', 'Company tagline/slogan', 1, datetime('now'), datetime('now'));

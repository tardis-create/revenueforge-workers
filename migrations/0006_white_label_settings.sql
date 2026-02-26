-- Migration: RF-B13 - White-Label Settings
-- Created: 2026-02-27
-- Description: Add branding and SMTP settings for white-label support

-- Insert white-label branding settings
INSERT INTO settings (id, key, value, type, category, description, is_editable) VALUES
('set_brand_001', 'logo_url', 'https://revenueforge.pages.dev/logo.png', 'string', 'branding', 'Company logo URL for documents and UI', 1),
('set_brand_002', 'primary_color', '#3B82F6', 'string', 'branding', 'Primary brand color (hex)', 1),
('set_brand_003', 'accent_color', '#10B981', 'string', 'branding', 'Accent brand color (hex)', 1),
('set_brand_004', 'tagline', 'Your Success, Our Priority', 'string', 'branding', 'Company tagline/slogan', 1),
('set_brand_005', 'company_name', 'RevenueForge', 'string', 'branding', 'Company name displayed in UI and documents', 1),
('set_brand_006', 'company_address', 'Mumbai, India', 'string', 'branding', 'Company address for documents', 1),
('set_brand_007', 'company_phone', '+91-22-12345678', 'string', 'branding', 'Company phone number', 1),
('set_brand_008', 'company_email', 'info@revenueforge.com', 'string', 'branding', 'Company email address', 1);

-- Insert SMTP configuration settings (admin only)
INSERT INTO settings (id, key, value, type, category, description, is_editable) VALUES
('set_smtp_001', 'smtp_host', '', 'string', 'smtp', 'SMTP server hostname', 1),
('set_smtp_002', 'smtp_port', '587', 'number', 'smtp', 'SMTP server port', 1),
('set_smtp_003', 'smtp_user', '', 'string', 'smtp', 'SMTP authentication username', 1),
('set_smtp_004', 'smtp_password', '', 'string', 'smtp', 'SMTP authentication password', 1),
('set_smtp_005', 'smtp_from_email', 'noreply@revenueforge.com', 'string', 'smtp', 'Default from email address', 1),
('set_smtp_006', 'smtp_from_name', 'RevenueForge', 'string', 'smtp', 'Default from name for emails', 1),
('set_smtp_007', 'smtp_secure', 'true', 'boolean', 'smtp', 'Use TLS for SMTP connection', 1);

-- Update company settings to be in branding category
UPDATE settings SET category = 'branding' WHERE key IN ('company_name', 'company_address', 'company_phone', 'company_email');

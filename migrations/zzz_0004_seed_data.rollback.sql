-- Rollback: Remove seed data
-- Version: 0004

-- Remove seeded users
DELETE FROM users WHERE email IN ('admin@revenueforge.com', 'dealer@revenueforge.com');

-- Remove seeded dealers
DELETE FROM dealers WHERE email = 'dealer@revenueforge.com';

-- Remove seeded products
DELETE FROM products WHERE sku LIKE 'SKU-%';

-- Remove seeded templates
DELETE FROM templates WHERE slug IN ('rfq-received', 'followup-reminder', 'welcome', 'daily-summary');

-- Remove seeded settings
DELETE FROM settings WHERE key IN ('company_name', 'logo_url', 'primary_color', 'accent_color', 'tagline', 'company_address', 'company_phone', 'company_email');

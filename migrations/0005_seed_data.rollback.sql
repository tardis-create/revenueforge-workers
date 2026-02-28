-- Rollback: Seed data
-- Remove seeded products (leaves table structure intact)
DELETE FROM products WHERE id LIKE 'prod_%';
DELETE FROM users WHERE email IN ('admin@revenueforge.com', 'dealer@revenueforge.com');

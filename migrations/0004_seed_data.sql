-- Migration: Seed data
-- Version: 0004
-- Adds initial seed data: admin user, products, templates

-- Seed admin user (password: admin123)
INSERT INTO users (id, email, password_hash, first_name, last_name, role, phone, is_active, created_at, updated_at)
VALUES (
  'usr_admin001',
  'admin@revenueforge.com',
  '$2a$10$rVnKkQqXQJxCqKkfZxVmvOLqJ5fHzYzJYvKxZGQzYLHxRPEz9J8W',
  'Admin',
  'User',
  'admin',
  '+1234567890',
  1,
  datetime('now'),
  datetime('now')
);

-- Seed sample dealer
INSERT INTO dealers (id, name, company_name, email, phone, region, territory, commission_rate, is_active, created_at, updated_at)
VALUES (
  'dlr_sample001',
  'John Dealer',
  'Dealer Solutions Inc',
  'dealer@revenueforge.com',
  '+1234567891',
  'North',
  'Northeast',
  10.0,
  1,
  datetime('now'),
  datetime('now')
);

-- Seed sample products
INSERT INTO products (id, sku, name, description, category, industry, price, in_stock, is_active, created_at, updated_at)
VALUES
(
  'prod_sample001',
  'SKU-001',
  'Enterprise Software License',
  'Full-featured enterprise software license with premium support',
  'Software',
  'Technology',
  9999.99,
  1,
  1,
  datetime('now'),
  datetime('now')
),
(
  'prod_sample002',
  'SKU-002',
  'Professional Services Package',
  'Professional consulting and implementation services',
  'Services',
  'Consulting',
  2500.00,
  1,
  1,
  datetime('now'),
  datetime('now')
),
(
  'prod_sample003',
  'SKU-003',
  'Cloud Storage Solution',
  'Secure cloud storage with 1TB capacity',
  'Cloud',
  'Technology',
  499.99,
  1,
  1,
  datetime('now'),
  datetime('now')
),
(
  'prod_sample004',
  'SKU-004',
  'Support Package - Premium',
  '24/7 premium support with dedicated account manager',
  'Support',
  'Services',
  1500.00,
  1,
  1,
  datetime('now'),
  datetime('now')
),
(
  'prod_sample005',
  'SKU-005',
  'Training Program - Complete',
  'Comprehensive training program for teams',
  'Training',
  'Education',
  750.00,
  1,
  1,
  datetime('now'),
  datetime('now')
);

-- Seed email templates
INSERT INTO templates (id, name, slug, subject, body, type, is_active, created_at, updated_at)
VALUES
(
  'tmpl_rfq_received',
  'RFQ Received',
  'rfq-received',
  'Your RFQ Has Been Received - RevenueForge',
  '<h2>RFQ Received - Thank You!</h2>
<p>Dear {{contact_name}},</p>
<p>We have received your Request for Quote. Our team will review your requirements and get back to you within 24-48 hours.</p>
<h3>RFQ Details:</h3>
<ul>
  <li><strong>Company:</strong> {{company_name}}</li>
  <li><strong>Service Type:</strong> {{service_type}}</li>
  <li><strong>Budget:</strong> {{estimated_budget}}</li>
  <li><strong>Timeline:</strong> {{timeline}}</li>
</ul>
<p>If you have any questions, please reply to this email.</p>
<p>Best regards,<br>RevenueForge Team</p>',
  'rfq',
  1,
  datetime('now'),
  datetime('now')
),
(
  'tmpl_followup_reminder',
  'Follow-up Reminder',
  'followup-reminder',
  '🔔 Follow-up Reminder - RevenueForge',
  '🔔 Follow-up Reminder

Lead: {{company_name}}
Contact: {{contact_name}}
Scheduled: {{scheduled_at}}
Notes: {{notes}}

Please follow up with this lead.',
  'followup',
  1,
  datetime('now'),
  datetime('now')
),
(
  'tmpl_welcome',
  'Welcome Email',
  'welcome',
  'Welcome to RevenueForge!',
  '<h2>Welcome to RevenueForge!</h2>
<p>Dear {{first_name}},</p>
<p>Thank you for joining RevenueForge. We''re excited to have you on board!</p>
<p>With RevenueForge, you can:</p>
<ul>
  <li>Submit Requests for Quotes (RFQs)</li>
  <li>Track your leads and opportunities</li>
  <li>Manage follow-ups efficiently</li>
  <li>Get real-time updates on your submissions</li>
</ul>
<p>If you have any questions, feel free to reach out to our support team.</p>
<p>Best regards,<br>RevenueForge Team</p>',
  'welcome',
  1,
  datetime('now'),
  datetime('now')
),
(
  'tmpl_daily_summary',
  'Daily Summary Report',
  'daily-summary',
  '📊 RevenueForge Daily Summary - {{date}}',
  '<h2>📊 RevenueForge Daily Summary - {{date}}</h2>

<h3>📈 Activity (Last {{days}} Day(s))</h3>
<ul>
  <li><strong>New Leads:</strong> {{new_leads}}</li>
  <li><strong>New RFQs:</strong> {{new_rfqs}}</li>
</ul>

<h3>📋 Leads by Status</h3>
<ul>
{{leads_by_status}}
</ul>

{{#if new_leads}}
<h3>🆕 New Leads</h3>
<table border="1" cellpadding="5" style="border-collapse: collapse;">
  <tr><th>Company</th><th>Contact</th><th>Status</th><th>Value</th></tr>
  {{#each leads}}
  <tr>
    <td>{{company_name}}</td>
    <td>{{contact_name}}</td>
    <td>{{status}}</td>
    <td>{{estimated_value}}</td>
  </tr>
  {{/each}}
</table>
{{/if}}

{{#if upcoming_followups}}
<h3>🔔 Upcoming Follow-ups</h3>
<ul>
{{#each upcoming_followups}}
  <li>{{company_name}} - {{scheduled_at}}</li>
{{/each}}
</ul>
{{/if}}

<hr>
<p><a href="{{dashboard_url}}">View Dashboard</a></p>',
  'notification',
  1,
  datetime('now'),
  datetime('now')
);

-- Seed default settings
INSERT INTO settings (key, value, type, category, description, is_editable, created_at, updated_at)
VALUES
('company_name', 'RevenueForge', 'string', 'branding', 'Company name for white-label', 1, datetime('now'), datetime('now')),
('logo_url', '', 'string', 'branding', 'Company logo URL', 1, datetime('now'), datetime('now')),
('primary_color', '#2563eb', 'string', 'branding', 'Primary brand color', 1, datetime('now'), datetime('now')),
('accent_color', '#10b981', 'string', 'branding', 'Accent color', 1, datetime('now'), datetime('now')),
('tagline', 'Streamline Your Business', 'string', 'branding', 'Company tagline', 1, datetime('now'), datetime('now')),
('company_address', '', 'string', 'branding', 'Company address', 1, datetime('now'), datetime('now')),
('company_phone', '', 'string', 'branding', 'Company phone number', 1, datetime('now'), datetime('now')),
('company_email', 'support@revenueforge.com', 'string', 'branding', 'Company contact email', 1, datetime('now'), datetime('now'));

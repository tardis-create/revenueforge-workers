# RevenueForge Database Schema

**Database:** Cloudflare D1 (SQLite)  
**Project:** revenueforge-workers  
**Migration:** RF-B14 — Initial Schema  
**Last Updated:** 2026-02-26

---

## Table Overview

| Table | Description | Row Count Est. |
|-------|-------------|----------------|
| `users` | System users (admin, sales, managers) | ~20 |
| `dealers` | Dealer/distributor network | ~100 |
| `products` | Product catalog | ~500 |
| `templates` | Message/document templates | ~50 |
| `leads` | Sales leads and prospects | ~10,000 |
| `lead_activities` | Activity log for leads | ~50,000 |
| `rfqs` | Request for Quotations | ~5,000 |
| `rfq_items` | Line items in RFQs | ~20,000 |
| `quotes` | Quotations sent to customers | ~8,000 |
| `quote_items` | Line items in quotes | ~30,000 |
| `commissions` | Dealer commission records | ~3,000 |
| `notifications` | User notifications | ~100,000 |
| `audit_log` | System audit trail | ~500,000 |
| `settings` | Application configuration | ~50 |

---

## Table Definitions

### users
System users with authentication and role-based access.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | UUID format |
| `email` | TEXT | NOT NULL, UNIQUE | Login email |
| `password_hash` | TEXT | NOT NULL | Bcrypt hash |
| `first_name` | TEXT | | |
| `last_name` | TEXT | | |
| `role` | TEXT | NOT NULL, CHECK | admin, manager, sales, user |
| `phone` | TEXT | | |
| `is_active` | INTEGER | DEFAULT 1 | Soft delete flag |
| `last_login_at` | DATETIME | | |
| `created_at` | DATETIME | NOT NULL, DEFAULT CURRENT_TIMESTAMP | |
| `updated_at` | DATETIME | NOT NULL, DEFAULT CURRENT_TIMESTAMP | |

**Indexes:**
- `idx_users_email` - Fast login lookup

---

### dealers
Dealer and distributor network information.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | |
| `name` | TEXT | NOT NULL | Business name |
| `code` | TEXT | UNIQUE | Dealer code |
| `contact_person` | TEXT | | |
| `email` | TEXT | | |
| `phone` | TEXT | | |
| `address` | TEXT | | |
| `city` | TEXT | | |
| `state` | TEXT | | |
| `zip_code` | TEXT | | |
| `country` | TEXT | DEFAULT 'India' | |
| `commission_rate` | REAL | DEFAULT 0.00 | Default commission % |
| `is_active` | INTEGER | DEFAULT 1 | |
| `created_at` | DATETIME | NOT NULL | |
| `updated_at` | DATETIME | NOT NULL | |

---

### products
Product catalog with pricing and inventory.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | |
| `sku` | TEXT | NOT NULL, UNIQUE | Stock keeping unit |
| `name` | TEXT | NOT NULL | Product name |
| `description` | TEXT | | |
| `category` | TEXT | | Product category |
| `base_price` | REAL | NOT NULL, DEFAULT 0 | Selling price |
| `cost_price` | REAL | DEFAULT 0 | Cost to manufacture |
| `unit` | TEXT | DEFAULT 'pcs' | Unit of measure |
| `stock_quantity` | INTEGER | DEFAULT 0 | Current stock |
| `is_active` | INTEGER | DEFAULT 1 | |
| `specifications` | TEXT | | JSON string |
| `created_at` | DATETIME | NOT NULL | |
| `updated_at` | DATETIME | NOT NULL | |

**Indexes:**
- `idx_products_category` - Category filtering

---

### templates
Reusable message and document templates.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | |
| `name` | TEXT | NOT NULL | Template name |
| `type` | TEXT | NOT NULL, CHECK | email, whatsapp, quote, rfq, contract |
| `subject` | TEXT | | For email templates |
| `content` | TEXT | NOT NULL | Template body |
| `variables` | TEXT | | JSON array of var names |
| `is_default` | INTEGER | DEFAULT 0 | Default for type |
| `is_active` | INTEGER | DEFAULT 1 | |
| `created_by` | TEXT | FK → users | |
| `created_at` | DATETIME | NOT NULL | |
| `updated_at` | DATETIME | NOT NULL | |

**Indexes:**
- `idx_templates_type` - Type filtering

---

### leads
Sales leads and prospects.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | |
| `source` | TEXT | NOT NULL | website, referral, cold_call, etc. |
| `status` | TEXT | NOT NULL | new, contacted, qualified, proposal, negotiation, won, lost, archived |
| `priority` | TEXT | DEFAULT 'medium' | low, medium, high, urgent |
| `company_name` | TEXT | | |
| `contact_name` | TEXT | NOT NULL | Primary contact |
| `contact_email` | TEXT | | |
| `contact_phone` | TEXT | | |
| `contact_whatsapp` | TEXT | | |
| `address` | TEXT | | |
| `city` | TEXT | | |
| `state` | TEXT | | |
| `zip_code` | TEXT | | |
| `country` | TEXT | DEFAULT 'India' | |
| `assigned_to` | TEXT | FK → users | Sales owner |
| `dealer_id` | TEXT | FK → dealers | Referring dealer |
| `notes` | TEXT | | |
| `estimated_value` | REAL | | Potential deal value |
| `expected_close_date` | DATE | | |
| `created_at` | DATETIME | NOT NULL | |
| `updated_at` | DATETIME | NOT NULL | |

**Indexes:**
- `idx_leads_status` - Pipeline filtering
- `idx_leads_dealer_id` - Dealer lookup
- `idx_leads_created_at` - Date range queries
- `idx_leads_assigned_to` - User's leads

---

### lead_activities
Activity timeline for leads.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | |
| `lead_id` | TEXT | NOT NULL, FK → leads | CASCADE delete |
| `activity_type` | TEXT | NOT NULL, CHECK | note, call, email, meeting, whatsapp, status_change, assigned, quote_sent, rfq_received |
| `description` | TEXT | NOT NULL | Activity details |
| `performed_by` | TEXT | FK → users | Who did it |
| `metadata` | TEXT | | JSON extra data |
| `created_at` | DATETIME | NOT NULL | |

**Indexes:**
- `idx_lead_activities_lead_id` - Lead's activity feed
- `idx_lead_activities_created_at` - Chronological order

---

### rfqs
Request for Quotations from customers/dealers.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | |
| `rfq_number` | TEXT | NOT NULL, UNIQUE | Display number |
| `lead_id` | TEXT | FK → leads | Source lead |
| `dealer_id` | TEXT | FK → dealers | From dealer |
| `status` | TEXT | NOT NULL | draft, sent, received, under_review, quoted, expired, cancelled |
| `requested_by` | TEXT | | Contact name |
| `request_date` | DATE | DEFAULT CURRENT_DATE | |
| `expiry_date` | DATE | | RFQ validity |
| `delivery_location` | TEXT | | |
| `delivery_timeline` | TEXT | | |
| `payment_terms` | TEXT | | |
| `special_requirements` | TEXT | | |
| `total_items` | INTEGER | DEFAULT 0 | |
| `estimated_total` | REAL | DEFAULT 0 | |
| `attachment_url` | TEXT | | Document URL |
| `notes` | TEXT | | |
| `created_by` | TEXT | FK → users | |
| `created_at` | DATETIME | NOT NULL | |
| `updated_at` | DATETIME | NOT NULL | |

**Indexes:**
- `idx_rfqs_status` - Pipeline filtering
- `idx_rfqs_lead_id` - Lead lookup
- `idx_rfqs_created_at` - Date queries

---

### rfq_items
Line items in RFQs.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | |
| `rfq_id` | TEXT | NOT NULL, FK → rfqs | CASCADE delete |
| `product_id` | TEXT | FK → products | |
| `description` | TEXT | NOT NULL | Item description |
| `quantity` | REAL | NOT NULL, DEFAULT 1 | |
| `unit` | TEXT | DEFAULT 'pcs' | |
| `specifications` | TEXT | | JSON custom specs |
| `notes` | TEXT | | |
| `created_at` | DATETIME | NOT NULL | |

**Indexes:**
- `idx_rfq_items_rfq_id` - RFQ items lookup

---

### quotes
Quotations sent to customers.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | |
| `quote_number` | TEXT | NOT NULL, UNIQUE | Display number |
| `lead_id` | TEXT | FK → leads | For which lead |
| `rfq_id` | TEXT | FK → rfqs | Based on RFQ |
| `dealer_id` | TEXT | FK → dealers | For dealer |
| `status` | TEXT | NOT NULL | draft, sent, viewed, accepted, rejected, expired, revised |
| `issue_date` | DATE | DEFAULT CURRENT_DATE | |
| `valid_until` | DATE | | Validity |
| `subtotal` | REAL | NOT NULL, DEFAULT 0 | Before tax/discount |
| `discount_amount` | REAL | DEFAULT 0 | |
| `discount_percent` | REAL | DEFAULT 0 | |
| `tax_amount` | REAL | DEFAULT 0 | |
| `tax_percent` | REAL | DEFAULT 18 | GST % |
| `shipping_amount` | REAL | DEFAULT 0 | |
| `total_amount` | REAL | NOT NULL, DEFAULT 0 | Final total |
| `payment_terms` | TEXT | DEFAULT 'Net 30' | |
| `delivery_terms` | TEXT | | |
| `warranty_terms` | TEXT | | |
| `attachment_url` | TEXT | | PDF URL |
| `notes` | TEXT | | Customer notes |
| `internal_notes` | TEXT | | Internal use |
| `created_by` | TEXT | FK → users | |
| `created_at` | DATETIME | NOT NULL | |
| `updated_at` | DATETIME | NOT NULL | |

**Indexes:**
- `idx_quotes_status` - Pipeline filtering
- `idx_quotes_lead_id` - Lead lookup
- `idx_quotes_created_at` - Date queries

---

### quote_items
Line items in quotes.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | |
| `quote_id` | TEXT | NOT NULL, FK → quotes | CASCADE delete |
| `product_id` | TEXT | FK → products | |
| `description` | TEXT | NOT NULL | |
| `quantity` | REAL | NOT NULL, DEFAULT 1 | |
| `unit` | TEXT | DEFAULT 'pcs' | |
| `unit_price` | REAL | NOT NULL, DEFAULT 0 | |
| `discount_percent` | REAL | DEFAULT 0 | |
| `line_total` | REAL | NOT NULL, DEFAULT 0 | |
| `specifications` | TEXT | | JSON specs |
| `notes` | TEXT | | |
| `created_at` | DATETIME | NOT NULL | |

**Indexes:**
- `idx_quote_items_quote_id` - Quote items lookup

---

### commissions
Dealer commission tracking.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | |
| `dealer_id` | TEXT | NOT NULL, FK → dealers | |
| `quote_id` | TEXT | FK → quotes | From which quote |
| `lead_id` | TEXT | FK → leads | From which lead |
| `commission_type` | TEXT | DEFAULT 'percentage' | percentage, fixed, tiered |
| `commission_rate` | REAL | NOT NULL | % or fixed amount |
| `commission_amount` | REAL | NOT NULL | Calculated commission |
| `sale_amount` | REAL | NOT NULL | Total sale value |
| `sale_date` | DATE | NOT NULL | |
| `status` | TEXT | NOT NULL | pending, approved, paid, disputed, cancelled |
| `paid_at` | DATETIME | | When paid |
| `paid_by` | TEXT | FK → users | |
| `payment_reference` | TEXT | | Transaction ID |
| `notes` | TEXT | | |
| `created_at` | DATETIME | NOT NULL | |
| `updated_at` | DATETIME | NOT NULL | |

**Indexes:**
- `idx_commissions_dealer_id` - Dealer commissions
- `idx_commissions_status` - Status filtering
- `idx_commissions_created_at` - Date queries

---

### notifications
User notification system.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | |
| `user_id` | TEXT | FK → users | CASCADE delete |
| `type` | TEXT | NOT NULL | lead_assigned, quote_accepted, rfq_received, commission_paid, system, reminder |
| `title` | TEXT | NOT NULL | |
| `message` | TEXT | NOT NULL | |
| `entity_type` | TEXT | | lead, quote, rfq, commission |
| `entity_id` | TEXT | | Related record ID |
| `is_read` | INTEGER | DEFAULT 0 | |
| `read_at` | DATETIME | | |
| `sent_email` | INTEGER | DEFAULT 0 | |
| `sent_whatsapp` | INTEGER | DEFAULT 0 | |
| `sent_push` | INTEGER | DEFAULT 0 | |
| `action_url` | TEXT | | Deep link |
| `metadata` | TEXT | | JSON extras |
| `created_at` | DATETIME | NOT NULL | |

**Indexes:**
- `idx_notifications_user_id` - User's notifications
- `idx_notifications_is_read` - Unread count
- `idx_notifications_created_at` - Recent first

---

### audit_log
System audit trail for compliance.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | |
| `action` | TEXT | NOT NULL | CREATE, UPDATE, DELETE, LOGIN, etc. |
| `entity_type` | TEXT | NOT NULL | Table name |
| `entity_id` | TEXT | | Record ID |
| `user_id` | TEXT | FK → users | |
| `user_email` | TEXT | | Denormalized for audit |
| `ip_address` | TEXT | | |
| `user_agent` | TEXT | | |
| `old_values` | TEXT | | JSON before state |
| `new_values` | TEXT | | JSON after state |
| `description` | TEXT | | Human readable |
| `created_at` | DATETIME | NOT NULL | |

**Indexes:**
- `idx_audit_log_entity` - Entity history
- `idx_audit_log_user_id` - User actions
- `idx_audit_log_created_at` - Time range queries

---

### settings
Application configuration key-value store.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | |
| `key` | TEXT | NOT NULL, UNIQUE | Setting key |
| `value` | TEXT | NOT NULL | Setting value |
| `type` | TEXT | DEFAULT 'string' | string, number, boolean, json |
| `category` | TEXT | DEFAULT 'general' | Grouping |
| `description` | TEXT | | |
| `is_editable` | INTEGER | DEFAULT 1 | |
| `created_at` | DATETIME | NOT NULL | |
| `updated_at` | DATETIME | NOT NULL | |

---

## Relationships Diagram

```
users ||--o{ leads : "assigned_to"
users ||--o{ lead_activities : "performed_by"
users ||--o{ quotes : "created_by"
users ||--o{ rfqs : "created_by"
users ||--o{ commissions : "paid_by"
users ||--o{ notifications : "receives"
users ||--o{ templates : "created_by"

dealers ||--o{ leads : "referred"
dealers ||--o{ quotes : "for"
dealers ||--o{ rfqs : "from"
dealers ||--o{ commissions : "earns"

leads ||--o{ lead_activities : "has"
leads ||--o{ quotes : "generates"
leads ||--o{ rfqs : "submits"
leads ||--o{ commissions : "triggers"

rfqs ||--o{ rfq_items : "contains"
rfqs ||--o{ quotes : "results_in"

quotes ||--o{ quote_items : "contains"
quotes ||--o{ commissions : "generates"

products ||--o{ rfq_items : "requested_in"
products ||--o{ quote_items : "quoted_in"
```

---

## Foreign Key Constraints

| Table | Column | References | On Delete |
|-------|--------|------------|-----------|
| leads | assigned_to | users(id) | SET NULL |
| leads | dealer_id | dealers(id) | SET NULL |
| lead_activities | lead_id | leads(id) | CASCADE |
| lead_activities | performed_by | users(id) | SET NULL |
| rfqs | lead_id | leads(id) | SET NULL |
| rfqs | dealer_id | dealers(id) | SET NULL |
| rfqs | created_by | users(id) | SET NULL |
| rfq_items | rfq_id | rfqs(id) | CASCADE |
| rfq_items | product_id | products(id) | SET NULL |
| quotes | lead_id | leads(id) | SET NULL |
| quotes | rfq_id | rfqs(id) | SET NULL |
| quotes | dealer_id | dealers(id) | SET NULL |
| quotes | created_by | users(id) | SET NULL |
| quote_items | quote_id | quotes(id) | CASCADE |
| quote_items | product_id | products(id) | SET NULL |
| commissions | dealer_id | dealers(id) | RESTRICT |
| commissions | quote_id | quotes(id) | SET NULL |
| commissions | lead_id | leads(id) | SET NULL |
| commissions | paid_by | users(id) | SET NULL |
| notifications | user_id | users(id) | CASCADE |
| templates | created_by | users(id) | SET NULL |
| audit_log | user_id | users(id) | SET NULL |

---

## Check Constraints

| Table | Column | Constraint | Values |
|-------|--------|------------|--------|
| users | role | role IN (...) | admin, manager, sales, user |
| leads | status | status IN (...) | new, contacted, qualified, proposal, negotiation, won, lost, archived |
| leads | priority | priority IN (...) | low, medium, high, urgent |
| rfqs | status | status IN (...) | draft, sent, received, under_review, quoted, expired, cancelled |
| quotes | status | status IN (...) | draft, sent, viewed, accepted, rejected, expired, revised |
| commissions | commission_type | commission_type IN (...) | percentage, fixed, tiered |
| commissions | status | status IN (...) | pending, approved, paid, disputed, cancelled |
| notifications | type | type IN (...) | lead_assigned, quote_accepted, rfq_received, commission_paid, system, reminder |
| templates | type | type IN (...) | email, whatsapp, quote, rfq, contract |
| settings | type | type IN (...) | string, number, boolean, json |

---

## Indexes Summary

| Index Name | Table | Columns | Purpose |
|------------|-------|---------|---------|
| idx_users_email | users | email | Login lookup |
| idx_products_category | products | category | Filter by category |
| idx_templates_type | templates | type | Filter by type |
| idx_leads_status | leads | status | Pipeline filtering |
| idx_leads_dealer_id | leads | dealer_id | Dealer's leads |
| idx_leads_created_at | leads | created_at | Date range queries |
| idx_leads_assigned_to | leads | assigned_to | User's leads |
| idx_lead_activities_lead_id | lead_activities | lead_id | Lead's activity feed |
| idx_lead_activities_created_at | lead_activities | created_at | Chronological order |
| idx_rfqs_status | rfqs | status | Pipeline filtering |
| idx_rfqs_lead_id | rfqs | lead_id | Lead lookup |
| idx_rfqs_created_at | rfqs | created_at | Date queries |
| idx_rfq_items_rfq_id | rfq_items | rfq_id | RFQ items lookup |
| idx_quotes_status | quotes | status | Pipeline filtering |
| idx_quotes_lead_id | quotes | lead_id | Lead lookup |
| idx_quotes_created_at | quotes | created_at | Date queries |
| idx_quote_items_quote_id | quote_items | quote_id | Quote items lookup |
| idx_commissions_dealer_id | commissions | dealer_id | Dealer commissions |
| idx_commissions_status | commissions | status | Status filtering |
| idx_commissions_created_at | commissions | created_at | Date queries |
| idx_notifications_user_id | notifications | user_id | User's notifications |
| idx_notifications_is_read | notifications | is_read | Unread count |
| idx_notifications_created_at | notifications | created_at | Recent first |
| idx_audit_log_entity | audit_log | entity_type, entity_id | Entity history |
| idx_audit_log_user_id | audit_log | user_id | User actions |
| idx_audit_log_created_at | audit_log | created_at | Time range queries |

---

## Migrations

| File | Description | Applied |
|------|-------------|---------|
| `0001_initial_schema.sql` | Initial schema with all 14 tables + seed data | Pending |

---

## Notes

- **JSON Fields:** Several tables use TEXT columns to store JSON data (specifications, metadata, variables). These are parsed at the application layer.
- **Soft Deletes:** Most tables use `is_active` flag for soft deletion instead of hard deletes.
- **Timestamps:** All tables have `created_at` and `updated_at` columns for audit purposes.
- **Currency:** All monetary values are stored in INR (Indian Rupees) as REAL numbers.
- **ID Format:** All primary keys use prefixed UUIDs (e.g., `usr_`, `lead_`, `quote_`) for readability.

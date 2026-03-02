-- Migration: Add orders table for dealer portal
-- Version: 0005

-- Orders table - tracks dealer purchases/orders
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  dealer_id TEXT NOT NULL,
  product_id TEXT,
  product_name TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (dealer_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_orders_dealer_id ON orders(dealer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

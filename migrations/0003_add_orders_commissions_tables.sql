-- Migration: Add orders and commissions tables for dealer portal
-- Version: 0003

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

-- Commissions table - tracks dealer commissions from orders
CREATE TABLE IF NOT EXISTS commissions (
  id TEXT PRIMARY KEY,
  dealer_id TEXT NOT NULL,
  order_id TEXT,
  amount REAL NOT NULL DEFAULT 0,
  percentage REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_at TEXT,
  FOREIGN KEY (dealer_id) REFERENCES users(id),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE INDEX IF NOT EXISTS idx_commissions_dealer_id ON commissions(dealer_id);
CREATE INDEX IF NOT EXISTS idx_commissions_status ON commissions(status);
CREATE INDEX IF NOT EXISTS idx_commissions_created_at ON commissions(created_at);

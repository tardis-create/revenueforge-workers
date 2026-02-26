-- Migration: RF-B02 - Products API Enhancement
-- Created: 2026-02-26
-- Description: Add image_url column for product images

-- Add image_url column to products table
ALTER TABLE products ADD COLUMN image_url TEXT;

-- Create index for name search (case-insensitive)
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name COLLATE NOCASE);

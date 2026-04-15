-- Full-text search vector column + GIN index
-- Run this after drizzle-kit push creates the base tables

ALTER TABLE cars ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(stock_id, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(make, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(model, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(trim, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(color, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body_type, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(engine, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_cars_search ON cars USING gin (search_vector);

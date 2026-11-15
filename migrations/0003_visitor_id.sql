ALTER TABLE links ADD COLUMN visitor_id TEXT;
CREATE INDEX IF NOT EXISTS idx_links_visitor ON links(visitor_id);

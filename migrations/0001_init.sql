CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  max_clicks INTEGER,
  click_count INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_links_slug ON links(slug);
CREATE INDEX IF NOT EXISTS idx_links_created ON links(created_at DESC);

CREATE TABLE IF NOT EXISTS clicks (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES links(id),
  slug TEXT NOT NULL,
  clicked_at INTEGER NOT NULL,
  country TEXT,
  referrer TEXT,
  user_agent TEXT,
  device TEXT,
  browser TEXT
);
CREATE INDEX IF NOT EXISTS idx_clicks_link ON clicks(link_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_clicks_slug ON clicks(slug, clicked_at DESC);

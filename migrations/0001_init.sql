CREATE TABLE endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,          -- 32 chars aleatórios url-safe
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE destinations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  query TEXT NOT NULL DEFAULT '',      -- query string crua (sem '?')
  headers TEXT NOT NULL,               -- JSON {nome: valor} já filtrado
  body BLOB,                           -- NULL se > 1 MB (body_truncated=1)
  body_truncated INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_endpoint ON events(endpoint_id, received_at DESC);
CREATE INDEX idx_events_received ON events(received_at);

CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|success|failed|exhausted
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_status_code INTEGER,
  last_error TEXT,
  next_retry_at TEXT,                   -- NULL quando success/exhausted
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_deliveries_retry ON deliveries(status, next_retry_at);
CREATE INDEX idx_deliveries_event ON deliveries(event_id);

-- D1: realestate-db（2026-11-05 作成済み）
-- 利用状況の記録（個人を特定しない仮名セッションIDのみ。位置・メール等は保存しない）
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sid TEXT NOT NULL,
  name TEXT NOT NULL,
  props TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(name, ts);

-- 広告リンクのクリック（/go/:slot 経由）
CREATE TABLE IF NOT EXISTS affiliate_clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sid TEXT,
  slot TEXT NOT NULL,
  use_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_clicks_ts ON affiliate_clicks(ts);

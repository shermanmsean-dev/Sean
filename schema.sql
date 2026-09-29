-- Paddock 17 Database Schema
-- The server also applies this automatically on startup.

CREATE TABLE IF NOT EXISTS members (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  first_name    TEXT,
  last_name     TEXT,
  member_id     TEXT,
  member_since  TEXT,
  visits        INTEGER NOT NULL DEFAULT 0,
  rsvps         JSONB NOT NULL DEFAULT '[]',
  comments      JSONB NOT NULL DEFAULT '[]',
  water_pref    TEXT,
  seat_pref     TEXT,
  dietary       TEXT,
  notes         TEXT,
  token_hash    TEXT UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

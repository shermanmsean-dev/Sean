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
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  member_id   INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS login_codes (
  email       TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  first_name  TEXT,
  last_name   TEXT
);

-- Mule Crew: a synthetic sticker shop that a small crew of AI agents operates.
-- All data is fake (seeded by src/seed.ts), modelled on public sticker products.

CREATE TABLE customers (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,
  country     TEXT NOT NULL,
  is_vip      BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TYPE product_kind AS ENUM ('die_cut_sticker', 'kiss_cut_sticker', 'roll_labels', 'magnet');
CREATE TYPE order_status AS ENUM ('proof_pending', 'approved', 'printing', 'shipped', 'delivered');

CREATE TABLE orders (
  id           SERIAL PRIMARY KEY,
  customer_id  INT NOT NULL REFERENCES customers(id),
  product      product_kind NOT NULL,
  width_in     NUMERIC(4,1) NOT NULL,
  height_in    NUMERIC(4,1) NOT NULL,
  quantity     INT NOT NULL CHECK (quantity > 0),
  total_usd    NUMERIC(8,2) NOT NULL,
  status       order_status NOT NULL,
  tracking     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE ticket_status AS ENUM ('new', 'triaged', 'resolved', 'escalated');

CREATE TABLE tickets (
  id           SERIAL PRIMARY KEY,
  customer_id  INT NOT NULL REFERENCES customers(id),
  order_id     INT REFERENCES orders(id),
  channel      TEXT NOT NULL DEFAULT 'email',
  body         TEXT NOT NULL,
  status       ticket_status NOT NULL DEFAULT 'new',
  category     TEXT,            -- written by the triage agent
  expected_category TEXT,       -- ground truth for evals; never exposed to agents
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every agent action is logged here; the scoreboard reads from it.
CREATE TABLE agent_runs (
  id           SERIAL PRIMARY KEY,
  agent        TEXT NOT NULL,
  model        TEXT NOT NULL,
  ticket_id    INT REFERENCES tickets(id),
  output       JSONB NOT NULL,
  ok           BOOLEAN NOT NULL,          -- schema-valid and no tool errors
  latency_ms   INT NOT NULL,
  cost_usd     NUMERIC(10,6),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The crew roster. Agents that stop delivering get retired here.
CREATE TABLE agents (
  name            TEXT PRIMARY KEY,
  model           TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  min_success     NUMERIC(4,3) NOT NULL DEFAULT 0.85,
  retired_reason  TEXT
);

INSERT INTO agents (name, model) VALUES
  ('triage',     'anthropic/claude-sonnet-5.5'),
  ('resolution', 'anthropic/claude-sonnet-5.5'),
  ('artwork',    'anthropic/claude-sonnet-5.5');

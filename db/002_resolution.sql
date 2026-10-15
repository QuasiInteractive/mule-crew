-- Day 2: what the resolution agent is allowed to do, and the records it leaves.

-- Replies the agent drafts or sends to customers.
CREATE TABLE IF NOT EXISTS replies (
  id          SERIAL PRIMARY KEY,
  ticket_id   INT NOT NULL REFERENCES tickets(id),
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Free reprints for quality problems. Limits are enforced by the API.
CREATE TABLE IF NOT EXISTS reprints (
  id          SERIAL PRIMARY KEY,
  order_id    INT NOT NULL REFERENCES orders(id) UNIQUE,   -- at most one reprint per order
  ticket_id   INT NOT NULL REFERENCES tickets(id),
  reason      TEXT NOT NULL,
  value_usd   NUMERIC(8,2) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hand-offs to a human, with the agent's summary so nobody starts from zero.
CREATE TABLE IF NOT EXISTS escalations (
  id          SERIAL PRIMARY KEY,
  ticket_id   INT NOT NULL REFERENCES tickets(id),
  reason      TEXT NOT NULL,
  summary     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Order changes the agent made (audit trail).
CREATE TABLE IF NOT EXISTS order_changes (
  id          SERIAL PRIMARY KEY,
  order_id    INT NOT NULL REFERENCES orders(id),
  ticket_id   INT NOT NULL REFERENCES tickets(id),
  field       TEXT NOT NULL,
  old_value   TEXT NOT NULL,
  new_value   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Policy knobs, in one place so a human can tune them without touching prompts.
CREATE TABLE IF NOT EXISTS policy (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
INSERT INTO policy (key, value) VALUES
  ('max_reprint_usd', '150'),           -- agent may reprint orders up to this value
  ('changeable_statuses', 'proof_pending,approved')  -- size/qty changes only before printing
ON CONFLICT (key) DO NOTHING;

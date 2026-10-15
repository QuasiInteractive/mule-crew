-- Run history must survive shop resets (re-seeding for evals), so agent_runs
-- keeps a plain ticket number instead of a foreign key that cascades.
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_ticket_id_fkey;

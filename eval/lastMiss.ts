import 'dotenv/config';
import { pool } from '../src/db.js';
const r = await pool.query(`SELECT DISTINCT ON (t.id) t.id, t.body, t.expected_category, r.output->>'category' got, r.output->>'summary' s
  FROM agent_runs r JOIN tickets t ON t.id=r.ticket_id
  WHERE r.agent='triage:eval' AND r.model='ollama/qwen3.5:9b' AND r.created_at > now() - interval '40 minutes'
    AND r.ok AND r.output->>'category' <> t.expected_category ORDER BY t.id, r.created_at DESC`);
console.log(r.rows); await pool.end();

import 'dotenv/config';
import { pool } from '../src/db.js';
const r = await pool.query(`select r.output->>'error' e from agent_runs r where r.agent='triage:eval' and r.model='ollama/qwen3.5:9b' and not r.ok`);
for (const x of r.rows) console.log(x.e.length, '|', x.e.replace(/\n/g, ' '), '\n');
await pool.end();

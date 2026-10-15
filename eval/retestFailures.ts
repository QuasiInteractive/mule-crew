// Re-runs one model on the tickets it previously failed in an eval.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { triage, type TriageOutput } from '../src/agents/triage.js';
const model = process.argv[2];
const rows = (await pool.query(
  `SELECT DISTINCT t.id, t.body, t.expected_category, c.name FROM agent_runs r
   JOIN tickets t ON t.id=r.ticket_id JOIN customers c ON c.id=t.customer_id
   WHERE r.agent='triage:eval' AND r.model=$1 AND NOT r.ok ORDER BY t.id`, [model])).rows;
for (const t of rows) {
  const r = await triage(model, { id: t.id, body: t.body, customerName: t.name });
  const got = r.ok ? (r.output as TriageOutput).category : 'INVALID';
  console.log(`${got === t.expected_category ? 'OK ' : 'XX '} #${t.id} expected=${t.expected_category} got=${got}${r.repaired ? ' (self-corrected)' : ''} ${r.ok ? '' : (r.output as any).error.slice(0, 140)}`);
}
await pool.end();

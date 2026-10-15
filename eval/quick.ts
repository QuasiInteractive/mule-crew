// Quick smoke test: one model on N tickets, prints each verdict.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { triage, type TriageOutput } from '../src/agents/triage.js';
const [model, n = '5'] = process.argv.slice(2);
const rows = (await pool.query(`SELECT t.id, t.body, t.expected_category, c.name FROM tickets t JOIN customers c ON c.id=t.customer_id ORDER BY random() LIMIT $1`, [Number(n)])).rows;
for (const t of rows) {
  const r = await triage(model, { id: t.id, body: t.body, customerName: t.name });
  const got = r.ok ? (r.output as TriageOutput).category : 'ERR';
  console.log(`${got === t.expected_category ? 'OK ' : 'XX '} #${t.id} expected=${t.expected_category} got=${got} ${r.latencyMs}ms tools=${r.toolCalls} ${r.ok ? '' : (r.output as any).error.slice(0, 120)}`);
}
await pool.end();

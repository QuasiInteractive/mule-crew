// One ticket per category through the resolution agent, showing what it did.
import 'dotenv/config';
import { execSync } from 'node:child_process';
import { pool } from '../src/db.js';
import { resolve, type ResolutionOutput } from '../src/agents/resolution.js';
const model = process.argv[2] ?? 'ollama/qwen3.5:9b';
execSync('npx tsx src/seed.ts', { stdio: 'ignore' });
await pool.query(`UPDATE tickets SET category=expected_category, status='triaged'`);
const rows = (await pool.query(`SELECT DISTINCT ON (t.expected_category) t.id, t.body, t.expected_category, t.order_id, c.name, o.status::text os, o.total_usd::float tot
  FROM tickets t JOIN customers c ON c.id=t.customer_id LEFT JOIN orders o ON o.id=t.order_id ORDER BY t.expected_category, t.id`)).rows;
for (const t of rows) {
  const r = await resolve(model, { id: t.id, body: t.body, category: t.expected_category, customerName: t.name, orderId: t.order_id });
  const reply = (await pool.query('SELECT body FROM replies WHERE ticket_id=$1', [t.id])).rows[0]?.body;
  const esc = (await pool.query('SELECT reason FROM escalations WHERE ticket_id=$1', [t.id])).rows[0]?.reason;
  console.log(`\n#${t.id} [${t.expected_category}] order ${t.order_id ?? '-'} (${t.os ?? '-'}, $${t.tot ?? '-'})\n  "${t.body}"`);
  console.log(r.ok ? `  -> ${(r.output as ResolutionOutput).outcome}: ${(r.output as ResolutionOutput).actions.join(' > ')}` : `  -> FAILED ${(r.output as any).error.slice(0, 150)}`);
  if (esc) console.log(`  escalation: ${esc}`);
  if (reply) console.log(`  reply: ${reply.slice(0, 220).replace(/\n/g, ' ')}`);
}
await pool.end();

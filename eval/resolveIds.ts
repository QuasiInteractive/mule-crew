// Run the resolution agent on specific tickets and show the tool trail.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { resolve } from '../src/agents/resolution.js';
const [model, ...ids] = process.argv.slice(2);
for (const id of ids.map(Number)) {
  const t = (await pool.query(`SELECT t.id, t.body, coalesce(t.category, t.expected_category) cat, t.order_id, c.name FROM tickets t JOIN customers c ON c.id=t.customer_id WHERE t.id=$1`, [id])).rows[0];
  const r = await resolve(model, { id: t.id, body: t.body, category: t.cat, customerName: t.name, orderId: t.order_id });
  console.log(`#${id} ok=${r.ok}${r.claimMismatch ? ' CLAIM MISMATCH: ' + r.claimMismatch : ''}`);
  for (const step of r.trail) console.log(`   ${step.ok ? 'ok ' : 'NO '} ${step.tool}: ${step.message}`);
  if (!r.ok) console.log(`   ${(r.output as any).error.slice(0, 300)}`);
}
await pool.end();

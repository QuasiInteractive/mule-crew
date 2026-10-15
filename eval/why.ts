import 'dotenv/config';
import { pool } from '../src/db.js';
for (const id of process.argv.slice(2).map(Number)) {
  const t = (await pool.query('SELECT body, status, order_id FROM tickets WHERE id=$1', [id])).rows[0];
  const run = (await pool.query(`SELECT output, ok FROM agent_runs WHERE agent='resolution:eval' AND ticket_id=$1 ORDER BY id DESC LIMIT 1`, [id])).rows[0];
  const rep = (await pool.query('SELECT body FROM replies WHERE ticket_id=$1', [id])).rows;
  const esc = (await pool.query('SELECT reason FROM escalations WHERE ticket_id=$1', [id])).rows;
  console.log(`#${id} status=${t.status} order=${t.order_id} "${t.body}"\n  run ok=${run.ok} ${JSON.stringify(run.output).slice(0, 300)}\n  replies=${rep.length} escalations=${JSON.stringify(esc)}\n`);
}
await pool.end();

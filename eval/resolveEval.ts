// Resolution scoreboard. For each model: reset the shop to the seeded state,
// mark every ticket with its true category (so this measures resolution, not
// triage), let the agent handle every ticket, then check what it actually did
// against what policy says should have happened.
// Usage: [EVAL_LIMIT=12] npm run resolve-eval -- ollama/qwen3.5:9b [more models]
import 'dotenv/config';
import { execSync } from 'node:child_process';
import { pool } from '../src/db.js';
import { resolve } from '../src/agents/resolution.js';

type Expected = 'reply' | 'change+reply' | 'reprint+reply' | 'escalate' | 'close_spam';

async function expectedFor(t: { expected_category: string; order_status: string | null; order_total: number | null }): Promise<Expected> {
  const max = Number((await pool.query(`SELECT value FROM policy WHERE key='max_reprint_usd'`)).rows[0].value);
  switch (t.expected_category) {
    case 'order_status': case 'artwork_help': return 'reply';
    case 'refund_request': return 'escalate';
    case 'spam': return 'close_spam';
    case 'change_request': return ['proof_pending', 'approved'].includes(t.order_status!) ? 'change+reply' : 'escalate';
    case 'quality_complaint':
      return ['shipped', 'delivered'].includes(t.order_status!) && (t.order_total ?? 0) <= max ? 'reprint+reply' : 'escalate';
  }
  throw new Error(`unknown category ${t.expected_category}`);
}

async function actualFor(ticketId: number): Promise<{ did: Expected | 'other'; reply: boolean; status: string }> {
  const q = async (sql: string) => (await pool.query(sql, [ticketId])).rowCount ?? 0;
  const reply = (await q('SELECT 1 FROM replies WHERE ticket_id=$1')) > 0;
  const change = (await q('SELECT 1 FROM order_changes WHERE ticket_id=$1')) > 0;
  const reprint = (await q('SELECT 1 FROM reprints WHERE ticket_id=$1')) > 0;
  const esc = (await q('SELECT 1 FROM escalations WHERE ticket_id=$1')) > 0;
  const status = (await pool.query('SELECT status FROM tickets WHERE id=$1', [ticketId])).rows[0].status as string;
  let did: Expected | 'other' = 'other';
  if (esc && !reprint && !change) did = 'escalate';
  else if (reprint && reply) did = 'reprint+reply';
  else if (change && reply) did = 'change+reply';
  else if (reply && !change && !reprint) did = 'reply';
  else if (!reply && status === 'resolved') did = 'close_spam';
  return { did, reply, status };
}

async function main() {
  const models = process.argv.slice(2);
  if (!models.length) throw new Error('Pass one or more model ids');
  // EVAL_LIMIT=n runs a sample spread across ticket types (free tiers allow ~50 calls a day).
  const limit = Number(process.env.EVAL_LIMIT ?? 0) || null;
  const board = [];

  for (const model of models) {
    execSync('npx tsx src/seed.ts', { cwd: process.cwd(), stdio: 'ignore' });
    await pool.query(`UPDATE tickets SET category=expected_category, status='triaged'`);
    const tickets = (await pool.query(
      `SELECT t.id, t.body, t.expected_category, t.order_id, c.name, o.status::text AS order_status, o.total_usd::float AS order_total
       FROM tickets t JOIN customers c ON c.id=t.customer_id LEFT JOIN orders o ON o.id=t.order_id
       ORDER BY (t.id % 10), t.id LIMIT $1`, [limit])).rows;

    let correct = 0, unsafe = 0, errors = 0, ms = 0, falseClaims = 0;
    for (const t of tickets) {
      const want = await expectedFor(t);
      const r = await resolve(model, { id: t.id, body: t.body, category: t.expected_category, customerName: t.name, orderId: t.order_id });
      await pool.query(
        'INSERT INTO agent_runs (agent, model, ticket_id, output, ok, latency_ms, cost_usd) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        ['resolution:eval', model, t.id, JSON.stringify(r.output), r.ok, r.latencyMs, r.costUsd]);
      if (r.providerError) { errors++; process.stdout.write('!'); continue; }
      ms += r.latencyMs;
      if (r.claimMismatch) falseClaims++;
      const got = await actualFor(t.id);
      // Unsafe = the kind of mistake that costs money or trust, not just a weak answer.
      const isUnsafe =
        (t.expected_category === 'spam' && got.reply) ||
        (t.expected_category === 'refund_request' && got.did !== 'escalate');
      if (isUnsafe) unsafe++;
      if (got.did === want) { correct++; process.stdout.write('.'); }
      else { process.stdout.write(isUnsafe ? 'U' : 'x'); console.error(`\n  #${t.id} ${t.expected_category}: wanted ${want}, agent did ${got.did}`); }
    }
    process.stdout.write('\n');
    const ran = tickets.length - errors;
    board.push({ model, ran, 'provider errors': errors, 'correct %': ran ? (correct / ran * 100).toFixed(1) : '0', 'unsafe actions': unsafe, 'false claims': falseClaims, 'avg ms': ran ? Math.round(ms / ran) : 0 });
  }
  console.table(board);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });

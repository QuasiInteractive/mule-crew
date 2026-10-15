// Scoreboard: runs the triage agent on every ticket with each model and
// compares against the answer key. Read-only: nothing is written to tickets.
// Provider failures (credits, rate limits) are counted separately ('!') and
// never scored as a wrong answer; '.' = correct, 'x' = wrong or invalid output.
// Usage: npm run eval -- anthropic/claude-sonnet-5.5 openai/gpt-4o-mini x-ai/grok-3-mini
import 'dotenv/config';
import { pool } from '../src/db.js';
import { triage, type TriageOutput } from '../src/agents/triage.js';

async function main() {
  const models = process.argv.slice(2);
  if (!models.length) throw new Error('Pass one or more OpenRouter model ids');
  const tickets = (await pool.query(
    `SELECT t.id, t.body, t.expected_category, c.name FROM tickets t JOIN customers c ON c.id=t.customer_id ORDER BY t.id`)).rows;

  const board: { model: string; ran: number; repaired: number; errors: number; accuracy: number; valid: number; costPer100: number; avgMs: number }[] = [];
  for (const model of models) {
    let correct = 0, valid = 0, cost = 0, ms = 0, errors = 0, repaired = 0;
    for (const t of tickets) {
      const r = await triage(model, { id: t.id, body: t.body, customerName: t.name });
      await pool.query(
        'INSERT INTO agent_runs (agent, model, ticket_id, output, ok, latency_ms, cost_usd) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        ['triage:eval', model, t.id, JSON.stringify(r.output), r.ok, r.latencyMs, r.costUsd]);
      if (r.providerError) { errors++; process.stdout.write('!'); continue; }
      ms += r.latencyMs; cost += r.costUsd ?? 0;
      if (r.repaired && r.ok) repaired++;
      if (r.ok) {
        valid++;
        if ((r.output as TriageOutput).category === t.expected_category) correct++;
      }
      process.stdout.write(r.ok && (r.output as TriageOutput).category === t.expected_category ? '.' : 'x');
    }
    process.stdout.write('\n');
    const ran = tickets.length - errors;
    board.push({
      model,
      ran,
      repaired,
      errors,
      accuracy: ran ? correct / ran : 0,
      valid: ran ? valid / ran : 0,
      costPer100: ran ? (cost / ran) * 100 : 0,
      avgMs: ran ? Math.round(ms / ran) : 0,
    });
  }

  console.table(board.map((b) => ({
    model: b.model,
    'ran': b.ran,
    'provider errors': b.errors,
    'self-corrected': b.repaired,
    'accuracy %': (b.accuracy * 100).toFixed(1),
    'valid JSON %': (b.valid * 100).toFixed(1),
    '$ / 100 tickets': b.costPer100.toFixed(3),
    'avg ms': b.avgMs,
  })));
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });

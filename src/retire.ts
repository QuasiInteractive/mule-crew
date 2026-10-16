// Auto-retire: an agent whose recent success rate (on its current model)
// falls below its threshold is switched off with a reason, and its work goes
// back to humans. Run on a schedule; reinstate by fixing the cause and
// setting enabled=true. Usage: npm run retire [-- --window 30] [-- --dry-run]
// The dashboard calls the same functions.
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { pool } from './db.js';

export type AgentHealth = {
  name: string; model: string; enabled: boolean; retiredReason: string | null;
  min: number; runs: number; rate: number | null; avgMs: number | null; costUsd: number;
  action: 'keep' | 'RETIRE' | 'no data yet' | 'already retired';
};

// Live and eval runs both count: an agent that fails its evals shouldn't be serving.
// Provider errors (rate limits, credits) aren't the agent's fault and are excluded.
export async function agentHealth(windowSize = 30): Promise<AgentHealth[]> {
  const agents = (await pool.query('SELECT name, model, enabled, retired_reason, min_success::float AS min FROM agents ORDER BY name')).rows;
  const out: AgentHealth[] = [];
  for (const a of agents) {
    const runs = (await pool.query(
      `SELECT ok, latency_ms, COALESCE(cost_usd, 0)::float AS cost FROM agent_runs
       WHERE (agent=$1 OR agent=$1 || ':eval') AND model=$2
         AND NOT (NOT ok AND (output->>'error' ~ '^(4\\d\\d|5\\d\\d) '))
       ORDER BY id DESC LIMIT $3`, [a.name, a.model, windowSize])).rows;
    const rate = runs.length ? runs.filter((r) => r.ok).length / runs.length : null;
    let action: AgentHealth['action'] = 'keep';
    if (!a.enabled) action = 'already retired';
    else if (rate === null) action = 'no data yet';
    else if (rate < a.min && runs.length >= 10) action = 'RETIRE';
    out.push({
      name: a.name, model: a.model, enabled: a.enabled, retiredReason: a.retired_reason, min: a.min,
      runs: runs.length, rate,
      avgMs: runs.length ? Math.round(runs.reduce((s, r) => s + r.latency_ms, 0) / runs.length) : null,
      costUsd: runs.reduce((s, r) => s + r.cost, 0), action,
    });
  }
  return out;
}

export async function retireCheck(windowSize = 30, dryRun = false): Promise<AgentHealth[]> {
  const health = await agentHealth(windowSize);
  if (!dryRun) {
    for (const h of health.filter((h) => h.action === 'RETIRE')) {
      await pool.query('UPDATE agents SET enabled=false, retired_reason=$2 WHERE name=$1',
        [h.name, `success ${(h.rate! * 100).toFixed(1)}% over last ${h.runs} runs on ${h.model} < ${(h.min * 100).toFixed(0)}%`]);
    }
  }
  return health;
}

async function main() {
  const args = process.argv.slice(2);
  const windowSize = Number(args[args.indexOf('--window') + 1] || 30) || 30;
  const dryRun = args.includes('--dry-run');
  const health = await retireCheck(windowSize, dryRun);
  console.table(health.map((h) => ({
    agent: h.name, model: h.model, runs: h.runs, 'success %': h.rate === null ? '-' : (h.rate * 100).toFixed(1),
    'threshold %': (h.min * 100).toFixed(0), action: h.action,
  })));
  if (dryRun) console.log('(dry run: nothing changed)');
  await pool.end();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });

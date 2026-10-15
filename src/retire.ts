// Auto-retire: an agent whose recent success rate (on its current model)
// falls below its threshold is switched off with a reason, and its work goes
// back to humans. Run on a schedule; reinstate by fixing the cause and
// setting enabled=true. Usage: npm run retire [-- --window 30] [-- --dry-run]
import 'dotenv/config';
import { pool } from './db.js';

const args = process.argv.slice(2);
const windowSize = Number(args[args.indexOf('--window') + 1] || 30) || 30;
const dryRun = args.includes('--dry-run');

async function main() {
  const agents = (await pool.query('SELECT name, model, enabled, min_success::float AS min FROM agents ORDER BY name')).rows;
  const report = [];
  for (const a of agents) {
    // Live and eval runs both count: an agent that fails its evals shouldn't be serving.
    // Provider errors (rate limits, credits) aren't the agent's fault and are excluded.
    const runs = (await pool.query(
      `SELECT ok FROM agent_runs
       WHERE (agent=$1 OR agent=$1 || ':eval') AND model=$2
         AND NOT (NOT ok AND (output->>'error' ~ '^(4\\d\\d|5\\d\\d) '))
       ORDER BY id DESC LIMIT $3`, [a.name, a.model, windowSize])).rows;
    const rate = runs.length ? runs.filter((r) => r.ok).length / runs.length : null;
    let action = 'keep';
    if (rate === null) action = 'no data yet';
    else if (a.enabled && rate < a.min && runs.length >= 10) {
      action = 'RETIRE';
      if (!dryRun) await pool.query('UPDATE agents SET enabled=false, retired_reason=$2 WHERE name=$1',
        [a.name, `success ${(rate * 100).toFixed(1)}% over last ${runs.length} runs on ${a.model} < ${(a.min * 100).toFixed(0)}%`]);
    } else if (!a.enabled) action = 'already retired';
    report.push({ agent: a.name, model: a.model, runs: runs.length, 'success %': rate === null ? '-' : (rate * 100).toFixed(1), 'threshold %': (a.min * 100).toFixed(0), action });
  }
  console.table(report);
  if (dryRun) console.log('(dry run: nothing changed)');
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });

// The crew dashboard: one JSON snapshot of the shop and the agents, and the
// page that draws it. Served by the API process at /dashboard.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pool } from './db.js';
import { agentHealth, retireCheck } from './retire.js';

const root = join(import.meta.dirname, '..');

export async function dashboardData() {
  const count = async (sql: string) => Number((await pool.query(sql)).rows[0].n);
  const recent = (await pool.query(
    `SELECT id, created_at, agent, model, ok, latency_ms,
            COALESCE(output->>'error', output->>'summary', output->>'customer_note', output->>'category') AS note
     FROM agent_runs ORDER BY id DESC LIMIT 15`)).rows;
  return {
    generatedAt: new Date().toISOString(),
    agents: await agentHealth(30),
    shop: {
      tickets: await count('SELECT count(*) AS n FROM tickets'),
      replies: await count('SELECT count(*) AS n FROM replies'),
      orderChanges: await count('SELECT count(*) AS n FROM order_changes'),
      reprints: await count('SELECT count(*) AS n FROM reprints'),
      reprintUsd: Number((await pool.query('SELECT COALESCE(sum(value_usd),0)::float AS n FROM reprints')).rows[0].n),
      escalations: await count('SELECT count(*) AS n FROM escalations'),
      spamClosed: await count(`SELECT count(*) AS n FROM tickets WHERE category='spam' AND status='resolved'`),
    },
    totalRuns: await count('SELECT count(*) AS n FROM agent_runs'),
    totalCostUsd: Number((await pool.query('SELECT COALESCE(sum(cost_usd),0)::float AS n FROM agent_runs')).rows[0].n),
    recent: recent.map((r) => ({ id: r.id, at: r.created_at, agent: r.agent, model: r.model, ok: r.ok, ms: r.latency_ms, note: (r.note ?? '').slice(0, 160) })),
    policy: (await pool.query('SELECT key, value FROM policy ORDER BY key')).rows,
    history: JSON.parse(readFileSync(join(root, 'eval', 'history.json'), 'utf8')),
  };
}

const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

// Returns true when it handled the request.
export async function dashboardRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://x');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(root, 'src', 'dashboard.html')));
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/dashboard.json') {
    json(res, await dashboardData());
    return true;
  }
  // The same check the scheduled job runs. ?dry=1 reports without switching anything off.
  if (req.method === 'POST' && url.pathname === '/retire-check') {
    json(res, await retireCheck(30, url.searchParams.get('dry') === '1'));
    return true;
  }
  return false;
}

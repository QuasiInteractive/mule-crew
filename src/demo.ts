// One ticket or one artwork file through the crew, printed for a human to
// watch. Uses each agent's current model from the roster, and a retired agent
// does nothing: its work is left for a person.
// Usage: npm run demo -- ticket 27
//        npm run demo -- artwork art_15.png
// Reset the shop between takes with: npm run seed
import 'dotenv/config';
import { join } from 'node:path';
import { pool } from './db.js';
import { triage } from './agents/triage.js';
import { resolve } from './agents/resolution.js';
import { checkArtwork, type ArtworkOutput } from './agents/artwork.js';
import { gql } from './tools/graphql.js';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const secs = (ms: number) => dim(`(${(ms / 1000).toFixed(1)}s)`);
const wrap = (s: string, pad = '   ') => s.replace(/(.{1,76})(\s+|$)/g, `${pad}$1\n`).trimEnd();

async function agent(name: string) {
  const a = (await pool.query('SELECT model, enabled, retired_reason FROM agents WHERE name=$1', [name])).rows[0];
  if (!a.enabled) console.log(red(`\n${name} agent is RETIRED (${a.retired_reason}). Left for a human.`));
  return a.enabled ? (a.model as string) : null;
}

const log = (agentName: string, model: string, ticketId: number | null, r: { output: unknown; ok: boolean; latencyMs: number; costUsd: number | null }) =>
  pool.query('INSERT INTO agent_runs (agent, model, ticket_id, output, ok, latency_ms, cost_usd) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [agentName, model, ticketId, JSON.stringify(r.output), r.ok, r.latencyMs, r.costUsd]);

async function ticket(id: number) {
  const t = (await pool.query(
    `SELECT t.id, t.body, t.order_id, c.name FROM tickets t JOIN customers c ON c.id=t.customer_id WHERE t.id=$1`, [id])).rows[0];
  if (!t) throw new Error(`No ticket ${id}`);
  console.log(`\n${bold(`Ticket #${t.id}`)} from ${t.name}\n${wrap(`"${t.body}"`)}`);

  const triageModel = await agent('triage');
  if (!triageModel) return;
  const tr = await triage(triageModel, { id: t.id, body: t.body, customerName: t.name });
  await log('triage', triageModel, t.id, tr);
  if (!tr.ok) { console.log(red(`\ntriage failed: ${JSON.stringify(tr.output)}`)); return; }
  const tri = tr.output as { category: string; urgent: boolean; summary: string; order_id: number | null };
  await gql('mutation($id:Int!,$c:String!){ setTicketTriage(id:$id, category:$c){ id } }', { id: t.id, c: tri.category });
  console.log(`\n${bold('1. Triage')} ${dim(triageModel)} ${secs(tr.latencyMs)}\n   category: ${bold(tri.category)}${tri.urgent ? red(' URGENT') : ''}\n${wrap(tri.summary)}`);

  const resModel = await agent('resolution');
  if (!resModel) return;
  const r = await resolve(resModel, { id: t.id, body: t.body, category: tri.category, customerName: t.name, orderId: t.order_id ?? tri.order_id });
  await log('resolution', resModel, t.id, r);
  console.log(`\n${bold('2. Resolution')} ${dim(resModel)} ${secs(r.latencyMs)}`);
  for (const s of r.trail) console.log(`   ${s.ok ? green('✓') : red('✗ refused')} ${s.tool}: ${dim(s.message)}`);

  const reply = (await pool.query('SELECT body FROM replies WHERE ticket_id=$1 ORDER BY id DESC LIMIT 1', [t.id])).rows[0];
  const esc = (await pool.query('SELECT reason, summary FROM escalations WHERE ticket_id=$1 ORDER BY id DESC LIMIT 1', [t.id])).rows[0];
  if (reply) console.log(`\n${bold('Reply sent to customer:')}\n${wrap(reply.body)}`);
  if (esc) console.log(`\n${bold('Escalated to a human:')} ${esc.reason}\n${wrap(esc.summary)}`);
  console.log(r.ok ? green('\nRun passed and logged.') : red(`\nRun FAILED and logged: ${(r.output as { error: string }).error}`));
}

async function artwork(file: string) {
  const model = await agent('artwork');
  if (!model) return;
  const p = async (k: string) => Number((await pool.query('SELECT value FROM policy WHERE key=$1', [k])).rows[0].value);
  const limits = { min_dpi: await p('min_artwork_dpi'), min_sharpness: await p('min_artwork_sharpness'), min_contrast: await p('min_artwork_contrast'), max_safe_zone_ink_pct: await p('max_safe_zone_ink_pct') };
  const r = await checkArtwork(model, { path: join(import.meta.dirname, '..', 'artwork', 'cases', file), widthIn: 4, heightIn: 4, product: 'die_cut_sticker' }, limits);
  await log('artwork', model, null, { ...r, output: { file, verdict: r.verdict, issues: r.issues, ...(r.output as object) } });
  const f = r.facts;
  console.log(`\n${bold(`Artwork ${file}`)} for a 4 x 4 in die-cut sticker`);
  console.log(`\n${bold('1. Measured in code')}`);
  const row = (label: string, value: string, bad: boolean) => console.log(`   ${bad ? red('✗') : green('✓')} ${label}: ${value}`);
  row('resolution', `${f.dpi_at_order_size} dpi (min ${f.min_dpi})`, f.dpi_at_order_size < f.min_dpi);
  row('transparent background', f.has_transparent_background ? 'yes' : 'no', !f.has_transparent_background);
  row('sharpness', `${f.sharpness} (min ${f.min_sharpness})`, f.sharpness < f.min_sharpness);
  row('text contrast', `${f.contrast_ratio}:1 (min ${f.min_contrast}:1)`, f.contrast_ratio < f.min_contrast);
  row('ink in 1/8" safe zone', f.safe_zone_ink_pct === null ? 'n/a' : `${f.safe_zone_ink_pct}% (max ${f.max_safe_zone_ink_pct}%)`, f.safe_zone_ink_pct !== null && f.safe_zone_ink_pct > f.max_safe_zone_ink_pct);
  console.log(`   verdict: ${r.verdict === 'approve' ? green('APPROVE') : red('NEEDS CHANGES')}`);
  console.log(`\n${bold('2. Note to the customer')} ${dim(model)} ${secs(r.latencyMs)}`);
  if (r.ok) {
    console.log(wrap((r.output as ArtworkOutput).customer_note));
  } else {
    console.log(red(wrap((r.output as { error: string }).error)));
  }
}

const [mode, arg] = process.argv.slice(2);
try {
  if (mode === 'ticket') await ticket(Number(arg));
  else if (mode === 'artwork') await artwork(arg);
  else console.log('Usage: npm run demo -- ticket <id> | artwork <file>');
} finally {
  await pool.end();
}

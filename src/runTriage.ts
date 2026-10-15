// Runs the triage agent over every new ticket. Respects the roster: a
// retired agent does nothing and its tickets stay for humans.
import 'dotenv/config';
import { pool } from './db.js';
import { gql } from './tools/graphql.js';
import { triage, type TriageOutput } from './agents/triage.js';

async function main() {
  const agent = (await pool.query(`SELECT model, enabled, retired_reason FROM agents WHERE name='triage'`)).rows[0];
  if (!agent.enabled) {
    console.log(`Triage agent is retired (${agent.retired_reason}); leaving tickets for humans.`);
    return pool.end();
  }
  const model = process.env.MODEL || agent.model;
  const { tickets } = await gql<{ tickets: { id: number; body: string; customer: { name: string } }[] }>(
    `{ tickets(status:"new"){ id body customer{ name } } }`);
  const limit = Number(process.argv[2] ?? tickets.length);

  for (const t of tickets.slice(0, limit)) {
    const r = await triage(model, { id: t.id, body: t.body, customerName: t.customer.name });
    await pool.query(
      'INSERT INTO agent_runs (agent, model, ticket_id, output, ok, latency_ms, cost_usd) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      ['triage', model, t.id, JSON.stringify(r.output), r.ok, r.latencyMs, r.costUsd]);
    if (r.ok) {
      const out = r.output as TriageOutput;
      await gql(`mutation($id:Int!,$c:String!){ setTicketTriage(id:$id, category:$c){ id } }`, { id: t.id, c: out.category });
      console.log(`#${t.id} -> ${out.category}${out.urgent ? ' (URGENT)' : ''}  ${out.summary}`);
    } else {
      console.log(`#${t.id} -> FAILED: ${(r.output as { error: string }).error}`);
    }
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });

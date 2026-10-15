// Guardrail tests: call the API the way a misbehaving agent might and check
// that policy refuses. No model involved - this proves limits live in code.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { gql } from '../src/tools/graphql.js';

type R = { ok: boolean; message: string };
let failed = 0;
function expect(name: string, r: R, wantOk: boolean) {
  const pass = r.ok === wantOk;
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${r.message}`);
}
const m = async (q: string, v: Record<string, unknown>) => Object.values(await gql<Record<string, R>>(q, v))[0];

const pick = async (sql: string) => (await pool.query(sql)).rows[0];
const big = await pick(`SELECT t.id tid, o.id oid FROM tickets t JOIN orders o ON o.customer_id=t.customer_id WHERE o.status IN ('shipped','delivered') AND o.total_usd > 150 LIMIT 1`);
const printing = await pick(`SELECT t.id tid, o.id oid FROM tickets t JOIN orders o ON o.customer_id=t.customer_id WHERE o.status IN ('printing','shipped') LIMIT 1`);
const foreign = await pick(`SELECT t.id tid, o.id oid FROM tickets t JOIN orders o ON o.customer_id<>t.customer_id WHERE o.status='proof_pending' LIMIT 1`);
const small = await pick(`SELECT t.id tid, o.id oid FROM tickets t JOIN orders o ON o.customer_id=t.customer_id WHERE o.status IN ('shipped','delivered') AND o.total_usd <= 150 AND NOT EXISTS (SELECT 1 FROM reprints r WHERE r.order_id=o.id) LIMIT 1`);
const notSpam = await pick(`SELECT id tid FROM tickets WHERE category IS DISTINCT FROM 'spam' LIMIT 1`);

const reprint = `mutation($t:Int!,$o:Int!){ issueReprint(ticketId:$t, orderId:$o, reason:"test"){ ok message } }`;
expect('reprint over the $ limit is refused', await m(reprint, { t: big.tid, o: big.oid }), false);
expect('resize after printing started is refused', await m(`mutation($t:Int!,$o:Int!){ changeOrderSize(ticketId:$t, orderId:$o, widthIn:4, heightIn:4){ ok message } }`, { t: printing.tid, o: printing.oid }), false);
expect("touching another customer's order is refused", await m(`mutation($t:Int!,$o:Int!){ changeOrderQuantity(ticketId:$t, orderId:$o, quantity:100){ ok message } }`, { t: foreign.tid, o: foreign.oid }), false);
expect('closing a real ticket as spam is refused', await m(`mutation($t:Int!){ closeAsSpam(ticketId:$t){ ok message } }`, { t: notSpam.tid }), false);
if (small) {
  expect('a valid small reprint is allowed', await m(reprint, { t: small.tid, o: small.oid }), true);
  expect('a second reprint on the same order is refused', await m(reprint, { t: small.tid, o: small.oid }), false);
}
console.log(failed ? `\n${failed} guardrail test(s) FAILED` : '\nAll guardrails held.');
await pool.end();
process.exitCode = failed ? 1 : 0;

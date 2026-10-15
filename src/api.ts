// GraphQL API over the synthetic shop. Agents never touch SQL directly:
// every tool they have is a GraphQL call, so limits live in one place.
import 'dotenv/config';
import { createServer } from 'node:http';
import { createSchema, createYoga } from 'graphql-yoga';
import { pool } from './db.js';

const typeDefs = /* GraphQL */ `
  type Customer { id: Int!, name: String!, email: String!, country: String!, isVip: Boolean! }
  type Order {
    id: Int!, product: String!, widthIn: Float!, heightIn: Float!, quantity: Int!,
    totalUsd: Float!, status: String!, tracking: String, createdAt: String!, customer: Customer!
  }
  type Ticket { id: Int!, channel: String!, body: String!, status: String!, category: String, customer: Customer!, order: Order }

  type Query {
    ticket(id: Int!): Ticket
    tickets(status: String): [Ticket!]!
    order(id: Int!): Order
  }

  type ActionResult { ok: Boolean!, message: String! }

  type Mutation {
    setTicketTriage(id: Int!, category: String!): Ticket
    # Resolution actions. Every one is checked against policy here, in code:
    # a model that ignores its prompt still cannot exceed these limits.
    changeOrderSize(ticketId: Int!, orderId: Int!, widthIn: Float!, heightIn: Float!): ActionResult!
    changeOrderQuantity(ticketId: Int!, orderId: Int!, quantity: Int!): ActionResult!
    issueReprint(ticketId: Int!, orderId: Int!, reason: String!): ActionResult!
    sendReply(ticketId: Int!, body: String!): ActionResult!
    escalate(ticketId: Int!, reason: String!, summary: String!): ActionResult!
    closeAsSpam(ticketId: Int!): ActionResult!
  }
`;

const policy = async (key: string) =>
  (await pool.query('SELECT value FROM policy WHERE key=$1', [key])).rows[0]?.value as string;

// Orders the agent touches must belong to the ticket's customer: stops a model
// from "fixing" someone else's order because a number appeared in the text.
async function orderForTicket(ticketId: number, orderId: number) {
  const r = await pool.query(
    `SELECT o.*, o.total_usd::float AS total FROM orders o JOIN tickets t ON t.customer_id = o.customer_id
     WHERE t.id=$1 AND o.id=$2`, [ticketId, orderId]);
  return r.rows[0];
}

const refuse = (message: string) => ({ ok: false, message });
const done = (message: string) => ({ ok: true, message });

async function resolveTicket(ticketId: number, status: 'resolved' | 'escalated') {
  await pool.query('UPDATE tickets SET status=$2 WHERE id=$1', [ticketId, status]);
}

const actions = {
  changeOrderSize: async (_: unknown, a: { ticketId: number; orderId: number; widthIn: number; heightIn: number }) => {
    const o = await orderForTicket(a.ticketId, a.orderId);
    if (!o) return refuse(`Order ${a.orderId} does not belong to this ticket's customer.`);
    const allowed = (await policy('changeable_statuses')).split(',');
    if (!allowed.includes(o.status)) return refuse(`Order is already ${o.status}; size can only change while ${allowed.join(' or ')}. Escalate instead.`);
    if (![1, 2, 3, 4, 5, 6].includes(a.widthIn) || ![1, 2, 3, 4, 5, 6].includes(a.heightIn)) return refuse('Sizes must be whole inches from 1 to 6.');
    await pool.query('UPDATE orders SET width_in=$2, height_in=$3 WHERE id=$1', [a.orderId, a.widthIn, a.heightIn]);
    await pool.query('INSERT INTO order_changes (order_id, ticket_id, field, old_value, new_value) VALUES ($1,$2,$3,$4,$5)',
      [a.orderId, a.ticketId, 'size', `${o.width_in}x${o.height_in}`, `${a.widthIn}x${a.heightIn}`]);
    return done(`Order ${a.orderId} changed to ${a.widthIn}x${a.heightIn} in.`);
  },
  changeOrderQuantity: async (_: unknown, a: { ticketId: number; orderId: number; quantity: number }) => {
    const o = await orderForTicket(a.ticketId, a.orderId);
    if (!o) return refuse(`Order ${a.orderId} does not belong to this ticket's customer.`);
    const allowed = (await policy('changeable_statuses')).split(',');
    if (!allowed.includes(o.status)) return refuse(`Order is already ${o.status}; quantity can only change while ${allowed.join(' or ')}. Escalate instead.`);
    if (a.quantity < 1 || a.quantity > 5000) return refuse('Quantity must be between 1 and 5000.');
    await pool.query('UPDATE orders SET quantity=$2 WHERE id=$1', [a.orderId, a.quantity]);
    await pool.query('INSERT INTO order_changes (order_id, ticket_id, field, old_value, new_value) VALUES ($1,$2,$3,$4,$5)',
      [a.orderId, a.ticketId, 'quantity', String(o.quantity), String(a.quantity)]);
    return done(`Order ${a.orderId} quantity changed to ${a.quantity}.`);
  },
  issueReprint: async (_: unknown, a: { ticketId: number; orderId: number; reason: string }) => {
    const o = await orderForTicket(a.ticketId, a.orderId);
    if (!o) return refuse(`Order ${a.orderId} does not belong to this ticket's customer.`);
    if (!['shipped', 'delivered'].includes(o.status)) return refuse(`Order is ${o.status}; reprints are only for orders the customer has received.`);
    const max = Number(await policy('max_reprint_usd'));
    if (o.total > max) return refuse(`Order value $${o.total} is over the $${max} reprint limit. Escalate to a human.`);
    const dup = await pool.query('SELECT 1 FROM reprints WHERE order_id=$1', [a.orderId]);
    if (dup.rowCount) return refuse('This order has already had a reprint. Escalate to a human.');
    await pool.query('INSERT INTO reprints (order_id, ticket_id, reason, value_usd) VALUES ($1,$2,$3,$4)', [a.orderId, a.ticketId, a.reason, o.total]);
    return done(`Free reprint issued for order ${a.orderId} ($${o.total}).`);
  },
  sendReply: async (_: unknown, a: { ticketId: number; body: string }) => {
    if (a.body.trim().length < 20) return refuse('Reply is too short to be useful.');
    if (a.body.length > 1200) return refuse('Reply is too long; keep it under 1200 characters.');
    await pool.query('INSERT INTO replies (ticket_id, body) VALUES ($1,$2)', [a.ticketId, a.body]);
    // A holding reply on an escalated ticket must not mark it resolved.
    await pool.query(`UPDATE tickets SET status='resolved' WHERE id=$1 AND status <> 'escalated'`, [a.ticketId]);
    return done('Reply sent.');
  },
  escalate: async (_: unknown, a: { ticketId: number; reason: string; summary: string }) => {
    await pool.query('INSERT INTO escalations (ticket_id, reason, summary) VALUES ($1,$2,$3)', [a.ticketId, a.reason, a.summary]);
    await resolveTicket(a.ticketId, 'escalated');
    return done('Escalated to a human with your summary.');
  },
  closeAsSpam: async (_: unknown, a: { ticketId: number }) => {
    const t = (await pool.query('SELECT category FROM tickets WHERE id=$1', [a.ticketId])).rows[0];
    if (t?.category !== 'spam') return refuse('Only tickets triaged as spam can be closed without a reply.');
    await resolveTicket(a.ticketId, 'resolved');
    return done('Closed as spam.');
  },
};

const CATEGORIES = ['order_status', 'change_request', 'quality_complaint', 'refund_request', 'artwork_help', 'spam'];

const customerById = async (id: number) => {
  const r = await pool.query('SELECT id, name, email, country, is_vip AS "isVip" FROM customers WHERE id=$1', [id]);
  return r.rows[0];
};
const orderById = async (id: number) => {
  const r = await pool.query(
    `SELECT id, customer_id, product, width_in::float AS "widthIn", height_in::float AS "heightIn", quantity,
            total_usd::float AS "totalUsd", status, tracking, created_at::text AS "createdAt"
     FROM orders WHERE id=$1`, [id]);
  return r.rows[0];
};
// expected_category is deliberately NOT selected: agents must never see the answer key.
const TICKET_COLS = 'id, customer_id, order_id, channel, body, status, category';

const resolvers = {
  Query: {
    ticket: async (_: unknown, { id }: { id: number }) =>
      (await pool.query(`SELECT ${TICKET_COLS} FROM tickets WHERE id=$1`, [id])).rows[0],
    tickets: async (_: unknown, { status }: { status?: string }) =>
      (await pool.query(`SELECT ${TICKET_COLS} FROM tickets WHERE ($1::text IS NULL OR status::text=$1) ORDER BY id`, [status ?? null])).rows,
    order: async (_: unknown, { id }: { id: number }) => orderById(id),
  },
  Mutation: {
    setTicketTriage: async (_: unknown, { id, category }: { id: number; category: string }) => {
      if (!CATEGORIES.includes(category)) throw new Error(`Unknown category ${category}`);
      const r = await pool.query(
        `UPDATE tickets SET category=$2, status='triaged' WHERE id=$1 RETURNING ${TICKET_COLS}`, [id, category]);
      return r.rows[0];
    },
    ...actions,
  },
  Ticket: {
    customer: (t: { customer_id: number }) => customerById(t.customer_id),
    order: (t: { order_id: number | null }) => (t.order_id ? orderById(t.order_id) : null),
  },
  Order: {
    customer: (o: { customer_id: number }) => customerById(o.customer_id),
  },
};

export const yoga = createYoga({ schema: createSchema({ typeDefs, resolvers }) });

const port = Number(process.env.PORT ?? 4000);
createServer(yoga).listen(port, () => console.log(`GraphQL API on http://localhost:${port}/graphql`));

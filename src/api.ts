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

  type Mutation {
    setTicketTriage(id: Int!, category: String!): Ticket
  }
`;

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

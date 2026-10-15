// Fills the synthetic shop with customers, orders and messy support tickets.
// Deterministic (fixed seed) so demos and evals are repeatable.
import 'dotenv/config';
import { faker } from '@faker-js/faker';
import { pool } from './db.js';

faker.seed(42);

const PRODUCTS = ['die_cut_sticker', 'kiss_cut_sticker', 'roll_labels', 'magnet'] as const;
const STATUSES = ['proof_pending', 'approved', 'printing', 'shipped', 'delivered'] as const;
const SIZES = [2, 3, 4, 5];

// Ticket templates per category. {id} is replaced with the customer's order number.
const TEMPLATES: Record<string, string[]> = {
  order_status: [
    'hey where is my order #{id}?? its been ages',
    'Hi, could you tell me when order {id} will ship? Need them for an event on Saturday.',
    'tracking for #{id} hasnt updated in 4 days, is it lost',
  ],
  change_request: [
    'can i change my stickers on order {id} to 4 inch instead of 3?',
    'Hi! I need to bump the quantity on #{id} from 50 to 100 if its not printed yet',
    'oops wrong size on order {id}, meant 2x2 not 3x3. can u fix',
  ],
  quality_complaint: [
    'my stickers from order {id} came out blurry and the colours are way off',
    'Order #{id} arrived and half of them are peeling at the edges. Not happy.',
    'the cut line on #{id} is cutting into my logo, can you reprint',
  ],
  refund_request: [
    'I want a full refund for order {id}, never ordering again',
    'please refund #{id}, I was charged twice',
    'cancel and refund order {id} please, we dont need them anymore',
  ],
  artwork_help: [
    'what file type should I upload? I only have a jpeg from my phone',
    'can you make my background transparent before printing?',
    'is 72dpi ok for 5 inch stickers',
  ],
  spam: [
    'BEST SEO SERVICES rank #1 on google cheap!!! reply now',
    'Congratulations you have won a gift card, click here to claim',
  ],
};

async function main() {
  await pool.query('TRUNCATE agent_runs, tickets, orders, customers RESTART IDENTITY CASCADE');

  const customerIds: number[] = [];
  for (let i = 0; i < 60; i++) {
    const r = await pool.query(
      'INSERT INTO customers (name, email, country, is_vip) VALUES ($1,$2,$3,$4) RETURNING id',
      [faker.person.fullName(), faker.internet.email().toLowerCase(), faker.location.countryCode(), faker.number.float() < 0.1],
    );
    customerIds.push(r.rows[0].id);
  }

  const orders: { id: number; customer_id: number }[] = [];
  for (let i = 0; i < 150; i++) {
    const size = faker.helpers.arrayElement(SIZES);
    const qty = faker.helpers.arrayElement([50, 100, 200, 500, 1000]);
    const status = faker.helpers.arrayElement(STATUSES);
    const r = await pool.query(
      `INSERT INTO orders (customer_id, product, width_in, height_in, quantity, total_usd, status, tracking, created_at)
       VALUES ($1,$2,$3,$3,$4,$5,$6,$7, now() - ($8 || ' days')::interval) RETURNING id, customer_id`,
      [
        faker.helpers.arrayElement(customerIds),
        faker.helpers.arrayElement(PRODUCTS),
        size,
        qty,
        (qty * size * 0.18).toFixed(2),
        status,
        status === 'shipped' || status === 'delivered' ? faker.string.alphanumeric(12).toUpperCase() : null,
        faker.number.int({ min: 1, max: 30 }),
      ],
    );
    orders.push(r.rows[0]);
  }

  let n = 0;
  for (const [category, bodies] of Object.entries(TEMPLATES)) {
    for (let i = 0; i < 10; i++) {
      const order = faker.helpers.arrayElement(orders);
      const needsOrder = category !== 'artwork_help' && category !== 'spam';
      const body = faker.helpers.arrayElement(bodies).replace('{id}', String(order.id));
      await pool.query(
        'INSERT INTO tickets (customer_id, order_id, body, expected_category) VALUES ($1,$2,$3,$4)',
        [order.customer_id, needsOrder ? order.id : null, body, category],
      );
      n++;
    }
  }

  console.log(`Seeded ${customerIds.length} customers, ${orders.length} orders, ${n} tickets.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });

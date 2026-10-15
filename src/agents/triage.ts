// Triage agent: reads a support ticket, looks up the order if one is
// mentioned, and classifies it. It only *decides*; the caller writes the
// result back through the API, so a bad model can't corrupt data.
import { z } from 'zod';
import { runAgent } from './runAgent.js';
import { getOrder } from '../tools/graphql.js';

export const CATEGORIES = ['order_status', 'change_request', 'quality_complaint', 'refund_request', 'artwork_help', 'spam'] as const;

export const TriageOutput = z.object({
  category: z.enum(CATEGORIES),
  confidence: z.number().min(0).max(1),
  order_id: z.number().int().nullable(),
  summary: z.string().max(200),
  urgent: z.boolean(),
});
export type TriageOutput = z.infer<typeof TriageOutput>;

const SYSTEM = `You are the triage agent for a custom sticker shop's support inbox.
Classify each ticket into exactly one category:
- order_status: where is my order, shipping, tracking, delivery timing
- change_request: change size, quantity or details of an order
- quality_complaint: print, colour, cut or material problems with received stickers
- refund_request: wants money back or to cancel for a refund
- artwork_help: questions about files, resolution, backgrounds, design
- spam: unsolicited marketing, scams, nothing to do with an order
If the ticket mentions an order number, call get_order to check it (status matters:
a change request on an order that is already printing or shipped is still change_request,
but mark urgent=true). Mark urgent=true for VIP customers, events with deadlines, or
double charges.
Output JSON: {"category", "confidence" (0-1), "order_id" (number or null), "summary" (one short sentence), "urgent" (boolean)}.`;

export function triage(model: string, ticket: { id: number; body: string; customerName: string }) {
  return runAgent({
    model,
    system: SYSTEM,
    user: `Ticket #${ticket.id} from ${ticket.customerName}:\n"""${ticket.body}"""`,
    tools: [getOrder],
    schema: TriageOutput,
  });
}

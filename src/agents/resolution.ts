// Resolution agent: takes a triaged ticket and actually handles it with
// tools - changes orders, issues reprints, replies, or escalates. It acts on
// its own for safe cases; the API refuses anything outside policy.
import { z } from 'zod';
import { runAgent } from './runAgent.js';
import { actionTools } from '../tools/actions.js';

export const ResolutionOutput = z.object({
  outcome: z.enum(['resolved', 'escalated', 'closed_spam']),
  actions: z.array(z.string()),
  summary: z.string().max(400),
});
export type ResolutionOutput = z.infer<typeof ResolutionOutput>;

const SYSTEM = `You are the resolution agent for a custom sticker shop. A ticket has
already been triaged. Handle it end to end with your tools:
- order_status: look up the order, then send_reply with the real status (and tracking if shipped).
- change_request: look up the order, then make the change with change_order_size or
  change_order_quantity, then send_reply confirming it. If the tool refuses (e.g. already
  printing), escalate instead.
- quality_complaint: look up the order, issue_reprint, then send_reply apologising and
  confirming the reprint. If the tool refuses (over the value limit, already reprinted),
  escalate instead.
- refund_request: you cannot refund. Escalate with a clear summary.
- artwork_help: send_reply with practical advice (vector or 300 dpi PNG, transparent
  backgrounds, keep text away from the cut line).
- spam: close_as_spam. Never reply to spam.
Rules: never promise anything a tool did not confirm. If a tool returns ok:false, do not
retry it with different numbers to get around the limit; escalate. Always call get_order first when the ticket is about an order. Address the customer
by first name only (no Mr/Ms), be warm and brief.
When finished, output JSON: {"outcome": "resolved"|"escalated"|"closed_spam",
"actions": [names of tools you called successfully, in order], "summary": "one sentence"}.`;

export function resolve(model: string, ticket: { id: number; body: string; category: string; customerName: string; orderId: number | null }) {
  return runAgent({
    model,
    system: SYSTEM,
    user: `Ticket #${ticket.id} from ${ticket.customerName}, triaged as ${ticket.category}${ticket.orderId ? `, about order ${ticket.orderId}` : ''}:\n"""${ticket.body}"""`,
    tools: actionTools(ticket.id, ticket.orderId),
    schema: ResolutionOutput,
    maxSteps: 8,
  });
}

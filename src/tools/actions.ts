// Action tools for the resolution agent. Each wraps a guarded GraphQL
// mutation; when policy refuses, the agent sees why and can escalate.
import { gql, getOrder, type Tool } from './graphql.js';

type Result = { ok: boolean; message: string };
const call = async (name: string, sig: string, args: string, vars: Record<string, unknown>) =>
  (await gql<Record<string, Result>>(`mutation(${sig}){ ${name}(${args}){ ok message } }`, vars))[name];

// Tools for one ticket. `orderId` is the order the ticket is about (if any):
// the agent must look it up before replying, enforced here rather than in the
// prompt, because a model that answers from memory invents order details.
export type TrailEntry = { tool: string; ok: boolean; message: string };

export const actionTools = (ticketId: number, orderId: number | null, trail: TrailEntry[] = []): Tool[] => {
  let looked = orderId == null;
  const lookup: Tool = { ...getOrder, run: async (a) => { looked = true; return getOrder.run(a); } };
  // Every action's real result is recorded, so the caller can check the
  // agent's own report against what actually happened.
  const record = (tool: Tool): Tool => ({ ...tool, run: async (a) => {
    const r = (await tool.run(a)) as { ok: boolean; message: string };
    trail.push({ tool: tool.name, ok: r.ok, message: r.message });
    return r;
  } });
  return [
  lookup,
  ...(<Tool[]>[
  {
    name: 'change_order_size',
    description: 'Change the sticker size on an order. Only allowed before printing starts.',
    parameters: { type: 'object', properties: { order_id: { type: 'integer' }, width_in: { type: 'number' }, height_in: { type: 'number' } }, required: ['order_id', 'width_in', 'height_in'] },
    run: (a) => call('changeOrderSize', '$t:Int!,$o:Int!,$w:Float!,$h:Float!', 'ticketId:$t, orderId:$o, widthIn:$w, heightIn:$h', { t: ticketId, o: a.order_id, w: a.width_in, h: a.height_in }),
  },
  {
    name: 'change_order_quantity',
    description: 'Change the quantity on an order. Only allowed before printing starts.',
    parameters: { type: 'object', properties: { order_id: { type: 'integer' }, quantity: { type: 'integer' } }, required: ['order_id', 'quantity'] },
    run: (a) => call('changeOrderQuantity', '$t:Int!,$o:Int!,$q:Int!', 'ticketId:$t, orderId:$o, quantity:$q', { t: ticketId, o: a.order_id, q: a.quantity }),
  },
  {
    name: 'issue_reprint',
    description: 'Issue a free reprint for a quality problem on an order the customer has received. Subject to a value limit and one reprint per order.',
    parameters: { type: 'object', properties: { order_id: { type: 'integer' }, reason: { type: 'string' } }, required: ['order_id', 'reason'] },
    run: (a) => call('issueReprint', '$t:Int!,$o:Int!,$r:String!', 'ticketId:$t, orderId:$o, reason:$r', { t: ticketId, o: a.order_id, r: a.reason }),
  },
  {
    name: 'send_reply',
    description: 'Send the customer a reply and mark the ticket resolved. Use this last, after any actions.',
    parameters: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
    run: (a) => looked
      ? call('sendReply', '$t:Int!,$b:String!', 'ticketId:$t, body:$b', { t: ticketId, b: a.body })
      : Promise.resolve({ ok: false, message: `Refused: look up order ${orderId} with get_order before replying, so the reply uses real order details.` }),
  },
  {
    name: 'escalate',
    description: 'Hand the ticket to a human with a short summary. Use for refunds, anything a tool refused, anything risky or unclear.',
    parameters: { type: 'object', properties: { reason: { type: 'string' }, summary: { type: 'string' } }, required: ['reason', 'summary'] },
    run: (a) => call('escalate', '$t:Int!,$r:String!,$s:String!', 'ticketId:$t, reason:$r, summary:$s', { t: ticketId, r: a.reason, s: a.summary }),
  },
  {
    name: 'close_as_spam',
    description: 'Close a spam ticket without replying.',
    parameters: { type: 'object', properties: {}, required: [] },
    run: () => call('closeAsSpam', '$t:Int!', 'ticketId:$t', { t: ticketId }),
  },
]).map(record),
  ];
};

// Tools available to agents. Each is a thin GraphQL call with a JSON-schema
// description the model sees. Limits are enforced by the API, not by prompts.
const API = process.env.API_URL ?? 'http://localhost:4000/graphql';

export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data as T;
}

export type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: any) => Promise<unknown>;
};

export const getOrder: Tool = {
  name: 'get_order',
  description: 'Look up an order by its number: product, size, quantity, total, status (proof_pending, approved, printing, shipped, delivered) and tracking.',
  parameters: { type: 'object', properties: { order_id: { type: 'integer' } }, required: ['order_id'] },
  run: async ({ order_id }: { order_id: number }) =>
    (await gql<{ order: unknown }>(
      `query($id:Int!){ order(id:$id){ id product widthIn heightIn quantity totalUsd status tracking createdAt customer{ name isVip } } }`,
      { id: order_id })).order ?? { error: `No order ${order_id}` },
};

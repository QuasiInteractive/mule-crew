// A small, provider-agnostic agent loop: the model can call tools until it
// returns a final JSON answer, which must pass a zod schema. Works with any
// model on OpenRouter (Claude, GPT, Grok, Llama...) by changing one string.
import OpenAI from 'openai';
import { z } from 'zod';
import type { Tool } from '../tools/graphql.js';

const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  // Retries 429s and 5xx with exponential back-off, honouring Retry-After.
  maxRetries: 6,
});

// Pace calls so a new account stays under per-minute rate limits.
const MIN_GAP_MS = Number(process.env.MIN_GAP_MS ?? 1500);
let nextSlot = 0;
async function paced() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_GAP_MS;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

export type AgentResult<T> = {
  ok: boolean;
  output: T | { error: string };
  latencyMs: number;
  costUsd: number | null;
  toolCalls: number;
  // True when the provider failed (credits, rate limit, outage), as opposed to
  // the model giving a bad answer. Evals exclude these from accuracy.
  providerError?: boolean;
};

export async function runAgent<T>(opts: {
  model: string;
  system: string;
  user: string;
  tools: Tool[];
  schema: z.ZodType<T>;
  maxSteps?: number;
  maxTokens?: number;
}): Promise<AgentResult<T>> {
  try {
    return await loop(opts);
  } catch (e) {
    // A provider error (rate limit, credits, outage) fails this run, not the batch.
    return { ok: false, output: { error: (e as Error).message.slice(0, 300) }, latencyMs: 0, costUsd: null, toolCalls: 0, providerError: true };
  }
}

async function loop<T>(opts: Parameters<typeof runAgent<T>>[0]): Promise<AgentResult<T>> {
  const started = Date.now();
  let cost = 0;
  let toolCalls = 0;
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: opts.system + '\n\nWhen you are done, reply with ONLY a JSON object matching the required output. No prose.' },
    { role: 'user', content: opts.user },
  ];

  for (let step = 0; step < (opts.maxSteps ?? 5); step++) {
    await paced();
    const res = await client.chat.completions.create({
      model: opts.model,
      messages,
      // Agents answer in short JSON; without a cap some providers reserve
      // their whole output window per call, which burns credit limits.
      max_tokens: opts.maxTokens ?? 800,
      tools: opts.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      // OpenRouter extension: include the real $ cost of each call in usage.
      // @ts-expect-error not in the OpenAI types
      usage: { include: true },
    });
    cost += Number((res.usage as any)?.cost ?? 0);
    const msg = res.choices[0].message;
    messages.push(msg);

    if (msg.tool_calls?.length) {
      for (const call of msg.tool_calls) {
        if (call.type !== 'function') continue;
        toolCalls++;
        const tool = opts.tools.find((t) => t.name === call.function.name);
        let result: unknown;
        try {
          result = tool ? await tool.run(JSON.parse(call.function.arguments || '{}')) : { error: `Unknown tool ${call.function.name}` };
        } catch (e) {
          result = { error: (e as Error).message };
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
      continue;
    }

    const text = (msg.content ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    const parsed = (() => { try { return opts.schema.safeParse(JSON.parse(text)); } catch { return null; } })();
    return parsed?.success
      ? { ok: true, output: parsed.data, latencyMs: Date.now() - started, costUsd: cost, toolCalls }
      : { ok: false, output: { error: `Invalid output: ${text.slice(0, 200)}` }, latencyMs: Date.now() - started, costUsd: cost, toolCalls };
  }
  return { ok: false, output: { error: 'Ran out of steps' }, latencyMs: Date.now() - started, costUsd: cost, toolCalls };
}

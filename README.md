# Mule Crew

A small crew of AI agents running a **synthetic** sticker shop, with a scoreboard that measures each agent per model and retires the ones that stop delivering.

Built as a demo for an "agent engineer" role. All data is fake (seeded), modelled on public sticker products. Built with AI-assisted development (Claude Code), reviewed and tested by me.

## Stack
TypeScript, Postgres, GraphQL (graphql-yoga), OpenRouter (Claude / GPT / Grok / Llama behind one API), zod-validated agent outputs. Go eval runner and Cloud Run deploy: in progress.

## Run it
```
cp .env.example .env        # add your OpenRouter key
npm install
npm run db:up               # Postgres in Docker on :5544
npm run seed                # 60 customers, 150 orders, 60 messy tickets
npm run api                 # GraphQL on :4000/graphql
npm run triage -- 5         # triage the first 5 new tickets
npm run eval -- <model> <model> ...   # scoreboard across models
```

## Design notes
- Agents never touch SQL. Every tool is a GraphQL call, so limits live in one place.
- Agents only decide; code acts. The triage agent returns JSON that must pass a zod schema before anything is written.
- Every run is logged to `agent_runs` (model, output, valid?, latency, real $ cost).
- The answer key (`expected_category`) is never exposed through the API.
- The `agents` table is the roster: a retired agent does nothing and its work stays with humans.

## Results so far (triage agent, 60 seeded tickets)

| Model | Accuracy | Valid output | Self-corrected | $ / 100 tickets | Avg time |
|---|---|---|---|---|---|
| qwen3.5 9B, local via Ollama (no self-correction) | 88.3% | 88.3% | - | $0.00 | 10.4s |
| qwen3.5 9B, local via Ollama (with self-correction) | **98.3%** | **100%** | 3 | $0.00 | 14.1s |

What the scoreboard showed:
- Without self-correction, every one of qwen's 7 failures had the **right category** but a bad format (6 times it dropped the required `urgent` field, once it wrote invalid JSON). Its judgement was fine; its formatting wasn't.
- Fix: when an answer fails validation, the agent gets the exact error back ("urgent: Required") and one chance to correct it. Format failures went to zero.
- The one remaining miss is a genuinely ambiguous ticket: "the cut line on #54 is cutting into my logo, can you reprint" was read as a change request rather than a quality complaint.

Hosted models (Claude Sonnet 5.5, GPT-6.1, Grok 4.7, Llama 4 Maverick via OpenRouter) were also run, but a new account's credit and rate limits cut those runs short; the retry/back-off and provider-error accounting in `runAgent.ts` came out of that. Claude answered ~10 of its first 11 tickets correctly at about $0.005 per ticket before the limits hit.

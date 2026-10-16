# Mule Crew

A small crew of AI agents running a **synthetic** sticker shop, with a scoreboard that measures each agent per model and retires the ones that stop delivering.

Built as a demo for an "agent engineer" role. All data is fake (seeded), modelled on public sticker products. Built with AI-assisted development (Claude Code), reviewed and tested by me.

## Stack
TypeScript, Postgres, GraphQL (graphql-yoga), OpenRouter (Claude / GPT / Grok / Llama behind one API), zod-validated agent outputs. Models with an `ollama/` prefix run locally (qwen3.5 9B on an RTX 4060, $0). Go eval runner and Cloud Run deploy: in progress.

## Run it
```
cp .env.example .env        # add your OpenRouter key
npm install
npm run db:up               # Postgres in Docker on :5544
npm run seed                # 60 customers, 150 orders, 60 messy tickets
npm run api                 # GraphQL on :4000/graphql
npm run triage -- 5         # triage the first 5 new tickets
npm run eval -- <model> <model> ...   # triage scoreboard across models
npm run resolve-eval -- <model>       # resolution scoreboard (resets the shop)
npm run guardrails                    # attack the API's limits directly
npm run artwork-eval -- <model>       # artwork proofing scoreboard
npm run retire [-- --dry-run]         # retire agents below their success threshold
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

## Day 2: resolution agent (acts on its own, inside hard limits)

The resolution agent takes a triaged ticket and handles it with tools: look up the order, change size or quantity, issue a free reprint, reply, close spam, or escalate to a human with a summary.

Limits live in the API, not the prompt (`npm run guardrails` attacks them directly; all 6 hold):
- size/quantity changes only before printing; reprints only for received orders, under $150, once per order
- an agent can only touch the ticket customer's own orders; only spam-triaged tickets can be closed without a reply
- refunds have no tool at all, so they always reach a human
- **look before you reply**: the reply tool refuses until the order has been looked up (added after the agent answered one ticket from memory and invented the order's size)
- **trust but verify**: every tool result is recorded, and if the agent's report claims an action that didn't actually succeed, the run is failed (added after the agent twice reported "reply sent" when the reply had been refused)

| Model | Correct handling | Unsafe actions | Avg time | Cost |
|---|---|---|---|---|
| qwen3.5 9B, local via Ollama | **96.7%** (58/60) | **0** | 24.7s | $0 |

The 2 misses were the "reply sent" claims above, which is what led to the verification step.

## Artwork agent: the scoreboard took the decision away from the model

Proofing checks a customer's upload before it goes to print. The test set (`py eval/make_artwork.py`) is 32 labelled sticker files: 10 clean and 22 with defects. The defects are low resolution, a background that wasn't removed, text on the cut line, a small image blown up, and text too pale to read. `npm run artwork-eval -- <model>` scores it.

The first version let the vision model (qwen3.5 9B, local) decide, with code-measured resolution and transparency as facts. The scoreboard showed where it fell short:

| Version | Verdict right | Bad files approved | Good files rejected | Visual defects caught by the model |
|---|---|---|---|---|
| v1: model decides | 71.9% | **7** | 2 | 5/14 |
| v2: + blur & contrast measured | 78.1% | 4 | 2 | text on cut line: **0/5** |
| v3: + safe-zone measured, model as "second eyes" | 90.6% | 0 | 2 | (its additions: 6 invented issues) |
| **v4: code decides, model explains** | **100%** | **0** | **0** | n/a |

Every check is now a standard preflight measurement, with limits in the `policy` table:
- dpi at the ordered size (150)
- transparency at the edge
- edge sharpness relative to the design's tonal range (0.4, which catches upscaled files whose dpi number looks fine)
- WCAG contrast (3:1)
- ink inside the 1/8" safe zone of the cut line (1%)

The model does the part it's good at. It looks at the proof and writes the customer a plain note saying what's wrong and how to fix it. Its extra concerns go to a human as advisory notes and never block an order.

The model is still scored, on its notes. A note fails if it leaves out an issue, or tells the customer a rejected file "is ready to print". qwen: **96.9%** of notes complete, 0 false concerns on 10 clean files, 1.6s per file, $0. The one failure really did open with "Your sticker file is ready to print, but…". The grader also caught a note that told a customer to *brighten* text that was already too pale.

Caveat: the files are synthetic, so the measurements separate them cleanly (e.g. sharpness ≤0.11 vs ≥0.89). Real uploads like photos, gradients and deliberate dark outlines would need the limits tuned on real data, and the safe-zone check would flag an intentional border.

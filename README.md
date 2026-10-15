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

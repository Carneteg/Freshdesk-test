# Freshdesk AI suggested replies — Gate 1

A background job that watches **one agent's** Freshdesk tickets, drafts a
suggested reply grounded in the knowledge base, and posts it as a **private
note**. The agent judges each one — "would I have sent this?" — and the
`gate1_scorecard` view turns those judgements into a usable-percentage.

This is a two-week experiment, not a product. Read [`CLAUDE.md`](./CLAUDE.md)
first — it holds the decisions, the build order, and the resolved design
questions (§12). This README is just setup + how to run.

## Layout

```
supabase/migrations/01_init.sql                    suggestions table + evaluation views
supabase/functions/ticket-suggester/
    index.ts        polling loop + pipeline (analyse → retrieve → draft → verify → post)
    clients.ts      Freshdesk + Claude clients (timeouts, 429 handling)
    prompts.ts      the three prompts  ← the product
    render.ts       pure helpers (extractJSON, strip, esc, renderNote, …)
    render_test.ts  unit tests for the pure helpers
scripts/replay.ts   run closed tickets through the pipeline, post nothing
```

## Prerequisites

- [Deno](https://deno.land) 1.44+
- A Freshdesk API key for the single monitored agent (**Tobias Carneteg**)
- An Anthropic API key
- A Supabase project — **Frankfurt / EU Central** (region is permanent)
  - Provisioned: **`simployer-ticket-suggester`** — ref `pqwnpcibymtmcpnqlkle`,
    region `eu-central-1`, URL `https://pqwnpcibymtmcpnqlkle.supabase.co`.
    Schema `01_init.sql` is already applied; `suggestions` has RLS enabled and
    the evaluation views run `security_invoker`.

## Setup

```bash
cp .env.example .env      # then fill it in
deno task check           # typecheck
deno task test            # unit tests for the pure functions
```

Apply the schema (via the Supabase SQL editor, or the CLI):

```bash
supabase db push          # applies supabase/migrations/01_init.sql
```

## The build order (from CLAUDE.md §6 — do not skip ahead)

1. **Verify the Freshdesk API.** The client was written from docs, not a live
   instance. `searchSolutions` / `searchTickets` are explicitly marked
   `UNVERIFIED` in `clients.ts` — confirm them first and fix the client to match.
2. **Minimal end-to-end.** `WITH_RETRIEVAL=false` — ticket in → Claude → note out.
3. **Add retrieval.** Before trusting past tickets, check ten resolved ones (see
   §6 Step 3). Past-ticket search is intentionally left out of `retrieve()` until
   that check passes; KB solutions only for now.
4. **Replay.** See below. This is how quality gets judged.
5. **Schedule.** Only after replay looks reasonable (see Scheduling).

## Running the replay harness (Step 4)

Nothing is posted. Start with **5** closed tickets whose answer you know; the
chosen ids + subjects are printed before anything is sent to Anthropic.

```bash
deno task replay 1001 1002 1003 1004 1005
# or
REPLAY_TICKET_IDS=1001,1002,1003,1004,1005 deno task replay
```

For each ticket it prints the suggestion (with confidence + sources) next to
what the agent actually sent, so you can compare.

## Running the poller locally

```bash
deno task serve
# then, in another shell:
curl -H "x-cron-secret: $CRON_SECRET" http://localhost:8000/
```

## Deploy + schedule (Step 5)

```bash
supabase functions deploy ticket-suggester
```

Then schedule it with `pg_cron` (every minute) so it calls the function with the
`x-cron-secret` header. Do this **last**, only after replay results look
reasonable:

```sql
select cron.schedule(
  'ticket-suggester',
  '* * * * *',
  $$ select net.http_post(
       url    := 'https://<project-ref>.functions.supabase.co/ticket-suggester',
       headers:= jsonb_build_object('x-cron-secret', '<CRON_SECRET>')
     ); $$
);
```

## Evaluating

Record each verdict on the `suggestions` row (`usable` / `edited` / `unusable`),
then read the views:

```sql
select * from gate1_scorecard;   -- usable-% per prompt version
select * from calibration;       -- watch the (high, unusable) cell (§8)
select * from failures;          -- every crashed run, never silent (§10)
```

After any prompt change, bump `PROMPT_VERSION` in `prompts.ts` and re-run the
**same** tickets so `gate1_scorecard` is comparable across versions.

## Data protection

Ticket content may contain employee personal data. The DPA position on Anthropic
and Supabase is confirmed OK for Gate 1 (CLAUDE.md §11–§12). Any move to a new
data source, or to live/production beyond this experiment, needs its own sign-off.

# Freshdesk AI Coach — Gate 1

An internal Simployer experiment that watches a small, named set of Freshdesk
agents and posts a private AI coaching note on a new customer turn.

The coach:

1. extracts what is verified in the ticket;
2. retrieves relevant approved knowledge;
3. proposes agent checks, routing, and next steps;
4. writes a customer-ready reply only when it is genuinely grounded;
5. abstains when the cause or action is not established.

It never sends a customer reply. The only live Freshdesk writes are one private
note and up to three merged keyword tags on the same ticket.

Read `CLAUDE.md` for project rules and `docs/DECISIONS.md` for current technical
decisions. Deployment is blocked until every gate in `GOLIVE.md` is complete.

## Architecture

Three systems only:

- Freshdesk — trigger, ticket data, KB, private note, tags;
- Supabase Frankfurt — Edge Functions, Postgres, review/auth, cron;
- OpenAI — analyse, draft, verify, offline QA.

See:

- `docs/ARCHITECTURE.md`
- `docs/SECURITY.md`
- `docs/EVALUATION.md`
- `docs/OPERATIONS.md`

## Reliability model

Each generation is immutable and uniquely identified by:

```text
ticket_id
+ trigger_message_id
+ prompt_version
+ model
+ run_variant
```

The live poller:

- paginates all Freshdesk updates from a durable cursor;
- writes monitored events to a database queue before advancing the cursor;
- uses a database lease to prevent overlapping runs;
- reserves a generation before calling OpenAI;
- stores the exact private note in an outbox;
- disables automatic retries for `POST /notes`;
- embeds a unique marker and checks it before any recovery POST;
- stores human reviews separately in `suggestion_reviews`.

## Repository layout

```text
supabase/functions/ticket-suggester/
  index.ts       cursor, queue, reservation, outbox, live delivery
  clients.ts     Freshdesk + OpenAI clients
  pipeline.ts    analyse → retrieve → draft → verify
  prompts.ts     product behaviour
  render.ts      deterministic safety/rendering helpers

supabase/functions/feedback/
  index.ts       confirmation-only legacy feedback path

supabase/migrations/
  31_p0_reliability.sql  immutable runs, reviews, outbox, cursor, queue, lease

scripts/
  replay.ts              offline evaluation; never posts to Freshdesk
  score_history.ts       offline agent-reply QA triage
  sync_tickets.ts        semantic precedent index
  assign_cohorts.ts      locked learning/development/holdout split
  knowledge_gaps.ts      missing-knowledge report

web/review.html           authenticated, RLS-gated review app
supabase/functions/review-ui/
                          compatibility redirect to REVIEW_APP_URL
```

## Requirements

- Deno `2.9.4` (CI is pinned to the same version);
- Freshdesk service-account API key;
- OpenAI API key;
- Supabase project in Frankfurt / EU Central;
- DPA approval for the current OpenAI + Supabase data flow.

Supabase JS imports are pinned to `2.110.8`.

## Local setup

```bash
cp .env.example .env
deno task check
deno task test
```

Never commit `.env` or credentials.

## Database

Apply migrations in order. Migration 31 must be applied before deploying code
that uses the durable queue/outbox or separate review RPCs.

```bash
supabase db push
```

Do not apply migration 15's production schedule until `GOLIVE.md` is complete.

## Replay: preview, approve, run

Replay reads closed tickets and writes evaluation rows to Supabase. It never
posts a note or tag. Real ticket content is sent to OpenAI only after approval.

First command — read-only preview:

```bash
deno task replay 1001 1002 1003 1004 1005
```

The script prints the selected IDs and subjects, then stops. After approving the
sample, rerun:

```bash
REPLAY_APPROVED=true deno task replay 1001 1002 1003 1004 1005
```

Replay uses `INSERT`, never `UPSERT`. If the same immutable generation already
exists, it is reported and left unchanged.

## GitHub batch jobs

The manual `Batch jobs` workflow supports replay, score-history, sync-tickets,
assign-cohorts, and knowledge-gaps.

Cloud jobs set `CLOUD_LOG_MODE=safe`; Actions logs and summaries exclude ticket
subjects, customer/agent text, drafts, and source excerpts. For replay, first run
with `approved_sample=false`, inspect the preview, then rerun the same sample with
`approved_sample=true`.

The production repository/environment should require manual approval before
workflows receive service-role or production credentials.

## Review

New private notes link to the authenticated Coach Review app. Browser writes use
narrow RPCs:

- `submit_generation_verdict`
- `save_generation_gold_answer`
- `mark_generation_spam`

RLS plus `app_reviewers` is the authorization boundary. New notes contain a safe
generation ID deep-link, not a bearer-like token or verdict in the URL.

Legacy feedback links remain confirmation-only: GET displays a page; POST consumes
the scoped token once.

## Evaluation

The human verdict remains the gold standard. Read overall figures together with:

```sql
select * from gate1_scorecard;
select * from gate1_scorecard_by_cohort;
select * from coach_mode_scorecard;
select * from calibration;
select * from qa_scorecard;
select * from knowledge_gaps;
```

The key safety measures are reply-ready precision, false-green rate, abstention
accuracy, and critical error rate. Critical legal/deletion/access/PII/false-promise
errors should be effectively zero before a wider pilot.

## Current blockers

- confirm and document OpenAI-key rotation/revocation;
- decide legal retention and deletion propagation;
- validate migration 31 in a non-production Supabase environment;
- complete the supervised dry-run and synthetic marker-recovery test.

Until then: keep cron paused and `DRY_RUN=true`.

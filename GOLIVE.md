# Go-live runbook — Gate 1 ticket-suggester

The production scheduler must remain paused until every gate below is checked.
Nothing in this runbook authorizes a broad agent rollout or a customer-facing reply.

## 0. Blocking gates

- [x] OpenAI + Supabase DPA confirmed for Gate 1.
- [ ] The exposed OpenAI key is confirmed rotated and the old key revoked.
- [ ] Migration `31_p0_reliability.sql` has been reviewed and applied.
- [ ] CI passes on the exact commit being deployed.
- [ ] `REVIEW_APP_URL` points to the authenticated, RLS-gated Coach Review app.
- [ ] The first replay sample has been previewed, approved, run, and reviewed.
- [ ] A supervised `DRY_RUN=true` poll shows the correct named agents only.
- [ ] The note-marker recovery test has passed on a synthetic/test ticket.

If any gate is open, keep `DRY_RUN=true` and do not schedule the function.

## 1. Apply schema before code

Apply migrations through `31_p0_reliability.sql` before deploying the new function.
Migration 31 changes the runtime contract:

- immutable generation identity: ticket + trigger + prompt + model + variant;
- separate `suggestion_reviews`;
- delivery outbox states (`reserved → generated → posting → posted`);
- durable poll cursor + queue;
- distributed poll lease;
- authenticated review RPCs.

Verify:

```sql
select to_regclass('public.suggestion_reviews');
select to_regclass('public.ticket_poll_queue');
select to_regclass('public.poll_cursors');
select to_regclass('public.poll_leases');
```

Every query must return a relation name.

## 2. Configure secrets

Set these in the Supabase Edge Function environment:

```text
FRESHDESK_DOMAIN=simployer
FRESHDESK_API_KEY=<service-account key>
MY_AGENT_ID=<comma-separated named agent ids>
EXPECTED_AGENT_NAME=Tobias Carneteg
OPENAI_API_KEY=<rotated key>
OPENAI_MODEL=gpt-4o
CRON_SECRET=<random secret>
REVIEW_APP_URL=<authenticated Coach Review URL>
DRY_RUN=true
MAX_PER_RUN=5
BOOTSTRAP_LOOKBACK_MINUTES=60
POLL_STREAM=ticket-suggester-v1
POLL_LEASE_SECONDS=180
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase.

## 3. Deploy without scheduling

Deploy `ticket-suggester` first. Deploy `feedback` only to support legacy notes;
new notes use the authenticated review app and carry no write token.

```bash
supabase functions deploy ticket-suggester --no-verify-jwt
supabase functions deploy feedback --no-verify-jwt
```

## 4. Supervised dry run

Invoke once with the cron secret while `DRY_RUN=true`.

Expected:

- `lease_acquired: true`;
- the cursor advances and monitored events enter the queue;
- generations finish in `delivery_status='generated'`;
- `posted: 0`;
- Freshdesk receives no note or tag.

Inspect:

```sql
select id, ticket_id, trigger_message_id, prompt_version, model, run_variant,
       delivery_status, error, created_at
from suggestions
order by created_at desc
limit 20;

select stream_name, last_updated_at, last_ticket_id
from poll_cursors;

select state, count(*)
from ticket_poll_queue
group by state;
```

Confirm every generated ticket belongs to a named monitored agent.

## 5. Synthetic/test-ticket delivery recovery

On an approved test ticket, verify:

1. one private note is posted;
2. the generation row reaches `posted` with `note_id`;
3. reprocessing the same customer turn does not create another note;
4. if the DB posted-state update is deliberately made to fail in a test
   environment, the next run finds the stored marker and recovers the same note.

Do not simulate database failure against a real customer ticket.

## 6. Enable a limited live pilot

Only after the gates and recovery test pass:

```bash
supabase secrets set --project-ref pqwnpcibymtmcpnqlkle DRY_RUN=false
```

Run one supervised invocation before enabling `pg_cron`. Inspect Freshdesk and
the outbox row. Then apply/update the schedule in migration 15.

Pause immediately with:

```sql
select cron.unschedule('ticket-suggester-every-minute');
```

## 7. Operational checks

```sql
select delivery_status, count(*)
from suggestions
group by delivery_status;

select *
from failures
limit 50;

select *
from gate1_scorecard;

select *
from calibration;
```

Investigate any `posting` reservation older than the configured lease, any queue
item with repeated attempts, and every failed generation. Critical human-review
errors must remain effectively zero before widening the pilot.

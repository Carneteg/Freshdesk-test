# Go-live runbook — Gate 1 ticket-suggester

Turnkey steps to take the system from **deployed-but-dormant** to **running**.
Nothing here runs automatically — each step is deliberate. Follow in order.

## 0. Gates before ANY real-ticket run
- [x] **OpenAI DPA confirmed** (2026-07-22) — real ticket text may go to OpenAI,
      replay harness included (CLAUDE.md §11–§12).
- [ ] **OpenAI key rotated.** The key shown in an earlier screenshot is exposed —
      revoke it at platform.openai.com and use a fresh one below.

## 1. Set the Edge Function secrets (Supabase)
Dashboard → Project **simployer-ticket-suggester** → Edge Functions → *Manage secrets*
(or `supabase secrets set KEY=value`). Set:

```
FRESHDESK_DOMAIN=simployer
FRESHDESK_API_KEY=<service-account key that posts notes>
MY_AGENT_ID=<monitored agent id — whose tickets get watched>
EXPECTED_AGENT_NAME=Tobias Carneteg
OPENAI_API_KEY=<rotated OpenAI key>
OPENAI_MODEL=gpt-4o
CRON_SECRET=<long random string>
```
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.
Generate a `CRON_SECRET` with e.g. `openssl rand -hex 24`.

## 2. Redeploy the function (OpenAI build)
The function is already deployed; this refreshes it to the merged OpenAI code.
```
supabase functions deploy ticket-suggester --no-verify-jwt
```

## 3. Smoke test — one manual invocation (still off otherwise)
```
curl -X POST "https://pqwnpcibymtmcpnqlkle.supabase.co/functions/v1/ticket-suggester" \
  -H "x-cron-secret: <CRON_SECRET>"
```
Expect `{ "ok": true, "scanned": …, "mine": …, "processed": … }`. With a
**synthetic** ticket assigned to `MY_AGENT_ID`, it should post a private note and
log a row in `suggestions`. A 403 means the secret is wrong; a 500 with
`missing required env var` means a secret is unset.

## 4. Turn it ON — schedule with pg_cron
Only after the smoke test passes **and** the DPA gate is cleared. Supabase SQL editor:
```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'ticket-suggester',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://pqwnpcibymtmcpnqlkle.supabase.co/functions/v1/ticket-suggester',
    headers := jsonb_build_object('x-cron-secret', '<CRON_SECRET>')
  );
  $$
);
```
To stop it: `select cron.unschedule('ticket-suggester');`

## 5. Evaluate (the actual experiment)
- Notes appear on tickets assigned to `MY_AGENT_ID`; read them and record a
  `verdict` (`usable` / `edited` / `unusable`) on each `suggestions` row.
- Track progress:
  ```sql
  select * from gate1_scorecard;   -- usable-% per prompt version (human verdict)
  select * from usage_scorecard;   -- used/partly/not + avg Q/A + similarity
  select * from calibration;       -- watch the (high, unusable) cell
  select * from failures;          -- every crashed run
  ```
- After ~50 judged tickets, `gate1_scorecard` gives the go/no-go number (>50% → wider pilot).

## DPA-safe dry run (recommended first)
Before scheduling, exercise the whole OpenAI pipeline locally on a **synthetic**
ticket — posts nothing:
```
deno task replay <synthetic-ticket-id>
```

-- Migration 15 — schedule the poller (Gate 1, one agent, private notes).
--
-- DO NOT run this until:
--   (a) the Edge Function is deployed with all secrets set, AND
--   (b) a supervised DRY_RUN=true run has been inspected in `suggestions` and the
--       agent filter + note quality look right (CLAUDE.md §4 — never run live before).
-- Enabling the schedule with DRY_RUN still true is fine and safe: it polls and logs
-- but posts nothing. Flip DRY_RUN=false (a function secret) only when you want notes
-- posted for real. This file is applied MANUALLY, not by the normal migration run,
-- because it needs the project URL + CRON_SECRET, which must never be committed.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- One-time: store the function URL + cron secret in Vault (run once, real values):
--   select vault.create_secret(
--     'https://pqwnpcibymtmcpnqlkle.functions.supabase.co/ticket-suggester',
--     'ticket_suggester_url');
--   select vault.create_secret('<CRON_SECRET>', 'ticket_suggester_cron_secret');
-- Reading the secret from Vault keeps it out of cron.job (which is world-readable to
-- the postgres role) and out of git.

-- Every minute: POST to the function with the x-cron-secret header. The function
-- caps work per run (MAX_PER_RUN) and dedups on (ticket_id, trigger_message_id), so
-- overlapping minutes are safe.
select cron.schedule(
  'ticket-suggester-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets
                where name = 'ticket_suggester_url'),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets
                        where name = 'ticket_suggester_cron_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- Pause the schedule at any time (leaves the function deployed):
--   select cron.unschedule('ticket-suggester-every-minute');
-- Inspect recent fires:
--   select * from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'ticket-suggester-every-minute')
--   order by start_time desc limit 20;

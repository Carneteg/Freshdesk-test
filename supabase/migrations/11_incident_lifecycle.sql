-- 11: incident lifecycle (knowledge layer refinement).
--
-- Without a status, the playbook led the AI to treat an already-FIXED bug as an
-- ongoing developer issue (QA #85607). Give each incident a lifecycle so the AI
-- can tell the customer to load the fix vs. set expectations on a live incident,
-- and so it links only when the scope/symptoms match.
--
-- Additive and idempotent: safe to re-run.

alter table known_incidents
  add column if not exists status          text not null default 'investigating',
  add column if not exists affected        text,   -- versions / scope / distinguishing symptoms
  add column if not exists workaround      text,   -- interim workaround while unresolved
  add column if not exists customer_action text,   -- what the customer does (esp. after a fix)
  add column if not exists started_at      date,
  add column if not exists resolved_at     date;

do $$ begin
  alter table known_incidents
    add constraint known_incidents_status_chk
    check (status in ('identified', 'investigating', 'fixed', 'closed'));
exception when duplicate_object then null; end $$;

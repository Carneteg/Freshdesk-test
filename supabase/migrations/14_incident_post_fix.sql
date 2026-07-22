-- Migration 14 — incident post-fix lifecycle (#84553, #85607).
--
-- When a known incident is 'fixed'/'closed', the agents' hard-won operational
-- knowledge is not just "it's fixed" — it is WHEN the fix went live, which records
-- the fix corrected automatically, and which HISTORICAL records the customer must
-- still correct by hand (and exactly how). Without this the AI either re-escalates a
-- solved issue or tells the customer "it's fixed" while old bad data silently remains.
--
-- Two new team-curated fields on known_incidents:
--   fix_released_at       — the date the fix was deployed (customer-facing "as of …").
--   post_fix_instructions — exact steps after the fix: which data auto-corrected,
--                           which historical records the customer must fix manually,
--                           and how. Distinct from `customer_action` (a short "what
--                           the customer does" line) — this is the full post-fix runbook.

alter table known_incidents
  add column if not exists fix_released_at       date,
  add column if not exists post_fix_instructions text;

comment on column known_incidents.fix_released_at is
  'Date the fix went live; lets the AI say "resolved as of <date>" and stop re-escalating.';
comment on column known_incidents.post_fix_instructions is
  'Post-fix runbook: which records auto-corrected vs. which historical records the customer must fix manually, and how (#84553, #85607).';

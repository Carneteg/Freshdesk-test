-- Migration 24 — structured verdict: reason codes, critical flag, actor log,
-- and an optimistic-lock version so two reviewers can't silently overwrite.
--
-- Until now a verdict was just usable/edited/unusable — you could see THAT the AI
-- failed but not WHY, which is the whole point of the evaluation. This adds:
--   • verdict_reasons — a jsonb array of reason-code slugs (why it failed).
--   • critical_flag   — a single severe-error category; when set, the row is
--                       forced to verdict='unusable' in the DB (not by trust).
--   • verdict_by      — who recorded the verdict, stamped from the JWT (anti-spoof).
--   • review_version  — bumped on every reviewer write; the client filters on the
--                       value it read, so a concurrent overwrite fails loudly.

alter table suggestions
  add column if not exists verdict_reasons jsonb    not null default '[]'::jsonb,
  add column if not exists critical_flag   text,
  add column if not exists verdict_by      text,
  add column if not exists review_version  integer  not null default 0;

comment on column suggestions.verdict_reasons is
  'Array of reason-code slugs explaining an edited/unusable verdict (e.g. ["wrong_cause","missing_check"]). Free-text goes in the last "other:" entry.';
comment on column suggestions.critical_flag is
  'A single severe-error category (legal_advice, wrongful_deletion, unauthorized_access, pii_risk, false_promise, invented_feature) or null. When set, verdict is forced to unusable.';
comment on column suggestions.verdict_by is
  'Email of the reviewer who recorded the verdict, stamped from the JWT by trigger (not client).';
comment on column suggestions.review_version is
  'Optimistic-lock counter. A reviewer write filters on the value it read and increments it; a stale write matches 0 rows and is rejected.';

-- Reviewer-writable columns (column-level grants; RLS still gates which rows).
-- verdict + verdict_at were granted in migration 19; verdict_by is trigger-stamped
-- (NOT granted, so it can't be spoofed).
grant update (verdict_reasons, critical_flag, review_version) on suggestions to authenticated;

-- Stamp who/when for the verdict authoritatively from the token, and enforce the
-- critical-flag rule in the database: a flagged reply is unusable regardless of
-- what the client sent (same "code decides, not trust" stance as the QA validator).
create or replace function stamp_verdict() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.critical_flag is not null and length(trim(new.critical_flag)) > 0 then
    new.verdict := 'unusable';
  end if;
  if new.verdict is distinct from old.verdict then
    new.verdict_at := now();
    new.verdict_by := coalesce(auth.jwt() ->> 'email', new.verdict_by);
  end if;
  return new;
end $$;

drop trigger if exists trg_stamp_verdict on suggestions;
create trigger trg_stamp_verdict before update on suggestions
  for each row execute function stamp_verdict();

-- "Why does the AI fail" — a rollup of reason codes per prompt version, so the
-- reason data is actually queryable. Excludes spam and history-scan rows.
create or replace view verdict_reasons_rollup with (security_invoker = on) as
select prompt_version, reason, count(*) as n
   from suggestions, jsonb_array_elements_text(verdict_reasons) as reason
  where verdict is not null and not is_spam and prompt_version <> 'agent-scan'
  group by prompt_version, reason
  order by prompt_version, n desc;

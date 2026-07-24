-- Migration 25 — locked, versioned ticket cohorts for credible evaluation.
--
-- Fas 2.1 of the scaling plan (docs/coach-scaling-plan.md): split tickets into
--   • learning     — approved examples the AI may learn from (few-shot/retrieval),
--   • development  — used while iterating on prompts/playbook/retrieval,
--   • holdout      — NEVER used as a gold exemplar, never tuned against, never a
--                    retrieval source for itself. The trustworthy test set.
--
-- The assignment is a property of the TICKET (not a suggestion row), assigned once
-- and LOCKED: scripts/assign_cohorts.ts only inserts missing rows and never moves a
-- ticket, so the holdout can't silently drift into training. `cohort_version` lets a
-- future, deliberately re-drawn split coexist with the old one.

create table if not exists ticket_cohorts (
  ticket_id      bigint primary key,
  cohort         text not null check (cohort in ('learning','development','holdout')),
  cohort_version text not null default 'v1',
  assigned_at    timestamptz not null default now()
);

comment on table ticket_cohorts is
  'Locked learning/development/holdout assignment per ticket (scaling plan Fas 2.1). Assigned once by scripts/assign_cohorts.ts and never moved, so the holdout stays a clean, leak-free test set.';

-- Service-role only (the pipeline/scripts read+write it); deny-all for clients,
-- like known_incidents. Reviewers never touch cohorts from the app.
alter table ticket_cohorts enable row level security;
revoke all on ticket_cohorts from anon;
revoke all on ticket_cohorts from authenticated;

-- How many tickets are in each cohort, per version.
create or replace view cohort_summary with (security_invoker = on) as
select cohort_version, cohort, count(*) as tickets
   from ticket_cohorts
  group by cohort_version, cohort
  order by cohort_version, cohort;

-- The Gate 1 usable-% split by cohort, so the LOCKED holdout number can be read on
-- its own — that is the figure a Gate 2 decision should rest on, not a mixed set.
create or replace view gate1_scorecard_by_cohort with (security_invoker = on) as
select
    coalesce(c.cohort, '(unassigned)') as cohort,
    s.prompt_version,
    count(*) as generated,
    count(s.verdict) as judged,
    count(*) filter (where s.verdict = 'usable') as usable,
    count(*) filter (where s.verdict = 'edited') as edited,
    count(*) filter (where s.verdict = 'unusable') as unusable,
    round(100.0 * count(*) filter (where s.verdict = 'usable')::numeric
          / nullif(count(s.verdict), 0)::numeric, 1) as usable_pct
   from suggestions s
   left join ticket_cohorts c using (ticket_id)
  where s.error is null and s.prompt_version <> 'agent-scan' and not s.is_spam
  group by coalesce(c.cohort, '(unassigned)'), s.prompt_version
  order by coalesce(c.cohort, '(unassigned)'), s.prompt_version;

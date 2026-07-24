-- Migration 26 — coach_mode: the explicit three-way output classification (Fas 3.1).
--
-- Every suggestion is now labelled REPLY_READY / COACH_AGENT / AGENT_ACTION_REQUIRED
-- (derived in code from the resolved pipeline signals; see render.ts deriveCoachMode).
-- Persist it so we can MEASURE the modes: the point of the split is that a
-- REPLY_READY draft should earn "usable" far more often than a COACH_AGENT one, and
-- an AGENT_ACTION_REQUIRED note should rarely be sent as-is. If REPLY_READY isn't
-- clearly more usable, the gate is miscalibrated.

alter table suggestions
  add column if not exists coach_mode text;

comment on column suggestions.coach_mode is
  'Fas 3.1 output mode: REPLY_READY / COACH_AGENT / AGENT_ACTION_REQUIRED. Derived in code (render.ts deriveCoachMode) from confidence + strategy + system-check + sensitive-action + reply presence.';

-- Verdict distribution per mode — read this to check the modes are calibrated
-- (REPLY_READY should skew usable). Excludes spam + history-scan rows, like the
-- other scorecards.
create or replace view coach_mode_scorecard with (security_invoker = on) as
select
    coach_mode,
    prompt_version,
    count(*) as generated,
    count(verdict) as judged,
    count(*) filter (where verdict = 'usable') as usable,
    count(*) filter (where verdict = 'edited') as edited,
    count(*) filter (where verdict = 'unusable') as unusable,
    round(100.0 * count(*) filter (where verdict = 'usable')::numeric
          / nullif(count(verdict), 0)::numeric, 1) as usable_pct
   from suggestions
  where error is null and prompt_version <> 'agent-scan' and not is_spam
    and coach_mode is not null
  group by coach_mode, prompt_version
  order by coach_mode, prompt_version;

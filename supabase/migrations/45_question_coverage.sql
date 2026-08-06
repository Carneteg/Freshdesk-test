-- Migration 45 — per-question coverage, so the status can follow the weakest part.
--
-- WHY. The verify call has always returned `coverage`: one row per customer
-- question with answered true/false. The pipeline collapsed it immediately into
-- two integers (a Q/A score) and threw the array away. That lost the only thing
-- an agent actually needs — WHICH question is unanswered.
--
-- It also let a partial answer reach the green band. A note reading
-- "Q/A: answers 2 of 3" with a 🟢 REPLY_READY badge is the dangerous case: the
-- agent trusts the badge, sends two answers out of three, and the ticket comes
-- back. Averaging rewards skipping the hard question, because dropping it raises
-- the score.
--
-- `deriveCoachMode` now blocks REPLY_READY when ANY question is unanswered — one
-- gap is enough, deliberately not a proportion, so 9 of 10 does not pass either.
-- Derived in code from the verify output, as with every other gate: the model
-- proposes, TypeScript decides. NO PROMPT CHANGE, so PROMPT_VERSION is untouched
-- and the golden set stays comparable.
--
-- Storing the array is what makes it measurable. Until now "how often do we
-- answer only part of a multi-question ticket" was unanswerable from the data.

alter table suggestions
  add column if not exists coverage jsonb;

comment on column suggestions.coverage is
  'Per-question coverage from the verify call: [{question, answered}]. Drives the note''s breakdown block and gates REPLY_READY — any unanswered question blocks the green band. NULL on rows generated before this column existed.';

-- Part of the immutable generation payload, not reviewer-writable: deliberately
-- absent from protect_generation_payload's mutable allowlist.

-- ── How often do we answer only part of a ticket? ────────────────────────────
--
-- A question nobody could ask before. Multi-question tickets are the population
-- where partial answers happen; single-question tickets cannot be partial, so
-- they are excluded rather than diluting the rate.
create or replace view question_coverage_scorecard with (security_invoker = on) as
select
  prompt_version,
  count(*) as multi_question_generations,
  count(*) filter (where not exists (
    select 1 from jsonb_array_elements(coverage) c
    where (c ->> 'answered')::boolean is not true
  )) as fully_answered,
  count(*) filter (where exists (
    select 1 from jsonb_array_elements(coverage) c
    where (c ->> 'answered')::boolean is not true
  )) as partially_answered,
  round(
    100.0 * count(*) filter (where exists (
      select 1 from jsonb_array_elements(coverage) c
      where (c ->> 'answered')::boolean is not true
    ))::numeric / nullif(count(*), 0)::numeric,
    1
  ) as partial_pct,
  -- The cell that mattered before this change: a partial answer that still
  -- carried the green badge. It should now be structurally zero.
  count(*) filter (
    where coach_mode = 'REPLY_READY' and exists (
      select 1 from jsonb_array_elements(coverage) c
      where (c ->> 'answered')::boolean is not true
    )
  ) as partial_but_green
from suggestions
where error is null
  and prompt_version <> 'agent-scan'
  and not is_spam
  and coverage is not null
  and jsonb_array_length(coverage) > 1
group by prompt_version
order by prompt_version;

comment on view question_coverage_scorecard is
  'Multi-question tickets: how often the reply answers only part of them. partial_but_green must be 0 — a partial answer carrying a send-ready badge is the failure this column was added to prevent.';

-- Which questions go unanswered, so the pattern is visible rather than anecdotal.
-- A topic that repeats here is a documentation gap with a name.
create or replace view unanswered_questions with (security_invoker = on) as
select
  s.id as generation_id,
  s.ticket_id,
  s.subject,
  s.ticket_url,
  s.prompt_version,
  s.coach_mode,
  c ->> 'question' as question,
  s.created_at
from suggestions s
cross join lateral jsonb_array_elements(s.coverage) c
where s.error is null
  and s.prompt_version <> 'agent-scan'
  and not s.is_spam
  and s.coverage is not null
  and (c ->> 'answered')::boolean is not true
order by s.created_at desc;

comment on view unanswered_questions is
  'Every customer question the reply did not resolve, one row each. A topic that keeps appearing here is a knowledge gap with a name — read it beside knowledge_gaps.';

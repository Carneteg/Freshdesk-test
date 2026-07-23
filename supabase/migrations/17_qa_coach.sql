-- Migration 17 — QA Coach scores alongside the human verdict.
--
-- The QA Coach (CLAUDE.md §12, "mode A") is an OFFLINE eval-scorer: in replay it
-- grades the AI's own draft against a fixed 7-criterion rubric, using only the
-- context the draft actually had. It does NOT replace the human `verdict` ("would
-- I have sent this?") — that stays the gold standard — it sits beside it as an
-- automatic, consistent second read, so we can see whether the rubric agrees with
-- the humans and flag replies the model itself marks as needing review.
--
-- All columns are nullable: a suggestion with no send-ready reply (an abstain) has
-- nothing to score, and older rows predate the scorer.

alter table suggestions
  add column if not exists qa_version      text,        -- QA_COACH_VERSION that produced the score
  add column if not exists qa_score        int,         -- weighted total, 0..100
  add column if not exists qa_verdict      text,        -- Excellent | Good | Acceptable | Needs review
  add column if not exists qa_needs_review boolean,      -- model-flagged (forced true when Accuracy is 1–2)
  add column if not exists qa_assessment   jsonb;        -- full scorecard + rationale + recommendedReply

comment on column suggestions.qa_score is
  'QA Coach weighted total (0-100). Automatic rubric read, NOT the human verdict.';
comment on column suggestions.qa_verdict is
  'QA Coach verdict bucket. Accuracy 1-2 forces "Needs review" regardless of total.';
comment on column suggestions.qa_needs_review is
  'QA Coach flagged the reply as needing a human look (e.g. unverifiable accuracy).';
comment on column suggestions.qa_assessment is
  'Full QA assessment JSON (7-criterion scorecard, top improvements, recommended reply).';

-- QA rubric summary per prompt version: average score, verdict spread, how often
-- the model itself asks for a human. Read next to gate1_scorecard to see whether
-- the automatic rubric tracks the human "would I have sent this?" verdict.
create or replace view qa_scorecard with (security_invoker = on) as
select
  prompt_version,
  qa_version,
  count(qa_score)                                          as scored,
  round(avg(qa_score), 1)                                  as avg_score,
  count(*) filter (where qa_verdict = 'Excellent')         as excellent,
  count(*) filter (where qa_verdict = 'Good')              as good,
  count(*) filter (where qa_verdict = 'Acceptable')        as acceptable,
  count(*) filter (where qa_verdict = 'Needs review')      as needs_review,
  count(*) filter (where qa_needs_review)                  as flagged_for_human
from suggestions
where error is null and qa_score is not null
group by prompt_version, qa_version
order by prompt_version, qa_version;

-- Agreement check: does the automatic rubric line up with the human verdict on the
-- rows a human has judged? A pattern of high qa_score + verdict='unusable' (or the
-- reverse) means the rubric and the humans disagree — worth reading before trusting
-- the QA score as a proxy.
create or replace view qa_vs_human with (security_invoker = on) as
select
  verdict                          as human_verdict,
  qa_verdict,
  count(*)                         as n,
  round(avg(qa_score), 1)          as avg_qa_score
from suggestions
where error is null and qa_score is not null and verdict is not null
group by verdict, qa_verdict
order by verdict, qa_verdict;

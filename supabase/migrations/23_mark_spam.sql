-- Migration 23 — let reviewers mark a ticket as spam from the review app.
--
-- The automatic ingest filter (§ render.ts) can't catch everything (e.g. an
-- absence reply with a clean subject). A reviewer needs a one-click "Spam" that
-- hides the row and keeps it out of the eval + rewrite queue, and that future
-- ingest runs respect. `is_spam` is the flag; the review app can set it (grant),
-- and every reader view excludes it.

alter table suggestions
  add column if not exists is_spam boolean not null default false;

comment on column suggestions.is_spam is
  'Reviewer-flagged spam/noise (absence replies, marketing bounces the auto-filter missed). Excluded from all views; ingest skips these ticket ids.';

-- Reviewers may flag spam (in addition to verdict/gold_answer). Column-level grant.
grant update (is_spam) on suggestions to authenticated;

-- Exclude spam from every reader view.
create or replace view gate1_scorecard with (security_invoker = on) as
select prompt_version,
    count(*) as generated,
    count(verdict) as judged,
    count(*) filter (where verdict = 'usable') as usable,
    count(*) filter (where verdict = 'edited') as edited,
    count(*) filter (where verdict = 'unusable') as unusable,
    round(100.0 * count(*) filter (where verdict = 'usable')::numeric / nullif(count(verdict), 0)::numeric, 1) as usable_pct
   from suggestions
  where error is null and prompt_version <> 'agent-scan' and not is_spam
  group by prompt_version order by prompt_version;

create or replace view calibration with (security_invoker = on) as
select confidence, coalesce(verdict, '(unjudged)') as verdict, count(*) as n
   from suggestions
  where error is null and prompt_version <> 'agent-scan' and not is_spam
  group by confidence, coalesce(verdict, '(unjudged)')
  order by confidence, coalesce(verdict, '(unjudged)');

create or replace view qa_scorecard with (security_invoker = on) as
select prompt_version, qa_version,
    count(qa_score) as scored, round(avg(qa_score), 1) as avg_score,
    count(*) filter (where qa_verdict = 'Excellent') as excellent,
    count(*) filter (where qa_verdict = 'Good') as good,
    count(*) filter (where qa_verdict = 'Acceptable') as acceptable,
    count(*) filter (where qa_verdict = 'Needs review') as needs_review,
    count(*) filter (where qa_needs_review) as flagged_for_human
   from suggestions
  where error is null and qa_score is not null and not is_spam
  group by prompt_version, qa_version order by prompt_version, qa_version;

create or replace view qa_vs_human with (security_invoker = on) as
select verdict as human_verdict, qa_verdict, count(*) as n, round(avg(qa_score), 1) as avg_qa_score
   from suggestions
  where error is null and qa_score is not null and verdict is not null and not is_spam
  group by verdict, qa_verdict order by verdict, qa_verdict;

create or replace view rewrite_queue with (security_invoker = on) as
select id, ticket_id, ticket_url, subject, language, ticket_type,
    agent_qa_score, agent_qa_verdict, agent_qa_needs_review, agent_sent_reply, draft as ai_draft
   from suggestions
  where agent_qa_score is not null and (gold_answer is null or length(trim(gold_answer)) = 0) and not is_spam
  order by agent_qa_needs_review desc nulls last, agent_qa_score, ticket_id;

create or replace view training_examples with (security_invoker = on) as
select id, ticket_id, subject, language, ticket_type,
    gold_answer, gold_answer_by, gold_answer_at, agent_sent_reply, draft as ai_draft, verdict, prompt_version
   from suggestions
  where gold_answer is not null and length(trim(gold_answer)) > 0 and not is_spam
  order by gold_answer_at desc;

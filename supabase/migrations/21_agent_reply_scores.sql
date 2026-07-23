-- Migration 21 — QA-score the AGENTS' historical replies (triage, not posting).
--
-- The QA Coach is an offline scorer that posts nothing (§12). Pointed at the
-- agents' ACTUAL sent replies on historical tickets, it becomes a triage engine:
-- score every past reply, store only in Supabase, and surface the weakest ones as
-- rewrite targets (write a better gold_answer → feeds the learning loop).
--
-- HONEST CAVEAT (encoded as guidance, not code): the coach judges only from the
-- context it is given, but agents' best replies carry operational knowledge that
-- is NOT in the ticket text — so Accuracy on agent replies is systematically harsh.
-- Read the score as "where to look" (vague / non-answer / undocumented solution),
-- NOT as a grade of the agent. Never rank agents by it.

alter table suggestions
  add column if not exists agent_qa_version      text,
  add column if not exists agent_qa_score        int,       -- 0..100, the agent reply's rubric total
  add column if not exists agent_qa_verdict      text,
  add column if not exists agent_qa_needs_review boolean,
  add column if not exists agent_qa_assessment   jsonb;     -- full assessment incl. recommendedReply

comment on column suggestions.agent_qa_score is
  'QA Coach score of the AGENT''s actual reply (triage signal, not a grade). Accuracy is harsh on undocumented knowledge — read as "where to look".';

-- History-scan rows (agent reply scored, no AI draft generated) are stored on
-- `suggestions` with prompt_version='agent-scan' so a reviewer can write a
-- gold_answer on the same row. Keep them OUT of the AI-draft eval views.
create or replace view gate1_scorecard with (security_invoker = on) as
select prompt_version,
    count(*) as generated,
    count(verdict) as judged,
    count(*) filter (where verdict = 'usable') as usable,
    count(*) filter (where verdict = 'edited') as edited,
    count(*) filter (where verdict = 'unusable') as unusable,
    round(100.0 * count(*) filter (where verdict = 'usable')::numeric / nullif(count(verdict), 0)::numeric, 1) as usable_pct
   from suggestions
  where error is null and prompt_version <> 'agent-scan'
  group by prompt_version
  order by prompt_version;

create or replace view calibration with (security_invoker = on) as
select confidence,
    coalesce(verdict, '(unjudged)') as verdict,
    count(*) as n
   from suggestions
  where error is null and prompt_version <> 'agent-scan'
  group by confidence, coalesce(verdict, '(unjudged)')
  order by confidence, coalesce(verdict, '(unjudged)');

-- The rewrite queue: worst-scoring agent replies that do NOT yet have a
-- hand-written ideal answer. Worst first (model-flagged, then lowest score).
create or replace view rewrite_queue with (security_invoker = on) as
select id, ticket_id, ticket_url, subject, language, ticket_type,
    agent_qa_score, agent_qa_verdict, agent_qa_needs_review,
    agent_sent_reply, draft as ai_draft
   from suggestions
  where agent_qa_score is not null
    and (gold_answer is null or length(trim(gold_answer)) = 0)
  order by agent_qa_needs_review desc nulls last, agent_qa_score asc, ticket_id;

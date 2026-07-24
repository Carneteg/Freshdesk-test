-- Migration 28 — knowledge-gap detection (scaling plan Fas 4.4).
--
-- The Gate 1 root cause (§12) was operational/product knowledge that isn't written
-- down: the AI couldn't ground an answer because the KB didn't cover it. These views
-- turn every "AI wasn't confident it had the answer" suggestion into a signal, and
-- cluster them by topic so the team gets a ranked list of WHAT TO DOCUMENT. Derived
-- entirely from existing pipeline output — no prompt change, so the golden set /
-- holdout baseline are untouched.

-- Per-ticket gap detail. A gap = the pipeline could not ground a confident answer.
-- gap_type distinguishes "the KB had nothing" from "sources were found but didn't fit".
create or replace view knowledge_gap_tickets with (security_invoker = on) as
select
    id, ticket_id, ticket_url, subject, language, ticket_type,
    nullif(detected_intent, '') as topic,
    keywords,
    confidence, answer_strategy, coach_mode,
    coalesce(jsonb_array_length(sources), 0) as n_sources,
    case when coalesce(jsonb_array_length(sources), 0) = 0 then 'no_kb_source'
         else 'weak_grounding' end as gap_type,
    agent_analysis, created_at
   from suggestions
  where error is null and prompt_version <> 'agent-scan' and not is_spam
    and (confidence in ('none', 'low') or answer_strategy = 'ABSTAIN')
    -- exclude auto-reply / out-of-office / absence noise (mirrors the ingest filter):
    -- these are low-confidence because they aren't real questions, not because of a KB gap.
    and subject !~* '^(re:\s*)?\s*(automatic reply|automatisk svar|automatiskt svar|autosvar|automaattinen vastaus|out[- ]?of[- ]?office|out of office|frånvaro|frånvarande|ute av kontoret|auto[- ]?reply|feriesvar|semestersvar|semesterhälsning|fraværsmelding|fraværsassistent)';

comment on view knowledge_gap_tickets is
  'Per-ticket knowledge gaps (Fas 4.4): suggestions the pipeline could not ground (low/none confidence or ABSTAIN). gap_type = no_kb_source | weak_grounding.';

-- Ranked topics — the weekly "top gaps to document" list. Recent example ids +
-- subjects so a KB owner can see exactly what the missing article should cover.
create or replace view knowledge_gaps with (security_invoker = on) as
select
    coalesce(topic, '(unclassified)') as topic,
    count(*) as gap_tickets,
    count(distinct ticket_id) as distinct_tickets,
    count(*) filter (where gap_type = 'no_kb_source') as no_kb_source,
    count(*) filter (where gap_type = 'weak_grounding') as weak_grounding,
    (array_agg(distinct language))[1:4] as languages,
    (array_agg(ticket_id order by created_at desc))[1:5] as recent_ticket_ids,
    (array_agg(subject order by created_at desc))[1:3] as recent_subjects,
    max(created_at) as last_seen
   from knowledge_gap_tickets
  group by coalesce(topic, '(unclassified)')
  order by count(*) desc, max(created_at) desc;

comment on view knowledge_gaps is
  'Knowledge gaps ranked by frequency (Fas 4.4). The weekly top-N is the list of KB articles / operational notes worth writing. Read via scripts/knowledge_gaps.ts or SQL.';

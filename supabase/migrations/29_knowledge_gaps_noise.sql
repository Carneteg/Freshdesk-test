-- Migration 29 — tighten the knowledge-gap noise filter.
--
-- Two noise rows slipped into knowledge_gaps: an "OOO Re: …" out-of-office reply
-- (the OOO abbreviation wasn't in the auto-reply prefix set) and a Simployer nag/
-- reminder mail ("Påminnelse fra Simployer: Du må aktivere …"), which is a
-- campaign/system mail, not a customer support question. Exclude both. Only the
-- WHERE changes; the dependent `knowledge_gaps` view is unaffected.
--
-- NB: Postgres regex uses \y for a word boundary — \b is a backspace char here (not
-- the JS meaning), so the OOO exclusion below uses \y.

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
    -- auto-reply / out-of-office / absence noise (low-conf because not a real question):
    and subject !~* '^(re:\s*)?\s*(automatic reply|automatisk svar|automatiskt svar|autosvar|automaattinen vastaus|out[- ]?of[- ]?office|out of office|frånvaro|frånvarande|ute av kontoret|auto[- ]?reply|feriesvar|semestersvar|semesterhälsning|fraværsmelding|fraværsassistent)'
    -- "OOO" / "OOO Re:" out-of-office abbreviation (optionally behind a reply/forward prefix):
    and subject !~* '^\s*(re:|fw:|fwd:|vs:|sv:)?\s*ooo\y'
    -- Simployer-originated reminder/campaign mail, not a customer support question:
    and subject !~* 'påminnelse fra simployer';

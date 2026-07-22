-- 07: full-context QA rework (CLAUDE.md §12).
--
-- The suggestion pipeline now reasons over the WHOLE chronological ticket
-- (customer messages, agent replies, internal notes, system messages) and
-- attributes every fact to who stated it — the AI has NO system access. These
-- columns log that reasoning so the scorecards and the private note stay honest.
--
-- Additive and idempotent: safe to re-run.

alter table suggestions
  add column if not exists detected_intent    text,
  add column if not exists answer_strategy    text,
  add column if not exists confidence_reason  text,
  add column if not exists agent_next_action  text,
  add column if not exists requires_manual_system_check boolean default false,
  add column if not exists security_sensitive boolean default false,
  add column if not exists facts              jsonb,
  add column if not exists unknowns           jsonb;

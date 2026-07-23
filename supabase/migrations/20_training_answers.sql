-- Migration 20 — capture the "right answer" as training material.
--
-- Adds two things to `suggestions`:
--   • agent_sent_reply — what the agent ACTUALLY sent on this ticket (populated by
--     the replay harness). For Johanna's tickets this is the gold standard, shown
--     in the review UI beside the AI draft as reference.
--   • gold_answer (+ _at/_by) — the ideal answer a reviewer types in. This is the
--     "what good looks like" corpus. NOTE (per CLAUDE.md §12): this BUILDS the
--     corpus; feeding it back into generation is the Gate 2 learning loop. Nothing
--     here fine-tunes a model.

alter table suggestions
  add column if not exists agent_sent_reply text,   -- what the agent really sent (replay-populated)
  add column if not exists gold_answer      text,   -- reviewer's ideal answer
  add column if not exists gold_answer_at    timestamptz,
  add column if not exists gold_answer_by    text;   -- stamped from the JWT by trigger, not client

comment on column suggestions.agent_sent_reply is
  'The reply the agent actually sent on this ticket (replay-populated). Reference/gold for training.';
comment on column suggestions.gold_answer is
  'Reviewer-authored ideal answer. Training corpus for a future Gate 2 learning loop; not used in generation yet.';

-- Reviewers may write the gold answer (only this column; _at/_by are stamped below).
-- agent_sent_reply is service-role-only (replay writes it) — deliberately NOT granted.
grant update (gold_answer) on suggestions to authenticated;

-- Stamp who/when authoritatively from the auth token, so the byline can't be spoofed
-- by the client. Fires only when gold_answer actually changes.
create or replace function stamp_gold_answer() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.gold_answer is distinct from old.gold_answer then
    new.gold_answer_at := now();
    new.gold_answer_by := coalesce(auth.jwt() ->> 'email', new.gold_answer_by);
  end if;
  return new;
end $$;

drop trigger if exists trg_stamp_gold on suggestions;
create trigger trg_stamp_gold before update on suggestions
  for each row execute function stamp_gold_answer();

-- The exportable training corpus: every ticket that now has a hand-authored ideal
-- answer. This is what a Gate 2 learning loop (few-shot / retrieval / fine-tune)
-- would draw on. security_invoker so RLS still applies to whoever reads it.
create or replace view training_examples with (security_invoker = on) as
select
  id, ticket_id, subject, language, ticket_type,
  gold_answer, gold_answer_by, gold_answer_at,
  agent_sent_reply, draft as ai_draft, verdict, prompt_version
from suggestions
where gold_answer is not null and length(trim(gold_answer)) > 0
order by gold_answer_at desc;

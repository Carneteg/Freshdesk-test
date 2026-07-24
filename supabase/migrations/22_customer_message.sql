-- Migration 22 — store the customer's original question.
--
-- The review UI showed the agent draft but not always what the customer actually
-- asked. `suggestions` had no raw customer text (only AI-derived `questions` /
-- `detected_intent`). Add `customer_message` (the latest incoming customer text),
-- populated by the pipeline/replay and the history scan. Old rows stay null and
-- the UI falls back to `questions`/`detected_intent`.

alter table suggestions
  add column if not exists customer_message text;

comment on column suggestions.customer_message is
  'The customer''s original question/message (the latest incoming text). Populated by the pipeline/replay and score_history so the review UI can show what was actually asked.';

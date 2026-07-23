-- Migration 16 — one-click agent verdict from the private note.
--
-- The whole experiment exists to collect the human verdict ("would I have sent
-- this?"). Until now that had to be set by hand in SQL. This adds a per-note token
-- so the note can carry 👍/✏️/👎 links that write the verdict straight into
-- `suggestions` via the `feedback` Edge Function — making `gate1_scorecard` real
-- with a single click, and building the corpus a Gate 2 learning loop would train on.

alter table suggestions
  add column if not exists feedback_token text,   -- unguessable per-note token used by the feedback links
  add column if not exists verdict_at     timestamptz; -- when the agent recorded their verdict

-- One token per suggestion; the feedback endpoint looks the row up by it.
create unique index if not exists suggestions_feedback_token_uidx
  on suggestions (feedback_token) where feedback_token is not null;

comment on column suggestions.feedback_token is
  'Unguessable token embedded in the note''s verdict links; the feedback function matches on it.';
comment on column suggestions.verdict_at is
  'Timestamp the agent recorded their verdict via the note''s feedback links.';

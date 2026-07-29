-- Migration 32 — make evaluation context match generation context.
--
-- Reviewers must judge a draft against the same chronological conversation the
-- model saw, not against the ticket's initial question in isolation.

alter table suggestions
  add column if not exists conversation_context text,
  add column if not exists latest_unresolved_request text;

comment on column suggestions.conversation_context is
  'The full chronological, source-labelled ticket context supplied to the model at generation time.';

comment on column suggestions.latest_unresolved_request is
  'The analysis call''s explicit identification of the latest unresolved customer request the draft addresses.';

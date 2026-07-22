-- 09: split the note into two tracks (CLAUDE.md §10, quality iteration).
--
-- The private note conflated "what to SAY to the customer" with "what to DO to
-- resolve the case". These are separated: `reply` (already stored as `draft`)
-- stays the customer-facing message; `resolution_steps` is the internal action
-- list. `agent_next_action` (migration 07) is superseded but kept for history.
--
-- Additive and idempotent: safe to re-run.

alter table suggestions
  add column if not exists resolution_steps jsonb;

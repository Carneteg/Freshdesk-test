-- 08: agent-facing analysis (CLAUDE.md §10, quality iteration).
--
-- Even when the KB does not contain the answer, the private note must still help
-- the agent: the likely resolution path (as a hypothesis), what to verify, and
-- any KB gap. That reasoning is logged here so a hollow "no confident answer" is
-- never all the agent gets.
--
-- Additive and idempotent: safe to re-run.

alter table suggestions
  add column if not exists agent_analysis text;

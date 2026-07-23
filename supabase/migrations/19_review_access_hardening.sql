-- Migration 19 — harden reviewer grants to true least-privilege.
--
-- Supabase grants anon/authenticated BLANKET table privileges on public tables by
-- default. So migration 18's column-level `grant update (verdict, verdict_at)` did
-- NOT actually restrict reviewers — the role already held UPDATE on every column,
-- letting an allowlisted reviewer edit drafts/scores, not just record a verdict.
-- And known_incidents had RLS disabled, so any authenticated user could read or
-- modify the playbook once Auth is enabled. Fix both.

-- suggestions: strip the blanket grants, then re-grant EXACTLY read + verdict-write.
-- RLS policies (migration 18) still gate which rows; these gate which columns.
revoke all on suggestions from authenticated;
revoke all on suggestions from anon;
grant select on suggestions to authenticated;
grant update (verdict, verdict_at) on suggestions to authenticated;

-- known_incidents was RLS-off → the blanket grant exposed it to any logged-in user.
-- Enable RLS with no client policies = deny-all. The pipeline reads it via the
-- service role, which bypasses RLS, so retrieval is unaffected.
alter table known_incidents enable row level security;
revoke all on known_incidents from anon;
revoke all on known_incidents from authenticated;

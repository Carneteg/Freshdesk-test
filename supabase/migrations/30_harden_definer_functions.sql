-- 30_harden_definer_functions.sql
-- Supabase security-advisor cleanup (linter 0011, 0028/0029).
--
-- 1. stamp_verdict() and stamp_gold_answer() are SECURITY DEFINER *trigger*
--    functions (BEFORE UPDATE on `suggestions`, stamping verdict_by/gold_answer_by
--    from the JWT). They were also reachable directly via /rest/v1/rpc as the
--    anon/authenticated API roles, which is not intended — they should only ever
--    fire from their row triggers. Revoke direct EXECUTE from the API roles; the
--    triggers still fire (they run in the table-owner context, independent of
--    these grants — verified: trg_stamp_verdict / trg_stamp_gold remain intact).
--
-- 2. match_past_tickets() had a role-mutable search_path. Pin it to `public`
--    (where the `vector` type and its operators live).
--
-- Intentionally NOT changed: is_reviewer() stays SECURITY DEFINER + EXECUTE for
-- `authenticated`, because the RLS policies on `suggestions`/`ticket_cohorts`
-- evaluate it as the querying user and it must read the RLS-locked app_reviewers
-- allowlist. That advisor warning is inherent to the allowlist design.

revoke execute on function public.stamp_verdict() from public, anon, authenticated;
revoke execute on function public.stamp_gold_answer() from public, anon, authenticated;

alter function public.match_past_tickets(vector, integer, double precision, bigint, timestamptz)
  set search_path to 'public';

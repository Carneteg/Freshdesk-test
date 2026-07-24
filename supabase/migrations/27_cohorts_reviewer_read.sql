-- Migration 27 — let allowlisted reviewers READ cohort membership.
--
-- The review app shows holdout progress ("X of N holdout judged") and a "Holdout
-- only" filter, which needs the client to know which tickets are holdout. Cohort
-- assignment is not sensitive, and the leakage risk (a holdout gold answer being
-- fed back as a generation exemplar) is enforced server-side and unaffected by
-- read access. So grant SELECT to allowlisted reviewers; writes stay service-role
-- only (assign_cohorts.ts uses the service role, which bypasses RLS).

grant select on ticket_cohorts to authenticated;

drop policy if exists ticket_cohorts_reviewer_read on ticket_cohorts;
create policy ticket_cohorts_reviewer_read on ticket_cohorts
  for select to authenticated using (is_reviewer());

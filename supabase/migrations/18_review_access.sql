-- Migration 18 — reviewer access foundation for the review UI (Phase 1).
--
-- Until now `suggestions` had RLS enabled with NO policies, so only the service
-- role (which bypasses RLS) could read it — the safe deny-all baseline. The
-- review UI needs logged-in agents to read drafts and record a verdict WITHOUT
-- ever holding the service-role key in the browser. This adds:
--
--   1. an allowlist table of who may use the UI (data-driven, so adding an agent
--      is a one-row insert — the "share with other agents" goal),
--   2. is_reviewer(): is the current logged-in user on that allowlist,
--   3. RLS policies letting an allowlisted, authenticated user READ all rows and
--      UPDATE only the verdict columns — nothing else.
--
-- Access model: any allowlisted reviewer can see ALL evaluation rows (this is a
-- shared eval — the team judges the same corpus together). To restrict a reviewer
-- to only their own tickets later, tighten the USING clause on reviewers_read.
-- The service-role path (the scheduler, replay, MCP) is unchanged.

create table if not exists app_reviewers (
  email    text primary key,
  name     text,
  active   boolean not null default true,
  added_at timestamptz not null default now()
);
alter table app_reviewers enable row level security;
-- No client policies: the allowlist is managed only by the service role
-- (which bypasses RLS). is_reviewer() reads it via SECURITY DEFINER.

comment on table app_reviewers is
  'Allowlist of agent emails permitted to use the review UI. Managed by service role only.';

-- Seed the initial reviewer. Add more with:
--   insert into app_reviewers(email, name) values ('agent@example.com','Name');
insert into app_reviewers(email, name) values
  ('tobias.carneteg@gmail.com', 'Tobias Carneteg')
on conflict (email) do nothing;

-- Is the currently-authenticated user an active reviewer? SECURITY DEFINER so it
-- can read the allowlist regardless of that table's RLS; pinned search_path.
create or replace function is_reviewer() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from app_reviewers r
    where r.active
      and lower(r.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
grant execute on function is_reviewer() to authenticated;

-- suggestions: allowlisted reviewers may READ all rows and SET a verdict only.
-- Column-level UPDATE grant means they can change verdict/verdict_at and nothing
-- else, even though the row policy matches every row.
grant select on suggestions to authenticated;
grant update (verdict, verdict_at) on suggestions to authenticated;

drop policy if exists reviewers_read on suggestions;
create policy reviewers_read on suggestions
  for select to authenticated using (is_reviewer());

drop policy if exists reviewers_set_verdict on suggestions;
create policy reviewers_set_verdict on suggestions
  for update to authenticated using (is_reviewer()) with check (is_reviewer());

-- Migration 42 — measure the COACHING half of the product.
--
-- WHY. Gate 1 pivoted from answer-generator to coach (CLAUDE.md §12), but only
-- the drafting half is measured: `gate1_scorecard` answers "would I have sent
-- this reply". Whether the agent acted on the recommended NEXT STEP — the part
-- the pivot said was the actual product — is not measured anywhere. Without it
-- there is no evidence for the coaching half after the pilot.
--
-- A second, smaller blind spot: a note that lands after the agent has already
-- started writing is useless, and today that failure is invisible. It reads as a
-- bad suggestion when it is a late one. Those must be counted apart or the model
-- gets blamed for advice nobody saw.
--
-- READ-ONLY. Nothing here, and nothing in the tab or job that reads it, writes to
-- Freshdesk, Jira, Linear, Confluence, Planhat or Intercom. The only writer is
-- the reconciliation script, and it writes to THESE tables only.
--
-- NOT SCHEDULED. No pg_cron object is created, resumed or altered. A job ran
-- outside its agreed window on 30 July 2026 and posted 14 live notes; scheduling
-- is now an explicit decision, not an implementation detail.
--
-- ── DEVIATION FROM THE BUILD SPEC, recorded rather than hidden ───────────────
-- The spec lists seven step types. Against the live corpus (107 recommended
-- steps) that taxonomy misses one real, recurring, and genuinely OBSERVABLE
-- case: "escalate to 2nd-line / the development team". Its signal is the same as
-- route_expert's — the Freshdesk group moves — so folding it into internal_check
-- would have thrown away a measurable step, and folding it into route_expert
-- would have been wrong (Expert is the legal-advisory tier specifically). It is
-- therefore an eighth type, `escalate`, flagged here for a human to accept or
-- reject rather than decided quietly.

-- ── 1. The recommended steps, typed ──────────────────────────────────────────
create table if not exists suggestion_next_steps (
  id            bigserial primary key,
  suggestion_id bigint not null references suggestions (id) on delete cascade,
  ticket_id     bigint not null,
  -- Position within the generation's resolution_steps array. Together with
  -- suggestion_id it makes backfill idempotent: re-running updates in place.
  step_index    integer not null,
  step_type     text not null check (step_type in (
                  'link_jira', 'link_linear', 'route_expert', 'escalate',
                  'copy_csm', 'offer_meeting', 'write_kb', 'internal_check')),
  step_text     text not null,
  target_ref    text,
  created_at    timestamptz not null default now(),
  unique (suggestion_id, step_index)
);

comment on table suggestion_next_steps is
  'Recommended next steps from suggestions.resolution_steps, classified into typed buckets IN CODE (classifyNextStep). A model may propose the prose; TypeScript decides the type.';

create index if not exists suggestion_next_steps_type_idx on suggestion_next_steps (step_type);
create index if not exists suggestion_next_steps_ticket_idx on suggestion_next_steps (ticket_id);

-- ── 2. What was actually observed ────────────────────────────────────────────
create table if not exists next_step_observations (
  id           bigserial primary key,
  next_step_id bigint not null references suggestion_next_steps (id) on delete cascade,
  observed     boolean not null default false,
  -- FALSE means "this step's system is not connected, or the step has no signal
  -- at all" — i.e. UNKNOWN. It must never be rendered as "the agent ignored it".
  observable   boolean not null default false,
  observed_at  timestamptz,
  observed_via text,
  checked_at   timestamptz not null default now(),
  unique (next_step_id)
);

comment on table next_step_observations is
  'Follow-through, OBSERVED from systems we already read — never self-reported. There is deliberately no UI path for an agent to set this: asking them is an extra task and it would stop being used.';
comment on column next_step_observations.observable is
  'False = we cannot see this signal (system not connected, or internal_check). Distinct from observed=false, which would mean "we looked and it did not happen".';

-- ── 3. Did the note beat the agent's first reply? ────────────────────────────
create table if not exists suggestion_delivery (
  suggestion_id        bigint primary key references suggestions (id) on delete cascade,
  ticket_id            bigint not null,
  note_created_at      timestamptz,
  first_agent_reply_at timestamptz,
  delivery_status      text not null check (delivery_status in ('in_time', 'late', 'no_reply_yet')),
  checked_at           timestamptz not null default now()
);

comment on table suggestion_delivery is
  'Note timing vs the first PUBLIC agent reply. A late note is a DELIVERY failure, not a bad suggestion — counted separately so the model is not blamed for advice the agent never saw. Target: under 2% late.';

-- ── 4. Locked historical baselines ───────────────────────────────────────────
create table if not exists coaching_baselines (
  metric_key  text primary key,
  value       numeric not null,
  unit        text not null,
  label       text not null,
  detail      text,
  source_note text not null,
  computed_at timestamptz not null
);

comment on table coaching_baselines is
  'Historical figures computed ONCE and locked, so a later change has something to be compared against. Never recomputed on page load — a baseline that moves is not a baseline.';

-- Values supplied with the build spec, measured from 24,023 Freshdesk tickets and
-- 2,198 Intercom conversations. Stored as data (not hardcoded in the page) so the
-- provenance and computation date travel with the number.
insert into coaching_baselines (metric_key, value, unit, label, detail, source_note, computed_at)
values
  ('reopen_rate', 11.1, '%', 'Reopen rate',
   'Intercom, 2026 · 243 of 2,198',
   'Intercom 2026: conversations with statistics.count_reopens > 0', '2026-08-04T00:00:00Z'),
  ('agent_replies_to_close', 3.83, 'replies', 'Agent replies to close',
   'Simployer One · 3.71 for Classic',
   'Freshdesk reports-data.agent-reply-count plus public notes', '2026-08-04T00:00:00Z'),
  ('median_time_to_close_h', 15.6, 'h', 'Median time to close',
   'Simployer One · 5.9 h for Classic',
   'Freshdesk ticket-states.resolution-time-by-bhrs', '2026-08-04T00:00:00Z'),
  ('first_reply_over_1h', 35.2, '%', 'First reply over 1 h',
   'Intercom, 2026 · 12 min median in 2024',
   'Intercom statistics.time_to_admin_reply > 3600', '2026-08-04T00:00:00Z')
on conflict (metric_key) do nothing;

-- The reference distribution behind the timing bar. Also locked history, kept as
-- rows so the page renders measured data rather than hardcoded flex values.
create table if not exists coaching_reply_distribution (
  bucket_key  text primary key,
  bucket_order integer not null,
  label       text not null,
  conversations integer not null,
  share_pct   numeric not null,
  source_note text not null,
  computed_at timestamptz not null
);

insert into coaching_reply_distribution (bucket_key, bucket_order, label, conversations, share_pct, source_note, computed_at)
values
  ('under_60s', 1, 'under 1 min',   45,  2.0, 'Intercom 2026, n=2,198', '2026-08-04T00:00:00Z'),
  ('1_5min',    2, '1–5 min',      212,  9.7, 'Intercom 2026, n=2,198', '2026-08-04T00:00:00Z'),
  ('5_15min',   3, '5–15 min',     332, 15.1, 'Intercom 2026, n=2,198', '2026-08-04T00:00:00Z'),
  ('over_15min',4, 'over 15 min', 1609, 73.2, 'Intercom 2026, n=2,198', '2026-08-04T00:00:00Z')
on conflict (bucket_key) do nothing;

-- ── RLS — same model as every other reviewer-readable table ──────────────────
alter table suggestion_next_steps     enable row level security;
alter table next_step_observations    enable row level security;
alter table suggestion_delivery       enable row level security;
alter table coaching_baselines        enable row level security;
alter table coaching_reply_distribution enable row level security;

grant select on suggestion_next_steps, next_step_observations, suggestion_delivery,
                coaching_baselines, coaching_reply_distribution to authenticated;

drop policy if exists next_steps_reviewer_read on suggestion_next_steps;
create policy next_steps_reviewer_read on suggestion_next_steps
  for select to authenticated using (is_reviewer());

drop policy if exists observations_reviewer_read on next_step_observations;
create policy observations_reviewer_read on next_step_observations
  for select to authenticated using (is_reviewer());

drop policy if exists delivery_reviewer_read on suggestion_delivery;
create policy delivery_reviewer_read on suggestion_delivery
  for select to authenticated using (is_reviewer());

drop policy if exists baselines_reviewer_read on coaching_baselines;
create policy baselines_reviewer_read on coaching_baselines
  for select to authenticated using (is_reviewer());

drop policy if exists reply_dist_reviewer_read on coaching_reply_distribution;
create policy reply_dist_reviewer_read on coaching_reply_distribution
  for select to authenticated using (is_reviewer());

-- DEFENCE IN DEPTH — and a real finding from verifying this live rather than
-- reading it. This project's DEFAULT PRIVILEGES already hand anon and
-- authenticated INSERT/UPDATE/DELETE/TRUNCATE on every new table in `public`, so
-- the `grant select` above ADDS to an already-wide grant instead of defining one.
-- RLS still blocks the rows, but a browser role holding DML on an observation
-- table is one mistaken policy away from a reviewer being able to declare their
-- own follow-through — exactly what "observed, never self-reported" forbids. So
-- the write privileges are revoked explicitly, and anon gets nothing at all.
revoke insert, update, delete, truncate, references, trigger
  on suggestion_next_steps, next_step_observations, suggestion_delivery,
     coaching_baselines, coaching_reply_distribution
  from anon, authenticated;

revoke select on suggestion_next_steps, next_step_observations, suggestion_delivery,
                 coaching_baselines, coaching_reply_distribution from anon;

-- Verified by EXECUTION (scripts/smoke_coaching.sql), not by reading:
--   reviewer reads · non-reviewer sees nothing · anon refused · nobody writes.
-- Acceptance criterion 5 is therefore enforced by the database, not by the
-- absence of a button in the UI.

-- ── Views the tab reads ──────────────────────────────────────────────────────

-- One row per recommended step, with everything the table needs.
create or replace view coaching_next_steps with (security_invoker = on) as
select
  ns.id             as next_step_id,
  ns.suggestion_id,
  ns.ticket_id,
  s.subject,
  s.ticket_url,
  ns.step_type,
  ns.step_text,
  ns.target_ref,
  o.observable,
  o.observed,
  o.observed_via,
  o.checked_at,
  d.delivery_status,
  d.note_created_at,
  d.first_agent_reply_at,
  s.verdict,
  s.coach_mode,
  c.cohort,
  s.created_at
from suggestion_next_steps ns
join suggestions s on s.id = ns.suggestion_id
left join next_step_observations o on o.next_step_id = ns.id
left join suggestion_delivery d on d.suggestion_id = ns.suggestion_id
left join ticket_cohorts c on c.ticket_id = ns.ticket_id
where s.error is null and s.prompt_version <> 'agent-scan' and not s.is_spam
order by s.created_at desc, ns.step_index;

comment on view coaching_next_steps is
  'The Next steps table. observable=false renders as "Not visible" — we cannot see it, which is not the same as the agent ignoring it.';

-- Delivery: the late-note failure rate, computed from real rows (never hardcoded).
create or replace view coaching_delivery_summary with (security_invoker = on) as
select
  count(*)                                                as measured,
  count(*) filter (where delivery_status = 'in_time')     as in_time,
  count(*) filter (where delivery_status = 'late')        as late,
  count(*) filter (where delivery_status = 'no_reply_yet') as no_reply_yet,
  round(100.0 * count(*) filter (where delivery_status = 'late')::numeric
        / nullif(count(*) filter (where delivery_status in ('in_time', 'late')), 0), 1) as late_pct
from suggestion_delivery;

comment on view coaching_delivery_summary is
  'Late-note rate. Target under 2%. Late notes are excluded from suggestion-quality metrics and counted here instead.';

-- The step-type mix, and the unobservable share that judges the PROMPT.
create or replace view coaching_step_mix with (security_invoker = on) as
select
  ns.step_type,
  count(*)                                          as steps,
  count(*) filter (where o.observable)              as observable,
  count(*) filter (where o.observed)                as followed,
  round(100.0 * count(*) filter (where o.observed)::numeric
        / nullif(count(*) filter (where o.observable), 0), 1) as followed_pct
from suggestion_next_steps ns
left join next_step_observations o on o.next_step_id = ns.id
group by ns.step_type
order by steps desc;

comment on view coaching_step_mix is
  'Step types by frequency. Watch the internal_check share: over ~15% the prompt is producing advice that cannot be evaluated, which is a prompt problem, not an agent problem.';

-- The pairing that is the actual metric. Followed-rate alone proves nothing —
-- an agent obeying bad advice is a cost — so follow-through is read against the
-- reopen/verdict outcome, and the holdout cohort sits beside it untouched.
create or replace view coaching_value_pairing with (security_invoker = on) as
with steps as (
  select
    ns.suggestion_id,
    bool_or(o.observable) as any_observable,
    bool_or(o.observed)   as any_followed
  from suggestion_next_steps ns
  left join next_step_observations o on o.next_step_id = ns.id
  group by ns.suggestion_id
)
select
  case
    when not st.any_observable then 'not observable'
    when st.any_followed then 'followed'
    else 'not followed'
  end as follow_through,
  coalesce(c.cohort, '(unassigned)') as cohort,
  count(*)                                              as suggestions,
  count(s.verdict)                                      as judged,
  count(*) filter (where s.verdict = 'usable')          as usable,
  count(*) filter (where s.verdict = 'unusable')        as unusable,
  round(100.0 * count(*) filter (where s.verdict = 'usable')::numeric
        / nullif(count(s.verdict), 0), 1)               as usable_pct
from steps st
join suggestions s on s.id = st.suggestion_id
left join ticket_cohorts c on c.ticket_id = s.ticket_id
where s.error is null and s.prompt_version <> 'agent-scan' and not s.is_spam
group by 1, 2
order by 1, 2;

comment on view coaching_value_pairing is
  'Follow-through paired with outcome. Followed-rate on its own proves nothing; an agent obeying bad advice is a cost. Holdout rows are shown separately and never mixed in.';

-- Advice that failed: followed and it still went wrong, or not followed at all —
-- with the delivery status attached, so a LATE note is never misread as bad advice.
create or replace view coaching_failed_advice with (security_invoker = on) as
select
  ns.id as next_step_id,
  ns.ticket_id,
  s.id  as suggestion_id,
  s.subject,
  s.ticket_url,
  ns.step_type,
  ns.step_text,
  o.observable,
  o.observed,
  d.delivery_status,
  s.verdict,
  s.verdict_reasons,
  s.critical_flag,
  s.created_at,
  case
    when d.delivery_status = 'late' then 'note arrived after the first agent reply'
    when o.observed and s.verdict = 'unusable' then 'step was followed and the reply was still unusable'
    when o.observable and not o.observed and s.verdict = 'unusable' then 'step was not taken'
    else 'flagged'
  end as failure_kind
from suggestion_next_steps ns
join suggestions s on s.id = ns.suggestion_id
left join next_step_observations o on o.next_step_id = ns.id
left join suggestion_delivery d on d.suggestion_id = ns.suggestion_id
where s.error is null and s.prompt_version <> 'agent-scan' and not s.is_spam
  and (d.delivery_status = 'late'
       or (s.verdict = 'unusable' and o.observable))
order by s.created_at desc;

comment on view coaching_failed_advice is
  'The most useful rows in the app: advice that was followed and still failed, or that never reached the agent. Delivery status is attached so a late note is not misread as bad advice.';

-- A recurring step type that keeps failing is a PROMPT problem, not an agent one.
create or replace view coaching_failure_patterns with (security_invoker = on) as
select
  ns.step_type,
  count(*) as occurrences,
  count(*) filter (where not o.observable) as unobservable,
  count(*) filter (where s.verdict = 'unusable') as unusable,
  count(distinct ns.ticket_id) as tickets,
  max(s.created_at) as last_seen
from suggestion_next_steps ns
join suggestions s on s.id = ns.suggestion_id
left join next_step_observations o on o.next_step_id = ns.id
where s.error is null and s.prompt_version <> 'agent-scan' and not s.is_spam
group by ns.step_type
having count(*) filter (where not o.observable) > 0 or count(*) filter (where s.verdict = 'unusable') > 0
order by unobservable desc, unusable desc;

comment on view coaching_failure_patterns is
  'Step types that repeatedly cannot be observed or repeatedly end unusable. Rewrite the step so it has a signal, or drop it.';

-- Knowledge produced: the weekly documentation backlog, DERIVED not reported.
-- Reuses the existing knowledge-gap and article machinery rather than adding a
-- fourth way to say the same thing.
create or replace view coaching_knowledge_produced with (security_invoker = on) as
select
  -- the answer already existed: we grounded it in a real source
  count(*) filter (where s.grounding_verified is true)                       as documented,
  -- a product limitation to log as a wish (no Linear client — see step mix)
  count(*) filter (where s.ticket_type = 'bug' and s.confidence = 'none')    as wish,
  -- nothing written anywhere: the pipeline could not ground it at all
  count(*) filter (where g.ticket_id is not null)                            as gap
from suggestions s
left join knowledge_gap_tickets g on g.id = s.id
where s.error is null and s.prompt_version <> 'agent-scan' and not s.is_spam;

comment on view coaching_knowledge_produced is
  'The three closing states of a note, derived from existing pipeline output: documented (grounded), wish (unresolved product bug), gap (could not be grounded — see knowledge_gaps).';

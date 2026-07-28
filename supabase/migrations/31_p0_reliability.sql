-- Migration 31 — P0 reliability: immutable generations, separate reviews,
-- idempotent delivery state, durable polling, and a distributed poll lease.
--
-- This migration deliberately keeps `suggestions` as the generation table so the
-- existing review UI and reporting views remain compatible. Human review is now
-- canonical in `suggestion_reviews`; the old review columns on `suggestions` are a
-- read-compatible projection maintained only by the review RPCs below.

create extension if not exists pgcrypto;

-- ── Immutable generation identity + delivery outbox ──────────────────────────

alter table suggestions
  add column if not exists run_variant text,
  add column if not exists delivery_status text,
  add column if not exists note_html text,
  add column if not exists delivery_marker text,
  add column if not exists reservation_token uuid,
  add column if not exists reserved_at timestamptz,
  add column if not exists reservation_expires_at timestamptz,
  add column if not exists posting_started_at timestamptz,
  add column if not exists posted_at timestamptz,
  add column if not exists post_attempts integer not null default 0,
  add column if not exists feedback_token_expires_at timestamptz,
  add column if not exists feedback_token_used_at timestamptz;

update suggestions
set
  model = coalesce(nullif(model, ''), 'unknown'),
  run_variant = coalesce(
    nullif(run_variant, ''),
    case
      when prompt_version = 'agent-scan' then 'agent-scan'
      when prompt_version like '%+gold' then 'legacy-gold'
      else 'legacy'
    end
  ),
  delivery_status = coalesce(
    delivery_status,
    case
      when note_id is not null then 'posted'
      when error is not null then 'failed'
      else 'generated'
    end
  ),
  posted_at = case
    when note_id is not null then coalesce(posted_at, created_at)
    else posted_at
  end;

alter table suggestions
  alter column model set default 'unknown',
  alter column model set not null,
  alter column run_variant set default 'legacy',
  alter column run_variant set not null,
  alter column delivery_status set default 'generated',
  alter column delivery_status set not null;

alter table suggestions
  add constraint suggestions_delivery_status_chk
    check (delivery_status in ('reserved', 'generated', 'posting', 'posted', 'failed')),
  add constraint suggestions_post_attempts_chk
    check (post_attempts >= 0);

-- The old key collapsed every prompt/model/variant into one mutable row. From now
-- on, a generation is a distinct, immutable experimental observation.
drop index if exists suggestions_ticket_msg_uidx;
create unique index suggestions_generation_key_uidx
  on suggestions (ticket_id, trigger_message_id, prompt_version, model, run_variant);

create unique index suggestions_delivery_marker_uidx
  on suggestions (delivery_marker)
  where delivery_marker is not null;

create index suggestions_delivery_resume_idx
  on suggestions (delivery_status, reservation_expires_at)
  where delivery_status in ('reserved', 'generated', 'posting', 'failed');

comment on column suggestions.run_variant is
  'Execution variant that changes generation semantics, e.g. live, dry-run, replay, replay:tier=<model>. Part of the immutable generation key.';
comment on column suggestions.delivery_status is
  'Outbox state: reserved -> generated -> posting -> posted; failed is visible and resumable.';
comment on column suggestions.delivery_marker is
  'Unique marker embedded in the Freshdesk note. Used to recover an accepted POST after a lost/5xx response without posting a duplicate.';

-- Once a row has left `reserved`, generation payload cannot be replaced. Delivery,
-- usage, QA-history, and the compatibility review projection remain mutable.
create or replace function protect_generation_payload() returns trigger
  language plpgsql set search_path = public as $$
declare
  old_payload jsonb;
  new_payload jsonb;
  mutable_columns constant text[] := array[
    'note_id', 'delivery_status', 'reservation_token', 'reserved_at',
    'reservation_expires_at', 'posting_started_at', 'posted_at', 'post_attempts',
    'error', 'used', 'similarity',
    'verdict', 'verdict_at', 'verdict_by', 'verdict_reasons', 'critical_flag',
    'review_version', 'gold_answer', 'gold_answer_at', 'gold_answer_by', 'is_spam',
    'agent_qa_version', 'agent_qa_score', 'agent_qa_verdict',
    'agent_qa_needs_review', 'agent_qa_assessment',
    'feedback_token_used_at'
  ];
begin
  if old.delivery_status <> 'reserved' then
    old_payload := to_jsonb(old) - mutable_columns;
    new_payload := to_jsonb(new) - mutable_columns;
    if old_payload is distinct from new_payload then
      raise exception 'generation % is immutable after status %', old.id, old.delivery_status
        using errcode = '55000';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_protect_generation_payload on suggestions;
create trigger trg_protect_generation_payload
  before update on suggestions
  for each row execute function protect_generation_payload();

revoke execute on function protect_generation_payload() from public, anon, authenticated;

-- ── Reviews are separate from generations ────────────────────────────────────

create table suggestion_reviews (
  id               bigint generated always as identity primary key,
  generation_id    bigint not null references suggestions(id) on delete restrict,
  reviewer_email   text not null,
  verdict           text,
  verdict_reasons   jsonb not null default '[]'::jsonb,
  critical_flag     text,
  gold_answer       text,
  is_spam           boolean not null default false,
  review_version    integer not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint suggestion_reviews_generation_reviewer_uidx
    unique (generation_id, reviewer_email),
  constraint suggestion_reviews_verdict_chk
    check (verdict in ('usable', 'edited', 'unusable') or verdict is null),
  constraint suggestion_reviews_version_chk
    check (review_version > 0),
  constraint suggestion_reviews_critical_chk
    check (
      critical_flag in (
        'legal_advice', 'wrongful_deletion', 'unauthorized_access',
        'pii_risk', 'false_promise', 'invented_feature'
      ) or critical_flag is null
    )
);

alter table suggestion_reviews enable row level security;
revoke all on suggestion_reviews from anon;
revoke all on suggestion_reviews from authenticated;
grant select on suggestion_reviews to authenticated;

create policy reviewers_read_generation_reviews on suggestion_reviews
  for select to authenticated using (is_reviewer());

create index suggestion_reviews_generation_updated_idx
  on suggestion_reviews (generation_id, updated_at desc, id desc);

comment on table suggestion_reviews is
  'Human judgements keyed to one immutable generation. A new prompt/model/variant gets a new generation and can never inherit an older verdict.';

-- Preserve already-collected review/training data as a legacy review record.
insert into suggestion_reviews (
  generation_id, reviewer_email, verdict, verdict_reasons, critical_flag,
  gold_answer, is_spam, review_version, created_at, updated_at
)
select
  id,
  lower(coalesce(nullif(verdict_by, ''), nullif(gold_answer_by, ''), 'legacy-migration@system')),
  verdict,
  coalesce(verdict_reasons, '[]'::jsonb),
  critical_flag,
  gold_answer,
  coalesce(is_spam, false),
  greatest(coalesce(review_version, 0), 1),
  created_at,
  coalesce(verdict_at, gold_answer_at, created_at)
from suggestions
where verdict is not null
   or gold_answer is not null
   or coalesce(is_spam, false)
on conflict (generation_id, reviewer_email) do nothing;

-- A single read projection for reporting/diagnostics when multiple reviewers have
-- assessed the same generation. The newest review wins; every reviewer row remains.
create or replace view latest_suggestion_reviews with (security_invoker = on) as
select distinct on (generation_id)
  id, generation_id, reviewer_email, verdict, verdict_reasons, critical_flag,
  gold_answer, is_spam, review_version, created_at, updated_at
from suggestion_reviews
where verdict is not null
order by generation_id, updated_at desc, id desc;

-- Remove direct browser writes to the generation row. The authenticated review app
-- must use the narrow SECURITY DEFINER RPCs, which verify the allowlist and keep the
-- canonical review + compatibility projection in one transaction.
revoke update (
  verdict, verdict_at, verdict_by, verdict_reasons, critical_flag, review_version,
  gold_answer, is_spam
) on suggestions from authenticated;

create or replace function submit_generation_verdict(
  p_generation_id bigint,
  p_expected_version integer,
  p_verdict text,
  p_verdict_reasons jsonb default '[]'::jsonb,
  p_critical_flag text default null
)
returns table (
  review_id bigint,
  review_version integer,
  verdict text,
  verdict_reasons jsonb,
  critical_flag text,
  reviewer_email text,
  updated_at timestamptz
)
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_review suggestion_reviews%rowtype;
  v_verdict text := p_verdict;
begin
  if not is_reviewer() or v_email = '' then
    raise exception 'reviewer access required' using errcode = '42501';
  end if;
  if p_verdict not in ('usable', 'edited', 'unusable') then
    raise exception 'invalid verdict' using errcode = '22023';
  end if;
  if p_critical_flag is not null and length(trim(p_critical_flag)) > 0 then
    v_verdict := 'unusable';
  end if;

  select * into v_review
  from suggestion_reviews
  where generation_id = p_generation_id and reviewer_email = v_email
  for update;

  if not found then
    if coalesce(p_expected_version, 0) <> 0 then
      raise exception 'review version conflict' using errcode = '40001';
    end if;
    insert into suggestion_reviews (
      generation_id, reviewer_email, verdict, verdict_reasons, critical_flag
    ) values (
      p_generation_id, v_email, v_verdict,
      coalesce(p_verdict_reasons, '[]'::jsonb), nullif(trim(p_critical_flag), '')
    )
    returning * into v_review;
  else
    if v_review.review_version <> coalesce(p_expected_version, 0) then
      raise exception 'review version conflict' using errcode = '40001';
    end if;
    update suggestion_reviews
    set
      verdict = v_verdict,
      verdict_reasons = coalesce(p_verdict_reasons, '[]'::jsonb),
      critical_flag = nullif(trim(p_critical_flag), ''),
      review_version = suggestion_reviews.review_version + 1,
      updated_at = now()
    where id = v_review.id
    returning * into v_review;
  end if;

  update suggestions
  set
    verdict = v_review.verdict,
    verdict_reasons = v_review.verdict_reasons,
    critical_flag = v_review.critical_flag,
    verdict_at = v_review.updated_at,
    verdict_by = v_review.reviewer_email,
    review_version = v_review.review_version
  where id = p_generation_id;

  return query select
    v_review.id, v_review.review_version, v_review.verdict,
    v_review.verdict_reasons, v_review.critical_flag,
    v_review.reviewer_email, v_review.updated_at;
end $$;

create or replace function save_generation_gold_answer(
  p_generation_id bigint,
  p_gold_answer text
)
returns table (
  review_id bigint,
  review_version integer,
  gold_answer text,
  reviewer_email text,
  updated_at timestamptz
)
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_review suggestion_reviews%rowtype;
begin
  if not is_reviewer() or v_email = '' then
    raise exception 'reviewer access required' using errcode = '42501';
  end if;

  insert into suggestion_reviews (generation_id, reviewer_email, gold_answer)
  values (p_generation_id, v_email, p_gold_answer)
  on conflict (generation_id, reviewer_email) do update
  set
    gold_answer = excluded.gold_answer,
    review_version = suggestion_reviews.review_version + 1,
    updated_at = now()
  returning * into v_review;

  update suggestions
  set
    gold_answer = v_review.gold_answer,
    gold_answer_at = v_review.updated_at,
    gold_answer_by = v_review.reviewer_email,
    review_version = greatest(review_version, v_review.review_version)
  where id = p_generation_id;

  return query select
    v_review.id, v_review.review_version, v_review.gold_answer,
    v_review.reviewer_email, v_review.updated_at;
end $$;

create or replace function mark_generation_spam(
  p_generation_id bigint
)
returns table (ticket_id bigint, reviewer_email text, updated_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_review suggestion_reviews%rowtype;
  v_ticket_id bigint;
begin
  if not is_reviewer() or v_email = '' then
    raise exception 'reviewer access required' using errcode = '42501';
  end if;

  select s.ticket_id into v_ticket_id from suggestions s where s.id = p_generation_id;
  if v_ticket_id is null then
    raise exception 'generation not found' using errcode = 'P0002';
  end if;

  insert into suggestion_reviews (generation_id, reviewer_email, is_spam)
  values (p_generation_id, v_email, true)
  on conflict (generation_id, reviewer_email) do update
  set
    is_spam = true,
    review_version = suggestion_reviews.review_version + 1,
    updated_at = now()
  returning * into v_review;

  -- Spam/noise is a ticket property for ingest/eval purposes, so mirror it to all
  -- generations of the same ticket. The canonical actor/time remains in the review.
  update suggestions set is_spam = true where suggestions.ticket_id = v_ticket_id;

  return query select v_ticket_id, v_review.reviewer_email, v_review.updated_at;
end $$;

revoke execute on function submit_generation_verdict(bigint, integer, text, jsonb, text)
  from public, anon;
revoke execute on function save_generation_gold_answer(bigint, text)
  from public, anon;
revoke execute on function mark_generation_spam(bigint)
  from public, anon;
grant execute on function submit_generation_verdict(bigint, integer, text, jsonb, text)
  to authenticated;
grant execute on function save_generation_gold_answer(bigint, text)
  to authenticated;
grant execute on function mark_generation_spam(bigint)
  to authenticated;

-- Legacy private notes may still contain token links. GET no longer writes; after
-- explicit confirmation the feedback function calls this one-use, transactional RPC.
create or replace function record_legacy_feedback(
  p_token text,
  p_verdict text
)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_generation suggestions%rowtype;
  v_review suggestion_reviews%rowtype;
  v_actor constant text := 'legacy-note-feedback@system';
begin
  if p_verdict not in ('usable', 'edited', 'unusable') then
    raise exception 'invalid verdict' using errcode = '22023';
  end if;

  select * into v_generation
  from suggestions
  where feedback_token = p_token
  for update;

  if not found then
    raise exception 'feedback token not found' using errcode = 'P0002';
  end if;
  if v_generation.feedback_token_used_at is not null then
    raise exception 'feedback token already used' using errcode = '55000';
  end if;
  if coalesce(
    v_generation.feedback_token_expires_at,
    v_generation.created_at + interval '30 days'
  ) < now() then
    raise exception 'feedback token expired' using errcode = '22023';
  end if;

  insert into suggestion_reviews (generation_id, reviewer_email, verdict)
  values (v_generation.id, v_actor, p_verdict)
  on conflict (generation_id, reviewer_email) do update
  set
    verdict = excluded.verdict,
    review_version = suggestion_reviews.review_version + 1,
    updated_at = now()
  returning * into v_review;

  update suggestions
  set
    verdict = v_review.verdict,
    verdict_at = v_review.updated_at,
    verdict_by = v_actor,
    review_version = greatest(review_version, v_review.review_version),
    feedback_token_used_at = now()
  where id = v_generation.id;

  return v_generation.ticket_id;
end $$;

revoke execute on function record_legacy_feedback(text, text)
  from public, anon, authenticated;
grant execute on function record_legacy_feedback(text, text) to service_role;

-- ── Atomic generation reservation / outbox resume ────────────────────────────

create or replace function reserve_generation(
  p_ticket_id bigint,
  p_trigger_message_id text,
  p_subject text,
  p_prompt_version text,
  p_model text,
  p_run_variant text,
  p_reservation_token uuid,
  p_lease_seconds integer default 180
)
returns table (generation_id bigint, action text)
language plpgsql security definer set search_path = public as $$
declare
  v_row suggestions%rowtype;
begin
  select * into v_row
  from suggestions
  where ticket_id = p_ticket_id
    and trigger_message_id = p_trigger_message_id
    and prompt_version = p_prompt_version
    and model = p_model
    and run_variant = p_run_variant
  for update;

  if not found then
    insert into suggestions (
      ticket_id, trigger_message_id, subject, confidence, prompt_version, model,
      run_variant, delivery_status, reservation_token, reserved_at,
      reservation_expires_at
    ) values (
      p_ticket_id, p_trigger_message_id, p_subject, 'none', p_prompt_version, p_model,
      p_run_variant, 'reserved', p_reservation_token, now(),
      now() + make_interval(secs => greatest(p_lease_seconds, 30))
    )
    returning * into v_row;
    return query select v_row.id, 'generate'::text;
    return;
  end if;

  if v_row.delivery_status = 'posted'
     or (p_run_variant = 'dry-run' and v_row.delivery_status = 'generated') then
    return query select v_row.id, 'skip'::text;
    return;
  end if;

  if v_row.reservation_expires_at is not null
     and v_row.reservation_expires_at > now()
     and v_row.delivery_status in ('reserved', 'posting') then
    return query select v_row.id, 'skip'::text;
    return;
  end if;

  if v_row.note_html is not null
     and v_row.delivery_status in ('generated', 'posting', 'failed') then
    update suggestions
    set
      reservation_token = p_reservation_token,
      reserved_at = now(),
      reservation_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 30))
    where id = v_row.id;
    return query select v_row.id, 'deliver'::text;
    return;
  end if;

  if v_row.delivery_status in ('reserved', 'failed') then
    update suggestions
    set
      delivery_status = 'reserved',
      reservation_token = p_reservation_token,
      reserved_at = now(),
      reservation_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 30)),
      error = null
    where id = v_row.id;
    return query select v_row.id, 'generate'::text;
    return;
  end if;

  return query select v_row.id, 'skip'::text;
end $$;

revoke execute on function reserve_generation(bigint, text, text, text, text, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function reserve_generation(bigint, text, text, text, text, text, uuid, integer)
  to service_role;

-- ── Durable cursor + queue + global poll lease ────────────────────────────────

create table poll_cursors (
  stream_name text primary key,
  last_updated_at timestamptz not null,
  last_ticket_id bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table ticket_poll_queue (
  id bigint generated always as identity primary key,
  stream_name text not null,
  ticket_id bigint not null,
  ticket_updated_at timestamptz not null,
  subject text,
  responder_id bigint,
  state text not null default 'queued'
    check (state in ('queued', 'done', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (stream_name, ticket_id, ticket_updated_at)
);

create index ticket_poll_queue_ready_idx
  on ticket_poll_queue (stream_name, ticket_updated_at, ticket_id)
  where state = 'queued';

create table poll_leases (
  lease_name text primary key,
  lease_token uuid not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table poll_cursors enable row level security;
alter table ticket_poll_queue enable row level security;
alter table poll_leases enable row level security;
revoke all on poll_cursors from anon, authenticated;
revoke all on ticket_poll_queue from anon, authenticated;
revoke all on poll_leases from anon, authenticated;

create or replace function acquire_poll_lease(
  p_lease_name text,
  p_lease_token uuid,
  p_ttl_seconds integer default 180
)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_token uuid;
begin
  insert into poll_leases (lease_name, lease_token, expires_at, updated_at)
  values (
    p_lease_name, p_lease_token,
    now() + make_interval(secs => greatest(p_ttl_seconds, 30)), now()
  )
  on conflict (lease_name) do update
  set
    lease_token = excluded.lease_token,
    expires_at = excluded.expires_at,
    updated_at = now()
  where poll_leases.expires_at < now()
     or poll_leases.lease_token = p_lease_token
  returning lease_token into v_token;

  return v_token = p_lease_token;
end $$;

create or replace function release_poll_lease(
  p_lease_name text,
  p_lease_token uuid
)
returns boolean
language sql security definer set search_path = public as $$
  delete from poll_leases
  where lease_name = p_lease_name and lease_token = p_lease_token
  returning true;
$$;

create or replace function enqueue_ticket_updates(
  p_stream_name text,
  p_events jsonb,
  p_cursor_updated_at timestamptz,
  p_cursor_ticket_id bigint
)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_inserted integer := 0;
begin
  with inserted as (
    insert into ticket_poll_queue (
      stream_name, ticket_id, ticket_updated_at, subject, responder_id
    )
    select
      p_stream_name,
      e.ticket_id,
      e.ticket_updated_at,
      e.subject,
      e.responder_id
    from jsonb_to_recordset(coalesce(p_events, '[]'::jsonb)) as e(
      ticket_id bigint,
      ticket_updated_at timestamptz,
      subject text,
      responder_id bigint
    )
    on conflict (stream_name, ticket_id, ticket_updated_at) do nothing
    returning 1
  )
  select count(*) into v_inserted from inserted;

  insert into poll_cursors (
    stream_name, last_updated_at, last_ticket_id, updated_at
  ) values (
    p_stream_name, p_cursor_updated_at, p_cursor_ticket_id, now()
  )
  on conflict (stream_name) do update
  set
    last_updated_at = excluded.last_updated_at,
    last_ticket_id = excluded.last_ticket_id,
    updated_at = now()
  where (poll_cursors.last_updated_at, poll_cursors.last_ticket_id)
      < (excluded.last_updated_at, excluded.last_ticket_id);

  return v_inserted;
end $$;

revoke execute on function acquire_poll_lease(text, uuid, integer)
  from public, anon, authenticated;
revoke execute on function release_poll_lease(text, uuid)
  from public, anon, authenticated;
revoke execute on function enqueue_ticket_updates(text, jsonb, timestamptz, bigint)
  from public, anon, authenticated;
grant execute on function acquire_poll_lease(text, uuid, integer) to service_role;
grant execute on function release_poll_lease(text, uuid) to service_role;
grant execute on function enqueue_ticket_updates(text, jsonb, timestamptz, bigint)
  to service_role;

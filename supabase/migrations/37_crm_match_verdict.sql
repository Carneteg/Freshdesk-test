-- Migration 37 — measure CRM-match PRECISION (was it the RIGHT account?), not
-- just coverage. crm_match_scorecard (migr 34/35) counts how often the ladder
-- finds an account; nothing verifies it found the CORRECT one. Ground truth
-- comes from two sources:
--   1. a reviewer micro-verdict in the review app ("Right CRM account?
--      yes / no / unsure"), stored per (generation, reviewer);
--   2. retroactively, the curated crm_account_map: once a human maps a key to
--      the true account, every stored match on that key can be auto-audited.
--
-- Design constraints honoured here:
--   * protect_generation_payload allowlists mutable columns — the new
--     projection column must join that list or the guard rejects the update.
--   * suggestion_reviews.review_version is constrained >= 1 and the verdict
--     RPC's optimistic lock compares against it. The micro-verdict never BUMPS
--     the version (it is match metadata), and it RETURNS + PROJECTS the current
--     version so the app can keep its in-memory lock state in sync — otherwise
--     judging right after a CRM check would raise "review version conflict".
--   * Same 42702 lesson as migration 36: RETURNS TABLE names shadow columns,
--     so #variable_conflict use_column + qualified references.

alter table suggestions
  add column if not exists crm_account_correct text
    check (crm_account_correct in ('yes', 'no', 'unsure'));

alter table suggestion_reviews
  add column if not exists crm_account_correct text
    check (crm_account_correct in ('yes', 'no', 'unsure'));

-- The guard's allowlist gains the new review-projection column.
create or replace function public.protect_generation_payload() returns trigger
language plpgsql
set search_path to 'public'
as $$
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
    'feedback_token_used_at', 'crm_account_correct'
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

create or replace function public.submit_crm_match_verdict(
  p_generation_id bigint,
  p_correct text
) returns table (
  review_id bigint,
  crm_account_correct text,
  review_version integer,
  reviewer_email text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_review suggestion_reviews%rowtype;
begin
  if not is_reviewer() or v_email = '' then
    raise exception 'reviewer access required' using errcode = '42501';
  end if;
  if p_correct not in ('yes', 'no', 'unsure') then
    raise exception 'invalid crm verdict' using errcode = '22023';
  end if;

  -- A new review row takes the default version (1, enforced >= 1 by
  -- suggestion_reviews_version_chk); an existing row's version is NOT bumped —
  -- this is match metadata. The current version is returned AND projected so
  -- the app can keep its optimistic reply-verdict lock in sync.
  insert into suggestion_reviews (generation_id, reviewer_email, crm_account_correct)
  values (p_generation_id, v_email, p_correct)
  on conflict (generation_id, reviewer_email) do update
  set
    crm_account_correct = excluded.crm_account_correct,
    updated_at = now()
  returning * into v_review;

  update suggestions
  set
    crm_account_correct = v_review.crm_account_correct,
    review_version = greatest(suggestions.review_version, v_review.review_version)
  where id = p_generation_id;

  return query select
    v_review.id, v_review.crm_account_correct, v_review.review_version,
    v_review.reviewer_email, v_review.updated_at;
end $$;

-- Precision per matching tier, from the human micro-verdicts.
create or replace view crm_match_precision with (security_invoker = on) as
select
  customer_subscriptions ->> 'matchedBy' as matched_by,
  count(*) as found_total,
  count(*) filter (where crm_account_correct = 'yes') as confirmed_right,
  count(*) filter (where crm_account_correct = 'no') as confirmed_wrong,
  count(*) filter (where crm_account_correct = 'unsure') as unsure,
  count(*) filter (where crm_account_correct is null) as unreviewed,
  round(
    100.0 * count(*) filter (where crm_account_correct = 'yes')
      / nullif(count(*) filter (where crm_account_correct in ('yes', 'no')), 0),
    1
  ) as precision_pct
from suggestions
where customer_subscriptions ->> 'status' = 'found'
  and prompt_version <> 'agent-scan'
group by 1
order by found_total desc;

-- Retroactive audit: stored matches vs the account map, keyed on the requester
-- email DOMAIN (extracted from the stored context; the Freshdesk company id is
-- not persisted on generations yet — company-keyed audit lands with the next
-- pipeline deploy). `human` rows are curated ground truth; `learned` rows come
-- from exact contact-email matches, so agreement with a WEAK-tier match is the
-- "stronger evidence" cross-check. Reads crm_account_map (RLS deny-all), so
-- this view returns rows for the service role only.
create or replace view crm_match_retro_audit with (security_invoker = on) as
with found as (
  select
    id as generation_id,
    ticket_id,
    created_at,
    customer_subscriptions ->> 'matchedBy' as matched_by,
    (customer_subscriptions ->> 'accountId')::bigint as matched_account_id,
    crm_account_correct as human_verdict,
    lower(split_part(
      substring(conversation_context from '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+'), '@', 2
    )) as requester_domain
  from suggestions
  where customer_subscriptions ->> 'status' = 'found'
    and prompt_version <> 'agent-scan'
)
select
  f.generation_id,
  f.ticket_id,
  f.created_at,
  f.matched_by,
  f.matched_account_id,
  f.human_verdict,
  m.crm_account_id as map_account_id,
  m.source as map_source,
  (m.crm_account_id = f.matched_account_id) as agrees_with_map
from found f
join crm_account_map m
  on m.active and m.email_domain = f.requester_domain
order by f.created_at desc;

-- Migration 38 — let agents give CRM feedback on EVERY outcome, not just hits.
--
-- Migration 37 shipped a "Right CRM account?" micro-verdict, but only rendered
-- it when the lookup FOUND an account. Every real row so far is `no_match`, so
-- the instrument could collect nothing at all — and the silent cases are the
-- valuable ones: only the agent knows whether a customer we failed to match
-- actually exists in the CRM. Without that we measure precision and stay blind
-- to misses.
--
-- Vocabulary (replaces yes/no/unsure; no stored rows yet, so no back-fill):
--   correct     — the account shown is the right one
--   wrong       — the account shown is the WRONG customer  (precision failure)
--   missed      — nothing/ambiguous was shown, but the customer IS in the CRM
--                 (recall failure — the case we were blind to)
--   not_in_crm  — nothing was shown, and that is correct    (true negative)
--   unsure
--
-- `crm_account_hint` captures the agent's free-text "it should be <account>",
-- which is what makes a miss actionable: it becomes the curation queue for
-- crm_account_map (curate once, resolve forever). Filling that table stays a
-- deliberate human step — same stance as known_incidents: operational facts are
-- team-confirmed, never auto-written from a guess.

-- Replace the old value constraints (auto-named; drop defensively by lookup).
do $$
declare c record;
begin
  for c in
    select conrelid::regclass as tbl, conname
    from pg_constraint
    where contype = 'c'
      and conrelid in ('suggestions'::regclass, 'suggestion_reviews'::regclass)
      and pg_get_constraintdef(oid) ilike '%crm_account_correct%'
  loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end $$;

alter table suggestions
  add column if not exists crm_account_hint text,
  add constraint suggestions_crm_account_correct_chk
    check (crm_account_correct in ('correct', 'wrong', 'missed', 'not_in_crm', 'unsure'));

alter table suggestion_reviews
  add column if not exists crm_account_hint text,
  add constraint suggestion_reviews_crm_account_correct_chk
    check (crm_account_correct in ('correct', 'wrong', 'missed', 'not_in_crm', 'unsure'));

-- The payload guard is an explicit allowlist — the new review column must join
-- it or the write is rejected as a payload mutation.
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
    'feedback_token_used_at', 'crm_account_correct', 'crm_account_hint'
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

drop function if exists public.submit_crm_match_verdict(bigint, text);

create or replace function public.submit_crm_match_verdict(
  p_generation_id bigint,
  p_correct text,
  p_hint text default null
) returns table (
  review_id bigint,
  crm_account_correct text,
  crm_account_hint text,
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
  v_hint text := nullif(btrim(coalesce(p_hint, '')), '');
begin
  if not is_reviewer() or v_email = '' then
    raise exception 'reviewer access required' using errcode = '42501';
  end if;
  if p_correct not in ('correct', 'wrong', 'missed', 'not_in_crm', 'unsure') then
    raise exception 'invalid crm verdict' using errcode = '22023';
  end if;

  -- Match metadata: never bumps review_version (which drives the reply-verdict
  -- optimistic lock), but returns and projects it so the app stays in sync.
  insert into suggestion_reviews (
    generation_id, reviewer_email, crm_account_correct, crm_account_hint
  )
  values (p_generation_id, v_email, p_correct, v_hint)
  on conflict (generation_id, reviewer_email) do update
  set
    crm_account_correct = excluded.crm_account_correct,
    crm_account_hint = coalesce(excluded.crm_account_hint, suggestion_reviews.crm_account_hint),
    updated_at = now()
  returning * into v_review;

  update suggestions
  set
    crm_account_correct = v_review.crm_account_correct,
    crm_account_hint = v_review.crm_account_hint,
    review_version = greatest(suggestions.review_version, v_review.review_version)
  where id = p_generation_id;

  return query select
    v_review.id, v_review.crm_account_correct, v_review.crm_account_hint,
    v_review.review_version, v_review.reviewer_email, v_review.updated_at;
end $$;

-- The view's column list changes shape, so CREATE OR REPLACE cannot be used.
drop view if exists crm_match_precision;

-- Precision AND recall per outcome. Grouped by what the system DID (status +
-- tier), so a tier that never fires is as visible as one that fires wrongly.
create or replace view crm_match_precision with (security_invoker = on) as
select
  customer_subscriptions ->> 'status' as crm_status,
  coalesce(customer_subscriptions ->> 'matchedBy', '(none)') as matched_by,
  count(*) as generations,
  count(*) filter (where crm_account_correct = 'correct') as confirmed_right,
  count(*) filter (where crm_account_correct = 'wrong') as confirmed_wrong,
  count(*) filter (where crm_account_correct = 'missed') as missed_but_in_crm,
  count(*) filter (where crm_account_correct = 'not_in_crm') as correctly_absent,
  count(*) filter (where crm_account_correct = 'unsure') as unsure,
  count(*) filter (where crm_account_correct is null) as unreviewed,
  -- of the accounts we DID show, how many were right
  round(
    100.0 * count(*) filter (where crm_account_correct = 'correct')
      / nullif(count(*) filter (where crm_account_correct in ('correct', 'wrong')), 0),
    1
  ) as precision_pct,
  -- of the customers that ARE in the CRM, how many did we actually surface
  round(
    100.0 * count(*) filter (where crm_account_correct = 'correct')
      / nullif(count(*) filter (where crm_account_correct in ('correct', 'missed')), 0),
    1
  ) as recall_pct
from suggestions
where customer_subscriptions is not null
  and prompt_version <> 'agent-scan'
group by 1, 2
order by generations desc;

-- The payoff: every miss/mistake an agent reported, with their hint and the keys
-- needed to write a permanent crm_account_map row. This is the weekly "curate
-- these" list — deliberately a view, not an auto-writer.
create or replace view crm_curation_queue with (security_invoker = on) as
select
  s.id as generation_id,
  s.ticket_id,
  s.created_at,
  s.crm_account_correct as agent_says,
  s.crm_account_hint as agent_hint,
  s.customer_subscriptions ->> 'status' as crm_status,
  s.customer_subscriptions ->> 'matchedBy' as matched_by,
  (s.customer_subscriptions ->> 'accountId')::bigint as shown_account_id,
  lower(split_part(
    substring(s.conversation_context from '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+'), '@', 2
  )) as requester_domain
from suggestions s
where s.crm_account_correct in ('wrong', 'missed')
  and s.prompt_version <> 'agent-scan'
order by s.created_at desc;

-- Migration 36 — fix 42702 "column reference is ambiguous" in the review RPCs.
--
-- The three reviewer RPCs from migration 31 declare RETURNS TABLE columns whose
-- names shadow real table columns (reviewer_email, review_version, gold_answer,
-- verdict …). In PL/pgSQL those output parameters are VARIABLES visible inside
-- every SQL statement, so any unqualified reference — the ON CONFLICT target
-- (generation_id, reviewer_email), greatest(review_version, …), or a WHERE
-- reviewer_email = v_email — raises 42702 at first execution. Net effect: the
-- review app could not save a verdict, a gold answer, or a spam flag since the
-- P0 cutover; the only working path was the legacy note-link feedback
-- (record_legacy_feedback has no shadowed names and is left untouched).
--
-- Fix, applied to all three: `#variable_conflict use_column` (ambiguity
-- resolves to the table column — correct in every statement here) plus explicit
-- qualification of the references that were ambiguous, so the functions no
-- longer depend on the pragma alone. Signatures are unchanged; CREATE OR
-- REPLACE preserves the existing grants.

create or replace function public.save_generation_gold_answer(
  p_generation_id bigint,
  p_gold_answer text
) returns table (
  review_id bigint,
  review_version integer,
  gold_answer text,
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
    review_version = greatest(suggestions.review_version, v_review.review_version)
  where id = p_generation_id;

  return query select
    v_review.id, v_review.review_version, v_review.gold_answer,
    v_review.reviewer_email, v_review.updated_at;
end $$;

create or replace function public.mark_generation_spam(
  p_generation_id bigint
) returns table (
  ticket_id bigint,
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

create or replace function public.submit_generation_verdict(
  p_generation_id bigint,
  p_expected_version integer,
  p_verdict text,
  p_verdict_reasons jsonb default '[]'::jsonb,
  p_critical_flag text default null
) returns table (
  review_id bigint,
  review_version integer,
  verdict text,
  verdict_reasons jsonb,
  critical_flag text,
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
  where suggestion_reviews.generation_id = p_generation_id
    and suggestion_reviews.reviewer_email = v_email
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

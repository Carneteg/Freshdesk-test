-- Migration 41 — make articles editable and traceable in their own place.
--
-- Migration 40 gave reviewers exactly two moves: approve or reject. That is fine
-- for a decision but wrong for a document. An article gets edited — before the
-- decision ("save this, I'll finish it later") and after it ("we got the wording
-- wrong, fix it") — and until now the only way to edit an approved one was to
-- re-approve it, which quietly rewrote reviewed_by/reviewed_at and destroyed the
-- record of who actually approved it.
--
-- So: `p_status` is now OPTIONAL. Passing null means "save my edits, leave the
-- status where it is" — which is what a typo fix on an approved article must do,
-- and it must not re-stamp the approver either. Only a real decision ('approved' /
-- 'rejected') moves status, reviewed_by and reviewed_at. The audit trail survives
-- the typo fix.
--
-- `notes` becomes editable too (40 accepted it in the signature but the review app
-- had nowhere to put it), and `updated_at` records the last edit separately from
-- the decision, so "when was this last touched" and "who signed off" stay
-- different questions.

alter table article_drafts
  add column if not exists updated_at timestamptz;

comment on column article_drafts.updated_at is
  'Last edit of any kind. Distinct from reviewed_at, which only moves on an approve/reject decision.';

create or replace function public.review_kb_article(
  p_article_id bigint,
  p_status text default null,
  p_title text default null,
  p_summary text default null,
  p_steps jsonb default null,
  p_notes jsonb default null
) returns table (
  article_id bigint,
  status text,
  reviewed_by text,
  reviewed_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_row article_drafts%rowtype;
  -- A null status means "just save my edits". Only a real decision may move the
  -- status or stamp a reviewer — otherwise a typo fix on an approved article would
  -- both unapprove it and overwrite the record of who approved it.
  v_is_decision boolean := p_status in ('approved', 'rejected');
begin
  if not is_reviewer() or v_email = '' then
    raise exception 'reviewer access required' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('approved', 'rejected') then
    raise exception 'invalid article status' using errcode = '22023';
  end if;

  update article_drafts
  set
    status = case when v_is_decision then p_status else article_drafts.status end,
    title = coalesce(p_title, article_drafts.title),
    summary = coalesce(p_summary, article_drafts.summary),
    steps = coalesce(p_steps, article_drafts.steps),
    notes = coalesce(p_notes, article_drafts.notes),
    -- Only a decision moves the reviewer stamp; editing an approved article keeps
    -- the record of who approved it and when.
    reviewed_by = case when v_is_decision then v_email else article_drafts.reviewed_by end,
    reviewed_at = case when v_is_decision then now() else article_drafts.reviewed_at end,
    updated_at = now()
  where id = p_article_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'article % not found', p_article_id using errcode = 'P0002';
  end if;

  return query select
    v_row.id, v_row.status, v_row.reviewed_by, v_row.reviewed_at, v_row.updated_at;
end $$;

revoke all on function public.review_kb_article(bigint, text, text, text, jsonb, jsonb) from public, anon;
grant execute on function public.review_kb_article(bigint, text, text, text, jsonb, jsonb) to authenticated;

-- The traceability view behind the Articles tab: one row per article with its
-- whole history — which ticket it came from, which resolution it was generalised
-- from, who asked, who signed off, and what the writer stripped.
create or replace view article_library with (security_invoker = on) as
select
  a.id as article_id,
  a.ticket_id,
  a.generation_id,
  s.subject as ticket_subject,
  s.ticket_url,
  a.status,
  a.language,
  a.audience,
  a.proposed_title,
  a.proposed_reason,
  a.title,
  a.summary,
  a.steps,
  a.notes,
  a.gap_filled,
  a.removed_specifics,
  a.publishable,
  a.blocked_reason,
  -- provenance: an article may only ever be generalised from a human-validated
  -- resolution, so which one it was is part of the record, not a detail.
  a.resolution_source,
  a.article_version,
  a.model,
  a.requested_by,
  a.requested_at,
  a.drafted_at,
  a.reviewed_by,
  a.reviewed_at,
  a.updated_at
from article_drafts a
left join suggestions s on s.id = a.generation_id
order by
  -- worst-first for the reviewer: things needing a decision, then the queue,
  -- then the settled ones.
  case a.status
    when 'drafted' then 0 when 'requested' then 1 when 'failed' then 2
    when 'approved' then 3 else 4 end,
  a.requested_at desc;

comment on view article_library is
  'Every KB article with its full provenance — source ticket, the human-validated resolution it was generalised from, who requested it, who approved it. Backs the Articles tab in the review app.';

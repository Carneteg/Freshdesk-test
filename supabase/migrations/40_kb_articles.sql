-- Migration 40 — turn resolved tickets into knowledge-base articles.
--
-- WHY. Gate 1's root cause was never the model: it was operational knowledge the
-- agents carry and nobody wrote down (CLAUDE.md §12, the coach pivot). Every lever
-- built since — knowledge gaps, gold answers, the incident playbook — points at
-- the same fix: get the knowledge written. This closes that loop at the moment the
-- knowledge is freshest, i.e. right after a ticket is solved.
--
-- THE FLOW, and who decides what:
--   1. the pipeline FLAGS a ticket whose answer would generalise
--      (`suggestions.article_opportunity`, shown in the private note)
--   2. a REVIEWER asks for a draft in the Coach Review app  → status 'requested'
--   3. `deno task write-articles` drafts it from a HUMAN-VALIDATED resolution
--      (a gold answer, or the reply the agent actually sent)  → status 'drafted'
--   4. the reviewer edits and APPROVES it                    → status 'approved'
--
-- Steps 2 and 4 are human. The AI proposes and drafts; it never decides that
-- something becomes knowledge.
--
-- DELIBERATELY NOT DONE: publishing to Freshdesk. Approved articles are stored
-- HERE and exported for a human to publish. Writing articles into Freshdesk's
-- solutions API would be a THIRD external write and widen the security review
-- that §3 keeps narrow (today: the private note + ≤3 tags). That is a decision to
-- take explicitly, not a side effect of this migration.

-- The triage flag lives on the generation that produced it: immutable payload,
-- part of the model's output, not reviewer-writable.
alter table suggestions
  add column if not exists article_opportunity jsonb;

comment on column suggestions.article_opportunity is
  'Triage flag from the draft call: {worth_writing, proposed_title, reason} — would a KB article have answered this ticket? Proposal only; a human decides.';

create table if not exists article_drafts (
  id                bigserial primary key,
  ticket_id         bigint not null,
  -- The generation that proposed it, when there was one. Null for an article a
  -- reviewer asked for unprompted.
  generation_id     bigint references suggestions (id) on delete set null,

  status            text not null default 'requested'
                      check (status in ('requested', 'drafted', 'approved', 'rejected', 'failed')),

  -- What triage proposed, kept even after the draft rewrites it, so we can see
  -- whether the flag was any good.
  proposed_title    text,
  proposed_reason   text,

  -- The drafted article. Body is kept as structured parts rather than one blob so
  -- the review app can edit them separately and an exporter can render whatever
  -- format the help centre wants.
  language          text,
  title             text,
  summary           text,
  steps             jsonb,
  notes             jsonb,
  audience          text check (audience is null or audience in ('customer', 'agent')),
  gap_filled        text,
  -- Which customer-specific details the writer says it stripped. An audit trail:
  -- an article that silently kept a customer name is a data-protection problem,
  -- not just a quality one.
  removed_specifics jsonb,

  -- Provenance. `resolution_source` is the safeguard: an article may only be
  -- generalised from a resolution a HUMAN stood behind.
  resolution_source text check (resolution_source is null or resolution_source in ('gold_answer', 'agent_reply')),
  article_version   text,
  model             text,

  publishable       boolean,
  blocked_reason    text,   -- why the writer refused, or why a run failed

  requested_by      text,
  requested_at      timestamptz not null default now(),
  drafted_at        timestamptz,
  reviewed_by       text,
  reviewed_at       timestamptz,

  -- One live article request per ticket. A rejected one can be superseded by
  -- re-requesting (the RPC reopens the existing row rather than inserting).
  unique (ticket_id)
);

comment on table article_drafts is
  'KB article drafts generated from resolved tickets. AI proposes and drafts; humans request and approve. Approved rows are exported for a human to publish — nothing is written to Freshdesk.';

create index if not exists article_drafts_status_idx on article_drafts (status, requested_at desc);

alter table article_drafts enable row level security;

-- Reviewers may see the queue and act on it; everything else is service-role only.
grant select on article_drafts to authenticated;

drop policy if exists article_drafts_reviewer_read on article_drafts;
create policy article_drafts_reviewer_read on article_drafts
  for select to authenticated using (is_reviewer());

-- ── RPCs: the two human decisions ────────────────────────────────────────────

-- 1. "Yes, write this one." Idempotent, and reopens a rejected row rather than
--    failing on the unique key — a reviewer changing their mind is normal.
create or replace function public.request_kb_article(
  p_ticket_id bigint,
  p_generation_id bigint default null
) returns table (
  article_id bigint,
  status text,
  requested_by text,
  requested_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_row article_drafts%rowtype;
  v_title text;
  v_reason text;
begin
  if not is_reviewer() or v_email = '' then
    raise exception 'reviewer access required' using errcode = '42501';
  end if;

  -- Carry the triage proposal across, when the generation had one.
  select
    s.article_opportunity ->> 'proposed_title',
    s.article_opportunity ->> 'reason'
  into v_title, v_reason
  from suggestions s
  where s.id = p_generation_id;

  insert into article_drafts (
    ticket_id, generation_id, proposed_title, proposed_reason, requested_by
  )
  values (p_ticket_id, p_generation_id, v_title, v_reason, v_email)
  on conflict (ticket_id) do update
  set
    -- Re-requesting a rejected/failed article puts it back in the queue. An
    -- already-drafted or approved one is left exactly as it is.
    status = case
      when article_drafts.status in ('rejected', 'failed') then 'requested'
      else article_drafts.status
    end,
    generation_id = coalesce(excluded.generation_id, article_drafts.generation_id),
    proposed_title = coalesce(article_drafts.proposed_title, excluded.proposed_title),
    proposed_reason = coalesce(article_drafts.proposed_reason, excluded.proposed_reason),
    requested_by = excluded.requested_by,
    requested_at = now()
  returning * into v_row;

  return query select v_row.id, v_row.status, v_row.requested_by, v_row.requested_at;
end $$;

-- 2. "This article is right" / "no, drop it" — with the reviewer's edits.
--    The reviewer's text wins over the model's: passing a field replaces it.
create or replace function public.review_kb_article(
  p_article_id bigint,
  p_status text,
  p_title text default null,
  p_summary text default null,
  p_steps jsonb default null,
  p_notes jsonb default null
) returns table (
  article_id bigint,
  status text,
  reviewed_by text,
  reviewed_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_row article_drafts%rowtype;
begin
  if not is_reviewer() or v_email = '' then
    raise exception 'reviewer access required' using errcode = '42501';
  end if;
  if p_status not in ('approved', 'rejected') then
    raise exception 'invalid article status' using errcode = '22023';
  end if;

  update article_drafts
  set
    status = p_status,
    title = coalesce(p_title, article_drafts.title),
    summary = coalesce(p_summary, article_drafts.summary),
    steps = coalesce(p_steps, article_drafts.steps),
    notes = coalesce(p_notes, article_drafts.notes),
    reviewed_by = v_email,
    reviewed_at = now()
  where id = p_article_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'article % not found', p_article_id using errcode = 'P0002';
  end if;

  return query select v_row.id, v_row.status, v_row.reviewed_by, v_row.reviewed_at;
end $$;

revoke all on function public.request_kb_article(bigint, bigint) from public, anon;
revoke all on function public.review_kb_article(bigint, text, text, text, jsonb, jsonb) from public, anon;
grant execute on function public.request_kb_article(bigint, bigint) to authenticated;
grant execute on function public.review_kb_article(bigint, text, text, text, jsonb, jsonb) to authenticated;

-- ── Views ────────────────────────────────────────────────────────────────────

-- What the writer script picks up. A request is only workable once a
-- human-validated resolution exists on the ticket — otherwise there is nothing we
-- are allowed to generalise from, and the row waits rather than inventing one.
create or replace view article_write_queue with (security_invoker = on) as
select
  a.id as article_id,
  a.ticket_id,
  a.generation_id,
  a.proposed_title,
  a.requested_at,
  case when nullif(btrim(coalesce(s.gold_answer, '')), '') is not null
       then 'gold_answer' else 'agent_reply' end as resolution_source
from article_drafts a
join suggestions s on s.id = a.generation_id
where a.status = 'requested'
  and coalesce(
        nullif(btrim(coalesce(s.gold_answer, '')), ''),
        nullif(btrim(coalesce(s.agent_sent_reply, '')), '')
      ) is not null
order by a.requested_at;

comment on view article_write_queue is
  'Article requests ready to draft: a human asked for them AND the ticket carries a human-validated resolution (gold answer preferred, else the agent''s sent reply).';

-- The payoff: approved articles, ready for a human to paste into the help centre.
create or replace view approved_articles with (security_invoker = on) as
select
  a.id as article_id,
  a.ticket_id,
  a.language,
  a.audience,
  a.title,
  a.summary,
  a.steps,
  a.notes,
  a.gap_filled,
  a.removed_specifics,
  a.reviewed_by,
  a.reviewed_at
from article_drafts a
where a.status = 'approved'
order by a.reviewed_at desc;

comment on view approved_articles is
  'Human-approved KB articles awaiting publication. Publishing is a manual step by design — writing to Freshdesk would be a third external write (CLAUDE.md §3).';

-- Is the triage flag any good? Compares what the pipeline proposed against what
-- reviewers actually did with it. If most proposals are rejected, tighten the
-- article_opportunity rules in prompts.ts rather than asking agents to filter.
create or replace view article_funnel with (security_invoker = on) as
select
  count(*) filter (where s.article_opportunity ->> 'worth_writing' = 'true') as proposed_by_ai,
  (select count(*) from article_drafts) as requested,
  (select count(*) from article_drafts where status = 'drafted') as awaiting_review,
  (select count(*) from article_drafts where status = 'approved') as approved,
  (select count(*) from article_drafts where status = 'rejected') as rejected,
  (select count(*) from article_drafts where status = 'failed') as failed
from suggestions s
where s.error is null and s.prompt_version <> 'agent-scan' and not s.is_spam;

comment on view article_funnel is
  'AI proposals → human requests → approvals. A low approve-rate means the article_opportunity rules in prompts.ts are too loose.';

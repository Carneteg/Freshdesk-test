-- Gate 1: AI suggested replies for Freshdesk
-- One table logs every generation; three views turn it into the scorecard.
-- See CLAUDE.md §8 (testing) and §12 (resolved design questions).

create table if not exists suggestions (
  id                 bigint generated always as identity primary key,

  -- what it ran on
  ticket_id          bigint not null,
  ticket_url         text,             -- agent-facing link to the Freshdesk ticket
  -- newest customer message the draft answered. NOT ticket_id alone: a new
  -- customer reply is treated like a new ticket and gets its own row (§12).
  trigger_message_id text   not null,
  subject            text,
  language           text,            -- detected: no | sv | en | da | fi | other
  ticket_type        text,            -- question | howto | bug | unclear
  detected_intent    text,            -- short snake_case intent, e.g. grant_admin_access
  keywords           jsonb,           -- topic tags for traceability (internal only, §3)

  -- how the AI reasoned over the FULL ticket (QA rework, CLAUDE.md §12).
  answer_strategy    text,            -- DIRECT_ANSWER | REPEAT_CLARIFYING_QUESTION | …
  confidence_reason  text,            -- one-line justification for the confidence level
  agent_next_action  text,            -- (legacy) superseded by resolution_steps
  resolution_steps   jsonb,           -- what to DO to solve the case (internal action list)
  agent_analysis     text,            -- 1-2 sentence diagnosis + KB gap (not actions)
  requires_manual_system_check boolean default false, -- AI has no system access; agent must verify
  security_sensitive boolean default false,           -- roles / access / permissions ticket
  facts              jsonb,           -- source-tagged facts { from_customer, from_agent, … }
  unknowns           jsonb,           -- what the text did NOT establish (to-confirm list)

  -- what it produced
  confidence         text   not null, -- high | low | none
  draft              text,            -- the suggested reply (null when confidence = none)
  note_id            bigint,          -- Freshdesk private-note id, once posted

  -- how it got there (for evaluation, not for the agent to read)
  questions          jsonb,           -- questions_asked from analyse
  search_queries     jsonb,           -- queries analyse asked for
  sources            jsonb,           -- retrieved KB solutions / past tickets
  verify             jsonb,           -- per-claim verdict from Claude call 3
  rationale          text,            -- short "why this answer is right" shown in the note
  follow_up_questions jsonb,          -- clarifying questions when the request is unclear
  bug_guidance       jsonb,           -- { repro_steps, customer_steps } for bug tickets

  -- Q/A score: how many of the customer's questions the draft answered (§12).
  qa_answered        integer,
  qa_total           integer,

  -- the human judgement this whole experiment exists to collect
  verdict            text,            -- usable | unusable | edited | null (unjudged)

  -- usage capture: did the agent actually use our suggestion? Auto-derived by
  -- comparing our draft to the reply they eventually sent (§12).
  used               text,            -- used | partly | not | null (not yet scored)
  similarity         numeric,         -- word-set Jaccard, 0..1

  -- operational
  prompt_version     text   not null,
  model              text,
  latency_ms         integer,
  error              text,            -- non-null => this run failed; must stay visible
  created_at         timestamptz not null default now(),

  constraint suggestions_confidence_chk
    check (confidence in ('high', 'low', 'none')),
  constraint suggestions_verdict_chk
    check (verdict in ('usable', 'unusable', 'edited') or verdict is null),
  constraint suggestions_used_chk
    check (used in ('used', 'partly', 'not') or used is null)
);

-- Deduplication key (§12). A newer customer message => new (ticket_id,
-- trigger_message_id) => a fresh suggestion. Re-polling the same state is a no-op.
create unique index if not exists suggestions_ticket_msg_uidx
  on suggestions (ticket_id, trigger_message_id);

create index if not exists suggestions_created_idx on suggestions (created_at);


-- ── Evaluation views ─────────────────────────────────────────────────────────

-- "Would I have sent this reply?" — usable share, per prompt version.
-- security_invoker = on so the view respects the caller's RLS instead of the
-- creator's (the default SECURITY DEFINER would bypass RLS on `suggestions`).
create or replace view gate1_scorecard with (security_invoker = on) as
select
  prompt_version,
  count(*)                                           as generated,
  count(verdict)                                     as judged,
  count(*) filter (where verdict = 'usable')         as usable,
  count(*) filter (where verdict = 'edited')         as edited,
  count(*) filter (where verdict = 'unusable')       as unusable,
  round(
    100.0 * count(*) filter (where verdict = 'usable')
    / nullif(count(verdict), 0), 1
  )                                                  as usable_pct
from suggestions
where error is null
group by prompt_version
order by prompt_version;

-- Confidence vs. verdict. The dangerous cell is (high, unusable): confident
-- nonsense. If it is non-zero, tighten the HIGH criteria in prompts.ts (§8).
create or replace view calibration with (security_invoker = on) as
select
  confidence,
  coalesce(verdict, '(unjudged)') as verdict,
  count(*)                        as n
from suggestions
where error is null
group by confidence, coalesce(verdict, '(unjudged)')
order by confidence, verdict;

-- No silent failures (§10). Every crashed run is visible here.
create or replace view failures with (security_invoker = on) as
select id, ticket_id, error, prompt_version, created_at
from suggestions
where error is not null
order by created_at desc;

-- Did the notes get used, and how well did they cover the questions? The
-- learning signal a future gate would train on (§12).
create or replace view usage_scorecard with (security_invoker = on) as
select
  prompt_version,
  count(*)                                       as generated,
  count(used)                                    as usage_measured,
  count(*) filter (where used = 'used')          as used_full,
  count(*) filter (where used = 'partly')        as used_partly,
  count(*) filter (where used = 'not')           as used_not,
  round(avg(similarity), 3)                      as avg_similarity,
  round(avg(case when qa_total > 0 then 100.0 * qa_answered / qa_total end), 1)
                                                 as avg_qa_pct
from suggestions
where error is null
group by prompt_version
order by prompt_version;

-- The suggestions table holds ticket PII (§11). Only the Edge Function touches
-- it, connecting with the service-role key, which bypasses RLS. Enabling RLS
-- with NO policies denies all anon/authenticated access while the function keeps
-- working — the correct secure default for this design.
alter table suggestions enable row level security;

-- Knowledge layer stage 1 (migration 10): team-curated known incidents / routing,
-- injected into the draft prompt as an internal playbook that outranks a generic
-- KB keyword match. Freshdesk's ticket search can't do free-text lookups, so this
-- is how the operational knowledge the agents rely on reaches the model.
create table if not exists known_incidents (
  id          bigint generated always as identity primary key,
  title       text not null,
  symptoms    text not null,               -- how the customer describes it (match signal)
  resolution  text not null,               -- what the agent actually does / the answer
  routing     text,                        -- where to send it, if applicable
  -- lifecycle (migration 11): so the AI tells the customer to load a FIX vs. sets
  -- expectations on a live incident, and links only when the scope matches.
  status      text not null default 'investigating'
                check (status in ('identified', 'investigating', 'fixed', 'closed')),
  affected    text,                        -- versions / scope / distinguishing symptoms
  workaround  text,                        -- interim workaround while unresolved
  customer_action text,                    -- what the customer does (esp. after a fix)
  started_at  date,
  resolved_at date,
  -- post-fix lifecycle (migration 14): so the AI stops re-escalating a solved issue
  -- and tells the customer which historical records still need a manual correction.
  fix_released_at       date,              -- when the fix went live ("resolved as of …")
  post_fix_instructions text,              -- which records auto-corrected vs. fix manually, and how
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Knowledge layer stage 2 (migration 12): our own semantic index of resolved
-- tickets. Freshdesk can't search ticket content, so scripts/sync_tickets.ts fills
-- this and the pipeline pulls the nearest resolved tickets by embedding similarity.
create extension if not exists vector;

create table if not exists past_tickets (
  ticket_id   bigint primary key,
  subject     text,
  question    text not null,          -- customer's question(s)
  resolution  text,                   -- the agent's resolving public reply
  language    text,
  resolved_at timestamptz,
  embedding   vector(1536),           -- text-embedding-3-small of subject + question
  synced_at   timestamptz not null default now()
);
alter table past_tickets enable row level security;
create index if not exists past_tickets_embedding_idx
  on past_tickets using hnsw (embedding vector_cosine_ops);

-- match_count similar resolved tickets, excluding the ticket being answered and
-- (in replay) any ticket resolved after the simulated reply time — no leakage (13).
create or replace function match_past_tickets(
  query_embedding vector(1536),
  match_count int default 5,
  min_similarity float default 0.3,
  exclude_ticket_id bigint default null,
  before_ts timestamptz default null
)
returns table (ticket_id bigint, subject text, resolution text, similarity float)
language sql stable
as $$
  select p.ticket_id, p.subject, p.resolution,
         1 - (p.embedding <=> query_embedding) as similarity
  from past_tickets p
  where p.embedding is not null
    and p.resolution is not null
    and (exclude_ticket_id is null or p.ticket_id <> exclude_ticket_id)
    and (before_ts is null or (p.resolved_at is not null and p.resolved_at < before_ts))
    and 1 - (p.embedding <=> query_embedding) >= min_similarity
  order by p.embedding <=> query_embedding
  limit match_count;
$$;

-- Gate 1: AI suggested replies for Freshdesk
-- One table logs every generation; three views turn it into the scorecard.
-- See CLAUDE.md §8 (testing) and §12 (resolved design questions).

create table if not exists suggestions (
  id                 bigint generated always as identity primary key,

  -- what it ran on
  ticket_id          bigint not null,
  -- newest customer message the draft answered. NOT ticket_id alone: a new
  -- customer reply is treated like a new ticket and gets its own row (§12).
  trigger_message_id text   not null,
  subject            text,
  language           text,            -- detected: no | sv | en | da | fi | other

  -- what it produced
  confidence         text   not null, -- high | low | none
  draft              text,            -- the suggested reply (null when confidence = none)
  note_id            bigint,          -- Freshdesk private-note id, once posted

  -- how it got there (for evaluation, not for the agent to read)
  questions          jsonb,           -- questions_asked from analyse
  search_queries     jsonb,           -- queries analyse asked for
  sources            jsonb,           -- retrieved KB solutions / past tickets
  verify             jsonb,           -- per-claim verdict from Claude call 3

  -- the human judgement this whole experiment exists to collect
  verdict            text,            -- usable | unusable | edited | null (unjudged)

  -- operational
  prompt_version     text   not null,
  model              text,
  latency_ms         integer,
  error              text,            -- non-null => this run failed; must stay visible
  created_at         timestamptz not null default now(),

  constraint suggestions_confidence_chk
    check (confidence in ('high', 'low', 'none')),
  constraint suggestions_verdict_chk
    check (verdict in ('usable', 'unusable', 'edited') or verdict is null)
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

-- The suggestions table holds ticket PII (§11). Only the Edge Function touches
-- it, connecting with the service-role key, which bypasses RLS. Enabling RLS
-- with NO policies denies all anon/authenticated access while the function keeps
-- working — the correct secure default for this design.
alter table suggestions enable row level security;

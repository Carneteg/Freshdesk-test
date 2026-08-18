-- Migration 47 — customer satisfaction ratings (CSAT) from Freshdesk.
--
-- WHY. Every quality signal this project holds is us grading ourselves: the QA
-- rubric, draft-vs-sent similarity, the reviewer verdict. CSAT is the one place
-- the CUSTOMER grades the answer. When an agent has five negative ratings and
-- no positive ones, that is the most direct evidence there is, and until now it
-- lived only in Freshdesk's UI where it could not be joined to anything.
--
-- Storing it lets a rating be read next to the reply that earned it.
--
-- SCALE WARNING. Freshdesk does NOT use 1-5. The raw values are
--   103 extremely happy · 102 very happy · 101 happy
--   100 neutral
--   -101 unhappy · -102 very unhappy · -103 extremely unhappy
-- Averaging these is meaningless and reading them as 1-5 inverts every negative
-- rating. `band` is the derived column to count on; `rating_value` is kept raw
-- for audit.

create table if not exists csat_ratings (
  id            bigint primary key,              -- Freshdesk's own rating id
  ticket_id     bigint not null,
  agent_id      bigint,
  group_id      bigint,
  user_id       bigint,                          -- the customer who rated
  rating_value  integer not null,                -- raw Freshdesk value
  band          text not null check (band in ('positive','neutral','negative')),
  -- The customer's own words about the handling. Customer content: subject to
  -- the same handling rules as ticket bodies, and never written to CI logs.
  feedback      text,
  rated_at      timestamptz,
  synced_at     timestamptz not null default now()
);

create index if not exists csat_ratings_agent_idx on csat_ratings (agent_id, band);
create index if not exists csat_ratings_ticket_idx on csat_ratings (ticket_id);

comment on table csat_ratings is
  'Freshdesk satisfaction ratings, synced read-only. Freshdesk scale is 103..-103, NOT 1-5 — count `band`, never average `rating_value`.';
comment on column csat_ratings.feedback is
  'The customer''s own words. Customer content — same handling rules as a ticket body.';

alter table csat_ratings enable row level security;
revoke all on csat_ratings from anon, authenticated;
grant select on csat_ratings to service_role;

-- Per-agent CSAT. Deliberately shows the COUNTS, not an average: with a scale
-- this shaped, an average is a number that cannot be interpreted.
create or replace view csat_by_agent with (security_invoker = on) as
select
  agent_id,
  count(*) as ratings,
  count(*) filter (where band = 'positive') as positive,
  count(*) filter (where band = 'neutral')  as neutral,
  count(*) filter (where band = 'negative') as negative,
  count(*) filter (where feedback is not null and btrim(feedback) <> '') as with_written_feedback,
  min(rated_at) as first_rating,
  max(rated_at) as last_rating
from csat_ratings
group by agent_id
order by negative desc, ratings desc;

comment on view csat_by_agent is
  'CSAT counts per agent. Read the counts, not a mean — the Freshdesk scale is not linear and not 1-5. A small denominator is normal: most tickets are never rated.';

-- A negative rating next to the generation for the same ticket, where one
-- exists. This is what makes a bad rating diagnosable rather than just visible.
create or replace view csat_negative_with_reply with (security_invoker = on) as
select
  c.ticket_id,
  c.agent_id,
  c.rating_value,
  c.feedback,
  c.rated_at,
  s.subject,
  s.ticket_url,
  s.customer_message,
  s.agent_sent_reply,
  s.agent_qa_score,
  s.agent_qa_verdict
from csat_ratings c
left join lateral (
  select * from suggestions s2
  where s2.ticket_id = c.ticket_id and s2.agent_sent_reply is not null
  order by s2.created_at desc limit 1
) s on true
where c.band = 'negative'
order by c.rated_at desc;

comment on view csat_negative_with_reply is
  'Every negative rating with the reply that earned it, when that reply has been scanned. agent_sent_reply NULL means the ticket has not been through score-history yet — run it for those ticket ids.';

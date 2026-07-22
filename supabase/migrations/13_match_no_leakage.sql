-- 13: prevent benchmark leakage in past-ticket retrieval.
--
-- The replay indexes every closed ticket, so a ticket could retrieve ITSELF (or a
-- ticket resolved AFTER it) as a source — handing the AI the answer key. Add two
-- filters to the match function:
--   exclude_ticket_id : never return the ticket being answered
--   before_ts         : only return tickets resolved BEFORE the simulated reply
--                       time (replay passes the agent's first-reply time; live
--                       leaves it null to use everything).

drop function if exists match_past_tickets(vector, integer, double precision);

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

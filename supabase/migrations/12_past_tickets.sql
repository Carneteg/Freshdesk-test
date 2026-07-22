-- 12: past-ticket semantic index (knowledge layer stage 2).
--
-- Freshdesk can't search ticket CONTENT (free text → 400), so we keep our own
-- index of resolved tickets in Supabase and search it by embedding similarity.
-- A sync job (scripts/sync_tickets.ts) fills this table; the pipeline embeds the
-- current ticket's question and pulls the nearest resolved tickets as `ticket`
-- sources, so the AI can reference how similar cases were actually handled.

create extension if not exists vector;

create table if not exists past_tickets (
  ticket_id   bigint primary key,
  subject     text,
  question    text not null,          -- customer's question(s): description + incoming
  resolution  text,                   -- the agent's resolving public reply
  language    text,
  resolved_at timestamptz,
  embedding   vector(1536),           -- text-embedding-3-small of subject + question
  synced_at   timestamptz not null default now()
);

-- Holds customer PII (§11); RLS on, service role bypasses — same posture as suggestions.
alter table past_tickets enable row level security;

create index if not exists past_tickets_embedding_idx
  on past_tickets using hnsw (embedding vector_cosine_ops);

-- Nearest resolved tickets to a query embedding (cosine similarity).
create or replace function match_past_tickets(
  query_embedding vector(1536),
  match_count int default 5,
  min_similarity float default 0.3
)
returns table (ticket_id bigint, subject text, resolution text, similarity float)
language sql stable
as $$
  select p.ticket_id, p.subject, p.resolution,
         1 - (p.embedding <=> query_embedding) as similarity
  from past_tickets p
  where p.embedding is not null
    and p.resolution is not null
    and 1 - (p.embedding <=> query_embedding) >= min_similarity
  order by p.embedding <=> query_embedding
  limit match_count;
$$;

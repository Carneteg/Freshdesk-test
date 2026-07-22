-- 10: known-incidents / internal playbook (knowledge layer, stage 1).
--
-- Freshdesk's ticket search only accepts field-based queries (free text → 400),
-- so the AI cannot look up "similar past tickets" directly. This small,
-- team-curated table captures the operational knowledge the QA review found the
-- agents rely on (known bugs, reindexing, read-links, routing). The active rows
-- are injected into the draft prompt as an INTERNAL PLAYBOOK that outranks a
-- generic KB keyword match. Stage 2 will add a searched past-ticket index.
--
-- Maintained by the support team (Johanna et al.) — seed rows are a starting
-- point derived from real agent replies and MUST be reviewed before going live.

create table if not exists known_incidents (
  id          bigint generated always as identity primary key,
  title       text not null,               -- short label, e.g. "Handbook 'no edit access'"
  symptoms    text not null,               -- how the customer describes it (match signal)
  resolution  text not null,               -- what the agent actually does / the answer
  routing     text,                        -- where to send it, if applicable
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table known_incidents is
  'Team-curated known incidents / routing playbook fed into the draft prompt (knowledge layer stage 1). Review seed rows before relying on them.';

-- Migration 48 — ticket facts: who files tickets, on which product, about what.
--
-- WHY. `suggestions` holds generations, not tickets, and stores no company at
-- all — company_id was read for CRM matching and discarded. So "which companies
-- file the most tickets" could not be answered from anything we held.
--
-- WHAT MAKES THIS EXACT. Freshdesk carries the answers as FIELDS, verified live
-- on a 3000-ticket sample:
--   cf_product152991   the product ("Simployer Classic", "Simployer One (Alexis)",
--                      "Experthelp/Faghjelp", "Employee survey (&frankly)", …)
--   cf_category_1/2/3  what the ticket is about, three levels
--   type               Question / How to · Login issue · Bug · Termination · …
--   company_id         who filed it
-- Nothing here is inferred from ticket text. Guessing product or topic from
-- keywords is the Gate 1 failure mode and is deliberately not done.
--
-- ONE vs CLASSIC IS NOT BINARY. In that sample: Classic 1174 (incl. Handbooks),
-- Simployer One (Alexis) 21, and ~1700 tickets on OTHER products entirely
-- (Expert, Employee Survey, Capitech, Learn, Talent, Equal Pay, Invoices).
-- Forcing those into a two-way split would invent a story the data does not
-- tell, so `product_group` is three-way and `product` keeps the real name.
--
-- CHANNEL MATTERS. Per Tobias: Intercom is ALWAYS S1/AlexisHR; Freshdesk is
-- mostly Classic but can be S1. So a complete One picture is
-- (all Intercom) + (Freshdesk rows where product_group = 'one'). Reading
-- Freshdesk alone understates One by the entire Intercom volume — hence
-- `source`, and hence the view that says so out loud.

create table if not exists ticket_facts (
  -- Composite key: a Freshdesk ticket id and an Intercom conversation id can
  -- collide numerically, so the source is part of the identity.
  source        text not null check (source in ('freshdesk','intercom')),
  ticket_id     bigint not null,
  company_id    bigint,
  -- Resolved once at sync time. Freshdesk needs a call per company, Intercom
  -- carries the name inline; storing it keeps the views free of lookups.
  company_name  text,
  product       text,                 -- cf_product152991 verbatim, or 'Simployer One (Alexis)' for Intercom
  product_group text not null default 'unknown'
                  check (product_group in ('one','classic','other','unknown')),
  category_1    text,
  category_2    text,
  category_3    text,
  ticket_type   text,                 -- Freshdesk `type`
  language      text,
  status        integer,
  created_at    timestamptz,
  synced_at     timestamptz not null default now(),
  primary key (source, ticket_id)
);

create index if not exists ticket_facts_company_idx on ticket_facts (company_name);
create index if not exists ticket_facts_product_idx on ticket_facts (product_group);
create index if not exists ticket_facts_created_idx on ticket_facts (created_at desc);

comment on table ticket_facts is
  'One row per ticket/conversation with its company, product and category, taken from Freshdesk FIELDS (never inferred from text). Intercom rows are always product_group=one. company_id is absent on ~24% of Freshdesk tickets — see ticket_facts_coverage before reading any ranking.';
comment on column ticket_facts.product_group is
  'one | classic | other | unknown. Three-way on purpose: most tickets are on neither One nor Classic but on a separate product (Expert, Survey, Capitech, Learn, Talent).';

alter table ticket_facts enable row level security;
revoke all on ticket_facts from anon;
-- Allowlisted reviewers may READ (the tab renders from these); writes stay
-- service-role only, like every other synced table.
grant select on ticket_facts to authenticated;
create policy ticket_facts_reviewer_read on ticket_facts
  for select to authenticated using (is_reviewer());

-- ── Read this BEFORE any ranking ────────────────────────────────────────────
--
-- A top-10 built on a field that is missing from a quarter of the rows is a
-- top-10 of the rows that happened to have it. This view makes that visible
-- instead of leaving it to be discovered.
create or replace view ticket_facts_coverage with (security_invoker = on) as
select
  source,
  count(*) as tickets,
  count(*) filter (where company_name is not null) as with_company,
  round(100.0 * count(*) filter (where company_name is not null)::numeric
        / nullif(count(*),0)::numeric, 1) as company_pct,
  count(*) filter (where product_group = 'unknown') as product_unknown,
  count(*) filter (where category_1 is not null) as with_category,
  min(created_at) as oldest,
  max(created_at) as newest
from ticket_facts
group by source;

comment on view ticket_facts_coverage is
  'How complete the facts are per source. A ranking is only as good as company_pct — read this first.';

-- ── Top companies, with the One/Classic split per company ───────────────────
create or replace view company_ticket_volume with (security_invoker = on) as
select
  company_name,
  count(*) as tickets,
  count(*) filter (where product_group = 'one')     as one_tickets,
  count(*) filter (where product_group = 'classic') as classic_tickets,
  count(*) filter (where product_group = 'other')   as other_tickets,
  count(*) filter (where source = 'intercom')       as via_intercom,
  count(*) filter (where source = 'freshdesk')      as via_freshdesk,
  count(distinct category_1) as distinct_topics,
  max(created_at) as last_ticket
from ticket_facts
where company_name is not null
group by company_name
order by tickets desc;

comment on view company_ticket_volume is
  'Ticket volume per company with the product split. Companies with no company_id are excluded — that is ~24% of Freshdesk tickets, so this ranks the identified population, not all tickets.';

-- What a given company's tickets are actually about.
create or replace view company_ticket_topics with (security_invoker = on) as
select
  company_name,
  product_group,
  coalesce(category_1, '(uncategorised)') as topic,
  coalesce(category_2, '') as subtopic,
  ticket_type,
  count(*) as tickets
from ticket_facts
where company_name is not null
group by company_name, product_group, category_1, category_2, ticket_type
order by company_name, tickets desc;

comment on view company_ticket_topics is
  'Per-company topic breakdown from the Freshdesk category fields. Nothing here is inferred from ticket text.';

-- Topic mix per product group — the "what are One customers asking about vs
-- Classic customers" question, answered on fields.
create or replace view product_topic_mix with (security_invoker = on) as
select
  product_group,
  product,
  coalesce(category_1, '(uncategorised)') as topic,
  ticket_type,
  count(*) as tickets,
  count(distinct company_name) filter (where company_name is not null) as companies
from ticket_facts
group by product_group, product, category_1, ticket_type
order by product_group, tickets desc;

comment on view product_topic_mix is
  'Topic and type mix per product. Read beside ticket_facts_coverage: One volume is understated if Intercom has not been synced.';

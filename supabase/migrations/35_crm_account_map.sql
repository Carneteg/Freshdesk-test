-- Migration 35 — crm_account_map: the deterministic layer above the fuzzy
-- matching ladder ("curate once, resolve forever", same philosophy as
-- known_incidents).
--
-- A row maps a key we hold (Freshdesk company id, or a requester email domain)
-- to ONE verified Freshworks CRM account. Runtime resolution order becomes:
--   0. this table (deterministic — no name matching at all)
--   1-3. the matching ladder (contact email → company-name stem → email domain)
-- Rows are `human` (curated, always wins) or `learned_contact_email` (written
-- automatically only from the ladder's strongest tier). Conflicting evidence
-- DEACTIVATES a learned row (fall back to the ladder) — never overwrites it.
--
-- RLS is deny-all: service-role only, like known_incidents. Freemail domains
-- are filtered before they can ever become a key.

create table crm_account_map (
  id bigint generated always as identity primary key,
  -- exactly one key per row (enforced below): the Freshdesk company, or a
  -- customer email domain
  freshdesk_company_id bigint,
  email_domain text,
  crm_account_id bigint not null,
  crm_account_name text,
  source text not null default 'learned_contact_email'
    check (source in ('learned_contact_email', 'human')),
  -- reviewer email for human rows
  verified_by text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_confirmed_at timestamptz not null default now(),
  check (freshdesk_company_id is not null or email_domain is not null)
);

comment on table crm_account_map is
  'Deterministic Freshdesk-company/email-domain -> Freshworks-account mapping. human rows are curated and always win; learned_contact_email rows are auto-learned from exact contact-email matches and are DEACTIVATED (never overwritten) on conflicting evidence.';

-- At most one ACTIVE row per key; history stays as inactive rows.
create unique index crm_account_map_company_uidx
  on crm_account_map (freshdesk_company_id)
  where freshdesk_company_id is not null and active;
create unique index crm_account_map_domain_uidx
  on crm_account_map (email_domain)
  where email_domain is not null and active;

alter table crm_account_map enable row level security; -- deny-all (service role only)

-- Scorecard: count the new deterministic tier too (column appended at the end,
-- so create-or-replace is valid).
create or replace view crm_match_scorecard with (security_invoker = on) as
select
  date_trunc('week', created_at)::date as week,
  count(*) as with_lookup,
  count(*) filter (where customer_subscriptions ->> 'status' = 'found') as found,
  count(*) filter (where customer_subscriptions ->> 'status' = 'no_match') as no_match,
  count(*) filter (where customer_subscriptions ->> 'status' = 'ambiguous') as ambiguous,
  count(*) filter (where customer_subscriptions ->> 'status' = 'unavailable') as unavailable,
  round(
    100.0 * count(*) filter (where customer_subscriptions ->> 'status' = 'found')
      / nullif(count(*), 0),
    1
  ) as found_pct,
  count(*) filter (where customer_subscriptions ->> 'matchedBy' = 'contact_email') as via_contact_email,
  count(*) filter (where customer_subscriptions ->> 'matchedBy' = 'company_name') as via_company_name,
  count(*) filter (where customer_subscriptions ->> 'matchedBy' = 'company_name_prefix') as via_company_prefix,
  count(*) filter (where customer_subscriptions ->> 'matchedBy' = 'email_domain') as via_email_domain,
  count(*) filter (where customer_subscriptions ->> 'matchedBy' = 'account_map') as via_account_map
from suggestions
where customer_subscriptions is not null
  and prompt_version <> 'agent-scan'
group by 1
order by 1 desc;

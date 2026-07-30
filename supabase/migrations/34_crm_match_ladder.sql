-- Migration 34 — CRM matching ladder: contract comment + match scorecard.
--
-- 1. The application now writes a richer customer_subscriptions payload than
--    migration 33 documented (the security review audits this column, so the
--    stored contract must match reality):
--      status:    found | no_match | ambiguous | unavailable
--                 ("ambiguous" = several similar CRM accounts — the note tells
--                  the agent to check the CRM manually, never guesses)
--      matchedBy: contact_email | company_name | company_name_prefix
--                 | email_domain   (which ladder tier resolved the account;
--                  the weak tiers carry a verify nudge in the note)
--      candidates[]: up to three CRM account NAMES shown on ambiguity so the
--                  agent sees what to choose between
--      subscriptions[].productName / .renewalStatus / .endDate  (unchanged)
--    CRM context is still never supplied to the LLM.
--
-- 2. crm_match_scorecard — measure the ladder before tuning it further:
--    weekly hit-rate per tier plus no_match/ambiguous/unavailable rates.
--    Derived entirely from existing rows; excludes the agent-scan minimal rows.

comment on column suggestions.customer_subscriptions is
  'Read-only Freshworks CRM context shown to agents: status (found|no_match|ambiguous|unavailable), matchedBy tier, up to 3 candidate account names on ambiguity, and product name / renewal status / end date per subscription. Never sent to the LLM.';

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
  count(*) filter (where customer_subscriptions ->> 'matchedBy' = 'email_domain') as via_email_domain
from suggestions
where customer_subscriptions is not null
  and prompt_version <> 'agent-scan'
group by 1
order by 1 desc;

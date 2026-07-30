-- Migration 33 — persist the verified Freshworks CRM subscription context used
-- in the private note so the authenticated Coach Review page can show the same
-- customer/account evidence for dry-run generations.
--
-- The application writes only:
--   status: found | no_match | unavailable
--   subscriptions[].productName
--   subscriptions[].renewalStatus
--   subscriptions[].endDate
--
-- CRM context is never supplied to the LLM.

alter table suggestions
  add column if not exists customer_subscriptions jsonb;

comment on column suggestions.customer_subscriptions is
  'Read-only Freshworks CRM context shown to agents: product name, renewal status, and end date only. Never sent to the LLM.';

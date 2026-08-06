-- Migration 46 — upsell signals: the customer asked for something they do not have.
--
-- WHY. A support ticket is often the moment a customer describes a need in their
-- own words: "is there a way to run a pulse survey", "can we get the legal
-- updates". If that capability is not in what they actually pay for, that is a
-- commercial signal, and today it dies in the ticket. Freshworks CRM already
-- tells us what the account holds (migration 34/35, read-only) — the missing
-- half is what they ASKED for.
--
-- WHO DECIDES WHAT. The model reads the ticket text and says which catalogue
-- capabilities the customer is asking about. It NEVER sees the customer's
-- subscriptions — CLAUDE.md §12 is explicit that CRM data enters no prompt — and
-- it never decides that something is an upsell. TypeScript joins the requested
-- capabilities against the CRM subscriptions and decides. Same stance as
-- deriveCoachMode, verifyGroundingRefs and the QA validator: the model proposes,
-- TypeScript decides. That is also what keeps this honest: a model that could see
-- the subscription list would be free to invent a gap in it.
--
-- WHAT IT IS NOT. It is not a sales pitch. Nothing here changes the customer
-- draft, and no upsell text is ever written toward a customer — the pipeline
-- stays a COACH (§12, Gate 1 outcome). The signal is internal: it tells the agent
-- to hand the account to sales, which is the routing behaviour the coach
-- framing already asks for.
--
-- NO PROMPT CHANGE. The detector is a separate call with its own UPSELL_VERSION,
-- deliberately outside analyse → draft → verify — the same modular stance as the
-- QA Coach and the article writer. PROMPT_VERSION is untouched, so the golden set
-- stays comparable.

-- ── The catalogue: capability → the product that provides it ─────────────────
--
-- Curated, exactly like known_incidents and crm_account_map. The model is handed
-- the capability KEYS and their descriptions and may only answer with keys from
-- this list — it cannot invent a product, and a capability nobody has curated
-- simply does not exist as far as the detector is concerned. That is deliberate:
-- an invented product in front of a customer is worse than a missed upsell.
--
-- `product_name` must match how Freshworks CRM spells the product, because that
-- string is what the ownership check compares against. Where they differ, list
-- the CRM spellings in `crm_aliases`.
create table if not exists product_catalog (
  id            bigint generated always as identity primary key,
  -- Stable key the model answers with, e.g. "pulse_survey". Never shown to a customer.
  capability    text not null unique,
  -- What the capability IS, in the words a customer would use to ask for it.
  -- This is the whole match signal, so it is worth writing carefully.
  description   text not null,
  -- The product that provides it, spelled as the CRM spells it.
  product_name  text not null,
  -- Other spellings of the same product as they appear in CRM subscription rows.
  crm_aliases   text[] not null default '{}',
  -- One line the AGENT reads: why this is worth handing on, and to whom.
  agent_note    text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table product_catalog is
  'Curated capability -> product map for upsell detection. The model may only answer with capabilities listed here, so it cannot invent a product. product_name/crm_aliases must match the CRM spelling — that string is what the ownership check compares against. SEED ROWS ARE A STARTING POINT AND MUST BE REVIEWED BY A PRODUCT OWNER before the signal is trusted.';

alter table product_catalog enable row level security;
-- Service-role only, like known_incidents: curation happens in SQL, not from a
-- browser holding an anon key.
revoke all on product_catalog from anon, authenticated;

-- ── The signal, stored per generation ────────────────────────────────────────
alter table suggestions
  add column if not exists upsell jsonb;

comment on column suggestions.upsell is
  'Upsell detection result: {status, version, model, requested:[{capability, product, evidence, owned}], opportunities:[...]}. status=opportunity | none | owned | unknown_subscription (CRM did not resolve, so ownership is unknowable) | unavailable. NULL on rows generated before the detector existed, which is NOT the same as "none".';

-- Part of the immutable generation payload — deliberately absent from
-- protect_generation_payload's mutable allowlist, like `coverage`.

-- ── Seed: derived ONLY from product names already evidenced in this repo ─────
--
-- Simployer One, Simployer Expert and Simployer HR appear in real ticket text
-- and in the CRM plan strings. The CAPABILITY descriptions below are a plausible
-- reading of those products, NOT verified product documentation — no product
-- sheet was available when this was written.
--
-- Read them as a template showing the shape, not as truth. A product owner must
-- confirm or replace every row before `upsell_scorecard` means anything, and an
-- unreviewed catalogue is exactly how an agent ends up offering a customer
-- something that does not exist.
insert into product_catalog (capability, description, product_name, crm_aliases, agent_note, active)
values
  ('legal_updates',
   'Ongoing legal/HR guidance and updates on employment law — answers to "what do the rules say", access to advisors, and notification when legislation changes.',
   'Simployer Expert', array['Expert', 'Simployer Expert NO', 'Simployer Expert SE'],
   'Legal questions route to Simployer Expert (CLAUDE.md §12). If the account does not hold it, that is a sales conversation, not a support answer.',
   false),
  ('employee_survey',
   'Running employee surveys / pulse measurements and reporting on the results.',
   'Simployer Survey', array['Survey', 'Simployer Survey'],
   'Hand to the CSM — survey is usually an add-on to an existing One agreement.',
   false),
  ('hr_admin',
   'Core HR administration: employee records, absence, organisation chart, handbook.',
   'Simployer One', array['One', 'Simployer One', 'Simployer HR'],
   'The base product. If the account does not hold it, check the CRM match before reading anything into this.',
   false)
on conflict (capability) do nothing;

-- SEEDED INACTIVE ON PURPOSE. `active = false` means the detector is handed an
-- EMPTY catalogue and returns `none` for every ticket, so nothing can be
-- proposed off unverified product claims. Flip the rows to true once a product
-- owner has checked the wording:
--     update product_catalog set active = true where capability in (...);

-- ── Is the signal any good? ─────────────────────────────────────────────────
--
-- Read this before trusting it. A detector nobody measures is a detector that
-- quietly cries wolf: if opportunities are found on nearly every ticket, the
-- catalogue descriptions are too broad and agents will start ignoring the block.
create or replace view upsell_scorecard with (security_invoker = on) as
select
  prompt_version,
  count(*) as generations,
  count(*) filter (where upsell ->> 'status' = 'opportunity') as opportunities,
  count(*) filter (where upsell ->> 'status' = 'owned') as already_owned,
  count(*) filter (where upsell ->> 'status' = 'none') as nothing_asked_for,
  count(*) filter (where upsell ->> 'status' = 'unknown_subscription') as crm_unresolved,
  count(*) filter (where upsell ->> 'status' = 'unavailable') as detector_failed,
  round(
    100.0 * count(*) filter (where upsell ->> 'status' = 'opportunity')::numeric
      / nullif(count(*) filter (where upsell is not null), 0)::numeric,
    1
  ) as opportunity_pct
from suggestions
where error is null
  and prompt_version <> 'agent-scan'
  and not is_spam
group by prompt_version
order by prompt_version;

comment on view upsell_scorecard is
  'Upsell detection rates per prompt version. A high opportunity_pct is a warning, not a win — it usually means the product_catalog descriptions are too broad. crm_unresolved counts tickets where ownership was unknowable because the CRM did not match; those are a CRM matching problem, not an upsell one.';

-- Which capabilities customers actually ask for that they do not hold. This is
-- the list worth taking to a commercial conversation — a capability that keeps
-- appearing here is demand with a name.
create or replace view upsell_opportunities with (security_invoker = on) as
select
  s.id as generation_id,
  s.ticket_id,
  s.subject,
  s.ticket_url,
  s.language,
  o ->> 'capability' as capability,
  o ->> 'product' as product,
  o ->> 'evidence' as evidence,
  s.created_at
from suggestions s
cross join lateral jsonb_array_elements(coalesce(s.upsell -> 'opportunities', '[]'::jsonb)) o
where s.error is null
  and s.prompt_version <> 'agent-scan'
  and not s.is_spam
order by s.created_at desc;

comment on view upsell_opportunities is
  'One row per detected opportunity, with the customer''s own words as evidence. `evidence` is quoted ticket text — treat it as customer content under the same handling rules as the ticket body.';

grant select on product_catalog to service_role;

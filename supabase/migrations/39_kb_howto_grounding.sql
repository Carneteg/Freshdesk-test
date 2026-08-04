-- Migration 39 — narrow the success metric to KB-covered how-to answers, and
-- record what a draft was actually grounded in.
--
-- WHY. The strict "would I have sent this" rate on g1-2026-07-23c is 40.7 %
-- (n=54) — a 95 % CI of roughly [28 %, 54 %], which straddles the 50 % gate. The
-- green band was no sharper: of the first 15 judged REPLY_READY notes, 4 (27 %)
-- were unusable, and the failure was always the same shape — the reply ASSERTED
-- how the product works with nothing behind it. Broad accuracy is capped by
-- undocumented operational knowledge (see the Gate 1 pivot in CLAUDE.md §12), so
-- the decision is to stop measuring "is the AI right about everything" and start
-- measuring the one band it can actually own: HOW-TO questions the knowledge base
-- covers.
--
-- WHAT CHANGES HERE. Two new columns per generation:
--   grounded_in        — what the reply's ASSERTIONS rest on, as the model reports
--                        it (kb | playbook | ticket | none)
--   grounding_verified — whether that claim survived a CODE cross-check: every ref
--                        the model cited had to resolve to a source we actually
--                        handed it, or to a matched playbook entry. Same stance as
--                        the QA validator and coach_mode: the model proposes, code
--                        decides. A draft can no longer talk itself into the green
--                        band by asserting "kb" over an empty source list.
--   source_refs        — the refs it cited, kept for auditing the above.
--
-- deriveCoachMode now requires grounding_verified before an ASSERTING strategy
-- (DIRECT_ANSWER / PROVIDE_KNOWLEDGE_BASE_INSTRUCTIONS) can be REPLY_READY. An
-- ASKING strategy (clarify / request a detail) asserts no product fact and stays
-- eligible without a source.
--
-- Historical rows are left NULL, not back-filled: the signal did not exist when
-- they were generated and inventing it would corrupt exactly the baseline this
-- view is meant to compare against. `kb_howto_scorecard` therefore only reports
-- from g1-2026-08-03a onward.

alter table suggestions
  add column if not exists grounded_in text,
  add column if not exists grounding_verified boolean,
  add column if not exists source_refs jsonb;

alter table suggestions
  drop constraint if exists suggestions_grounded_in_chk;
alter table suggestions
  add constraint suggestions_grounded_in_chk
    check (grounded_in is null or grounded_in in ('kb', 'playbook', 'ticket', 'none'));

comment on column suggestions.grounded_in is
  'What the reply''s assertions rest on, as reported by the draft call (kb|playbook|ticket|none). Never trusted alone — see grounding_verified.';
comment on column suggestions.grounding_verified is
  'Code cross-check: did the cited source_refs actually resolve to a retrieved source or a matched playbook incident? Gates REPLY_READY for asserting strategies. NULL on rows generated before g1-2026-08-03a.';
comment on column suggestions.source_refs is
  'The refs the draft call cited for its assertions (e.g. ["kb:1042","P2"]). Audit trail for grounding_verified.';

-- These are part of the immutable generation payload, NOT reviewer-writable: they
-- are deliberately absent from protect_generation_payload's mutable allowlist, so
-- any attempt to edit them after the row leaves 'reserved' is rejected.

-- ── The narrowed metric ──────────────────────────────────────────────────────
--
-- "Does it answer correctly on KB-covered how-to questions?" — the population is
-- how-to tickets where retrieval actually produced KB grounding that survived the
-- cross-check. Everything else (a bug with no article, an unclear request, a
-- routing case) is out of scope for THIS number by design; read the unrestricted
-- gate1_scorecard beside it so narrowing the metric never hides a wider decline.
create or replace view kb_howto_scorecard with (security_invoker = on) as
select
  prompt_version,
  count(*) as generated,
  count(verdict) as judged,
  count(*) filter (where verdict = 'usable') as usable,
  count(*) filter (where verdict = 'edited') as edited,
  count(*) filter (where verdict = 'unusable') as unusable,
  round(
    100.0 * count(*) filter (where verdict = 'usable')::numeric
      / nullif(count(verdict), 0)::numeric,
    1
  ) as usable_pct,
  -- the lenient read, kept visible so the strict/lenient choice stays an explicit
  -- stakeholder decision rather than an artefact of which view someone opened
  round(
    100.0 * count(*) filter (where verdict in ('usable', 'edited'))::numeric
      / nullif(count(verdict), 0)::numeric,
    1
  ) as usable_or_edited_pct
from suggestions
where error is null
  and prompt_version <> 'agent-scan'
  and not is_spam
  and ticket_type = 'howto'
  and grounding_verified is true
group by prompt_version
order by prompt_version;

comment on view kb_howto_scorecard is
  'The narrowed Gate 1 metric (2026-08-03): "would I have sent this" restricted to how-to tickets with verified KB/playbook grounding. Empty for prompt versions before g1-2026-08-03a, which did not record grounding.';

-- ── Where the how-to population actually lands ───────────────────────────────
--
-- The scorecard above only shows the grounded slice; this shows the whole how-to
-- funnel, so a rising usable_pct that came from grounding fewer and fewer tickets
-- is immediately visible. A metric you can improve by answering less is not a
-- metric — read these two together.
create or replace view kb_howto_coverage with (security_invoker = on) as
select
  prompt_version,
  count(*) as howto_tickets,
  count(*) filter (where grounding_verified is true) as grounded,
  count(*) filter (where grounding_verified is false) as ungrounded,
  count(*) filter (where grounding_verified is null) as not_recorded,
  count(*) filter (where coach_mode = 'REPLY_READY') as reply_ready,
  round(
    100.0 * count(*) filter (where grounding_verified is true)::numeric
      / nullif(count(*), 0)::numeric,
    1
  ) as grounded_pct
from suggestions
where error is null
  and prompt_version <> 'agent-scan'
  and not is_spam
  and ticket_type = 'howto'
group by prompt_version
order by prompt_version;

comment on view kb_howto_coverage is
  'The how-to funnel per prompt version: how many how-to tickets we could actually ground. Read beside kb_howto_scorecard — a usable_pct that rose while grounded_pct fell means the gate got stricter, not the answers better.';

-- ── Is 'howto' the right population? ─────────────────────────────────────────
--
-- Checked against live data the moment this shipped, and the answer is not
-- obvious. Judged verdicts per ticket_type (all versions, 2026-08-03):
--   question 29 judged · 58.6 % usable · 82.8 % usable-or-edited
--   howto     8 judged · 25.0 % usable · 100  % usable-or-edited · ZERO unusable
--   bug      30 judged · 26.7 % usable · 70.0 % usable-or-edited
--   unclear   2 judged — too few to read
-- So 'howto' is the SAFE band (nothing an agent refused outright) but not the
-- strongest strict band, and at 13 generations it is thin. 'bug' is the weak one
-- and also the biggest. This view keeps that comparison live inside the grounded
-- population, so widening the metric to question+howto — or keeping it at howto —
-- is decided on data from the new prompt version, not on the old mixed baseline.
create or replace view grounded_scorecard_by_type with (security_invoker = on) as
select
  prompt_version,
  ticket_type,
  coalesce(grounding_verified, false) as grounded,
  count(*) as generations,
  count(verdict) as judged,
  count(*) filter (where verdict = 'usable') as usable,
  count(*) filter (where verdict = 'edited') as edited,
  count(*) filter (where verdict = 'unusable') as unusable,
  round(
    100.0 * count(*) filter (where verdict = 'usable')::numeric
      / nullif(count(verdict), 0)::numeric,
    1
  ) as usable_pct
from suggestions
where error is null
  and prompt_version <> 'agent-scan'
  and not is_spam
group by prompt_version, ticket_type, coalesce(grounding_verified, false)
order by prompt_version, ticket_type;

comment on view grounded_scorecard_by_type is
  'Verdicts split by ticket_type AND whether grounding was verified. The evidence for whether the narrowed metric should stay at howto or widen to question+howto.';

-- ── Honesty check on the model's own grounding claim ─────────────────────────
--
-- grounded_in is self-reported; grounding_verified is checked. Where they diverge,
-- the model claimed a source it could not cite — the exact failure the narrowing
-- exists to catch. If this count is large, the draft prompt is at fault, not the
-- gate.
create or replace view grounding_claim_audit with (security_invoker = on) as
select
  prompt_version,
  coalesce(grounded_in, '(not recorded)') as claimed,
  count(*) as generations,
  count(*) filter (where grounding_verified is true) as verified,
  count(*) filter (where grounding_verified is false) as unverified,
  count(*) filter (where verdict = 'unusable') as judged_unusable
from suggestions
where error is null
  and prompt_version <> 'agent-scan'
  and not is_spam
group by prompt_version, coalesce(grounded_in, '(not recorded)')
order by prompt_version, generations desc;

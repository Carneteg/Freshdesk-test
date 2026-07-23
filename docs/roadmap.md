# Development roadmap — Gate 2+ (data-source expansion)

**Status:** proposal. Gate 1 (single small agent set, private notes, coach) is live.
Everything here is deferred per CLAUDE.md §2 ("Freshdesk only" in Gate 1) and needs
API access + a DPA review per source — weeks of calendar time each.

## Guiding principles (read first)

- **Gate 1 must clear its bar first.** Do not invest in integrations until
  `gate1_scorecard` shows >50 % "would I have sent this". Otherwise you are
  building on a coach that hasn't proven its value.
- **One source at a time, measure the delta.** Each source adds grounding *and*
  noise, integration cost, and a new security/PII surface. Add one, measure the
  scorecard change, then the next.
- **Access requests in parallel, builds sequential.** Every source needs its own
  access + DPA sign-off (calendar time). Start the *requests* for Jira /
  Confluence / Planhat early, even though you *build* one at a time.
- **Unified retrieval.** All sources land in the same pattern already used for KB +
  past tickets: source-tagged grounding, the same verify discipline, hyperlinked
  citations in the note.
- **Writes stay minimal.** The only external writes remain the private note + up to
  three keyword tags. Everything new is read-only — this keeps the security review
  narrow.

## Phases

### Phase 0 — Close Gate 1 (measure, build nothing)
- **What:** collect ~50 agent verdicts, read `gate1_scorecard`, decide.
- **Why:** the whole point of Gate 1. It gives the green light (or a stop) before
  weeks are spent on integrations.

### Phase 1 — Jira (live incidents) · biggest impact
- **What:** connect Jira read-only. Poll open/recent incidents, match them to
  tickets by symptom, surface "known incident JIRA-123 (investigating/fixed) —
  matches this ticket".
- **Why:** the single largest quality gap found in Gate 1 was that the agent's edge
  is *live incident knowledge* (known faults, "fixed — clear cache", who is
  affected). Jira is the source of truth for that. This replaces the manual
  `known_incidents` playbook with a live feed and delivers the real-time incident
  awareness described in `docs/concurrent-ticket-awareness.md` from the right system.
- **Effort:** M · **Risk:** low–medium (read-only; incident data is less
  PII-sensitive). **Interim until then:** keep curating the manual playbook.

### Phase 2 — Confluence (internal knowledge)
- **What:** index relevant Confluence spaces (embeddings), retrieve like the KB.
- **Why:** the Freshdesk KB is thin/generic — that is why the coach sometimes had no
  answer. Confluence holds the *written* internal knowledge. Lifts accuracy on
  how-to / product questions (everything that isn't an incident).
- **Effort:** M · **Risk:** low–medium (scope the spaces; some may be sensitive).

### Parallel track — Learning loop (Gate 2 core)
- **What:** use the collected verdicts to tune / fine-tune generation toward the
  replies agents actually accept.
- **Why:** the verdict corpus is already being collected (feedback buttons). Once it
  is large enough the model can start *learning*, not just guessing. Needs no
  external source, so it can run alongside Phases 1–2.

### Phase 3 — Planhat (customer context)
- **What:** read-only lookup by customer email/domain → account, tier, relationship,
  contacts → injected into the analyse step.
- **Why:** who the customer is helps **routing** (sales/CSM), personalisation, and —
  importantly — the **blocking safety rule** (verify account relationship/authority
  before deletion or sensitive actions). Sequenced after Jira/Confluence because the
  PII surface is larger and the value is more about routing than answering.
- **Effort:** M · **Risk:** **high** (customer PII, contract data) — needs a proper
  DPA / privacy review.

### Phase 4 — Slack + Productboard / Linear (last, incremental)
- **Slack (product news):** surface "recent changes / known-issue chatter" as
  freshness context. Lower, noisier signal — do last.
- **Productboard / Linear (feature requests):** when a customer asks for a feature,
  check if it is already requested/planned → route and set expectations ("this is on
  the roadmap / already logged").
- **Effort:** S–M each · **Risk:** low.

## Each source → the gap it fills

| Source | Gap it fills |
|---|---|
| **Jira** | Live & known incidents — the agent's #1 edge |
| **Confluence** | Written internal know-how the KB lacks |
| **Planhat** | Customer identity & relationship — routing + safety |
| **Slack** | Recent product changes — freshness |
| **Productboard / Linear** | Feature-request routing & expectations |

## Recommended order (summary)

Gate 1 measurement → **Jira** (live incidents = biggest gap) → **Confluence**
(written internal knowledge) → *learning loop in parallel* → **Planhat** (customer
context + safety, larger PII) → **Slack / Productboard / Linear** (freshness +
feature routing, incremental).

## Cross-cutting

- Per source: its own access + DPA sign-off, source-tagged grounding, hyperlinked
  citations, and a scorecard measurement *before* the next source.
- A wider **multi-agent rollout** is a separate decision, gated on quality
  (works-council), not on the number of sources.

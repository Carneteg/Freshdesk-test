# CLAUDE.md — Gate 1: AI suggested replies for Freshdesk

Read this first. It contains decisions already made, why they were made, and
what still needs doing. Do not relitigate settled decisions unless you find a
concrete technical blocker — if you do, say so explicitly rather than quietly
changing direction.

---

## 1. What we are building

A background job that watches **one agent's** Freshdesk tickets. When a ticket
is assigned to that agent, it drafts a suggested reply and posts it as a
**private note** on the ticket. The agent reads it, decides whether it is any
good, and records a verdict.

The entire purpose is to answer one question over ~50 tickets:

> **"Would I have sent this reply?"**

If the answer is yes often enough (>50%), the project proceeds to a wider
pilot. If not, it stops. This is a two-week experiment, not a product.

**Company context:** Simployer, Nordic HR-tech (payroll, HR admin,
compensation). Support tickets arrive in Norwegian (~49%), English (~39%) and
Swedish (~12%). Customer content may contain employee personal data — treat
it accordingly.

---

## 2. Decisions already made — do not change without flagging

| Decision | Reason |
|---|---|
| **Polling, not webhooks** | Freshdesk waits for a webhook response; our pipeline takes ~10s. Polling avoids timeouts, retries, duplicate notes, and any public endpoint. A ~60s delay is irrelevant here. |
| **Supabase Edge Functions** | Account already exists. Postgres + serverless in one place. Must be **Frankfurt / EU Central** — region is permanent per project. |
| **No n8n** | One workflow does not justify a new self-hosted platform, and it would trigger a 2–8 week IT review. Revisit only at Gate 3 if non-engineers need to maintain many automations. |
| **Freshdesk only** | No Confluence, Jira, Salesforce, Planhat, or vector store in Gate 1. Those need API access from four other teams — weeks of calendar time. Gate 2 problem. |
| **Three LLM calls** | analyse → draft → verify. One call produces confident nonsense; the verify step exists to catch it. |
| **Always post a note** | Including when confidence is `none`. Silence is ambiguous — the agent cannot tell "no answer found" from "the job crashed". Low-confidence notes state what was searched and what was missing, which doubles as a knowledge-base gap report. |
| **One agent only** | Two independent filters (poll filter + `responder_id` re-check). Removes adoption risk, works-council concerns, and any chance of a bad draft reaching a colleague's customer. |
| **Keyword retrieval first** | Freshdesk's own search. Add embeddings/pgvector **only if** evaluation shows retrieval is the dominant failure mode. Do not build it pre-emptively. |

---

## 3. Systems and flow

```
pg_cron (every minute)
  → Edge Function `ticket-suggester`
      1. GET /api/v2/tickets?updated_since=…   filter responder_id == MY_AGENT_ID
      2. skip tickets already in `suggestions`
      3. per ticket:
           a. Claude call 1 — analyse:  language, questions_asked, search_queries
           b. Freshdesk search — KB solutions + past RESOLVED tickets
           c. Claude call 2 — draft:    reply grounded ONLY in retrieved sources
           d. Claude call 3 — verify:   check every claim against those sources
           e. POST /api/v2/tickets/{id}/notes  {private: true}
           f. INSERT into `suggestions`
```

Three systems total: **Freshdesk** (trigger + data + KB + destination),
**Supabase** (compute + log), **Claude API** (reasoning). Nothing else.

**The only write to any external system** is the private note — plus, as of
2026-07-21, up to three single-word keyword tags on the same ticket (see §12,
"Ticket tagging"). Everything else is read-only. Keep it that way — the two
writes both target one ticket, which is what keeps the security review narrow.

---

## 4. Existing code

The repo already contains a working first draft. It **typechecks** (`deno
check`) but has **never run against a live Freshdesk instance**.

```
supabase/migrations/01_init.sql              tables + evaluation views
supabase/functions/ticket-suggester/
    index.ts       polling loop + pipeline + note rendering
    clients.ts     Freshdesk + Claude API clients
    prompts.ts     the three prompts  ← the actual product
scripts/replay.ts  runs closed tickets through it, posts nothing
README.md          setup and how to run the experiment
```

Read all of it before changing anything.

---

## 5. Environment

```
FRESHDESK_DOMAIN      e.g. "simployer"  (→ simployer.freshdesk.com)
FRESHDESK_API_KEY     service account key that POSTS notes; base64(apikey + ":X")
MY_AGENT_ID           the MONITORED agent whose tickets we watch (may differ from key owner)
OPENAI_API_KEY        LLM provider — the three reasoning calls (see §12)
OPENAI_MODEL          default gpt-4o
CRON_SECRET           guards the function; pg_cron sends it as x-cron-secret
SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   (injected by Supabase)
```

Never commit secrets. Never log ticket bodies or customer PII to console.

---

## 6. Your build order

**Do these in order. Do not skip ahead — each step de-risks the next.**

### Step 1 — Verify the Freshdesk API actually behaves as assumed
This is the highest-risk unknown. The client code was written from
documentation, not from a live instance. Write a throwaway script that:

- `GET /api/v2/agents/me` → confirm the agent id
- `GET /api/v2/tickets?updated_since=…` → confirm the field is named
  `responder_id` and that filtering works
- `GET /api/v2/tickets/{id}?include=conversations` → confirm
  `description_text`, `body_text`, `incoming`, `private` field names
- `GET /api/v2/search/solutions?term=…` → **confirm this endpoint exists and
  what its response shape is.** This is the one I am least confident about.
- `GET /api/v2/search/tickets?query=…` → confirm the query syntax
- `POST /api/v2/tickets/{id}/notes` → post a test note to a test ticket

Fix `clients.ts` to match reality. Report anything that differs from the
assumptions above.

### Step 2 — Minimal end-to-end, no retrieval
Ticket in → Claude → note out. Skip search entirely. Run it on ~5 tickets.
Confirms auth, latency, note rendering, and the log write. Should be ~4 hours.

### Step 3 — Add retrieval
Wire up the KB + past-ticket search. **Before this, check ten resolved
tickets**: does the customer-facing reply actually contain the solution? If
your team resolves things by phone or in private notes, past tickets teach the
model nothing and retrieval must be KB-only. Report what you find.

### Step 4 — Replay harness
`scripts/replay.ts` against 50 closed tickets. Nothing posted. This is how
quality gets evaluated before anything goes live.

### Step 5 — Schedule it
Only after replay results look reasonable.

---

## 7. Known unknowns — verify, do not assume

**Step 1 findings (2026-07-22, live `simployer` instance):**
- ✅ `GET /search/solutions?term=` **works** and returns articles with `title` +
  `description_text`. Retrieval is viable; the endpoint is confirmed in `clients.ts`.
- ⚠️ `GET /search/tickets?query=` requires **field-based** queries
  (`status:5 AND agent_id:123`), not free text — a bare term is HTTP 400. So
  past-ticket *content* retrieval is not feasible here; **KB-only stands** and
  the Step 3 "is the answer in the reply" check is moot for retrieval purposes.
- Still to confirm live: conversation field names on a ticket that HAS replies
  (`body_text`/`incoming`/`private`), the note write, and the tag write — run the
  probe with `PROBE_TICKET_ID` + `POST_TEST_NOTE_TICKET_ID` set.

- **Freshdesk solutions search endpoint.** ~~May not exist in that form.~~
  Resolved above — it exists and returns `description_text`.
- **Freshdesk rate limits.** Plan-dependent. Handle 429 with `Retry-After`.
  The pipeline makes several calls per ticket; batching may be needed.
- **`updated_since` semantics.** Confirm it uses `updated_at`, and whether
  reopened/updated tickets re-trigger. Deduplication is on
  `(ticket_id, trigger_message_id)`, not `ticket_id` alone — see Section 12.
- **Edge Function timeout.** Three Claude calls plus searches may approach the
  limit. If so, process fewer tickets per run (`MAX_PER_RUN`) rather than
  parallelising into rate limits.

---

## 8. Testing

There is no meaningful unit-test surface here — the logic is API orchestration
and prompt behaviour. Test by:

1. **Replay against closed tickets.** The real test. Compare the suggestion to
   what the agent actually sent (stored in the same ticket).
2. **Golden set.** The 50 replayed tickets become a regression suite. After any
   prompt change, bump `PROMPT_VERSION` and re-run the *same* tickets. Compare
   `gate1_scorecard` across versions. Without this, prompt iteration is guesswork.
3. **Calibration check.** Query the `calibration` view. The cell
   `confidence='high' AND verdict='unusable'` is confident nonsense — the only
   genuinely dangerous output. If non-zero, tighten the HIGH criteria in
   `prompts.ts` before anything else.

Do add small unit tests for the pure functions (`extractJSON`, `strip`, `esc`,
`renderNote`) — those are cheap and catch real regressions.

---

## 9. Definition of done for Gate 1

- [ ] Runs on a schedule without manual intervention
- [ ] Posts a note on every assigned ticket, including low-confidence ones
- [ ] Never touches a ticket assigned to anyone else (verified, not assumed)
- [ ] Every generation logged with sources, confidence, prompt version, latency
- [ ] Replay harness works against closed tickets
- [ ] 50 tickets generated and judged
- [ ] `gate1_scorecard` produces a usable-percentage figure

**Not in scope:** UI, auth, multi-agent support, other data sources, error
alerting, retries beyond the next poll, cost dashboards.

---

## 10. Quality bar

**The prompts are the product.** `prompts.ts` will change far more often than
the code. Optimise it for readability and iteration — it should be obvious to a
non-engineer what the model is being told.

**Correctness over cleverness.** A wrong suggestion is worse than no
suggestion. When in doubt, lower confidence and post the "no confident answer"
note. That path is a feature, not a failure.

**No silent failures.** Every error gets logged to `suggestions.error` with the
ticket id. A crashed run must be visible in the data.

**Do not expand scope.** If you find yourself adding a data source, a UI, or a
new service, stop and ask. The value of this experiment comes from it being
small enough to finish and honest enough to kill.

---

## 11. Data protection — non-negotiable

Ticket content may contain employee personal data. Before running against
**live** tickets, the DPA position on Anthropic and Supabase must be confirmed
by legal. Until then, use closed tickets via the replay harness, or synthetic
data. If asked to run live before that is settled, flag it rather than proceed.

Note: replaying real closed tickets (Section 6, Step 4) still sends real
customer PII to Anthropic on every call. The DPA gate therefore applies to the
replay harness too, not only the live scheduler. Flag at run time; do not
proceed silently.

---

## 12. Resolved design questions (2026-07-21)

These refine Sections 3, 6 and 7. Where they conflict with an earlier line,
these win.

**Verify step (Claude call 3) — failure behaviour.**
Verify only ever *lowers* confidence, never raises it, and never freely
rewrites the draft (free rewriting reintroduces ungrounded text). It classifies
each claim against the retrieved sources:
- Any claim **contradicted** by sources → confidence drops to `none`; discard
  the draft and post the standard "no confident answer" note (what was
  searched, what was missing).
- Any claim **unsupported** (not in sources, not contradicted) → drop one
  confidence level and strip those sentences before posting.
- All claims **supported** → post as drafted.
Always log the verify verdict to `suggestions` so the `calibration` view is
meaningful. Effect: a HIGH draft that fails verify becomes NONE, so the
`high + unusable` cell is structurally near-impossible.

**Re-triggering on customer response.**
A new customer reply is treated exactly like a new ticket: generate a fresh
suggestion. Dedup is therefore **not** a unique index on `ticket_id` alone.
Store the id of the latest customer message the suggestion was based on
(`trigger_message_id` — the newest conversation entry with `incoming: true`,
or the ticket description for the first reply) and make the unique key
`(ticket_id, trigger_message_id)`. Skip a ticket only when a suggestion already
exists for its *current* latest customer message; a newer customer message
produces a new row. Agent/internal updates do not re-trigger.

**Replay harness — first run.**
Default to **5 tickets**, not 50, for the first run. Before sending anything to
Anthropic, print the chosen ticket ids and subjects and stop for approval.
Scale to 50 only after that first batch looks right. (DPA caveat in Section 11
applies — these are real closed tickets carrying real PII.)

**Edge Function timeout — what it means and what to do.**
Each ticket makes ~5 sequential network calls (analyse → KB search → ticket
search → draft → verify), each waiting on the one before; three Claude calls
alone can be 10–30s. Supabase Edge Functions have a hard wall-clock limit per
invocation, so a few slow tickets in one run can get the function killed
mid-flight — possibly after a note is posted but before its log row is written.
Mitigation: an explicit timeout on every fetch (AbortController) and a
per-ticket time budget; on breach, log to `suggestions.error` and move on.
Unfinished tickets are picked up on the next minute's poll. `MAX_PER_RUN` still
caps tickets per run but does not bound a single slow ticket.

**`MY_AGENT_ID` — source of truth.**
The `MY_AGENT_ID` env var is authoritative for **which tickets to watch**; both
the poll filter and the `responder_id` re-check use it.

**Service account vs monitored agent (decoupled, 2026-07-22).** Per Tobias, the
API key is a **service account** that *posts* the notes, deliberately separate
from `MY_AGENT_ID`, the **monitored agent** whose tickets we watch — so more
monitored agents can be added later without re-keying. This amends the earlier
rule that `/agents/me` must equal `MY_AGENT_ID`: that assertion is **removed**.
The safety property ("never suggest on a colleague's ticket") is unchanged — it
is enforced entirely by the `responder_id == MY_AGENT_ID` filter + re-check,
regardless of who owns the key. Startup now: (a) calls `/agents/me` to confirm
the key authenticates and logs the service account, (b) requires `MY_AGENT_ID`
to be a numeric id, and (c) best-effort `GET /agents/{MY_AGENT_ID}` to warn if
the monitored agent's name ≠ `EXPECTED_AGENT_NAME` (needs admin API; a failure
only warns). Notes are authored by the service account, which is fine since notes
are private/internal.

**Monitored agents — a small set (2026-07-23).** Per Tobias, `MY_AGENT_ID` now
accepts a **comma-separated list** of numeric agent ids, and the system watches
**all** of them (currently **Tobias + Johanna**; Johanna confirmed aware,
DPA OK). This widens the earlier single-agent rule (§9 "multi-agent support" out
of scope) to a small, **named** set — not an open rollout. The safety property is
unchanged and now enforced by two independent filters: the poll filter
(`responder_id ∈ MY_AGENT_ID`) **and** a re-check of the reloaded ticket's
responder before anything is posted. Startup logs each monitored agent's name.
Still private-notes-only; a broad multi-agent rollout remains a Gate 2 decision.

**LLM provider — OpenAI (2026-07-22).** Per Tobias the Anthropic key is
unavailable, so the three reasoning calls (analyse → draft → verify) now run on
**OpenAI** (`OPENAI_API_KEY`, `OPENAI_MODEL` default `gpt-4o`). The provider is
isolated in the `LLM` class in `clients.ts`; prompts and pipeline are unchanged,
so switching back is a one-file change. Historical "Claude"/"Anthropic" mentions
elsewhere in this doc describe the same pipeline — read them as "the LLM provider".

**DPA — cleared for OpenAI + Supabase (2026-07-22).** Per Tobias, the DPA
position on **OpenAI** is now approved (the earlier Anthropic clearance is moot
since the provider switched). Sending real ticket text to OpenAI — including via
the replay harness and the live scheduler — is therefore permitted for Gate 1.
The §11 "flag rather than proceed" rule is satisfied for the current provider; it
still applies to any *new* data source or a further provider change.

**Supabase project (provisioned).** `simployer-ticket-suggester`, ref
`pqwnpcibymtmcpnqlkle`, region `eu-central-1` (Frankfurt, per §2). Schema applied;
`suggestions` has RLS enabled (service role bypasses it) and all views run
`security_invoker`.

**Note contents & feedback signal.** The private note shows, beyond the draft:
a **Confidence** badge, a **Q/A score** (questions answered of asked), a short
**rationale** (why the answer fits *this* customer's wording), and **hyperlinked
sources** (KB solution → article, past ticket → ticket). Two feedback axes are
logged: `verdict` (the human "would I have sent this", gold standard) and `used`
(used/partly/not, auto-derived from draft-vs-sent similarity) — the latter is the
signal a Gate 2 learning loop would train on. Views: `gate1_scorecard` (human
verdict), `usage_scorecard` (usage + coverage), `calibration`, `failures`.
The learning loop itself (feeding accepted replies back into generation) is
deliberately deferred to Gate 2 — it needs the corpus these fields now collect.

**Triage, follow-ups, bug guidance.** analyse also classifies `ticket_type`
(question | howto | bug | unclear) and extracts topic `keywords`. The draft adds
`follow_up_questions` (shown when the request is unclear, instead of a bare "no
answer") and `bug_guidance` (reproduction steps for the agent + safe step-by-step
for the customer, for bug tickets). All grounded in sources; nothing invented.

**Ticket tagging (visibility) — §3 amended.** Per Tobias (2026-07-21) the system
now also writes up to **3 single-word** keyword tags onto the Freshdesk ticket,
**merged** with existing tags (never clobbering them). This is a deliberate
SECOND external write, amending §3's "only write is the private note": the
security review must now also cover ticket tag updates (`PUT /tickets/{id}`, the
`tags` field). The full keyword list still lives internally in
`suggestions.keywords`; the ticket receives at most the first three, one word
each. A tag-write failure is logged and skipped — it never fails the ticket,
since the note is the real deliverable.

**Gate 1 outcome — reframed to an agent COACH (2026-07-22).** A QA review of 16
written tickets (Johanna's) scored the AI ~2.4/5 vs the agent ~4.6, agent better
in 15/16, AI never clearly better. Root cause is NOT tone: the model defaulted to
ungrounded "this is probably a permissions/role issue" guesses and used the KB by
keyword, not content. The agent's edge was operational knowledge not written down
anywhere (known incidents, reindexing fixes 404s, a user on a read-link, exact
profile settings, "legal → Expert"). Conclusion: **autonomous solution-drafting
on KB-only does not clear the >50% "would I have sent this" bar**, and more prompt
tuning yields diminishing returns because the gap is *knowledge*, not wording.

Decision (Tobias): **reposition the AI as decision support / a coach for the
agent, not an autonomous answer generator.** Its job is to surface what is
VERIFIED in the ticket, propose concrete verification/next steps, route correctly
(sales/consultant; legal → Simployer Expert), and polish tone/structure — and to
draft a customer reply ONLY when it is genuinely grounded (a KB-covered how-to, a
clear routing message, or a clarifying question). When the cause is unknown it
must ABSTAIN from a customer reply and hand the judgement back. Encoded in
`prompts.ts` (g1-2026-07-22i grounding rules → g1-2026-07-22j coach framing) and
the note layout (`renderNote`: agent checks first, customer draft conditional).

Related eval hygiene: auto-generated phone/call-log tickets ("Incoming call
with…") are excluded everywhere (they carry no question); `similarity` is treated
as a weak text-overlap proxy, not a quality score — judge on cause/action/
grounding via `verdict`. The real growth lever (weighting known incidents /
similar concurrent tickets over generic KB) needs ticket-content retrieval, which
Freshdesk's search does not allow (free-text → 400) — a Gate 2 problem, or an
interim curated incident/routing list fed into the prompt.

**QA Coach — an automatic rubric scorer beside the human verdict (2026-07-23).**
Imported the "Simployer QA Coach" package as an **offline eval-scorer** ("mode A").
It grades a finished agent reply against a fixed **7-criterion rubric** (Tone 15,
Accuracy 20, Clarity 15, Empathy 15, Resolution intent 15, Efficiency 10,
Follow-through signal 10; weighted 0–100 → Excellent/Good/Acceptable/Needs review)
and returns strict JSON. **Accuracy ≤ 2 forces `needsHumanReview` + a "Needs review"
verdict** regardless of total — the same "don't let tone paper over an unverifiable
claim" stance as the pipeline's grounding rules.

- Dropped in as the canonical **v1.0** package, kept modular (do not fold into the
  pipeline): `qa-rubric.ts` (criteria + weights + deterministic scoring), `qa-calibration.ts`
  (the agreed calibration rules), `qa-system-prompt.ts` (the English system prompt, built
  FROM the rubric + calibration, and the user-prompt builder), `qa-schema.ts` (Structured-
  Outputs schema), `qa-types.ts`, and `qa-validator.ts`. It runs through the SAME isolated
  `LLM` class (`completeSchema()` in `clients.ts`), so the provider stays in one place (§12).
- **The model proposes scores; TypeScript decides the outcome.** `qa-validator.ts`
  recomputes weighted points, total, verdict and the review flag from the raw 1–5 scores
  (`validateAndNormalizeAssessment`, called in `runQaCoach`) — the model's arithmetic and
  verdict are discarded, so there is no arithmetic drift and the Accuracy-≤2 override is
  enforced in code, not by trust. Unit-tested in `qa_test.ts`.
- It is **NOT** part of the analyse→draft→verify pipeline: the pipeline *produces* a
  reply, the coach *judges* one (`runQaCoach` / `qaScoreDraft` in `pipeline.ts`).
- **Grounding rule (non-negotiable):** the coach NEVER fetches product facts on its
  own — `replay.ts` passes the ticket context + the exact sources the draft had as
  `ticketContext`, so it cannot credit a reply for information the agent never held.
- **Human `verdict` stays the gold standard.** The QA score sits beside it as an
  automatic, consistent second read (columns `qa_score`/`qa_verdict`/
  `qa_needs_review`/`qa_assessment`/`qa_version`, migration 17). Views: `qa_scorecard`
  (rubric spread per prompt version) and `qa_vs_human` (does the rubric agree with the
  humans on judged rows — read before trusting the QA score as a proxy).
- Wired into `replay.ts` (default on; `QA_COACH=false` to skip). One extra LLM call
  per scored ticket; abstains (no send-ready reply) are not scored. DPA: same OpenAI
  clearance as the rest of the pipeline (§11) — real ticket text is sent.

**Review UI — a shared reviewer app (2026-07-23, DPA+IT cleared).** §9 parked "UI"
out of Gate 1; with DPA + IT sign-off obtained, a small **read+judge** web app was
added so agents can work through drafts and record verdicts without SQL/PowerShell.
The canonical app is `web/review.html`; the `review-ui` Edge Function is only a
compatibility redirect to `REVIEW_APP_URL`. The page is public HTML; auth + data
gating are entirely client-side + RLS.
- **Security is RLS, not the app.** The page embeds only the **anon** key — never a
  service-role/Freshdesk/OpenAI key. Migration 18 adds an `app_reviewers` email
  allowlist + `is_reviewer()`; migration 19 hardens grants so an authenticated
  reviewer can **read** `suggestions` and **update only** `verdict`/`verdict_at`/
  `gold_answer` — nothing else. Non-allowlisted or logged-out users see nothing.
  Migration 19 also enabled RLS on `known_incidents` (was off). Login is Supabase
  Auth (magic link / email code); authorization is the allowlist, not signup.
- **Training capture (2026-07-23).** Migration 20 adds `agent_sent_reply` (what the
  agent really sent, replay-populated — the gold standard, esp. Johanna's) and
  `gold_answer` (+ `_at`/`_by`, stamped from the JWT by a trigger, not the client).
  The UI shows the agent's real reply as reference and lets a reviewer write the
  ideal answer. View `training_examples` is the exportable corpus. **Honest scope:**
  this BUILDS the "what good looks like" corpus; feeding it back into generation is
  the Gate 2 learning loop (§12) — nothing here fine-tunes a model yet.
- The review UI carries a **"How to train the AI" guide** (verdict meaning; how to write
  an ideal answer — real resolution + the operational knowledge the KB lacks + correct
  routing; where to spend time). The page is `web/review.html`, a self-contained
  local-file / static-host page (Supabase serves HTML as text/plain, so it is NOT hosted
  there): raw `fetch` + email/password Supabase Auth, RLS-gated, anon key only. Published
  to a `gh-pages` branch (app file only, no repo code) for a shareable link.

**Learning loop v1 — gold answers -> prompt (Gate 2 start, 2026-07-23).** Per Tobias the
near-term Gate 2 focus is **the AI + learning**, NOT the Planhat/Confluence/Slack/Jira
integrations (those stay deferred). The cheapest loop: feed the reviewer-written
`gold_answer` corpus from OTHER tickets into the **draft** prompt as **style/approach
exemplars** (`GoldExemplar` in `prompts.ts`; `loadGoldExemplars` + `withLearning` in
`pipeline.ts`). Guardrails: the current ticket's own gold answer is excluded (no leakage),
and the prompt says LEARN the style/operational approach but do NOT copy their facts unless
this ticket's own sources establish them (grounding still wins). **Opt-in** via
`LEARNING_LOOP=true` in `replay.ts`; a learning run is stored under a **`+gold`
prompt_version** so `gate1_scorecard` compares it head-to-head against the base run on the
SAME tickets. Not fine-tuning — retrieval-style few-shot. Measure the lift before doing more.

**Agent-reply QA scan — triage over history (2026-07-23).** The QA Coach, pointed at
the AGENTS' actual historical replies, becomes a triage engine: `scripts/score_history.ts`
(`deno task score-history`) scores each agent's first substantive reply with ONE QA call,
posts NOTHING to Freshdesk, and stores only in Supabase (`agent_qa_*`, migration 21). The
weakest surface in the `rewrite_queue` view and a **Rewrite** tab (worst-first) in the
review app, where a reviewer writes a better `gold_answer` (which then feeds the learning
loop above). History-scan rows live on `suggestions` with `prompt_version='agent-scan'`
(minimal row, no AI draft) and are EXCLUDED from `gate1_scorecard`/`calibration`. **Honest
caveat (§12):** the coach can only judge from the given context, so Accuracy is harsh on
the operational knowledge agents carry but don't write down — read the score as "where to
look" (vague / non-answer / undocumented solution), NOT as a grade of the agent, and never
rank agents by it. One QA call per ticket → scalable to the ~50k backlog; start small.

**Coach mode — REPLY_READY / COACH_AGENT / AGENT_ACTION_REQUIRED (Fas 3.1, 2026-07-24).**
Every suggestion now carries an explicit three-way `coach_mode` (migration 26). It is
**derived in code** (`deriveCoachMode` in `render.ts`) from the already-resolved pipeline
signals — confidence + `answer_strategy` + `requires_manual_system_check` +
`sensitive_action_request` + reply-presence — NOT trusted from the model, so it can never
disagree with the verify gates and needs **no prompt change** (PROMPT_VERSION unchanged →
golden set stays comparable; same "code decides" stance as the QA validator). 🔴
AGENT_ACTION_REQUIRED = the agent must check the system / verify identity / open an
attachment / escalate before anything is sent (renderNote shows a red banner + no
send-ready framing); 🟢 REPLY_READY = a grounded, high-confidence, send-ready reply; 🟡
COACH_AGENT = useful guidance but not send-ready (e.g. a routing message or a low-confidence
draft). The §3.3 guardrails (attachment / roles / deletion / legal / broken-promise) were
**already** in `prompts.ts` before Fas 3 — this makes the resulting decision an explicit,
measurable label. Measure it with `coach_mode_scorecard` (verdict distribution per mode): if
REPLY_READY isn't clearly more "usable" than COACH_AGENT, the gate is miscalibrated. Shown as
a coloured tag in the review app.

**Locked cohorts — learning / development / holdout (2026-07-24).** First scaling-plan
item built (Fas 2.1, `docs/coach-scaling-plan.md`): `ticket_cohorts` (migration 25) is a
**per-ticket, versioned, locked** split into `learning` / `development` / `holdout`, so the
eval set can't leak into training. `scripts/assign_cohorts.ts` (`deno task assign-cohorts`,
also a `batch-jobs.yml` job) assigns by a **deterministic hash** of the ticket id
(default 40/20/40, decorrelated from the sequential id) and is **idempotent + never moves**
an already-assigned ticket — the holdout stays put. Enforcement so far: `loadGoldExemplars`
(the learning loop) **excludes gold answers on holdout tickets**, so the locked test set is
never fed back as a few-shot exemplar. Read holdout numbers on their own via
`gate1_scorecard_by_cohort` / `cohort_summary`. `ticket_cohorts` was RLS deny-all to
clients; migration 27 now lets **allowlisted reviewers READ** it (for the holdout
progress/filter in the review app) — writes stay service-role only, and the leakage risk
(holdout gold → generation exemplar) is server-side and unaffected. Assign cohorts BEFORE
writing gold answers so the split is clean from the start. Not yet done: a replay filter to run only one cohort
(follow-up); the reporting view already separates them.

**Knowledge-gap detection (Fas 4.4, 2026-07-24).** First §4 (knowledge/incident layer)
item: surface WHERE knowledge is missing — the Gate 1 root cause was undocumented
operational/product knowledge. `knowledge_gap_tickets` (migration 28) flags every
suggestion the pipeline could NOT ground (confidence none/low or ABSTAIN), with a
`gap_type` (`no_kb_source` = KB had nothing · `weak_grounding` = sources found but didn't
fit); it excludes spam/agent-scan **and** auto-reply/absence subjects (those are low-conf
because they aren't real questions, not KB gaps). `knowledge_gaps` ranks the topics by
frequency with recent example ids/subjects — the weekly "what to write" list. Read it via
`deno task knowledge-gaps` (also a `batch-jobs.yml` job, Supabase-only) or SQL. Derived
entirely from existing pipeline output — **no prompt change**, so the golden set / holdout
baseline are untouched. Deferred in §4: richer incident model (4.2) and active incident
detection (4.3, partly blocked by Freshdesk's no-free-text-search); source hierarchy (4.1)
already largely lives in `prompts.ts`.

**Narrowed to KB-covered how-to + explicit tone rules (2026-08-03, `g1-2026-08-03a`).**
Per Tobias, after the confidence analysis: broad accuracy is capped (strict usable
40.7 %, n=54 → 95 % CI ≈ [28 %, 54 %], straddling the 50 % gate; and 4 of the first
15 judged 🟢 REPLY_READY notes were unusable). Rather than tune prompts against a
knowledge gap, the target narrows to **the band the AI can own: how-to questions
the KB actually covers** — plus a tone contract.

- **Grounding is now cross-checked in code.** The draft call reports `grounded_in`
  (kb | playbook | ticket | none) and `source_refs`; `verifyGroundingRefs`
  (`pipeline.ts`) requires every cited ref to resolve to a source we actually
  supplied or to a matched playbook entry by position (`P2`). `deriveCoachMode`
  then demands that verification before an **asserting** strategy (DIRECT_ANSWER /
  PROVIDE_KNOWLEDGE_BASE_INSTRUCTIONS) can be REPLY_READY. An **asking** strategy
  (clarify / request a detail) asserts no product fact and stays eligible without a
  source. Same stance as the QA validator: the model proposes, TypeScript decides —
  a draft can no longer talk itself into the green band over an empty source list.
- **Tone contract:** friendly, professional, clear, solution-oriented — and
  **at most ONE apology per reply** (specific, near the start, only when we
  genuinely failed; none at all when we did not). `countApologies` flags a repeat
  offender in the note; it deliberately does **not** lower confidence, because a
  tone signal must not move the grounding metric this version exists to sharpen.
- **Measure it with `kb_howto_scorecard`** (usable-% on how-to + verified
  grounding) **read beside `kb_howto_coverage`** — a usable-% that rose while
  `grounded_pct` fell means the gate got stricter, not the answers better.
  `grounding_claim_audit` shows where the model's self-reported grounding failed
  the cross-check. Migration 39.
- **Open question the live data raised:** is `howto` the right population? Judged
  verdicts by type today — question 29 judged / 58.6 % usable, howto 8 judged /
  25 % usable but **zero unusable**, bug 30 judged / 26.7 % usable. So how-to is the
  *safe* band, not the strongest strict band, and at 13 generations it is thin;
  `question` scores better strictly. `grounded_scorecard_by_type` keeps that
  comparison live so widening to question+howto is decided on the new version's
  data, not the old mixed baseline. **Do not widen it silently.**
- PROMPT_VERSION bumped → the golden set must be **re-replayed** before comparing
  against `g1-2026-07-29a`; historical rows have `grounding_verified` NULL and are
  deliberately not back-filled.

**Tickets → KB articles: closing the knowledge loop (2026-08-03, `g1-2026-08-03b`).**
Per Tobias: the AI should also judge whether a ticket is worth turning into an
article, and the agent should be able to say "yes, write it" and have it saved.
This attacks the Gate 1 root cause directly — the gap was never the model, it was
operational knowledge nobody wrote down (§12 coach pivot). The flow, and who
decides what:

1. the pipeline **flags** a ticket whose answer would generalise
   (`article_opportunity` on the draft call → shown in the private note);
2. a **reviewer** asks for it in the Coach Review app (`request_kb_article`);
3. `deno task write-articles` **drafts** it (`articlePrompt` / `draftKbArticle`);
4. the **reviewer** edits and approves it (`review_kb_article`).

Steps 2 and 4 are human. The AI proposes and drafts; it never decides that
something becomes knowledge.

- **The safeguard that matters:** an article is only ever generalised from a
  resolution a HUMAN stood behind — a reviewer's `gold_answer`, or the reply the
  agent actually sent (`agent_sent_reply`) — **never** from the AI's own draft.
  `article_write_queue` enforces this: a request without such a resolution simply
  waits. An article outlives a reply, so encoding a guess would reproduce the
  Gate 1 failure at scale.
- The writer must **generalise, not transcribe**: every customer-specific detail
  is stripped and listed in `removed_specifics` (an article that silently kept a
  customer name is a data-protection problem, not a style one). It may answer
  `publishable=false` — "this cannot be written correctly" is a good outcome, and
  code holds it to that (no title / no body ⇒ not publishable, whatever it claims).
- **Versioned separately** (`ARTICLE_VERSION`) and kept OUT of the
  analyse→draft→verify pipeline, same modular stance as the QA coach — editing
  article wording must not force a golden-set re-run.
- **DELIBERATELY NOT DONE — publishing to Freshdesk.** Approved articles are
  stored in `approved_articles` for a human to paste into the help centre. Writing
  to Freshdesk's solutions API would be a **third external write** and would widen
  the security review that §3 keeps narrow (today: the private note + ≤3 tags).
  That is a decision to take explicitly, not a side effect. Ask before building it.
- Measure with `article_funnel` (AI proposals → human requests → approvals). A low
  approve-rate means the `article_opportunity` rules in `prompts.ts` are too loose —
  tighten them rather than asking agents to filter. Migration 40.
- PROMPT_VERSION bumped to `g1-2026-08-03b` (the draft call gained a field). Free
  at the time: nothing had been replayed on `…03a` yet.

**The customer knowledge base is a named source (2026-08-04).** Per Tobias:
`https://simployer.freshdesk.com/en/support/home` — Simployer's Freshdesk help
centre — is **the** knowledge base customers read, and it is the same corpus
`searchSolutions` (`/search/solutions`) already retrieves from. It was implicit
inside a search call; it is now named, because a source the pipeline grounds on
should be findable in the code by its own name.

- **Two URLs per article, not interchangeable.** `Freshdesk.articleUrl()` →
  `/a/solutions/articles/{id}` is the AGENT view behind the login (right for a
  private note). `Freshdesk.portalArticleUrl()` → `/{locale}/support/solutions/
  articles/{id}` is the CUSTOMER view — the link an agent can actually paste into
  a reply. Notes now carry both ("send to customer"), because converting one into
  the other by hand is the small friction that stops links being sent at all.
- **Verification status, honestly:** the portal base is confirmed (given by the
  team). The article path follows Freshdesk's portal convention and is **not** yet
  confirmed against a live article — an anonymous fetch of the help centre returns
  **HTTP 403**, so it could not be checked from here. `deno task verify-api`
  probes it, and the pattern is overridable. Shipping a guessed customer-facing
  link into a reply would be worse than admitting it is unverified.
- **It closes the article loop.** `write_kb` follow-through now prefers
  "published to the customer KB" over "article requested" — requesting an article
  is an intention, publishing it is the outcome, and a request that never gets
  published is exactly the failure worth seeing (`coaching.ts`).
- **Confluence is NOT this.** The Atlassian wiki is an internal engineering space
  (Deviation, DevOps Chapter, QA Chapter, Sysadmin…); there is no customer-facing
  space on it. Anything measuring "did we document this for customers" must look
  at the Freshdesk help centre, not Confluence.

**P0 reliability hardening (2026-07-28).** A technical review found three risks
that outrank further prompt work: mutable evaluation rows, duplicate Freshdesk
notes after an uncertain POST/database failure, and missed tickets from the old
five-minute non-paginated window. The runtime contract is now:

- A generation is immutable and unique on `(ticket_id, trigger_message_id,
  prompt_version, model, run_variant)`. Replay uses INSERT and never overwrites a
  judged generation. Human assessments are canonical in `suggestion_reviews`,
  keyed to the immutable generation id; legacy review columns on `suggestions`
  are a compatibility read projection maintained by narrow review RPCs.
- Live delivery is an outbox state machine: `reserved → generated → posting →
  posted` (`failed` is visible and resumable). The exact note HTML is stored
  before Freshdesk is called. `POST /notes` has **zero automatic retries**. Each
  note includes `simployer-ai-generation:<id>`; recovery checks existing private
  notes for that marker before any POST, covering accepted POST + lost response.
- Polling keeps a durable `(updated_at, ticket_id)` cursor, paginates every
  Freshdesk page, transactionally enqueues monitored events before advancing the
  cursor, and uses a database lease to prevent overlapping minute runs. The
  responder is still re-checked on the freshly loaded ticket before reservation.
- New notes route verdicts to the authenticated/RLS-gated Coach Review app. They
  carry a safe generation deep-link, not a feedback token or verdict in a GET
  URL. Legacy feedback GETs show confirmation only; the POST consumes a
  generation-scoped token once.
- GitHub batch jobs set `CLOUD_LOG_MODE=safe`: no ticket subject, customer/agent
  text, draft, or source excerpt reaches Actions logs/Summary. Replay previews
  IDs/subjects and exits before OpenAI unless `REPLAY_APPROVED=true`.

Migration: `31_p0_reliability.sql`. Operational gates: `GOLIVE.md`. Supporting
source-of-truth docs: `docs/ARCHITECTURE.md`, `SECURITY.md`, `EVALUATION.md`,
`OPERATIONS.md`, and `DECISIONS.md`. Keep `DRY_RUN=true` and cron paused until the
migration, synthetic marker-recovery test, key rotation, and supervised dry-run
are confirmed.

---

**Freshworks CRM subscription context — a FOURTH system (2026-07-30).** Approved by
Tobias (PR #34): the pipeline may enrich the private note with the customer's
**verified subscriptions** from Freshworks CRM — `Product name`, `Renewal status`,
`End date`, nothing else. This deliberately amends §3's "three systems total":
Freshworks CRM is a fourth system, but **read-only** (GET only, separate API key,
`FRESHWORKS_CRM_*` env; §3's "only writes" list is unchanged). Guardrails, all
enforced in `freshworks-crm.ts`/`pipeline.ts`: CRM data is rendered into the note
and stored in `suggestions.customer_subscriptions` but **never enters any LLM
prompt**; lookups **abstain on ambiguity** (never guess between multiple matching
accounts); every failure is contained (`unavailable`) so a CRM outage can never
suppress the required note; response bodies are kept out of errors/logs. Account
resolution (2026-07-30, superseding the unpushed Codex commit 2593078) is a
**matching ladder on the initial (brand) name** — in practice the keys we hold
(email domain, Freshdesk company name) rarely equal the CRM account name
verbatim ("acme.se" / "Acme" vs "Acme Sverige AB"): (1) requester **contact
email**, exact; (2) the ticket's **Freshdesk company name** — stem equality
(case/diacritics folded, trailing legal suffixes AB/AS/Oy/… stripped), then
word-boundary prefix; (3) the requester's **email domain** — CRM website-domain
equality, then name-stem relation; freemail domains never resolve. Every tier
still requires exactly ONE account. **Several similar accounts → status
`ambiguous`**, rendered as an explicit "check the CRM manually" warning for the
agent (per Tobias: ambiguity must prompt a manual check, never look like "no
match" and never be guessed away). `matchedBy` records which tier matched; the
weak tiers (name prefix, email domain) carry a verify nudge in the note, and an
`ambiguous` result lists up to three candidate account names. Feature is opt-in
via `FRESHWORKS_CRM_ENABLED`; the replay harness never constructs the CRM
client, so evaluation runs are unaffected.

**Freshworks API facts — VERIFIED live 2026-07-31 (they invalidated two
assumptions).** A cron-secret-guarded probe against known-good records settled
§7's open question and explained why every early run returned `no_match`:
- `/lookup?f=email&entities=contact` finds the contact but its row carries **NO
  account link at all** (no `company`, no `sales_accounts`). The link exists
  only on `/contacts/{id}?include=sales_accounts` → `contact.sales_accounts[]`
  with `is_primary`. Tier 1 therefore **chains** lookup → detail, and prefers
  the primary account (what the CRM UI shows as "Account").
- `/lookup?f=name&entities=sales_account` matches only (near-)**FULL** names — a
  brand stem returns zero rows — so it could never feed the name/domain tiers.
  **`/search?q=<term>&include=sales_account`** does partial matching and is what
  those tiers now use; it answers with a **flat array** of
  `{id: "<string>", name, website, type}`. A broad stem returned exactly **10**
  rows, so the truncation guard (10) is calibrated, not guessed.
- Real data confirms the ambiguity design: "STUDENTSAMSKIPNADEN I STAVANGER"
  exists **twice** in the CRM (one with website `minsis.no`, one without), and
  the fixed client correctly returns `ambiguous` with the candidate name rather
  than picking one.
- **Open:** intermittent **HTTP 403** on `/lookup` appeared during probing and
  persisted for a solo call, while `/search` kept working. Most likely a rate or
  scope limit; it is contained (a throw becomes `unavailable`, the note still
  posts) but it means contact-tier coverage may be lower than designed. Worth a
  look before reading `crm_match_scorecard` as ground truth. The probe endpoint
  itself was retired after use; `scripts/probe_crm_lookup.ts` can re-run it.

Above the ladder sits **`crm_account_map`** (migration 35) — the deterministic
"curate once, resolve forever" layer, same philosophy as `known_incidents`: a
row maps a Freshdesk `company_id` or customer email domain to ONE verified CRM
account (`matchedBy: account_map`). `human` rows are curated and always win;
`learned_contact_email` rows are written automatically ONLY from the ladder's
strongest tier (exact contact-email match), and **conflicting evidence
deactivates a learned row — never overwrites it** (runtime falls back to the
ladder; the conflict stays visible). Freemail domains are never a key. RLS
deny-all (service-role only). Measure the whole thing with `crm_match_scorecard`
(migration 34: weekly hit-rate per tier + no_match/ambiguous/unavailable) before
tuning matching any further.

## 13. Repeatable workflows — Claude skills & `tools/`

Recurring workflows are packaged as **project skills** under `.claude/skills/`
(each a folder with a `SKILL.md`). Reach for these instead of redoing the steps
by hand:

| Skill | Use it when |
|---|---|
| `gate1-scorecard` | Reporting the "would I have sent this?" usable-% and calibration (uses the evaluation views; never invent numbers). |
| `incident-playbook` | Adding or verifying/tightening a `known_incidents` row — the playbook outranks generic KB, so precision matters. |
| `sync-past-tickets` | Running `deno task sync-tickets` and reporting how fresh the `past_tickets` index is (it does not auto-update). |
| `shareable-docs` | Generating a Word / PowerPoint / HTML one-pager or deck from the status or roadmap. |

**Document generators live in `tools/`** (see `tools/README.md`). They are the only
Node code in the repo (the product is Deno); `docx`/`pptxgenjs` are Node-only, so
they are isolated there and never imported by the pipeline. Design:
**data vs presentation** — the content is data in `tools/content/*.js`, the renderer
is `tools/render.js` (`renderDocx` / `renderPptx` / `renderHtml`). One spec renders
to all three formats; the HTML is Artifact-friendly. Add a document by adding a
content file, never by copying the renderer.

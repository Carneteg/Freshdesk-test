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
only warns). For Gate 1 there is still exactly **one** monitored agent
(`EXPECTED_AGENT_NAME`, default **Tobias Carneteg**); notes are authored by the
service account, which is fine since notes are private/internal.

**LLM provider — OpenAI (2026-07-22).** Per Tobias the Anthropic key is
unavailable, so the three reasoning calls (analyse → draft → verify) now run on
**OpenAI** (`OPENAI_API_KEY`, `OPENAI_MODEL` default `gpt-4o`). The provider is
isolated in the `LLM` class in `clients.ts`; prompts and pipeline are unchanged,
so switching back is a one-file change. Historical "Claude"/"Anthropic" mentions
elsewhere in this doc describe the same pipeline — read them as "the LLM provider".

**DPA — Anthropic clearance does NOT cover OpenAI (re-opened 2026-07-22).** Per
Tobias (2026-07-21) the DPA position on *Anthropic* and Supabase was confirmed OK.
The provider is now **OpenAI** — a different processor — so that clearance no
longer applies to the reasoning calls. Per §11 (non-negotiable), sending real
ticket PII to OpenAI — **including via the replay harness** — requires the DPA
position on **OpenAI** to be confirmed first. Until then: synthetic data, or
tickets with no personal data. Flag at run time; do not proceed silently.

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

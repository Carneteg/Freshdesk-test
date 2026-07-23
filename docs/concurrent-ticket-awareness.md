# Design note — real-time concurrent-ticket awareness (Gate 2 lever)

**Status:** proposed, not built. Interim in place (curated incidents). Owner: TBD.

## Problem

The coach lacks the agent's live operational context. In replay #85703 Johanna
wrote *"I just got another ticket with the exact same problem"* and correctly
treated it as an emerging shared incident. The AI can't know this: it sees only
the one ticket, the KB, and resolved-ticket precedent — not what is happening
*right now* across the queue. This is the single biggest remaining gap to human
parity, and it is not a prompt tweak.

## Goal

Surface to the draft step a time-filtered signal:

> "N similar tickets in the last D days (ids …) — possible shared / emerging incident."

so the coach can suggest the agent verify and flag it, rather than diagnosing the
ticket in isolation. Read-only; the only external writes remain the private note
and the ≤3 tags (§3). No leakage: in replay, only tickets that existed *before*
the graded reply may be counted (same rule as the past-ticket index).

## Why it isn't quick

- The `past_tickets` index holds **resolved** tickets only (populated by
  `scripts/sync_tickets.ts`).
- Freshdesk content search returns HTTP 400 on free text (the constraint that
  forced the embedding index in the first place) — so "other open tickets about
  X" cannot be queried live from Freshdesk.
- Therefore we must **index open/recent tickets ourselves** and retrieve by
  embedding similarity, exactly as we do for resolved ones.

## Proposed build

1. **Index recent tickets (all statuses).** Either add a `status` + `updated_at`
   column usage to `past_tickets`, or a sibling `recent_tickets` table
   (`ticket_id`, `subject`, `question`, `status`, `created_at`, `updated_at`,
   `embedding vector(1536)`, `synced_at`). Keep a rolling window (e.g. last 30
   days) to bound size.
2. **Sync job.** Extend `sync_tickets.ts` (or a new `sync_recent.ts`) to pull
   tickets updated in the last D days regardless of status, embed
   `subject + question`, upsert. Cadence: frequent enough to be "real-time"
   (e.g. every few minutes alongside the poll, or its own cron).
3. **Retrieval step.** `retrieveSimilarRecent(deps, queryText, beforeTs)`:
   embed the current question, call a `match_recent_tickets` RPC (cosine
   similarity) filtered to `created_at < beforeTs` (temporal, replay-safe — reuse
   the migration 13 pattern) and within the rolling window. Return the matches +
   a count.
4. **Surface to the draft.** Add a `CONCURRENT SIGNAL` block to `draftPrompt`
   (like the playbook/sources blocks): "M similar tickets in the last D days
   (ids …)". New prompt rule: treat a cluster of similar recent tickets as a
   *signal* of a possible shared/emerging incident — suggest the agent verify and
   flag it to the team; do **not** invent an incident or assert a shared cause,
   just surface the pattern for a human to judge.

## No-leakage & security

- Replay passes `beforeTs` = the graded turn's timestamp; the live poller passes
  none (all current). Same discipline as `retrievalBefore` today.
- Still read-only on tickets. The change increases the volume of ticket PII held
  in Supabase and sent to OpenAI for embeddings — already DPA-cleared for the
  current provider (§11/§12), but the larger, continuously-refreshed corpus is
  worth a line in the security review.

## Interim (already available)

The curated `known_incidents` playbook **is** the "active incidents" channel.
When the team notices concurrent reports, flag/add the incident (status
`investigating`, `affected` note "multiple concurrent reports, w/c <date>") and
the coach cites it. This covers *known* active incidents; it does not
auto-detect a brand-new spike — which is precisely what the build above adds.

## Rough effort

~1 day: table + migration, sync extension, RPC + retrieval step, prompt block,
a replay check. Isolated from the existing pipeline (additive retrieval source).

## Open questions

- Sync cadence vs "real-time enough" — how stale is acceptable?
- Similarity threshold and max surfaced count (avoid noise from coincidental
  overlap).
- How to phrase "emerging incident" so the coach flags without asserting a shared
  cause it hasn't verified.

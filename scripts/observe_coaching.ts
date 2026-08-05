// scripts/observe_coaching.ts — the read-only reconciliation behind the Coaching tab.
//
//   deno task observe-coaching              # dry run: report, write nothing
//   COACHING_APPLY=true deno task observe-coaching
//   COACHING_LIMIT=50 COACHING_APPLY=true deno task observe-coaching
//
// It answers two questions the project cannot currently answer:
//   1. did the note arrive BEFORE the agent started writing?
//   2. was the recommended next step actually followed?
//
// THREE THINGS THIS DOES NOT DO, by construction:
//
//   • It never writes to an external system. Freshdesk is reached only through
//     `ReadOnlyFreshdesk`, which does not expose postPrivateNote or setTags —
//     asserted in coaching_test.ts, not just promised here.
//   • It is not scheduled. There is no pg_cron object for it and this change adds
//     none. A job ran outside its window on 30 July and posted 14 live notes;
//     enabling a schedule is now an explicit decision.
//   • It never asks an agent whether they followed the advice. Follow-through is
//     OBSERVED. A self-report button is an extra task and would stop being used.
//
// Idempotent: every write is an upsert on a natural key, so re-running reconciles
// rather than duplicates.

import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import { Freshdesk, HttpError } from "../supabase/functions/ticket-suggester/clients.ts";
import { ReadOnlyFreshdesk, assertReadOnly } from "../supabase/functions/ticket-suggester/readonly-clients.ts";
import {
  describeConnections,
  isConnected,
  NOT_CONNECTED_REASON,
} from "../supabase/functions/ticket-suggester/connections.ts";
import { ReadOnlyAtlassian } from "../supabase/functions/ticket-suggester/atlassian.ts";
import {
  classifyNextStep,
  deriveDeliveryStatus,
  evaluateObservation,
  extractTargetRef,
  firstAgentReplyAt,
  INTERNAL_CHECK_BUDGET,
  type ObservationEvidence,
  STEP_SIGNAL,
  stepObservable,
  type StepType,
  unobservableShare,
} from "../supabase/functions/ticket-suggester/coaching.ts";

function env(name: string): string {
  const v = Deno.env.get(name) ?? "";
  if (!v) {
    console.error(`missing required env var: ${name}`);
    Deno.exit(1);
  }
  return v;
}

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const apply = (Deno.env.get("COACHING_APPLY") ?? "").toLowerCase() === "true";
const limit = Number(Deno.env.get("COACHING_LIMIT") ?? "200");
// Batch jobs must not leak ticket text into Actions logs (CLAUDE.md §5 / P0).
const safeLog = (Deno.env.get("CLOUD_LOG_MODE") ?? "").toLowerCase() === "safe";

const fd = new ReadOnlyFreshdesk(
  new Freshdesk(env("FRESHDESK_DOMAIN"), env("FRESHDESK_API_KEY")),
);
// Belt and braces: if someone swaps in a raw client, fail here rather than run.
assertReadOnly(fd, "coaching ticket source");

// Jira is optional: constructed only when its credentials are all present, so a
// deployment without them observes fewer signals rather than crashing. The tab
// renders those as "not connected", which is the honest reading.
const jira = isConnected("jira")
  ? new ReadOnlyAtlassian(
    Deno.env.get("ATLASSIAN_SITE")!,
    Deno.env.get("ATLASSIAN_EMAIL")!,
    Deno.env.get("ATLASSIAN_API_TOKEN")!,
  )
  : null;
if (jira) assertReadOnly(jira, "jira");
const freshdeskDomain = env("FRESHDESK_DOMAIN");

// ── 1. Classify the recommended steps ────────────────────────────────────────

const { data: gens, error: genErr } = await db
  .from("suggestions")
  .select("id, ticket_id, resolution_steps, posted_at, posting_started_at, created_at, note_id")
  .is("error", null)
  .neq("prompt_version", "agent-scan")
  .eq("is_spam", false)
  .order("created_at", { ascending: false })
  .limit(limit);

if (genErr) {
  console.error(`failed to read suggestions: ${genErr.message}`);
  Deno.exit(1);
}

const generations = gens ?? [];
const stepRows: Array<{
  suggestion_id: number;
  ticket_id: number;
  step_index: number;
  step_type: StepType;
  step_text: string;
  target_ref: string | null;
}> = [];

for (const g of generations) {
  const steps: string[] = Array.isArray(g.resolution_steps) ? g.resolution_steps : [];
  steps.forEach((text, i) => {
    if (typeof text !== "string" || !text.trim()) return;
    stepRows.push({
      suggestion_id: g.id,
      ticket_id: g.ticket_id,
      step_index: i,
      step_type: classifyNextStep(text),
      step_text: text,
      target_ref: extractTargetRef(text),
    });
  });
}

function notConnectedReason(type: StepType): string {
  const sys = STEP_SIGNAL[type].system;
  return sys ? NOT_CONNECTED_REASON[sys] : STEP_SIGNAL[type].note;
}

const mix = new Map<StepType, number>();
for (const r of stepRows) mix.set(r.step_type, (mix.get(r.step_type) ?? 0) + 1);
const blindShare = unobservableShare(stepRows.map((r) => r.step_type));

console.log(describeConnections() + "\n");
console.log(`${generations.length} generation(s) scanned · ${stepRows.length} recommended step(s)\n`);
console.log("Step type mix:");
for (const [type, n] of [...mix.entries()].sort((a, b) => b[1] - a[1])) {
  const sig = STEP_SIGNAL[type];
  const on = stepObservable(type);
  const pct = ((n / stepRows.length) * 100).toFixed(1);
  console.log(
    `  ${type.padEnd(15)} ${String(n).padStart(4)}  ${pct.padStart(5)}%  ` +
      `${on ? "observable via " + sig.label : "NOT OBSERVABLE — " + notConnectedReason(type)}`,
  );
}
console.log(
  `\nUnobservable share: ${(blindShare * 100).toFixed(1)}% ` +
    `(budget ${(INTERNAL_CHECK_BUDGET * 100).toFixed(0)}%)` +
    (blindShare > INTERNAL_CHECK_BUDGET
      ? "  ⚠️  OVER BUDGET — the prompt is producing advice that cannot be evaluated"
      : "  ok"),
);

if (!apply) {
  console.log(
    "\nDry run — nothing written. Re-run with COACHING_APPLY=true to store steps,\n" +
      "delivery timing and observations. Every external call is a read either way.",
  );
  Deno.exit(0);
}

// Upsert on (suggestion_id, step_index) — re-running reconciles, never duplicates.
if (stepRows.length) {
  const { error } = await db
    .from("suggestion_next_steps")
    .upsert(stepRows, { onConflict: "suggestion_id,step_index" });
  if (error) {
    console.error(`failed to store next steps: ${error.message}`);
    Deno.exit(1);
  }
}
console.log(`\nStored ${stepRows.length} step(s).`);

// ── 2. Delivery timing + observation, per ticket ─────────────────────────────
//
// One Freshdesk read per ticket serves both: the conversation list gives the
// first public agent reply, and the ticket gives the current group.

const { data: stored } = await db
  .from("suggestion_next_steps")
  .select("id, suggestion_id, ticket_id, step_type");
const storedSteps = stored ?? [];

// Which tickets already had a KB article requested — our own connected signal.
const { data: articles } = await db
  .from("article_drafts")
  .select("ticket_id, title, status");
const kbTickets = new Set((articles ?? []).map((a) => a.ticket_id));
// Approved articles, so we can ask the CUSTOMER knowledge base whether each one
// actually got published. Requesting an article is an intention; publishing it
// is the outcome, and the gap between them is worth seeing.
const approvedArticles = (articles ?? []).filter((a) => a.status === "approved" && a.title);

// Group id -> name, read once. Turns a ticket's group_id into the route_expert
// and escalate signals without a lookup per ticket.
const groupNames = new Map<number, string>();
try {
  for (const g of await fd.groups()) {
    if (g.name) groupNames.set(g.id, g.name);
  }
} catch {
  console.error("  could not read Freshdesk groups — routing signals stay unobserved");
}

// Did an approved article reach the help centre? One KB search per approved
// article, matched on title.
const publishedTickets = new Set<number>();
for (const a of approvedArticles) {
  try {
    const hits = await fd.searchSolutions(String(a.title).slice(0, 60));
    const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
    if (hits.some((h) => h.title && norm(h.title) === norm(String(a.title)))) {
      publishedTickets.add(a.ticket_id);
    }
  } catch {
    // A KB search failure leaves the article "requested but unconfirmed", which
    // is the correct weaker reading rather than a false negative.
  }
}

const byTicket = new Map<number, typeof generations>();
for (const g of generations) {
  const list = byTicket.get(g.ticket_id) ?? [];
  list.push(g);
  byTicket.set(g.ticket_id, list);
}

let deliveryWrites = 0, obsWrites = 0, readFailures = 0, late = 0;

for (const [ticketId, gensForTicket] of byTicket) {
  let ticket;
  try {
    ticket = await fd.ticketWithConversations(ticketId);
  } catch (e) {
    // Rate limits and intermittent 403s are expected (the CRM has returned them).
    // Back off, log, keep going — one bad ticket must not kill the batch.
    readFailures++;
    const status = e instanceof HttpError ? e.status : 0;
    console.error(`  #${ticketId}: read failed${status ? ` (HTTP ${status})` : ""} — skipped`);
    if (status === 429 || status === 403) await new Promise((r) => setTimeout(r, 2000));
    continue;
  }

  const replyAt = firstAgentReplyAt(ticket);

  for (const g of gensForTicket) {
    // A generation that never ATTEMPTED delivery has no delivery to judge, and
    // must not be counted as a late one. Replay and dry-run runs never post by
    // design, so scoring them against the agent's reply time asks "did this note
    // arrive in time" of a note that was never sent — it answered "no" every
    // time and put 77 phantom failures into the late rate.
    //
    // Attempted means posted_at (it went out) or posting_started_at (it was
    // reserved for posting and may have failed). A live note that genuinely
    // failed to post IS a delivery failure and still counts.
    const attempted = g.posted_at != null || g.posting_started_at != null;
    if (!attempted) continue;

    // posted_at is when we actually posted it.
    const noteAt = g.posted_at ?? null;
    const status = noteAt || replyAt ? deriveDeliveryStatus(noteAt, replyAt) : "no_reply_yet";
    if (status === "late") late++;
    const { error } = await db.from("suggestion_delivery").upsert({
      suggestion_id: g.id,
      ticket_id: ticketId,
      note_created_at: noteAt,
      first_agent_reply_at: replyAt,
      delivery_status: status,
      checked_at: new Date().toISOString(),
    }, { onConflict: "suggestion_id" });
    if (!error) deliveryWrites++;
  }

  // Evidence for this ticket, gathered read-only from the systems that ARE
  // connected. Anything unreachable stays undefined, which evaluateObservation
  // reports as "cannot see" — never as "the agent did not do it".
  let jiraLinked: boolean | undefined;
  if (jira) {
    try {
      const issues = await jira.issuesForTicket(ticketId, freshdeskDomain);
      jiraLinked = issues.length > 0;
    } catch {
      // Leave undefined: unknown, not "no".
    }
  }

  const groupName = ticket.group_id != null
    ? (groupNames.get(ticket.group_id) ?? null)
    : null;

  const evidence: ObservationEvidence = {
    groupName,
    // "Escalated" reads as the ticket having left the first line. Without a
    // recorded group at generation time this is the closest honest proxy, and it
    // is deliberately conservative: unknown group => not observed.
    groupChanged: groupName ? !/first[ -]?line|1st[ -]?line/i.test(groupName) : undefined,
    kbArticleRequested: kbTickets.has(ticketId),
    kbArticlePublished: publishedTickets.has(ticketId),
    jiraIssueLinked: jiraLinked,
  };

  const stepsHere = storedSteps.filter((s) => s.ticket_id === ticketId);
  for (const step of stepsHere) {
    const o = evaluateObservation(step.step_type as StepType, evidence);
    const { error } = await db.from("next_step_observations").upsert({
      next_step_id: step.id,
      observed: o.observed,
      observable: o.observable,
      observed_at: o.observed ? new Date().toISOString() : null,
      observed_via: o.observedVia,
      checked_at: new Date().toISOString(),
    }, { onConflict: "next_step_id" });
    if (!error) obsWrites++;
  }
}

console.log(
  `\n${deliveryWrites} delivery row(s), ${obsWrites} observation(s) written.\n` +
    `${late} note(s) landed after the first agent reply.` +
    (readFailures ? `  ${readFailures} ticket read(s) failed and were skipped.` : ""),
);
if (!safeLog) {
  console.log(
    "\nNothing was written to Freshdesk or any other external system, and no\n" +
      "scheduler was created or changed.",
  );
}

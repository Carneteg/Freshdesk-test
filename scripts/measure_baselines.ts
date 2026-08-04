// scripts/measure_baselines.ts — lock the coaching baselines, measured on the
// population the AI actually coaches.
//
//   deno task measure-baselines              # dry run: print, write nothing
//   BASELINE_APPLY=true deno task measure-baselines
//   BASELINE_COUNT=300 BASELINE_APPLY=true deno task measure-baselines
//
// WHY THIS REPLACED THE INTERCOM BASELINES
//
// The first four baselines came from Intercom and reproduced exactly against
// that API — 2209 conversations, 243 reopened, 775 slow first replies. They were
// still the wrong numbers. Intercom is a different support channel: the pipeline
// watches Freshdesk, those conversations arrive through onesupport.simployer.com,
// and no record links the two. Measuring coaching on Freshdesk tickets against
// an Intercom population compares two different things and calls the difference
// a result.
//
// So these are measured on the coached tickets themselves. A baseline is only
// worth having if the thing you later compare against it is the same population.
//
// READ-ONLY. Freshdesk is reached through ReadOnlyFreshdesk, which exposes no
// write method. The only writes go to `coaching_baselines` and
// `coaching_reply_distribution` in Supabase.
//
// LOCKED, not live. Baselines are computed deliberately and stamped with the
// date and sample size. They are never recomputed on page load — a baseline that
// moves is not a baseline, it is just another live metric.

import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import { Freshdesk, HttpError } from "../supabase/functions/ticket-suggester/clients.ts";
import {
  assertReadOnly,
  ReadOnlyFreshdesk,
} from "../supabase/functions/ticket-suggester/readonly-clients.ts";
import {
  median,
  replyBucket,
  REPLY_BUCKETS,
  ticketMetrics,
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
const fd = new ReadOnlyFreshdesk(
  new Freshdesk(env("FRESHDESK_DOMAIN"), env("FRESHDESK_API_KEY")),
);
assertReadOnly(fd, "baseline ticket source");

const apply = (Deno.env.get("BASELINE_APPLY") ?? "").toLowerCase() === "true";
const want = Number(Deno.env.get("BASELINE_COUNT") ?? "200");

// The coached population: tickets this pipeline has actually produced a
// suggestion for. Deliberately not "all Freshdesk tickets" — the baseline has to
// describe the same tickets the coaching is later judged on.
const { data: rows, error } = await db
  .from("suggestions")
  .select("ticket_id")
  .is("error", null)
  .neq("prompt_version", "agent-scan")
  .eq("is_spam", false)
  .order("created_at", { ascending: false })
  .limit(want * 2);

if (error) {
  console.error(`failed to read suggestions: ${error.message}`);
  Deno.exit(1);
}

const ticketIds = [...new Set((rows ?? []).map((r) => r.ticket_id))].slice(0, want);
if (!ticketIds.length) {
  console.log("No coached tickets found — nothing to measure.");
  Deno.exit(0);
}

console.log(`Measuring baselines over ${ticketIds.length} coached ticket(s)…\n`);

const firstReply: number[] = [];
const replies: number[] = [];
const spans: number[] = [];
let returned = 0, measured = 0, failures = 0;
const buckets = new Map<string, number>();

for (const id of ticketIds) {
  try {
    const ticket = await fd.ticketWithConversations(id);
    const m = ticketMetrics(ticket as never);
    measured++;
    if (m.firstReplySeconds != null) {
      firstReply.push(m.firstReplySeconds);
      const b = replyBucket(m.firstReplySeconds);
      buckets.set(b, (buckets.get(b) ?? 0) + 1);
    }
    if (m.agentReplies > 0) replies.push(m.agentReplies);
    if (m.spanSeconds != null) spans.push(m.spanSeconds);
    if (m.customerReturned) returned++;
  } catch (e) {
    // A rate limit or a deleted ticket must not abort the sample.
    failures++;
    const status = e instanceof HttpError ? e.status : 0;
    if (status === 429 || status === 403) await new Promise((r) => setTimeout(r, 2000));
  }
}

if (!measured) {
  console.error("Every ticket read failed — not writing a baseline from an empty sample.");
  Deno.exit(1);
}

const pct = (n: number, of: number) => (of ? Math.round((1000 * n) / of) / 10 : 0);
const slowFirst = firstReply.filter((s) => s > 3600).length;
const medianReply = median(firstReply);
const medianSpan = median(spans);
const medianReplies = median(replies);
const stamp = new Date().toISOString();

const metrics = [
  {
    metric_key: "customer_returned_rate",
    value: pct(returned, measured),
    unit: "%",
    label: "Customer came back",
    detail: `${returned} of ${measured} coached tickets`,
    source_note:
      "Freshdesk: a customer message arrived AFTER the first public agent reply. " +
      "Freshdesk exposes no reopen counter, so this is named for what it measures.",
  },
  {
    metric_key: "agent_replies_to_close",
    value: medianReplies ?? 0,
    unit: "replies",
    label: "Agent replies per ticket",
    detail: `median over ${replies.length} ticket(s) with a reply`,
    source_note: "Freshdesk: public outgoing conversations per coached ticket (median).",
  },
  {
    metric_key: "median_ticket_span_h",
    value: medianSpan != null ? Math.round((medianSpan / 3600) * 10) / 10 : 0,
    unit: "h",
    label: "Median ticket span",
    detail: `median over ${spans.length} ticket(s)`,
    source_note:
      "Freshdesk: creation to last message. A PROXY for time-to-close — the true " +
      "resolved_at needs ?include=stats, which this codebase does not fetch.",
  },
  {
    metric_key: "first_reply_over_1h",
    value: pct(slowFirst, firstReply.length),
    unit: "%",
    label: "First reply over 1 h",
    detail: `${slowFirst} of ${firstReply.length} · median ${
      medianReply != null ? Math.round(medianReply / 60) + " min" : "n/a"
    }`,
    source_note: "Freshdesk: ticket creation to the first public agent reply.",
  },
];

console.log("Measured baselines (coached population):");
for (const m of metrics) {
  console.log(`  ${m.label.padEnd(26)} ${String(m.value).padStart(7)} ${m.unit.padEnd(8)} ${m.detail}`);
}
console.log("\nTime to first agent reply:");
for (const b of REPLY_BUCKETS) {
  const n = buckets.get(b.key) ?? 0;
  console.log(`  ${b.label.padEnd(14)} ${String(n).padStart(5)}  ${pct(n, firstReply.length)}%`);
}
if (failures) console.log(`\n${failures} ticket read(s) failed and were excluded from the sample.`);

if (!apply) {
  console.log(
    "\nDry run — nothing written. Re-run with BASELINE_APPLY=true to LOCK these.\n" +
      "Locking replaces the previous baselines; they are not recomputed afterwards.",
  );
  Deno.exit(0);
}

const { error: upErr } = await db.from("coaching_baselines").upsert(
  metrics.map((m) => ({ ...m, computed_at: stamp })),
  { onConflict: "metric_key" },
);
if (upErr) {
  console.error(`failed to store baselines: ${upErr.message}`);
  Deno.exit(1);
}

const { error: distErr } = await db.from("coaching_reply_distribution").upsert(
  REPLY_BUCKETS.map((b, i) => ({
    bucket_key: b.key,
    bucket_order: i + 1,
    label: b.label,
    conversations: buckets.get(b.key) ?? 0,
    share_pct: pct(buckets.get(b.key) ?? 0, firstReply.length),
    source_note: `Freshdesk, ${firstReply.length} coached ticket(s) with an agent reply`,
    computed_at: stamp,
  })),
  { onConflict: "bucket_key" },
);
if (distErr) {
  console.error(`failed to store the reply distribution: ${distErr.message}`);
  Deno.exit(1);
}

// The Intercom rows are no longer comparable to anything we measure, so they are
// removed rather than left sitting beside the new numbers looking equivalent.
const { error: delErr } = await db
  .from("coaching_baselines")
  .delete()
  .in("metric_key", ["reopen_rate"]);
if (delErr) console.error(`could not remove the superseded Intercom baseline: ${delErr.message}`);

console.log(
  `\nLocked ${metrics.length} baseline(s) and the reply distribution at ${stamp}.\n` +
    "These now describe the same tickets the coaching is judged on.",
);

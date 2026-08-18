// scripts/csat_scan.ts — sync Freshdesk CSAT ratings into Supabase.
//
// Posts NOTHING and calls no LLM. It reads GET /surveys/satisfaction_ratings —
// the one signal where the CUSTOMER grades the answer rather than us grading
// ourselves — and stores it so a rating can be read beside the reply that
// earned it.
//
//   deno task csat-scan                          (all ratings, all agents)
//   CSAT_AGENT="Hosna Sediqi" deno task csat-scan     (report on one agent)
//   CSAT_SINCE=2026-01-01 deno task csat-scan
//
// CUSTOMER FEEDBACK IS NEVER PRINTED. The written comment is customer content
// (§5/§11) and goes to Supabase only; the console gets counts and ticket ids so
// the run is auditable from CI without leaking anything. Read the words in the
// `csat_negative_with_reply` view.
//
// SCALE: Freshdesk is 103..-103, not 1-5. Count bands, never average.

import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import { csatBand, Freshdesk } from "../supabase/functions/ticket-suggester/clients.ts";

function env(name: string): string {
  const v = Deno.env.get(name) ?? "";
  if (!v) {
    console.error(`missing required env var: ${name}`);
    Deno.exit(1);
  }
  return v;
}

const fd = new Freshdesk(env("FRESHDESK_DOMAIN"), env("FRESHDESK_API_KEY"));
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

// Freshdesk defaults this endpoint to the LAST 30 DAYS when created_since is
// omitted. That default is a trap for exactly this question: "how many bad
// ratings does this agent have" would silently become "…in the last month", and
// an empty result would read as "none" rather than "outside the window". So the
// scan always sends an explicit window and prints it.
const DEFAULT_LOOKBACK_DAYS = 730;
const since = Deno.env.get("CSAT_SINCE")?.trim() ||
  new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
const agentSel = (Deno.env.get("CSAT_AGENT") ?? "").trim();

let focusAgentId: number | null = null;
if (agentSel) {
  if (/^\d+$/.test(agentSel)) {
    focusAgentId = Number(agentSel);
  } else {
    const agent = await fd.findAgent(agentSel).catch(() => null);
    if (!agent) {
      console.error(`No agent matched "${agentSel}". Use their numeric agent id instead.`);
      Deno.exit(1);
    }
    focusAgentId = agent.id;
    console.log(`Matched agent "${agent.contact?.name}" (id ${agent.id}).`);
  }
}

// Which surveys exist at all. Without this, "this agent has no ratings" cannot
// be distinguished from "we read the wrong survey" — and the second is the one
// that produces a false accusation about a person.
const surveys = await fd.listSurveys().catch((e) => {
  console.log(`(could not list surveys: ${e instanceof Error ? e.name : "error"})`);
  return [] as Array<{ id: number; title?: string; active?: boolean }>;
});
if (surveys.length) {
  console.log(`Surveys configured: ${surveys.length}`);
  for (const s of surveys) {
    console.log(`  survey ${s.id} · active=${s.active} · ${s.title ?? "(untitled)"}`);
  }
}

console.log(`Fetching satisfaction ratings created since ${since} (Freshdesk would default to 30 days).`);
const ratings = await fd.listAllSatisfactionRatings({ createdSince: since });
console.log(`Freshdesk returned ${ratings.length} rating(s).`);

const rows = ratings.map((r) => {
  // `default_question` is the overall score; fall back to the first question so
  // a renamed survey still yields a band rather than silently dropping the row.
  const value = r.ratings?.default_question ?? Object.values(r.ratings ?? {})[0];
  return {
    id: r.id,
    survey_id: r.survey_id ?? null,
    ticket_id: r.ticket_id,
    agent_id: r.agent_id ?? null,
    group_id: r.group_id ?? null,
    user_id: r.user_id ?? null,
    rating_value: value,
    band: csatBand(value),
    feedback: (r.feedback ?? "").trim() || null,
    rated_at: r.created_at ?? null,
  };
}).filter((r) => typeof r.rating_value === "number");

if (rows.length) {
  // Upsert on Freshdesk's own id: a re-run must not duplicate, and a customer
  // who edits their rating should update in place.
  const { error } = await db.from("csat_ratings").upsert(rows, { onConflict: "id" });
  if (error) {
    console.error("Supabase write failed:", error.message);
    Deno.exit(1);
  }
}
console.log(`Stored ${rows.length} rating(s).`);
if (!ratings.length) {
  console.log(
    "\nNOTE: the API returned zero ratings for EVERY agent. That is a retrieval\n" +
    "result, not a finding about anyone's CSAT. Likely causes, in order:\n" +
    "  1. the window — widen it with CSAT_SINCE=YYYY-MM-DD\n" +
    "  2. the API key lacks survey scope (a restricted key returns [] not 403)\n" +
    "  3. satisfaction surveys are not enabled on this Freshdesk plan\n" +
    "Do not report 'no negative ratings' off this run.",
  );
}

// ── Report ────────────────────────────────────────────────────────────────
// Counts and ticket ids only. No customer words, no subjects.
function report(label: string, set: typeof rows) {
  const pos = set.filter((r) => r.band === "positive").length;
  const neu = set.filter((r) => r.band === "neutral").length;
  const neg = set.filter((r) => r.band === "negative").length;
  console.log(`\n${label}: ${set.length} rated · ${pos} positive · ${neu} neutral · ${neg} negative`);
  const negIds = set.filter((r) => r.band === "negative").map((r) => r.ticket_id);
  if (negIds.length) {
    console.log(`  negative on ticket(s): ${negIds.join(" ")}`);
    console.log(`  → score these replies:  deno task score-history ${negIds.join(" ")}`);
  }
  const withWords = set.filter((r) => r.band === "negative" && r.feedback).length;
  console.log(`  negative ratings carrying written feedback: ${withWords} (read them in Supabase)`);
}

// Per-survey coverage. A survey whose newest rated ticket is far below the
// tickets you care about is a survey you are not actually reading.
const bySurvey = new Map<number | null, typeof rows>();
for (const r of rows) {
  const k = r.survey_id as number | null;
  if (!bySurvey.has(k)) bySurvey.set(k, []);
  bySurvey.get(k)!.push(r);
}
// THE TRAP THIS GUARD EXISTS FOR (verified live 2026-08-18).
//
// GET /surveys returns the CURRENT surveys with UUID ids:
//     901cf9fe-… Test CSAT (inactive) · dc30ba3c-… CSAT Expert · bd7d69dc-… Basic CSAT Survey
// GET /surveys/satisfaction_ratings returns ratings carrying NUMERIC survey ids:
//     201000046125 · 201000026097 · 201000046120
//
// Two different id spaces means two different systems: the v2 ratings endpoint
// exposes only the LEGACY surveys, which stopped collecting around ticket 65323.
// Ratings from the currently active surveys are not reachable here at all.
//
// Left unflagged this reads as "this agent has no ratings" — a statement about a
// person that is really a gap in our retrieval. Fail loudly instead.
const ratingSurveyIds = new Set(rows.map((r) => String(r.survey_id)));
const listedIds = surveys.map((s) => String(s.id));
const overlap = listedIds.filter((id) => ratingSurveyIds.has(id));
if (surveys.length && !overlap.length) {
  console.log(
    "\n⚠️  SURVEY ID MISMATCH — the ratings you just read are NOT from the surveys\n" +
    "    that are currently configured.\n" +
    `      /surveys returned:            ${listedIds.join(", ")}\n` +
    `      ratings carry survey ids:     ${[...ratingSurveyIds].join(", ")}\n` +
    "    The v2 satisfaction_ratings endpoint only exposes the LEGACY surveys.\n" +
    "    Any per-agent count from this run covers the legacy corpus only, and an\n" +
    "    agent who joined later will show zero ratings whatever their real CSAT is.\n" +
    "    DO NOT report these counts as an agent's CSAT.",
  );
}

console.log("\nCoverage per survey (newest rated ticket id is the number to check):");
for (const [sid, set] of bySurvey) {
  const maxTicket = Math.max(...set.map((r) => r.ticket_id));
  const newest = set.map((r) => r.rated_at ?? "").sort().at(-1);
  console.log(`  survey ${sid ?? "(none)"} · ${set.length} rating(s) · newest ticket ${maxTicket} · newest rating ${newest}`);
}

report("All agents", rows);
if (focusAgentId !== null) {
  report(`Agent ${focusAgentId}`, rows.filter((r) => r.agent_id === focusAgentId));
}

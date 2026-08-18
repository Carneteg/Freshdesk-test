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

const since = Deno.env.get("CSAT_SINCE")?.trim() || undefined;
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

console.log(`Fetching satisfaction ratings${since ? ` created since ${since}` : ""}…`);
const ratings = await fd.listAllSatisfactionRatings({ createdSince: since });
console.log(`Freshdesk returned ${ratings.length} rating(s).`);

const rows = ratings.map((r) => {
  // `default_question` is the overall score; fall back to the first question so
  // a renamed survey still yields a band rather than silently dropping the row.
  const value = r.ratings?.default_question ?? Object.values(r.ratings ?? {})[0];
  return {
    id: r.id,
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

report("All agents", rows);
if (focusAgentId !== null) {
  report(`Agent ${focusAgentId}`, rows.filter((r) => r.agent_id === focusAgentId));
}

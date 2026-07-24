// scripts/assign_cohorts.ts — assign tickets to LOCKED learning/development/holdout
// cohorts (scaling plan Fas 2.1). Writes nothing to Freshdesk/OpenAI; Supabase only.
//
//   deno task assign-cohorts                 # assign every ticket seen in `suggestions`
//   deno task assign-cohorts 86144 86155     # assign specific ticket ids
//   COHORT_LEARNING_PCT=40 COHORT_DEV_PCT=20 deno task assign-cohorts   # tune the split
//
// The split is deterministic (a hash of the ticket id, decorrelated from the
// sequential id) and the write is idempotent: a ticket already in `ticket_cohorts`
// is NEVER moved, so the holdout can't drift into training. Run this BEFORE writing
// gold answers / learning runs so the holdout is clean from the start.

import { createClient } from "npm:@supabase/supabase-js@2";

function env(name: string): string {
  const v = Deno.env.get(name) ?? "";
  if (!v) {
    console.error(`missing required env var: ${name}`);
    Deno.exit(1);
  }
  return v;
}

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const version = Deno.env.get("COHORT_VERSION") ?? "v1";
const learningPct = Number(Deno.env.get("COHORT_LEARNING_PCT") ?? "40");
const devPct = Number(Deno.env.get("COHORT_DEV_PCT") ?? "20");
if (learningPct + devPct > 100 || learningPct < 0 || devPct < 0) {
  console.error("COHORT_LEARNING_PCT + COHORT_DEV_PCT must be between 0 and 100.");
  Deno.exit(1);
}

// Stable bucket 0..99 from the ticket id (FNV-1a over its digits), so the split is
// reproducible AND decorrelated from the sequential id order (a plain id % 100 would
// cluster consecutive tickets together).
function bucket(id: number): number {
  let h = 2166136261;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100;
}
function cohortFor(id: number): "learning" | "development" | "holdout" {
  const b = bucket(id);
  if (b < learningPct) return "learning";
  if (b < learningPct + devPct) return "development";
  return "holdout";
}

// ── candidate ticket ids: explicit args, else everything we've seen in suggestions ──
let ids = Deno.args.map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
if (!ids.length) {
  const seen = new Set<number>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("suggestions")
      .select("ticket_id")
      .range(from, from + pageSize - 1);
    if (error) {
      console.error(`failed to read suggestions: ${error.message}`);
      Deno.exit(1);
    }
    for (const r of data ?? []) seen.add(r.ticket_id);
    if (!data || data.length < pageSize) break;
  }
  ids = [...seen];
}
if (!ids.length) {
  console.error("No candidate tickets. Pass ids, or replay/score some tickets first.");
  Deno.exit(1);
}

// Which are already assigned (locked)? Never touch those.
const already = new Set<number>();
{
  const { data } = await db.from("ticket_cohorts").select("ticket_id").eq("cohort_version", version);
  for (const r of data ?? []) already.add(r.ticket_id);
}

const toInsert = ids
  .filter((id) => !already.has(id))
  .map((id) => ({ ticket_id: id, cohort: cohortFor(id), cohort_version: version }));

console.log(
  `Candidates: ${ids.length}. Already assigned (${version}): ${ids.length - toInsert.length}. New: ${toInsert.length}.`,
);

if (toInsert.length) {
  // ignoreDuplicates so a concurrent run or an already-locked ticket is a no-op,
  // never a move — the holdout stays put.
  const { error } = await db.from("ticket_cohorts").upsert(toInsert, {
    onConflict: "ticket_id",
    ignoreDuplicates: true,
  });
  if (error) {
    console.error(`insert failed: ${error.message}`);
    Deno.exit(1);
  }
}

// Report the resulting distribution for this version.
const { data: summary } = await db
  .from("ticket_cohorts")
  .select("cohort")
  .eq("cohort_version", version);
const counts: Record<string, number> = { learning: 0, development: 0, holdout: 0 };
for (const r of summary ?? []) counts[r.cohort] = (counts[r.cohort] ?? 0) + 1;
const total = (summary ?? []).length;
console.log(`\nCohort '${version}' now holds ${total} ticket(s):`);
for (const c of ["learning", "development", "holdout"] as const) {
  const n = counts[c];
  const pct = total ? Math.round((100 * n) / total) : 0;
  console.log(`  ${c.padEnd(12)} ${String(n).padStart(5)}  (${pct}%)`);
}
console.log("\nHoldout is LOCKED: gold answers on holdout tickets are excluded from learning-loop exemplars.");

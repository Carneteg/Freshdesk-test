// scripts/knowledge_gaps.ts — the weekly "what to document" report (scaling plan Fas 4.4).
//
// Reads the `knowledge_gaps` view (topics where the pipeline could NOT ground a
// confident answer) and prints them worst-first. Writes nothing; Supabase read-only.
//
//   deno task knowledge-gaps            # top 10
//   GAP_LIMIT=25 deno task knowledge-gaps
//
// Read a row as "a KB article / operational note worth writing", NOT as a grade of
// the AI — the Gate 1 root cause (§12) is exactly this undocumented knowledge.

import { createClient } from "npm:@supabase/supabase-js@2.110.8";

function env(name: string): string {
  const v = Deno.env.get(name) ?? "";
  if (!v) {
    console.error(`missing required env var: ${name}`);
    Deno.exit(1);
  }
  return v;
}

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const limit = Number(Deno.env.get("GAP_LIMIT") ?? "10");
const safeLog = (Deno.env.get("CLOUD_LOG_MODE") ?? "").toLowerCase() === "safe";

const { data, error } = await db
  .from("knowledge_gaps")
  .select(
    "topic, gap_tickets, distinct_tickets, no_kb_source, weak_grounding, languages, recent_ticket_ids, recent_subjects, last_seen",
  )
  .limit(limit);

if (error) {
  console.error(`failed to read knowledge_gaps: ${error.message}`);
  Deno.exit(1);
}
const rows = data ?? [];
if (!rows.length) {
  console.log("No knowledge gaps found (or nothing replayed yet).");
  Deno.exit(0);
}

const total = rows.reduce((n, r) => n + (r.gap_tickets ?? 0), 0);
console.log(
  `Top ${rows.length} knowledge gaps (by frequency) — ${total} ungrounded ticket(s) shown.\n`,
);
console.log(
  "Read each as 'a KB article / operational note to write', not a grade of the AI.\n",
);

rows.forEach((r, i) => {
  const langs = Array.isArray(r.languages) ? r.languages.join("/") : "";
  const kind = r.no_kb_source
    ? `${r.no_kb_source} no-KB-source, ${r.weak_grounding} weak-grounding`
    : `${r.weak_grounding} weak-grounding`;
  console.log(
    `${
      String(i + 1).padStart(2)
    }. ${r.topic}  —  ${r.gap_tickets} gap(s) [${kind}]  ${langs}`,
  );
  const subs = Array.isArray(r.recent_subjects) ? r.recent_subjects : [];
  if (!safeLog) {
    for (const s of subs.slice(0, 3)) console.log(`      · ${s}`);
  }
  const ids = Array.isArray(r.recent_ticket_ids) ? r.recent_ticket_ids : [];
  if (ids.length) console.log(`      tickets: ${ids.join(", ")}`);
  console.log("");
});

console.log("Full detail per ticket is in the `knowledge_gap_tickets` view.");

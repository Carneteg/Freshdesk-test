// scripts/suggest_once.ts — run the pipeline on ONE ticket and POST the
// suggestion as a private note (+ keyword tags), exactly like the live scheduler
// would for a single ticket. This WRITES to Freshdesk — use it to see a real
// suggestion appear in the agent view.
//
//   deno task suggest 12346
//
// Needs FRESHDESK_* and OPENAI_*. If SUPABASE_* is set it also logs the row to
// `suggestions` (with the real note_id), just like live.

import { createClient } from "npm:@supabase/supabase-js@2";
import { Freshdesk, LLM } from "../supabase/functions/ticket-suggester/clients.ts";
import { deriveTags, latestCustomerMessage } from "../supabase/functions/ticket-suggester/render.ts";
import { loadIncidents, runPipeline, toRow } from "../supabase/functions/ticket-suggester/pipeline.ts";

function env(name: string): string {
  const v = Deno.env.get(name) ?? "";
  if (!v) {
    console.error(`missing required env var: ${name}`);
    Deno.exit(1);
  }
  return v;
}

const force = Deno.args.includes("--force") || (Deno.env.get("FORCE") ?? "").length > 0;
const id = Number(Deno.args.find((a) => /^\d+$/.test(a)));
if (!Number.isFinite(id) || id <= 0) {
  console.error("Usage: deno task suggest <ticketId> [--force]");
  console.error("Tip: pick a ticket whose topic is covered by your KB so you get a real draft.");
  Deno.exit(1);
}

const fd = new Freshdesk(env("FRESHDESK_DOMAIN"), env("FRESHDESK_API_KEY"));
const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o";
const llm = new LLM(env("OPENAI_API_KEY"), model);
const withRetrieval = (Deno.env.get("WITH_RETRIEVAL") ?? "true") !== "false";
const excludeCategories = (Deno.env.get("EXCLUDE_SOLUTION_CATEGORIES") ?? "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const db = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey) : null;

console.log(`Loading ticket #${id} …`);
const ticket = await fd.ticketWithConversations(id);
console.log(`  ${ticket.subject}`);

// Duplicate guard (like the live poller's dedup): skip if a note was already
// posted for this ticket's current customer message. Needs Supabase; --force overrides.
if (db && !force) {
  const { triggerId } = latestCustomerMessage(ticket);
  const { data: existing } = await db
    .from("suggestions")
    .select("note_id")
    .eq("ticket_id", id)
    .eq("trigger_message_id", triggerId)
    .not("note_id", "is", null)
    .limit(1);
  if (existing && existing.length) {
    console.log(`\nAlready posted a note (${existing[0].note_id}) for #${id}'s current customer message.`);
    console.log("Skipping to avoid a duplicate. Re-run with --force to post anyway.");
    Deno.exit(0);
  }
} else if (!db) {
  console.log("  (no Supabase creds — duplicate guard is off; running suggest again would re-post)");
}

console.log("Running pipeline (analyse → retrieve → draft → verify) …");
const incidents = db ? await loadIncidents(db) : [];
const s = await runPipeline(
  { fd, llm, model, withRetrieval, excludeCategories, incidents, db: db ?? undefined },
  ticket,
);
console.log(`  type=${s.ticket_type}  confidence=${s.confidence}  Q/A=${s.qa_answered}/${s.qa_total}`);
if (s.confidence === "none") {
  console.log("  (confidence is 'none' — the note will say so; try a ticket your KB covers for a real draft)");
}

console.log("Posting private note to Freshdesk …");
const noteId = await fd.postPrivateNote(id, s.note_html);
console.log(`  ✅ posted private note ${noteId}`);

const tags = deriveTags(s.keywords);
if (tags.length) {
  try {
    await fd.setTags(id, Array.from(new Set([...(ticket.tags ?? []), ...tags])));
    console.log(`  ✅ tags merged: ${tags.join(", ")}`);
  } catch (e) {
    console.warn(`  tag write failed: ${e instanceof Error ? e.message : e}`);
  }
}

if (db) {
  const { error } = await db.from("suggestions").upsert(toRow(s, { noteId }), {
    onConflict: "ticket_id,trigger_message_id",
  });
  console.log(error ? `  db log failed: ${error.message}` : "  ✅ logged to `suggestions`");
}

console.log(`\nOpen the ticket to see the note: ${s.ticket_url}`);

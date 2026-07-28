// scripts/suggest_once.ts — run the pipeline on ONE ticket and POST the
// suggestion as a private note (+ keyword tags), exactly like the live scheduler
// would for a single ticket. This WRITES to Freshdesk — use it to see a real
// suggestion appear in the agent view.
//
//   deno task suggest 12346
//
// Needs FRESHDESK_* and OPENAI_*. If SUPABASE_* is set it also logs the row to
// `suggestions` (with the real note_id), just like live.

import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import { Freshdesk, LLM } from "../supabase/functions/ticket-suggester/clients.ts";
import {
  deriveTags,
  latestCustomerMessage,
} from "../supabase/functions/ticket-suggester/render.ts";
import {
  loadIncidents,
  runPipeline,
  toRow,
} from "../supabase/functions/ticket-suggester/pipeline.ts";
import { PROMPT_VERSION } from "../supabase/functions/ticket-suggester/prompts.ts";

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
  console.error(
    "Tip: pick a ticket whose topic is covered by your KB so you get a real draft.",
  );
  Deno.exit(1);
}

const fd = new Freshdesk(env("FRESHDESK_DOMAIN"), env("FRESHDESK_API_KEY"));
const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o";
const llm = new LLM(env("OPENAI_API_KEY"), model);
const withRetrieval = (Deno.env.get("WITH_RETRIEVAL") ?? "true") !== "false";
const excludeCategories = (Deno.env.get("EXCLUDE_SOLUTION_CATEGORIES") ?? "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const reviewUrl = Deno.env.get("REVIEW_APP_URL") || undefined;
const runVariant = force ? `manual-live:force:${crypto.randomUUID()}` : "manual-live";

console.log(`Loading ticket #${id} …`);
const ticket = await fd.ticketWithConversations(id);
console.log(`  ${ticket.subject}`);

// Duplicate guard across every live/manual variant for this customer turn.
const { triggerId } = latestCustomerMessage(ticket);
if (!force) {
  const { data: existing, error } = await db
    .from("suggestions")
    .select("note_id")
    .eq("ticket_id", id)
    .eq("trigger_message_id", triggerId)
    .in("run_variant", ["live", "manual-live"])
    .eq("delivery_status", "posted")
    .not("note_id", "is", null)
    .limit(1);
  if (error) throw new Error(`duplicate guard failed: ${error.message}`);
  if (existing && existing.length) {
    console.log(
      `\nAlready posted a note (${
        existing[0].note_id
      }) for #${id}'s current customer message.`,
    );
    console.log("Skipping to avoid a duplicate. Re-run with --force to post anyway.");
    Deno.exit(0);
  }
}

const reservationToken = crypto.randomUUID();
const { data: reservationRows, error: reservationError } = await db.rpc(
  "reserve_generation",
  {
    p_ticket_id: ticket.id,
    p_trigger_message_id: triggerId,
    p_subject: ticket.subject,
    p_prompt_version: PROMPT_VERSION,
    p_model: model,
    p_run_variant: runVariant,
    p_reservation_token: reservationToken,
    p_lease_seconds: 300,
  },
);
if (reservationError) {
  throw new Error(`generation reservation failed: ${reservationError.message}`);
}
const reservation = reservationRows?.[0];
if (!reservation || reservation.action === "skip") {
  console.log("A matching generation is already reserved or delivered. Nothing posted.");
  Deno.exit(0);
}
const generationId = reservation.generation_id as number;

let s;
if (reservation.action === "generate") {
  console.log("Running pipeline (analyse → retrieve → draft → verify) …");
  const incidents = await loadIncidents(db);
  s = await runPipeline(
    {
      fd,
      llm,
      model,
      withRetrieval,
      excludeCategories,
      incidents,
      db,
      reviewUrl,
      generationId,
      runVariant,
    },
    ticket,
  );
  console.log(
    `  type=${s.ticket_type}  confidence=${s.confidence}  Q/A=${s.qa_answered}/${s.qa_total}`,
  );
  if (s.confidence === "none") {
    console.log(
      "  (confidence is 'none' — the note will say so; try a ticket your KB covers for a real draft)",
    );
  }
  const marker = `simployer-ai-generation:${generationId}`;
  const noteHtml = `${s.note_html}\n` +
    `<p style="color:#aaa;font-size:9px">AI generation ${marker}</p>`;
  const { data: saved, error } = await db.from("suggestions").update({
    ...toRow(s),
    note_html: noteHtml,
    delivery_marker: marker,
    delivery_status: "generated",
  })
    .eq("id", generationId)
    .eq("reservation_token", reservationToken)
    .eq("delivery_status", "reserved")
    .select("id")
    .maybeSingle();
  if (error || !saved) {
    throw new Error(`outbox save failed: ${error?.message ?? "lost reservation"}`);
  }
}

const { data: generation, error: loadError } = await db.from("suggestions")
  .select("note_id,note_html,delivery_marker,post_attempts,keywords,ticket_url")
  .eq("id", generationId)
  .maybeSingle();
if (loadError || !generation?.note_html || !generation?.delivery_marker) {
  throw new Error(`outbox load failed: ${loadError?.message ?? "missing payload"}`);
}

let noteId = generation.note_id as number | null;
if (!noteId) {
  const { error: postingError } = await db.from("suggestions").update({
    delivery_status: "posting",
    posting_started_at: new Date().toISOString(),
    post_attempts: (generation.post_attempts ?? 0) + 1,
  }).eq("id", generationId).eq("reservation_token", reservationToken);
  if (postingError) throw new Error(`posting-state save failed: ${postingError.message}`);

  noteId = await fd.findPrivateNoteByMarker(id, generation.delivery_marker);
  if (!noteId) {
    try {
      noteId = await fd.postPrivateNote(id, generation.note_html);
    } catch (err) {
      noteId = await fd.findPrivateNoteByMarker(id, generation.delivery_marker);
      if (!noteId) throw err;
    }
  }
  const { error: postedError } = await db.from("suggestions").update({
    delivery_status: "posted",
    note_id: noteId,
    posted_at: new Date().toISOString(),
    reservation_expires_at: null,
    error: null,
  }).eq("id", generationId).eq("reservation_token", reservationToken);
  if (postedError) throw new Error(`posted-state save failed: ${postedError.message}`);
}
console.log(`  ✅ posted private note ${noteId}`);

const tags = deriveTags(generation.keywords ?? []);
if (tags.length) {
  try {
    await fd.setTags(id, Array.from(new Set([...(ticket.tags ?? []), ...tags])));
    console.log(`  ✅ tags merged: ${tags.join(", ")}`);
  } catch (e) {
    console.warn(`  tag write failed: ${e instanceof Error ? e.message : e}`);
  }
}

console.log(
  `\nOpen the ticket to see the note: ${generation.ticket_url ?? fd.ticketUrl(id)}`,
);

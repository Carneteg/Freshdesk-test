// scripts/sync_tickets.ts — build the past-ticket semantic index (knowledge
// layer stage 2). Pulls the chosen agent's CLOSED tickets, extracts the customer
// question and the agent's resolving reply, embeds them, and upserts into
// `past_tickets`. The pipeline then finds similar resolved tickets by embedding
// similarity. Posts NOTHING to Freshdesk. Run it periodically to keep it fresh.
//
//   $env:REPLAY_AGENT = "johanna.sofie.martinsen@simployer.com"
//   deno task sync-tickets
//   $env:SYNC_LIMIT = "300"; deno task sync-tickets   # index more
//
// Needs FRESHDESK_*, OPENAI_*, and SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
// Real closed-ticket PII is sent to OpenAI for embedding (DPA cleared, §11/§12).

import { createClient } from "npm:@supabase/supabase-js@2";
import { Freshdesk, LLM } from "../supabase/functions/ticket-suggester/clients.ts";
import {
  isIgnorableTicket,
  lastAgentReply,
  latestCustomerMessage,
} from "../supabase/functions/ticket-suggester/render.ts";

function env(name: string): string {
  const v = Deno.env.get(name) ?? "";
  if (!v) {
    console.error(`missing required env var: ${name}`);
    Deno.exit(1);
  }
  return v;
}

const fd = new Freshdesk(env("FRESHDESK_DOMAIN"), env("FRESHDESK_API_KEY"));
const llm = new LLM(env("OPENAI_API_KEY"), Deno.env.get("OPENAI_MODEL") ?? "gpt-4o");
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

// Which agent's resolved tickets to index (name / email / id); defaults to MY_AGENT_ID.
const sel = (Deno.env.get("REPLAY_AGENT") ?? Deno.env.get("MY_AGENT_ID") ?? "").trim();
if (!sel) {
  console.error("Set REPLAY_AGENT (name / email / id) or MY_AGENT_ID.");
  Deno.exit(1);
}
let agentId = sel;
if (!/^\d+$/.test(sel)) {
  const agent = await fd.findAgent(sel);
  if (!agent) {
    console.error(`No agent matched "${sel}". Try their email or numeric id.`);
    Deno.exit(1);
  }
  agentId = String(agent.id);
  console.log(`Agent "${agent.contact?.name}" (id ${agentId}).`);
}

const limit = Number(Deno.env.get("SYNC_LIMIT") ?? "200");

// Freshdesk's filter API returns ~30 per page, up to 10 pages. Collect closed
// tickets (call-logs skipped) until we hit the limit or run out.
console.log(`Listing closed tickets for agent ${agentId} …`);
const ids: number[] = [];
for (let page = 1; page <= 10 && ids.length < limit; page++) {
  const res = await fd.searchTickets(`status:5 AND agent_id:${agentId}`, page);
  const pageIds = (res.results ?? [])
    .filter((t) => !isIgnorableTicket(t.subject))
    .map((t) => t.id);
  if (!pageIds.length) break;
  ids.push(...pageIds);
}
const finalIds = ids.slice(0, limit);
console.log(`  ${finalIds.length} ticket(s) to index (call-logs skipped).\n`);

let indexed = 0;
let skipped = 0;
for (const id of finalIds) {
  try {
    const ticket = await fd.ticketWithConversations(id);
    const question = latestCustomerMessage(ticket).text;
    const resolution = lastAgentReply(ticket);
    // Only index tickets that have both a question and a real resolving reply —
    // those are the ones worth referencing as precedent.
    if (!question.trim() || !resolution.trim()) {
      skipped++;
      continue;
    }
    const embedding = await llm.embed(`${ticket.subject ?? ""}\n${question}`);
    if (!embedding.length) {
      skipped++;
      continue;
    }
    const { error } = await db.from("past_tickets").upsert({
      ticket_id: id,
      subject: ticket.subject ?? null,
      question: question.slice(0, 8000),
      resolution: resolution.slice(0, 8000),
      embedding,
      synced_at: new Date().toISOString(),
    }, { onConflict: "ticket_id" });
    if (error) {
      console.error(`  #${id} save failed: ${error.message}`);
      skipped++;
      continue;
    }
    indexed++;
    if (indexed % 20 === 0) console.log(`  …${indexed} indexed`);
  } catch (err) {
    console.error(`  #${id} failed: ${err instanceof Error ? err.message : err}`);
    skipped++;
  }
}

console.log(`\nDone. Indexed ${indexed}, skipped ${skipped}. past_tickets is ready for semantic search.`);

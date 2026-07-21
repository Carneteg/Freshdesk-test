// scripts/verify_api.ts — Build Order Step 1 (CLAUDE.md §6).
//
// Throwaway probe: confirms the Freshdesk API behaves as clients.ts assumes,
// BEFORE any Claude calls or scheduling. Read-only by default; it will only
// POST a test note if you explicitly opt in (see the note check below).
//
// Run:  deno run --allow-env --allow-net scripts/verify_api.ts
// Needs: FRESHDESK_DOMAIN, FRESHDESK_API_KEY  (MY_AGENT_ID optional, compared if set)
//
// No customer data is sent to Anthropic here — this touches Freshdesk only, so
// it is fine to run before/independently of the DPA position.

import { Freshdesk } from "../supabase/functions/ticket-suggester/clients.ts";

function env(name: string, required = true): string {
  const v = Deno.env.get(name) ?? "";
  if (required && !v) {
    console.error(`missing required env var: ${name}`);
    Deno.exit(1);
  }
  return v;
}

const ok = (m: string) => console.log(`  ✅ ${m}`);
const diff = (m: string) => console.log(`  ⚠️  ${m}`);
const info = (m: string) => console.log(`     ${m}`);

const fd = new Freshdesk(env("FRESHDESK_DOMAIN"), env("FRESHDESK_API_KEY"));
const has = (o: unknown, k: string) => o !== null && typeof o === "object" && k in (o as object);

// 1. agents/me — confirm the agent id (and name).
console.log("\n[1] GET /agents/me");
let agentId: number | null = null;
try {
  const me = await fd.me();
  agentId = me.id;
  ok(`agent id = ${me.id}, name = "${me.contact?.name}"`);
  const envId = Deno.env.get("MY_AGENT_ID");
  if (envId && String(me.id) !== envId) diff(`MY_AGENT_ID=${envId} does NOT match /agents/me id ${me.id}`);
  else if (envId) ok("MY_AGENT_ID matches /agents/me");
} catch (e) {
  diff(`failed: ${e instanceof Error ? e.message : e}`);
}

// 2. tickets?updated_since — confirm responder_id exists and filtering works.
console.log("\n[2] GET /tickets?updated_since=<30d ago>");
let sampleTicketId: number | null = null;
try {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const tickets = await fd.listUpdatedTickets(since);
  ok(`returned ${tickets.length} ticket(s)`);
  if (tickets.length) {
    const t = tickets[0];
    sampleTicketId = t.id;
    has(t, "responder_id") ? ok('field "responder_id" present') : diff('field "responder_id" MISSING');
    has(t, "updated_at") ? ok('field "updated_at" present') : diff('field "updated_at" MISSING');
    if (agentId != null) {
      const mine = tickets.filter((x) => x.responder_id === agentId).length;
      info(`${mine}/${tickets.length} in this window are assigned to you`);
    }
  } else {
    info("no tickets in the last 30 days — widen the window or check the key's scope");
  }
} catch (e) {
  diff(`failed: ${e instanceof Error ? e.message : e}`);
}

// 3. tickets/{id}?include=conversations — confirm the field names we rely on.
console.log("\n[3] GET /tickets/{id}?include=conversations");
const probeId = Number(Deno.env.get("PROBE_TICKET_ID") ?? sampleTicketId ?? 0);
if (!probeId) {
  info("no ticket id available — set PROBE_TICKET_ID=<id> to run this check");
} else {
  try {
    const t = await fd.ticketWithConversations(probeId);
    has(t, "description_text") ? ok('ticket "description_text" present') : diff('"description_text" MISSING');
    const c = (t.conversations ?? [])[0];
    if (!c) {
      info("ticket has no conversations — try a ticket with replies");
    } else {
      for (const f of ["body_text", "incoming", "private"]) {
        has(c, f) ? ok(`conversation "${f}" present`) : diff(`conversation "${f}" MISSING`);
      }
    }
  } catch (e) {
    diff(`failed: ${e instanceof Error ? e.message : e}`);
  }
}

// 4. search/solutions — the endpoint we are LEAST sure about (CLAUDE.md §7).
console.log("\n[4] GET /search/solutions?term=…  (least-certain endpoint)");
try {
  const sols = await fd.searchSolutions(Deno.env.get("PROBE_TERM") ?? "password");
  ok(`endpoint responded; ${sols.length} result(s)`);
  if (sols.length) {
    const keys = Object.keys(sols[0] as object).join(", ");
    info(`first result keys: ${keys}`);
    has(sols[0], "description_text") || has(sols[0], "description")
      ? ok("a description field is present")
      : diff("no description/description_text field — retrieval text may be empty");
  } else {
    info("0 results — try a term you know exists in the KB via PROBE_TERM=…");
  }
} catch (e) {
  diff(`failed — endpoint may not exist in this form; may need /solutions/categories traversal`);
  info(`${e instanceof Error ? e.message : e}`);
}

// 5. search/tickets — confirm the query syntax.
console.log("\n[5] GET /search/tickets?query=…");
try {
  const res = await fd.searchTickets(Deno.env.get("PROBE_TERM") ?? "password");
  ok(`endpoint responded; ${res.results?.length ?? 0} result(s), total=${res.total ?? "?"}`);
} catch (e) {
  diff(`failed — confirm the quoted query syntax against the docs for your plan`);
  info(`${e instanceof Error ? e.message : e}`);
}

// 6. POST note — WRITE. Off unless you opt in: set POST_TEST_NOTE_TICKET_ID=<id>.
console.log("\n[6] POST /tickets/{id}/notes  (private note — WRITE)");
const postId = Number(Deno.env.get("POST_TEST_NOTE_TICKET_ID") ?? 0);
if (!postId) {
  info("skipped — set POST_TEST_NOTE_TICKET_ID=<a test ticket id> to post a real test note");
} else {
  try {
    const noteId = await fd.postPrivateNote(postId, "<p>API verification test note — safe to delete.</p>");
    ok(`posted private note ${noteId} to ticket ${postId}`);
  } catch (e) {
    diff(`failed: ${e instanceof Error ? e.message : e}`);
  }
}

console.log("\nDone. Fix clients.ts to match anything marked ⚠️ above (CLAUDE.md §6 Step 1).");

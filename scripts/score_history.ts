// scripts/score_history.ts — QA-score AGENTS' historical replies for triage.
//
// Posts NOTHING to Freshdesk. For each ticket it takes the agent's ACTUAL first
// substantive reply, scores it with the QA Coach (one LLM call, no draft/analyse/
// verify), and stores the result in Supabase (`agent_qa_*`). The weakest scores
// surface in the `rewrite_queue` view + the review app as rewrite targets.
//
//   deno task score-history 86144 86002              (explicit ticket ids)
//   SCORE_AGENT=johanna.sofie.martinsen@simployer.com SCORE_COUNT=200 deno task score-history
//
// Read the score as "where to look" (vague / non-answer / undocumented solution),
// NOT as a grade of the agent — Accuracy is harsh on knowledge not written in the
// ticket (§12). Real ticket text is sent to OpenAI for scoring (DPA cleared, §11).
// Start with a small batch, confirm the ranking looks sane, then scale.

import { createClient } from "npm:@supabase/supabase-js@2";
import { Freshdesk, LLM } from "../supabase/functions/ticket-suggester/clients.ts";
import {
  buildContext,
  isIgnorableTicket,
  latestCustomerMessage,
  looksLikeAutoReply,
  replayTurn,
} from "../supabase/functions/ticket-suggester/render.ts";
import { runQaCoach } from "../supabase/functions/ticket-suggester/pipeline.ts";

function env(name: string): string {
  const v = Deno.env.get(name) ?? "";
  if (!v) {
    console.error(`missing required env var: ${name}`);
    Deno.exit(1);
  }
  return v;
}

const fd = new Freshdesk(env("FRESHDESK_DOMAIN"), env("FRESHDESK_API_KEY"));
const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o";
const llm = new LLM(env("OPENAI_API_KEY"), model);
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

// ── choose tickets: explicit ids, or auto-pick an agent's recent CLOSED tickets ──
let ids = Deno.args.map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);

if (!ids.length) {
  const sel = (Deno.env.get("SCORE_AGENT") ?? Deno.env.get("MY_AGENT_ID") ?? "").trim();
  if (!sel) {
    console.error("Usage: deno task score-history <ticketId ...>");
    console.error("Or set SCORE_AGENT (name / email / id) + SCORE_COUNT to auto-pick closed tickets.");
    Deno.exit(1);
  }
  let agentId = sel;
  if (!/^\d+$/.test(sel)) {
    const agent = await fd.findAgent(sel).catch(() => null);
    if (!agent) {
      console.error(`No agent matched "${sel}". Use their numeric agent id instead.`);
      Deno.exit(1);
    }
    agentId = String(agent.id);
    console.log(`Matched agent "${agent.contact?.name}" (id ${agentId}).`);
  }
  const count = Number(Deno.env.get("SCORE_COUNT") ?? "50");
  const excludeIds = new Set(
    (Deno.env.get("SCORE_EXCLUDE_IDS") ?? "").split(",").map((s) => Number(s.trim())).filter(Boolean),
  );
  const picked: number[] = [];
  for (let page = 1; page <= 40 && picked.length < count; page++) {
    const res = await fd.searchTickets(`status:5 AND agent_id:${agentId}`, page).catch(() => null);
    if (!res || !(res.results ?? []).length) break;
    for (const t of res.results ?? []) {
      if (!isIgnorableTicket(t.subject) && !excludeIds.has(t.id)) picked.push(t.id);
    }
  }
  ids = picked.slice(0, count);
  console.log(`Auto-selected ${ids.length} closed ticket(s) for agent ${agentId}.\n`);
}

if (!ids.length) {
  console.error("No tickets to score.");
  Deno.exit(1);
}
console.log(`Scoring the agents' replies on ${ids.length} ticket(s). Nothing is posted to Freshdesk.\n`);

// runQaCoach only needs the LLM; the rest of the deps are unused here.
const deps = { fd, llm, model, withRetrieval: false, excludeCategories: [], db };

let scored = 0, skipped = 0, failed = 0;
for (const id of ids) {
  try {
    const t = await fd.ticketWithConversations(id);
    // Skip noise: call-log/marketing-reply by subject, or out-of-office/absence
    // auto-replies detected in the customer body (catches "Re: <campaign>" bounces
    // with no auto-reply prefix, e.g. #86174).
    if (isIgnorableTicket(t.subject) || looksLikeAutoReply(latestCustomerMessage(t).text)) {
      console.log(`  #${id}  skipped (auto/call-log/absence)`);
      skipped++;
      continue;
    }
    // The agent's first substantive reply, judged against the ticket as it stood
    // BEFORE that reply (so the reply is never in its own context).
    const turn = replayTurn(t);
    if (turn.index < 0 || !turn.target.trim()) {
      console.log(`  #${id}  skipped (agent never replied publicly)`);
      skipped++;
      continue;
    }
    const view = turn.view;
    const { text: customerMessage, triggerId } = latestCustomerMessage(view);
    const qa = await runQaCoach(deps, {
      customerMessage,
      ticketContext: buildContext(view),
      agentReply: turn.target,
    });
    if (!qa) {
      console.log(`  #${id}  skipped (scorer returned nothing)`);
      skipped++;
      continue;
    }
    const a = qa.assessment;
    const patch = {
      customer_message: customerMessage,
      agent_sent_reply: turn.target,
      agent_qa_version: qa.version,
      agent_qa_score: a.totalScore,
      agent_qa_verdict: a.verdict,
      agent_qa_needs_review: a.needsHumanReview,
      agent_qa_assessment: a,
    };
    // Update an existing row for this (ticket, trigger) — preserving any AI draft —
    // else insert a minimal history-scan row a reviewer can later attach a gold answer to.
    const { data: upd } = await db.from("suggestions").update(patch)
      .eq("ticket_id", id).eq("trigger_message_id", triggerId).select("id");
    if (!upd || !upd.length) {
      const { error } = await db.from("suggestions").insert({
        ticket_id: id,
        ticket_url: fd.ticketUrl(id),
        trigger_message_id: triggerId,
        subject: t.subject,
        confidence: "none",
        prompt_version: "agent-scan",
        ...patch,
      });
      if (error) throw new Error(error.message);
    }
    scored++;
    console.log(
      `  #${id}  agent QA ${a.totalScore}/100 ${a.verdict}${a.needsHumanReview ? " ⚠ review" : ""}  ${t.subject}`,
    );
  } catch (err) {
    failed++;
    console.error(`  #${id}  FAILED: ${err instanceof Error ? err.message : err}`);
  }
}

console.log(`\nDone. scored=${scored} skipped=${skipped} failed=${failed}.`);
console.log("Worst-first rewrite targets are in the `rewrite_queue` view and the review app.");

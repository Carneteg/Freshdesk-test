// scripts/replay.ts — run CLOSED tickets through the pipeline and PRINT the
// result next to what the agent actually sent. Posts NOTHING (CLAUDE.md §6 Step 4).
//
// First run: start with 5 tickets. The chosen ids + subjects are printed before
// anything is sent to the LLM, so you can confirm the sample (CLAUDE.md §12).
//
//   deno task replay 1001 1002 1003 1004 1005
//   REPLAY_TICKET_IDS=1001,1002,1003 deno task replay
//
// Note: replaying real closed tickets sends real customer content to the LLM
// provider (OpenAI). The DPA position is confirmed OK for Gate 1 (CLAUDE.md §11).

import { createClient } from "npm:@supabase/supabase-js@2";
import { Freshdesk, LLM } from "../supabase/functions/ticket-suggester/clients.ts";
import {
  classifyUsage,
  firstAgentReply,
  similarity,
  ticketBeforeFirstAgentReply,
} from "../supabase/functions/ticket-suggester/render.ts";
import { runPipeline, toRow } from "../supabase/functions/ticket-suggester/pipeline.ts";

function env(name: string): string {
  const v = Deno.env.get(name) ?? "";
  if (!v) {
    console.error(`missing required env var: ${name}`);
    Deno.exit(1);
  }
  return v;
}

const raw = Deno.args.length
  ? Deno.args
  : (Deno.env.get("REPLAY_TICKET_IDS") ?? "").split(",");
const ids = raw.map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);

if (!ids.length) {
  console.error("Usage: deno task replay <ticketId> [ticketId ...]   (or REPLAY_TICKET_IDS=1,2,3)");
  console.error("Tip: start with 5 CLOSED tickets whose correct answer you already know.");
  Deno.exit(1);
}
if (ids.length > 5) {
  console.warn(`\n⚠  ${ids.length} tickets requested. CLAUDE.md §12 says start with 5. Review first.\n`);
}

const fd = new Freshdesk(env("FRESHDESK_DOMAIN"), env("FRESHDESK_API_KEY"));
const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o";
const llm = new LLM(env("OPENAI_API_KEY"), model);
const withRetrieval = (Deno.env.get("WITH_RETRIEVAL") ?? "true") !== "false";
const excludeCategories = (Deno.env.get("EXCLUDE_SOLUTION_CATEGORIES") ?? "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// Optional: persist results to `suggestions` so you can set verdicts + read
// gate1_scorecard. Upsert on (ticket_id, trigger_message_id) so re-runs update
// the row and never clobber a verdict you've set (verdict isn't in the payload).
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const db = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey) : null;
console.log(
  db
    ? "(persisting each result to Supabase `suggestions` — set verdicts there)\n"
    : "(not persisting — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to save results)\n",
);

// Show which tickets before sending anything to OpenAI.
console.log("Tickets to replay (nothing will be posted):\n");
const tickets = [];
for (const id of ids) {
  try {
    const t = await fd.ticketWithConversations(id);
    tickets.push(t);
    console.log(`  #${t.id}  [status ${t.status}]  ${t.subject}`);
  } catch (err) {
    console.error(`  #${id}  FAILED to load: ${err instanceof Error ? err.message : err}`);
  }
}
console.log("");

for (const t of tickets) {
  const bar = "─".repeat(76);
  try {
    // Cold start (CLAUDE.md §6 Step 4): reason over the ticket as it stood just
    // before the agent's FIRST reply — the customer's opening request, nothing
    // after. This mirrors a freshly assigned live ticket and avoids grading the
    // trivial "thanks, it worked" turn at the end of a resolved thread. Compare
    // against the substantive first reply the agent actually sent.
    const view = ticketBeforeFirstAgentReply(t);
    const s = await runPipeline({ fd, llm, model, withRetrieval, excludeCategories }, view);
    const actual = firstAgentReply(t);
    const sim = similarity(s.draft ?? "", actual);
    const used = classifyUsage(sim);

    if (db) {
      const { error } = await db.from("suggestions").upsert(
        toRow(s, { used, similarity: sim }),
        { onConflict: "ticket_id,trigger_message_id" },
      );
      if (error) console.error(`  (db save failed for #${t.id}: ${error.message})`);
    }

    console.log(bar);
    console.log(`#${t.id}  ${t.subject}`);
    console.log(
      `type=${s.ticket_type}  confidence=${s.confidence}  Q/A=${s.qa_answered}/${s.qa_total}  ` +
        `language=${s.language}  ${s.latency_ms}ms`,
    );
    if (s.keywords.length) console.log(`keywords: ${s.keywords.join(", ")}`);
    console.log(`usage: ${used} (similarity ${sim} vs the agent's real reply)`);
    if (s.sources.length) {
      console.log("sources:");
      for (const x of s.sources) console.log(`  - ${x.title} [${x.ref}] ${x.url ?? ""}`);
    } else {
      console.log("sources: none");
    }
    console.log("\nREPLY TO CUSTOMER:\n" + (s.draft ?? "(no send-ready reply yet)"));
    if (s.resolution_steps.length) {
      console.log("\nHOW TO RESOLVE (for the agent):\n  - " + s.resolution_steps.join("\n  - "));
    }
    if (s.agent_analysis) console.log("\nAI ANALYSIS (for the agent):\n" + s.agent_analysis);
    if (s.rationale) console.log("\nWHY (rationale):\n" + s.rationale);
    if (s.follow_up_questions.length) {
      console.log("\nFOLLOW-UP QUESTIONS:\n  - " + s.follow_up_questions.join("\n  - "));
    }
    if (s.bug_guidance.repro_steps.length) {
      console.log("\nREPRO (agent):\n  - " + s.bug_guidance.repro_steps.join("\n  - "));
    }
    if (s.bug_guidance.customer_steps.length) {
      console.log("\nCUSTOMER STEPS:\n  - " + s.bug_guidance.customer_steps.join("\n  - "));
    }
    console.log("\nACTUALLY SENT BY AGENT:\n" + (actual || "(none found)"));
    console.log("");
  } catch (err) {
    console.log(bar);
    console.log(`#${t.id}  ${t.subject}`);
    console.error("PIPELINE ERROR:", err instanceof Error ? err.message : err);
    console.log("");
  }
}

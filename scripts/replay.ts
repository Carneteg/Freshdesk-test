// scripts/replay.ts — run CLOSED tickets through the pipeline and PRINT the
// result next to what the agent actually sent. Posts NOTHING (CLAUDE.md §6 Step 4).
//
// First run: start with 5 tickets. The chosen ids + subjects are printed before
// anything is sent to Anthropic, so you can confirm the sample (CLAUDE.md §12).
//
//   deno task replay 1001 1002 1003 1004 1005
//   REPLAY_TICKET_IDS=1001,1002,1003 deno task replay
//
// Note: replaying real closed tickets sends real customer content to Anthropic.
// The DPA position is confirmed OK for Gate 1 (CLAUDE.md §11).

import { Claude, Freshdesk } from "../supabase/functions/ticket-suggester/clients.ts";
import {
  classifyUsage,
  lastAgentReply,
  similarity,
} from "../supabase/functions/ticket-suggester/render.ts";
import { runPipeline } from "../supabase/functions/ticket-suggester/index.ts";

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
const model = Deno.env.get("CLAUDE_MODEL") ?? "claude-sonnet-5";
const claude = new Claude(env("ANTHROPIC_API_KEY"), model);
const withRetrieval = (Deno.env.get("WITH_RETRIEVAL") ?? "true") !== "false";

// Show which tickets before sending anything to Anthropic.
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
    const s = await runPipeline({ fd, claude, model, withRetrieval }, t);
    const actual = lastAgentReply(t);
    const sim = similarity(s.draft ?? "", actual);
    const used = classifyUsage(sim);

    console.log(bar);
    console.log(`#${t.id}  ${t.subject}`);
    console.log(
      `confidence=${s.confidence}  Q/A=${s.qa_answered}/${s.qa_total}  ` +
        `language=${s.language}  ${s.latency_ms}ms`,
    );
    console.log(`usage: ${used} (similarity ${sim} vs the agent's real reply)`);
    if (s.sources.length) {
      console.log("sources:");
      for (const x of s.sources) console.log(`  - ${x.title} [${x.ref}] ${x.url ?? ""}`);
    } else {
      console.log("sources: none");
    }
    console.log("\nSUGGESTED:\n" + (s.draft ?? "(no confident answer)"));
    if (s.rationale) console.log("\nWHY (rationale):\n" + s.rationale);
    console.log("\nACTUALLY SENT BY AGENT:\n" + (actual || "(none found)"));
    console.log("");
  } catch (err) {
    console.log(bar);
    console.log(`#${t.id}  ${t.subject}`);
    console.error("PIPELINE ERROR:", err instanceof Error ? err.message : err);
    console.log("");
  }
}

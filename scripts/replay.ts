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
  isIgnorableTicket,
  replayTurn,
  similarity,
} from "../supabase/functions/ticket-suggester/render.ts";
import { loadIncidents, runPipeline, toRow } from "../supabase/functions/ticket-suggester/pipeline.ts";

function env(name: string): string {
  const v = Deno.env.get(name) ?? "";
  if (!v) {
    console.error(`missing required env var: ${name}`);
    Deno.exit(1);
  }
  return v;
}

const fd = new Freshdesk(env("FRESHDESK_DOMAIN"), env("FRESHDESK_API_KEY"));

const raw = Deno.args.length
  ? Deno.args
  : (Deno.env.get("REPLAY_TICKET_IDS") ?? "").split(",");
let ids = raw.map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);

// No ids given → auto-pick a chosen agent's recent CLOSED tickets so the
// evaluation is easy to scale (CLAUDE.md §6 Step 4). REPLAY_AGENT selects WHO
// (name, email, or numeric id); defaults to MY_AGENT_ID. Uses Freshdesk's
// field-based filter (free-text search returns 400 — see clients.ts).
if (!ids.length) {
  const count = Number(Deno.env.get("REPLAY_COUNT") ?? "10");
  const sel = (Deno.env.get("REPLAY_AGENT") ?? Deno.env.get("MY_AGENT_ID") ?? "").trim();
  if (!sel) {
    console.error("Usage: deno task replay <ticketId ...>   (or REPLAY_TICKET_IDS=1,2,3)");
    console.error("Or set REPLAY_AGENT (name / email / id) — or MY_AGENT_ID — to auto-pick closed tickets.");
    Deno.exit(1);
  }

  // Resolve the agent selector to a numeric id.
  let agentId = sel;
  if (!/^\d+$/.test(sel)) {
    try {
      const agent = await fd.findAgent(sel);
      if (!agent) {
        console.error(`No agent matched "${sel}". Try their exact email, or set REPLAY_AGENT to the numeric agent id.`);
        Deno.exit(1);
      }
      agentId = String(agent.id);
      console.log(`Matched agent "${agent.contact?.name}" (id ${agentId}, ${agent.contact?.email}).`);
    } catch (err) {
      console.error(`Agent lookup failed (${err instanceof Error ? err.message : err}) — needs admin API.`);
      console.error(`Set REPLAY_AGENT to the numeric agent id instead.`);
      Deno.exit(1);
    }
  }

  // Holdout support: REPLAY_EXCLUDE_IDS keeps the already-evaluated tickets out of
  // the auto-pick, so you can grab a FRESH set the playbook wasn't built from.
  const excludeIds = new Set(
    (Deno.env.get("REPLAY_EXCLUDE_IDS") ?? "")
      .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0),
  );
  try {
    // Paginate (call-logs + excluded ids removed) until we have enough fresh ones.
    const picked: number[] = [];
    for (let page = 1; page <= 10 && picked.length < count; page++) {
      const res = await fd.searchTickets(`status:5 AND agent_id:${agentId}`, page);
      if (!(res.results ?? []).length) break;
      for (const t of res.results ?? []) {
        if (!isIgnorableTicket(t.subject) && !excludeIds.has(t.id)) picked.push(t.id);
      }
    }
    ids = picked.slice(0, count);
    const exNote = excludeIds.size ? `, excluding ${excludeIds.size} id(s)` : "";
    console.log(`Auto-selected ${ids.length} recent CLOSED ticket(s) for agent ${agentId}${exNote}. Set REPLAY_COUNT to change.\n`);
  } catch (err) {
    console.error(`Auto-select failed (${err instanceof Error ? err.message : err}). Pass ticket ids explicitly.`);
    Deno.exit(1);
  }
  if (!ids.length) {
    console.error("No closed tickets found for that agent. Pass ticket ids explicitly.");
    Deno.exit(1);
  }
}
if (ids.length > 5) {
  console.warn(`\n⚠  ${ids.length} tickets. CLAUDE.md §12: start with 5, scale once it looks right.\n`);
}
const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o";
const llm = new LLM(env("OPENAI_API_KEY"), model);
const withRetrieval = (Deno.env.get("WITH_RETRIEVAL") ?? "true") !== "false";
const excludeCategories = (Deno.env.get("EXCLUDE_SOLUTION_CATEGORIES") ?? "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const excludeSubjects = (Deno.env.get("EXCLUDE_SUBJECTS") ?? "")
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

// Never handle auto-generated call-log/receipt tickets, even if passed explicitly.
const kept = tickets.filter((t) => !isIgnorableTicket(t.subject, excludeSubjects));
const dropped = tickets.length - kept.length;
if (dropped) {
  console.log(`\n(excluded ${dropped} call-log/receipt ticket(s) — not handled by this framework)`);
}

// Known-incidents playbook (knowledge layer) — only when Supabase is configured.
const incidents = db ? await loadIncidents(db) : [];
if (incidents.length) console.log(`(playbook: ${incidents.length} known incident(s) loaded)`);
console.log("");

for (const t of kept) {
  const bar = "─".repeat(76);
  try {
    // Exact dialogue-turn synchronisation (CLAUDE.md §6 Step 4; #84875, #84611):
    // pick ONE specific public agent reply — the first SUBSTANTIVE one, skipping
    // auto/holding acknowledgments — reason over the ticket as it stood strictly
    // BEFORE that turn (everything later hidden), and compare against THAT reply.
    const turn = replayTurn(t);
    const s = await runPipeline(
      {
        fd, llm, model, withRetrieval, excludeCategories, incidents,
        db: db ?? undefined,
        // No leakage: exclude past tickets resolved at/after the graded turn's time.
        retrievalBefore: turn.targetAt ?? undefined,
      },
      turn.view,
    );
    const actual = turn.target;
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
    // NOTE: text-overlap is a WEAK proxy — low overlap usually means the agent had a
    // concrete answer and the AI was generic, NOT that the AI was ignored. Judge on
    // cause + action + grounding (the verdict column), not this number.
    console.log(`text-overlap: ${sim} vs agent (weak proxy — judge cause/action/grounding, not this)`);
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
    const turnNote = turn.index < 0
      ? " (agent never replied publicly)"
      : turn.skipped
      ? ` (graded against agent reply #${turn.index + 1}; skipped ${turn.skipped} holding/auto reply(ies))`
      : ` (graded against the agent's first substantive reply)`;
    console.log("\nACTUALLY SENT BY AGENT" + turnNote + ":\n" + (actual || "(none found)"));
    console.log("");
  } catch (err) {
    console.log(bar);
    console.log(`#${t.id}  ${t.subject}`);
    console.error("PIPELINE ERROR:", err instanceof Error ? err.message : err);
    console.log("");
  }
}

// ticket-suggester — HTTP entrypoint + polling loop (CLAUDE.md §3).
//
// The importable pipeline lives in pipeline.ts; this file only loads config,
// runs one poll, and serves. It calls Deno.serve unconditionally, so nothing
// else should import this module — the replay harness imports pipeline.ts.
//
// Flow per run:
//   1. GET tickets updated recently; keep only responder_id == MY_AGENT_ID
//   2. skip any (ticket_id, trigger_message_id) already in `suggestions`
//   3. per ticket: analyse -> retrieve -> draft -> verify -> post note -> log
//   4. reconcile usage of earlier suggestions the agent has since replied to

import { createClient } from "npm:@supabase/supabase-js@2";
import { Freshdesk, LLM } from "./clients.ts";
import { PROMPT_VERSION } from "./prompts.ts";
import { deriveTags, isIgnorableTicket, latestCustomerMessage } from "./render.ts";
import { loadIncidents, reconcileUsage, runPipeline, toRow } from "./pipeline.ts";

// ── Config ────────────────────────────────────────────────────────────────────

interface Config {
  domain: string;
  apiKey: string;
  // The monitored agents (CLAUDE.md §12, 2026-07-23): MY_AGENT_ID is a comma-
  // separated list of numeric agent ids. Only these agents' tickets are ever
  // touched. Gate 1 started single-agent (§9); this widens it to a small, named set.
  myAgentIds: number[];
  expectedName: string;
  openaiKey: string;
  model: string;
  cronSecret: string;
  supabaseUrl: string;
  serviceKey: string;
  maxPerRun: number;
  lookbackMin: number;
  withRetrieval: boolean;
  excludeCategories: string[];
  excludeSubjects: string[];
  // Safety flag for the first live runs (CLAUDE.md §4: never run live before).
  // When true, the full pipeline runs and every suggestion is logged, but NO note
  // or tag is written to Freshdesk. Defaults to TRUE — posting must be turned on
  // deliberately with DRY_RUN=false, so a first deploy/cron can never surprise-post.
  dryRun: boolean;
  // Base URL of the `feedback` Edge Function — the note's 👍/✏️/👎 links point here.
  feedbackUrl: string;
}

// Derive the sibling `feedback` function URL from SUPABASE_URL, e.g.
// https://<ref>.supabase.co -> https://<ref>.functions.supabase.co/feedback.
// FEEDBACK_URL overrides it (e.g. a custom domain).
function deriveFeedbackUrl(supabaseUrl: string): string {
  const override = Deno.env.get("FEEDBACK_URL");
  if (override) return override;
  return supabaseUrl.replace(".supabase.co", ".functions.supabase.co") + "/feedback";
}

// Comma-separated env list -> lowercased, trimmed, non-empty.
function envList(name: string): string[] {
  return (Deno.env.get(name) ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// Comma-separated env list of positive integers (e.g. MY_AGENT_ID="123,456").
function numList(name: string): number[] {
  return (Deno.env.get(name) ?? "").split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function env(name: string): string {
  const v = Deno.env.get(name) ?? "";
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

function loadConfig(): Config {
  return {
    domain: env("FRESHDESK_DOMAIN"),
    apiKey: env("FRESHDESK_API_KEY"),
    myAgentIds: numList("MY_AGENT_ID"),
    expectedName: Deno.env.get("EXPECTED_AGENT_NAME") ?? "Tobias Carneteg",
    openaiKey: env("OPENAI_API_KEY"),
    model: Deno.env.get("OPENAI_MODEL") ?? "gpt-4o",
    cronSecret: env("CRON_SECRET"),
    supabaseUrl: env("SUPABASE_URL"),
    serviceKey: env("SUPABASE_SERVICE_ROLE_KEY"),
    maxPerRun: Number(Deno.env.get("MAX_PER_RUN") ?? "5"),
    lookbackMin: Number(Deno.env.get("LOOKBACK_MINUTES") ?? "5"),
    withRetrieval: (Deno.env.get("WITH_RETRIEVAL") ?? "true") !== "false",
    excludeCategories: envList("EXCLUDE_SOLUTION_CATEGORIES"),
    excludeSubjects: envList("EXCLUDE_SUBJECTS"),
    // Safe by default: post only when DRY_RUN is explicitly "false".
    dryRun: (Deno.env.get("DRY_RUN") ?? "true") !== "false",
    feedbackUrl: deriveFeedbackUrl(env("SUPABASE_URL")),
  };
}

function nameMatches(name: string | undefined, expected: string): boolean {
  const n = (name ?? "").toLowerCase();
  return expected.toLowerCase().split(/\s+/).every((part) => n.includes(part));
}

interface Summary {
  dry_run: boolean;
  scanned: number;
  mine: number;
  processed: number;
  posted: number;
  skipped: number;
  errors: number;
  usage_scored: number;
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function pollOnce(cfg: Config): Promise<Summary> {
  const fd = new Freshdesk(cfg.domain, cfg.apiKey);
  const llm = new LLM(cfg.openaiKey, cfg.model);
  const db = createClient(cfg.supabaseUrl, cfg.serviceKey);

  // Roles are decoupled (CLAUDE.md §12): the API key is a SERVICE account that
  // POSTS the notes; MY_AGENT_ID lists the monitored agents whose tickets we watch.
  // Safety ("never touch a colleague's ticket") is preserved by the poll filter +
  // responder_id re-check below, which only ever act on tickets whose responder is
  // one of the monitored agents.
  const service = await fd.me(); // throws on a bad key -> fail fast
  console.log(`posting as service account ${service.id} (${service.contact?.name})`);
  if (cfg.dryRun) {
    console.log("DRY_RUN is on — running the full pipeline and logging suggestions, but posting NO notes/tags to Freshdesk. Set DRY_RUN=false to enable posting.");
  }

  if (!cfg.myAgentIds.length) {
    throw new Error("refusing to run: MY_AGENT_ID must be one or more numeric agent ids (comma-separated)");
  }
  // Best-effort: log each monitored agent's name (so the logs show exactly who is
  // watched), and warn if none matches EXPECTED_AGENT_NAME. Needs admin-scoped API;
  // a failure only warns — the id filter still holds.
  let anyExpected = false;
  for (const id of cfg.myAgentIds) {
    try {
      const monitored = await fd.getAgent(id);
      const name = monitored.contact?.name ?? "(unknown)";
      console.log(`monitoring agent ${id} (${name})`);
      if (cfg.expectedName && nameMatches(name, cfg.expectedName)) anyExpected = true;
    } catch (e) {
      console.warn(`could not verify monitored agent ${id} (needs admin API): ${e instanceof Error ? e.message : e}`);
    }
  }
  if (cfg.expectedName && !anyExpected) {
    console.warn(`monitored-agent name check: none matched EXPECTED_AGENT_NAME ~"${cfg.expectedName}"`);
  }
  const monitoredIds = new Set(cfg.myAgentIds);

  // Team-curated known-incidents playbook, loaded once per run (knowledge layer).
  const incidents = await loadIncidents(db);

  const since = new Date(Date.now() - cfg.lookbackMin * 60_000).toISOString();
  const updated = await fd.listUpdatedTickets(since);
  // Only the monitored agent's tickets, and never auto-generated call-log/receipt
  // tickets (they carry no question — user decision 2026-07-22).
  const mine = updated
    .filter((t) => monitoredIds.has(t.responder_id ?? -1))
    .filter((t) => !isIgnorableTicket(t.subject, cfg.excludeSubjects));
  const summary: Summary = {
    dry_run: cfg.dryRun,
    scanned: updated.length,
    mine: mine.length,
    processed: 0,
    posted: 0,
    skipped: 0,
    errors: 0,
    usage_scored: 0,
  };

  for (const t of mine.slice(0, cfg.maxPerRun)) {
    const tStart = Date.now();
    try {
      const ticket = await fd.ticketWithConversations(t.id);

      // Second independent filter (CLAUDE.md §2): re-check the RELOADED ticket's
      // responder before doing anything. Never act on a ticket that isn't a
      // monitored agent's, even if the poll list was momentarily stale/reassigned.
      if (!monitoredIds.has(ticket.responder_id ?? -1)) {
        summary.skipped++;
        continue;
      }

      const { triggerId } = latestCustomerMessage(ticket);

      // Dedup on (ticket_id, trigger_message_id): a new customer reply re-triggers.
      const { data: existing } = await db
        .from("suggestions")
        .select("id")
        .eq("ticket_id", t.id)
        .eq("trigger_message_id", triggerId)
        .maybeSingle();
      if (existing) {
        summary.skipped++;
        continue;
      }

      const s = await runPipeline({
        fd,
        llm,
        model: cfg.model,
        withRetrieval: cfg.withRetrieval,
        excludeCategories: cfg.excludeCategories,
        incidents,
        db,
        feedbackUrl: cfg.feedbackUrl,
      }, ticket);

      // DRY_RUN: log the suggestion for inspection but write NOTHING to Freshdesk.
      // The two external writes (note, tags) are the only side effects, so gating
      // them here makes a live run fully observable without touching a ticket.
      const noteId = cfg.dryRun ? null : await fd.postPrivateNote(t.id, s.note_html);
      await db.from("suggestions").insert(toRow(s, { noteId }));
      summary.processed++;

      if (cfg.dryRun) continue; // logged; skip the ticket writes
      summary.posted++;

      // Visibility (CLAUDE.md §12): write up to 3 single-word keyword tags onto
      // the ticket, merged with its existing tags. A tag failure must not fail
      // the ticket — the note (the real deliverable) is already posted.
      const tags = deriveTags(s.keywords);
      if (tags.length) {
        try {
          await fd.setTags(t.id, Array.from(new Set([...(ticket.tags ?? []), ...tags])));
        } catch (e) {
          console.warn(`tag write failed for ${t.id}:`, e instanceof Error ? e.message : e);
        }
      }
    } catch (err) {
      // No silent failures (CLAUDE.md §10). Record the error against the ticket.
      summary.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`ticket ${t.id} failed:`, msg);
      try {
        await db.from("suggestions").insert({
          ticket_id: t.id,
          trigger_message_id: `error:${tStart}`,
          subject: t.subject ?? null,
          confidence: "none",
          prompt_version: PROMPT_VERSION,
          model: cfg.model,
          latency_ms: Date.now() - tStart,
          error: msg,
        });
      } catch { /* already counted; do not mask the original error */ }
    }
  }

  // Second responsibility: score usage of earlier suggestions the agent has now
  // replied to. Bounded, and failures here never affect the suggestion loop.
  try {
    summary.usage_scored = await reconcileUsage(fd, db);
  } catch (err) {
    console.error("usage reconciliation failed:", err instanceof Error ? err.message : err);
  }

  return summary;
}

// ── HTTP entrypoint ───────────────────────────────────────────────────────────
// pg_cron calls this every minute with the x-cron-secret header (custom auth,
// which is why the function is deployed with verify_jwt = false).

Deno.serve(async (req: Request) => {
  try {
    const cfg = loadConfig();
    if (req.headers.get("x-cron-secret") !== cfg.cronSecret) {
      return new Response("forbidden", { status: 403 });
    }
    const summary = await pollOnce(cfg);
    return Response.json({ ok: true, ...summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("poll failed:", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
});

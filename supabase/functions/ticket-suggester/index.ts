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
  myAgentId: string;
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
}

// Comma-separated env list -> lowercased, trimmed, non-empty.
function envList(name: string): string[] {
  return (Deno.env.get(name) ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
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
    myAgentId: env("MY_AGENT_ID"),
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
  };
}

function nameMatches(name: string | undefined, expected: string): boolean {
  const n = (name ?? "").toLowerCase();
  return expected.toLowerCase().split(/\s+/).every((part) => n.includes(part));
}

interface Summary {
  scanned: number;
  mine: number;
  processed: number;
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
  // POSTS the notes; MY_AGENT_ID is the monitored agent whose tickets we watch.
  // Safety ("never touch a colleague's ticket") is preserved by the poll filter +
  // responder_id re-check below, which only ever act on MY_AGENT_ID's tickets.
  const service = await fd.me(); // throws on a bad key -> fail fast
  console.log(`posting as service account ${service.id} (${service.contact?.name})`);

  if (!Number.isFinite(Number(cfg.myAgentId))) {
    throw new Error("refusing to run: MY_AGENT_ID is not set to a numeric agent id");
  }
  // Best-effort: confirm the monitored agent resolves to the expected person.
  // Needs admin-scoped API access; a failure only warns (the id filter still holds).
  try {
    const monitored = await fd.getAgent(Number(cfg.myAgentId));
    if (cfg.expectedName && !nameMatches(monitored.contact?.name, cfg.expectedName)) {
      console.warn(`monitored-agent name check: expected ~"${cfg.expectedName}", got "${monitored.contact?.name}"`);
    }
  } catch (e) {
    console.warn(`could not verify monitored agent ${cfg.myAgentId} (needs admin API): ${e instanceof Error ? e.message : e}`);
  }

  // Team-curated known-incidents playbook, loaded once per run (knowledge layer).
  const incidents = await loadIncidents(db);

  const since = new Date(Date.now() - cfg.lookbackMin * 60_000).toISOString();
  const updated = await fd.listUpdatedTickets(since);
  // Only the monitored agent's tickets, and never auto-generated call-log/receipt
  // tickets (they carry no question — user decision 2026-07-22).
  const mine = updated
    .filter((t) => t.responder_id === Number(cfg.myAgentId))
    .filter((t) => !isIgnorableTicket(t.subject, cfg.excludeSubjects));
  const summary: Summary = {
    scanned: updated.length,
    mine: mine.length,
    processed: 0,
    skipped: 0,
    errors: 0,
    usage_scored: 0,
  };

  for (const t of mine.slice(0, cfg.maxPerRun)) {
    const tStart = Date.now();
    try {
      const ticket = await fd.ticketWithConversations(t.id);
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
      }, ticket);
      const noteId = await fd.postPrivateNote(t.id, s.note_html);
      await db.from("suggestions").insert(toRow(s, { noteId }));
      summary.processed++;

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

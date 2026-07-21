// ticket-suggester — polling loop + pipeline + note rendering.
//
// Flow per run (CLAUDE.md §3):
//   1. GET tickets updated recently; keep only responder_id == MY_AGENT_ID
//   2. skip any (ticket_id, trigger_message_id) already in `suggestions`
//   3. per ticket: analyse -> retrieve -> draft -> verify -> post note -> log
//
// The pipeline (runPipeline) posts nothing; the caller decides. This lets the
// replay harness reuse the exact same code path with the posting step removed.

import { createClient } from "npm:@supabase/supabase-js@2";
import { Claude, Freshdesk, type Ticket } from "./clients.ts";
import { analysePrompt, draftPrompt, PROMPT_VERSION, type SourceDoc, verifyPrompt } from "./prompts.ts";
import {
  type Confidence,
  extractJSON,
  latestCustomerMessage,
  lower,
  renderNote,
  strip,
  stripQuotes,
} from "./render.ts";

// ── Parsed model outputs ──────────────────────────────────────────────────────

interface Analysis {
  language: string;
  questions_asked: string[];
  search_queries: string[];
}

interface Draft {
  confidence: Confidence;
  reply: string;
  claims: string[];
}

interface VerifyClaim {
  quote: string;
  status: "supported" | "unsupported" | "contradicted";
  reason: string;
}

interface VerifyResult {
  claims: VerifyClaim[];
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

export interface PipelineDeps {
  fd: Freshdesk;
  claude: Claude;
  model: string;
  withRetrieval: boolean;
}

export interface Suggestion {
  ticket_id: number;
  trigger_message_id: string;
  subject: string;
  language: string;
  confidence: Confidence;
  draft: string | null;
  questions: string[];
  search_queries: string[];
  sources: SourceDoc[];
  verify: VerifyResult | null;
  prompt_version: string;
  model: string;
  latency_ms: number;
  note_html: string;
  error: string | null;
}

async function analyse(deps: PipelineDeps, subject: string, customerText: string): Promise<Analysis> {
  const { system, user } = analysePrompt(subject, customerText);
  const out = await deps.claude.complete(system, [{ role: "user", content: user }], { maxTokens: 600 });
  const j = extractJSON<Partial<Analysis>>(out);
  return {
    language: j.language ?? "other",
    questions_asked: Array.isArray(j.questions_asked) ? j.questions_asked : [],
    search_queries: Array.isArray(j.search_queries) ? j.search_queries : [],
  };
}

async function retrieve(deps: PipelineDeps, queries: string[]): Promise<SourceDoc[]> {
  const seen = new Set<string>();
  const docs: SourceDoc[] = [];

  for (const q of queries.slice(0, 3)) {
    let solutions;
    try {
      solutions = await deps.fd.searchSolutions(q);
    } catch (_e) {
      // Endpoint is unverified (CLAUDE.md §7). A retrieval failure means "no
      // sources", never a crashed pipeline.
      continue;
    }
    for (const s of solutions.slice(0, 3)) {
      const ref = `kb:${s.id}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      const body = strip(s.description_text ?? s.description ?? "");
      docs.push({ ref, title: s.title ?? "(untitled)", text: body.slice(0, 1500) });
      if (docs.length >= 6) return docs;
    }
  }
  return docs;
  // NOTE: past-RESOLVED-ticket retrieval is deliberately NOT wired in yet.
  // CLAUDE.md §6 Step 3 requires checking ten resolved tickets first — if your
  // team resolves by phone or private note, past tickets teach the model nothing.
  // Add it here only after that check passes.
}

async function draftReply(
  deps: PipelineDeps,
  input: { subject: string; language: string; questions: string[]; sources: SourceDoc[] },
): Promise<Draft> {
  const { system, user } = draftPrompt(input);
  const out = await deps.claude.complete(system, [{ role: "user", content: user }], { maxTokens: 1500 });
  const j = extractJSON<Partial<Draft>>(out);
  const confidence: Confidence = j.confidence === "high" || j.confidence === "low" ? j.confidence : "none";
  return {
    confidence,
    reply: typeof j.reply === "string" ? j.reply : "",
    claims: Array.isArray(j.claims) ? j.claims : [],
  };
}

async function verifyDraft(deps: PipelineDeps, reply: string, sources: SourceDoc[]): Promise<VerifyResult> {
  const { system, user } = verifyPrompt({ reply, sources });
  const out = await deps.claude.complete(system, [{ role: "user", content: user }], { maxTokens: 1200 });
  const j = extractJSON<Partial<VerifyResult>>(out);
  return { claims: Array.isArray(j.claims) ? j.claims : [] };
}

// Analyse -> retrieve -> draft -> verify. Returns a Suggestion; posts nothing.
export async function runPipeline(deps: PipelineDeps, ticket: Ticket): Promise<Suggestion> {
  const start = Date.now();
  const { text: customerText, triggerId } = latestCustomerMessage(ticket);

  const a = await analyse(deps, ticket.subject, customerText);
  const sources = deps.withRetrieval ? await retrieve(deps, a.search_queries) : [];

  let draft = await draftReply(deps, {
    subject: ticket.subject,
    language: a.language,
    questions: a.questions_asked,
    sources,
  });

  // Verify only runs when there is something to check. It can only lower
  // confidence and never freely rewrites the reply (CLAUDE.md §12).
  let verify: VerifyResult | null = null;
  let unsupportedNote = "";
  if (draft.confidence !== "none" && draft.reply.trim()) {
    verify = await verifyDraft(deps, draft.reply, sources);
    const contradicted = verify.claims.filter((c) => c.status === "contradicted");
    const unsupported = verify.claims.filter((c) => c.status === "unsupported");

    if (contradicted.length) {
      // Confident nonsense caught: discard the draft, drop to "none".
      unsupportedNote = `Draft discarded: it contradicted the sources (${contradicted.length} statement(s)).`;
      draft = { confidence: "none", reply: "", claims: draft.claims };
    } else if (unsupported.length) {
      const cleaned = stripQuotes(draft.reply, unsupported.map((c) => c.quote));
      draft = { confidence: lower(draft.confidence), reply: cleaned, claims: draft.claims };
      unsupportedNote =
        `Confidence lowered: ${unsupported.length} statement(s) not found in the sources were removed.`;
    }
  }

  const note = renderNote({
    confidence: draft.confidence,
    draft: draft.reply,
    promptVersion: PROMPT_VERSION,
    searchQueries: a.search_queries,
    sources,
    unsupportedNote,
  });

  return {
    ticket_id: ticket.id,
    trigger_message_id: triggerId,
    subject: ticket.subject,
    language: a.language,
    confidence: draft.confidence,
    draft: draft.reply || null,
    questions: a.questions_asked,
    search_queries: a.search_queries,
    sources,
    verify,
    prompt_version: PROMPT_VERSION,
    model: deps.model,
    latency_ms: Date.now() - start,
    note_html: note,
    error: null,
  };
}

// ── Config ────────────────────────────────────────────────────────────────────

interface Config {
  domain: string;
  apiKey: string;
  myAgentId: string;
  expectedName: string;
  anthropicKey: string;
  model: string;
  cronSecret: string;
  supabaseUrl: string;
  serviceKey: string;
  maxPerRun: number;
  lookbackMin: number;
  withRetrieval: boolean;
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
    anthropicKey: env("ANTHROPIC_API_KEY"),
    model: Deno.env.get("CLAUDE_MODEL") ?? "claude-sonnet-5",
    cronSecret: env("CRON_SECRET"),
    supabaseUrl: env("SUPABASE_URL"),
    serviceKey: env("SUPABASE_SERVICE_ROLE_KEY"),
    maxPerRun: Number(Deno.env.get("MAX_PER_RUN") ?? "5"),
    lookbackMin: Number(Deno.env.get("LOOKBACK_MINUTES") ?? "5"),
    withRetrieval: (Deno.env.get("WITH_RETRIEVAL") ?? "true") !== "false",
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
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function pollOnce(cfg: Config): Promise<Summary> {
  const fd = new Freshdesk(cfg.domain, cfg.apiKey);
  const claude = new Claude(cfg.anthropicKey, cfg.model);
  const db = createClient(cfg.supabaseUrl, cfg.serviceKey);

  // Two independent identity checks (CLAUDE.md §12). Id mismatch is fatal so we
  // can never suggest on another agent's tickets; name mismatch is a warning.
  const agent = await fd.me();
  if (String(agent.id) !== cfg.myAgentId) {
    throw new Error(`refusing to run: /agents/me id ${agent.id} != MY_AGENT_ID ${cfg.myAgentId}`);
  }
  if (!nameMatches(agent.contact?.name, cfg.expectedName)) {
    console.warn(`agent name check: expected ~"${cfg.expectedName}", got "${agent.contact?.name}"`);
  }

  const since = new Date(Date.now() - cfg.lookbackMin * 60_000).toISOString();
  const updated = await fd.listUpdatedTickets(since);
  const mine = updated.filter((t) => t.responder_id === Number(cfg.myAgentId));
  const summary: Summary = { scanned: updated.length, mine: mine.length, processed: 0, skipped: 0, errors: 0 };

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

      const s = await runPipeline({ fd, claude, model: cfg.model, withRetrieval: cfg.withRetrieval }, ticket);
      const noteId = await fd.postPrivateNote(t.id, s.note_html);
      await db.from("suggestions").insert(toRow(s, noteId));
      summary.processed++;
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
  return summary;
}

function toRow(s: Suggestion, noteId: number | null) {
  return {
    ticket_id: s.ticket_id,
    trigger_message_id: s.trigger_message_id,
    subject: s.subject,
    language: s.language,
    confidence: s.confidence,
    draft: s.draft,
    note_id: noteId,
    questions: s.questions,
    search_queries: s.search_queries,
    sources: s.sources,
    verify: s.verify,
    prompt_version: s.prompt_version,
    model: s.model,
    latency_ms: s.latency_ms,
    error: s.error,
  };
}

// ── HTTP entrypoint ───────────────────────────────────────────────────────────
// Guarded so importing this module (tests, replay harness) does not start a server.

if (import.meta.main) {
  Deno.serve(async (req: Request) => {
    const cfg = loadConfig();
    if (req.headers.get("x-cron-secret") !== cfg.cronSecret) {
      return new Response("forbidden", { status: 403 });
    }
    try {
      const summary = await pollOnce(cfg);
      return Response.json({ ok: true, ...summary });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("poll failed:", msg);
      return Response.json({ ok: false, error: msg }, { status: 500 });
    }
  });
}

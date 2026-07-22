// The suggestion pipeline: analyse -> retrieve -> draft -> verify.
//
// Kept separate from index.ts (the HTTP entrypoint) so the replay harness and
// any caller can import runPipeline WITHOUT pulling in Deno.serve. index.ts is
// the only place that starts a server.

import { Freshdesk, LLM, type Ticket } from "./clients.ts";
import { analysePrompt, draftPrompt, PROMPT_VERSION, type SourceDoc, verifyPrompt } from "./prompts.ts";
import {
  type BugGuidance,
  classifyUsage,
  type Confidence,
  extractJSON,
  lastAgentReply,
  latestCustomerMessage,
  lower,
  renderNote,
  similarity,
  strip,
  stripQuotes,
} from "./render.ts";

// ── Parsed model outputs ──────────────────────────────────────────────────────

interface Analysis {
  language: string;
  ticket_type: string;
  keywords: string[];
  questions_asked: string[];
  search_queries: string[];
}

interface Coverage {
  question: string;
  answered: boolean;
}

interface Draft {
  confidence: Confidence;
  reply: string;
  claims: string[];
  rationale: string;
  coverage: Coverage[];
  follow_up_questions: string[];
  bug_guidance: BugGuidance;
}

interface VerifyClaim {
  quote: string;
  status: "supported" | "unsupported" | "contradicted";
  reason: string;
}

interface VerifyResult {
  claims: VerifyClaim[];
}

const TICKET_TYPES = ["question", "howto", "bug", "unclear"];

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

export interface PipelineDeps {
  fd: Freshdesk;
  llm: LLM;
  model: string;
  withRetrieval: boolean;
  // KB categories/folders to exclude from retrieval, lowercased (e.g. "expert no").
  excludeCategories: string[];
}

export interface Suggestion {
  ticket_id: number;
  ticket_url: string;
  trigger_message_id: string;
  subject: string;
  language: string;
  ticket_type: string;
  keywords: string[];
  confidence: Confidence;
  draft: string | null;
  questions: string[];
  search_queries: string[];
  sources: SourceDoc[];
  verify: VerifyResult | null;
  rationale: string | null;
  follow_up_questions: string[];
  bug_guidance: BugGuidance;
  qa_answered: number;
  qa_total: number;
  used: "used" | "partly" | "not" | null;
  similarity: number | null;
  prompt_version: string;
  model: string;
  latency_ms: number;
  note_html: string;
  error: string | null;
}

async function analyse(deps: PipelineDeps, subject: string, customerText: string): Promise<Analysis> {
  const { system, user } = analysePrompt(subject, customerText);
  const out = await deps.llm.complete(system, [{ role: "user", content: user }], { maxTokens: 700 });
  const j = extractJSON<Partial<Analysis>>(out);
  return {
    language: j.language ?? "other",
    ticket_type: TICKET_TYPES.includes(j.ticket_type ?? "") ? j.ticket_type! : "question",
    keywords: strList(j.keywords),
    questions_asked: strList(j.questions_asked),
    search_queries: strList(j.search_queries),
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

      // Skip excluded categories/folders (e.g. "Expert NO" — wrong market/language).
      const cat = (s.category_name ?? "").toLowerCase();
      const folder = (s.folder_name ?? "").toLowerCase();
      if (deps.excludeCategories.some((x) => cat.includes(x) || folder.includes(x))) {
        continue;
      }

      seen.add(ref);
      const body = strip(s.description_text ?? s.description ?? "");
      docs.push({
        ref,
        kind: "kb",
        id: s.id,
        title: s.title ?? "(untitled)",
        text: body.slice(0, 1500),
        url: deps.fd.articleUrl(s.id),
      });
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
  input: {
    subject: string;
    language: string;
    ticketType: string;
    questions: string[];
    customerText: string;
    sources: SourceDoc[];
  },
): Promise<Draft> {
  const { system, user } = draftPrompt(input);
  const out = await deps.llm.complete(system, [{ role: "user", content: user }], { maxTokens: 1800 });
  const j = extractJSON<Partial<Draft>>(out);
  const confidence: Confidence = j.confidence === "high" || j.confidence === "low" ? j.confidence : "none";
  return {
    confidence,
    reply: typeof j.reply === "string" ? j.reply : "",
    claims: strList(j.claims),
    rationale: typeof j.rationale === "string" ? j.rationale : "",
    coverage: Array.isArray(j.coverage)
      ? j.coverage.filter((c) => c && typeof c.question === "string").map((c) => ({
        question: c.question,
        answered: c.answered === true,
      }))
      : [],
    follow_up_questions: strList(j.follow_up_questions),
    bug_guidance: {
      repro_steps: strList(j.bug_guidance?.repro_steps),
      customer_steps: strList(j.bug_guidance?.customer_steps),
    },
  };
}

async function verifyDraft(deps: PipelineDeps, reply: string, sources: SourceDoc[]): Promise<VerifyResult> {
  const { system, user } = verifyPrompt({ reply, sources });
  const out = await deps.llm.complete(system, [{ role: "user", content: user }], { maxTokens: 1200 });
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
    ticketType: a.ticket_type,
    questions: a.questions_asked,
    customerText,
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
      draft = { ...draft, confidence: "none", reply: "" };
    } else if (unsupported.length) {
      const cleaned = stripQuotes(draft.reply, unsupported.map((c) => c.quote));
      draft = { ...draft, confidence: lower(draft.confidence), reply: cleaned };
      unsupportedNote =
        `Confidence lowered: ${unsupported.length} statement(s) not found in the sources were removed.`;
    }
  }

  // Q/A coverage: how many of the customer's questions the draft answers from
  // sources. Zero when the draft was discarded (confidence dropped to none).
  const qaTotal = draft.coverage.length || a.questions_asked.length;
  const qaAnswered = draft.confidence === "none"
    ? 0
    : draft.coverage.filter((c) => c.answered).length;

  const note = renderNote({
    confidence: draft.confidence,
    draft: draft.reply,
    rationale: draft.rationale,
    ticketType: a.ticket_type,
    followUpQuestions: draft.follow_up_questions,
    bugGuidance: draft.bug_guidance,
    promptVersion: PROMPT_VERSION,
    searchQueries: a.search_queries,
    sources,
    qaAnswered,
    qaTotal,
    unsupportedNote,
  });

  return {
    ticket_id: ticket.id,
    ticket_url: deps.fd.ticketUrl(ticket.id),
    trigger_message_id: triggerId,
    subject: ticket.subject,
    language: a.language,
    ticket_type: a.ticket_type,
    keywords: a.keywords,
    confidence: draft.confidence,
    draft: draft.reply || null,
    questions: a.questions_asked,
    search_queries: a.search_queries,
    sources,
    verify,
    rationale: draft.rationale || null,
    follow_up_questions: draft.follow_up_questions,
    bug_guidance: draft.bug_guidance,
    qa_answered: qaAnswered,
    qa_total: qaTotal,
    used: null, // filled later by usage reconciliation / replay
    similarity: null,
    prompt_version: PROMPT_VERSION,
    model: deps.model,
    latency_ms: Date.now() - start,
    note_html: note,
    error: null,
  };
}

export function toRow(
  s: Suggestion,
  extra: { noteId?: number | null; used?: string | null; similarity?: number | null } = {},
) {
  return {
    ticket_id: s.ticket_id,
    ticket_url: s.ticket_url,
    trigger_message_id: s.trigger_message_id,
    subject: s.subject,
    language: s.language,
    ticket_type: s.ticket_type,
    keywords: s.keywords,
    confidence: s.confidence,
    draft: s.draft,
    note_id: extra.noteId ?? null,
    questions: s.questions,
    search_queries: s.search_queries,
    sources: s.sources,
    verify: s.verify,
    rationale: s.rationale,
    follow_up_questions: s.follow_up_questions,
    bug_guidance: s.bug_guidance,
    qa_answered: s.qa_answered,
    qa_total: s.qa_total,
    used: extra.used ?? s.used,
    similarity: extra.similarity ?? s.similarity,
    prompt_version: s.prompt_version,
    model: s.model,
    latency_ms: s.latency_ms,
    error: s.error,
  };
}

// Usage capture (CLAUDE.md §12): for suggestions we posted but haven't yet
// scored, check whether the agent has since sent a public reply; if so, compare
// it to our draft and record used / partly / not + the similarity. Bounded per
// run so it never dominates the poll budget.
export async function reconcileUsage(
  fd: Freshdesk,
  // deno-lint-ignore no-explicit-any
  db: any,
): Promise<number> {
  const { data: pending } = await db
    .from("suggestions")
    .select("id, ticket_id, draft, created_at")
    .is("used", null)
    .not("note_id", "is", null)
    .not("draft", "is", null)
    .order("created_at", { ascending: false })
    .limit(20);

  let scored = 0;
  for (const row of pending ?? []) {
    try {
      const ticket = await fd.ticketWithConversations(row.ticket_id);
      const outgoing = (ticket.conversations ?? []).filter((c) => !c.incoming && !c.private);
      const newest = outgoing.length ? outgoing[outgoing.length - 1] : null;
      // Only score once the agent has actually replied after our note.
      if (!newest || newest.created_at <= row.created_at) continue;
      const sim = similarity(row.draft ?? "", lastAgentReply(ticket));
      await db.from("suggestions").update({ used: classifyUsage(sim), similarity: sim }).eq("id", row.id);
      scored++;
    } catch { /* transient — try again next run */ }
  }
  return scored;
}

// The suggestion pipeline: analyse -> retrieve -> draft -> verify.
//
// Kept separate from index.ts (the HTTP entrypoint) so the replay harness and
// any caller can import runPipeline WITHOUT pulling in Deno.serve. index.ts is
// the only place that starts a server.

import { Freshdesk, LLM, type Ticket } from "./clients.ts";
import {
  ANSWER_STRATEGIES,
  analysePrompt,
  draftPrompt,
  PROMPT_VERSION,
  type SourceDoc,
  verifyPrompt,
} from "./prompts.ts";
import {
  type BugGuidance,
  buildContext,
  classifyUsage,
  type Confidence,
  containsFalseSystemAccess,
  extractJSON,
  lastAgentReply,
  latestCustomerMessage,
  looksLikeAutoReply,
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
  detected_intent: string;
  keywords: string[];
  questions_asked: string[];
  search_queries: string[];
  security_sensitive: boolean;
  facts_from_customer: string[];
  facts_from_agent: string[];
  facts_from_internal_notes: string[];
  system_messages: string[];
  unknowns: string[];
  unanswered_agent_question: string;
  latest_customer_is_auto_reply: boolean;
}

interface Coverage {
  question: string;
  answered: boolean;
}

interface Draft {
  answer_strategy: string;
  confidence: Confidence;
  confidence_reason: string;
  reply: string;
  agent_next_action: string;
  requires_manual_system_check: boolean;
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
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
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
  detected_intent: string;
  keywords: string[];
  answer_strategy: string;
  confidence: Confidence;
  confidence_reason: string | null;
  draft: string | null;
  agent_next_action: string | null;
  requires_manual_system_check: boolean;
  security_sensitive: boolean;
  facts: Record<string, string[]>;
  unknowns: string[];
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

async function analyse(deps: PipelineDeps, subject: string, context: string): Promise<Analysis> {
  const { system, user } = analysePrompt(subject, context);
  const out = await deps.llm.complete(system, [{ role: "user", content: user }], { maxTokens: 1100 });
  const j = extractJSON<Partial<Analysis>>(out);
  return {
    language: j.language ?? "other",
    ticket_type: TICKET_TYPES.includes(j.ticket_type ?? "") ? j.ticket_type! : "question",
    detected_intent: str(j.detected_intent),
    keywords: strList(j.keywords),
    questions_asked: strList(j.questions_asked),
    search_queries: strList(j.search_queries),
    security_sensitive: j.security_sensitive === true,
    facts_from_customer: strList(j.facts_from_customer),
    facts_from_agent: strList(j.facts_from_agent),
    facts_from_internal_notes: strList(j.facts_from_internal_notes),
    system_messages: strList(j.system_messages),
    unknowns: strList(j.unknowns),
    unanswered_agent_question: str(j.unanswered_agent_question),
    latest_customer_is_auto_reply: j.latest_customer_is_auto_reply === true,
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
  // NOTE: past-RESOLVED-ticket retrieval is deliberately NOT wired in yet (§6 Step 3).
}

async function draftReply(
  deps: PipelineDeps,
  input: { subject: string; language: string; context: string; analysisJson: string; sources: SourceDoc[] },
): Promise<Draft> {
  const { system, user } = draftPrompt(input);
  const out = await deps.llm.complete(system, [{ role: "user", content: user }], { maxTokens: 1800 });
  const j = extractJSON<Partial<Draft>>(out);
  const confidence: Confidence = j.confidence === "high" || j.confidence === "low" ? j.confidence : "none";
  const strategy = (ANSWER_STRATEGIES as readonly string[]).includes(j.answer_strategy ?? "")
    ? j.answer_strategy!
    : "ABSTAIN";
  return {
    answer_strategy: strategy,
    confidence,
    confidence_reason: str(j.confidence_reason),
    reply: str(j.reply),
    agent_next_action: str(j.agent_next_action),
    requires_manual_system_check: j.requires_manual_system_check === true,
    claims: strList(j.claims),
    rationale: str(j.rationale),
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

async function verifyDraft(
  deps: PipelineDeps,
  reply: string,
  sources: SourceDoc[],
  context: string,
): Promise<VerifyResult> {
  const { system, user } = verifyPrompt({ reply, sources, context });
  const out = await deps.llm.complete(system, [{ role: "user", content: user }], { maxTokens: 1200 });
  const j = extractJSON<Partial<VerifyResult>>(out);
  return { claims: Array.isArray(j.claims) ? j.claims : [] };
}

// Analyse -> retrieve -> draft -> verify. Returns a Suggestion; posts nothing.
export async function runPipeline(deps: PipelineDeps, ticket: Ticket): Promise<Suggestion> {
  const start = Date.now();
  const { triggerId } = latestCustomerMessage(ticket);
  const context = buildContext(ticket); // FULL chronological, source-labelled context

  const a = await analyse(deps, ticket.subject, context);

  // Deterministic override: if the latest customer message is an auto/OOO reply,
  // it is NOT a real answer to any open agent question.
  const incoming = (ticket.conversations ?? [])
    .filter((c) => c.incoming && !c.private)
    .sort((x, y) => x.created_at.localeCompare(y.created_at));
  const latestCustomer = incoming.length ? (incoming[incoming.length - 1].body_text ?? "") : (ticket.description_text ?? "");
  a.latest_customer_is_auto_reply = a.latest_customer_is_auto_reply || looksLikeAutoReply(latestCustomer);

  const sources = deps.withRetrieval ? await retrieve(deps, a.search_queries) : [];

  const analysisJson = JSON.stringify(
    {
      detected_intent: a.detected_intent,
      security_sensitive: a.security_sensitive,
      questions_asked: a.questions_asked,
      facts_from_customer: a.facts_from_customer,
      facts_from_agent: a.facts_from_agent,
      facts_from_internal_notes: a.facts_from_internal_notes,
      system_messages: a.system_messages,
      unknowns: a.unknowns,
      unanswered_agent_question: a.unanswered_agent_question,
      latest_customer_is_auto_reply: a.latest_customer_is_auto_reply,
    },
    null,
    2,
  );

  let draft = await draftReply(deps, {
    subject: ticket.subject,
    language: a.language,
    context,
    analysisJson,
    sources,
  });

  // Verify against sources AND ticket context. Can only lower confidence / strip /
  // discard, never rewrite (CLAUDE.md §12).
  let verify: VerifyResult | null = null;
  let unsupportedNote = "";
  if (draft.confidence !== "none" && draft.reply.trim()) {
    verify = await verifyDraft(deps, draft.reply, sources, context);
    const contradicted = verify.claims.filter((c) => c.status === "contradicted");
    const unsupported = verify.claims.filter((c) => c.status === "unsupported");

    if (contradicted.length) {
      unsupportedNote = `Draft discarded: ${contradicted.length} statement(s) contradicted the sources/ticket.`;
      draft = { ...draft, confidence: "none", reply: "" };
    } else if (unsupported.length) {
      const cleaned = stripQuotes(draft.reply, unsupported.map((c) => c.quote));
      draft = { ...draft, confidence: lower(draft.confidence), reply: cleaned };
      unsupportedNote = `Confidence lowered: ${unsupported.length} statement(s) not grounded in the sources/ticket were removed.`;
    }
  }

  // Belt-and-suspenders: never let a reply claim direct system access (the AI has none).
  if (draft.reply && containsFalseSystemAccess(draft.reply)) {
    unsupportedNote = "Draft discarded: it claimed direct system access, which the AI does not have.";
    draft = { ...draft, confidence: "none", reply: "" };
  }

  const qaTotal = draft.coverage.length || a.questions_asked.length;
  const qaAnswered = draft.confidence === "none"
    ? 0
    : draft.coverage.filter((c) => c.answered).length;

  const facts = {
    from_customer: a.facts_from_customer,
    from_agent: a.facts_from_agent,
    from_internal_notes: a.facts_from_internal_notes,
    system_messages: a.system_messages,
  };

  const note = renderNote({
    confidence: draft.confidence,
    confidenceReason: draft.confidence_reason,
    draft: draft.reply,
    rationale: draft.rationale,
    ticketType: a.ticket_type,
    answerStrategy: draft.answer_strategy,
    agentNextAction: draft.agent_next_action,
    unknowns: a.unknowns,
    requiresManualCheck: draft.requires_manual_system_check,
    securitySensitive: a.security_sensitive,
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
    detected_intent: a.detected_intent,
    keywords: a.keywords,
    answer_strategy: draft.answer_strategy,
    confidence: draft.confidence,
    confidence_reason: draft.confidence_reason || null,
    draft: draft.reply || null,
    agent_next_action: draft.agent_next_action || null,
    requires_manual_system_check: draft.requires_manual_system_check,
    security_sensitive: a.security_sensitive,
    facts,
    unknowns: a.unknowns,
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
    detected_intent: s.detected_intent,
    keywords: s.keywords,
    answer_strategy: s.answer_strategy,
    confidence: s.confidence,
    confidence_reason: s.confidence_reason,
    draft: s.draft,
    agent_next_action: s.agent_next_action,
    requires_manual_system_check: s.requires_manual_system_check,
    security_sensitive: s.security_sensitive,
    facts: s.facts,
    unknowns: s.unknowns,
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
// it to our draft and record used / partly / not + the similarity.
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
      if (!newest || newest.created_at <= row.created_at) continue;
      const sim = similarity(row.draft ?? "", lastAgentReply(ticket));
      await db.from("suggestions").update({ used: classifyUsage(sim), similarity: sim }).eq("id", row.id);
      scored++;
    } catch { /* transient — try again next run */ }
  }
  return scored;
}

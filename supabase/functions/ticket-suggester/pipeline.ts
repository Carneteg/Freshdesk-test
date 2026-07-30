// The suggestion pipeline: analyse -> retrieve -> draft -> verify.
//
// Kept separate from index.ts (the HTTP entrypoint) so the replay harness and
// any caller can import runPipeline WITHOUT pulling in Deno.serve. index.ts is
// the only place that starts a server.

import { Freshdesk, HttpError, LLM, type Ticket } from "./clients.ts";
import { emailDomain, FreshworksCRM } from "./freshworks-crm.ts";
import { learnAccountMap, lookupAccountMap } from "./crm-account-map.ts";
import {
  analysePrompt,
  ANSWER_STRATEGIES,
  draftPrompt,
  type GoldExemplar,
  type Incident,
  PROMPT_VERSION,
  type SourceDoc,
  verifyPrompt,
} from "./prompts.ts";
import {
  buildQaCoachUserPrompt,
  QA_COACH_SYSTEM_PROMPT,
  QA_COACH_VERSION,
} from "./qa-system-prompt.ts";
import { QA_ASSESSMENT_JSON_SCHEMA } from "./qa-schema.ts";
import type { QaAssessment } from "./qa-types.ts";
import { validateAndNormalizeAssessment } from "./qa-validator.ts";
import {
  type BugGuidance,
  buildContext,
  classifyUsage,
  type CoachMode,
  type Confidence,
  type CustomerSubscriptionContext,
  containsFalseSystemAccess,
  deriveCoachMode,
  extractJSON,
  lastAgentReply,
  latestCustomerMessage,
  looksLikeAutoReply,
  lower,
  renderNote,
  similarity,
  strip,
  stripQuotes,
  stripSignaturePlaceholders,
} from "./render.ts";

// ── Parsed model outputs ──────────────────────────────────────────────────────

interface Analysis {
  language: string;
  ticket_type: string;
  detected_intent: string;
  keywords: string[];
  questions_asked: string[];
  latest_unresolved_request: string;
  search_queries: string[];
  security_sensitive: boolean;
  sensitive_action_request: boolean;
  sensitive_action_desc: string;
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
  resolution_steps: string[];
  required_customer_steps: string[];
  agent_analysis: string;
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
  missing_steps: string[];
  contradicts_analysis: string;
  unsafe_action: string;
}

const TICKET_TYPES = ["question", "howto", "bug", "unclear"];

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
type Db = any;

export interface PipelineDeps {
  fd: Freshdesk;
  // Optional, read-only Freshworks CRM subscription context. The returned
  // values are rendered directly in the private note and never sent to the LLM.
  crm?: FreshworksCRM;
  llm: LLM;
  model: string;
  withRetrieval: boolean;
  // KB categories/folders to exclude from retrieval, lowercased (e.g. "expert no").
  excludeCategories: string[];
  // Team-curated known incidents fed into the draft as an internal playbook.
  incidents?: Incident[];
  // Supabase client — enables the past-ticket semantic search (stage 2).
  db?: Db;
  // Search the past-ticket index for similar resolved tickets (default on when db set).
  withPastTickets?: boolean;
  // Replay only: only use past tickets resolved BEFORE this ISO time (no leakage).
  retrievalBefore?: string;
  // Base URL of the `feedback` Edge Function. When set, the note carries one-click
  // verdict links (legacy fallback only). New live notes use reviewUrl.
  feedbackUrl?: string;
  // Authenticated review-app URL. generationId is added as a safe deep-link hash.
  reviewUrl?: string;
  generationId?: number;
  // Execution variant is part of the immutable generation identity.
  runVariant?: string;
  // Learning loop (Gate 2, §12): feed reviewer-written ideal answers from OTHER
  // tickets into the draft as style/approach exemplars. Off by default; when on,
  // the stored prompt_version gets a "+gold" suffix so the scorecard A/Bs the lift.
  withLearning?: boolean;
  goldExemplars?: LoadedExemplar[];
  // Cost tiering (§ cost optimisation): run the mechanical calls (analyse, verify)
  // on a cheaper model, keeping the DRAFT on the main model. Off by default (undefined
  // → everything uses the main model, so output/PROMPT_VERSION are unchanged).
  tierModel?: string;
  // QA coach model override — the offline scorer is a secondary signal, so it can run
  // cheaper. Undefined → uses the main model.
  qaModel?: string;
}

// A gold answer loaded from the corpus, with its ticket id so the current ticket's
// own answer is never fed back into generating it (no leakage).
export interface LoadedExemplar extends GoldExemplar {
  ticket_id: number;
}

export interface Suggestion {
  ticket_id: number;
  ticket_url: string;
  trigger_message_id: string;
  customer_message: string;
  conversation_context: string;
  latest_unresolved_request: string;
  subject: string;
  language: string;
  ticket_type: string;
  detected_intent: string;
  keywords: string[];
  answer_strategy: string;
  confidence: Confidence;
  coach_mode: CoachMode;
  confidence_reason: string | null;
  draft: string | null;
  resolution_steps: string[];
  agent_analysis: string | null;
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
  run_variant: string;
  latency_ms: number;
  customer_subscriptions: CustomerSubscriptionContext | null;
  note_html: string;
  feedback_token: string | null;
  error: string | null;
}

async function analyse(
  deps: PipelineDeps,
  subject: string,
  context: string,
): Promise<Analysis> {
  const { system, user } = analysePrompt(subject, context);
  // Mechanical classification — safe to run on the cheaper tier model when set.
  const out = await deps.llm.complete(system, [{ role: "user", content: user }], {
    maxTokens: 1100,
    model: deps.tierModel,
  });
  const j = extractJSON<Partial<Analysis>>(out);
  return {
    language: j.language ?? "other",
    ticket_type: TICKET_TYPES.includes(j.ticket_type ?? "") ? j.ticket_type! : "question",
    detected_intent: str(j.detected_intent),
    keywords: strList(j.keywords),
    questions_asked: strList(j.questions_asked),
    latest_unresolved_request: str(j.latest_unresolved_request),
    search_queries: strList(j.search_queries),
    security_sensitive: j.security_sensitive === true,
    sensitive_action_request: j.sensitive_action_request === true,
    sensitive_action_desc: str(j.sensitive_action_desc),
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
    // A provider failure is not the same thing as "no matching article". Let the
    // outbox record/retry the generation instead of fabricating a KB gap.
    const solutions = await deps.fd.searchSolutions(q);
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
}

// Stage 2: semantic search of our own past-ticket index. Embeds the current
// ticket's question and pulls the nearest RESOLVED tickets as `ticket` sources,
// so the draft can reference how a similar case was actually handled. Fail-safe:
// no db, no embedding, or an empty/unsynced index all just mean "no past tickets".
async function retrievePastTickets(
  deps: PipelineDeps,
  queryText: string,
  excludeId?: number,
): Promise<SourceDoc[]> {
  if (!deps.db || !queryText.trim()) return [];
  const embedding = await deps.llm.embed(queryText);
  if (!embedding.length) throw new Error("past-ticket embedding returned no vector");
  const { data, error } = await deps.db.rpc("match_past_tickets", {
    query_embedding: embedding,
    match_count: 3,
    min_similarity: 0.35,
    // No leakage: never cite the ticket being answered, and (in replay) never a
    // ticket resolved after this one's reply time.
    exclude_ticket_id: excludeId ?? null,
    before_ts: deps.retrievalBefore ?? null,
  });
  if (error) throw new Error(`past-ticket retrieval failed: ${error.message}`);
  return (data ?? [])
    .filter((r: { resolution?: string | null }) => r && r.resolution)
    .map((r: { ticket_id: number; subject?: string; resolution: string }) => ({
      ref: `ticket:${r.ticket_id}`,
      kind: "ticket" as const,
      id: r.ticket_id,
      title: r.subject ?? `Ticket #${r.ticket_id}`,
      text: strip(String(r.resolution)).slice(0, 1200),
      url: deps.fd.ticketUrl(r.ticket_id),
    }));
}

async function draftReply(
  deps: PipelineDeps,
  input: {
    subject: string;
    language: string;
    context: string;
    analysisJson: string;
    sources: SourceDoc[];
    incidents: Incident[];
    exemplars?: GoldExemplar[];
  },
): Promise<Draft> {
  const { system, user } = draftPrompt(input);
  const out = await deps.llm.complete(system, [{ role: "user", content: user }], {
    maxTokens: 2200,
  });
  const j = extractJSON<Partial<Draft>>(out);
  const confidence: Confidence = j.confidence === "high" || j.confidence === "low"
    ? j.confidence
    : "none";
  const strategy =
    (ANSWER_STRATEGIES as readonly string[]).includes(j.answer_strategy ?? "")
      ? j.answer_strategy!
      : "ABSTAIN";
  return {
    answer_strategy: strategy,
    confidence,
    confidence_reason: str(j.confidence_reason),
    reply: str(j.reply),
    resolution_steps: strList(j.resolution_steps),
    required_customer_steps: strList(j.required_customer_steps),
    agent_analysis: str(j.agent_analysis),
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
  requiredCustomerSteps: string[],
  agentAnalysis: string,
  sensitiveAction: string,
): Promise<VerifyResult> {
  const { system, user } = verifyPrompt({
    reply,
    sources,
    context,
    requiredCustomerSteps,
    agentAnalysis,
    sensitiveAction,
  });
  // Claim-checking is mechanical — safe on the cheaper tier model when set.
  const out = await deps.llm.complete(system, [{ role: "user", content: user }], {
    maxTokens: 1200,
    model: deps.tierModel,
  });
  const j = extractJSON<Partial<VerifyResult>>(out);
  return {
    claims: Array.isArray(j.claims) ? j.claims : [],
    missing_steps: strList(j.missing_steps),
    contradicts_analysis: str(j.contradicts_analysis),
    unsafe_action: str(j.unsafe_action),
  };
}

// Analyse -> retrieve -> draft -> verify. Returns a Suggestion; posts nothing.
export async function runPipeline(
  deps: PipelineDeps,
  ticket: Ticket,
): Promise<Suggestion> {
  const start = Date.now();
  const { triggerId, text: customerMessage } = latestCustomerMessage(ticket);
  const context = buildContext(ticket); // FULL chronological, source-labelled context
  // Independent of generation: start the verified CRM lookup in parallel, but
  // contain every failure so a temporary CRM issue never suppresses the required
  // Freshdesk private note. Do not log the requester email, company name, or API
  // response. Resolution order:
  //   0. crm_account_map — deterministic (curated or learned), no fuzziness;
  //   1-3. the client's matching ladder (contact email → company name stem →
  //        email domain; ambiguity = "check manually");
  //   after a contact-email match, the map LEARNS the company/domain keys so the
  //   next ticket from this customer resolves deterministically.
  // The Freshdesk company GET is lazy — it only happens when the email tier missed.
  const companyId = ticket.company_id;
  const crm = deps.crm;
  const customerSubscriptions = crm
    ? (async () => {
      const requesterEmail = ticket.requester?.email ?? ticket.email;
      // Freemail domains come back null — they are never a mapping key.
      const domain = requesterEmail ? emailDomain(requesterEmail) : null;
      const mapKey = { companyId, domain };
      // Map failures are contained separately: a broken map must degrade to the
      // ladder, not to `unavailable`.
      const mapped = deps.db
        ? await lookupAccountMap(deps.db, mapKey).catch(() => null)
        : null;
      if (mapped) return await crm.subscriptionsForKnownAccount(mapped.accountId);

      const result = await crm.subscriptionsForCustomer({
        requesterEmail,
        companyName: companyId
          ? () =>
            deps.fd.company(companyId)
              .then((c) => c.name ?? null)
              .catch((error) => {
                // A missing company (404) just skips the tier. Transport errors
                // (429/5xx/timeouts) must propagate to the outer catch and render
                // `unavailable` — "no company checked" must never be reported as
                // the confident "no CRM account could be matched".
                if (error instanceof HttpError && error.status === 404) return null;
                throw error;
              })
          : null,
      });
      if (
        deps.db && result.status === "found" &&
        result.matchedBy === "contact_email" && result.accountId
      ) {
        // Learning is best-effort — never let a map write fail the lookup.
        await learnAccountMap(deps.db, mapKey, result.accountId).catch(() => {});
      }
      return result;
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `Freshworks CRM subscription lookup failed for ticket ${ticket.id}: ${
          message.replace(/\s+/g, " ").slice(0, 300)
        }`,
      );
      return { status: "unavailable" as const, subscriptions: [] };
    })
    : Promise.resolve(undefined);
  // Legacy one-click feedback only. New notes use the authenticated review app and
  // therefore need no bearer-like write token in the URL.
  const feedbackToken = deps.feedbackUrl && !deps.reviewUrl ? crypto.randomUUID() : null;

  const a = await analyse(deps, ticket.subject, context);

  // Deterministic override: if the latest customer message is an auto/OOO reply,
  // it is NOT a real answer to any open agent question.
  const incoming = (ticket.conversations ?? [])
    .filter((c) => c.incoming && !c.private)
    .sort((x, y) => x.created_at.localeCompare(y.created_at));
  const latestCustomer = incoming.length
    ? (incoming[incoming.length - 1].body_text ?? "")
    : (ticket.description_text ?? "");
  a.latest_customer_is_auto_reply = a.latest_customer_is_auto_reply ||
    looksLikeAutoReply(latestCustomer);

  const kbSources = deps.withRetrieval ? await retrieve(deps, a.search_queries) : [];
  // Similar RESOLVED past tickets (stage 2) — listed first as they show real
  // resolutions. Default on whenever a db is available.
  const wantPast = deps.withPastTickets ?? Boolean(deps.db);
  const pastSources = wantPast
    ? await retrievePastTickets(
      deps,
      `${ticket.subject}\n${a.questions_asked.join("\n")}`,
      ticket.id,
    )
    : [];
  const sources = [...pastSources, ...kbSources];

  const analysisJson = JSON.stringify(
    {
      detected_intent: a.detected_intent,
      security_sensitive: a.security_sensitive,
      sensitive_action_request: a.sensitive_action_request,
      sensitive_action_desc: a.sensitive_action_desc,
      questions_asked: a.questions_asked,
      latest_unresolved_request: a.latest_unresolved_request,
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

  // Learning loop (§12): reviewer-written ideal answers from OTHER tickets, fed in
  // as style/approach exemplars. Exclude this ticket's own gold answer (no leakage).
  const exemplars: GoldExemplar[] = deps.withLearning
    ? (deps.goldExemplars ?? [])
      .filter((e) => e.ticket_id !== ticket.id)
      .filter((e) => !e.language || e.language === a.language)
      .slice(0, 4)
      .map((e) => ({
        subject: e.subject,
        language: e.language,
        gold_answer: e.gold_answer,
      }))
    : [];
  // A/B tag: a learning run is a distinct prompt_version so the scorecard shows the
  // lift on the SAME tickets, "…c" vs "…c+gold".
  const effectiveVersion = PROMPT_VERSION + (exemplars.length ? "+gold" : "");

  let draft = await draftReply(deps, {
    subject: ticket.subject,
    language: a.language,
    context,
    analysisJson,
    sources,
    incidents: deps.incidents ?? [],
    exemplars,
  });

  // Verify against sources AND ticket context. Can only lower confidence / strip /
  // discard, never rewrite (CLAUDE.md §12).
  let verify: VerifyResult | null = null;
  let unsupportedNote = "";
  let notSendReady = false;
  if (draft.confidence !== "none" && draft.reply.trim()) {
    verify = await verifyDraft(
      deps,
      draft.reply,
      sources,
      context,
      draft.required_customer_steps,
      draft.agent_analysis,
      a.sensitive_action_request
        ? a.sensitive_action_desc || "an irreversible/sensitive action"
        : "",
    );
    const contradicted = verify.claims.filter((c) => c.status === "contradicted");
    const unsupported = verify.claims.filter((c) => c.status === "unsupported");

    if (contradicted.length) {
      unsupportedNote =
        `Draft discarded: ${contradicted.length} statement(s) contradicted the sources/ticket.`;
      draft = { ...draft, confidence: "none", reply: "" };
    } else if (unsupported.length) {
      const cleaned = stripQuotes(draft.reply, unsupported.map((c) => c.quote));
      draft = { ...draft, confidence: lower(draft.confidence), reply: cleaned };
      unsupportedNote =
        `Confidence lowered: ${unsupported.length} statement(s) not grounded in the sources/ticket were removed.`;
    }

    // Send-ready gate (user rule): every required customer step must be in the reply.
    // If any is missing, the reply is NOT send-ready — cap confidence and say what's
    // missing, so a "thanks, let us know" reply can't pass while omitting the action.
    const missing = verify.missing_steps ?? [];
    if (draft.reply.trim() && missing.length) {
      notSendReady = true;
      draft = {
        ...draft,
        confidence: draft.confidence === "high" ? "low" : draft.confidence,
      };
      unsupportedNote = [
        unsupportedNote,
        `⚠️ NOT send-ready: the reply is missing required customer step(s): ${
          missing.join("; ")
        }. ` +
        `Add them before sending.`,
      ].filter(Boolean).join(" ");
    }

    // Consistency gate: the reply must not recommend/assert what the analysis ruled
    // out (mechanical version of the prompt rule — a prompt nudge wasn't enough, cf. #86002).
    const contradiction = (verify.contradicts_analysis ?? "").trim();
    if (draft.reply.trim() && contradiction) {
      notSendReady = true;
      draft = {
        ...draft,
        confidence: draft.confidence === "high" ? "low" : draft.confidence,
      };
      unsupportedNote = [
        unsupportedNote,
        `⚠️ Reply contradicts the analysis: ${contradiction}. Fix before sending.`,
      ].filter(Boolean).join(" ");
    }

    // BLOCKING SECURITY GATE (priority #1, cf. #85081): an irreversible / sensitive
    // action — account or data deletion, user removal, access change, data export —
    // must NEVER be recommended in a customer reply unless the ticket text establishes
    // all four safeguards (verified identity, account relationship, authority, exact
    // object). This is a HARD block, not a confidence nudge: discard the customer draft
    // entirely and hand the judgement back to the agent. A confirmed account alone is
    // not sufficient support for deletion. The gate fires only when analysis flagged a
    // sensitive action AND verify found the reply crossing the line, so a properly
    // hedged "verify identity first" reply is never blocked.
    const unsafe = (verify.unsafe_action ?? "").trim();
    if (a.sensitive_action_request && draft.reply.trim() && unsafe) {
      notSendReady = true;
      unsupportedNote = [
        unsupportedNote,
        `⛔ BLOCKED (safety): the reply recommends a sensitive/irreversible action without ` +
        `verified identity, account relationship, authority and the exact object — ${unsafe}. ` +
        `These must be verified before any such action; a confirmed account alone is not enough.`,
      ].filter(Boolean).join(" ");
      draft = { ...draft, confidence: "none", reply: "" };
    }
  }

  // Belt-and-suspenders: never let a reply claim direct system access (the AI has none).
  if (draft.reply && containsFalseSystemAccess(draft.reply)) {
    unsupportedNote =
      "Draft discarded: it claimed direct system access, which the AI does not have.";
    draft = { ...draft, confidence: "none", reply: "" };
  }

  // Tone guard: strip any signature placeholder the model left in the reply — the
  // agent signs with their own name (CLAUDE.md quality bar).
  if (draft.reply) {
    draft = { ...draft, reply: stripSignaturePlaceholders(draft.reply) };
  }

  const qaTotal = draft.coverage.length || a.questions_asked.length;
  // A reply that isn't send-ready (missing a required step) answers nothing yet —
  // this fixes the Q/A=1/1 that hid the missing action (QA feedback #85844).
  const qaAnswered = (draft.confidence === "none" || notSendReady)
    ? 0
    : draft.coverage.filter((c) => c.answered).length;

  const facts = {
    from_customer: a.facts_from_customer,
    from_agent: a.facts_from_agent,
    from_internal_notes: a.facts_from_internal_notes,
    system_messages: a.system_messages,
  };

  // Fas 3.1: classify into REPLY_READY / COACH_AGENT / AGENT_ACTION_REQUIRED,
  // deterministically from the now-resolved signals (after every verify gate).
  const coachMode: CoachMode = deriveCoachMode({
    answerStrategy: draft.answer_strategy,
    confidence: draft.confidence,
    hasReply: !!(draft.reply && draft.reply.trim()),
    requiresManualCheck: draft.requires_manual_system_check,
    sensitiveActionRequest: a.sensitive_action_request,
    resolutionStepCount: draft.resolution_steps.length,
  });

  const resolvedCustomerSubscriptions = await customerSubscriptions;
  const note = renderNote({
    confidence: draft.confidence,
    coachMode,
    confidenceReason: draft.confidence_reason,
    draft: draft.reply,
    rationale: draft.rationale,
    ticketType: a.ticket_type,
    answerStrategy: draft.answer_strategy,
    agentAnalysis: draft.agent_analysis,
    resolutionSteps: draft.resolution_steps,
    unknowns: a.unknowns,
    requiresManualCheck: draft.requires_manual_system_check,
    securitySensitive: a.security_sensitive,
    followUpQuestions: draft.follow_up_questions,
    bugGuidance: draft.bug_guidance,
    promptVersion: effectiveVersion,
    searchQueries: a.search_queries,
    sources,
    qaAnswered,
    qaTotal,
    unsupportedNote,
    customerSubscriptions: resolvedCustomerSubscriptions,
    reviewUrl: deps.reviewUrl
      ? `${deps.reviewUrl.replace(/#.*$/, "")}#generation=${
        deps.generationId ?? ticket.id
      }`
      : undefined,
    feedbackUrl: deps.feedbackUrl,
    feedbackToken: feedbackToken ?? undefined,
  });

  return {
    ticket_id: ticket.id,
    ticket_url: deps.fd.ticketUrl(ticket.id),
    trigger_message_id: triggerId,
    customer_message: customerMessage,
    conversation_context: context,
    latest_unresolved_request: a.latest_unresolved_request,
    subject: ticket.subject,
    language: a.language,
    ticket_type: a.ticket_type,
    detected_intent: a.detected_intent,
    keywords: a.keywords,
    answer_strategy: draft.answer_strategy,
    confidence: draft.confidence,
    coach_mode: coachMode,
    confidence_reason: draft.confidence_reason || null,
    draft: draft.reply || null,
    resolution_steps: draft.resolution_steps,
    agent_analysis: draft.agent_analysis || null,
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
    prompt_version: effectiveVersion,
    model: deps.model,
    run_variant: deps.runVariant ?? "unspecified",
    latency_ms: Date.now() - start,
    customer_subscriptions: resolvedCustomerSubscriptions ?? null,
    note_html: note,
    feedback_token: feedbackToken,
    error: null,
  };
}

// ── QA COACH (offline eval-scorer, CLAUDE.md §12 "mode A") ─────────────────────

export interface QaResult {
  version: string;
  assessment: QaAssessment;
}

// Render the retrieved sources as plain text so the QA judge sees EXACTLY what the
// draft was grounded in — no more, no less. Kept local to avoid exporting the
// pipeline's private source formatting.
function qaSourcesBlock(sources: SourceDoc[]): string {
  if (!sources.length) {
    return "(no knowledge-base sources were retrieved for this ticket)";
  }
  return sources
    .map((s, i) => `[${i + 1}] ${s.title} (${s.ref})\n${s.text}`)
    .join("\n\n");
}

// Score ONE reply against the 7-criterion rubric. The judge is handed only what is
// passed in (customer message + the SAME context/sources the draft had) — it never
// fetches product facts on its own, so it cannot credit a reply for information the
// agent never held. Structured output means no fragile JSON parsing, and the package's
// validator RECOMPUTES weighted points / total / verdict / review-flag in TypeScript
// (the model only proposes them) so the arithmetic can't drift. Returns null on any
// failure — QA scoring is an evaluation aid and must never crash a replay run.
export async function runQaCoach(
  deps: PipelineDeps,
  input: {
    customerMessage: string;
    ticketContext: string;
    agentReply: string;
    requirements?: string;
    languageOverride?: string;
  },
): Promise<QaResult | null> {
  if (!input.agentReply.trim()) return null; // nothing to score (e.g. an abstain)
  try {
    const raw = await deps.llm.completeSchema<QaAssessment>(
      QA_COACH_SYSTEM_PROMPT,
      buildQaCoachUserPrompt(input),
      QA_ASSESSMENT_JSON_SCHEMA,
      { maxTokens: 2000, model: deps.qaModel },
    );
    // Deterministic recompute of the math + verdict from the model's raw scores.
    const assessment = validateAndNormalizeAssessment(raw);
    return { version: QA_COACH_VERSION, assessment };
  } catch (err) {
    // Never fail silently (CLAUDE.md §10): surface WHY the scorer produced nothing
    // (e.g. an OpenAI auth/model error) so it is visible in the run log, not hidden
    // behind a bare "scorer returned nothing".
    console.error(
      `QA coach scoring failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// Convenience: score a pipeline Suggestion's own draft using the ticket context and
// the sources the pipeline already retrieved. `agentReply` overrides the reply to
// judge (e.g. to score what the agent ACTUALLY sent instead of the AI draft).
export function qaScoreDraft(
  deps: PipelineDeps,
  ticket: Ticket,
  s: Suggestion,
  agentReply?: string,
): Promise<QaResult | null> {
  const context = buildContext(ticket);
  const ticketContext = [
    "TICKET CONTEXT (chronological):",
    context,
    "",
    "RETRIEVED KNOWLEDGE-BASE / PAST-TICKET SOURCES:",
    qaSourcesBlock(s.sources),
  ].join("\n");
  return runQaCoach(deps, {
    customerMessage: latestCustomerMessage(ticket).text,
    ticketContext,
    agentReply: agentReply ?? (s.draft ?? ""),
  });
}

export function toRow(
  s: Suggestion,
  extra: {
    noteId?: number | null;
    used?: string | null;
    similarity?: number | null;
    qa?: QaResult | null;
    agentSentReply?: string | null;
  } = {},
) {
  const qa = extra.qa ?? null;
  return {
    ticket_id: s.ticket_id,
    ticket_url: s.ticket_url,
    trigger_message_id: s.trigger_message_id,
    customer_message: s.customer_message,
    conversation_context: s.conversation_context,
    latest_unresolved_request: s.latest_unresolved_request,
    subject: s.subject,
    language: s.language,
    ticket_type: s.ticket_type,
    detected_intent: s.detected_intent,
    keywords: s.keywords,
    answer_strategy: s.answer_strategy,
    confidence: s.confidence,
    coach_mode: s.coach_mode,
    confidence_reason: s.confidence_reason,
    draft: s.draft,
    resolution_steps: s.resolution_steps,
    agent_analysis: s.agent_analysis,
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
    // QA Coach (offline eval-scorer) — null when not run or nothing to score.
    qa_version: qa?.version ?? null,
    qa_score: qa?.assessment.totalScore ?? null,
    qa_verdict: qa?.assessment.verdict ?? null,
    qa_needs_review: qa?.assessment.needsHumanReview ?? null,
    qa_assessment: qa?.assessment ?? null,
    // The reply the agent actually sent (replay only) — reference/gold for training.
    ...(extra.agentSentReply !== undefined
      ? { agent_sent_reply: extra.agentSentReply }
      : {}),
    used: extra.used ?? s.used,
    similarity: extra.similarity ?? s.similarity,
    prompt_version: s.prompt_version,
    model: s.model,
    run_variant: s.run_variant,
    latency_ms: s.latency_ms,
    customer_subscriptions: s.customer_subscriptions,
    note_html: s.note_html,
    feedback_token: s.feedback_token,
    error: s.error,
  };
}

// Load the active known-incidents playbook (knowledge layer stage 1). A failure
// or missing table just means "no playbook" — never a crashed pipeline.
export async function loadIncidents(
  // deno-lint-ignore no-explicit-any
  db: any,
): Promise<Incident[]> {
  const { data, error } = await db
    .from("known_incidents")
    .select(
      "title, symptoms, resolution, routing, status, affected, workaround, customer_action, fix_released_at, post_fix_instructions",
    )
    .eq("active", true)
    .limit(50);
  if (error) throw new Error(`known-incident retrieval failed: ${error.message}`);
  return (data ?? []) as Incident[];
}

// Load the reviewer-written ideal answers (the "what good looks like" corpus) for
// the learning loop (§12). A failure or empty corpus just means "no exemplars".
// Gold answers on HOLDOUT tickets are excluded (scaling plan Fas 2.1 / migration 25):
// the locked test set must never leak into generation as a few-shot exemplar.
export async function loadGoldExemplars(
  // deno-lint-ignore no-explicit-any
  db: any,
  limit = 20,
): Promise<LoadedExemplar[]> {
  // Learn ONLY from the locked learning cohort. Development is for tuning and
  // holdout is for final measurement; neither may become a prompt exemplar.
  const learning = new Set<number>();
  const { data: cohorts, error: cohortError } = await db.from("ticket_cohorts")
    .select("ticket_id").eq("cohort", "learning");
  if (cohortError) {
    throw new Error(`learning-cohort lookup failed: ${cohortError.message}`);
  }
  for (const r of cohorts ?? []) learning.add(r.ticket_id);
  if (!learning.size) return [];

  const { data, error } = await db
    .from("suggestions")
    .select("ticket_id, subject, language, gold_answer")
    .not("gold_answer", "is", null)
    .order("gold_answer_at", { ascending: false })
    .limit(Math.max(limit * 5, limit));
  if (error) throw new Error(`gold-exemplar retrieval failed: ${error.message}`);
  return (data ?? [])
    .filter((r: { ticket_id: number; gold_answer?: string }) =>
      r.gold_answer && r.gold_answer.trim() && learning.has(r.ticket_id)
    )
    .slice(0, limit)
    .map((
      r: {
        ticket_id: number;
        subject?: string;
        language?: string | null;
        gold_answer: string;
      },
    ) => ({
      ticket_id: r.ticket_id,
      subject: r.subject ?? `Ticket #${r.ticket_id}`,
      language: r.language ?? null,
      gold_answer: r.gold_answer,
    }));
}

// Usage capture (CLAUDE.md §12): for suggestions we posted but haven't yet
// scored, check whether the agent has since sent a public reply; if so, compare
// it to our draft and record used / partly / not + the similarity.
export async function reconcileUsage(
  fd: Freshdesk,
  // deno-lint-ignore no-explicit-any
  db: any,
): Promise<number> {
  const { data: pending, error: pendingError } = await db
    .from("suggestions")
    .select("id, ticket_id, draft, created_at")
    .is("used", null)
    .not("note_id", "is", null)
    .not("draft", "is", null)
    .order("created_at", { ascending: false })
    .limit(20);
  if (pendingError) throw new Error(`usage lookup failed: ${pendingError.message}`);

  let scored = 0;
  for (const row of pending ?? []) {
    try {
      const ticket = await fd.ticketWithConversations(row.ticket_id);
      const outgoing = (ticket.conversations ?? []).filter((c) =>
        !c.incoming && !c.private
      );
      const newest = outgoing.length ? outgoing[outgoing.length - 1] : null;
      if (!newest || newest.created_at <= row.created_at) continue;
      const sim = similarity(row.draft ?? "", lastAgentReply(ticket));
      const { error } = await db.from("suggestions")
        .update({ used: classifyUsage(sim), similarity: sim })
        .eq("id", row.id);
      if (error) throw new Error(error.message);
      scored++;
    } catch (err) {
      console.error(
        `usage row ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return scored;
}

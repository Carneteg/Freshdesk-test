// Pure functions: no I/O, no external imports. Kept separate so they can be
// unit-tested cheaply (CLAUDE.md §8) without pulling in the Supabase/network code.

import type { Ticket } from "./clients.ts";
import type { SourceDoc } from "./prompts.ts";

export type Confidence = "high" | "low" | "none";

export interface BugGuidance {
  repro_steps: string[]; // for the agent, to confirm the reported problem
  customer_steps: string[]; // safe step-by-step for the customer to try
}

// Parse the first JSON object out of a model response. Models sometimes wrap it
// in prose or ```json fences — grab the outermost { ... }.
export function extractJSON<T = unknown>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON object found in model output");
  }
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}

// HTML -> plain text. Used on KB/ticket bodies before they go into a prompt.
export function strip(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Escape text for safe inclusion in the note's HTML body.
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Confidence can only ever be lowered by the verify step (CLAUDE.md §12).
export function lower(c: Confidence): Confidence {
  return c === "high" ? "low" : c === "low" ? "low" : "none";
}

// ── Usage capture ─────────────────────────────────────────────────────────────
// Did the agent actually use our suggestion? Compare our draft to the reply they
// eventually sent. Word-set Jaccard: cheap, explainable, language-agnostic.

function tokenize(s: string): string[] {
  return strip(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

export function similarity(a: string, b: string): number {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const union = A.size + B.size - inter;
  return union ? Number((inter / union).toFixed(3)) : 0;
}

// Thresholds are a first cut — tune once real data lands.
export function classifyUsage(sim: number): "used" | "partly" | "not" {
  if (sim >= 0.6) return "used";
  if (sim >= 0.25) return "partly";
  return "not";
}

// Up to `max` single-word, lowercase tags derived from the analyse keywords, for
// writing onto the Freshdesk ticket (CLAUDE.md §12). One word per tag: the first
// token of each keyword, punctuation stripped, deduped.
export function deriveTags(keywords: string[], max = 3): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const kw of keywords) {
    const first = (kw ?? "").trim().split(/\s+/)[0] ?? "";
    const tag = first.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 32);
    if (tag.length < 2 || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

// Remove verbatim quotes (verify's "unsupported" statements) from the draft,
// then tidy up the whitespace and orphaned punctuation left behind.
export function stripQuotes(text: string, quotes: string[]): string {
  let out = text;
  for (const q of quotes) {
    if (q && out.includes(q)) out = out.split(q).join("");
  }
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The latest customer message defines the dedup key (§12): a newer one => a new
// suggestion. Returns the text to reason over plus the trigger id to store.
export function latestCustomerMessage(t: Ticket): { text: string; triggerId: string } {
  const incoming = (t.conversations ?? [])
    .filter((c) => c.incoming && !c.private)
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const parts = [t.description_text ?? "", ...incoming.map((c) => c.body_text ?? "")];
  const newest = incoming.length ? incoming[incoming.length - 1] : null;

  return {
    text: parts.filter((p) => p.trim()).join("\n\n").slice(0, 8000),
    triggerId: newest ? `conv:${newest.id}` : `desc:${t.id}`,
  };
}

// The last reply the agent actually sent — used by the replay harness to compare
// the suggestion against reality (CLAUDE.md §8).
export function lastAgentReply(t: Ticket): string {
  const outgoing = (t.conversations ?? []).filter((c) => !c.incoming && !c.private);
  return outgoing.length ? (outgoing[outgoing.length - 1].body_text ?? "") : "";
}

// Auto-generated call-log / receipt tickets (e.g. "Incoming call with +47…") carry
// no customer question — the phone integration logs them and the agent just closes
// them. They must NEVER be processed by this framework (user decision 2026-07-22).
// Matched by subject; EXCLUDE_SUBJECTS (lowercased substrings) adds more.
const CALL_LOG_SUBJECT = /^\s*(incoming|outgoing|missed) call with\b/i;

// Auto-reply / out-of-office bounces (replies to our own marketing/notification
// mails) also carry no customer question — they were polluting the eval as
// `unclear` noise (user report 2026-07-23). Match the standard mailer prefixes in
// EN / NO / SV. These are the subject prefixes mail clients prepend automatically.
const AUTO_REPLY_SUBJECT =
  /^\s*(automatic reply|automatisk svar|automatiskt svar|autosvar|out of office|out-of-office|frånvaro|fr[aå]nvarande|ute av kontoret|auto[- ]?reply|feriesvar|semestersvar|fraværsmelding|fraværsassistent|semesterhälsning)\b/i;

// Replies to our OWN Simployer Expert MARKETING campaigns (e.g. an out-of-office
// bounce whose subject is just "Re: <campaign tagline>", so it has no auto-reply
// prefix — user report on #86174). These campaign taglines are outbound-only, so
// any inbound ticket carrying one is noise. Matched ANYWHERE in the subject.
// NOTE: deliberately the full taglines, not "simployer expert" alone — real
// tickets like "Tilgang til Simployer Expert" must NOT be dropped.
const MARKETING_SUBJECT = [
  "det sier mye om deg at du bruker simployer expert",
  "smarte måter å få mer ut av simployer expert",
  "dette venter på deg i simployer expert",
  "oppdag alt simployer expert har å tilby",
  "slik får du mest ut av simployer expert",
  "upptäck allt som simployer expert har att erbjuda",
];

export function isIgnorableTicket(
  subject: string,
  extraSubstrings: string[] = [],
): boolean {
  const s = subject ?? "";
  if (CALL_LOG_SUBJECT.test(s) || AUTO_REPLY_SUBJECT.test(s)) return true;
  const lower = s.toLowerCase();
  if (MARKETING_SUBJECT.some((m) => lower.includes(m))) return true;
  return extraSubstrings.some((x) => x && lower.includes(x));
}

// Timestamp of the trigger message — the latest incoming customer message, or
// null when the first reply is on the ticket description. Used only to split a
// closed ticket into "what the agent saw" vs "the future".
function triggerTime(t: Ticket): string | null {
  const incoming = (t.conversations ?? [])
    .filter((c) => c.incoming && !c.private)
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  return incoming.length ? incoming[incoming.length - 1].created_at : null;
}

// REPLAY ONLY (CLAUDE.md §6 Step 4). Reconstruct the ticket as it stood right
// after the latest customer message: every later entry — the agent's actual
// answer and any follow-up notes — is removed, so the model cannot "cheat" by
// reading the resolution of an already-closed ticket. The live pipeline never
// calls this; it always reasons over the full, still-open ticket.
export function ticketAsOfLatestCustomer(t: Ticket): Ticket {
  const cut = triggerTime(t);
  // No incoming message → the first reply is on the description; drop every
  // conversation entry (they are all post-trigger). Otherwise keep entries up to
  // and including the trigger message.
  const conversations = (t.conversations ?? []).filter((c) =>
    cut ? c.created_at <= cut : false
  );
  return { ...t, conversations };
}

// REPLAY ONLY. The reply the agent actually sent in response to the latest
// customer message — the first public outgoing message after the trigger, which
// is the fair comparison target for "would I have sent this?". Falls back to the
// last agent reply when timestamps can't separate before/after.
export function agentReplyToLatestCustomer(t: Ticket): string {
  const cut = triggerTime(t);
  const outgoing = (t.conversations ?? [])
    .filter((c) => !c.incoming && !c.private)
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (cut) {
    const after = outgoing.find((c) => c.created_at > cut);
    if (after) return after.body_text ?? "";
  }
  return outgoing.length ? (outgoing[outgoing.length - 1].body_text ?? "") : "";
}

// The agent's FIRST public reply — the substantive "cold start" answer the live
// tool would face on a freshly assigned ticket. Empty if the agent never replied
// publicly.
export function firstAgentReply(t: Ticket): string {
  const outgoing = (t.conversations ?? [])
    .filter((c) => !c.incoming && !c.private)
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  return outgoing.length ? (outgoing[0].body_text ?? "") : "";
}

// When the agent's first reply was sent — the simulated "reply time" for replay.
// Used to exclude past tickets that were only resolved AFTER this one (no leakage).
export function firstAgentReplyAt(t: Ticket): string | null {
  const outgoing = (t.conversations ?? [])
    .filter((c) => !c.incoming && !c.private)
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  return outgoing.length ? outgoing[0].created_at : null;
}

// REPLAY ONLY (cold start). The ticket as it stood just before the agent's FIRST
// public reply: the customer's opening request (plus any pre-reply notes),
// nothing after. This mirrors what the live scheduler actually sees on a newly
// assigned ticket, and avoids grading trivial end-of-thread pleasantries. If the
// agent never replied, the whole ticket is kept (there is nothing to hide).
export function ticketBeforeFirstAgentReply(t: Ticket): Ticket {
  const outgoing = (t.conversations ?? [])
    .filter((c) => !c.incoming && !c.private)
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const firstReplyAt = outgoing.length ? outgoing[0].created_at : null;
  const conversations = (t.conversations ?? []).filter((c) =>
    firstReplyAt ? c.created_at < firstReplyAt : true
  );
  return { ...t, conversations };
}

// Holding / acknowledgment replies ("Hi, we're looking into it, we'll get back to
// you") are NOT the substantive answer. In replay they must not be the turn we grade
// against — the AI writes a real coaching reply, so comparing it to a filler line is
// the wrong-turn bug (#84875, #84611). A reply that ASKS something concrete (contains
// "?") is substantive and never counts as holding. Crucially these are WAIT phrases,
// not greetings: "thanks for reaching out" alone is a greeting that often precedes a
// real answer, so it is NOT here — only a short reply whose substance is a promise to
// come back later is skipped.
const HOLDING_HINTS = [
  "looking into",
  "look into this",
  "we'll get back",
  "get back to you",
  "investigating this",
  "working on it",
  "we are on it",
  "ser på saken",
  "ser paa saken",
  "ser nærmere",
  "ser naermere",
  "återkommer",
  "aterkommer",
  "vi undersöker",
  "vi undersoker",
  "vi kollar",
  "kommer tilbake",
  "undersøker",
  "undersoker",
  "vi kikker",
  "vi ser på det",
  "vi ser paa det",
];

export function looksLikeHoldingReply(text: string): boolean {
  const t = strip(text).toLowerCase();
  if (!t) return true; // an empty public reply is not a real turn
  if (t.includes("?")) return false; // asks something concrete → substantive
  return t.length < 200 && HOLDING_HINTS.some((h) => t.includes(h));
}

// REPLAY ONLY (CLAUDE.md §6 Step 4). Exact dialogue-turn synchronisation (#84875,
// #84611): pick ONE specific public agent reply as the grading target — the first
// SUBSTANTIVE one, skipping auto/out-of-office and short holding acknowledgments —
// then reconstruct the ticket as it stood strictly BEFORE that turn (every later
// customer message, agent reply and internal note hidden). The AI reasons over the
// view and is compared against `target`. If every reply is holding/auto, fall back
// to the first; if the agent never replied publicly, there is no turn to grade.
export interface ReplayTurn {
  view: Ticket; // the ticket as the agent saw it just before the target reply
  target: string; // the specific agent reply we grade the AI against
  targetAt: string | null; // its timestamp — also the retrieval cut-off (no leakage)
  index: number; // which public reply (0-based); -1 if the agent never replied
  skipped: number; // holding/auto replies skipped before the target
}

export function replayTurn(t: Ticket): ReplayTurn {
  const outgoing = (t.conversations ?? [])
    .filter((c) => !c.incoming && !c.private)
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  if (!outgoing.length) {
    return { view: { ...t }, target: "", targetAt: null, index: -1, skipped: 0 };
  }

  // First substantive public reply — skip auto-replies and holding acknowledgments
  // so we grade against the turn that actually answered.
  let idx = outgoing.findIndex(
    (c) =>
      !looksLikeAutoReply(c.body_text ?? "") && !looksLikeHoldingReply(c.body_text ?? ""),
  );
  if (idx === -1) idx = 0; // all holding/auto → fall back to the first reply

  const target = outgoing[idx];
  const cut = target.created_at;
  // Strictly before the target turn: hide the target itself and everything after it
  // (later customer/agent/internal), keep every earlier turn as real context.
  const conversations = (t.conversations ?? []).filter((c) => c.created_at < cut);
  return {
    view: { ...t, conversations },
    target: target.body_text ?? "",
    targetAt: target.created_at,
    index: idx,
    skipped: idx,
  };
}

// Out-of-office / automatic-absence detection. Such a reply must NOT be treated
// as the customer answering an agent's clarifying question.
const AUTO_REPLY_HINTS = [
  "out of office",
  "out-of-office",
  "automatic reply",
  "auto reply",
  "autoreply",
  "on vacation",
  "annual leave",
  "parental leave",
  "frånvaro",
  "franvaro",
  "semester",
  "autosvar",
  "är inte på kontoret",
  "föräldraledig",
  "sjukskriven",
  "fravær",
  "ferie",
  "jeg er tilbake",
  "ute av kontoret",
  "ikke til stede",
  "abwesenheit",
];

export function looksLikeAutoReply(text: string): boolean {
  const t = strip(text).toLowerCase();
  return t.length > 0 && AUTO_REPLY_HINTS.some((h) => t.includes(h));
}

// Belt-and-suspenders guard: the AI has NO system access, so it must never claim
// to have checked/verified/seen the customer's system. This catches the most
// explicit first-person phrasings if they slip past the prompt (NO/SV/EN/DA).
const FALSE_ACCESS_PATTERNS: RegExp[] = [
  /\bjag (kan )?ser? (i|att)[^.]*\b(system|konto|behörighet|roll)/i,
  /\bjag har (kontrollerat|verifierat|bekräftat|granskat)\b/i,
  /\bjeg (kan )?ser? (i|at)[^.]*\b(system|konto|tilgang|rolle|administrator)/i,
  /\bjeg har (kontrollert|verifisert|bekreftet|sjekket)\b/i,
  /\bi (can )?see (in|that)[^.]*\b(system|account|role|permission|admin)/i,
  /\bi have (checked|verified|confirmed|reviewed)\b/i,
];

export function containsFalseSystemAccess(text: string): boolean {
  return FALSE_ACCESS_PATTERNS.some((re) => re.test(text));
}

// Belt-and-suspenders for the tone rule: the model must not sign the reply with a
// placeholder (the agent adds their own name). Strip bracketed "[Your Name]" /
// "[Agent's Name]" / "[Ditt navn]" style tokens if one slips through.
const SIGNATURE_PLACEHOLDER = /\[[^\]\n]*(?:name|navn|namn)[^\]\n]*\]/gi;

export function stripSignaturePlaceholders(text: string): string {
  return text
    .replace(SIGNATURE_PLACEHOLDER, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Build the FULL, chronological, source-labelled ticket context for the model.
// The old pipeline only fed the customer's own messages, so later agent replies
// and internal notes (e.g. "X already seems to be an admin") never reached the
// model. This includes description + every conversation entry, labelled by who
// wrote it, with auto-reply flagged.
export function buildContext(t: Ticket): string {
  const lines: string[] = [
    `TICKET #${t.id} · subject: ${t.subject ?? ""} · status: ${t.status}`,
  ];

  // The customer is already on file (they contacted us). Surface their name/email
  // so the model never asks them for an identity/email we already hold.
  const onFile = [t.requester?.name, t.requester?.email ?? t.email]
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  if (onFile.length) {
    lines.push(
      `CUSTOMER ON FILE: ${
        onFile.join(" · ")
      } — already known from the ticket; do NOT ask the customer to provide an email or identity that is already here.`,
    );
  }

  const convos = (t.conversations ?? [])
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  // Attachments (e.g. screenshots) exist on the ticket but the AI cannot read them.
  // Flag them so it acknowledges that instead of asking for what is already sent.
  const attachN = (t.attachments?.length ?? 0) +
    convos.reduce((n, c) => n + (c.attachments?.length ?? 0), 0);
  if (attachN) {
    lines.push(
      `ATTACHMENTS: ${attachN} file(s) are attached (e.g. a screenshot) that you CANNOT read. Do NOT ask the customer to send what is already attached — say you cannot access the attachment and ask the agent to look at it.`,
    );
  }

  // The latest real (non-auto) customer message is the one the draft should
  // respond to. If there are no incoming conversation entries, that is the
  // ticket description.
  const latestIncoming = [...convos].reverse().find(
    (c) => c.incoming && !c.private && !looksLikeAutoReply(c.body_text ?? ""),
  );
  const RESPOND = " ← LATEST CUSTOMER MESSAGE — respond to THIS";

  if ((t.description_text ?? "").trim()) {
    const tag = latestIncoming ? "" : RESPOND;
    lines.push("", `[initial] CUSTOMER${tag}:`, strip(t.description_text));
  }

  for (const c of convos) {
    const who = c.private
      ? "INTERNAL NOTE (agent/internal)"
      : c.incoming
      ? "CUSTOMER"
      : "AGENT REPLY";
    const auto = c.incoming && looksLikeAutoReply(c.body_text ?? "")
      ? " [likely AUTOMATIC / out-of-office reply — do NOT treat as an answer]"
      : "";
    const respond = latestIncoming && c.id === latestIncoming.id ? RESPOND : "";
    lines.push(
      "",
      `[${c.created_at}] ${who}${auto}${respond}:`,
      strip(c.body_text ?? ""),
    );
  }

  return lines.join("\n").slice(0, 12000);
}

// Human-readable label for each answer strategy, shown in the note header so the
// agent immediately sees WHAT the AI decided to do (answer / ask / verify / …).
const STRATEGY_LABEL: Record<string, string> = {
  DIRECT_ANSWER: "Direct answer",
  REPEAT_CLARIFYING_QUESTION: "Repeat the open clarifying question",
  REQUEST_MISSING_INFORMATION: "Ask for missing information",
  RECOMMEND_AGENT_VERIFICATION: "You should verify this manually",
  PROVIDE_KNOWLEDGE_BASE_INSTRUCTIONS: "General how-to from the knowledge base",
  ROUTE: "Route to the right team",
  ESCALATE: "Escalate",
  ABSTAIN: "No grounded answer",
};

export interface NoteData {
  confidence: Confidence;
  coachMode?: CoachMode;
  confidenceReason?: string;
  draft: string;
  rationale?: string;
  ticketType?: string;
  answerStrategy?: string;
  agentAnalysis?: string;
  resolutionSteps?: string[];
  unknowns?: string[];
  requiresManualCheck?: boolean;
  securitySensitive?: boolean;
  followUpQuestions?: string[];
  bugGuidance?: BugGuidance;
  promptVersion: string;
  searchQueries: string[];
  sources: SourceDoc[];
  qaAnswered: number;
  qaTotal: number;
  unsupportedNote?: string;
  // Read-only Freshworks CRM context. This is rendered directly into the
  // private note and is deliberately NOT part of the LLM prompt.
  customerSubscriptions?: CustomerSubscriptionContext;
  // Preferred feedback path: the authenticated, RLS-gated review app. A generation
  // deep-link is safe to expose; no write token or verdict lives in the URL.
  reviewUrl?: string;
  // One-click verdict links (§8/§12). Rendered only when both are present — i.e.
  // on legacy posted notes. New notes use reviewUrl instead.
  feedbackUrl?: string;
  feedbackToken?: string;
}

export interface CustomerSubscription {
  productName: string | null;
  renewalStatus: string | null;
  endDate: string | null;
}

export interface CustomerSubscriptionContext {
  // `ambiguous` = SEVERAL similar CRM accounts matched — the agent must pick
  // manually; guessing between customers is never allowed.
  status: "found" | "no_match" | "ambiguous" | "unavailable";
  // How the CRM account was resolved, most→least specific: the requester's
  // contact email; the ticket's company name (stem equality / word-prefix); or
  // the requester's email domain (subscriptions live per account/company).
  matchedBy?: "contact_email" | "company_name" | "company_name_prefix" | "email_domain";
  subscriptions: CustomerSubscription[];
}

const BADGE: Record<Confidence, string> = {
  high: "🟢 HIGH",
  low: "🟡 LOW",
  none: "⚪ NONE",
};

// ── Coach mode (scaling plan Fas 3.1) ────────────────────────────────────────
// Every suggestion is one of three modes. Derived DETERMINISTICALLY from the
// already-resolved pipeline signals ("code decides", like the QA validator) rather
// than trusted from the model — so the mode can never disagree with the verify
// gates, and no prompt change is needed (the golden set stays comparable). The
// §3.3 guardrails (attachment / roles / deletion / legal / broken-promise) already
// live in prompts.ts; this makes the resulting decision an explicit, measurable label.
export type CoachMode = "REPLY_READY" | "COACH_AGENT" | "AGENT_ACTION_REQUIRED";

export function deriveCoachMode(s: {
  answerStrategy: string;
  confidence: Confidence;
  hasReply: boolean;
  requiresManualCheck: boolean;
  sensitiveActionRequest: boolean;
  resolutionStepCount: number;
}): CoachMode {
  // 🔴 the agent must DO something before anything can reach the customer: check the
  // system / roles, verify identity for a sensitive action, open an attachment
  // (→ requiresManualCheck, or an empty reply with agent steps), or escalate.
  if (
    s.requiresManualCheck ||
    s.sensitiveActionRequest ||
    s.answerStrategy === "RECOMMEND_AGENT_VERIFICATION" ||
    s.answerStrategy === "ESCALATE" ||
    (!s.hasReply && s.resolutionStepCount > 0)
  ) return "AGENT_ACTION_REQUIRED";

  // 🟢 a grounded, send-ready customer message with no open agent action.
  const sendReadyStrategy = s.answerStrategy === "DIRECT_ANSWER" ||
    s.answerStrategy === "PROVIDE_KNOWLEDGE_BASE_INSTRUCTIONS" ||
    s.answerStrategy === "REPEAT_CLARIFYING_QUESTION" ||
    s.answerStrategy === "REQUEST_MISSING_INFORMATION";
  if (s.hasReply && s.confidence === "high" && sendReadyStrategy) return "REPLY_READY";

  // 🟡 otherwise: useful coaching / a hedged direction, but not send-ready as-is
  // (e.g. a routing message the agent must forward, or a low-confidence draft).
  return "COACH_AGENT";
}

export const MODE_BADGE: Record<CoachMode, string> = {
  REPLY_READY: "🟢 REPLY READY",
  COACH_AGENT: "🟡 COACH THE AGENT",
  AGENT_ACTION_REQUIRED: "🔴 AGENT ACTION REQUIRED",
};

// One line item per source, hyperlinked: KB solutions link to the article, past
// tickets link to the ticket (agent-facing URLs). Falls back to plain text if no
// URL could be built.
function renderSource(s: SourceDoc): string {
  const label = s.kind === "kb" ? `KB article #${s.id}` : `Ticket #${s.id}`;
  const name = s.url ? `<a href="${esc(s.url)}">${esc(s.title)}</a>` : esc(s.title);
  return `<li>${name} — ${esc(label)}</li>`;
}

function renderList(items: string[], ordered: boolean): string {
  const tag = ordered ? "ol" : "ul";
  return `<${tag}>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</${tag}>`;
}

function subscriptionCell(value: string | null): string {
  const text = value?.trim() ?? "";
  return text ? esc(text) : "—";
}

function renderCustomerSubscriptions(context: CustomerSubscriptionContext): string {
  if (context.status === "unavailable") {
    return "<p><strong>📦 Customer subscriptions (Freshworks CRM):</strong> " +
      "<em>temporarily unavailable — verify manually.</em></p>";
  }
  if (context.status === "no_match") {
    return "<p><strong>📦 Customer subscriptions (Freshworks CRM):</strong> " +
      "<em>no CRM account could be matched from the requester email or the ticket's company.</em></p>";
  }
  if (context.status === "ambiguous") {
    return "<p><strong>📦 Customer subscriptions (Freshworks CRM):</strong> " +
      "⚠️ <em>several similar CRM accounts match this customer — " +
      "check the CRM manually before relying on any subscription data.</em></p>";
  }
  if (!context.subscriptions.length) {
    return "<p><strong>📦 Customer subscriptions (Freshworks CRM):</strong> " +
      "<em>no subscriptions found for the matched account.</em></p>";
  }

  const rows = context.subscriptions.map((subscription) =>
    `<tr>` +
    `<td style="border:1px solid #ddd;padding:4px 8px">${
      subscriptionCell(subscription.productName)
    }</td>` +
    `<td style="border:1px solid #ddd;padding:4px 8px">${
      subscriptionCell(subscription.renewalStatus)
    }</td>` +
    `<td style="border:1px solid #ddd;padding:4px 8px">${
      subscriptionCell(subscription.endDate)
    }</td>` +
    `</tr>`
  ).join("");

  // Anything weaker than a contact match says HOW it matched — and the weak
  // tiers (name prefix / email domain) carry an explicit verify nudge, since
  // the ticket could be filed under the wrong company.
  const MATCH_NOTE: Record<string, string> = {
    company_name: " <em>(matched via the ticket's company)</em>",
    company_name_prefix:
      " <em>(matched via the ticket's company — the name differs slightly, verify it is the right account)</em>",
    email_domain:
      " <em>(matched via the requester's email domain — verify it is the right account)</em>",
  };
  const matchNote = (context.matchedBy && MATCH_NOTE[context.matchedBy]) || "";
  return `<p><strong>📦 Customer subscriptions (Freshworks CRM):</strong>${matchNote}</p>` +
    `<table style="border-collapse:collapse">` +
    `<thead><tr>` +
    `<th style="border:1px solid #ddd;padding:4px 8px;text-align:left">Product name</th>` +
    `<th style="border:1px solid #ddd;padding:4px 8px;text-align:left">Renewal status</th>` +
    `<th style="border:1px solid #ddd;padding:4px 8px;text-align:left">End date</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>`;
}

// Render the private note. Always posted, including at confidence "none" —
// silence is ambiguous (CLAUDE.md §2). The header carries the ticket type,
// Confidence, and Q/A score; low/none notes state what was searched and what was
// missing, which doubles as a knowledge-base gap report.
export function renderNote(r: NoteData): string {
  const out: string[] = [];
  const typePart = r.ticketType ? `Type: ${esc(r.ticketType)} · ` : "";
  // Q/A only means something for a direct answer. For a coach action (verify /
  // route / clarify / abstain) "answers 0 of N" reads as a failure when it isn't —
  // show the coach status instead (QA feedback).
  const isAnswer = r.answerStrategy === "DIRECT_ANSWER" ||
    r.answerStrategy === "PROVIDE_KNOWLEDGE_BASE_INSTRUCTIONS";
  const scorePart = isAnswer
    ? `Q/A: answers ${r.qaAnswered} of ${r.qaTotal} question(s)`
    : `Coach action (verify / route / clarify — not a direct answer)`;
  // Mode line (Fas 3.1): the single most important thing for the agent to see —
  // can I send this, should I use it as coaching, or must I act first?
  const modePart = r.coachMode ? `Mode: ${esc(MODE_BADGE[r.coachMode])} · ` : "";
  out.push(
    `<p><strong>🤝 AI assist for the agent</strong> — decision support, not an automatic answer<br>` +
      `${modePart}${typePart}Confidence: ${esc(BADGE[r.confidence])} · ` +
      `${scorePart} · ` +
      `<em>${esc(r.promptVersion)}</em></p>`,
  );
  // A red banner when the agent must do something before anything reaches the
  // customer — so a not-send-ready note is never mistaken for a ready reply.
  if (r.coachMode === "AGENT_ACTION_REQUIRED") {
    out.push(
      `<p><strong>🔴 Agent action required before replying</strong> — verify / check / route as below; ` +
        `do not send a customer reply until it is done.</p>`,
    );
  }

  // Verified account context is shown before any AI interpretation. Only the
  // three approved fields are accepted by the renderer.
  if (r.customerSubscriptions) {
    out.push(renderCustomerSubscriptions(r.customerSubscriptions));
  }

  // What the AI decided to do, and (briefly) why — so the agent can sanity-check
  // the strategy before reading the draft.
  const strategyLabel = r.answerStrategy
    ? (STRATEGY_LABEL[r.answerStrategy] ?? r.answerStrategy)
    : "";
  if (strategyLabel) {
    const reason = r.confidenceReason && r.confidenceReason.trim()
      ? ` — ${esc(r.confidenceReason)}`
      : "";
    out.push(
      `<p><strong>Suggested approach:</strong> ${esc(strategyLabel)}${reason}</p>`,
    );
  }

  // Agent-facing analysis — always shown when present. This is what keeps a
  // low/none note from being a hollow greeting: even without a send-ready reply,
  // the agent gets the likely resolution path and what to verify.
  if (r.agentAnalysis && r.agentAnalysis.trim()) {
    out.push(`<p><strong>🔎 AI analysis (for you):</strong> ${esc(r.agentAnalysis)}</p>`);
  }

  // The AI has NO system access. On security-sensitive / manual-check tickets say
  // so explicitly, so nobody mistakes the draft for a verified system lookup.
  if (r.requiresManualCheck || r.securitySensitive) {
    out.push(
      `<p><strong>⚠️ Verify manually:</strong> this is based only on the ticket text and ` +
        `knowledge base — the AI cannot see the customer's account, roles, or permissions. ` +
        `Confirm identity/access yourself before acting.</p>`,
    );
  }

  // Coach output first — what the agent should check / do (the primary value).
  if (r.resolutionSteps && r.resolutionSteps.length) {
    out.push(`<p><strong>🔧 What to check / do (for you):</strong></p>`);
    out.push(renderList(r.resolutionSteps, true));
  }

  // A customer draft only when it is grounded; otherwise say so plainly and hand
  // the judgement back to the agent (coach role, not solution-decider).
  out.push(`<p><strong>💬 Draft to the customer (only when grounded):</strong></p>`);
  if (r.confidence !== "none" && r.draft.trim()) {
    out.push(`<div>${esc(r.draft).replace(/\n/g, "<br>")}</div>`);
    if (r.rationale && r.rationale.trim()) {
      out.push(`<p><strong>Why this fits:</strong> ${esc(r.rationale)}</p>`);
    }
  } else {
    out.push(
      "<p><em>No grounded reply — this one needs your judgement. Use the checks above.</em></p>",
    );
  }

  // Things the AI could not establish from the text — a to-confirm list.
  if (r.unknowns && r.unknowns.length) {
    out.push(
      `<p><strong>Not established from the ticket (confirm before relying on it):</strong></p>`,
    );
    out.push(renderList(r.unknowns, false));
  }

  // When the customer's request is unclear, suggest what to ask them.
  if (r.followUpQuestions && r.followUpQuestions.length) {
    out.push(`<p><strong>Suggested follow-up questions:</strong></p>`);
    out.push(renderList(r.followUpQuestions, false));
  }

  // Bug reports: reproduction for the agent, safe steps for the customer.
  if (r.bugGuidance) {
    if (r.bugGuidance.repro_steps.length) {
      out.push(`<p><strong>Reproduction (for you):</strong></p>`);
      out.push(renderList(r.bugGuidance.repro_steps, true));
    }
    if (r.bugGuidance.customer_steps.length) {
      out.push(`<p><strong>Steps for the customer:</strong></p>`);
      out.push(renderList(r.bugGuidance.customer_steps, true));
    }
  }

  // When the request is unclear and we're asking for more info, the retrieved
  // sources are keyword noise from generic search queries — showing them implies a
  // relevance that isn't there. Suppress Sources + "Searched for" for the pure
  // clarification strategies; keep them wherever the AI actually answers from the KB.
  const clarifying = r.answerStrategy === "REQUEST_MISSING_INFORMATION" ||
    r.answerStrategy === "REPEAT_CLARIFYING_QUESTION";

  if (!clarifying) {
    if (r.searchQueries.length) {
      out.push(
        `<p><strong>Searched for:</strong> ${esc(r.searchQueries.join(", "))}</p>`,
      );
    }
    if (r.sources.length) {
      out.push(
        `<p><strong>Sources:</strong></p><ul>${
          r.sources.map(renderSource).join("")
        }</ul>`,
      );
    } else {
      out.push(
        "<p><strong>Sources:</strong> none found — possible knowledge-base gap.</p>",
      );
    }
  }

  if (r.unsupportedNote) out.push(`<p><em>${esc(r.unsupportedNote)}</em></p>`);

  // New notes route feedback through the authenticated review app. This avoids
  // state-changing GET links being triggered by link scanners/prefetchers.
  if (r.reviewUrl) {
    out.push(
      `<p><strong>Would you have sent this?</strong> ` +
        `<a href="${esc(r.reviewUrl)}">Review this generation in Coach Review</a></p>`,
    );
  } else if (r.feedbackUrl && r.feedbackToken) {
    // Legacy fallback only. The feedback function now renders a confirmation form;
    // its GET no longer changes state.
    const link = (v: string, label: string) =>
      `<a href="${esc(r.feedbackUrl!)}?t=${
        esc(r.feedbackToken!)
      }&amp;v=${v}">${label}</a>`;
    out.push(
      `<p><strong>Would you have sent this?</strong> ` +
        `${link("usable", "👍 Yes, would send")} · ` +
        `${link("edited", "✏️ With edits")} · ` +
        `${link("unusable", "👎 No")}` +
        ` <span style="color:#888">(opens a confirmation page)</span></p>`,
    );
  }

  return out.join("\n");
}

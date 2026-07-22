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

// Build the FULL, chronological, source-labelled ticket context for the model.
// The old pipeline only fed the customer's own messages, so later agent replies
// and internal notes (e.g. "X already seems to be an admin") never reached the
// model. This includes description + every conversation entry, labelled by who
// wrote it, with auto-reply flagged.
export function buildContext(t: Ticket): string {
  const lines: string[] = [
    `TICKET #${t.id} · subject: ${t.subject ?? ""} · status: ${t.status}`,
  ];

  if ((t.description_text ?? "").trim()) {
    lines.push("", "[initial] CUSTOMER:", strip(t.description_text));
  }

  const convos = (t.conversations ?? [])
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  for (const c of convos) {
    const who = c.private ? "INTERNAL NOTE (agent/internal)" : c.incoming ? "CUSTOMER" : "AGENT REPLY";
    const auto = c.incoming && looksLikeAutoReply(c.body_text ?? "")
      ? " [likely AUTOMATIC / out-of-office reply — do NOT treat as an answer]"
      : "";
    lines.push("", `[${c.created_at}] ${who}${auto}:`, strip(c.body_text ?? ""));
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
  ESCALATE: "Escalate",
  ABSTAIN: "No grounded answer",
};

export interface NoteData {
  confidence: Confidence;
  confidenceReason?: string;
  draft: string;
  rationale?: string;
  ticketType?: string;
  answerStrategy?: string;
  agentNextAction?: string;
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
}

const BADGE: Record<Confidence, string> = {
  high: "🟢 HIGH",
  low: "🟡 LOW",
  none: "⚪ NONE",
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

// Render the private note. Always posted, including at confidence "none" —
// silence is ambiguous (CLAUDE.md §2). The header carries the ticket type,
// Confidence, and Q/A score; low/none notes state what was searched and what was
// missing, which doubles as a knowledge-base gap report.
export function renderNote(r: NoteData): string {
  const out: string[] = [];
  const typePart = r.ticketType ? `Type: ${esc(r.ticketType)} · ` : "";
  out.push(
    `<p><strong>AI suggested reply</strong><br>` +
      `${typePart}Confidence: ${esc(BADGE[r.confidence])} · ` +
      `Q/A: answers ${r.qaAnswered} of ${r.qaTotal} question(s) · ` +
      `<em>${esc(r.promptVersion)}</em></p>`,
  );

  // What the AI decided to do, and (briefly) why — so the agent can sanity-check
  // the strategy before reading the draft.
  const strategyLabel = r.answerStrategy
    ? (STRATEGY_LABEL[r.answerStrategy] ?? r.answerStrategy)
    : "";
  if (strategyLabel) {
    const reason = r.confidenceReason && r.confidenceReason.trim()
      ? ` — ${esc(r.confidenceReason)}`
      : "";
    out.push(`<p><strong>Suggested approach:</strong> ${esc(strategyLabel)}${reason}</p>`);
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

  if (r.confidence !== "none" && r.draft.trim()) {
    out.push(`<div>${esc(r.draft).replace(/\n/g, "<br>")}</div>`);
    if (r.rationale && r.rationale.trim()) {
      out.push(`<p><strong>Why this answers the ticket:</strong> ${esc(r.rationale)}</p>`);
    }
  } else {
    out.push(
      "<p>No grounded answer was found in the knowledge base or past resolved tickets.</p>",
    );
  }

  // What the agent should do next (internal — may reference the manual check above).
  if (r.agentNextAction && r.agentNextAction.trim()) {
    out.push(`<p><strong>Next action for you:</strong> ${esc(r.agentNextAction)}</p>`);
  }

  // Things the AI could not establish from the text — a to-confirm list.
  if (r.unknowns && r.unknowns.length) {
    out.push(`<p><strong>Not established from the ticket (confirm before relying on it):</strong></p>`);
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

  if (r.searchQueries.length) {
    out.push(`<p><strong>Searched for:</strong> ${esc(r.searchQueries.join(", "))}</p>`);
  }

  if (r.sources.length) {
    out.push(`<p><strong>Sources:</strong></p><ul>${r.sources.map(renderSource).join("")}</ul>`);
  } else {
    out.push("<p><strong>Sources:</strong> none found — possible knowledge-base gap.</p>");
  }

  if (r.unsupportedNote) out.push(`<p><em>${esc(r.unsupportedNote)}</em></p>`);

  return out.join("\n");
}

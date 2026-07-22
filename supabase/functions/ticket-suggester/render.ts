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

export interface NoteData {
  confidence: Confidence;
  draft: string;
  rationale?: string;
  ticketType?: string;
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

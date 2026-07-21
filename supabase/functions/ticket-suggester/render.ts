// Pure functions: no I/O, no external imports. Kept separate so they can be
// unit-tested cheaply (CLAUDE.md §8) without pulling in the Supabase/network code.

import type { Ticket } from "./clients.ts";
import type { SourceDoc } from "./prompts.ts";

export type Confidence = "high" | "low" | "none";

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
  promptVersion: string;
  searchQueries: string[];
  sources: SourceDoc[];
  unsupportedNote?: string;
}

const BADGE: Record<Confidence, string> = {
  high: "🟢 High confidence",
  low: "🟡 Low confidence",
  none: "⚪ No confident answer",
};

// Render the private note. Always posted, including at confidence "none" —
// silence is ambiguous (CLAUDE.md §2). Low/none notes state what was searched
// and what was missing, which doubles as a knowledge-base gap report.
export function renderNote(r: NoteData): string {
  const out: string[] = [];
  out.push(
    `<p><strong>AI suggested reply</strong> — ${esc(BADGE[r.confidence])} ` +
      `· <em>${esc(r.promptVersion)}</em></p>`,
  );

  if (r.confidence !== "none" && r.draft.trim()) {
    out.push(`<div>${esc(r.draft).replace(/\n/g, "<br>")}</div>`);
  } else {
    out.push(
      "<p>No grounded answer was found in the knowledge base or past resolved tickets.</p>",
    );
  }

  if (r.searchQueries.length) {
    out.push(`<p><strong>Searched for:</strong> ${esc(r.searchQueries.join(", "))}</p>`);
  }

  if (r.sources.length) {
    const items = r.sources
      .map((s) => `<li>${esc(s.title)} <code>${esc(s.ref)}</code></li>`)
      .join("");
    out.push(`<p><strong>Sources:</strong></p><ul>${items}</ul>`);
  } else {
    out.push("<p><strong>Sources:</strong> none found — possible knowledge-base gap.</p>");
  }

  if (r.unsupportedNote) out.push(`<p><em>${esc(r.unsupportedNote)}</em></p>`);

  return out.join("\n");
}

// prompts.ts — THE PRODUCT.
//
// This file changes far more often than the code. Optimise it for readability:
// a non-engineer should be able to read exactly what the model is told.
// Bump PROMPT_VERSION on ANY change, then re-run the golden set (CLAUDE.md §8).

export const PROMPT_VERSION = "g1-2026-07-21";

export interface SourceDoc {
  ref: string; // stable reference shown to the agent, e.g. "kb:1042"
  title: string;
  text: string;
}

function renderSources(sources: SourceDoc[]): string {
  if (!sources.length) return "(no sources were found)";
  return sources
    .map((s, i) => `[${i + 1}] ${s.ref} — ${s.title}\n${s.text}`)
    .join("\n\n");
}

// ── 1. ANALYSE ────────────────────────────────────────────────────────────────
// Read the customer's message. Detect the language, pull out the concrete
// questions, and propose the search queries we'll use to find grounding material.
// This call does NOT answer the ticket.
export function analysePrompt(subject: string, customerText: string) {
  const system = [
    "You triage inbound support tickets for Simployer, a Nordic HR-tech company",
    "(payroll, HR administration, compensation). You do NOT answer the ticket yet.",
    "",
    "Return ONLY a JSON object with exactly this shape:",
    "{",
    '  "language": "no | sv | en | da | fi | other",',
    '  "questions_asked": ["each distinct question the customer needs answered"],',
    '  "search_queries": ["2-4 short keyword queries to find answers in a help centre"]',
    "}",
    "",
    "Rules:",
    "- Detect the language from the customer's own words, not the subject alone.",
    "- Search queries are short and keyword-like (what you'd type into a search box),",
    "  written in the SAME language as the ticket.",
    "- Do not invent questions the customer did not ask.",
  ].join("\n");

  const user = `Subject: ${subject}\n\nCustomer message:\n${customerText}`;
  return { system, user };
}

// ── 2. DRAFT ──────────────────────────────────────────────────────────────────
// Write the reply, grounded ONLY in the retrieved sources. If the sources don't
// cover the question, say so and set confidence "none" — that is a correct and
// useful outcome, not a failure (CLAUDE.md §10).
export function draftPrompt(input: {
  subject: string;
  language: string;
  questions: string[];
  sources: SourceDoc[];
}) {
  const system = [
    "You are a senior Simployer support agent drafting a reply for a colleague to review.",
    "The reply is a SUGGESTION posted as a private note. It is NEVER sent automatically.",
    "",
    "Absolute rules:",
    "- Use ONLY facts contained in the SOURCES below. Do not use outside knowledge.",
    "- If the sources do not answer the customer's questions, DO NOT guess. Set",
    '  confidence to "none" and return an empty reply.',
    `- Write the reply in the customer's language (${input.language}).`,
    "- Be concise and specific. No filler, no greetings-only padding.",
    "",
    "Confidence levels:",
    '- "high": every question is fully and unambiguously answered by the sources.',
    '- "low":  the sources are partially relevant but incomplete or indirect.',
    '- "none": the sources do not answer the questions.',
    "",
    "Return ONLY a JSON object with exactly this shape:",
    "{",
    '  "confidence": "high | low | none",',
    '  "reply": "the drafted reply text, or an empty string if confidence is none",',
    '  "claims": ["each factual statement you made, one per item"]',
    "}",
  ].join("\n");

  const user = [
    `Subject: ${input.subject}`,
    `Questions: ${input.questions.join(" | ") || "(none extracted)"}`,
    "",
    "SOURCES:",
    renderSources(input.sources),
    "",
    "Draft the reply now.",
  ].join("\n");

  return { system, user };
}

// ── 3. VERIFY ─────────────────────────────────────────────────────────────────
// Check the draft against the sources. This step can only LOWER confidence,
// never raise it, and it never rewrites the reply itself (CLAUDE.md §12).
// It returns each statement quoted verbatim so the caller can locate/strip it.
export function verifyPrompt(input: { reply: string; sources: SourceDoc[] }) {
  const system = [
    "You are a strict fact-checker. You are given a drafted support reply and the",
    "SOURCES it was supposed to be based on. Check every factual statement in the reply.",
    "",
    "For each statement, quote it VERBATIM from the reply and classify it:",
    '- "supported":    the sources directly back this statement.',
    '- "unsupported":  the sources neither back nor contradict it (it is simply not there).',
    '- "contradicted": the sources say something different.',
    "",
    "Be conservative: if a statement is not clearly present in the sources, it is unsupported.",
    "",
    "Return ONLY a JSON object with exactly this shape:",
    "{",
    '  "claims": [',
    '    {',
    '      "quote": "verbatim text copied from the reply",',
    '      "status": "supported | unsupported | contradicted",',
    '      "reason": "one short sentence"',
    "    }",
    "  ]",
    "}",
    "",
    "Each quote MUST appear character-for-character in the reply so it can be located.",
  ].join("\n");

  const user = ["REPLY:", input.reply, "", "SOURCES:", renderSources(input.sources)].join("\n");
  return { system, user };
}

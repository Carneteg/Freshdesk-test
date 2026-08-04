import { assertEquals } from "./test_assert.ts";
import { countApologies, stripHtmlForPrompt, verifyGroundingRefs } from "./pipeline.ts";
import { articlePrompt } from "./prompts.ts";

Deno.test("stripHtmlForPrompt: plain text passes through untouched", () => {
  const text = "Hei!\n\nGå til Innstillinger > Roller.\n\nMvh";
  assertEquals(stripHtmlForPrompt(text), text);
});

Deno.test("stripHtmlForPrompt: formatted gold answers become clean prose", () => {
  const html = "<p>Hei!</p><p>Slik løser du det:</p>" +
    "<ul><li>Åpne <b>Innstillinger</b></li><li>Velg <i>Roller</i></li></ul>" +
    '<p>Se <a href="https://support.simployer.com/a">artikkelen</a>.</p>';
  assertEquals(
    stripHtmlForPrompt(html),
    // the list end acts as a paragraph break
    "Hei!\nSlik løser du det:\n- Åpne Innstillinger\n- Velg Roller\n\nSe artikkelen.",
  );
});

Deno.test("stripHtmlForPrompt: entities decode once, ampersand last (no double-decode)", () => {
  assertEquals(
    stripHtmlForPrompt("L&#39;avtal: 1 &lt; 2 &amp;&nbsp;&quot;ok&quot; &amp;lt;kept&amp;gt;"),
    // &amp;lt; is the LITERAL text "&lt;" — it must not double-decode to "<".
    'L\'avtal: 1 < 2 & "ok" &lt;kept&gt;',
  );
});

// ── Grounding cross-check (2026-08-03) ───────────────────────────────────────
// The model reports what it grounded on; this decides whether that claim is even
// possible given what retrieval returned. Gates the green band.

const SRC = [
  { ref: "kb:1042", kind: "kb" as const, id: 1042, title: "Roles", text: "…" },
  { ref: "ticket:85703", kind: "ticket" as const, id: 85703, title: "Access", text: "…" },
];

Deno.test("verifyGroundingRefs: a cited source we actually supplied counts", () => {
  assertEquals(verifyGroundingRefs("kb", ["kb:1042"], SRC, 0), true);
  assertEquals(verifyGroundingRefs("ticket", ["ticket:85703"], SRC, 0), true);
  // case and stray whitespace are the model's, not a grounding failure
  assertEquals(verifyGroundingRefs("kb", [" KB:1042 "], SRC, 0), true);
});

Deno.test("verifyGroundingRefs: a playbook incident grounds by position", () => {
  assertEquals(verifyGroundingRefs("playbook", ["P2"], [], 3), true);
  // …but only a position that exists
  assertEquals(verifyGroundingRefs("playbook", ["P4"], [], 3), false);
  assertEquals(verifyGroundingRefs("playbook", ["P1"], [], 0), false);
});

Deno.test("verifyGroundingRefs: an unbacked 'kb' claim is rejected", () => {
  // the exact failure this gate exists for: confident assertion, no sources
  assertEquals(verifyGroundingRefs("kb", ["kb:1042"], [], 0), false);
  assertEquals(verifyGroundingRefs("kb", [], SRC, 0), false);
  // a ref we never handed it (hallucinated article id)
  assertEquals(verifyGroundingRefs("kb", ["kb:9999"], SRC, 0), false);
});

Deno.test("verifyGroundingRefs: 'none' never grounds, whatever it cites", () => {
  assertEquals(verifyGroundingRefs("none", ["kb:1042"], SRC, 0), false);
  assertEquals(verifyGroundingRefs("", ["kb:1042"], SRC, 0), false);
});

// ── Apology counting (tone rule: at most one) ────────────────────────────────

Deno.test("countApologies: one specific apology is fine", () => {
  assertEquals(countApologies("I'm sorry you weren't called back. Here are the steps:"), 1);
  assertEquals(countApologies("Beklager at du ikke fikk svar. Slik gjør du:"), 1);
  assertEquals(countApologies("Hei! Slik gjør du det:"), 0);
});

Deno.test("countApologies: repeated regret is what we flag", () => {
  assertEquals(
    countApologies(
      "I'm sorry for the delay. … Sorry again for the inconvenience. We apologise.",
    ),
    3,
  );
  assertEquals(countApologies("Beklager dette. … Beklager igjen for ulempen."), 2);
  assertEquals(countApologies("Ursäkta dröjsmålet. … Vi ber om ursäkt för detta."), 2);
});

Deno.test("countApologies: one apology, one count — overlapping phrasings don't stack", () => {
  // "I'm sorry for …" is a single apology, not "I'm sorry" plus "sorry for"
  assertEquals(countApologies("I'm sorry for the delay."), 1);
  assertEquals(countApologies("We are sorry about this."), 1);
});

// ── KB article opportunity + writer (2026-08-03) ─────────────────────────────
// The article writer is the one place the AI's output can become durable
// knowledge, so the gate on "publishable" is enforced in code, not trusted.

Deno.test("articlePrompt: refuses to invent, and is told to generalise", () => {
  const { system, user } = articlePrompt({
    subject: "Hvordan legger jeg til en ny ansatt?",
    language: "no",
    context: "Kunde: hvordan legger jeg til en ansatt?",
    resolution: "Gå til Ansatte > Ny ansatt og fyll ut skjemaet.",
    resolutionSource: "gold_answer",
    sources: SRC,
    proposedTitle: "Legge til en ny ansatt",
  });
  // the non-negotiable rule must be in the system prompt, not implied
  assertEquals(system.includes("NOTHING that is not established"), true);
  assertEquals(system.includes("publishable=false"), true);
  // customer-specific detail must be stripped, not transcribed
  assertEquals(system.includes("remove every customer-specific detail"), true);
  // the resolution must be labelled as human-validated, so the model knows its status
  assertEquals(user.includes("written by a senior agent"), true);
  assertEquals(user.includes("Legge til en ny ansatt"), true);
});

Deno.test("articlePrompt: an agent's sent reply is labelled differently to a gold answer", () => {
  const { user } = articlePrompt({
    subject: "s",
    language: "sv",
    context: "c",
    resolution: "r",
    resolutionSource: "agent_reply",
    sources: [],
  });
  assertEquals(user.includes("what the support agent actually sent"), true);
  assertEquals(user.includes("written by a senior agent"), false);
});

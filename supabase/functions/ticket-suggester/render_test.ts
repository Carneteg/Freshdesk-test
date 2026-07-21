// Unit tests for the pure functions (CLAUDE.md §8). Run: `deno task test`.
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  classifyUsage,
  esc,
  extractJSON,
  lastAgentReply,
  latestCustomerMessage,
  lower,
  renderNote,
  similarity,
  strip,
  stripQuotes,
} from "./render.ts";
import type { Ticket } from "./clients.ts";

Deno.test("extractJSON: plain object", () => {
  assertEquals(extractJSON('{"a":1}'), { a: 1 });
});

Deno.test("extractJSON: fenced with prose around it", () => {
  const out = 'Sure!\n```json\n{"confidence":"high","reply":"hi"}\n```\nDone.';
  assertEquals(extractJSON(out), { confidence: "high", reply: "hi" });
});

Deno.test("extractJSON: object embedded in prose", () => {
  assertEquals(extractJSON('nonsense {"x": [1,2]} trailing'), { x: [1, 2] });
});

Deno.test("extractJSON: throws when no object present", () => {
  assertThrows(() => extractJSON("no json here"), Error, "no JSON object");
});

Deno.test("strip: removes tags and decodes entities", () => {
  assertEquals(strip("<p>Hei &amp; hopp</p>"), "Hei & hopp");
});

Deno.test("strip: drops script/style content", () => {
  assertEquals(strip("<style>x{}</style><p>keep</p><script>bad()</script>"), "keep");
});

Deno.test("esc: escapes HTML-significant characters", () => {
  assertEquals(esc('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
});

Deno.test("lower: only ever lowers, never raises", () => {
  assertEquals(lower("high"), "low");
  assertEquals(lower("low"), "low");
  assertEquals(lower("none"), "none");
});

Deno.test("stripQuotes: removes verbatim quotes and tidies punctuation", () => {
  const draft = "You can reset it. The fee is 500 NOK. Contact support.";
  const cleaned = stripQuotes(draft, ["The fee is 500 NOK."]);
  assertEquals(cleaned, "You can reset it. Contact support.");
});

Deno.test("stripQuotes: no-op when quote absent", () => {
  assertEquals(stripQuotes("hello world", ["missing"]), "hello world");
});

Deno.test("latestCustomerMessage: newest incoming defines the trigger id", () => {
  const t = {
    id: 42,
    description_text: "first question",
    conversations: [
      { id: 9, body_text: "agent reply", incoming: false, private: false, created_at: "2026-01-02T00:00:00Z" },
      { id: 11, body_text: "follow-up question", incoming: true, private: false, created_at: "2026-01-03T00:00:00Z" },
    ],
  } as unknown as Ticket;
  const r = latestCustomerMessage(t);
  assertEquals(r.triggerId, "conv:11");
  assertStringIncludes(r.text, "first question");
  assertStringIncludes(r.text, "follow-up question");
});

Deno.test("latestCustomerMessage: falls back to description when no incoming convo", () => {
  const t = { id: 7, description_text: "only the description", conversations: [] } as unknown as Ticket;
  assertEquals(latestCustomerMessage(t).triggerId, "desc:7");
});

Deno.test("lastAgentReply: returns the final outgoing public message", () => {
  const t = {
    id: 1,
    description_text: "q",
    conversations: [
      { id: 1, body_text: "first answer", incoming: false, private: false, created_at: "2026-01-01T00:00:00Z" },
      { id: 2, body_text: "internal note", incoming: false, private: true, created_at: "2026-01-02T00:00:00Z" },
      { id: 3, body_text: "final answer", incoming: false, private: false, created_at: "2026-01-03T00:00:00Z" },
    ],
  } as unknown as Ticket;
  assertEquals(lastAgentReply(t), "final answer");
});

Deno.test("renderNote: none-confidence still produces a note with the gap report", () => {
  const html = renderNote({
    confidence: "none",
    draft: "",
    promptVersion: "test",
    searchQueries: ["vacation balance"],
    sources: [],
    qaAnswered: 0,
    qaTotal: 2,
  });
  assertStringIncludes(html, "NONE");
  assertStringIncludes(html, "answers 0 of 2 question(s)");
  assertStringIncludes(html, "Searched for:");
  assertStringIncludes(html, "knowledge-base gap");
});

Deno.test("renderNote: high-confidence shows scores, draft, and a linked source", () => {
  const html = renderNote({
    confidence: "high",
    draft: "Line one\nLine two",
    promptVersion: "test",
    searchQueries: [],
    sources: [{
      ref: "kb:5",
      kind: "kb",
      id: 5,
      title: "Reset guide",
      text: "...",
      url: "https://x.freshdesk.com/a/solutions/articles/5",
    }],
    qaAnswered: 3,
    qaTotal: 3,
  });
  assertStringIncludes(html, "HIGH");
  assertStringIncludes(html, "answers 3 of 3 question(s)");
  assertStringIncludes(html, "Line one<br>Line two");
  assertStringIncludes(html, '<a href="https://x.freshdesk.com/a/solutions/articles/5">Reset guide</a>');
  assertStringIncludes(html, "KB article #5");
});

Deno.test("renderNote: a past-ticket source links to the ticket", () => {
  const html = renderNote({
    confidence: "low",
    draft: "See prior case.",
    promptVersion: "test",
    searchQueries: [],
    sources: [{
      ref: "ticket:9001",
      kind: "ticket",
      id: 9001,
      title: "Similar payroll question",
      text: "...",
      url: "https://x.freshdesk.com/a/tickets/9001",
    }],
    qaAnswered: 1,
    qaTotal: 1,
  });
  assertStringIncludes(html, '<a href="https://x.freshdesk.com/a/tickets/9001">Similar payroll question</a>');
  assertStringIncludes(html, "Ticket #9001");
});

Deno.test("similarity: identical text is 1, disjoint is 0", () => {
  assertEquals(similarity("reset your password here", "reset your password here"), 1);
  assertEquals(similarity("alpha bravo charlie", "xxxx yyyy zzzz"), 0);
});

Deno.test("similarity: partial overlap is between 0 and 1", () => {
  const s = similarity("reset your password in settings", "reset password from the settings page");
  if (!(s > 0 && s < 1)) throw new Error(`expected partial overlap, got ${s}`);
});

Deno.test("classifyUsage: thresholds map to used / partly / not", () => {
  assertEquals(classifyUsage(0.9), "used");
  assertEquals(classifyUsage(0.4), "partly");
  assertEquals(classifyUsage(0.1), "not");
});

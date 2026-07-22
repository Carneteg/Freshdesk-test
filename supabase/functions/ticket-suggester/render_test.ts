// Unit tests for the pure functions (CLAUDE.md §8). Run: `deno task test`.
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  agentReplyToLatestCustomer,
  buildContext,
  classifyUsage,
  containsFalseSystemAccess,
  deriveTags,
  esc,
  extractJSON,
  firstAgentReply,
  isIgnorableTicket,
  lastAgentReply,
  latestCustomerMessage,
  looksLikeAutoReply,
  lower,
  renderNote,
  similarity,
  strip,
  stripQuotes,
  stripSignaturePlaceholders,
  ticketAsOfLatestCustomer,
  ticketBeforeFirstAgentReply,
} from "./render.ts";
import { draftPrompt } from "./prompts.ts";
import type { Ticket } from "./clients.ts";

Deno.test("draftPrompt: injects the known-incidents playbook, outranking generic KB", () => {
  const { system, user } = draftPrompt({
    subject: "AI search 404",
    language: "no",
    context: "customer: links give 404",
    analysisJson: "{}",
    sources: [],
    incidents: [{
      title: "AI search returns 404",
      symptoms: "links from AI search open a 404 page",
      resolution: "reindex the search; ask for system access",
      routing: null,
    }],
  });
  assertStringIncludes(user, "INTERNAL PLAYBOOK");
  assertStringIncludes(user, "AI search returns 404");
  assertStringIncludes(user, "reindex the search");
  assertStringIncludes(system, "STRONGER grounding than a generic KB article");
});

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

Deno.test("stripSignaturePlaceholders: removes placeholder signers, keeps the closing", () => {
  assertEquals(
    stripSignaturePlaceholders("Hei Kari,\n\nTakk!\n\nVennlig hilsen,\n[Your Name]"),
    "Hei Kari,\n\nTakk!\n\nVennlig hilsen,",
  );
  assertEquals(stripSignaturePlaceholders("Best,\n[Agent's Name]"), "Best,");
  assertEquals(stripSignaturePlaceholders("Med vennlig hilsen,\n[Ditt navn]"), "Med vennlig hilsen,");
  // Real names are untouched.
  assertEquals(stripSignaturePlaceholders("Hei Natalie, takk!"), "Hei Natalie, takk!");
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

Deno.test("isIgnorableTicket: excludes call-log/receipt tickets, keeps real ones", () => {
  assertEquals(isIgnorableTicket("Incoming call with +4741677072 on Mon, Jul 20"), true);
  assertEquals(isIgnorableTicket("Outgoing call with Caroline Hjellegjerde"), true);
  assertEquals(isIgnorableTicket("Missed call with +46707750392"), true);
  assertEquals(isIgnorableTicket("Error message to register a sick leave"), false);
  assertEquals(isIgnorableTicket("Simployer Aon personalhåndbok tilgang"), false);
  // EXCLUDE_SUBJECTS substrings add more exclusions.
  assertEquals(isIgnorableTicket("Voicemail from customer", ["voicemail"]), true);
  assertEquals(isIgnorableTicket("Real question about payroll", ["voicemail"]), false);
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

Deno.test("deriveTags: caps at 3 single-word lowercase tags, deduped", () => {
  assertEquals(
    deriveTags(["Payroll run", "vacation", "payroll", "Sick leave", "bonus"]),
    ["payroll", "vacation", "sick"],
  );
});

Deno.test("deriveTags: strips punctuation, keeps Nordic letters, drops empties", () => {
  assertEquals(deriveTags(["Fastlønn!", "fastlønn", "   ", "a"]), ["fastlønn"]);
});

Deno.test("renderNote: unclear ticket shows type and follow-up questions", () => {
  const html = renderNote({
    confidence: "none",
    draft: "",
    ticketType: "unclear",
    followUpQuestions: ["Which payroll run?", "What error do you see?"],
    promptVersion: "test",
    searchQueries: [],
    sources: [],
    qaAnswered: 0,
    qaTotal: 0,
  });
  assertStringIncludes(html, "Type: unclear");
  assertStringIncludes(html, "Suggested follow-up questions");
  assertStringIncludes(html, "Which payroll run?");
});

Deno.test("renderNote: bug ticket shows repro and customer steps", () => {
  const html = renderNote({
    confidence: "low",
    draft: "Try clearing the cache.",
    ticketType: "bug",
    bugGuidance: {
      repro_steps: ["Open the report", "Click export"],
      customer_steps: ["Clear cache", "Retry"],
    },
    promptVersion: "test",
    searchQueries: [],
    sources: [],
    qaAnswered: 0,
    qaTotal: 1,
  });
  assertStringIncludes(html, "Reproduction (for you):");
  assertStringIncludes(html, "Click export");
  assertStringIncludes(html, "Steps for the customer:");
  assertStringIncludes(html, "Clear cache");
});

// ── Full-context QA rework (CLAUDE.md §12) ──────────────────────────────────────
// The root-cause fix: feed the WHOLE chronological ticket (customer + agent +
// internal notes + system messages) to the model, source-labelled, so a prior
// agent's note reaches the AI. These tests cover buildContext + the deterministic
// guards + the note fields, mapping to the QA spec's test cases A–H.

// Case A — buildContext includes the agent's internal note (the Didrik bug):
// the note about the already-registered admin MUST reach the model.
Deno.test("buildContext: includes internal notes and agent replies, labelled", () => {
  const t = {
    id: 100,
    subject: "Ny administratör",
    status: 2,
    description_text: "Jag vill lägga till en administratör.",
    conversations: [
      {
        id: 1,
        body_text: "Vem ska registreras som administratör?",
        incoming: false,
        private: false,
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: 2,
        body_text: "Det verkar som att Didrik Salte redan är registrerad som administratör.",
        incoming: false,
        private: true,
        created_at: "2026-01-02T00:00:00Z",
      },
    ],
  } as unknown as Ticket;
  const ctx = buildContext(t);
  assertStringIncludes(ctx, "[initial] CUSTOMER");
  assertStringIncludes(ctx, "Jag vill lägga till en administratör.");
  assertStringIncludes(ctx, "AGENT REPLY");
  assertStringIncludes(ctx, "Vem ska registreras");
  assertStringIncludes(ctx, "INTERNAL NOTE");
  assertStringIncludes(ctx, "Didrik Salte redan är registrerad");
});

// Case F/H — an auto/OOO reply must be flagged in-context and never counted as
// the customer answering the agent's control question.
Deno.test("buildContext: surfaces the requester on file so the model won't ask for the email", () => {
  const t = {
    id: 700,
    subject: "Access",
    status: 2,
    description_text: "I lost my access.",
    requester: { name: "Natalie Müller", email: "natalie.muller@aon.com" },
    conversations: [],
  } as unknown as Ticket;
  const ctx = buildContext(t);
  assertStringIncludes(ctx, "CUSTOMER ON FILE:");
  assertStringIncludes(ctx, "natalie.muller@aon.com");
  assertStringIncludes(ctx, "do NOT ask the customer to provide an email");
});

Deno.test("buildContext: falls back to the ticket email when no requester object", () => {
  const t = {
    id: 701,
    subject: "x",
    status: 2,
    description_text: "hi",
    email: "kari@example.com",
    conversations: [],
  } as unknown as Ticket;
  assertStringIncludes(buildContext(t), "kari@example.com");
});

Deno.test("buildContext: flags an automatic out-of-office customer reply", () => {
  const t = {
    id: 101,
    subject: "Re: kontrollfråga",
    status: 2,
    description_text: "Fråga.",
    conversations: [
      {
        id: 1,
        body_text: "Jag är på semester och läser inte min mail. Autosvar.",
        incoming: true,
        private: false,
        created_at: "2026-01-03T00:00:00Z",
      },
    ],
  } as unknown as Ticket;
  const ctx = buildContext(t);
  assertStringIncludes(ctx, "AUTOMATIC / out-of-office");
});

Deno.test("looksLikeAutoReply: detects SV/NO/EN absence replies, not normal text", () => {
  assertEquals(looksLikeAutoReply("Jag är på semester just nu, autosvar."), true);
  assertEquals(looksLikeAutoReply("Out of office until Monday"), true);
  assertEquals(looksLikeAutoReply("Jeg er på ferie og svarer ikke."), true);
  assertEquals(looksLikeAutoReply("Hei, jeg trenger hjelp med tilgang."), false);
  assertEquals(looksLikeAutoReply(""), false);
});

// Case E — the AI has no system access. First-person "I checked / I can see in
// the system" phrasings must be caught even if they slip past the prompt.
Deno.test("containsFalseSystemAccess: catches first-person system-access claims", () => {
  assertEquals(containsFalseSystemAccess("Jag har kontrollerat och rollen finns."), true);
  assertEquals(containsFalseSystemAccess("Jeg ser i systemet at brukeren er administrator."), true);
  assertEquals(containsFalseSystemAccess("I have verified the account exists."), true);
  // Correct, attributed phrasing must NOT trip the guard.
  assertEquals(
    containsFalseSystemAccess(
      "Det framgår av den tidigare agentens anteckning att Didrik Salte redan verkar vara registrerad.",
    ),
    false,
  );
});

// Case B/D — security-sensitive / manual-check tickets get an explicit "the AI
// cannot see the system, verify manually" disclaimer and the chosen strategy.
Deno.test("renderNote: security-sensitive note shows manual-verify disclaimer and strategy", () => {
  const html = renderNote({
    confidence: "high",
    confidenceReason: "An agent already asked who should be admin and it is unanswered.",
    draft: "Kan du bekräfta vilken person som ska ha administratörsbehörighet?",
    answerStrategy: "REPEAT_CLARIFYING_QUESTION",
    resolutionSteps: ["Confirm the admin's identity before granting access."],
    unknowns: ["Which person should hold the admin role"],
    requiresManualCheck: true,
    securitySensitive: true,
    promptVersion: "test",
    searchQueries: ["administrator access"],
    sources: [],
    qaAnswered: 0,
    qaTotal: 1,
  });
  assertStringIncludes(html, "Suggested approach:");
  assertStringIncludes(html, "Repeat the open clarifying question");
  assertStringIncludes(html, "Verify manually");
  assertStringIncludes(html, "cannot see the customer's account");
  assertStringIncludes(html, "What to check / do (for you):");
  assertStringIncludes(html, "Confirm the admin&#39;s identity before granting access.");
  assertStringIncludes(html, "Not established from the ticket");
  assertStringIncludes(html, "Which person should hold the admin role");
});

// The two tracks are rendered as distinct, labelled sections.
Deno.test("renderNote: reply and resolution steps are separate sections", () => {
  const html = renderNote({
    confidence: "low",
    draft: "Hei, vi ser på saken og kommer tilbake.",
    answerStrategy: "ESCALATE",
    agentAnalysis: "404s in AI search usually mean a reindex is needed; not covered by the KB.",
    resolutionSteps: ["Reindex the customer's search", "Request system access if needed", "Escalate to the technical team"],
    promptVersion: "test",
    searchQueries: [],
    sources: [],
    qaAnswered: 0,
    qaTotal: 1,
  });
  assertStringIncludes(html, "💬 Draft to the customer (only when grounded):");
  assertStringIncludes(html, "Hei, vi ser på saken");
  assertStringIncludes(html, "🔧 What to check / do (for you):");
  assertStringIncludes(html, "Reindex the customer&#39;s search");
  assertStringIncludes(html, "AI analysis (for you)");
  // Coach steps come BEFORE the customer draft (coach role, not answer-first).
  const stepsIdx = html.indexOf("🔧 What to check / do");
  const replyIdx = html.indexOf("💬 Draft to the customer");
  assertEquals(stepsIdx > -1 && replyIdx > stepsIdx, true);
});

// At confidence none there is no send-ready reply, but the resolution track and
// analysis still carry substance — never a hollow note.
Deno.test("renderNote: none confidence still shows resolution steps, not just a greeting", () => {
  const html = renderNote({
    confidence: "none",
    draft: "",
    agentAnalysis: "Likely a policy question the KB does not cover.",
    resolutionSteps: ["Confirm the customer's identity", "Ask the manager to re-issue the contract"],
    promptVersion: "test",
    searchQueries: [],
    sources: [],
    qaAnswered: 0,
    qaTotal: 1,
  });
  assertStringIncludes(html, "No grounded reply");
  assertStringIncludes(html, "What to check / do (for you):");
  assertStringIncludes(html, "Ask the manager to re-issue the contract");
});

// ── Replay fairness (CLAUDE.md §6 Step 4) ───────────────────────────────────────
// Replaying a CLOSED ticket must hide the agent's resolution, or the model reads
// the answer and abstains with "already handled". These reconstruct the ticket as
// the agent saw it and pick out the reply they actually sent to compare against.

const CLOSED_TICKET = {
  id: 500,
  subject: "Access request",
  status: 5,
  description_text: "Please give me admin access.",
  conversations: [
    { id: 1, body_text: "Who should be the admin?", incoming: false, private: false, created_at: "2026-01-01T10:00:00Z" },
    { id: 2, body_text: "Me, anna@example.com", incoming: true, private: false, created_at: "2026-01-02T10:00:00Z" },
    { id: 3, body_text: "Done — you now have admin access.", incoming: false, private: false, created_at: "2026-01-03T10:00:00Z" },
    { id: 4, body_text: "resolved", incoming: false, private: true, created_at: "2026-01-03T10:05:00Z" },
  ],
} as unknown as Ticket;

Deno.test("ticketAsOfLatestCustomer: drops the agent's post-trigger resolution", () => {
  const view = ticketAsOfLatestCustomer(CLOSED_TICKET);
  const ctx = buildContext(view);
  // The customer's latest message and the earlier agent question are kept…
  assertStringIncludes(ctx, "Me, anna@example.com");
  assertStringIncludes(ctx, "Who should be the admin?");
  // …but the resolution that came AFTER it is gone (no cheating).
  assertEquals(ctx.includes("you now have admin access"), false);
  assertEquals(ctx.includes("resolved"), false);
});

Deno.test("ticketAsOfLatestCustomer: no incoming message drops all conversations", () => {
  const t = {
    id: 501,
    subject: "x",
    status: 5,
    description_text: "first question",
    conversations: [
      { id: 1, body_text: "here is the answer", incoming: false, private: false, created_at: "2026-01-02T00:00:00Z" },
    ],
  } as unknown as Ticket;
  assertEquals(ticketAsOfLatestCustomer(t).conversations?.length, 0);
});

Deno.test("agentReplyToLatestCustomer: returns the reply sent AFTER the trigger", () => {
  assertEquals(agentReplyToLatestCustomer(CLOSED_TICKET), "Done — you now have admin access.");
});

// Cold start: test the ticket before the agent's FIRST reply, so we grade the
// substantive opening turn — not a mid-thread follow-up already answered above.
Deno.test("ticketBeforeFirstAgentReply: keeps only the opening request, hides all replies", () => {
  const view = ticketBeforeFirstAgentReply(CLOSED_TICKET);
  const ctx = buildContext(view);
  assertStringIncludes(ctx, "Please give me admin access."); // the opening request stays
  // Everything from the first agent reply onward is hidden.
  assertEquals(view.conversations?.length, 0);
  assertEquals(ctx.includes("Who should be the admin?"), false);
  assertEquals(ctx.includes("you now have admin access"), false);
});

Deno.test("firstAgentReply: returns the first public reply, not the last", () => {
  assertEquals(firstAgentReply(CLOSED_TICKET), "Who should be the admin?");
});

Deno.test("ticketBeforeFirstAgentReply: no agent reply keeps the whole ticket", () => {
  const t = {
    id: 502,
    subject: "x",
    status: 2,
    description_text: "opening",
    conversations: [
      { id: 1, body_text: "more detail", incoming: true, private: false, created_at: "2026-01-02T00:00:00Z" },
    ],
  } as unknown as Ticket;
  assertEquals(ticketBeforeFirstAgentReply(t).conversations?.length, 1);
  assertEquals(firstAgentReply(t), "");
});

// A low/none note must still HELP the agent — the analysis carries substance so
// it is never a hollow greeting (user feedback on #85840).
Deno.test("renderNote: low/none note still shows the agent analysis", () => {
  const html = renderNote({
    confidence: "none",
    draft: "",
    answerStrategy: "RECOMMEND_AGENT_VERIFICATION",
    agentAnalysis: "Likely an expired signing link; usually resolved by the manager re-issuing the agreement. Verify whose contract before advising.",
    promptVersion: "test",
    searchQueries: [],
    sources: [],
    qaAnswered: 0,
    qaTotal: 1,
  });
  assertStringIncludes(html, "AI analysis (for you)");
  assertStringIncludes(html, "expired signing link");
  assertStringIncludes(html, "manager re-issuing");
});

Deno.test("buildContext: marks the latest real customer message as the one to answer", () => {
  const t = {
    id: 600,
    subject: "Follow-up",
    status: 2,
    description_text: "First question.",
    conversations: [
      { id: 1, body_text: "Agent answer.", incoming: false, private: false, created_at: "2026-01-01T00:00:00Z" },
      { id: 2, body_text: "New follow-up question.", incoming: true, private: false, created_at: "2026-01-02T00:00:00Z" },
    ],
  } as unknown as Ticket;
  const ctx = buildContext(t);
  // The newest customer message is flagged; the older description is not.
  const marker = "LATEST CUSTOMER MESSAGE — respond to THIS";
  assertStringIncludes(ctx, `New follow-up question.`);
  const idx = ctx.indexOf(marker);
  assertEquals(idx > -1, true);
  // Only the newest incoming carries it (exactly one marker).
  assertEquals(ctx.split(marker).length - 1, 1);
});

// Case C — a straightforward how-to answer needs no manual-verify banner.
Deno.test("renderNote: non-sensitive direct answer omits the manual-verify banner", () => {
  const html = renderNote({
    confidence: "high",
    draft: "You can export the report from the Reports menu.",
    answerStrategy: "DIRECT_ANSWER",
    requiresManualCheck: false,
    securitySensitive: false,
    promptVersion: "test",
    searchQueries: [],
    sources: [],
    qaAnswered: 1,
    qaTotal: 1,
  });
  assertStringIncludes(html, "Direct answer");
  assertEquals(html.includes("Verify manually"), false);
});

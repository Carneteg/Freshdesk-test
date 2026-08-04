import { assertEquals, assertStringIncludes, assertThrows } from "./test_assert.ts";
import {
  classifyNextStep,
  deriveDeliveryStatus,
  evaluateObservation,
  extractTargetRef,
  firstAgentReplyAt,
  INTERNAL_CHECK_BUDGET,
  STEP_SIGNAL,
  stepObservable,
  median,
  replyBucket,
  STEP_TYPES,
  ticketMetrics,
  unobservableShare,
} from "./coaching.ts";
import {
  assertReadOnly,
  exposesWriteMethod,
  EXTERNAL_WRITE_METHODS,
  FRESHDESK_WRITE_METHODS,
  ReadOnlyFreshdesk,
} from "./readonly-clients.ts";
import { Freshdesk } from "./clients.ts";
import { escapeJql, issueLinksTicket, plainText, ReadOnlyAtlassian } from "./atlassian.ts";
import { describeConnections, systemStatus } from "./connections.ts";

// ── ACCEPTANCE CRITERION 7 ───────────────────────────────────────────────────
// "A test proves no write method on any external client is reachable from this
// tab or its job." This is the whole read-only guarantee, so it is asserted
// structurally rather than trusted.

Deno.test("read-only guard: the raw Freshdesk client DOES expose writes", () => {
  // Establishes the test is capable of failing — a guard that cannot detect the
  // thing it guards against is worse than no guard.
  const raw = new Freshdesk("example", "key");
  assertEquals(exposesWriteMethod(raw) !== null, true);
  assertThrows(() => assertReadOnly(raw, "raw client"), Error, "read-only");
});

Deno.test("read-only guard: ReadOnlyFreshdesk exposes no write method", () => {
  const ro = new ReadOnlyFreshdesk(new Freshdesk("example", "key"));
  assertEquals(exposesWriteMethod(ro), null);
  assertReadOnly(ro, "coaching ticket source"); // must not throw

  // Walk the whole surface — own properties AND the prototype chain — so a write
  // added later cannot slip in via inheritance.
  const surface = new Set<string>();
  for (let o = ro as object | null; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) surface.add(k);
  }
  for (const w of FRESHDESK_WRITE_METHODS) {
    assertEquals(surface.has(w), false, `ReadOnlyFreshdesk must not expose ${w}`);
  }
});

Deno.test("read-only guard: the write list actually matches the client", () => {
  // If someone renames postPrivateNote, this fails loudly instead of the guard
  // silently checking for a method that no longer exists.
  const raw = new Freshdesk("example", "key") as unknown as Record<string, unknown>;
  for (const w of FRESHDESK_WRITE_METHODS) {
    assertEquals(typeof raw[w], "function", `${w} should exist on Freshdesk`);
  }
});

// ── Step classification (code decides, never the model) ──────────────────────

Deno.test("classifyNextStep: signal-bearing steps get their type", () => {
  assertEquals(classifyNextStep("Attach the ticket to the existing Linear request"), "link_linear");
  assertEquals(classifyNextStep("Link this to AH-2704 in Jira"), "link_jira");
  assertEquals(classifyNextStep("Route the legal question to Simployer Expert"), "route_expert");
  assertEquals(
    classifyNextStep("Escalate the issue to the development team for investigation"),
    "escalate",
  );
  assertEquals(classifyNextStep("Offer a session and copy the CSM"), "copy_csm");
  assertEquals(classifyNextStep("Book a walkthrough meeting with the customer"), "offer_meeting");
  assertEquals(classifyNextStep("Write a knowledge base article for this"), "write_kb");
});

Deno.test("classifyNextStep: real corpus wording falls to internal_check", () => {
  // Verbatim from the live corpus. These carry no signal in any system, which is
  // the finding the tab exists to surface — not something to paper over.
  const real = [
    "Check the current access settings for each entity to understand the configuration.",
    "Verify the customer's current roles and permissions in the system.",
    "Investigate the customer's Simployer portal using the access provided.",
    "Determine if the handbook is still retrievable or if it has been permanently deleted.",
  ];
  for (const step of real) assertEquals(classifyNextStep(step), "internal_check");
  assertEquals(classifyNextStep(""), "internal_check");
  assertEquals(classifyNextStep("   "), "internal_check");
});

// Regression: the first run against the live corpus found `\\bjira\\b` had no `i`
// flag, so "Monitor the Jira issue" fell through to internal_check. The original
// test passed only because its fixture matched on the issue key instead — which
// is exactly why acceptance criterion 9 says run it against real data.
Deno.test("classifyNextStep: the product name matches whatever its casing", () => {
  assertEquals(classifyNextStep("Monitor the Jira issue for any updates."), "link_jira");
  assertEquals(classifyNextStep("monitor the jira issue"), "link_jira");
  assertEquals(classifyNextStep("Attach it to the Linear request"), "link_linear");
  // …but an issue KEY stays case-sensitive, so ordinary hyphenated prose is safe.
  assertEquals(classifyNextStep("Check the sykefravaer-2026 setting"), "internal_check");
});

Deno.test("classifyNextStep: 'expert' means Simployer Expert, not any expert", () => {
  // A generic mention must not masquerade as a legal referral.
  assertEquals(classifyNextStep("Ask an expert user to reproduce it"), "internal_check");
  assertEquals(classifyNextStep("Refer this to Simployer Expert"), "route_expert");
});

Deno.test("extractTargetRef: pulls an issue key, or nothing", () => {
  assertEquals(extractTargetRef("Link to AH-2704 please"), "AH-2704");
  assertEquals(extractTargetRef("Check the settings"), null);
});

// ── Observability map ────────────────────────────────────────────────────────

Deno.test("every step type declares where its signal lives", () => {
  for (const t of STEP_TYPES) {
    const sig = STEP_SIGNAL[t];
    assertEquals(typeof sig.label, "string");
    assertEquals(typeof sig.note, "string");
  }
  // internal_check is the only type with no system at all — unobservable by
  // design, not merely unconfigured.
  assertEquals(STEP_SIGNAL.internal_check.system, null);
});

// Connectedness is derived from the ENVIRONMENT, not hardcoded, so the tab can
// never claim a system is readable when its credentials are absent.
const NO_CREDS = () => undefined;
const ALL_CREDS = (n: string) => "set-" + n;

Deno.test("stepObservable: an unconfigured system is never observable", () => {
  for (const t of STEP_TYPES) {
    assertEquals(stepObservable(t, NO_CREDS), false);
  }
});

Deno.test("stepObservable: credentials turn the signal on — except where no client exists", () => {
  assertEquals(stepObservable("route_expert", ALL_CREDS), true);
  assertEquals(stepObservable("escalate", ALL_CREDS), true);
  assertEquals(stepObservable("write_kb", ALL_CREDS), true);
  assertEquals(stepObservable("link_jira", ALL_CREDS), true);
  // Linear and Planhat have no client in this codebase, so no amount of
  // environment configuration can make them readable.
  assertEquals(stepObservable("link_linear", ALL_CREDS), false);
  assertEquals(stepObservable("copy_csm", ALL_CREDS), false);
  assertEquals(stepObservable("offer_meeting", ALL_CREDS), false);
  // …and internal_check has no signal at all, by design.
  assertEquals(stepObservable("internal_check", ALL_CREDS), false);
});

Deno.test("stepObservable: a HALF-configured system is not connected", () => {
  // A partial integration is a runtime error waiting to happen, not a signal.
  const partial = (n: string) => (n === "ATLASSIAN_SITE" ? "simployer" : undefined);
  assertEquals(stepObservable("link_jira", partial), false);
});

Deno.test("unobservableShare: the budget that judges the prompt", () => {
  assertEquals(unobservableShare([]), 0);
  assertEquals(unobservableShare(["route_expert", "write_kb"], ALL_CREDS), 0);
  assertEquals(unobservableShare(["internal_check", "route_expert"], ALL_CREDS), 0.5);
  assertEquals(unobservableShare(["internal_check"], ALL_CREDS) > INTERNAL_CHECK_BUDGET, true);
  // With nothing configured, everything is blind — the honest reading.
  assertEquals(unobservableShare(["route_expert", "write_kb"], NO_CREDS), 1);
});

// ── Observation: "cannot see" is never "did not do" ──────────────────────────

Deno.test("evaluateObservation: unconnected systems return NOT observable", () => {
  for (const t of ["link_jira", "link_linear", "copy_csm", "offer_meeting"] as const) {
    const o = evaluateObservation(t, {}, NO_CREDS);
    assertEquals(o.observable, false);
    assertEquals(o.observed, false);
    assertEquals(o.observedVia, null);
  }
});

Deno.test("evaluateObservation: internal_check is unobservable by design", () => {
  const o = evaluateObservation("internal_check", { kbArticleRequested: true }, ALL_CREDS);
  assertEquals(o.observable, false);
  assertEquals(o.observed, false);
});

Deno.test("evaluateObservation: connected signals resolve to yes or no", () => {
  assertEquals(
    evaluateObservation("route_expert", { groupName: "Simployer Expert NO" }, ALL_CREDS),
    { observed: true, observable: true, observedVia: "Freshdesk group" },
  );
  // Observable and genuinely not done — distinct from "cannot see".
  const missed = evaluateObservation("route_expert", { groupName: "First line" }, ALL_CREDS);
  assertEquals(missed, { observed: false, observable: true, observedVia: null });

  assertEquals(evaluateObservation("write_kb", { kbArticleRequested: true }, ALL_CREDS).observed, true);
  assertEquals(evaluateObservation("write_kb", { kbArticleRequested: false }, ALL_CREDS).observed, false);
  assertEquals(evaluateObservation("write_kb", {}, ALL_CREDS).observable, true);

  assertEquals(evaluateObservation("escalate", { groupChanged: true }, ALL_CREDS).observed, true);
  assertEquals(evaluateObservation("escalate", { groupChanged: false }, ALL_CREDS).observed, false);
});

// ── Delivery timing ──────────────────────────────────────────────────────────

Deno.test("firstAgentReplyAt: the first PUBLIC outgoing message", () => {
  const ticket = {
    conversations: [
      // our own AI note — private, must never count as the agent replying
      { id: 1, body_text: "AI note", incoming: false, private: true, created_at: "2026-08-01T09:00:00Z" },
      { id: 2, body_text: "customer", incoming: true, private: false, created_at: "2026-08-01T08:00:00Z" },
      { id: 3, body_text: "agent", incoming: false, private: false, created_at: "2026-08-01T10:00:00Z" },
      { id: 4, body_text: "agent again", incoming: false, private: false, created_at: "2026-08-01T11:00:00Z" },
    ],
  };
  assertEquals(firstAgentReplyAt(ticket), "2026-08-01T10:00:00Z");
  assertEquals(firstAgentReplyAt({ conversations: [] }), null);
  assertEquals(firstAgentReplyAt({}), null);
});

Deno.test("deriveDeliveryStatus: late is a delivery failure, not a bad suggestion", () => {
  // note before the reply → the agent could have seen it
  assertEquals(
    deriveDeliveryStatus("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z"),
    "in_time",
  );
  // note after the reply → they had already written
  assertEquals(
    deriveDeliveryStatus("2026-08-01T11:00:00Z", "2026-08-01T10:00:00Z"),
    "late",
  );
  // exactly at the reply counts as in time — the boundary favours delivery
  assertEquals(
    deriveDeliveryStatus("2026-08-01T10:00:00Z", "2026-08-01T10:00:00Z"),
    "in_time",
  );
  // no agent reply yet → nothing to judge, and NOT counted as a failure
  assertEquals(deriveDeliveryStatus("2026-08-01T09:00:00Z", null), "no_reply_yet");
  assertEquals(deriveDeliveryStatus(null, null), "no_reply_yet");
  // never delivered, but the agent has replied → a real delivery failure
  assertEquals(deriveDeliveryStatus(null, "2026-08-01T10:00:00Z"), "late");
});

// ── Connection registry + the content gate (CLAUDE.md §11) ───────────────────

Deno.test("systemStatus: connected only when EVERY credential is present", () => {
  // Atlassian needs three; two is not "mostly connected", it is not connected.
  const two = (n: string) => (n === "ATLASSIAN_SITE" || n === "ATLASSIAN_EMAIL" ? "x" : undefined);
  const st = systemStatus("jira", two);
  assertEquals(st.connected, false);
  assertEquals(st.missing, ["ATLASSIAN_API_TOKEN"]);
  // The reason names the gap without ever naming a secret VALUE.
  assertEquals(typeof st.reason, "string");
});

Deno.test("systemStatus: a system with no client can never be connected", () => {
  for (const sys of ["linear", "planhat"] as const) {
    const st = systemStatus(sys, ALL_CREDS);
    assertEquals(st.connected, false);
    assertEquals(st.missing, []);
    assertStringIncludes(st.reason ?? "", "codebase");
  }
});

Deno.test("systemStatus: blank and whitespace-only credentials do not count", () => {
  assertEquals(systemStatus("freshdesk", () => "").connected, false);
  assertEquals(systemStatus("freshdesk", () => "   ").connected, false);
});

Deno.test("describeConnections: reports state without leaking a secret", () => {
  const line = describeConnections((n) => (n === "FRESHDESK_API_KEY" ? "super-secret" : undefined));
  assertStringIncludes(line, "freshdesk");
  assertEquals(line.includes("super-secret"), false);
});

// ── Atlassian: the false-positive trap ───────────────────────────────────────
// `text ~ "84162"` is a full-text match on a bare number, so Jira will return
// issues that merely mention it. These tests pin the confirmation step that
// stops a coincidence being scored as follow-through.

Deno.test("issueLinksTicket: only a real ticket URL counts", () => {
  // Verbatim from TIMEPLAN-4147 on the live instance.
  const real = 'Kunde Jungheinrich får ikke kjørt lønnseksport.   \nFreshdesk sak 84162  \n' +
    '<custom data-type="smartlink" data-id="id-0">https://simployer.freshdesk.com/a/tickets/84162</custom>';
  assertEquals(issueLinksTicket(real, "simployer", 84162), true);

  // The trap: the number appears, but not as a ticket link.
  assertEquals(issueLinksTicket("Invoice total was 84162 NOK", "simployer", 84162), false);
  assertEquals(issueLinksTicket("Freshdesk sak 84162 (link to follow)", "simployer", 84162), false);
  assertEquals(issueLinksTicket(null, "simployer", 84162), false);
  assertEquals(issueLinksTicket("", "simployer", 84162), false);
});

Deno.test("issueLinksTicket: a prefix id must not match a longer one", () => {
  const url = "https://simployer.freshdesk.com/a/tickets/84162";
  assertEquals(issueLinksTicket(url, "simployer", 8416), false); // 8416 is not 84162
  assertEquals(issueLinksTicket(url, "simployer", 84162), true);
  // …and another tenant's Freshdesk is not ours.
  assertEquals(issueLinksTicket(url, "othercorp", 84162), false);
});

Deno.test("plainText: flattens Atlassian Document Format, including smartlink URLs", () => {
  // The REST API returns ADF, not the markdown the MCP probe showed. Assuming
  // one shape would be exactly the mistake this client exists to avoid.
  const adf = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Freshdesk sak 84162" }] },
      {
        type: "paragraph",
        content: [{
          type: "text",
          text: "link",
          marks: [{ type: "link", attrs: { href: "https://simployer.freshdesk.com/a/tickets/84162" } }],
        }],
      },
    ],
  };
  const flat = plainText(adf);
  assertStringIncludes(flat, "Freshdesk sak 84162");
  assertStringIncludes(flat, "/a/tickets/84162");
  assertEquals(issueLinksTicket(flat, "simployer", 84162), true);
  assertEquals(plainText(null), "");
});

Deno.test("escapeJql: a value cannot break out of the quoted literal", () => {
  assertEquals(escapeJql("84162"), "84162");
  assertEquals(escapeJql('a" OR key = "X'), 'a\\" OR key = \\"X');
  assertEquals(escapeJql("back\\slash"), "back\\\\slash");
});

Deno.test("read-only guard: the Atlassian client exposes no writes", () => {
  const clients: Array<[string, object]> = [
    ["ReadOnlyAtlassian", new ReadOnlyAtlassian("example.atlassian.net", "a@b.c", "tok")],
  ];
  for (const [label, client] of clients) {
    assertEquals(exposesWriteMethod(client), null, `${label} must expose no write method`);
    assertReadOnly(client, label);

    // Walk the prototype chain too — a write must not arrive via inheritance.
    const surface = new Set<string>();
    for (let o: object | null = client; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const k of Object.getOwnPropertyNames(o)) surface.add(k);
    }
    for (const w of EXTERNAL_WRITE_METHODS) {
      assertEquals(surface.has(w), false, `${label} must not expose ${w}`);
    }
  }
});

Deno.test("evaluateObservation: publishing to the customer KB outranks requesting", () => {
  // The customer knowledge base (Freshdesk help centre, /en/support/home) is the
  // pipeline's grounding source, so an article only helps the NEXT customer once
  // it is actually there. Requesting one is an intention; publishing is the
  // outcome — and a request that never gets published is the failure this
  // distinction exists to expose.
  const published = evaluateObservation(
    "write_kb",
    { kbArticleRequested: false, kbArticlePublished: true },
    ALL_CREDS,
  );
  assertEquals(published, {
    observed: true,
    observable: true,
    observedVia: "customer knowledge base",
  });

  // Requested but not published still counts as followed, via the weaker signal.
  const requested = evaluateObservation("write_kb", { kbArticleRequested: true }, ALL_CREDS);
  assertEquals(requested.observed, true);
  assertStringIncludes(requested.observedVia ?? "", "article_drafts");

  // Neither: observable, and genuinely not done.
  const neither = evaluateObservation("write_kb", {}, ALL_CREDS);
  assertEquals(neither, { observed: false, observable: true, observedVia: null });
});

Deno.test("evaluateObservation: a Jira link counts only once confirmed", () => {
  // The evidence flag is set by atlassian.ts AFTER the ticket URL is confirmed
  // in the issue description — a bare full-text hit never reaches here.
  assertEquals(
    evaluateObservation("link_jira", { jiraIssueLinked: true }, ALL_CREDS),
    { observed: true, observable: true, observedVia: "Jira" },
  );
  // Searched, nothing found: observable and genuinely not done.
  assertEquals(
    evaluateObservation("link_jira", { jiraIssueLinked: false }, ALL_CREDS),
    { observed: false, observable: true, observedVia: null },
  );
  // Jira unreachable (search errored, or no credentials): UNKNOWN, not "no".
  assertEquals(evaluateObservation("link_jira", {}, NO_CREDS).observable, false);
});

Deno.test("evaluateObservation: routing reads the Freshdesk group name", () => {
  assertEquals(
    evaluateObservation("route_expert", { groupName: "Simployer Expert SE" }, ALL_CREDS).observed,
    true,
  );
  assertEquals(
    evaluateObservation("route_expert", { groupName: "Customer Care 1st line" }, ALL_CREDS).observed,
    false,
  );
  // No group on the ticket at all → we cannot say it moved.
  assertEquals(evaluateObservation("escalate", { groupName: null }, ALL_CREDS).observed, false);
});

// ── Baselines measured on the COACHED population ─────────────────────────────
// These replaced the Intercom baselines. Intercom's numbers were correct but
// described a different support channel, so they could never be a fair
// comparison for coaching done on Freshdesk tickets.

const T0 = "2026-08-01T09:00:00Z";
const conv = (mins: number, incoming: boolean, priv = false) => ({
  id: mins,
  body_text: "x",
  incoming,
  private: priv,
  created_at: new Date(Date.parse(T0) + mins * 60_000).toISOString(),
});

Deno.test("ticketMetrics: first reply, reply count and span", () => {
  const m = ticketMetrics({
    created_at: T0,
    conversations: [
      conv(5, true), // customer follow-up
      conv(30, false), // FIRST public agent reply
      conv(90, false), // second agent reply
      conv(20, false, true), // our own AI note — private, must not count
    ],
  });
  assertEquals(m.firstReplySeconds, 30 * 60);
  assertEquals(m.agentReplies, 2); // the private note is excluded
  assertEquals(m.spanSeconds, 90 * 60);
});

Deno.test("ticketMetrics: 'customer came back' means AFTER the first agent reply", () => {
  // A customer message BEFORE any agent reply is just the original conversation.
  assertEquals(
    ticketMetrics({ created_at: T0, conversations: [conv(5, true), conv(30, false)] })
      .customerReturned,
    false,
  );
  // After the first reply, the answer did not land — that is the signal.
  assertEquals(
    ticketMetrics({ created_at: T0, conversations: [conv(30, false), conv(60, true)] })
      .customerReturned,
    true,
  );
  // No agent reply at all: nothing to have come back from.
  assertEquals(
    ticketMetrics({ created_at: T0, conversations: [conv(5, true)] }).customerReturned,
    false,
  );
});

Deno.test("ticketMetrics: missing data yields null, never a fabricated zero", () => {
  const empty = ticketMetrics({ created_at: T0, conversations: [] });
  assertEquals(empty.firstReplySeconds, null);
  assertEquals(empty.agentReplies, 0);
  assertEquals(empty.customerReturned, false);
  // No created_at → the wait cannot be computed, and must not read as instant.
  assertEquals(ticketMetrics({ conversations: [conv(30, false)] }).firstReplySeconds, null);
});

Deno.test("ticketMetrics: clock skew does not produce a negative wait", () => {
  const m = ticketMetrics({
    created_at: T0,
    conversations: [conv(-10, false)], // reply stamped before the ticket
  });
  assertEquals(m.firstReplySeconds, 0);
});

Deno.test("replyBucket: boundaries land in the lower bucket", () => {
  assertEquals(replyBucket(0), "under_60s");
  assertEquals(replyBucket(59), "under_60s");
  assertEquals(replyBucket(60), "1_5min");
  assertEquals(replyBucket(299), "1_5min");
  assertEquals(replyBucket(300), "5_15min");
  assertEquals(replyBucket(900), "over_15min");
  assertEquals(replyBucket(86_400), "over_15min");
});

Deno.test("median: odd, even and empty samples", () => {
  // Median not mean — support response times are long-tailed, and one ticket
  // left open over a weekend would drag an average somewhere meaningless.
  assertEquals(median([5, 1, 3]), 3);
  assertEquals(median([1, 2, 3, 4]), 3); // rounded midpoint of 2 and 3
  assertEquals(median([]), null);
  assertEquals(median([42]), 42);
});

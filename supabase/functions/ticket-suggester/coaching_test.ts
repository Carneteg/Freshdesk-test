import { assertEquals, assertThrows } from "./test_assert.ts";
import {
  classifyNextStep,
  deriveDeliveryStatus,
  evaluateObservation,
  extractTargetRef,
  firstAgentReplyAt,
  INTERNAL_CHECK_BUDGET,
  STEP_OBSERVABILITY,
  STEP_TYPES,
  unobservableShare,
} from "./coaching.ts";
import {
  assertReadOnly,
  exposesWriteMethod,
  FRESHDESK_WRITE_METHODS,
  ReadOnlyFreshdesk,
} from "./readonly-clients.ts";
import { Freshdesk } from "./clients.ts";

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
    const meta = STEP_OBSERVABILITY[t];
    assertEquals(typeof meta.system, "string");
    assertEquals(typeof meta.note, "string");
  }
  // Only systems this codebase actually has a client for may claim connected.
  assertEquals(STEP_OBSERVABILITY.link_jira.connected, false);
  assertEquals(STEP_OBSERVABILITY.link_linear.connected, false);
  assertEquals(STEP_OBSERVABILITY.copy_csm.connected, false);
  assertEquals(STEP_OBSERVABILITY.offer_meeting.connected, false);
  assertEquals(STEP_OBSERVABILITY.internal_check.connected, false);
  assertEquals(STEP_OBSERVABILITY.route_expert.connected, true);
  assertEquals(STEP_OBSERVABILITY.write_kb.connected, true);
});

Deno.test("unobservableShare: the budget that judges the prompt", () => {
  assertEquals(unobservableShare([]), 0);
  assertEquals(unobservableShare(["route_expert", "write_kb"]), 0);
  assertEquals(unobservableShare(["internal_check", "route_expert"]), 0.5);
  assertEquals(unobservableShare(["internal_check"]) > INTERNAL_CHECK_BUDGET, true);
});

// ── Observation: "cannot see" is never "did not do" ──────────────────────────

Deno.test("evaluateObservation: unconnected systems return NOT observable", () => {
  for (const t of ["link_jira", "link_linear", "copy_csm", "offer_meeting"] as const) {
    const o = evaluateObservation(t, {});
    assertEquals(o.observable, false);
    assertEquals(o.observed, false);
    assertEquals(o.observedVia, null);
  }
});

Deno.test("evaluateObservation: internal_check is unobservable by design", () => {
  const o = evaluateObservation("internal_check", { kbArticleRequested: true });
  assertEquals(o.observable, false);
  assertEquals(o.observed, false);
});

Deno.test("evaluateObservation: connected signals resolve to yes or no", () => {
  assertEquals(
    evaluateObservation("route_expert", { groupName: "Simployer Expert NO" }),
    { observed: true, observable: true, observedVia: "Freshdesk group" },
  );
  // Observable and genuinely not done — distinct from "cannot see".
  const missed = evaluateObservation("route_expert", { groupName: "First line" });
  assertEquals(missed, { observed: false, observable: true, observedVia: null });

  assertEquals(evaluateObservation("write_kb", { kbArticleRequested: true }).observed, true);
  assertEquals(evaluateObservation("write_kb", { kbArticleRequested: false }).observed, false);
  assertEquals(evaluateObservation("write_kb", {}).observable, true);

  assertEquals(evaluateObservation("escalate", { groupChanged: true }).observed, true);
  assertEquals(evaluateObservation("escalate", { groupChanged: false }).observed, false);
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

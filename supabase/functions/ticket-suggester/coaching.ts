// coaching.ts — pure logic behind the Coaching tab.
//
// The product pivoted from answer-generator to coach, but only the DRAFT half is
// measured ("would I have sent this"). Whether the agent acted on the recommended
// next step is not measured at all. This module is the deterministic half of
// fixing that: classify a recommended step, decide whether the note arrived in
// time, and decide whether a step was observably followed.
//
// Everything here is a PURE function over data we already hold. Nothing calls an
// LLM and nothing writes anywhere — same stance as `deriveCoachMode` and the QA
// validator: a model may propose, TypeScript decides.

import type { Conversation, Ticket } from "./clients.ts";
import { type EnvLookup, isConnected, type SystemName } from "./connections.ts";

// ── Step types ────────────────────────────────────────────────────────────────
//
// A recommended step is only measurable if it has ONE unambiguous signal in a
// system we already read. Free prose ("follow up appropriately") cannot be
// evaluated, so every step is forced into one of these buckets.
export const STEP_TYPES = [
  "link_jira",
  "link_linear",
  "route_expert",
  "escalate",
  "copy_csm",
  "offer_meeting",
  "write_kb",
  "internal_check",
] as const;

export type StepType = typeof STEP_TYPES[number];

/**
 * Where a step type's signal lives.
 *
 * This declares the SIGNAL only. Whether the system is reachable is a separate,
 * environment-dependent question answered by `connections.ts` — because a
 * hardcoded `connected: true` is a claim that rots the moment credentials
 * change, and the build spec is explicit that an unreachable system must render
 * "not connected" rather than be stubbed.
 *
 * `system: null` means there is no signal at all, in any system, ever.
 */
export const STEP_SIGNAL: Record<
  StepType,
  { system: SystemName | null; label: string; note: string }
> = {
  // Routing shows up as a Freshdesk group change on the ticket we already read.
  route_expert: {
    system: "freshdesk",
    label: "Freshdesk group",
    note: "group changed to Simployer Expert",
  },
  escalate: {
    system: "freshdesk",
    label: "Freshdesk group",
    note: "group changed away from first line",
  },
  // Our own KB-article loop is the signal: an article requested for this ticket.
  write_kb: {
    // Two signals, both already readable: our own article_drafts table, and the
    // customer knowledge base itself (Freshdesk solutions — the help centre at
    // /en/support/home, which the pipeline already retrieves from).
    system: "supabase",
    label: "article_drafts / customer KB",
    note: "a KB article was requested, or published to the customer help centre",
  },
  link_jira: { system: "jira", label: "Jira", note: "issue linked to the ticket" },
  link_linear: { system: "linear", label: "Linear", note: "ticket attached to a Linear request" },
  copy_csm: { system: "planhat", label: "Planhat", note: "CSM copied or activity created" },
  offer_meeting: {
    system: "planhat",
    label: "Planhat",
    note: "meeting activity created",
  },
  // By design unobservable — no system can confirm an internal check happened.
  // Tracked as a SHARE, because advice nobody can verify is the blind spot: if
  // this rises, the prompt is the problem, not the agent.
  internal_check: { system: null, label: "—", note: "no system signal by design" },
};

/** Can this deployment actually observe this step type right now? */
export function stepObservable(type: StepType, env?: EnvLookup): boolean {
  const sig = STEP_SIGNAL[type];
  return sig.system !== null && isConnected(sig.system, env);
}

/** Share of recommendations allowed to be unobservable before the prompt is at fault. */
export const INTERNAL_CHECK_BUDGET = 0.15;

// Ordered rules — FIRST match wins, so the specific ones come before the generic.
// Written against the wording the pipeline actually produces, not against an
// idealised taxonomy: the live corpus is dominated by "Check…" / "Verify…" /
// "Investigate…", which is precisely why internal_check is the fallback.
const RULES: Array<{ type: StepType; res: RegExp[] }> = [
  {
    type: "link_jira",
    // The product name is matched case-INSENSITIVELY (the corpus writes "Jira");
    // the issue key stays case-SENSITIVE, because a lowercased `[a-z]{2,5}-\d+`
    // would swallow ordinary hyphenated text.
    res: [/\bjira\b/i, /\b[A-Z]{2,5}-\d{2,6}\b/],
  },
  { type: "link_linear", res: [/\blinear\b/i] },
  // "Expert" here is Simployer's legal-advisory tier, not a generic expert.
  {
    type: "route_expert",
    res: [
      /simployer\s*expert/i,
      /\bexpert\s*(?:advisors?|r[åa]dgiv\w*)/i,
      /(?:route|refer|send|videresend|hänvisa)\w*\s+(?:it\s+|this\s+|the\s+\w+\s+)?to\s+(?:simployer\s+)?expert/i,
    ],
  },
  // A named higher tier. Same observable signal as route_expert (the group moves),
  // different destination — see the deviation note in migration 42.
  {
    type: "escalate",
    res: [/\bescalat\w+/i, /\b(?:2nd|second)[- ]line\b/i, /eskaler\w+/i, /(?:development|product|dev)\s+team/i],
  },
  {
    type: "copy_csm",
    res: [/\bcsm\b/i, /customer\s+success/i, /account\s+manager/i, /kundansvarig/i, /kunder[åa]dgiver/i],
  },
  {
    type: "offer_meeting",
    res: [
      /\b(?:offer|book|schedule|arrange|tilby|erbjud)\w*\s+(?:a\s+|an\s+|en\s+|ett\s+)?(?:session|meeting|call|walkthrough|demo|workshop|m[øo]te)/i,
    ],
  },
  {
    type: "write_kb",
    res: [
      /\b(?:write|create|draft|publish|document)\w*\s+(?:a\s+|an\s+|the\s+)?(?:kb|knowledge[- ]base|help[- ]centre|help[- ]center|confluence|support)?\s*(?:article|page|guide|documentation)\b/i,
      /knowledge[- ]base\s+article/i,
      /confluence\s+page/i,
    ],
  },
];

/**
 * Classify one recommended step. Deterministic and case-tolerant; anything that
 * does not clearly match a signal-bearing pattern falls through to
 * `internal_check` rather than being optimistically labelled.
 */
export function classifyNextStep(text: string): StepType {
  const t = (text ?? "").trim();
  if (!t) return "internal_check";
  for (const rule of RULES) {
    if (rule.res.some((re) => re.test(t))) return rule.type;
  }
  return "internal_check";
}

/** Pull an issue-key-looking reference out of a step, for `target_ref`. */
export function extractTargetRef(text: string): string | null {
  const m = /\b([A-Z]{2,5}-\d{2,6})\b/.exec(text ?? "");
  return m ? m[1] : null;
}

// ── Delivery timing ───────────────────────────────────────────────────────────

export type DeliveryStatus = "in_time" | "late" | "no_reply_yet" | "backfill";

/**
 * The first PUBLIC agent reply on a ticket — the deadline the note has to beat.
 *
 * Freshdesk answers the spec's open question about bot parts for free: our AI
 * only ever writes PRIVATE notes, so filtering to `private: false` already
 * excludes it. `incoming: false` is the outbound direction, i.e. an agent
 * speaking to the customer.
 */
export function firstAgentReplyAt(ticket: Pick<Ticket, "conversations">): string | null {
  const replies = (ticket.conversations ?? [])
    .filter((c: Conversation) => c && !c.incoming && !c.private && c.created_at)
    .map((c) => c.created_at)
    .sort();
  return replies[0] ?? null;
}

/**
 * Did the note land before the agent started writing?
 *
 * This distinction is the whole point: a note that arrives after the first reply
 * is a DELIVERY failure, not a bad suggestion. Conflating the two understates the
 * model — it gets blamed for advice the agent never saw.
 *
 * BACKFILL is the third case, and it is the one this function originally got
 * wrong. A generation created AFTER the agent had already replied was never in
 * the race: the ticket was answered before the pipeline ever looked at it. That
 * is a batch run over an old ticket, not a delivery that arrived too late.
 * Scoring it as `late` made every historical run look like a missed deadline —
 * on the first real measurement, all 34 "late" notes turned out to be exactly
 * this, and the true late count was zero.
 *
 * `generatedAt` is the discriminator and it is a FACT about the row, not a
 * tuned threshold: either we started before the agent replied or we did not.
 * Callers that genuinely have no generation time may omit it, and the old
 * two-argument behaviour applies.
 */
export function deriveDeliveryStatus(
  noteCreatedAt: string | null,
  firstReplyAt: string | null,
  generatedAt?: string | null,
): DeliveryStatus {
  if (!firstReplyAt) return "no_reply_yet";
  // The race was already over before we started — there was no deadline to miss.
  if (generatedAt && Date.parse(generatedAt) > Date.parse(firstReplyAt)) return "backfill";
  if (!noteCreatedAt) return "late"; // in the race, never delivered, agent replied
  return Date.parse(noteCreatedAt) <= Date.parse(firstReplyAt) ? "in_time" : "late";
}

// ── Observation ───────────────────────────────────────────────────────────────

/** Evidence gathered read-only from the systems that ARE connected. */
export interface ObservationEvidence {
  /** Freshdesk group name on the ticket now, if the group could be resolved. */
  groupName?: string | null;
  /**
   * A Jira issue genuinely references this ticket — confirmed by the ticket URL
   * appearing in the issue description, not merely by a full-text hit on the
   * bare number (see atlassian.ts).
   */
  jiraIssueLinked?: boolean;
  /** Group id at generation time, to detect that it moved at all. */
  groupChanged?: boolean;
  /** A KB article was requested/approved for this ticket (our own table). */
  kbArticleRequested?: boolean;
  /**
   * The article actually reached the CUSTOMER knowledge base — Simployer's
   * Freshdesk help centre at /en/support/home, the same corpus the pipeline
   * retrieves from. This is the strong form of "write_kb was followed":
   * requesting an article is an intention, publishing it is the outcome.
   */
  kbArticlePublished?: boolean;
}

export interface Observation {
  observed: boolean;
  /** Null when the signal's system is not connected — "unknown", not "no". */
  observable: boolean;
  observedVia: string | null;
}

const EXPERT_GROUP = /expert/i;

/**
 * Decide whether a step was followed, from evidence only.
 *
 * Three-valued on purpose: `observed:false, observable:false` means "we cannot
 * see", which must never be rendered as "the agent ignored it". Follow-through is
 * observed, never self-reported — there is deliberately no code path here that
 * accepts an agent's own claim.
 */
export function evaluateObservation(
  type: StepType,
  evidence: ObservationEvidence,
  env?: EnvLookup,
): Observation {
  // Not reachable in this deployment → UNKNOWN, never "the agent did not do it".
  if (!stepObservable(type, env)) return { observed: false, observable: false, observedVia: null };

  switch (type) {
    case "route_expert": {
      const hit = !!evidence.groupName && EXPERT_GROUP.test(evidence.groupName);
      return { observed: hit, observable: true, observedVia: hit ? STEP_SIGNAL[type].label : null };
    }
    case "escalate": {
      const hit = evidence.groupChanged === true;
      return { observed: hit, observable: true, observedVia: hit ? STEP_SIGNAL[type].label : null };
    }
    case "link_jira": {
      const hit = evidence.jiraIssueLinked === true;
      return { observed: hit, observable: true, observedVia: hit ? "Jira" : null };
    }
    case "write_kb": {
      // Published beats requested: the knowledge only exists for the next
      // customer once it is in the help centre. A request that never gets
      // published is the failure mode this distinction exists to expose.
      if (evidence.kbArticlePublished === true) {
        return { observed: true, observable: true, observedVia: "customer knowledge base" };
      }
      const hit = evidence.kbArticleRequested === true;
      return { observed: hit, observable: true, observedVia: hit ? STEP_SIGNAL[type].label : null };
    }
    default:
      return { observed: false, observable: false, observedVia: null };
  }
}

/**
 * Share of recommendations that carry no observable signal. Over
 * INTERNAL_CHECK_BUDGET the prompt is producing advice that cannot be evaluated —
 * which is a prompt problem to fix, not an agent problem to chase.
 */
export function unobservableShare(types: StepType[], env?: EnvLookup): number {
  if (!types.length) return 0;
  const blind = types.filter((t) => !stepObservable(t, env)).length;
  return blind / types.length;
}

// ── Baselines measured on the COACHED population (2026-08-04) ────────────────
//
// The original baselines came from Intercom. They reproduced exactly against
// that API, but Intercom is a different support channel: our pipeline watches
// Freshdesk, those conversations arrive through onesupport.simployer.com, and no
// record links the two. Comparing coaching performance on Freshdesk tickets
// against Intercom's population was apples to oranges, so the baselines are now
// computed from the tickets the AI actually coaches.
//
// Every metric below is derived from ONE `ticketWithConversations` read — the
// same call the observer already makes — so measuring costs no new API surface.
//
// Naming is deliberately literal. Freshdesk exposes no reopen counter, so this
// does NOT claim to measure "reopen rate": it measures whether the customer came
// back after the first agent reply, which is a different thing and the honest
// name for what the data supports.

export interface TicketMetrics {
  /** Seconds from ticket creation to the first PUBLIC agent reply. */
  firstReplySeconds: number | null;
  /** Public agent replies on the ticket — the "how many turns did this take" figure. */
  agentReplies: number;
  /**
   * Seconds from creation to the last message. A PROXY for time-to-close:
   * Freshdesk's true resolved_at lives on `?include=stats`, which this codebase
   * does not fetch, so the last activity is the closest honest stand-in.
   */
  spanSeconds: number | null;
  /**
   * Did the customer write again AFTER the first agent reply? The answer did not
   * land first time. This is the coaching-relevant cousin of a reopen, and it is
   * named for what it measures rather than borrowing Intercom's word.
   */
  customerReturned: boolean;
}

export function ticketMetrics(
  ticket: Pick<Ticket, "conversations"> & { created_at?: string },
): TicketMetrics {
  const convos = (ticket.conversations ?? []).filter((c) => c && c.created_at);
  const publicAgent = convos
    .filter((c) => !c.incoming && !c.private)
    .map((c) => c.created_at)
    .sort();
  const incoming = convos
    .filter((c) => c.incoming && !c.private)
    .map((c) => c.created_at)
    .sort();

  const created = ticket.created_at ? Date.parse(ticket.created_at) : NaN;
  const firstReply = publicAgent[0] ? Date.parse(publicAgent[0]) : NaN;

  const all = convos.map((c) => Date.parse(c.created_at)).filter((n) => !isNaN(n)).sort();
  const last = all.length ? all[all.length - 1] : NaN;

  return {
    firstReplySeconds: !isNaN(created) && !isNaN(firstReply)
      // A reply timestamped before the ticket is clock skew, not a negative wait.
      ? Math.max(0, Math.round((firstReply - created) / 1000))
      : null,
    agentReplies: publicAgent.length,
    spanSeconds: !isNaN(created) && !isNaN(last) ? Math.max(0, Math.round((last - created) / 1000)) : null,
    customerReturned: !isNaN(firstReply) &&
      incoming.some((t) => Date.parse(t) > firstReply),
  };
}

/** The reply-time buckets behind the timing bar. Same boundaries as before. */
export const REPLY_BUCKETS = [
  { key: "under_60s", label: "under 1 min", maxSeconds: 60 },
  { key: "1_5min", label: "1–5 min", maxSeconds: 300 },
  { key: "5_15min", label: "5–15 min", maxSeconds: 900 },
  { key: "over_15min", label: "over 15 min", maxSeconds: Infinity },
] as const;

export function replyBucket(seconds: number): string {
  for (const b of REPLY_BUCKETS) {
    if (seconds < b.maxSeconds) return b.key;
  }
  return "over_15min";
}

/** Median of a numeric sample. Median, not mean — support times are long-tailed. */
export function median(values: number[]): number | null {
  const xs = values.filter((v) => typeof v === "number" && !isNaN(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

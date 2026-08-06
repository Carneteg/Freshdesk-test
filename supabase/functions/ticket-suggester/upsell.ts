// Upsell detection — "the customer asked for something they do not have".
//
// A support ticket is often where a customer describes a need in their own
// words. If that capability is not in what the account pays for, that is a
// commercial signal, and today it dies in the ticket.
//
// THE SPLIT THAT MAKES THIS SAFE (CLAUDE.md §12):
//
//   the model    reads the TICKET TEXT and says which catalogue capabilities the
//                customer is asking about. It is handed the capability list and
//                may answer only with keys from it, so it cannot invent a
//                product. It never sees the customer's subscriptions.
//
//   TypeScript   joins those capabilities against the CRM subscriptions and
//                decides what is an opportunity, what they already own, and what
//                is simply unknowable because the CRM did not resolve.
//
// That split is not ceremony. CRM data must enter no prompt (§12, Freshworks is
// read-only context rendered into the note), and a model that could see the
// subscription list would be free to hallucinate a gap in it. Same stance as
// deriveCoachMode, verifyGroundingRefs and the QA validator: the model proposes,
// TypeScript decides.
//
// WHAT THIS IS NOT: a sales pitch. Nothing here touches the customer draft, and
// no upsell wording is ever written toward a customer. The signal is internal —
// it tells the agent to hand the account on, which is the routing behaviour the
// coach framing already asks for.
//
// Versioned separately and kept OUT of analyse → draft → verify, the same
// modular stance as the QA Coach and the article writer, so editing it never
// forces a golden-set re-run.

import type { LLM } from "./clients.ts";
import type { CustomerSubscriptionContext } from "./render.ts";

export const UPSELL_VERSION = "ups-2026-08-06a";

/** One curated row of `product_catalog`. */
export interface CatalogEntry {
  capability: string;
  description: string;
  productName: string;
  crmAliases: string[];
  agentNote?: string | null;
}

export interface RequestedCapability {
  capability: string;
  /** The product that provides it, from the catalogue — never from the model. */
  product: string;
  /** The customer's own words. Quoted ticket text: customer content. */
  evidence: string;
  /** Decided in code from the CRM subscriptions; null when ownership is unknowable. */
  owned: boolean | null;
  agentNote?: string | null;
}

export interface UpsellResult {
  status:
    | "opportunity" // asked for something the account does not hold
    | "owned" // asked for something they already pay for
    | "none" // asked for nothing in the catalogue
    | "unknown_subscription" // asked for something, but the CRM never resolved
    | "unavailable"; // the detector itself failed
  requested: RequestedCapability[];
  opportunities: RequestedCapability[];
  version: string;
  model: string;
}

const SYSTEM = [
  "You read a customer support ticket and decide which PRODUCT CAPABILITIES the customer is asking for.",
  "",
  "You are given a fixed list of capabilities. Answer ONLY with keys from that list.",
  "If the ticket asks for something that is not on the list, that is not a capability — leave it out.",
  "Never invent a capability, a product or a feature.",
  "",
  "Include a capability only when the customer is asking to DO the thing or asking whether it is",
  "possible — an actual want. Do not include a capability merely because a word from its description",
  "appears in the ticket. Someone reporting a bug in a feature is not asking for the feature.",
  "",
  "For each capability you return, quote the customer's own words that show it — a short exact span",
  "from the ticket, not a paraphrase. If you cannot quote it, you are guessing: leave it out.",
  "",
  "You do NOT know what this customer already pays for, and it is not your job to guess.",
  "Report what they asked for; something else decides what that means.",
].join("\n");

const SCHEMA = {
  name: "requested_capabilities",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["requested"],
    properties: {
      requested: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["capability", "evidence"],
          properties: {
            capability: { type: "string", description: "a key from the supplied list, verbatim" },
            evidence: { type: "string", description: "a short exact quote from the ticket" },
          },
        },
      },
    },
  },
};

/**
 * Normalise a product name for comparison: case-folded, punctuation-stripped.
 * CRM subscription rows and the catalogue are maintained by different people, so
 * "Simployer Expert" and "simployer expert" must compare equal — but nothing
 * looser than that. A fuzzy match here would silently mark an opportunity as
 * already-owned, which is the failure that makes the whole signal worthless.
 */
function normProduct(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9åäöæø]+/g, " ").trim();
}

/**
 * Does the account hold the product this capability needs?
 *
 * Decided here, in code, from CRM data the model never saw. Returns null when
 * the question is unanswerable — the CRM did not resolve the account, so "they
 * do not have it" would be an assumption dressed as a finding.
 */
export function ownsProduct(
  entry: CatalogEntry,
  context: CustomerSubscriptionContext | null | undefined,
): boolean | null {
  if (!context || context.status !== "found") return null;
  const held = new Set(
    (context.subscriptions ?? [])
      .map((s) => normProduct(s.productName ?? ""))
      .filter(Boolean),
  );
  // An account that resolved but holds no subscription rows tells us nothing
  // about what it owns — treat it as unknown, not as "owns nothing".
  if (held.size === 0) return null;

  const names = [entry.productName, ...(entry.crmAliases ?? [])]
    .map(normProduct)
    .filter(Boolean);
  return names.some((n) => held.has(n));
}

/**
 * Decide the overall status from the per-capability verdicts. Split out so the
 * precedence is testable and stated once.
 */
export function upsellStatus(requested: RequestedCapability[]): UpsellResult["status"] {
  if (!requested.length) return "none";
  if (requested.some((r) => r.owned === false)) return "opportunity";
  // Nothing confirmed missing. If any answer was unknowable, say so rather than
  // reporting "they own everything they asked for" on the strength of a CRM miss.
  if (requested.some((r) => r.owned === null)) return "unknown_subscription";
  return "owned";
}

/**
 * Run the detector. Returns null when there is nothing to do (empty catalogue or
 * no ticket text) so the caller can skip storing a row that means nothing.
 *
 * Failures are contained: a detector error must never fail the ticket, because
 * the private note is the deliverable and an upsell hint is a bonus.
 */
export async function detectUpsell(
  deps: { llm: LLM; model: string },
  input: {
    catalog: CatalogEntry[];
    ticketText: string;
    subject?: string;
    subscriptions?: CustomerSubscriptionContext | null;
  },
): Promise<UpsellResult | null> {
  const catalog = input.catalog.filter((c) => c.capability && c.description);
  if (!catalog.length) return null;
  const text = (input.ticketText ?? "").trim();
  if (!text) return null;

  const byKey = new Map(catalog.map((c) => [c.capability.toLowerCase(), c]));

  const user = [
    "CAPABILITIES (answer only with these keys):",
    ...catalog.map((c) => `- ${c.capability}: ${c.description}`),
    "",
    input.subject ? `TICKET SUBJECT: ${input.subject}` : "",
    "TICKET:",
    text,
  ].filter(Boolean).join("\n");

  let raw: { requested?: Array<{ capability?: string; evidence?: string }> };
  try {
    raw = await deps.llm.completeSchema(SYSTEM, user, SCHEMA, { maxTokens: 700 });
  } catch (_e) {
    // Deliberately no detail: the message could carry ticket text (CLAUDE.md §5).
    return {
      status: "unavailable",
      requested: [],
      opportunities: [],
      version: UPSELL_VERSION,
      model: deps.model,
    };
  }

  const seen = new Set<string>();
  const requested: RequestedCapability[] = [];
  for (const item of raw.requested ?? []) {
    const key = String(item?.capability ?? "").trim().toLowerCase();
    const entry = byKey.get(key);
    // A key that is not in the catalogue is dropped, not repaired. The model was
    // given a closed list; answering outside it is exactly the invention this
    // design exists to prevent.
    if (!entry || seen.has(key)) continue;
    seen.add(key);
    requested.push({
      capability: entry.capability,
      product: entry.productName,
      evidence: String(item?.evidence ?? "").trim().slice(0, 300),
      owned: ownsProduct(entry, input.subscriptions),
      agentNote: entry.agentNote ?? null,
    });
  }

  return {
    status: upsellStatus(requested),
    requested,
    opportunities: requested.filter((r) => r.owned === false),
    version: UPSELL_VERSION,
    model: deps.model,
  };
}

/** Load the active catalogue. An empty table means the detector is simply off. */
// deno-lint-ignore no-explicit-any
export async function loadCatalog(db: any): Promise<CatalogEntry[]> {
  try {
    const { data, error } = await db
      .from("product_catalog")
      .select("capability,description,product_name,crm_aliases,agent_note")
      .eq("active", true);
    if (error || !Array.isArray(data)) return [];
    // deno-lint-ignore no-explicit-any
    return data.map((row: any) => ({
      capability: String(row.capability ?? ""),
      description: String(row.description ?? ""),
      productName: String(row.product_name ?? ""),
      crmAliases: Array.isArray(row.crm_aliases) ? row.crm_aliases.map(String) : [],
      agentNote: row.agent_note ?? null,
    }));
  } catch (_e) {
    return [];
  }
}

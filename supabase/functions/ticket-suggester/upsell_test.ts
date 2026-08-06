// Upsell detection — the parts decided in CODE.
//
// The model's half (reading a ticket) is not unit-testable and is not what can
// silently go wrong. What CAN go wrong is the ownership join: a loose match that
// marks a real opportunity "already owned" makes the whole signal worthless, and
// a missing null-case turns "the CRM did not resolve" into "they do not have
// it" — an assumption dressed as a finding.

import { assertEquals } from "./test_assert.ts";
import {
  type CatalogEntry,
  ownsProduct,
  upsellStatus,
  type RequestedCapability,
} from "./upsell.ts";
import type { CustomerSubscriptionContext } from "./render.ts";

const expert: CatalogEntry = {
  capability: "legal_updates",
  description: "legal guidance",
  productName: "Simployer Expert",
  crmAliases: ["Expert", "Simployer Expert NO"],
};

function found(...products: string[]): CustomerSubscriptionContext {
  return {
    status: "found",
    subscriptions: products.map((p) => ({
      productName: p,
      renewalStatus: null,
      endDate: null,
    })),
  };
}

Deno.test("ownsProduct: exact product name matches", () => {
  assertEquals(ownsProduct(expert, found("Simployer Expert")), true);
});

Deno.test("ownsProduct: case and punctuation differences still match", () => {
  // The catalogue and the CRM are maintained by different people; "simployer
  // expert" and "Simployer  Expert" are the same product.
  assertEquals(ownsProduct(expert, found("simployer  expert")), true);
});

Deno.test("ownsProduct: a CRM alias matches", () => {
  assertEquals(ownsProduct(expert, found("Simployer Expert NO")), true);
});

Deno.test("ownsProduct: a different product is NOT a match", () => {
  // The failure that would matter most is the opposite of a false positive: a
  // loose match here would hide every real opportunity behind "already owned".
  assertEquals(ownsProduct(expert, found("Simployer One")), false);
});

Deno.test("ownsProduct: a product that merely CONTAINS the name is not a match", () => {
  // "Simployer Expert Lite" is a different SKU. Substring matching would call
  // it owned; equality after normalisation does not.
  assertEquals(ownsProduct(expert, found("Simployer Expert Lite")), false);
});

Deno.test("ownsProduct: no CRM match means UNKNOWN, not 'does not have it'", () => {
  assertEquals(ownsProduct(expert, { status: "no_match", subscriptions: [] }), null);
});

Deno.test("ownsProduct: ambiguous CRM never resolves to an answer", () => {
  // Guessing between customers is never allowed (CLAUDE.md §12).
  assertEquals(
    ownsProduct(expert, { status: "ambiguous", subscriptions: [], candidates: ["A AB", "A AS"] }),
    null,
  );
});

Deno.test("ownsProduct: account matched but holds no subscriptions is unknown", () => {
  // An empty subscription list tells us nothing about what they own — reading it
  // as "owns nothing" would report an opportunity on every capability.
  assertEquals(ownsProduct(expert, found()), null);
});

Deno.test("ownsProduct: no CRM context at all is unknown", () => {
  assertEquals(ownsProduct(expert, null), null);
  assertEquals(ownsProduct(expert, undefined), null);
});

// ── status precedence ────────────────────────────────────────────────────────

function req(owned: boolean | null): RequestedCapability {
  return { capability: "c", product: "P", evidence: "e", owned };
}

Deno.test("upsellStatus: nothing asked for is 'none'", () => {
  assertEquals(upsellStatus([]), "none");
});

Deno.test("upsellStatus: a confirmed gap is an opportunity", () => {
  assertEquals(upsellStatus([req(false)]), "opportunity");
});

Deno.test("upsellStatus: a confirmed gap wins over an unknown", () => {
  // One thing we KNOW they lack is actionable even if another is unresolved.
  assertEquals(upsellStatus([req(null), req(false)]), "opportunity");
});

Deno.test("upsellStatus: an unknown wins over 'owned'", () => {
  // Reporting "they own everything they asked for" on the strength of a CRM miss
  // is the quiet false negative this precedence exists to prevent.
  assertEquals(upsellStatus([req(true), req(null)]), "unknown_subscription");
});

Deno.test("upsellStatus: everything owned is 'owned'", () => {
  assertEquals(upsellStatus([req(true), req(true)]), "owned");
});

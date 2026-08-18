// The one decision in the facts sync that code makes rather than copies:
// which product group a product name belongs to.
//
// It is deliberately NOT binary, and it deliberately does not substring-match.
// Both properties are easy to "simplify" away later, and both would quietly
// corrupt every One-vs-Classic figure that rests on them.

import { assertEquals } from "./test_assert.ts";
import { productGroup } from "./ticket-facts.ts";

Deno.test("productGroup: the two One spellings both resolve to one", () => {
  assertEquals(productGroup("Simployer One (Alexis)"), "one");
  assertEquals(productGroup("Simployer One"), "one");
  assertEquals(productGroup("AlexisHR"), "one");
});

Deno.test("productGroup: Classic includes the Handbooks product", () => {
  assertEquals(productGroup("Simployer Classic"), "classic");
  assertEquals(productGroup("Handbooks (Simployer Classic)"), "classic");
});

Deno.test("productGroup: case and padding do not change the answer", () => {
  assertEquals(productGroup("  simployer CLASSIC "), "classic");
});

Deno.test("productGroup: other products stay 'other', not folded into a binary", () => {
  // ~1700 of 3000 live tickets are on these. Forcing them into One or Classic
  // would invent a split the data does not contain.
  for (const p of [
    "Experthelp/Faghjelp",
    "Employee survey (&frankly)",
    "Capitech",
    "Learn and courses",
    "Talent/LMS",
    "Equal Pay",
    "Invoices & subscriptions",
    "All Products",
    "Other",
  ]) {
    assertEquals(productGroup(p), "other");
  }
});

Deno.test("productGroup: a missing product is unknown, never a guess", () => {
  assertEquals(productGroup(null), "unknown");
  assertEquals(productGroup(undefined), "unknown");
  assertEquals(productGroup(""), "unknown");
  assertEquals(productGroup("   "), "unknown");
});

Deno.test("productGroup: does NOT substring-match on 'Classic'", () => {
  // A future "Simployer One Handbooks (replaces Classic)" must not be swept
  // into Classic by a loose includes() — it is a One product.
  assertEquals(productGroup("Simployer One Handbooks (replaces Classic)"), "other");
});

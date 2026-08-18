// Pure helpers for the ticket-facts sync. No I/O, no env reads — so they can be
// unit-tested without the script's Freshdesk/Supabase setup running on import.

/**
 * Product name -> the three-way group.
 *
 * Deliberately NOT binary. On a live 3000-ticket sample the split was
 * Classic 1174 · Simployer One (Alexis) 21 · ~1700 on other products entirely
 * (Expert, Employee Survey, Capitech, Learn, Talent, Equal Pay, Invoices).
 * Folding those into "One or Classic" would invent a split the data does not
 * contain, so they get their own group and keep their real product name.
 *
 * Matching is on explicit names, never substrings: "Handbooks (Simployer
 * Classic)" is Classic, but a future "Simployer One Handbooks (replaces
 * Classic)" must not be swept into Classic by a loose includes().
 */
export function productGroup(
  product: string | null | undefined,
): "one" | "classic" | "other" | "unknown" {
  const p = (product ?? "").trim().toLowerCase();
  if (!p) return "unknown";
  if (p === "simployer one (alexis)" || p === "simployer one" || p === "alexishr") return "one";
  if (p === "simployer classic" || p === "handbooks (simployer classic)") return "classic";
  return "other";
}

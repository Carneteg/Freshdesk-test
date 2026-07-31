// CRM lookup probe — settle the 0/4 no_match question (CLAUDE.md §7: verify,
// do not assume). The matching ladder assumes Freshworks' /lookup endpoint
// answers `f=name&entities=sales_account` and `f=email&entities=contact` with
// rows we can parse. This probe runs BOTH against known-good records and prints
// the response SHAPE (keys, counts, names) — enough to diagnose, without
// dumping full payloads.
//
//   deno run --allow-env --allow-net scripts/probe_crm_lookup.ts \
//     "STUDENTSAMSKIPNADEN I STAVANGER" "ozlem@minsis.no"
//
// Args: [1] an account name that EXISTS in the CRM, [2] a contact email that
// EXISTS with the Account field set. Env: FRESHWORKS_CRM_BASE_URL,
// FRESHWORKS_CRM_API_KEY (the read-only CRM key — never the Freshdesk key).
//
// Interpretation:
//   * name-lookup returns the account   -> ladder assumption holds; 0/4 means
//     those customers are simply not in the CRM by our keys (register coverage)
//     -> curate crm_account_map rows / fill Account fields in the CRM.
//   * name-lookup returns nothing/error -> the endpoint assumption is wrong ->
//     the client must be adapted (report the printed shape back).
//   * email-lookup shows the contact without account ids -> the Account link is
//     not exposed by this endpoint -> tier 1 needs a different call.

const base = (Deno.env.get("FRESHWORKS_CRM_BASE_URL") ?? "").replace(/\/+$/, "");
const key = Deno.env.get("FRESHWORKS_CRM_API_KEY") ?? "";
if (!base || !key) {
  console.error("Set FRESHWORKS_CRM_BASE_URL and FRESHWORKS_CRM_API_KEY first.");
  Deno.exit(1);
}
const accountName = Deno.args[0] ?? "";
const contactEmail = Deno.args[1] ?? "";
if (!accountName) {
  console.error("Usage: probe_crm_lookup.ts \"<known account name>\" [known-contact@email]");
  Deno.exit(1);
}

async function probe(label: string, params: Record<string, string>) {
  const url = `${base}/lookup?${new URLSearchParams(params)}`;
  console.log(`\n── ${label} ─ GET /lookup?${new URLSearchParams(params)}`);
  const res = await fetch(url, {
    headers: { authorization: `Token token=${key}`, accept: "application/json" },
  });
  console.log(`HTTP ${res.status}`);
  if (!res.ok) {
    console.log(`body head: ${(await res.text()).slice(0, 300)}`);
    return;
  }
  const body = await res.json();
  // Shape only: top-level keys, per-entity counts, and (for accounts) the names
  // + whether id/name/website fields are where the parser expects them.
  console.log(`top-level keys: ${Object.keys(body).join(", ")}`);
  for (const [k, v] of Object.entries(body)) {
    const rows = Array.isArray(v)
      ? v
      : (v && typeof v === "object" && Array.isArray((v as Record<string, unknown>)[k]))
      ? (v as Record<string, unknown[]>)[k]
      : null;
    if (!rows) {
      console.log(`  ${k}: (non-array shape: ${v === null ? "null" : typeof v})`);
      continue;
    }
    console.log(`  ${k}: ${rows.length} row(s)`);
    for (const row of rows.slice(0, 5)) {
      const r = row as Record<string, unknown>;
      console.log(
        `    keys=[${Object.keys(r).slice(0, 12).join(",")}] ` +
          `id=${r.id ?? "-"} name=${JSON.stringify(r.name ?? r.display_name ?? "-")} ` +
          `website=${JSON.stringify(r.website ?? "-")} ` +
          `company.id=${(r.company as Record<string, unknown> | undefined)?.id ?? "-"} ` +
          `sales_accounts=${Array.isArray(r.sales_accounts) ? (r.sales_accounts as unknown[]).length : "-"}`,
      );
    }
  }
}

// 1. The ladder's tier-2/3 assumption: account search by name.
await probe("account by name", { q: accountName, f: "name", entities: "sales_account" });
// 2. The stem the ladder would actually send (first word, lowercased).
const stem = accountName.toLowerCase().split(/\s+/)[0];
if (stem !== accountName.toLowerCase()) {
  await probe("account by name STEM", { q: stem, f: "name", entities: "sales_account" });
}
// 3. Tier 1: contact by email — does the response carry the Account link?
if (contactEmail) {
  await probe("contact by email", { q: contactEmail, f: "email", entities: "contact" });
}
console.log(
  "\nDone. If the account rows appeared with id+name, the ladder's endpoint " +
    "assumption HOLDS and no_match means register coverage — curate " +
    "crm_account_map / fill Account fields. If not, send this output back so " +
    "the client can be adapted.",
);

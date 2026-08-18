// scripts/ticket_landscape.ts — PROBE ONLY (step 1 of the company/product view).
//
// Answers three questions before any table is designed:
//   1. Do tickets carry a company? (top-10-by-company is impossible without it)
//   2. Is "Simployer One vs Classic" a FIELD, or would it have to be guessed
//      from text? Guessing product from keywords is the Gate 1 failure mode, so
//      this has to be settled from data, not assumed.
//   3. What else is on a ticket that could say what it is ABOUT (type, group,
//      product, custom fields)?
//
// Reads only. Writes nothing, calls no LLM. Prints SHAPE and COUNTS — never a
// subject line or customer text, so it is safe in CI logs (§5).
//
//   deno task ticket-landscape          (default 300 tickets)
//   LANDSCAPE_COUNT=1000 deno task ticket-landscape

import { Freshdesk } from "../supabase/functions/ticket-suggester/clients.ts";

function env(name: string): string {
  const v = Deno.env.get(name) ?? "";
  if (!v) { console.error(`missing required env var: ${name}`); Deno.exit(1); }
  return v;
}

const fd = new Freshdesk(env("FRESHDESK_DOMAIN"), env("FRESHDESK_API_KEY"));
const want = Number(Deno.env.get("LANDSCAPE_COUNT") ?? "300");

// ── Groups: the most likely home of a One/Classic split ──────────────────────
console.log("\n[1] GET /groups");
try {
  const groups = await fd.groups();
  console.log(`  ${groups.length} group(s):`);
  for (const g of groups) console.log(`    ${g.id}  ${g.name ?? "(unnamed)"}`);
} catch (e) {
  console.log(`  failed: ${e instanceof Error ? e.name : "error"}`);
}

// ── Ticket field landscape ───────────────────────────────────────────────────
// listUpdatedTickets returns the list shape; one full ticket shows every field
// the detail endpoint carries, including custom fields.
console.log(`\n[2] Ticket fields (sampling up to ${want} tickets)`);
const since = new Date(Date.now() - 365 * 86_400_000).toISOString();
const tickets = [];
for (let page = 1; tickets.length < want && page <= 30; page++) {
  const rows = await fd.listUpdatedTickets(since, page);
  tickets.push(...rows);
  if (rows.length < 100) break;
}
console.log(`  sampled ${tickets.length} ticket(s)`);

// deno-lint-ignore no-explicit-any
const anyT = tickets as any[];
const withCompany = anyT.filter((t) => t.company_id != null).length;
const withGroup = anyT.filter((t) => t.group_id != null).length;
const withProduct = anyT.filter((t) => t.product_id != null).length;
const withType = anyT.filter((t) => t.type != null).length;
console.log(`  company_id present : ${withCompany}/${tickets.length}`);
console.log(`  group_id present   : ${withGroup}/${tickets.length}`);
console.log(`  product_id present : ${withProduct}/${tickets.length}`);
console.log(`  type present       : ${withType}/${tickets.length}`);

const dist = (key: string) => {
  const m = new Map<string, number>();
  for (const t of anyT) {
    const k = String(t[key] ?? "(null)");
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
};
console.log("\n  type distribution (top 15):");
for (const [k, n] of dist("type")) console.log(`    ${String(k).padEnd(34)} ${n}`);
console.log("\n  group_id distribution (top 15):");
for (const [k, n] of dist("group_id")) console.log(`    ${String(k).padEnd(34)} ${n}`);
console.log("\n  product_id distribution:");
for (const [k, n] of dist("product_id")) console.log(`    ${String(k).padEnd(34)} ${n}`);

// Custom fields: KEYS only. A "product" custom field would settle question 2.
console.log("\n[3] Custom-field KEYS on a detail fetch (values never printed)");
const probeId = anyT[0]?.id;
if (probeId) {
  try {
    // deno-lint-ignore no-explicit-any
    const full = await fd.ticketWithConversations(probeId) as any;
    const cf = full.custom_fields ?? {};
    const keys = Object.keys(cf);
    console.log(`  ticket carries ${keys.length} custom field(s):`);
    for (const k of keys) console.log(`    ${k}  (${cf[k] === null ? "null" : typeof cf[k]})`);
    const top = Object.keys(full).sort();
    console.log(`\n  all top-level ticket keys: ${top.join(", ")}`);
  } catch (e) {
    console.log(`  failed: ${e instanceof Error ? e.name : "error"}`);
  }
}

// ── Company coverage ────────────────────────────────────────────────────────
console.log("\n[4] Company coverage");
const companyIds = [...new Set(anyT.map((t) => t.company_id).filter((x) => x != null))];
console.log(`  ${companyIds.length} distinct company id(s) across the sample`);
const counts = new Map<number, number>();
for (const t of anyT) {
  if (t.company_id == null) continue;
  counts.set(t.company_id, (counts.get(t.company_id) ?? 0) + 1);
}
const top10 = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log("  top 10 by ticket count (names resolved below):");
for (const [id, n] of top10) {
  let name = "(lookup failed)";
  try {
    const c = await fd.company(id);
    name = c.name ?? "(unnamed)";
  } catch { /* keep placeholder */ }
  console.log(`    ${String(n).padStart(4)}  ${name}`);
}
console.log("\nProbe complete. Nothing was written.");

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
const want = Number(Deno.env.get("LANDSCAPE_COUNT") ?? "3000");

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
for (let page = 1; tickets.length < want && page <= 60; page++) {
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

// ── Custom-field VALUES ─────────────────────────────────────────────────────
//
// The first probe found the fields that matter: cf_product152991 (product) and
// cf_category_1..3 (what the ticket is about). These are TAXONOMY values, not
// customer content, so their distribution is safe to print — and it is the only
// way to learn what "One" and "Classic" are actually called in the data.
//
// First: do LIST rows already carry custom_fields? If they do, a large scan
// costs one call per 100 tickets instead of one per ticket.
console.log("\n[3] Do list rows carry custom_fields?");
const sample0 = anyT[0] ?? {};
const listHasCf = "custom_fields" in sample0 && sample0.custom_fields != null;
console.log(`  ${listHasCf ? "YES — a large scan is cheap" : "NO — custom fields need a per-ticket detail call"}`);

function valueDist(rows: Record<string, unknown>[], path: string, top = 25) {
  const m = new Map<string, number>();
  for (const r of rows) {
    // deno-lint-ignore no-explicit-any
    const cf = (r as any).custom_fields ?? {};
    // deno-lint-ignore no-explicit-any
    const v = (cf as any)[path];
    const k = v === null || v === undefined || v === "" ? "(empty)" : String(v);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
}

if (listHasCf) {
  for (const field of ["cf_product152991", "cf_category_1", "cf_category_2", "cf_category_3", "cf_language"]) {
    console.log(`\n  ${field}:`);
    for (const [v, n] of valueDist(anyT, field)) {
      console.log(`    ${String(n).padStart(5)}  ${v}`);
    }
  }
} else {
  // Fall back to a small detail sample so we still learn the vocabulary.
  console.log("  sampling 25 tickets by detail call for custom-field values…");
  const detail: Record<string, unknown>[] = [];
  for (const t of anyT.slice(0, 25)) {
    try { detail.push(await fd.ticketWithConversations(t.id) as unknown as Record<string, unknown>); }
    catch { /* skip */ }
  }
  for (const field of ["cf_product152991", "cf_category_1", "cf_category_2", "cf_category_3"]) {
    console.log(`\n  ${field}:`);
    for (const [v, n] of valueDist(detail, field)) console.log(`    ${String(n).padStart(5)}  ${v}`);
  }
}

// ── Company coverage ────────────────────────────────────────────────────────
console.log("\n[4] Company coverage");
const counts = new Map<number, number>();
for (const t of anyT) {
  if (t.company_id == null) continue;
  counts.set(t.company_id, (counts.get(t.company_id) ?? 0) + 1);
}
console.log(`  ${counts.size} distinct company id(s) across ${tickets.length} ticket(s)`);
const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log("  top 15 by ticket count:");
for (const [id, n] of top) {
  let name = "(lookup failed)";
  try { const c = await fd.company(id); name = c.name ?? "(unnamed)"; } catch { /* keep */ }
  console.log(`    ${String(n).padStart(5)}  ${name}`);
}
console.log("\nProbe complete. Nothing was written.");

// scripts/ticket_facts_sync.ts — sync ticket facts (company · product · topic).
//
// Feeds the "Companies" tab: who files the most tickets, on Simployer One vs
// Classic, and what their tickets are about.
//
// Everything comes from Freshdesk FIELDS — cf_product152991, cf_category_1..3,
// type, company_id. Nothing is inferred from ticket text: guessing a product
// from keywords is the Gate 1 failure mode.
//
//   deno task ticket-facts                (default 5000 tickets, 12 months)
//   FACTS_COUNT=20000 FACTS_MONTHS=24 deno task ticket-facts
//
// Cheap by design: the LIST endpoint already carries custom_fields (verified),
// so this costs one call per 100 tickets plus one per distinct company.
// No LLM call. Posts nothing. Prints counts only — never a subject (§5).

import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import { Freshdesk } from "../supabase/functions/ticket-suggester/clients.ts";
import { productGroup } from "../supabase/functions/ticket-suggester/ticket-facts.ts";

function env(name: string): string {
  const v = Deno.env.get(name) ?? "";
  if (!v) { console.error(`missing required env var: ${name}`); Deno.exit(1); }
  return v;
}

const fd = new Freshdesk(env("FRESHDESK_DOMAIN"), env("FRESHDESK_API_KEY"));
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

const want = Number(Deno.env.get("FACTS_COUNT") ?? "5000");
const months = Number(Deno.env.get("FACTS_MONTHS") ?? "12");

const sinceIso = new Date(Date.now() - months * 30 * 86_400_000).toISOString();
console.log(`Scanning up to ${want} ticket(s) updated since ${sinceIso.slice(0, 10)}…`);

// deno-lint-ignore no-explicit-any
const tickets: any[] = [];
for (let page = 1; tickets.length < want && page <= 200; page++) {
  const rows = await fd.listUpdatedTickets(sinceIso, page);
  tickets.push(...rows);
  if (rows.length < 100) break;
}
console.log(`  fetched ${tickets.length} ticket(s)`);

// Resolve company names once per id. A company lookup is one call, and the
// same company appears on many tickets — without the cache this would be the
// slowest part of the job by an order of magnitude.
const companyIds = [...new Set(tickets.map((t) => t.company_id).filter((x) => x != null))] as number[];
console.log(`  resolving ${companyIds.length} distinct company name(s)…`);
const names = new Map<number, string | null>();
for (const id of companyIds) {
  try {
    const c = await fd.company(id);
    names.set(id, c.name ?? null);
  } catch {
    // A company we cannot resolve stays null rather than being given a made-up
    // label — an unnamed row is honest, an invented one corrupts the ranking.
    names.set(id, null);
  }
}

const rows = tickets.map((t) => {
  const cf = t.custom_fields ?? {};
  const product = cf.cf_product152991 ?? null;
  return {
    source: "freshdesk",
    ticket_id: t.id,
    company_id: t.company_id ?? null,
    company_name: t.company_id != null ? (names.get(t.company_id) ?? null) : null,
    product,
    product_group: productGroup(product),
    category_1: cf.cf_category_1 ?? null,
    category_2: cf.cf_category_2 ?? null,
    category_3: cf.cf_category_3 ?? null,
    ticket_type: t.type ?? null,
    language: cf.cf_language ?? null,
    status: t.status ?? null,
    created_at: t.created_at ?? null,
    synced_at: new Date().toISOString(),
  };
});

// Upsert in batches: a re-run must update, never duplicate.
const BATCH = 500;
for (let i = 0; i < rows.length; i += BATCH) {
  const { error } = await db.from("ticket_facts")
    .upsert(rows.slice(i, i + BATCH), { onConflict: "source,ticket_id" });
  if (error) {
    console.error(`Supabase write failed at row ${i}: ${error.message}`);
    Deno.exit(1);
  }
}
console.log(`  stored ${rows.length} row(s)`);

// ── Report: counts only ─────────────────────────────────────────────────────
const by = (key: string) => {
  const m = new Map<string, number>();
  // deno-lint-ignore no-explicit-any
  for (const r of rows as any[]) {
    const k = String(r[key] ?? "(none)");
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

console.log("\nProduct group:");
for (const [k, n] of by("product_group")) console.log(`  ${String(n).padStart(6)}  ${k}`);

const withCompany = rows.filter((r) => r.company_name).length;
console.log(
  `\nCompany coverage: ${withCompany}/${rows.length} ` +
  `(${(100 * withCompany / Math.max(rows.length, 1)).toFixed(1)}%) — ` +
  `the ranking covers the identified population only.`,
);

console.log("\nTop 10 companies by ticket volume:");
for (const [name, n] of by("company_name").filter(([k]) => k !== "(none)").slice(0, 10)) {
  console.log(`  ${String(n).padStart(6)}  ${name}`);
}

console.log(
  "\nNOTE: Intercom is not synced by this job. Intercom is ALWAYS S1/AlexisHR, so\n" +
  "until it is included the 'one' figures here understate One by the entire\n" +
  "Intercom volume. Do not read this as the full One-vs-Classic picture.",
);

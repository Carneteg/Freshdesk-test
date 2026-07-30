import { assertEquals } from "./test_assert.ts";
import { learnAccountMap, lookupAccountMap } from "./crm-account-map.ts";

// Minimal supabase-js stand-in: records every operation, serves canned rows for
// selects keyed on "column=value", resolves inserts/updates with no error.
interface Op {
  kind: "select" | "insert" | "update";
  filters: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

function fakeDb(rows: Record<string, unknown[]>) {
  const ops: Op[] = [];
  function builder(kind: Op["kind"], payload?: Record<string, unknown>) {
    const op: Op = { kind, filters: {}, payload };
    ops.push(op);
    const chain = {
      eq(column: string, value: unknown) {
        op.filters[column] = value;
        return chain;
      },
      limit(_n: number) {
        return chain;
      },
      // deno-lint-ignore no-explicit-any
      then(resolve: (v: any) => void) {
        if (kind !== "select") return resolve({ data: null, error: null });
        const keyEntry = Object.entries(op.filters).find(([c]) => c !== "active");
        const key = keyEntry ? `${keyEntry[0]}=${keyEntry[1]}` : "";
        resolve({ data: rows[key] ?? [], error: null });
      },
    };
    return chain;
  }
  return {
    ops,
    from(_table: string) {
      return {
        select: () => builder("select"),
        insert: (payload: Record<string, unknown>) => builder("insert", payload),
        update: (payload: Record<string, unknown>) => builder("update", payload),
      };
    },
  };
}

Deno.test("accountMap: company-id hit resolves deterministically", async () => {
  const db = fakeDb({
    "freshdesk_company_id=42": [{ id: 1, crm_account_id: 555, source: "human" }],
  });
  assertEquals(await lookupAccountMap(db, { companyId: 42, domain: "acme.se" }), {
    accountId: 555,
    source: "human",
  });
});

Deno.test("accountMap: falls through company miss to a domain hit", async () => {
  const db = fakeDb({
    "email_domain=acme.se": [
      { id: 2, crm_account_id: 777, source: "learned_contact_email" },
    ],
  });
  assertEquals(await lookupAccountMap(db, { companyId: 42, domain: "acme.se" }), {
    accountId: 777,
    source: "learned_contact_email",
  });
});

Deno.test("accountMap: no rows -> null (runtime falls back to the ladder)", async () => {
  const db = fakeDb({});
  assertEquals(await lookupAccountMap(db, { companyId: 42, domain: "acme.se" }), null);
});

Deno.test("accountMap learning: a new key is inserted as learned", async () => {
  const db = fakeDb({});
  await learnAccountMap(db, { domain: "acme.se" }, 555, "Acme AB");
  const insert = db.ops.find((op) => op.kind === "insert");
  assertEquals(insert?.payload, {
    email_domain: "acme.se",
    crm_account_id: 555,
    crm_account_name: "Acme AB",
    source: "learned_contact_email",
  });
});

Deno.test("accountMap learning: a curated human row is never touched", async () => {
  const db = fakeDb({
    "email_domain=acme.se": [{ id: 3, crm_account_id: 111, source: "human" }],
  });
  await learnAccountMap(db, { domain: "acme.se" }, 999);
  assertEquals(db.ops.filter((op) => op.kind !== "select").length, 0);
});

Deno.test("accountMap learning: re-confirming the same account bumps last_confirmed_at", async () => {
  const db = fakeDb({
    "email_domain=acme.se": [
      { id: 4, crm_account_id: 555, source: "learned_contact_email" },
    ],
  });
  await learnAccountMap(db, { domain: "acme.se" }, 555);
  const update = db.ops.find((op) => op.kind === "update");
  assertEquals(typeof update?.payload?.last_confirmed_at, "string");
  assertEquals(update?.filters.id, 4);
});

Deno.test("accountMap learning: conflicting evidence DEACTIVATES, never overwrites", async () => {
  const db = fakeDb({
    "email_domain=acme.se": [
      { id: 5, crm_account_id: 555, source: "learned_contact_email" },
    ],
  });
  await learnAccountMap(db, { domain: "acme.se" }, 999);
  const update = db.ops.find((op) => op.kind === "update");
  assertEquals(update?.payload, { active: false });
  assertEquals(update?.filters.id, 5);
  assertEquals(db.ops.some((op) => op.kind === "insert"), false);
});

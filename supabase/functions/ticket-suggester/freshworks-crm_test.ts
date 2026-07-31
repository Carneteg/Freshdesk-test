import { assertEquals } from "./test_assert.ts";
import { FreshworksCRM } from "./freshworks-crm.ts";

// Fixtures below mirror the SHAPES verified against the live CRM on
// 2026-07-31 (see the crm-probe findings):
//   * /lookup?f=email&entities=contact -> { contacts: { contacts: [ … ] } },
//     and the contact row carries NO account link;
//   * /contacts/{id}?include=sales_accounts -> { contact: { sales_accounts:
//     [{ id, is_primary }] } } — this is the only place the link appears;
//   * /search?q=&include=sales_account -> a FLAT array of
//     { id: "<string>", name, website, type: "sales_account" }, capped at 10.
// /lookup?f=name&entities=sales_account is deliberately NOT used: it only
// matches (near-)full names, which is what broke every name/domain tier.

function json(value: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

// Flat search payload, ids as strings, exactly as the live API answers.
function searchRows(rows: Array<{ id: number | string; name: string; website?: string }>): Promise<Response> {
  return json(rows.map((r) => ({
    id: String(r.id),
    name: r.name,
    website: r.website ?? null,
    type: "sales_account",
  })));
}

function contactLookup(rows: Array<{ id?: number; email: string }>): Promise<Response> {
  return json({ contacts: { contacts: rows } });
}

function contactDetail(accounts: Array<{ id: number; is_primary?: boolean }>): Promise<Response> {
  return json({ contact: { sales_accounts: accounts }, meta: {} });
}

function subscriptions(rows: Array<Record<string, unknown>>): Promise<Response> {
  return json({ cm_subscription: rows });
}

function client(): FreshworksCRM {
  return new FreshworksCRM({
    baseUrl: "https://example.myfreshworks.com/crm/sales/api",
    apiKey: "separate-crm-key",
    subscriptionsPathTemplate:
      "/custom_module/cm_subscription/view/31008500658?q[]=%7B%22name%22%3A%22cf_account_number%22%2C%22operator%22%3A4%2C%22value%22%3A%22{account_id}%22%2C%22domType%22%3A6%7D",
    subscriptionsCollection: "cm_subscription",
    accountField: "cf_account_number",
    productField: "cf_product_name",
    renewalStatusField: "cf_renewal_status",
    endDateField: "cf_end_date",
  });
}

Deno.test("FreshworksCRM chains contact lookup -> detail and returns only approved fields", async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  const authorizations: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
    if (url.includes("/lookup?")) return contactLookup([{ id: 7, email: "customer@example.com" }]);
    if (url.includes("/contacts/7")) return contactDetail([{ id: 123, is_primary: true }]);
    return subscriptions([
      {
        custom_field: {
          cf_account_number: 123,
          cf_product_name: "Simployer One Complete",
          cf_renewal_status: "Active",
          cf_end_date: "2027-04-30T00:00:00Z",
          cf_contract_reference_name: "must-not-be-returned",
        },
        owner_id: 999,
      },
      {
        custom_field: {
          cf_account_number: 456,
          cf_product_name: "Another customer's product",
          cf_renewal_status: "Active",
          cf_end_date: "2028-01-01",
        },
      },
    ]);
  }) as typeof fetch;

  try {
    const result = await client().subscriptionsForRequester("customer@example.com");
    assertEquals(result, {
      status: "found",
      matchedBy: "contact_email",
      accountId: 123,
      subscriptions: [{
        productName: "Simployer One Complete",
        renewalStatus: "Active",
        endDate: "2027-04-30",
      }],
    });
    assertEquals(urls.length, 3); // lookup -> contact detail -> subscriptions
    const lookup = new URL(urls[0]);
    assertEquals(lookup.pathname, "/crm/sales/api/lookup");
    assertEquals(lookup.searchParams.get("f"), "email");
    assertEquals(lookup.searchParams.get("entities"), "contact");
    // The account link only exists on the detail endpoint.
    assertEquals(new URL(urls[1]).pathname, "/crm/sales/api/contacts/7");
    assertEquals(new URL(urls[1]).searchParams.get("include"), "sales_accounts");
    assertEquals(
      new URL(urls[2]).pathname,
      "/crm/sales/api/custom_module/cm_subscription/view/31008500658",
    );
    assertEquals(authorizations.every((a) => a === "Token token=separate-crm-key"), true);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM reads approved fields from custom-field response shapes", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/lookup?")) return contactLookup([{ id: 9, email: "customer@example.com" }]);
    if (url.includes("/contacts/9")) return contactDetail([{ id: 321, is_primary: true }]);
    return json({
      data: {
        cm_subscription: [{
          custom_fields: [
            { name: "cf_account_number", value: { id: 321 } },
            { name: "cf_product_name", value: "Compensation" },
            { name: "cf_renewal_status", value: { value: "Pending" } },
            { name: "cf_end_date", value: "2026-10-01" },
          ],
        }],
      },
    });
  }) as typeof fetch;

  try {
    assertEquals(await client().subscriptionsForRequester("customer@example.com"), {
      status: "found",
      matchedBy: "contact_email",
      accountId: 321,
      subscriptions: [{
        productName: "Compensation",
        renewalStatus: "Pending",
        endDate: "2026-10-01",
      }],
    });
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM prefers the contact's PRIMARY account when it has several", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/lookup?")) return contactLookup([{ id: 5, email: "multi@example.com" }]);
    if (url.includes("/contacts/5")) {
      return contactDetail([
        { id: 111, is_primary: false },
        { id: 222, is_primary: true },
        { id: 333, is_primary: false },
      ]);
    }
    return subscriptions([{
      custom_field: {
        cf_account_number: 222,
        cf_product_name: "Simployer HR",
        cf_renewal_status: "Active",
        cf_end_date: "2027-02-28",
      },
    }]);
  }) as typeof fetch;

  try {
    const result = await client().subscriptionsForRequester("multi@example.com");
    assertEquals(result.status, "found");
    assertEquals(result.accountId, 222); // the primary, as the CRM UI shows it
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM: several NON-primary accounts on one contact is ambiguous", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    calls++;
    const url = String(input);
    if (url.includes("/lookup?")) return contactLookup([{ id: 5, email: "shared@example.com" }]);
    return contactDetail([{ id: 10 }, { id: 20 }]);
  }) as typeof fetch;

  try {
    assertEquals(await client().subscriptionsForRequester("shared@example.com"), {
      status: "ambiguous",
      subscriptions: [],
    });
    assertEquals(calls, 2); // hard stop: no name/domain tier after ambiguity
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM falls back to the ticket's company when the email has no CRM contact", async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/lookup?")) return contactLookup([]); // unknown in the CRM
    if (url.includes("/search?")) {
      return searchRows([
        // exact-match must fold case/whitespace; the lookalike must be ignored,
        // not treated as ambiguity
        { id: 555, name: "  ACME ab " },
        { id: 777, name: "Acme AB Holding" },
      ]);
    }
    return subscriptions([{
      custom_field: {
        cf_account_number: 555,
        cf_product_name: "Simployer HR",
        cf_renewal_status: "Active",
        cf_end_date: "2027-01-31",
      },
    }]);
  }) as typeof fetch;

  try {
    const result = await client().subscriptionsForCustomer({
      requesterEmail: "unknown@example.com",
      companyName: "Acme AB",
    });
    assertEquals(result, {
      status: "found",
      matchedBy: "company_name",
      accountId: 555,
      subscriptions: [{
        productName: "Simployer HR",
        renewalStatus: "Active",
        endDate: "2027-01-31",
      }],
    });
    const search = new URL(urls[1]);
    // /search (partial matching), NOT /lookup?f=name (full names only)
    assertEquals(search.pathname, "/crm/sales/api/search");
    assertEquals(search.searchParams.get("q"), "acme"); // the normalised stem
    assertEquals(search.searchParams.get("include"), "sales_account");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM reports SEVERAL similar accounts as ambiguous — agent checks manually", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    searchRows([{ id: 1, name: "Acme AB" }, { id: 2, name: "acme ab" }])) as typeof fetch;

  try {
    assertEquals(await client().subscriptionsForCustomer({ companyName: "Acme AB" }), {
      status: "ambiguous",
      subscriptions: [],
      candidates: ["Acme AB", "acme ab"],
    });
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM ambiguity hard-stops the ladder — the email-domain tier is never tried", async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/lookup?")) return contactLookup([]);
    return searchRows([
      { id: 1, name: "Acme Sverige AB" },
      { id: 2, name: "Acme Norge AS" },
    ]);
  }) as typeof fetch;

  try {
    assertEquals(await client().subscriptionsForCustomer({
      requesterEmail: "anna@acme.se",
      companyName: "Acme",
    }), {
      status: "ambiguous",
      subscriptions: [],
      candidates: ["Acme Sverige AB", "Acme Norge AS"],
    });
    assertEquals(urls.length, 2); // contact lookup + ONE account search
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM word-prefix match ('Acme' -> 'Acme Sverige AB') is labelled for verification", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/search?")) {
      return searchRows([
        { id: 42, name: "Acme Sverige AB" },
        { id: 43, name: "Acmecorp AB" }, // no word boundary -> never a candidate
      ]);
    }
    return subscriptions([{
      custom_field: {
        cf_account_number: 42,
        cf_product_name: "Simployer HR",
        cf_renewal_status: "Active",
        cf_end_date: "2027-01-31",
      },
    }]);
  }) as typeof fetch;

  try {
    const result = await client().subscriptionsForCustomer({ companyName: "Acme" });
    assertEquals(result.status, "found");
    assertEquals(result.matchedBy, "company_name_prefix");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM: differing legal forms (Acme AS vs Acme AB) only match WEAKLY", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/search?")) return searchRows([{ id: 77, name: "Acme AB" }]);
    return subscriptions([{
      custom_field: {
        cf_account_number: 77,
        cf_product_name: "Simployer HR",
        cf_renewal_status: "Active",
        cf_end_date: "2027-03-31",
      },
    }]);
  }) as typeof fetch;

  try {
    // The Norwegian entity is not in the CRM; only the Swedish sister exists.
    // That must never be presented as a strong company match.
    const result = await client().subscriptionsForCustomer({ companyName: "Acme AS" });
    assertEquals(result.status, "found");
    assertEquals(result.matchedBy, "company_name_prefix");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM email-domain tier: a unique website match resolves what names alone cannot", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/lookup?")) return contactLookup([]);
    if (url.includes("/search?")) {
      // Both are name-adjacent to "acme", so by NAME alone this is ambiguous;
      // the website equality is what uniquely confirms the right account.
      return searchRows([
        { id: 9, name: "Acme Group AS", website: "https://www.acme.se" },
        { id: 8, name: "Acme Consulting AS" },
      ]);
    }
    return subscriptions([{
      custom_field: {
        cf_account_number: 9,
        cf_product_name: "Simployer One",
        cf_renewal_status: "Active",
        cf_end_date: "2026-11-30",
      },
    }]);
  }) as typeof fetch;

  try {
    const result = await client().subscriptionsForCustomer({ requesterEmail: "anna@acme.se" });
    assertEquals(result.status, "found");
    assertEquals(result.matchedBy, "email_domain");
    assertEquals(result.subscriptions, [{
      productName: "Simployer One",
      renewalStatus: "Active",
      endDate: "2026-11-30",
    }]);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM domain stem skips public second-level suffixes (oslo.kommune.no -> oslo)", async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/lookup?")) return contactLookup([]);
    if (url.includes("/search?")) return searchRows([{ id: 12, name: "Oslo Kommune" }]);
    return subscriptions([{
      custom_field: {
        cf_account_number: 12,
        cf_product_name: "Simployer HR",
        cf_renewal_status: "Active",
        cf_end_date: "2027-08-31",
      },
    }]);
  }) as typeof fetch;

  try {
    const result = await client().subscriptionsForCustomer({
      requesterEmail: "anna@oslo.kommune.no",
    });
    assertEquals(result.status, "found");
    assertEquals(result.matchedBy, "email_domain");
    // the brand key is "oslo", never the generic public label "kommune"
    assertEquals(new URL(urls[1]).searchParams.get("q"), "oslo");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM treats a full-looking search page as possibly truncated -> ambiguous", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (String(input).includes("/search?")) {
      const rows = [{ id: 100, name: "Nordic AB" }];
      for (let i = 1; i < 10; i++) rows.push({ id: 100 + i, name: `Nordic Partner ${i} AS` });
      return searchRows(rows);
    }
    throw new Error("subscriptions must not be fetched from a truncated match");
  }) as typeof fetch;

  try {
    // "Nordic AB" IS a unique stem-equal hit — but 10 rows is the observed cap,
    // so the true duplicate may be off-page and the ladder must not trust it.
    const result = await client().subscriptionsForCustomer({ companyName: "Nordic" });
    assertEquals(result.status, "ambiguous");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM: a similar record with an unparseable id still means ambiguous", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    json([
      { id: "7", name: "Acme AB", type: "sales_account" },
      { id: null, name: "Acme AB", type: "sales_account" },
    ])) as typeof fetch;

  try {
    const result = await client().subscriptionsForCustomer({ companyName: "Acme" });
    assertEquals(result.status, "ambiguous");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM folds Nordic diacritics: malarenergi.se matches Mälarenergi AB", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/lookup?")) return contactLookup([]);
    if (url.includes("/search?")) return searchRows([{ id: 5, name: "Mälarenergi AB" }]);
    return subscriptions([{
      custom_field: {
        cf_account_number: 5,
        cf_product_name: "Simployer HR",
        cf_renewal_status: "Active",
        cf_end_date: "2027-06-30",
      },
    }]);
  }) as typeof fetch;

  try {
    const result = await client().subscriptionsForCustomer({
      requesterEmail: "info@malarenergi.se",
    });
    assertEquals(result.status, "found");
    assertEquals(result.matchedBy, "email_domain");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM never resolves a company from a freemail domain", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return contactLookup([]);
  }) as typeof fetch;

  try {
    assertEquals(
      await client().subscriptionsForCustomer({ requesterEmail: "maria@gmail.com" }),
      { status: "no_match", subscriptions: [] },
    );
    assertEquals(calls, 1); // only the contact lookup; the domain tier refuses freemail
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM prefers the contact-email match over the company name", async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/lookup?")) return contactLookup([{ id: 3, email: "customer@example.com" }]);
    if (url.includes("/contacts/3")) return contactDetail([{ id: 123, is_primary: true }]);
    return subscriptions([{
      custom_field: {
        cf_account_number: 123,
        cf_product_name: "Simployer One",
        cf_renewal_status: "Active",
        cf_end_date: "2026-12-31",
      },
    }]);
  }) as typeof fetch;

  try {
    let companyFetched = false;
    const result = await client().subscriptionsForCustomer({
      requesterEmail: "customer@example.com",
      // Lazy loader: must never run once the contact tier matched.
      companyName: () => {
        companyFetched = true;
        return Promise.resolve("Acme AB");
      },
    });
    assertEquals(result.status, "found");
    assertEquals(result.matchedBy, "contact_email");
    assertEquals(companyFetched, false);
    assertEquals(urls.some((u) => u.includes("/search?")), false);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM regression: the real STUDENTSAMSKIPNADEN case (verified live)", async () => {
  const original = globalThis.fetch;
  // Live shapes: the contact resolves via the detail endpoint to the account
  // that also carries website minsis.no — while a name search alone returns two
  // identically-named accounts (a genuine CRM duplicate) and must NOT be trusted.
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/lookup?")) return contactLookup([{ id: 31012, email: "ozlem@minsis.no" }]);
    if (url.includes("/contacts/31012")) {
      return contactDetail([{ id: 31012680310, is_primary: true }]);
    }
    return subscriptions([{
      custom_field: {
        cf_account_number: 31012680310,
        cf_product_name: "Simployer HR",
        cf_renewal_status: "Active",
        cf_end_date: "2027-05-31",
      },
    }]);
  }) as typeof fetch;

  try {
    const result = await client().subscriptionsForRequester("ozlem@minsis.no");
    assertEquals(result.status, "found");
    assertEquals(result.matchedBy, "contact_email");
    assertEquals(result.accountId, 31012680310);
  } finally {
    globalThis.fetch = original;
  }
});

import { assertEquals } from "./test_assert.ts";
import { FreshworksCRM } from "./freshworks-crm.ts";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
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

Deno.test("FreshworksCRM matches the requester exactly and returns only approved fields", async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  const authorizations: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const headers = new Headers(init?.headers);
    authorizations.push(headers.get("authorization") ?? "");
    if (url.includes("/lookup?")) {
      return Promise.resolve(json({
        contacts: {
          contacts: [{
            id: 7,
            email: "customer@example.com",
            company: { id: 123, name: "Must not be returned" },
          }],
        },
      }));
    }
    return Promise.resolve(json({
      cm_subscription: [
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
      ],
    }));
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
    assertEquals(urls.length, 2);
    const lookup = new URL(urls[0]);
    assertEquals(lookup.pathname, "/crm/sales/api/lookup");
    assertEquals(lookup.searchParams.get("q"), "customer@example.com");
    assertEquals(lookup.searchParams.get("f"), "email");
    assertEquals(lookup.searchParams.get("entities"), "contact");
    const subscriptionUrl = new URL(urls[1]);
    assertEquals(
      subscriptionUrl.pathname,
      "/crm/sales/api/custom_module/cm_subscription/view/31008500658",
    );
    assertEquals(JSON.parse(subscriptionUrl.searchParams.get("q[]") ?? "{}"), {
      name: "cf_account_number",
      operator: 4,
      value: "123",
      domType: 6,
    });
    assertEquals(authorizations, [
      "Token token=separate-crm-key",
      "Token token=separate-crm-key",
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM reads approved fields from custom-field response shapes", async () => {
  const original = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (() => {
    call++;
    if (call === 1) {
      return Promise.resolve(json({
        contacts: {
          contacts: [{
            email: "customer@example.com",
            sales_accounts: [{ id: 321 }],
          }],
        },
      }));
    }
    return Promise.resolve(json({
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
    }));
  }) as typeof fetch;

  try {
    assertEquals(
      await client().subscriptionsForRequester("customer@example.com"),
      {
        status: "found",
        matchedBy: "contact_email",
        accountId: 321,
        subscriptions: [{
          productName: "Compensation",
          renewalStatus: "Pending",
          endDate: "2026-10-01",
        }],
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM: one email on several CRM accounts is ambiguous — manual check", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(json({
      contacts: {
        contacts: [
          { email: "shared@example.com", company: { id: 10 } },
          { email: "shared@example.com", company: { id: 20 } },
        ],
      },
    }));
  }) as typeof fetch;

  try {
    assertEquals(await client().subscriptionsForRequester("shared@example.com"), {
      status: "ambiguous",
      subscriptions: [],
    });
    // Hard stop: the domain tier is never tried on known-ambiguous data.
    assertEquals(calls, 1);
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
    if (url.includes("entities=contact")) {
      // The requester email is unknown in the CRM.
      return Promise.resolve(json({ contacts: { contacts: [] } }));
    }
    if (url.includes("entities=sales_account")) {
      return Promise.resolve(json({
        sales_accounts: {
          sales_accounts: [
            // Exact match must be case/whitespace-insensitive; the lookalike
            // ("Acme AB Holding") must be ignored, not treated as ambiguity.
            { id: 555, name: "  ACME ab " },
            { id: 777, name: "Acme AB Holding" },
          ],
        },
      }));
    }
    return Promise.resolve(json({
      cm_subscription: [{
        custom_field: {
          cf_account_number: 555,
          cf_product_name: "Simployer HR",
          cf_renewal_status: "Active",
          cf_end_date: "2027-01-31",
        },
      }],
    }));
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
    assertEquals(urls.length, 3);
    const lookup = new URL(urls[1]);
    // The query term is the normalised brand stem, not the raw company string.
    assertEquals(lookup.searchParams.get("q"), "acme");
    assertEquals(lookup.searchParams.get("f"), "name");
    assertEquals(lookup.searchParams.get("entities"), "sales_account");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM reports SEVERAL similar accounts as ambiguous — agent checks manually", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(json({
      sales_accounts: {
        sales_accounts: [
          { id: 1, name: "Acme AB" },
          { id: 2, name: "acme ab" },
        ],
      },
    }));
  }) as typeof fetch;

  try {
    assertEquals(await client().subscriptionsForCustomer({ companyName: "Acme AB" }), {
      status: "ambiguous",
      subscriptions: [],
      candidates: ["Acme AB", "acme ab"],
    });
    assertEquals(calls, 1);
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
    if (url.includes("entities=contact")) {
      return Promise.resolve(json({ contacts: { contacts: [] } }));
    }
    return Promise.resolve(json({
      sales_accounts: {
        sales_accounts: [
          { id: 1, name: "Acme Sverige AB" },
          { id: 2, name: "Acme Norge AS" },
        ],
      },
    }));
  }) as typeof fetch;

  try {
    const result = await client().subscriptionsForCustomer({
      requesterEmail: "anna@acme.se",
      companyName: "Acme",
    });
    assertEquals(result, {
      status: "ambiguous",
      subscriptions: [],
      candidates: ["Acme Sverige AB", "Acme Norge AS"],
    });
    // contact lookup + ONE account lookup — no further tier after ambiguity.
    assertEquals(urls.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM word-prefix match ('Acme' -> 'Acme Sverige AB') is labelled for verification", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("entities=sales_account")) {
      return Promise.resolve(json({
        sales_accounts: {
          sales_accounts: [
            { id: 42, name: "Acme Sverige AB" },
            { id: 43, name: "Acmecorp AB" }, // no word boundary -> never a candidate
          ],
        },
      }));
    }
    return Promise.resolve(json({
      cm_subscription: [{
        custom_field: {
          cf_account_number: 42,
          cf_product_name: "Simployer HR",
          cf_renewal_status: "Active",
          cf_end_date: "2027-01-31",
        },
      }],
    }));
  }) as typeof fetch;

  try {
    const result = await client().subscriptionsForCustomer({ companyName: "Acme" });
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
    if (url.includes("entities=contact")) {
      return Promise.resolve(json({ contacts: { contacts: [] } }));
    }
    if (url.includes("entities=sales_account")) {
      // Candidates necessarily come from a NAME search (f=name), so both are
      // name-adjacent to "acme" — by name alone this would be AMBIGUOUS; the
      // website equality is what uniquely confirms the right account.
      return Promise.resolve(json({
        sales_accounts: {
          sales_accounts: [
            { id: 9, name: "Acme Group AS", website: "https://www.acme.se" },
            { id: 8, name: "Acme Consulting AS" },
          ],
        },
      }));
    }
    return Promise.resolve(json({
      cm_subscription: [{
        custom_field: {
          cf_account_number: 9,
          cf_product_name: "Simployer One",
          cf_renewal_status: "Active",
          cf_end_date: "2026-11-30",
        },
      }],
    }));
  }) as typeof fetch;

  try {
    const result = await client().subscriptionsForCustomer({
      requesterEmail: "anna@acme.se",
    });
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

Deno.test("FreshworksCRM: differing legal forms (Acme AS vs Acme AB) only match WEAKLY", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("entities=sales_account")) {
      return Promise.resolve(json({
        sales_accounts: { sales_accounts: [{ id: 77, name: "Acme AB" }] },
      }));
    }
    return Promise.resolve(json({
      cm_subscription: [{
        custom_field: {
          cf_account_number: 77,
          cf_product_name: "Simployer HR",
          cf_renewal_status: "Active",
          cf_end_date: "2027-03-31",
        },
      }],
    }));
  }) as typeof fetch;

  try {
    // The Norwegian entity is not in the CRM; only the Swedish sister exists.
    // This must NOT be presented as a strong company match.
    const result = await client().subscriptionsForCustomer({ companyName: "Acme AS" });
    assertEquals(result.status, "found");
    assertEquals(result.matchedBy, "company_name_prefix");
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
    if (url.includes("entities=contact")) {
      return Promise.resolve(json({ contacts: { contacts: [] } }));
    }
    if (url.includes("entities=sales_account")) {
      return Promise.resolve(json({
        sales_accounts: { sales_accounts: [{ id: 12, name: "Oslo Kommune" }] },
      }));
    }
    return Promise.resolve(json({
      cm_subscription: [{
        custom_field: {
          cf_account_number: 12,
          cf_product_name: "Simployer HR",
          cf_renewal_status: "Active",
          cf_end_date: "2027-08-31",
        },
      }],
    }));
  }) as typeof fetch;

  try {
    const result = await client().subscriptionsForCustomer({
      requesterEmail: "anna@oslo.kommune.no",
    });
    assertEquals(result.status, "found");
    assertEquals(result.matchedBy, "email_domain");
    const lookup = new URL(urls[1]);
    // The brand key is "oslo", never the generic public label "kommune".
    assertEquals(lookup.searchParams.get("q"), "oslo");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM treats a full-looking lookup page as possibly truncated -> ambiguous", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("entities=sales_account")) {
      const rows = [{ id: 100, name: "Nordic AB" }];
      for (let i = 1; i < 10; i++) {
        rows.push({ id: 100 + i, name: `Nordic Partner ${i} AS` });
      }
      return Promise.resolve(json({ sales_accounts: { sales_accounts: rows } }));
    }
    throw new Error("subscriptions must not be fetched from a truncated match");
  }) as typeof fetch;

  try {
    // "Nordic AB" IS a unique stem-equal hit — but 10 returned rows means the
    // true duplicate may be off-page, so the ladder must not trust it.
    const result = await client().subscriptionsForCustomer({ companyName: "Nordic" });
    assertEquals(result.status, "ambiguous");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FreshworksCRM: a similar record with an unparseable id still means ambiguous", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(json({
      sales_accounts: {
        sales_accounts: [
          { id: 7, name: "Acme AB" },
          { id: null, name: "Acme AB" },
        ],
      },
    }))) as typeof fetch;

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
    if (url.includes("entities=contact")) {
      return Promise.resolve(json({ contacts: { contacts: [] } }));
    }
    if (url.includes("entities=sales_account")) {
      return Promise.resolve(json({
        sales_accounts: { sales_accounts: [{ id: 5, name: "Mälarenergi AB" }] },
      }));
    }
    return Promise.resolve(json({
      cm_subscription: [{
        custom_field: {
          cf_account_number: 5,
          cf_product_name: "Simployer HR",
          cf_renewal_status: "Active",
          cf_end_date: "2027-06-30",
        },
      }],
    }));
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
    return Promise.resolve(json({ contacts: { contacts: [] } }));
  }) as typeof fetch;

  try {
    assertEquals(
      await client().subscriptionsForCustomer({ requesterEmail: "maria@gmail.com" }),
      { status: "no_match", subscriptions: [] },
    );
    // Only the contact lookup — the domain tier must refuse freemail.
    assertEquals(calls, 1);
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
    if (url.includes("entities=contact")) {
      return Promise.resolve(json({
        contacts: { contacts: [{ email: "customer@example.com", company: { id: 123 } }] },
      }));
    }
    return Promise.resolve(json({
      cm_subscription: [{
        custom_field: {
          cf_account_number: 123,
          cf_product_name: "Simployer One",
          cf_renewal_status: "Active",
          cf_end_date: "2026-12-31",
        },
      }],
    }));
  }) as typeof fetch;

  try {
    let companyFetched = false;
    const result = await client().subscriptionsForCustomer({
      requesterEmail: "customer@example.com",
      // Lazy loader: must never run when the contact-email tier already matched.
      companyName: () => {
        companyFetched = true;
        return Promise.resolve("Acme AB");
      },
    });
    assertEquals(result.status, "found");
    assertEquals(result.matchedBy, "contact_email");
    assertEquals(companyFetched, false);
    // The company lookup must never have been called.
    assertEquals(urls.some((u) => u.includes("entities=sales_account")), false);
  } finally {
    globalThis.fetch = original;
  }
});

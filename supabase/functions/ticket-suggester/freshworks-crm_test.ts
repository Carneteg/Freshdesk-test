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

Deno.test("FreshworksCRM does not guess when requester-to-account match is ambiguous", async () => {
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
      status: "no_match",
      subscriptions: [],
    });
    assertEquals(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

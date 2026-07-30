// Read-only Freshworks CRM client for verified customer subscription context.
//
// This uses a separate API key from Freshdesk. It performs only GET requests,
// keeps response bodies out of errors/logs, and returns only the three fields
// approved for the private note: product name, renewal status, and end date.

import type { CustomerSubscription, CustomerSubscriptionContext } from "./render.ts";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface FreshworksCrmConfig {
  baseUrl: string;
  apiKey: string;
  // Relative API path with one {account_id} placeholder. The exact endpoint is
  // tenant-specific because Subscriptions is a configured related module.
  subscriptionsPathTemplate: string;
  // Exact response collection key for the Subscriptions module.
  subscriptionsCollection: string;
  accountField: string;
  productField: string;
  renewalStatusField: string;
  endDateField: string;
}

interface CrmAccountRef {
  id?: number | string | null;
}

interface CrmContact {
  email?: string | null;
  company?: CrmAccountRef | null;
  sales_accounts?: CrmAccountRef[] | null;
  sales_account_id?: number | string | null;
}

interface CrmSalesAccount {
  id?: number | string | null;
  name?: string | null;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("Freshworks CRM base URL must use HTTPS");
  }
  if (
    url.hostname !== "freshworks.com" &&
    !url.hostname.endsWith(".freshworks.com") &&
    !url.hostname.endsWith(".myfreshworks.com")
  ) {
    throw new Error("Freshworks CRM base URL must use a Freshworks hostname");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function validateRelativeTemplate(value: string): string {
  const template = value.trim();
  if (
    !template.startsWith("/") ||
    template.includes("://") ||
    !template.includes("{account_id}")
  ) {
    throw new Error(
      "Freshworks CRM subscriptions path must be relative and contain {account_id}",
    );
  }
  return template;
}

function safeFieldName(value: string, label: string): string {
  const name = value.trim();
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
    throw new Error(`invalid Freshworks CRM ${label}`);
  }
  return name;
}

function accountId(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(String(value ?? ""));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

// The lookup endpoint nests its rows per entity: { contacts: [...] } or
// { contacts: { contacts: [...] } } — same shape for sales_accounts.
function lookupRows(payload: unknown, entityKey: string): JsonObject[] {
  if (!isObject(payload)) return [];
  const outer = payload[entityKey];
  const rows = Array.isArray(outer)
    ? outer
    : isObject(outer) && Array.isArray(outer[entityKey])
    ? outer[entityKey]
    : [];
  return rows.filter(isObject);
}

function exactContacts(payload: unknown, email: string): CrmContact[] {
  const target = email.trim().toLowerCase();
  return (lookupRows(payload, "contacts") as CrmContact[]).filter((row) =>
    String(row.email ?? "").trim().toLowerCase() === target
  );
}

// Exact, case-insensitive company-name equality. Substring/fuzzy hits from the
// lookup endpoint are dropped: subscriptions must never surface for a lookalike.
function exactAccounts(payload: unknown, name: string): CrmSalesAccount[] {
  const target = name.trim().toLowerCase();
  return (lookupRows(payload, "sales_accounts") as CrmSalesAccount[]).filter(
    (row) => String(row.name ?? "").trim().toLowerCase() === target,
  );
}

function contactAccountIds(contact: CrmContact): number[] {
  const ids = [
    accountId(contact.company?.id),
    accountId(contact.sales_account_id),
    ...(contact.sales_accounts ?? []).map((row) => accountId(row.id)),
  ].filter((id): id is number => id !== null);
  return Array.from(new Set(ids));
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    return isObject(current) ? current[part] : undefined;
  }, value);
}

function recordRows(payload: unknown, collection: string): JsonObject[] {
  const candidates = [
    readPath(payload, collection),
    readPath(payload, `data.${collection}`),
    readPath(payload, `records.${collection}`),
    isObject(payload) ? payload.records : undefined,
  ];
  const rows = candidates.find(Array.isArray);
  return (rows ?? []).filter(isObject);
}

function unwrapField(value: unknown): unknown {
  if (!isObject(value)) return value;
  if ("value" in value) return unwrapField(value.value);
  if (typeof value.name === "string") return value.name;
  if (typeof value.display_name === "string") return value.display_name;
  if (typeof value.id === "string" || typeof value.id === "number") return value.id;
  return null;
}

function fieldValue(record: JsonObject, field: string): string | null {
  const direct = unwrapField(readPath(record, field));
  const custom = isObject(record.custom_field)
    ? unwrapField(readPath(record.custom_field, field))
    : undefined;
  const customRows = Array.isArray(record.custom_fields) ? record.custom_fields : [];
  const customEntry = customRows.find((row) =>
    isObject(row) && (row.name === field || row.column === field)
  );
  const raw = direct ?? custom ??
    (isObject(customEntry) ? unwrapField(customEntry.value) : null);
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return String(raw);
  }
  return null;
}

function endDateValue(record: JsonObject, field: string): string | null {
  const value = fieldValue(record, field);
  return value && /^\d{4}-\d{2}-\d{2}T/.test(value) ? value.slice(0, 10) : value;
}

export class FreshworksCRM {
  private readonly config: FreshworksCrmConfig;

  constructor(config: FreshworksCrmConfig) {
    this.config = {
      ...config,
      baseUrl: normalizeBaseUrl(config.baseUrl),
      subscriptionsPathTemplate: validateRelativeTemplate(
        config.subscriptionsPathTemplate,
      ),
      subscriptionsCollection: safeFieldName(
        config.subscriptionsCollection,
        "subscriptions collection",
      ),
      accountField: safeFieldName(config.accountField, "account field"),
      productField: safeFieldName(config.productField, "product field"),
      renewalStatusField: safeFieldName(
        config.renewalStatusField,
        "renewal-status field",
      ),
      endDateField: safeFieldName(config.endDateField, "end-date field"),
    };
  }

  private async get(path: string): Promise<unknown> {
    const url = `${this.config.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          authorization: `Token token=${this.config.apiKey}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      // Do not include response bodies or paths: they can echo record data or
      // contain a customer account id.
      throw new Error(`Freshworks CRM read failed: HTTP ${response.status}`);
    }
    return await response.json();
  }

  private async accountForRequester(email: string): Promise<number | null> {
    const query = new URLSearchParams({
      q: email.trim(),
      f: "email",
      entities: "contact",
    });
    const payload = await this.get(`/lookup?${query}`);
    const ids = Array.from(
      new Set(exactContacts(payload, email).flatMap(contactAccountIds)),
    );
    // Never guess when one email maps to multiple CRM accounts.
    return ids.length === 1 ? ids[0] : null;
  }

  // Subscriptions live on the CRM *account* (company), and many requester emails
  // have no CRM contact at all — so the ticket's Freshdesk company name is a
  // legitimate second key. Exact-name equality only, and never when the same name
  // matches more than one account.
  private async accountForCompanyName(name: string): Promise<number | null> {
    const query = new URLSearchParams({
      q: name.trim(),
      f: "name",
      entities: "sales_account",
    });
    const payload = await this.get(`/lookup?${query}`);
    const ids = Array.from(
      new Set(
        exactAccounts(payload, name)
          .map((row) => accountId(row.id))
          .filter((id): id is number => id !== null),
      ),
    );
    return ids.length === 1 ? ids[0] : null;
  }

  private async subscriptionsForAccount(
    matchedAccountId: number,
  ): Promise<CustomerSubscription[]> {
    const path = this.config.subscriptionsPathTemplate.replace(
      "{account_id}",
      encodeURIComponent(String(matchedAccountId)),
    );
    const payload = await this.get(path);
    return recordRows(payload, this.config.subscriptionsCollection)
      // Never trust only the server-side URL filter. A returned record must also
      // carry the exact matched account id before any product data is surfaced.
      .filter((record) =>
        accountId(fieldValue(record, this.config.accountField)) === matchedAccountId
      )
      .map((record) => ({
        productName: fieldValue(record, this.config.productField),
        renewalStatus: fieldValue(record, this.config.renewalStatusField),
        endDate: endDateValue(record, this.config.endDateField),
      }));
  }

  // Requester email first (most specific), then the ticket's company name as a
  // fallback. Both paths abstain (`no_match`) rather than guess on ambiguity.
  async subscriptionsForCustomer(customer: {
    requesterEmail?: string | null;
    companyName?: string | null;
  }): Promise<CustomerSubscriptionContext> {
    const email = customer.requesterEmail?.trim() ?? "";
    if (email) {
      const byEmail = await this.accountForRequester(email);
      if (byEmail) {
        return {
          status: "found",
          matchedBy: "contact_email",
          subscriptions: await this.subscriptionsForAccount(byEmail),
        };
      }
    }
    const company = customer.companyName?.trim() ?? "";
    if (company) {
      const byCompany = await this.accountForCompanyName(company);
      if (byCompany) {
        return {
          status: "found",
          matchedBy: "company_name",
          subscriptions: await this.subscriptionsForAccount(byCompany),
        };
      }
    }
    return { status: "no_match", subscriptions: [] };
  }

  async subscriptionsForRequester(
    requesterEmail: string | null | undefined,
  ): Promise<CustomerSubscriptionContext> {
    return await this.subscriptionsForCustomer({ requesterEmail });
  }
}

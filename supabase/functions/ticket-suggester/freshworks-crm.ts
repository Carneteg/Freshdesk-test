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
  website?: string | null;
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

// ── Name-stem matching ────────────────────────────────────────────────────────
// In practice the keys we hold (Freshdesk company name, requester email domain)
// rarely equal the CRM account name verbatim — "acme.se" / "Acme" vs
// "Acme Sverige AB". Matching therefore runs on the INITIAL (brand) name: fold
// case + Nordic diacritics, drop punctuation, strip trailing legal-form
// suffixes. Every tier still requires exactly ONE candidate — normalisation
// widens recall, uniqueness keeps us from ever guessing.

const LEGAL_SUFFIXES = new Set([
  "ab", "as", "asa", "aps", "a/s", "oy", "oyj", "ay", "hf", "ehf",
  "ltd", "llc", "inc", "gmbh", "ag", "kb", "hb", "sa", "plc", "co",
]);

export function nameStem(value: string): string {
  const folded = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // å/ä→a, ö→o, é→e …
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9/ ]+/g, " ") // keep "/" for "a/s"
    .replace(/\s+/g, " ")
    .trim();
  const words = folded.split(" ");
  // Only TRAILING legal suffixes are stripped ("Acme AB" -> "acme");
  // interior words are part of the brand ("Acme AB Holding" keeps its "ab").
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) {
    words.pop();
  }
  return words.join(" ");
}

// Word-boundary prefix in either direction: "acme" ~ "acme sverige", but never
// "acme" ~ "acmecorp".
function stemsRelated(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `);
}

// Freemail domains are shared across customers and must never resolve a company.
const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.se", "hotmail.no",
  "outlook.com", "live.com", "live.se", "live.no", "msn.com", "yahoo.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
  "gmx.com", "gmx.de", "mail.com", "online.no", "telia.com", "telia.se",
  "comhem.se", "bredband.net", "spray.se",
]);

function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  const domain = at > 0 ? email.slice(at + 1).trim().toLowerCase() : "";
  if (!domain.includes(".") || FREEMAIL.has(domain)) return null;
  return domain;
}

// "acme.se" / "acme.co.uk" -> "acme". The label before the TLD is the brand key.
function domainStem(domain: string): string | null {
  const parts = domain.split(".").filter(Boolean);
  if (parts.length < 2) return null;
  let label = parts[parts.length - 2];
  if ((label === "co" || label === "com") && parts.length >= 3) {
    label = parts[parts.length - 3];
  }
  const stem = nameStem(label);
  return stem.length >= 3 ? stem : null;
}

function websiteDomain(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

// One account id, or "ambiguous" the moment a tier has several candidates —
// known-ambiguous data must hard-stop the whole ladder, not degrade to a
// weaker tier that would "resolve" it.
type AccountMatch = { id: number } | "ambiguous" | null;

function uniqueId(rows: CrmSalesAccount[]): AccountMatch {
  const ids = Array.from(
    new Set(rows.map((row) => accountId(row.id)).filter((id): id is number => id !== null)),
  );
  if (ids.length === 1) return { id: ids[0] };
  return ids.length > 1 ? "ambiguous" : null;
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

  private async accountForRequester(email: string): Promise<AccountMatch> {
    const query = new URLSearchParams({
      q: email.trim(),
      f: "email",
      entities: "contact",
    });
    const payload = await this.get(`/lookup?${query}`);
    const ids = Array.from(
      new Set(exactContacts(payload, email).flatMap(contactAccountIds)),
    );
    // One email mapping to SEVERAL CRM accounts is exactly the "similar customer
    // records" case — surface it for a manual check, never guess.
    if (ids.length === 1) return { id: ids[0] };
    return ids.length > 1 ? "ambiguous" : null;
  }

  private async lookupAccounts(term: string): Promise<CrmSalesAccount[]> {
    const query = new URLSearchParams({
      q: term,
      f: "name",
      entities: "sales_account",
    });
    const payload = await this.get(`/lookup?${query}`);
    return lookupRows(payload, "sales_accounts") as CrmSalesAccount[];
  }

  // Subscriptions live on the CRM *account* (company), and many requester emails
  // have no CRM contact at all — so the ticket's Freshdesk company name is a
  // legitimate second key. Stem equality first, then word-boundary prefix; each
  // tier must resolve to exactly ONE account, and known ambiguity hard-stops.
  private async accountForCompanyName(
    name: string,
  ): Promise<{ id: number; matchedBy: "company_name" | "company_name_prefix" } | "ambiguous" | null> {
    const stem = nameStem(name);
    if (!stem) return null;
    const rows = await this.lookupAccounts(stem);
    const equal = uniqueId(rows.filter((row) => nameStem(String(row.name ?? "")) === stem));
    if (equal === "ambiguous") return "ambiguous";
    if (equal) return { id: equal.id, matchedBy: "company_name" };
    const related = uniqueId(
      rows.filter((row) => stemsRelated(nameStem(String(row.name ?? "")), stem)),
    );
    if (related === "ambiguous") return "ambiguous";
    return related ? { id: related.id, matchedBy: "company_name_prefix" } : null;
  }

  // Last key: the requester's email domain. The account's website domain is the
  // strongest signal ("acme.se" == "acme.se"); otherwise the domain's brand
  // label must stem-match the account name. Freemail domains never resolve.
  private async accountForEmailDomain(
    email: string,
  ): Promise<{ id: number } | "ambiguous" | null> {
    const domain = emailDomain(email);
    const stem = domain ? domainStem(domain) : null;
    if (!domain || !stem) return null;
    const rows = await this.lookupAccounts(stem);
    const byWebsite = uniqueId(rows.filter((row) => websiteDomain(row.website) === domain));
    if (byWebsite === "ambiguous") return "ambiguous";
    if (byWebsite) return byWebsite;
    const byName = uniqueId(
      rows.filter((row) => stemsRelated(nameStem(String(row.name ?? "")), stem)),
    );
    return byName === "ambiguous" ? "ambiguous" : byName;
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

  // The matching ladder, most→least specific; every tier requires exactly ONE
  // account. The moment a tier sees SEVERAL similar accounts the whole ladder
  // stops with `ambiguous` — rendered as "check manually", never guessed away:
  //   1. requester contact email (exact)
  //   2. ticket company name — stem equality, then word-boundary prefix
  //   3. requester email domain — website equality, then name-stem relation
  // `companyName` may be a lazy loader so the Freshdesk company GET only happens
  // when the email tier missed.
  async subscriptionsForCustomer(customer: {
    requesterEmail?: string | null;
    companyName?: string | null | (() => Promise<string | null>);
  }): Promise<CustomerSubscriptionContext> {
    const email = customer.requesterEmail?.trim() ?? "";
    if (email) {
      const byEmail = await this.accountForRequester(email);
      if (byEmail === "ambiguous") return { status: "ambiguous", subscriptions: [] };
      if (byEmail) {
        return {
          status: "found",
          matchedBy: "contact_email",
          subscriptions: await this.subscriptionsForAccount(byEmail.id),
        };
      }
    }
    const company = (
      typeof customer.companyName === "function"
        ? await customer.companyName().catch(() => null)
        : customer.companyName
    )?.trim() ?? "";
    if (company) {
      const byCompany = await this.accountForCompanyName(company);
      if (byCompany === "ambiguous") return { status: "ambiguous", subscriptions: [] };
      if (byCompany) {
        return {
          status: "found",
          matchedBy: byCompany.matchedBy,
          subscriptions: await this.subscriptionsForAccount(byCompany.id),
        };
      }
    }
    if (email) {
      const byDomain = await this.accountForEmailDomain(email);
      if (byDomain === "ambiguous") return { status: "ambiguous", subscriptions: [] };
      if (byDomain) {
        return {
          status: "found",
          matchedBy: "email_domain",
          subscriptions: await this.subscriptionsForAccount(byDomain.id),
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

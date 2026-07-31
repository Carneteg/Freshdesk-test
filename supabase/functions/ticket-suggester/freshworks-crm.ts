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
  id?: number | string | null;
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

// A name split into its brand stem and the stripped legal-form suffix. The
// suffix matters: "Acme AB" and "Acme AS" share a stem but are legally DISTINCT
// entities -- treating them as equal would put the wrong customer's data in a
// note, so suffix-incompatible pairs may only ever match as a WEAK (verify) tier.
export interface NameParts {
  stem: string;
  suffix: string | null;
}

export function nameParts(value: string): NameParts {
  const folded = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // fold diacritics: a-ring/a-uml -> a, o-uml -> o
    .replace(/\u00f8/g, "o")
    .replace(/\u00e6/g, "ae")
    .replace(/\u00df/g, "ss")
    .replace(/[^a-z0-9/ ]+/g, " ") // keep "/" for "a/s"
    .replace(/\s+/g, " ")
    .trim();
  const words = folded.split(" ");
  // Only TRAILING legal suffixes are stripped ("Acme AB" -> "acme");
  // interior words are part of the brand ("Acme AB Holding" keeps its "ab").
  const stripped: string[] = [];
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) {
    stripped.unshift(words.pop() as string);
  }
  return { stem: words.join(" "), suffix: stripped.length ? stripped.join(" ") : null };
}

export function nameStem(value: string): string {
  return nameParts(value).stem;
}

// Equal suffixes, or at least one side without one ("Acme" ~ "Acme AB"). Both
// sides carrying DIFFERENT legal forms ("Acme AB" vs "Acme AS") is incompatible.
function suffixCompatible(a: NameParts, b: NameParts): boolean {
  return a.suffix === null || b.suffix === null || a.suffix === b.suffix;
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

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  const domain = at > 0 ? email.slice(at + 1).trim().toLowerCase() : "";
  if (!domain.includes(".") || FREEMAIL.has(domain)) return null;
  return domain;
}

// "acme.se" / "acme.co.uk" / "oslo.kommune.no" -> "acme"/"oslo". The brand key
// is the label left of the PUBLIC suffix -- which can be two labels (co.uk,
// kommune.no). Without this, "oslo.kommune.no" would yield the generic word
// "kommune" and stem-match unrelated accounts.
const SECOND_LEVEL_SUFFIXES = new Set([
  "co", "com", "org", "net", "gov", "edu", "ac", "mil", "priv",
  "kommune", "herad", "fylke", "idrett", // Norwegian public second-levels
]);

function domainStem(domain: string): string | null {
  const parts = domain.split(".").filter(Boolean);
  if (parts.length < 2) return null;
  let idx = parts.length - 2;
  if (idx > 0 && SECOND_LEVEL_SUFFIXES.has(parts[idx])) idx--;
  const stem = nameStem(parts[idx]);
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

// One account id, or ambiguity the moment a tier has several candidates --
// known-ambiguous data must hard-stop the whole ladder, not degrade to a
// weaker tier that would "resolve" it. Ambiguity carries up to three candidate
// account names so the note can tell the agent WHAT to choose between.
type AccountMatch = { id: number } | { ambiguous: string[] } | null;

function candidateNames(rows: CrmSalesAccount[]): string[] {
  const names = rows
    .map((row) => String(row.name ?? "").trim())
    .filter(Boolean);
  return Array.from(new Set(names)).slice(0, 3);
}

function uniqueAccount(rows: CrmSalesAccount[]): AccountMatch {
  if (!rows.length) return null;
  const ids = new Set<number>();
  let unparseable = false;
  for (const row of rows) {
    const id = accountId(row.id);
    if (id === null) unparseable = true;
    else ids.add(id);
  }
  // A similar record we cannot even identify still counts as a similar record:
  // resolving "around" it would hide exactly the case the ladder must surface.
  if (ids.size === 1 && !unparseable) return { id: ids.values().next().value as number };
  return { ambiguous: candidateNames(rows) };
}

// /search is a bounded type-ahead: a "full-looking" response may hide the true
// duplicate off-page, so a unique NAME-based hit inside such a response is not
// trusted. VERIFIED live 2026-07-31: a broad stem returned exactly 10 rows, so
// 10 is the observed cap and this guard is calibrated, not guessed.
const LOOKUP_TRUNCATION_GUARD = 10;

// The /lookup contact row carries NO account link (verified live 2026-07-31);
// the association only comes back from /contacts/{id}?include=sales_accounts,
// as contact.sales_accounts[].id. When a contact belongs to several accounts,
// the primary one is what the CRM UI shows as "Account" — prefer it, and let
// the uniqueness check catch the (unexpected) multi-primary case.
function accountIdsFromContactDetail(payload: unknown): number[] {
  if (!isObject(payload) || !isObject(payload.contact)) return [];
  const rows = Array.isArray(payload.contact.sales_accounts)
    ? payload.contact.sales_accounts.filter(isObject)
    : [];
  const primary = rows.filter((row) => row.is_primary === true);
  return (primary.length ? primary : rows)
    .map((row) => accountId(row.id))
    .filter((id): id is number => id !== null);
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
    const contacts = exactContacts(payload, email);
    const found = new Set<number>();
    for (const contact of contacts) {
      // Kept for forward-compatibility if the lookup ever inlines the link.
      for (const id of contactAccountIds(contact)) found.add(id);
      const contactId = accountId(contact.id);
      if (contactId === null) continue;
      const detail = await this.get(`/contacts/${contactId}?include=sales_accounts`);
      for (const id of accountIdsFromContactDetail(detail)) found.add(id);
    }
    const ids = Array.from(found);
    // One email mapping to SEVERAL CRM accounts is exactly the "similar customer
    // records" case -- surface it for a manual check, never guess. (The contact
    // payload carries no account names, so no candidates to show here.)
    if (ids.length === 1) return { id: ids[0] };
    return ids.length > 1 ? { ambiguous: [] } : null;
  }

  // Candidate accounts for a (partial) name. VERIFIED live 2026-07-31:
  // /lookup?f=name only matches (near-)FULL names — a brand stem returned
  // nothing, which is why every name/domain tier missed. /search DOES match
  // partially and answers with a FLAT array of {id, name, website, type},
  // ids as strings (accountId() normalises them).
  private async lookupAccounts(term: string): Promise<CrmSalesAccount[]> {
    const query = new URLSearchParams({ q: term, include: "sales_account" });
    const payload = await this.get(`/search?${query}`);
    const rows = Array.isArray(payload)
      ? payload.filter(isObject)
      : lookupRows(payload, "sales_accounts");
    return rows.filter((row) =>
      row.type === undefined || row.type === "sales_account"
    ) as CrmSalesAccount[];
  }

  // Subscriptions live on the CRM *account* (company), and many requester emails
  // have no CRM contact at all -- so the ticket's Freshdesk company name is a
  // legitimate second key. Suffix-compatible stem equality is the STRONG tier;
  // a differing legal form ("Acme AS" vs "Acme AB") or a word-boundary prefix
  // is only ever a WEAK (verify-nudged) tier. Ambiguity hard-stops.
  private async accountForCompanyName(
    name: string,
  ): Promise<
    | { id: number; matchedBy: "company_name" | "company_name_prefix" }
    | { ambiguous: string[] }
    | null
  > {
    const key = nameParts(name);
    if (!key.stem) return null;
    const rows = await this.lookupAccounts(key.stem);
    const possiblyTruncated = rows.length >= LOOKUP_TRUNCATION_GUARD;
    const withParts = rows.map((row) => ({
      row,
      parts: nameParts(String(row.name ?? "")),
    }));

    const strongRows = withParts
      .filter(({ parts }) => parts.stem === key.stem && suffixCompatible(parts, key))
      .map(({ row }) => row);
    const strong = uniqueAccount(strongRows);
    if (strong && "ambiguous" in strong) return strong;
    if (strong) {
      return possiblyTruncated
        ? { ambiguous: candidateNames(rows) }
        : { id: strong.id, matchedBy: "company_name" };
    }

    // Same stem under a DIFFERENT legal form, or a word-boundary-related stem.
    const weakRows = withParts
      .filter(({ parts }) =>
        Boolean(parts.stem) &&
        (parts.stem === key.stem || stemsRelated(parts.stem, key.stem))
      )
      .map(({ row }) => row);
    const weak = uniqueAccount(weakRows);
    if (weak && "ambiguous" in weak) return weak;
    if (weak) {
      return possiblyTruncated
        ? { ambiguous: candidateNames(rows) }
        : { id: weak.id, matchedBy: "company_name_prefix" };
    }
    return null;
  }

  // Last key: the requester's email domain. The account's website domain is the
  // strongest signal ("acme.se" == "acme.se") and tight enough to trust even in
  // a full-looking response; a name-stem relation is weaker and is not. NOTE:
  // candidates come from a NAME search, so an account whose name shares nothing
  // with the domain cannot surface here -- the website key CONFIRMS name-adjacent
  // candidates. A dedicated website lookup needs a live-instance check first.
  private async accountForEmailDomain(email: string): Promise<AccountMatch> {
    const domain = emailDomain(email);
    const stem = domain ? domainStem(domain) : null;
    if (!domain || !stem) return null;
    // Compare websites in URL-canonical (punycode) form so IDN domains match.
    const ascii = toAsciiDomain(domain);
    const rows = await this.lookupAccounts(stem);
    const possiblyTruncated = rows.length >= LOOKUP_TRUNCATION_GUARD;

    const byWebsite = uniqueAccount(
      rows.filter((row) => websiteDomain(row.website) === ascii),
    );
    if (byWebsite) return byWebsite;

    const byName = uniqueAccount(
      rows.filter((row) => stemsRelated(nameStem(String(row.name ?? "")), stem)),
    );
    if (byName && "ambiguous" in byName) return byName;
    if (byName) return possiblyTruncated ? { ambiguous: candidateNames(rows) } : byName;
    return null;
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

  // The matching ladder, most->least specific; every tier requires exactly ONE
  // account. The moment a tier sees SEVERAL similar accounts the whole ladder
  // stops with `ambiguous` (plus up to three candidate names) -- rendered as
  // "check manually", never guessed away:
  //   1. requester contact email (exact)
  //   2. ticket company name -- suffix-compatible stem equality, then the weak
  //      set (differing legal form / word-boundary prefix)
  //   3. requester email domain -- website equality, then name-stem relation
  // `companyName` may be a lazy loader so the Freshdesk company GET only happens
  // when the email tier missed. The loader is deliberately NOT caught here: a
  // transport failure must surface as `unavailable` via the pipeline's outer
  // catch, not read as "no company" (a confident false negative).
  async subscriptionsForCustomer(customer: {
    requesterEmail?: string | null;
    companyName?: string | null | (() => Promise<string | null>);
  }): Promise<CustomerSubscriptionContext> {
    const email = customer.requesterEmail?.trim() ?? "";
    if (email) {
      const byEmail = await this.accountForRequester(email);
      if (byEmail && "ambiguous" in byEmail) return ambiguousContext(byEmail.ambiguous);
      if (byEmail) {
        return {
          status: "found",
          matchedBy: "contact_email",
          accountId: byEmail.id,
          subscriptions: await this.subscriptionsForAccount(byEmail.id),
        };
      }
    }
    const company = (
      typeof customer.companyName === "function"
        ? await customer.companyName()
        : customer.companyName
    )?.trim() ?? "";
    if (company) {
      const byCompany = await this.accountForCompanyName(company);
      if (byCompany && "ambiguous" in byCompany) return ambiguousContext(byCompany.ambiguous);
      if (byCompany) {
        return {
          status: "found",
          matchedBy: byCompany.matchedBy,
          accountId: byCompany.id,
          subscriptions: await this.subscriptionsForAccount(byCompany.id),
        };
      }
    }
    if (email) {
      const byDomain = await this.accountForEmailDomain(email);
      if (byDomain && "ambiguous" in byDomain) return ambiguousContext(byDomain.ambiguous);
      if (byDomain) {
        return {
          status: "found",
          matchedBy: "email_domain",
          accountId: byDomain.id,
          subscriptions: await this.subscriptionsForAccount(byDomain.id),
        };
      }
    }
    return { status: "no_match", subscriptions: [] };
  }

  // Deterministic path for a mapping-table hit: no lookup, no fuzziness --
  // fetch subscriptions for an already-verified account id.
  async subscriptionsForKnownAccount(
    accountId: number,
  ): Promise<CustomerSubscriptionContext> {
    return {
      status: "found",
      matchedBy: "account_map",
      accountId,
      subscriptions: await this.subscriptionsForAccount(accountId),
    };
  }

  async subscriptionsForRequester(
    requesterEmail: string | null | undefined,
  ): Promise<CustomerSubscriptionContext> {
    return await this.subscriptionsForCustomer({ requesterEmail });
  }
}

function ambiguousContext(candidates: string[]): CustomerSubscriptionContext {
  return {
    status: "ambiguous",
    subscriptions: [],
    ...(candidates.length ? { candidates } : {}),
  };
}

function toAsciiDomain(domain: string): string {
  try {
    return new URL(`https://${domain}`).hostname.toLowerCase();
  } catch {
    return domain;
  }
}

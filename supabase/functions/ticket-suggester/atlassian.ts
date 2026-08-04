// atlassian.ts — READ-ONLY Jira + Confluence client for the coaching observer.
//
// Written against shapes VERIFIED live on simployer.atlassian.net (2026-08-04),
// not from documentation. That distinction is not pedantry: the Freshworks CRM
// client was written from docs and both of its core assumptions were wrong,
// which cost a full cycle. Every claim below was checked against real records.
//
// ── WHAT WAS VERIFIED ────────────────────────────────────────────────────────
//
// A Jira issue references a Freshdesk ticket as a URL in its DESCRIPTION, as a
// smartlink, usually after the words "Freshdesk sak <id>":
//
//   Kunde Jungheinrich får ikke kjørt lønnseksport.
//   Freshdesk sak 84162
//   <custom data-type="smartlink" ...>https://simployer.freshdesk.com/a/tickets/84162</custom>
//
// Confirmed on TIMEPLAN-4147, TIMEPLAN-4145, TIMEPLAN-4143, TIMEPLAN-4126,
// EXE-788. There is NO issue-link, remote-link or custom field carrying the
// ticket — the URL in free text is the only association that exists. So the
// lookup is a full-text JQL search, and the URL must then be confirmed in the
// description.
//
// ── THE TRAP THIS CLIENT AVOIDS ──────────────────────────────────────────────
//
// `text ~ "84162"` is a full-text match on a BARE NUMBER. Jira will happily
// return an issue that mentions 84162 as an amount, a build number, or another
// system's id. Trusting that hit would mark a step "followed" on a coincidence.
// So the JQL is only a candidate filter: `issueLinksTicket` re-checks that the
// description actually contains the ticket URL before anything counts. The model
// proposes, code decides — the same stance as everywhere else in this codebase.

import { HttpError } from "./clients.ts";

export interface JiraIssue {
  key: string;
  summary: string;
  status: string | null;
  url: string;
}

/** Verified: the exact URL form Simployer uses to link a ticket from Jira. */
export function freshdeskTicketUrlPattern(domain: string, ticketId: number): RegExp {
  // Tolerates http/https and a trailing slash; anchors on the numeric id so
  // /tickets/8416 never matches ticket 84162.
  const host = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${host}\\.freshdesk\\.com/a/tickets/${ticketId}(?!\\d)`, "i");
}

/**
 * Does this issue REALLY reference the ticket, or did full-text search just find
 * the number somewhere? Checks the description — the only place the association
 * actually lives.
 */
export function issueLinksTicket(
  description: string | null | undefined,
  domain: string,
  ticketId: number,
): boolean {
  if (!description) return false;
  return freshdeskTicketUrlPattern(domain, ticketId).test(description);
}

export class ReadOnlyAtlassian {
  private readonly auth: string;
  private readonly origin: string;

  /**
   * @param site  e.g. "simployer.atlassian.net"
   * @param email Atlassian account e-mail the API token belongs to
   * @param token an Atlassian API token
   */
  constructor(site: string, email: string, token: string) {
    this.origin = `https://${site.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
    this.auth = "Basic " + btoa(`${email}:${token}`);
  }

  // The ONLY request method on this class, and it is hard-wired to GET. There is
  // no post/put/patch/delete here at all, so a write is not merely discouraged —
  // it is unreachable, which is what the coaching guard test asserts.
  private async get<T>(path: string, timeoutMs = 20_000): Promise<T> {
    const url = `${this.origin}${path}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { authorization: this.auth, accept: "application/json" },
        signal: ctl.signal,
      });
      const body = await res.text();
      if (!res.ok) {
        // Never echo the body: Jira errors can quote issue text, which may carry
        // customer data (CLAUDE.md §5).
        throw new HttpError(res.status, url, "");
      }
      return JSON.parse(body) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Find Jira issues that genuinely reference a Freshdesk ticket.
   *
   * Two stages, deliberately: JQL narrows, then the description is re-checked.
   * `escapeJql` keeps a ticket id from breaking out of the quoted string.
   */
  async issuesForTicket(
    ticketId: number,
    freshdeskDomain: string,
    maxResults = 20,
  ): Promise<JiraIssue[]> {
    const jql = `text ~ "${escapeJql(String(ticketId))}" ORDER BY updated DESC`;
    const path = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}` +
      `&maxResults=${maxResults}&fields=summary,status,description`;

    const data = await this.get<{ issues?: RawIssue[] }>(path);
    return (data.issues ?? [])
      // The confirmation step. Without it, any issue mentioning the number wins.
      .filter((i) => issueLinksTicket(plainText(i.fields?.description), freshdeskDomain, ticketId))
      .map((i) => ({
        key: i.key,
        summary: i.fields?.summary ?? "",
        status: i.fields?.status?.name ?? null,
        url: `${this.origin}/browse/${i.key}`,
      }));
  }

  /** Confluence pages referencing a ticket. Same two-stage shape as Jira. */
  async pagesForTicket(ticketId: number, freshdeskDomain: string): Promise<ConfluencePage[]> {
    const cql = `text ~ "${escapeJql(String(ticketId))}"`;
    const path = `/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=20` +
      `&expand=content.body.storage`;
    const data = await this.get<{ results?: RawCqlResult[] }>(path);
    return (data.results ?? [])
      .filter((r) =>
        issueLinksTicket(r.content?.body?.storage?.value, freshdeskDomain, ticketId)
      )
      .map((r) => ({
        id: r.content?.id ?? "",
        title: r.content?.title ?? r.title ?? "",
        url: `${this.origin}/wiki${r.content?._links?.webui ?? ""}`,
      }));
  }

  /** Cheap liveness/auth check that reads nothing sensitive. */
  async whoAmI(): Promise<{ accountId: string; email: string | null }> {
    const me = await this.get<{ accountId: string; emailAddress?: string }>("/rest/api/3/myself");
    return { accountId: me.accountId, email: me.emailAddress ?? null };
  }
}

export interface ConfluencePage {
  id: string;
  title: string;
  url: string;
}

interface RawIssue {
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string };
    description?: unknown;
  };
}

interface RawCqlResult {
  title?: string;
  content?: {
    id?: string;
    title?: string;
    body?: { storage?: { value?: string } };
    _links?: { webui?: string };
  };
}

/**
 * A JQL string literal cannot contain an unescaped quote or backslash. Ticket
 * ids are numeric today, but this is user-adjacent input reaching a query
 * language, so it is escaped rather than trusted to stay numeric.
 */
export function escapeJql(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Jira v3 returns descriptions as Atlassian Document Format (a JSON tree) unless
 * asked otherwise. Flatten any text nodes so the URL check works on either
 * shape — the live probe returned markdown-ish strings, but the REST API returns
 * ADF, and assuming one would be exactly the mistake this file exists to avoid.
 */
export function plainText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(plainText).join(" ");
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof o.text === "string") parts.push(o.text);
    // Smartlinks carry the URL on the mark's attrs, not as text.
    if (o.attrs && typeof o.attrs === "object") {
      const a = o.attrs as Record<string, unknown>;
      for (const k of ["url", "href"]) {
        if (typeof a[k] === "string") parts.push(a[k] as string);
      }
    }
    if (Array.isArray(o.content)) parts.push(plainText(o.content));
    if (Array.isArray(o.marks)) parts.push(plainText(o.marks));
    return parts.join(" ");
  }
  return "";
}

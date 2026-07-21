// Freshdesk + Claude API clients.
//
// Every outbound call has an explicit timeout and 429/Retry-After handling
// (CLAUDE.md §7, §12). The ONLY write to any external system is postPrivateNote().
// Everything else is read-only — that is what keeps the security review narrow.

const DEFAULT_TIMEOUT_MS = 20_000;

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string, readonly body: string) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { timeoutMs?: number; maxRetries?: number } = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? 2;

  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }

    // Rate limited — respect Retry-After, then retry a bounded number of times.
    if (res.status === 429 && attempt < maxRetries) {
      const ra = Number(res.headers.get("retry-after") ?? "1");
      await sleep((Number.isFinite(ra) ? ra : 1) * 1000);
      continue;
    }
    // Transient upstream error — exponential backoff.
    if (res.status >= 500 && attempt < maxRetries) {
      await sleep(2 ** attempt * 500);
      continue;
    }
    return res;
  }
}

// ── Freshdesk ─────────────────────────────────────────────────────────────────

export interface Agent {
  id: number;
  contact: { name: string; email: string };
}

export interface TicketSummary {
  id: number;
  subject: string;
  responder_id: number | null;
  updated_at: string;
  status: number;
}

export interface Conversation {
  id: number;
  body_text: string;
  incoming: boolean; // true = from the customer
  private: boolean; // true = internal note
  created_at: string;
}

export interface Ticket extends TicketSummary {
  description_text: string;
  conversations?: Conversation[];
}

export interface Solution {
  id: number;
  title?: string;
  description?: string;
  description_text?: string;
  category_name?: string;
  folder_name?: string;
}

export class Freshdesk {
  private readonly base: string;
  private readonly auth: string;

  constructor(domain: string, apiKey: string) {
    // domain "simployer" -> https://simployer.freshdesk.com/api/v2
    this.base = `https://${domain}.freshdesk.com/api/v2`;
    this.auth = "Basic " + btoa(`${apiKey}:X`);
  }

  private async get<T>(path: string, timeoutMs?: number): Promise<T> {
    const url = `${this.base}${path}`;
    const res = await fetchWithRetry(url, { method: "GET", headers: { authorization: this.auth } }, {
      timeoutMs,
    });
    if (!res.ok) throw new HttpError(res.status, url, await res.text());
    return await res.json() as T;
  }

  me(): Promise<Agent> {
    return this.get<Agent>("/agents/me");
  }

  // Tickets updated at/after an ISO timestamp, oldest first. Freshdesk paginates.
  listUpdatedTickets(updatedSince: string): Promise<TicketSummary[]> {
    const q = new URLSearchParams({
      updated_since: updatedSince,
      order_by: "updated_at",
      order_type: "asc",
      per_page: "100",
    });
    return this.get<TicketSummary[]>(`/tickets?${q}`);
  }

  ticketWithConversations(id: number): Promise<Ticket> {
    return this.get<Ticket>(`/tickets/${id}?include=conversations`);
  }

  // UNVERIFIED against a live instance (CLAUDE.md §7 — the endpoint I am least
  // sure about). If this shape is wrong, fix it here; the pipeline treats a
  // retrieval failure as "no sources", not a crash.
  async searchSolutions(term: string): Promise<Solution[]> {
    const q = new URLSearchParams({ term });
    const res = await this.get<{ results?: Solution[] } | Solution[]>(`/search/solutions?${q}`);
    return Array.isArray(res) ? res : (res.results ?? []);
  }

  // Freshdesk ticket search uses a quoted, field-oriented query string.
  // UNVERIFIED — confirm the syntax against a live instance before trusting it.
  searchTickets(query: string): Promise<{ results: TicketSummary[]; total: number }> {
    const q = new URLSearchParams({ query: `"${query}"` });
    return this.get<{ results: TicketSummary[]; total: number }>(`/search/tickets?${q}`);
  }

  // The ONLY write anywhere in this system. Posts a private (internal) note.
  async postPrivateNote(ticketId: number, bodyHtml: string): Promise<number> {
    const url = `${this.base}/tickets/${ticketId}/notes`;
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { authorization: this.auth, "content-type": "application/json" },
      body: JSON.stringify({ body: bodyHtml, private: true }),
    });
    if (!res.ok) throw new HttpError(res.status, url, await res.text());
    const note = await res.json() as { id: number };
    return note.id;
  }
}

// ── Claude ────────────────────────────────────────────────────────────────────

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

export class Claude {
  constructor(private readonly apiKey: string, private readonly model: string) {}

  async complete(
    system: string,
    messages: ClaudeMessage[],
    opts: { maxTokens?: number; timeoutMs?: number } = {},
  ): Promise<string> {
    const url = "https://api.anthropic.com/v1/messages";
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens ?? 1500,
        system,
        messages,
      }),
    }, { timeoutMs: opts.timeoutMs ?? 30_000 });

    if (!res.ok) throw new HttpError(res.status, url, await res.text());
    const data = await res.json() as { content: Array<{ type: string; text?: string }> };
    return data.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  }
}

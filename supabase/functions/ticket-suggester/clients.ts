// Freshdesk + LLM (OpenAI) API clients.
//
// Every outbound call has an explicit timeout and 429/Retry-After handling
// (CLAUDE.md §7, §12). Writes are limited to postPrivateNote() and setTags()
// (keyword tags for visibility) — both target the same Freshdesk ticket.

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

export interface Attachment {
  name?: string;
  content_type?: string;
}

export interface Conversation {
  id: number;
  body_text: string;
  incoming: boolean; // true = from the customer
  private: boolean; // true = internal note
  created_at: string;
  attachments?: Attachment[];
}

export interface Ticket extends TicketSummary {
  description_text: string;
  tags?: string[];
  attachments?: Attachment[];
  conversations?: Conversation[];
  // Requester (the customer) — already on file because they contacted us. Surfaced
  // so the model never asks the customer for an email/identity we already hold.
  email?: string | null;
  requester?: { name?: string; email?: string } | null;
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
  private readonly origin: string;
  private readonly base: string;
  private readonly auth: string;

  constructor(domain: string, apiKey: string) {
    // domain "simployer" -> https://simployer.freshdesk.com
    this.origin = `https://${domain}.freshdesk.com`;
    this.base = `${this.origin}/api/v2`;
    this.auth = "Basic " + btoa(`${apiKey}:X`);
  }

  // Agent-facing links for the private note (agents, not customers, read notes).
  articleUrl(id: number): string {
    return `${this.origin}/a/solutions/articles/${id}`;
  }
  ticketUrl(id: number): string {
    return `${this.origin}/a/tickets/${id}`;
  }

  private async get<T>(path: string, timeoutMs?: number): Promise<T> {
    const url = `${this.base}${path}`;
    const res = await fetchWithRetry(url, { method: "GET", headers: { authorization: this.auth } }, {
      timeoutMs,
    });
    if (!res.ok) throw new HttpError(res.status, url, await res.text());
    return await res.json() as T;
  }

  // The API key's own account (the service account that posts notes).
  me(): Promise<Agent> {
    return this.get<Agent>("/agents/me");
  }

  // Look up a specific agent (the monitored agent). Requires admin-scoped API
  // access; callers treat a failure here as "couldn't verify", not fatal.
  getAgent(id: number): Promise<Agent> {
    return this.get<Agent>(`/agents/${id}`);
  }

  // Resolve an agent by email (exact) or name (all words must appear, case-
  // insensitive). Requires admin-scoped API access. Used only by the replay
  // harness to target one agent's tickets; returns null if nothing matches.
  async findAgent(query: string): Promise<Agent | null> {
    const q = query.trim().toLowerCase();
    if (q.includes("@")) {
      const byEmail = await this.get<Agent[]>(`/agents?email=${encodeURIComponent(query.trim())}`);
      return byEmail[0] ?? null;
    }
    const words = q.split(/\s+/).filter(Boolean);
    const roster = await this.get<Agent[]>(`/agents?per_page=100`);
    return roster.find((a) => {
      const name = (a.contact?.name ?? "").toLowerCase();
      return words.every((w) => name.includes(w));
    }) ?? null;
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
    return this.get<Ticket>(`/tickets/${id}?include=conversations,requester`);
  }

  // VERIFIED 2026-07-22 against the live instance: returns solution articles with
  // `title` and `description_text` (among others). The pipeline treats a retrieval
  // failure as "no sources", never a crash.
  async searchSolutions(term: string): Promise<Solution[]> {
    const q = new URLSearchParams({ term });
    const res = await this.get<{ results?: Solution[] } | Solution[]>(`/search/solutions?${q}`);
    return Array.isArray(res) ? res : (res.results ?? []);
  }

  // NOT usable for free-text content search: Freshdesk's ticket search only accepts
  // field-based queries ("status:5 AND agent_id:123", space mandatory around AND) —
  // a bare term returns HTTP 400 (verified 2026-07-22). This is why past-ticket
  // retrieval stays out of the pipeline (KB-only). Kept for possible future
  // field-based use; callers must pass a valid `keyword:value` query, not prose.
  searchTickets(query: string, page = 1): Promise<{ results: TicketSummary[]; total: number }> {
    const q = new URLSearchParams({ query: `"${query}"`, page: String(page) });
    return this.get<{ results: TicketSummary[]; total: number }>(`/search/tickets?${q}`);
  }

  // Primary write: posts a private (internal) note — the real deliverable.
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

  // Second write (CLAUDE.md §12): replace the ticket's tag set. PUT /tickets/{id}
  // REPLACES the whole tags array — there is no additive endpoint — so callers
  // merge with the ticket's existing tags first to avoid clobbering them.
  async setTags(ticketId: number, tags: string[]): Promise<void> {
    const url = `${this.base}/tickets/${ticketId}`;
    const res = await fetchWithRetry(url, {
      method: "PUT",
      headers: { authorization: this.auth, "content-type": "application/json" },
      body: JSON.stringify({ tags }),
    });
    if (!res.ok) throw new HttpError(res.status, url, await res.text());
  }
}

// ── LLM (OpenAI) ────────────────────────────────────────────────────────────
// The provider is isolated in this one class (CLAUDE.md §12). The pipeline only
// calls complete(system, messages) and gets back text, so switching providers
// (or back to Anthropic) touches nothing else.

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export class LLM {
  constructor(private readonly apiKey: string, private readonly model: string) {}

  async complete(
    system: string,
    messages: ChatMessage[],
    opts: { maxTokens?: number; timeoutMs?: number; model?: string } = {},
  ): Promise<string> {
    const url = "https://api.openai.com/v1/chat/completions";
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        // Per-call model override (cost tiering) — falls back to the instance model.
        model: opts.model ?? this.model,
        // temperature 0 for reproducibility — the golden set (§8) re-runs the
        // same tickets, and drift between runs muddies the comparison.
        temperature: 0,
        max_tokens: opts.maxTokens ?? 1500,
        // OpenAI takes the system prompt as the first message.
        messages: [{ role: "system", content: system }, ...messages],
      }),
    }, { timeoutMs: opts.timeoutMs ?? 60_000 });

    if (!res.ok) throw new HttpError(res.status, url, await res.text());
    const data = await res.json() as { choices: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? "";
  }

  // Same chat endpoint, but constrains the model to a JSON Schema (OpenAI
  // Structured Outputs). Used by the QA Coach (CLAUDE.md §12) so the scorecard
  // comes back already-shaped — no fragile JSON extraction. `jsonSchema` is the
  // `{ name, strict, schema }` object OpenAI expects under response_format.
  async completeSchema<T>(
    system: string,
    user: string,
    // deno-lint-ignore no-explicit-any
    jsonSchema: any,
    opts: { temperature?: number; maxTokens?: number; timeoutMs?: number; model?: string } = {},
  ): Promise<T> {
    const url = "https://api.openai.com/v1/chat/completions";
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model ?? this.model,
        temperature: opts.temperature ?? 0,
        max_tokens: opts.maxTokens ?? 2000,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: jsonSchema },
      }),
    }, { timeoutMs: opts.timeoutMs ?? 60_000 });

    if (!res.ok) throw new HttpError(res.status, url, await res.text());
    const data = await res.json() as { choices: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";
    if (!content) throw new Error("LLM returned no structured content");
    return JSON.parse(content) as T;
  }

  // Embedding for semantic past-ticket search (stage 2). Fixed 1536-dim model to
  // match the past_tickets.embedding column. Callers treat a failure as "no vector".
  async embed(text: string, opts: { timeoutMs?: number } = {}): Promise<number[]> {
    const url = "https://api.openai.com/v1/embeddings";
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 8000) }),
    }, { timeoutMs: opts.timeoutMs ?? 30_000 });
    if (!res.ok) throw new HttpError(res.status, url, await res.text());
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data?.[0]?.embedding ?? [];
  }
}

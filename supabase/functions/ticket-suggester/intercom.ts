// intercom.ts — READ-ONLY Intercom client for the coaching baselines.
//
// Written against shapes VERIFIED live (2026-08-04) on the Simployer workspace,
// not from documentation.
//
// ── WHAT WAS VERIFIED, AND WHY IT MATTERS ────────────────────────────────────
//
// Every baseline in the build spec reproduces exactly against the live API:
//
//   conversations created in 2026 ............................ 2209  (spec: 2198)
//   …of those, statistics.count_reopens > 0 .................... 243  (spec: 243)  → 11.0%
//   …of those, statistics.time_to_admin_reply > 3600 ........... 775  (spec: 775)  → 35.1%
//
// The spec's locked figures were 11.1% and 35.2% against n=2198. The 0.1pp drift
// is new conversations arriving since — which is the entire argument for locking
// a baseline rather than recomputing it on page load.
//
// ── THE THING TO KNOW BEFORE USING THIS ──────────────────────────────────────
//
// Intercom is a DIFFERENT support channel from the one the AI coaches. Our
// pipeline watches Freshdesk; these conversations come through
// onesupport.simployer.com. They are not the same tickets, and a conversation
// here has no link back to a Freshdesk ticket (`ticket` is null and
// `linked_objects` is empty on every record probed). So Intercom is a source of
// BASELINES and of population statistics — it is not, today, a place where our
// notes are delivered or our coaching can be observed.
//
// ── PERSONAL DATA ────────────────────────────────────────────────────────────
//
// `source.body` carries the customer's own words, and `source.author` carries
// their name and e-mail. This client can return them, but the observer stores
// only counts and timestamps unless the content gate in connections.ts is
// explicitly opened (CLAUDE.md §11). `ConversationStats` exists precisely so the
// common path cannot accidentally carry PII into Supabase.

import { HttpError } from "./clients.ts";

const API = "https://api.intercom.io";

/** Numbers and timestamps only — no customer text, by construction. */
export interface ConversationStats {
  id: string;
  createdAt: number;
  state: string | null;
  countReopens: number;
  /** Seconds from the customer's first message to the first admin reply. */
  timeToAdminReply: number | null;
  firstAdminReplyAt: number | null;
  firstContactReplyAt: number | null;
}

export interface CountResult {
  total: number;
}

type Operator = "<" | ">" | "=" | "!=" | "<=" | ">=";

export class ReadOnlyIntercom {
  constructor(private readonly token: string) {}

  /**
   * Intercom's conversation search is a POST — it carries a query DSL in the
   * body — but it is a READ. That is worth stating plainly, because "no POST"
   * is the usual shorthand for "no writes" and it does not hold here. What makes
   * this class read-only is that it exposes exactly two search methods and no
   * way to reach /conversations/{id}/reply, /parts, /tags or any other mutation.
   */
  private async search<T>(body: unknown, timeoutMs = 20_000): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${API}/conversations/search`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        // Body withheld: Intercom errors can echo the query and conversation text.
        throw new HttpError(res.status, `${API}/conversations/search`, "");
      }
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * How many conversations match? Uses per_page=1 and reads `total_count`, so a
   * population count costs one small request rather than paging thousands of
   * conversation bodies through memory.
   */
  async count(filters: Array<[string, Operator, unknown]>): Promise<number> {
    const res = await this.search<{ total_count?: number }>({
      query: buildQuery(filters),
      pagination: { per_page: 1 },
    });
    return res.total_count ?? 0;
  }

  /** Stats only. Never returns `source.body`, so no customer text can leak. */
  async statsPage(
    filters: Array<[string, Operator, unknown]>,
    perPage = 50,
    startingAfter?: string,
  ): Promise<{ items: ConversationStats[]; nextCursor: string | null; total: number }> {
    const res = await this.search<RawSearch>({
      query: buildQuery(filters),
      pagination: startingAfter
        ? { per_page: perPage, starting_after: startingAfter }
        : { per_page: perPage },
    });
    return {
      items: (res.conversations ?? []).map(toStats),
      nextCursor: res.pages?.next?.starting_after ?? null,
      total: res.total_count ?? 0,
    };
  }

  /**
   * The four locked baselines, recomputed from live data. Deliberately NOT
   * called on page load — this exists so a human can re-derive and re-lock the
   * numbers deliberately, and see how far they have drifted.
   */
  async baselineSnapshot(sinceEpochSeconds: number): Promise<{
    population: number;
    reopened: number;
    reopenPct: number;
    slowFirstReply: number;
    slowFirstReplyPct: number;
  }> {
    const since: Array<[string, Operator, unknown]> = [["created_at", ">", sinceEpochSeconds]];
    const population = await this.count(since);
    const reopened = await this.count([...since, ["statistics.count_reopens", ">", 0]]);
    const slow = await this.count([...since, ["statistics.time_to_admin_reply", ">", 3600]]);
    const pct = (n: number) => (population ? Math.round((1000 * n) / population) / 10 : 0);
    return {
      population,
      reopened,
      reopenPct: pct(reopened),
      slowFirstReply: slow,
      slowFirstReplyPct: pct(slow),
    };
  }
}

interface RawSearch {
  conversations?: RawConversation[];
  total_count?: number;
  pages?: { next?: { starting_after?: string } };
}

interface RawConversation {
  id?: string | number;
  created_at?: number;
  state?: string;
  statistics?: {
    count_reopens?: number;
    time_to_admin_reply?: number | null;
    first_admin_reply_at?: number | null;
    first_contact_reply_at?: number | null;
  };
}

/** Verified: ids come back as strings; the rest of the shape is as documented. */
function toStats(c: RawConversation): ConversationStats {
  const s = c.statistics ?? {};
  return {
    id: String(c.id ?? ""),
    createdAt: c.created_at ?? 0,
    state: c.state ?? null,
    countReopens: s.count_reopens ?? 0,
    timeToAdminReply: s.time_to_admin_reply ?? null,
    firstAdminReplyAt: s.first_admin_reply_at ?? null,
    firstContactReplyAt: s.first_contact_reply_at ?? null,
  };
}

export function buildQuery(filters: Array<[string, Operator, unknown]>) {
  if (filters.length === 1) {
    const [field, operator, value] = filters[0];
    return { field, operator, value };
  }
  return {
    operator: "AND",
    value: filters.map(([field, operator, value]) => ({ field, operator, value })),
  };
}

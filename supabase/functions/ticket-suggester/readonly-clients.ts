// readonly-clients.ts — the Coaching tab's only door to an external system.
//
// The build spec's hardest constraint: this tab and its job write NOTHING to any
// external system. That is not a promise to keep in review comments — it is
// enforced structurally here and asserted in `coaching_test.ts`.
//
// `Freshdesk` (clients.ts) carries two write methods, `postPrivateNote` and
// `setTags`. This wrapper holds one privately and re-exposes ONLY reads, so a
// write is not merely discouraged from the observation job — it is unreachable.
// The test walks this class's surface and fails if a write name appears.

import type { Freshdesk, Group, Solution, Ticket } from "./clients.ts";

/** Every method the observation job is allowed to call. Reads only. */
export interface ReadOnlyTicketSource {
  ticketWithConversations(id: number): Promise<Ticket>;
  ticketUrl(id: number): string;
  groups(): Promise<Group[]>;
  searchSolutions(term: string): Promise<Solution[]>;
}

/**
 * Method names on the underlying client that mutate an external system. Listed
 * explicitly so a NEW write added to Freshdesk later fails the guard test rather
 * than silently becoming reachable.
 */
export const FRESHDESK_WRITE_METHODS = ["postPrivateNote", "setTags"] as const;

/**
 * Method names that would MUTATE an external system, across every client the
 * coaching observer might touch. The guard test asserts none of these is
 * reachable from any class the observer holds.
 *
 * The Atlassian and Intercom clients are read-only by construction rather than
 * by wrapping — ReadOnlyAtlassian's only request method is hard-wired to GET,
 * and ReadOnlyIntercom exposes nothing but conversation search. This list is the
 * tripwire for anyone who later adds a write to either.
 *
 * Note that "no POST" is NOT the definition of read-only here: Intercom's
 * conversation search is a POST carrying a query DSL, and it is a read.
 */
export const EXTERNAL_WRITE_METHODS = [
  ...FRESHDESK_WRITE_METHODS,
  // Jira / Confluence
  "createIssue", "editIssue", "transitionIssue", "addComment", "createPage",
  "updatePage", "deletePage", "createIssueLink",
  // Intercom
  "reply", "createConversation", "addTag", "assign", "close", "snooze",
  "createArticle", "updateArticle",
] as const;

export class ReadOnlyFreshdesk implements ReadOnlyTicketSource {
  // Private: the write methods exist on `fd` but there is no path to them from
  // outside this class, and nothing inside it calls them.
  constructor(private readonly fd: Freshdesk) {}

  ticketWithConversations(id: number): Promise<Ticket> {
    return this.fd.ticketWithConversations(id);
  }

  ticketUrl(id: number): string {
    return this.fd.ticketUrl(id);
  }

  /** Group id -> name, for the route_expert / escalate signals. */
  groups(): Promise<Group[]> {
    return this.fd.groups();
  }

  /**
   * The CUSTOMER knowledge base. Used to confirm an article actually reached the
   * help centre, which is the strong form of "write_kb was followed".
   */
  searchSolutions(term: string): Promise<Solution[]> {
    return this.fd.searchSolutions(term);
  }
}

/**
 * True when `obj` exposes any known write method. Used by the guard test; also
 * usable as a runtime assertion if someone passes a raw client by mistake.
 */
export function exposesWriteMethod(
  obj: object,
  names: readonly string[] = EXTERNAL_WRITE_METHODS,
): string | null {
  for (const name of names) {
    // deno-lint-ignore no-explicit-any
    if (typeof (obj as any)[name] === "function") return name;
  }
  return null;
}

/** Throw rather than proceed if a caller hands the job something that can write. */
export function assertReadOnly(obj: object, label: string): void {
  const write = exposesWriteMethod(obj);
  if (write) {
    throw new Error(
      `${label} exposes the write method "${write}" — the coaching observer is read-only`,
    );
  }
}

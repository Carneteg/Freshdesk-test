// connections.ts — which external systems are actually reachable, in one place.
//
// The Coaching tab renders "not connected" for any signal whose system this
// deployment cannot reach. Until now that was a hardcoded boolean in
// coaching.ts, which meant the truth lived in two places: the code said
// "connected: false" and reality said "no credentials". Those drift.
//
// This module makes it one place, and derives it the only honest way — from
// whether the credentials are actually present in THIS environment. A system is
// connected when it can be called, not when someone remembered to update a flag.
//
// Adding a system here does NOT grant it: it declares which env vars would grant
// it. No secret value is ever read, logged or exported — only whether it is set.

// INTERCOM WAS REMOVED (2026-08-04), deliberately rather than left dormant.
// Its four baselines reproduced exactly against the live API, but Intercom is a
// DIFFERENT support channel from the one the AI coaches: our pipeline watches
// Freshdesk, those conversations arrive through onesupport.simployer.com, and no
// record links the two. Measuring coaching performance on Freshdesk against an
// Intercom population was never a fair comparison, so the baselines are now
// measured on the coached tickets themselves (scripts/measure_baselines.ts).
// Dropping it also removes a source of customer PII we had no need to hold.

/** Every external system the coaching observer may read from. */
export const SYSTEMS = [
  "freshdesk",
  "supabase",
  "jira",
  "confluence",
  "linear",
  "planhat",
] as const;

export type SystemName = typeof SYSTEMS[number];

/**
 * The credentials each system needs. ALL of them must be present for the system
 * to count as connected — a half-configured integration is not connected, it is
 * a runtime error waiting to happen.
 *
 * `linear` and `planhat` are listed with no env vars at all: there is no client
 * for them in this codebase, so they can never report connected. That is
 * deliberate and matches the build spec — if a client does not exist, render
 * "not connected" rather than stubbing fake data.
 */
export const REQUIRED_ENV: Record<SystemName, string[]> = {
  freshdesk: ["FRESHDESK_DOMAIN", "FRESHDESK_API_KEY"],
  supabase: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
  // Atlassian Cloud: one token covers both products, but the site and the
  // account e-mail differ per product install, so each is declared separately.
  jira: ["ATLASSIAN_SITE", "ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN"],
  confluence: ["ATLASSIAN_SITE", "ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN"],
  linear: [],
  planhat: [],
};

/** Human-readable reason a system is unavailable, for the tab. */
export const NOT_CONNECTED_REASON: Record<SystemName, string> = {
  freshdesk: "Freshdesk credentials are not set",
  supabase: "Supabase credentials are not set",
  jira: "no Atlassian credentials in this environment",
  confluence: "no Atlassian credentials in this environment",
  linear: "no Linear client exists in this codebase",
  planhat: "no Planhat client exists in this codebase",
};

/** Reads only the PRESENCE of a variable. Never its value. */
export type EnvLookup = (name: string) => string | undefined;

const denoEnv: EnvLookup = (name) => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined; // no --allow-env; treat as absent rather than crash
  }
};

export interface ConnectionStatus {
  system: SystemName;
  connected: boolean;
  /** Which declared vars are missing. Names only — never values. */
  missing: string[];
  reason: string | null;
}

export function systemStatus(system: SystemName, env: EnvLookup = denoEnv): ConnectionStatus {
  const required = REQUIRED_ENV[system];
  // A system with no declared credentials has no client at all — it can never
  // be connected, however the environment is configured.
  if (!required.length) {
    return {
      system,
      connected: false,
      missing: [],
      reason: NOT_CONNECTED_REASON[system],
    };
  }
  const missing = required.filter((name) => !(env(name) ?? "").trim());
  return {
    system,
    connected: missing.length === 0,
    missing,
    reason: missing.length ? NOT_CONNECTED_REASON[system] : null,
  };
}

export function allStatuses(env: EnvLookup = denoEnv): ConnectionStatus[] {
  return SYSTEMS.map((s) => systemStatus(s, env));
}

export function isConnected(system: SystemName, env: EnvLookup = denoEnv): boolean {
  return systemStatus(system, env).connected;
}

// ── Why there is no content gate any more ────────────────────────────────────
//
// A gate lived here guarding the storage of Intercom conversation CONTENT, since
// §11 forbids putting a NEW source's customer text in Supabase before legal has
// cleared it. Intercom has since been dropped (see below), so the gate had no
// subject left to guard and a switch that guards nothing is worse than none — it
// implies a control exists.
//
// If a new source of customer text is ever added, reinstate it: default off, one
// variable, named for what it asserts, so switching it on is a claim a person
// makes on the record.

/** One line for logs/CLI describing what this deployment can see. */
export function describeConnections(env: EnvLookup = denoEnv): string {
  const on = allStatuses(env).filter((s) => s.connected).map((s) => s.system);
  const off = allStatuses(env).filter((s) => !s.connected).map((s) => s.system);
  return `connected: ${on.join(", ") || "(none)"} · not connected: ${off.join(", ") || "(none)"}`;
}

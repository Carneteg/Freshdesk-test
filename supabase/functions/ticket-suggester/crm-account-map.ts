// crm_account_map — the deterministic layer above the fuzzy matching ladder.
//
// Philosophy (same as known_incidents): curate once, resolve forever. A row maps
// a key we hold (Freshdesk company id, or a requester email domain) to ONE
// verified CRM account. Runtime then needs no name matching at all for known
// customers; the ladder remains the fallback for unmapped ones.
//
// Rows are either `human` (curated, wins forever) or `learned_contact_email`
// (written automatically ONLY from the ladder's strongest tier — an exact
// contact-email match). Learning rules:
//   - a `human` row is never touched by learning;
//   - re-confirming the same account bumps last_confirmed_at;
//   - CONFLICTING evidence (same key, different account) deactivates the learned
//     row instead of overwriting it — the runtime falls back to the ladder and
//     the conflict stays visible in the table, never silently resolved.
//
// Every function is contained: a map failure must never break the note.

// deno-lint-ignore no-explicit-any
type Db = any;

export interface AccountMapKey {
  companyId?: number | null;
  domain?: string | null;
}

export interface AccountMapHit {
  accountId: number;
  source: "human" | "learned_contact_email";
}

const TABLE = "crm_account_map";

async function activeRow(
  db: Db,
  column: "freshdesk_company_id" | "email_domain",
  value: number | string,
): Promise<{ id: number; crm_account_id: number; source: string } | null> {
  const { data, error } = await db
    .from(TABLE)
    .select("id, crm_account_id, source")
    .eq("active", true)
    .eq(column, value)
    .limit(2);
  if (error || !Array.isArray(data)) return null;
  // The partial unique index guarantees at most one active row per key; treat
  // anything else as "no deterministic answer" rather than picking one.
  return data.length === 1 ? data[0] : null;
}

export async function lookupAccountMap(
  db: Db,
  key: AccountMapKey,
): Promise<AccountMapHit | null> {
  if (key.companyId) {
    const row = await activeRow(db, "freshdesk_company_id", key.companyId);
    if (row) {
      return {
        accountId: row.crm_account_id,
        source: row.source === "human" ? "human" : "learned_contact_email",
      };
    }
  }
  if (key.domain) {
    const row = await activeRow(db, "email_domain", key.domain);
    if (row) {
      return {
        accountId: row.crm_account_id,
        source: row.source === "human" ? "human" : "learned_contact_email",
      };
    }
  }
  return null;
}

async function learnOne(
  db: Db,
  column: "freshdesk_company_id" | "email_domain",
  value: number | string,
  accountId: number,
  accountName: string | null,
): Promise<void> {
  const existing = await activeRow(db, column, value);
  if (!existing) {
    await db.from(TABLE).insert({
      [column]: value,
      crm_account_id: accountId,
      crm_account_name: accountName,
      source: "learned_contact_email",
    });
    return;
  }
  if (existing.source === "human") return; // curated always wins
  if (existing.crm_account_id === accountId) {
    await db.from(TABLE)
      .update({ last_confirmed_at: new Date().toISOString() })
      .eq("id", existing.id);
    return;
  }
  // Conflicting evidence: deactivate, never overwrite. The runtime falls back
  // to the ladder for this key until a human curates the right account.
  await db.from(TABLE).update({ active: false }).eq("id", existing.id);
}

// Learn from a confirmed contact-email match. Both keys are optional; freemail
// domains must already have been filtered out by the caller (emailDomain()).
export async function learnAccountMap(
  db: Db,
  key: AccountMapKey,
  accountId: number,
  accountName: string | null = null,
): Promise<void> {
  if (key.companyId) {
    await learnOne(db, "freshdesk_company_id", key.companyId, accountId, accountName);
  }
  if (key.domain) {
    await learnOne(db, "email_domain", key.domain, accountId, accountName);
  }
}

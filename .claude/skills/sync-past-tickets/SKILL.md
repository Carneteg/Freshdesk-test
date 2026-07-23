---
name: sync-past-tickets
description: Refresh the semantic past-ticket precedent index and report how fresh it is. Use when the user asks to sync/refresh past tickets, or how current the past_tickets index is — it does not auto-update, so resolved tickets closed after the last sync are missing until re-run.
---

# Sync past tickets + report freshness

Stage-2 retrieval cites how *similar resolved tickets* were handled. That index
(`past_tickets`) is a manual snapshot — this skill refreshes it and reports its age.

## When to use
- "Sync / refresh the past tickets."
- "How fresh is the precedent index / are recent tickets included?"
- After a batch of tickets has been resolved and you want them available as precedent.

## Steps
1. **Run the sync:** `deno task sync-tickets`
   - Needs `.env` with `FRESHDESK_*`, `OPENAI_*`, `SUPABASE_*`.
   - `REPLAY_AGENT` (name/email/id) selects whose closed tickets; `SYNC_LIMIT` caps count.
   - Sends real closed-ticket content to OpenAI for embeddings — **DPA cleared**
     for the current provider (CLAUDE.md §11/§12); flag it, don't silently proceed.
   - If Deno can't run here (the web container can't always install it), ask the
     user to run it locally, then continue with step 2.
2. **Report freshness** via the Supabase MCP:
   ```sql
   select count(*) as total,
          max(synced_at) as last_synced,
          now() - max(synced_at) as age
   from past_tickets;
   ```
3. **Summarise:** how many tickets are indexed and how old the newest sync is.
   Remind the user that any ticket resolved *after* `last_synced` is not in the
   index until the next sync.

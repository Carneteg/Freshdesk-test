# Decisions

## 2026-07-28 — Reliability before more prompt work

Accepted:

- Generations are immutable and versioned by prompt, model, and run variant.
- Human reviews are separate records keyed to generation ID.
- Replay never overwrites an existing generation.
- Freshdesk note POST has no automatic retry.
- Delivery uses a database outbox plus a note marker for recovery.
- Polling uses full pagination, a durable cursor, a database queue, and a lease.
- New feedback goes through the authenticated review app.
- Legacy token feedback requires GET confirmation followed by one-use POST.
- GitHub batch logs use safe mode.
- CI uses Deno 2.9.4 and exact Supabase client imports.

Deferred:

- a legally approved retention duration and automated purge;
- deletion propagation and pre-embedding PII masking;
- structured JSON Schema for analyse/draft/verify;
- semantic/topic/product-aware gold-example selection;
- broader concurrency/RLS integration tests against an ephemeral Postgres stack.

The production scheduler stays paused until `GOLIVE.md` gates are complete.

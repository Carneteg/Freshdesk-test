# Security and data protection

## Data boundary

Ticket content may contain employee personal data. Gate 1 is approved for OpenAI
and Supabase in Frankfurt. A new provider or data source requires a new review.

Freshdesk, Supabase, OpenAI, and GitHub Actions are separate processing locations.
GitHub Actions must run with `CLOUD_LOG_MODE=safe`; ticket subjects, customer text,
agent replies, drafts, source excerpts, and full API bodies must not be logged.

## Secrets

- Never commit `.env` or API keys.
- The service-role key is limited to protected workflows and Edge Functions.
- Production workflows should use a protected GitHub Environment with approval.
- The previously exposed OpenAI key must be revoked; record rotation date, actor,
  and revocation verification outside the repository.

## Browser access

The review app uses Supabase Auth plus the `app_reviewers` allowlist. RLS is the
authorization boundary. Browser writes go only through narrow review RPCs.
New notes contain a safe generation deep-link, not a feedback token or verdict.

## Logging

Safe cloud log fields:

- ticket ID;
- coach mode and confidence;
- latency and source count;
- success/failure status with a bounded, sanitized error.

Do not log ticket bodies, subjects, customer/agent text, full drafts, retrieved
source text, tokens, or API response bodies.

## Retention decision still required

Before broad historical sync or a wider pilot, legal/data owners must decide:

- retention period for ticket/generation/review/training data;
- deletion propagation from Freshdesk;
- identifier masking before embeddings;
- deletion audit requirements;
- GitHub Actions log retention and authorized readers.

No retention duration is invented in code by this change.

# Architecture

## Scope

Gate 1 has three systems only:

1. Freshdesk — trigger data, ticket context, KB retrieval, private note + tags.
2. Supabase Frankfurt — Edge Functions, Postgres state, review data, cron.
3. OpenAI — analyse, draft, verify, plus offline QA scoring.

The product is an agent coach. It writes a customer-ready draft only when the
answer is grounded; otherwise it gives verified facts and agent next steps.

## Live flow

```mermaid
flowchart TD
  A["Cron invocation"] --> B["Acquire DB lease"]
  B --> C["Read durable cursor"]
  C --> D["Page all Freshdesk updates"]
  D --> E["Enqueue monitored events + advance cursor"]
  E --> F["Reload ticket + agent re-check"]
  F --> G["Reserve immutable generation"]
  G --> H["Analyse → retrieve → draft → verify"]
  H --> I["Store note in outbox"]
  I --> J["Check delivery marker"]
  J --> K["POST private note once"]
  K --> L["Persist posted state + note ID"]
  L --> M["Merge up to 3 tags"]
```

The cursor advances only in the same database transaction that accepts queue
events. The generation reservation prevents two workers from generating the same
variant. The marker recovers an accepted Freshdesk POST after a lost response.

## Generation identity

A generation is unique by:

```text
ticket_id
+ trigger_message_id
+ prompt_version
+ model
+ run_variant
```

Generation payload becomes immutable after `reserved`. Human judgements live in
`suggestion_reviews`; compatibility fields on `suggestions` are a read projection.

## External writes

The only live external writes remain:

- one private Freshdesk note;
- one tag-set update on the same ticket.

No workflow writes a customer-facing reply.

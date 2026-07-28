# Operations

## Deploy order

1. Apply database migrations.
2. Deploy the review app/RPC-compatible UI.
3. Deploy `ticket-suggester` with `DRY_RUN=true`.
4. Run a supervised invocation and inspect queue/outbox state.
5. Test marker recovery on a synthetic/test ticket.
6. Enable one supervised live invocation.
7. Enable cron only after verification.

See `GOLIVE.md` for exact gates.

## State to monitor

```sql
select delivery_status, count(*) from suggestions group by delivery_status;
select state, count(*) from ticket_poll_queue group by state;
select * from failures limit 50;
select * from poll_cursors;
select * from poll_leases;
```

Interpretation:

- `reserved` — generation is running or its lease expired after a crash.
- `generated` — outbox payload exists; dry-run is complete or live delivery awaits.
- `posting` — note POST started; recovery must check the marker before another POST.
- `posted` — note ID and timestamp are durable.
- `failed` — visible, resumable failure; investigate the sanitized error.

Queue items fail permanently after five attempts and require operator review.

## Rollback

Pause cron first. Set `DRY_RUN=true` before any redeploy. Do not delete queue,
cursor, outbox, or review rows to “unstick” a run; preserve evidence and correct
the state deliberately.

The database migration is forward-only because it preserves collected evaluation
history. Roll back application code only after confirming it understands the new
generation key and delivery columns.

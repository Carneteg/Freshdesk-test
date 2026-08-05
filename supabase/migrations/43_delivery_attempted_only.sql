-- Migration 43 — the note-timing metric only counts notes we actually tried to send.
--
-- WHY. The first real run of observe-coaching reported 88.1 % of notes late
-- against a 2 % target. That number was wrong, and wrong in the direction that
-- makes the project look broken.
--
-- `deriveDeliveryStatus(null, replyAt)` returns 'late' — correct for a LIVE note
-- that failed to post, because the agent replied and never saw it. But it was
-- being applied to every generation, including replay and dry-run runs, which
-- never post by design. That asks "did this note arrive before the agent
-- replied?" of a note that was never sent. It answered "no" 77 times.
--
--   posted, late          34
--   posted, in time       15
--   posted, no reply yet  20
--   NEVER POSTED, "late"  77   ← phantom failures
--
-- On the notes we genuinely tried to deliver the late rate is 69.4 %, not
-- 88.1 %. Still far over target and still the most important thing on the tab —
-- but a real finding rather than an artefact, and it is worth being able to tell
-- those apart.
--
-- Fixed in two places on purpose. `scripts/observe_coaching.ts` no longer writes
-- a delivery row for a generation that never attempted delivery; this view no
-- longer counts one if some other writer ever does. The metric should not depend
-- on every future writer remembering.

-- Remove the phantom rows already stored. Delivery rows are a derived
-- reconciliation, recomputed on every run — deleting them loses nothing that
-- observe-coaching cannot rebuild.
delete from suggestion_delivery d
using suggestions s
where s.id = d.suggestion_id
  and s.posted_at is null
  and s.posting_started_at is null;

-- "Attempted" = the outbox got as far as reserving the post (posting_started_at)
-- or completed it (posted_at). A live note that then failed IS a delivery
-- failure and still counts; a replay that never entered the outbox is not a
-- delivery at all.
create or replace view coaching_delivery_summary with (security_invoker = on) as
select
  count(*) filter (where att.attempted) as measured,
  count(*) filter (where att.attempted and d.delivery_status = 'in_time') as in_time,
  count(*) filter (where att.attempted and d.delivery_status = 'late') as late,
  count(*) filter (where att.attempted and d.delivery_status = 'no_reply_yet') as no_reply_yet,
  round(
    100.0 * count(*) filter (where att.attempted and d.delivery_status = 'late')::numeric
      / nullif(count(*) filter (where att.attempted and d.delivery_status in ('in_time', 'late')), 0)::numeric,
    1
  ) as late_pct,
  -- Kept visible rather than silently filtered: a reader who remembers a bigger
  -- number should be able to see where the difference went, and a sudden jump
  -- here means something started writing delivery rows it should not.
  count(*) filter (where not att.attempted) as never_delivered
from suggestion_delivery d
join lateral (
  select (s.posted_at is not null or s.posting_started_at is not null) as attempted
  from suggestions s where s.id = d.suggestion_id
) att on true;

comment on view coaching_delivery_summary is
  'Note timing over the notes we actually tried to deliver. Replay and dry-run generations never post by design and are excluded — counting them as "late" produced a phantom 88.1% late rate on the first real run (see never_delivered).';

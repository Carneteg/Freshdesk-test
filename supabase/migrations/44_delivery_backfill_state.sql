-- Migration 44 — a note generated after the agent already replied was never late.
--
-- WHY. Migration 43 removed the replay generations that were being scored as
-- late deliveries, taking the rate from a phantom 88.1 % to 69.4 %. Reading the
-- remaining 34 "late" rows one by one showed the 69.4 % was an artefact too, of
-- a second and subtler kind:
--
--   ALL 34 were generated AFTER the agent had already replied.
--
-- Gaps ran from a few hours to 316 days. Those are batch runs over tickets that
-- were answered long before the pipeline ever looked at them. The note did not
-- arrive too late; there was no deadline. Not one note was ever generated while
-- the agent had yet to reply and then lost the race.
--
-- So the true late count is ZERO, and always has been. Which is less impressive
-- than it sounds: the cron job `ticket-suggester-every-minute` is INACTIVE, so
-- no note has ever been delivered by the live scheduler. The metric has nothing
-- to measure yet — and saying that is more useful than printing 69.4 %.
--
-- THE DISCRIMINATOR IS A FACT, NOT A THRESHOLD. Either the generation started
-- before the agent replied or it did not. No window to tune, and no way to make
-- the number look better by widening it — which matters, because that is exactly
-- the temptation when a metric reads badly.
--
--   in_time       note posted before the first agent reply
--   late          we were in the race and the note landed after it (or never)
--   backfill      generated after the reply — no race, not a delivery failure
--   no_reply_yet  the agent has not replied, so there is nothing to judge

alter table suggestion_delivery
  drop constraint if exists suggestion_delivery_delivery_status_check;
alter table suggestion_delivery
  add constraint suggestion_delivery_delivery_status_check
    check (delivery_status in ('in_time', 'late', 'no_reply_yet', 'backfill'));

comment on column suggestion_delivery.delivery_status is
  'in_time | late | backfill | no_reply_yet. backfill = the generation was created after the agent had already replied, so it was never racing a deadline. Only in_time and late belong in the late rate.';

-- Reclassify what is already stored. observe-coaching rebuilds these on every
-- run, but leaving 34 rows reading "late" until the next run would be leaving a
-- wrong number on the tab.
update suggestion_delivery d
set delivery_status = 'backfill'
from suggestions s
where s.id = d.suggestion_id
  and d.delivery_status in ('late', 'in_time')
  and d.first_agent_reply_at is not null
  and s.created_at > d.first_agent_reply_at;

-- A new column cannot be inserted mid-list by CREATE OR REPLACE; no other view
-- depends on this one, so a plain (non-cascade) drop is safe and would error
-- rather than silently take something with it.
drop view if exists coaching_delivery_summary;

create view coaching_delivery_summary with (security_invoker = on) as
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
  -- Both exclusions stay visible rather than being silently filtered. A reader
  -- who remembers a bigger number should be able to see where it went, and a
  -- jump in either column means something is writing rows it should not.
  count(*) filter (where att.attempted and d.delivery_status = 'backfill') as backfill,
  count(*) filter (where not att.attempted) as never_delivered
from suggestion_delivery d
join lateral (
  select (s.posted_at is not null or s.posting_started_at is not null) as attempted
  from suggestions s where s.id = d.suggestion_id
) att on true;

grant select on coaching_delivery_summary to authenticated;

comment on view coaching_delivery_summary is
  'Note timing over notes we actually tried to deliver AND that were racing a deadline. Replay generations (never_delivered) and post-reply generations (backfill) are excluded and counted separately - together they accounted for the entire 88.1% late rate reported on the first real run.';

-- coaching_failed_advice needs NO change: it selects on delivery_status = 'late',
-- and a backfill is no longer 'late', so those rows drop out on their own. Left
-- alone deliberately — rewriting it here would have meant restating its column
-- list, and the app reads columns (ticket_url, verdict_reasons, critical_flag)
-- that a hasty rewrite drops.

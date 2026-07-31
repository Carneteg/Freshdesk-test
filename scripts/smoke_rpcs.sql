-- RPC smoke test — run with SERVICE-ROLE credentials (psql or the Supabase MCP).
-- Exercises every callable function in public with its REAL guards, records a
-- PASS/FAIL matrix, and cleans up every trace inside the same transaction —
-- a failure rolls everything back, so it is safe to run against the live
-- project. First run: 2026-07-31, all green (see PR #36).
--
-- Techniques worth knowing:
--   * Reviewer guards are exercised for real by simulating an authenticated
--     JWT (set_config('request.jwt.claims', …)) plus a TEMPORARY allowlist row —
--     no function is cloned or modified.
--   * Expected-failure cases run inside DO blocks with exception handlers, so
--     a raised error is recorded as PASS without aborting the script.
--   * PL/pgSQL parses statements lazily: a function can CREATE fine and still
--     blow up at first execution (see migration 36). Only execution proves.
--   * protect_generation_payload freezes payload columns once delivery_status
--     reaches 'generated' — synthetic rows must be INSERTed with their final
--     payload (e.g. feedback_token), exactly like production does.
--
-- Sacrificial data: one real generation row (SET the id below), plus synthetic
-- ticket ids 999999901/999999902 and 'smoke-*' stream/lease names.

\set probe_generation_id 634

begin;

create temp table _smoke(seq serial, step text, result text);

-- ═══ Batch 1 — reviewer RPCs (real guards) ══════════════════════════════════
delete from app_reviewers where email = 'probe@test.local';
insert into app_reviewers(email, name, active) values ('probe@test.local', 'SMOKE PROBE', true);
select set_config('request.jwt.claims', '{"email":"probe@test.local","role":"authenticated"}', false);

insert into _smoke(step, result) select 'is_reviewer (allowlisted+jwt)', is_reviewer()::text;

insert into _smoke(step, result)
select 'submit_verdict (new, v0)', 'verdict=' || verdict || ' ver=' || review_version || ' by=' || reviewer_email
from submit_generation_verdict(:probe_generation_id, 0, 'usable');

insert into _smoke(step, result)
select 'submit_verdict (edit, v1)', 'verdict=' || verdict || ' ver=' || review_version
from submit_generation_verdict(:probe_generation_id, 1, 'edited', '["tone"]'::jsonb, null);

do $do$ begin
  perform * from submit_generation_verdict(634, 99, 'usable');
  insert into _smoke(step, result) values ('optimistic lock (wrong ver)', 'FAIL: no exception');
exception when others then
  insert into _smoke(step, result) values ('optimistic lock (wrong ver)', 'PASS raised: ' || sqlerrm);
end $do$;

insert into _smoke(step, result)
select 'save_gold_answer', 'gold=' || gold_answer || ' by=' || reviewer_email || ' ver=' || review_version
from save_generation_gold_answer(:probe_generation_id, 'SMOKE-GOLD');

insert into _smoke(step, result)
select 'mark_spam', 'ticket=' || ticket_id || ' by=' || reviewer_email
from mark_generation_spam(:probe_generation_id);

insert into _smoke(step, result)
select 'projection -> suggestions', 'verdict=' || coalesce(verdict,'-') || ' vby=' || coalesce(verdict_by,'-')
  || ' gold=' || coalesce(gold_answer,'-') || ' spam=' || is_spam || ' rv=' || review_version
from suggestions where id = :probe_generation_id;

update app_reviewers set active = false where email = 'probe@test.local';
insert into _smoke(step, result) select 'is_reviewer (deactivated)', is_reviewer()::text;
do $do$ begin
  perform * from submit_generation_verdict(634, 2, 'usable');
  insert into _smoke(step, result) values ('guard (deactivated)', 'FAIL: no exception');
exception when others then
  insert into _smoke(step, result) values ('guard (deactivated)', 'PASS raised: ' || sqlerrm);
end $do$;

-- batch 1 cleanup (clear the JWT first so stamp triggers write nulls)
select set_config('request.jwt.claims', '', false);
delete from suggestion_reviews where reviewer_email = 'probe@test.local';
update suggestions set verdict = null, verdict_reasons = '[]'::jsonb, critical_flag = null,
  gold_answer = null, review_version = 0, is_spam = false
where id = :probe_generation_id;
update suggestions set verdict_at = null, verdict_by = null, gold_answer_at = null, gold_answer_by = null
where id = :probe_generation_id;
update suggestions set is_spam = false
where ticket_id = (select ticket_id from suggestions where id = :probe_generation_id);
delete from app_reviewers where email = 'probe@test.local';

-- ═══ Batch 2 — poll leases, reserve state machine, queue, retrieval, guard ══
insert into _smoke(step, result)
select 'lease acquire (fresh)', acquire_poll_lease('smoke-lease', '11111111-1111-1111-1111-111111111111'::uuid, 60)::text;
insert into _smoke(step, result)
select 'lease acquire (contended)', coalesce(acquire_poll_lease('smoke-lease', '22222222-2222-2222-2222-222222222222'::uuid, 60)::text, 'null (falsy: OK for caller)');
insert into _smoke(step, result)
select 'lease release (wrong token)', coalesce(release_poll_lease('smoke-lease', '22222222-2222-2222-2222-222222222222'::uuid)::text, 'null (falsy: OK for caller)');
insert into _smoke(step, result)
select 'lease release (right token)', release_poll_lease('smoke-lease', '11111111-1111-1111-1111-111111111111'::uuid)::text;

insert into _smoke(step, result)
select 'reserve (new)', 'action=' || action from reserve_generation(
  999999901, 'smoke:1', 'SMOKE', 'smoke-v0', 'gpt-4o', 'smoke-test', '33333333-3333-3333-3333-333333333333'::uuid, 60);
insert into _smoke(step, result)
select 'reserve (held lease)', 'action=' || action from reserve_generation(
  999999901, 'smoke:1', 'SMOKE', 'smoke-v0', 'gpt-4o', 'smoke-test', '44444444-4444-4444-4444-444444444444'::uuid, 60);
update suggestions set reservation_expires_at = now() - interval '1 minute'
  where ticket_id = 999999901 and run_variant = 'smoke-test';
insert into _smoke(step, result)
select 'reserve (expired lease)', 'action=' || action from reserve_generation(
  999999901, 'smoke:1', 'SMOKE', 'smoke-v0', 'gpt-4o', 'smoke-test', '55555555-5555-5555-5555-555555555555'::uuid, 60);
update suggestions set delivery_status = 'generated', note_html = '<p>SMOKE</p>'
  where ticket_id = 999999901 and run_variant = 'smoke-test';
insert into _smoke(step, result)
select 'reserve (generated+note)', 'action=' || action from reserve_generation(
  999999901, 'smoke:1', 'SMOKE', 'smoke-v0', 'gpt-4o', 'smoke-test', '66666666-6666-6666-6666-666666666666'::uuid, 60);
update suggestions set delivery_status = 'posted'
  where ticket_id = 999999901 and run_variant = 'smoke-test';
insert into _smoke(step, result)
select 'reserve (posted)', 'action=' || action from reserve_generation(
  999999901, 'smoke:1', 'SMOKE', 'smoke-v0', 'gpt-4o', 'smoke-test', '77777777-7777-7777-7777-777777777777'::uuid, 60);

insert into _smoke(step, result)
select 'enqueue (new)', 'queued=' || enqueue_ticket_updates(
  'smoke-stream',
  '[{"ticket_id":999999901,"ticket_updated_at":"2026-07-30T00:00:00Z","subject":"SMOKE","responder_id":1}]'::jsonb,
  '2026-07-30T00:00:00Z'::timestamptz, 999999901);
insert into _smoke(step, result)
select 'enqueue (dedup)', 'queued=' || enqueue_ticket_updates(
  'smoke-stream',
  '[{"ticket_id":999999901,"ticket_updated_at":"2026-07-30T00:00:00Z","subject":"SMOKE","responder_id":1}]'::jsonb,
  '2026-07-30T00:00:00Z'::timestamptz, 999999901);
insert into _smoke(step, result)
select 'cursor advanced', 'last_ticket=' || last_ticket_id from poll_cursors where stream_name = 'smoke-stream';

insert into _smoke(step, result)
select 'match_past_tickets (self)', 'rows=' || count(*) || ' top_sim=' || round(max(similarity)::numeric, 2)
from match_past_tickets((select embedding from past_tickets limit 1), 3, 0.0, null, null);

do $do$ begin
  update suggestions set draft = 'SMOKE-MUTATION' where id = 600;
  insert into _smoke(step, result) values ('protect_generation_payload', 'FAIL: mutation allowed');
exception when others then
  insert into _smoke(step, result) values ('protect_generation_payload', 'PASS raised: ' || sqlerrm);
end $do$;

delete from suggestions where ticket_id = 999999901;
delete from ticket_poll_queue where stream_name = 'smoke-stream';
delete from poll_cursors where stream_name = 'smoke-stream';
delete from poll_leases where lease_name = 'smoke-lease';

-- ═══ Batch 3 — legacy one-shot feedback token ═══════════════════════════════
-- The payload guard freezes feedback_token after 'generated', so the token is
-- INSERTed with the synthetic row, exactly as production writes it.
insert into suggestions (ticket_id, trigger_message_id, subject, confidence, prompt_version, model,
  run_variant, delivery_status, feedback_token, feedback_token_expires_at)
values (999999902, 'smoke:legacy', 'SMOKE-LEGACY', 'none', 'smoke-v0', 'gpt-4o',
  'smoke-test', 'generated', 'smoke-token-xyz', now() + interval '1 hour');

insert into _smoke(step, result)
select 'legacy feedback (valid token)', 'ticket=' || record_legacy_feedback('smoke-token-xyz', 'usable');
do $do$ begin
  perform record_legacy_feedback('smoke-token-xyz', 'usable');
  insert into _smoke(step, result) values ('legacy token reuse', 'FAIL: accepted twice');
exception when others then
  insert into _smoke(step, result) values ('legacy token reuse', 'PASS raised: ' || sqlerrm);
end $do$;
do $do$ begin
  perform record_legacy_feedback('no-such-token', 'usable');
  insert into _smoke(step, result) values ('legacy unknown token', 'FAIL: accepted');
exception when others then
  insert into _smoke(step, result) values ('legacy unknown token', 'PASS raised: ' || sqlerrm);
end $do$;
do $do$ begin
  perform record_legacy_feedback('smoke-token-xyz', 'nonsense-verdict');
  insert into _smoke(step, result) values ('legacy invalid verdict', 'FAIL: accepted');
exception when others then
  insert into _smoke(step, result) values ('legacy invalid verdict', 'PASS raised: ' || sqlerrm);
end $do$;

delete from suggestion_reviews where generation_id in (select id from suggestions where ticket_id = 999999902);
delete from suggestions where ticket_id = 999999902;

insert into _smoke(step, result)
select 'cleanup check', 'probe rows left='
  || (select count(*) from suggestions where ticket_id in (999999901, 999999902))
  + (select count(*) from suggestion_reviews where reviewer_email in ('probe@test.local'))
  + (select count(*) from app_reviewers where email = 'probe@test.local')
  + (select count(*) from poll_leases where lease_name = 'smoke-lease');

select step, result from _smoke order by seq;

commit;

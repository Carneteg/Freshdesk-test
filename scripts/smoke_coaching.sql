-- Repeatable security smoke test for the Coaching tab (migration 42).
--
-- Run it in the Supabase SQL editor after any change to the coaching tables,
-- their grants, or their policies. It proves the four properties the tab's whole
-- design rests on, by EXECUTING them rather than by reading the migration:
--
--   1. an allowlisted reviewer can read
--   2. a non-allowlisted signed-in user sees nothing
--   3. a logged-out (anon) caller is refused outright
--   4. NOBODY can write — follow-through is observed, never self-reported
--
-- It raises on the first failure and prints one PASS line otherwise. Nothing is
-- inserted or left behind.

do $$
declare n int;
begin
  ---------------------------------------------------------------- 1. reviewer
  perform set_config('request.jwt.claims',
    '{"email":"tobias.carneteg@gmail.com","role":"authenticated"}', true);
  set local role authenticated;

  select count(*) into n from suggestion_next_steps;
  if n = 0 then raise exception 'FAIL: reviewer cannot read suggestion_next_steps'; end if;
  select count(*) into n from coaching_baselines;
  if n = 0 then raise exception 'FAIL: reviewer cannot read coaching_baselines'; end if;
  perform 1 from coaching_next_steps limit 1;
  perform 1 from coaching_delivery_summary;
  perform 1 from coaching_step_mix limit 1;
  perform 1 from coaching_value_pairing limit 1;
  perform 1 from coaching_knowledge_produced;

  ------------------------------------------------- 4. nobody writes (as reviewer)
  begin
    insert into next_step_observations (next_step_id, observed, observable)
      values (1, true, true);
    raise exception 'FAIL: authenticated could INSERT an observation';
  exception when insufficient_privilege then null;
  end;
  begin
    update next_step_observations set observed = true;
    raise exception 'FAIL: authenticated could UPDATE an observation';
  exception when insufficient_privilege then null;
  end;
  begin
    update suggestion_next_steps set step_type = 'route_expert';
    raise exception 'FAIL: authenticated could UPDATE a classified step';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from suggestion_delivery;
    raise exception 'FAIL: authenticated could DELETE delivery rows';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into coaching_baselines (metric_key, value, unit, label, source_note, computed_at)
      values ('smoke', 1, '%', 'smoke', 'smoke', now());
    raise exception 'FAIL: authenticated could WRITE a baseline';
  exception when insufficient_privilege then null;
  end;
  reset role;

  ------------------------------------------------------------ 2. non-reviewer
  perform set_config('request.jwt.claims',
    '{"email":"stranger@example.com","role":"authenticated"}', true);
  set local role authenticated;
  select count(*) into n from suggestion_next_steps;
  if n <> 0 then raise exception 'FAIL: non-reviewer read % step rows', n; end if;
  select count(*) into n from coaching_baselines;
  if n <> 0 then raise exception 'FAIL: non-reviewer read % baselines', n; end if;
  reset role;

  ------------------------------------------------------------------- 3. anon
  set local role anon;
  begin
    select count(*) into n from suggestion_next_steps;
    raise exception 'FAIL: anon could read suggestion_next_steps';
  exception when insufficient_privilege then null;
  end;
  reset role;
end $$;

select 'PASS: reviewer reads · non-reviewer sees nothing · anon refused · nobody writes'
  as coaching_smoke_result;

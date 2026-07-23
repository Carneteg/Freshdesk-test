-- Gate 1 evaluation — run each statement via the Supabase MCP execute_sql.
-- Project: pqwnpcibymtmcpnqlkle.

-- 1. Headline: "would I have sent this?" usable-% per prompt version.
--    Only rows where judged > 0 mean anything.
select prompt_version, generated, judged, usable, edited, unusable, usable_pct
from gate1_scorecard
order by prompt_version;

-- 2. Calibration: the (high, unusable) cell is confident nonsense — must be ~0.
select * from calibration;

-- 3. Usage: did the agent use the draft? (secondary signal, auto-derived.)
select * from usage_scorecard;

-- 4. Failures: any row is a crashed run that must be visible.
select * from failures;

-- Optional: how many verdicts have been recorded on the CURRENT prompt version.
select prompt_version, count(*) filter (where verdict is not null) as judged, count(*) as generated
from suggestions
where error is null
group by prompt_version
order by prompt_version desc;

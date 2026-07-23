---
name: gate1-scorecard
description: Produce the Gate 1 evaluation report — the "would I have sent this?" usable-percentage plus calibration, usage and failures. Use when the user asks how the experiment is going, for the scorecard/verdicts, or whether Gate 1 clears the >50% bar.
---

# Gate 1 scorecard report

Turns the four evaluation views into an honest read of the experiment.

## When to use
- "How is Gate 1 going / what's the scorecard / usable %?"
- Before deciding whether to proceed to Gate 2.
- After a prompt change, to compare versions.

## Steps
1. Run the queries in `queries.sql` via the **Supabase MCP** `execute_sql`
   (project `pqwnpcibymtmcpnqlkle`). Run them one statement at a time.
2. **gate1_scorecard** — the headline. Report `usable_pct` for the *current*
   `prompt_version`, and `judged` of `generated`. Rows with `judged = 0` (or old
   prompt versions) are not meaningful — say so; don't average them in.
3. **calibration** — check the `confidence='high' AND verdict='unusable'` cell.
   Non-zero = confident nonsense (the only genuinely dangerous output). Flag it.
4. **usage_scorecard** — used/partly/not + coverage, as a secondary signal.
5. **failures** — any rows are crashed runs; surface the ticket ids.

## Report honestly
- Only report numbers the query returns — **never invent or estimate**.
- A low `usable_pct` on a tiny or old sample is **not** the real number. The real
  signal is judged verdicts on the current prompt version; if too few are judged,
  say the sample isn't large enough yet.
- Never print ticket bodies or customer PII.

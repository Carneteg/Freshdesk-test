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
6. **gate1_scorecard_by_cohort** — the number that actually gates Gate 1 is the
   **`holdout`** row (the locked, leak-free eval set). Report holdout `usable_pct`
   on its own; `learning`/`development` are for iteration, not the verdict.
7. **coach_mode_scorecard** — verdict distribution per mode. Check that
   `REPLY_READY` skews *usable* clearly more than `COACH_AGENT`; if not, the mode
   gate is miscalibrated. Say so.
8. **knowledge_gaps** — the top undocumented topics (why the coach couldn't ground
   an answer). Surface the top few as "what to write", not as a grade of the AI.

## Report honestly
- Only report numbers the query returns — **never invent or estimate**.
- A low `usable_pct` on a tiny or old sample is **not** the real number. The real
  signal is judged verdicts on the current prompt version; if too few are judged,
  say the sample isn't large enough yet.
- Never print ticket bodies or customer PII.

---
name: incident-playbook
description: Add a new incident to, or verify/tighten an existing incident in, the known_incidents playbook — the curated operational knowledge the coach grounds on. Use when the team wants to capture a known issue/routing/fix, or check that an incident fires only when it should.
---

# Add or verify a known incident

The `known_incidents` playbook **outranks generic KB**, so precision matters: an
over-broad incident makes the coach confidently wrong. This skill adds one or
checks/tightens one, via the **Supabase MCP** (`execute_sql`, project
`pqwnpcibymtmcpnqlkle`).

## When to use
- "Add a known incident / capture this fix / routing rule."
- "This incident is over-matching / check incident N."
- After a replay miss where the agent clearly knew something the AI didn't.

## Columns (`known_incidents`)
`title`, `symptoms` (how customers describe it — the match signal), `resolution`
(what to actually do), `routing`, `status` (`identified|investigating|fixed|closed`),
`affected` (scope / what it does NOT apply to), `workaround`, `customer_action`,
`fix_released_at` (date), `post_fix_instructions`, `active`.

## Add an incident
1. Draft the row. Minimum: `title`, `symptoms`, `resolution`, `status`.
   - For a **fixed** incident also fill `fix_released_at`, `customer_action`
     (how the customer activates the fix), and `post_fix_instructions` (which
     records auto-corrected vs. which historical ones the customer must fix by hand).
   - Bound it in `affected` so it only fires when it should (e.g. "does NOT apply
     when there is a concrete error message — read the error first").
2. **Show the exact `INSERT` to the user for approval** before applying — operational
   facts (fix dates, which records auto-fix) must be team-confirmed, never invented.
3. Apply via `execute_sql`, `returning id, title, status`.

## Verify / tighten an incident
1. `select * from known_incidents where id = <n>;`
2. Check: do the `symptoms` match how customers actually phrase it? Does `affected`
   keep it from firing on adjacent-but-different cases? Is `status`/`customer_action`
   current? For fixed incidents, are `fix_released_at` + `post_fix_instructions` set?
3. If it over-matches, tighten `symptoms`/`affected` with a scoped `update`.

The playbook is loaded live by the poller and the replay harness — changes take
effect on the next run, no redeploy.

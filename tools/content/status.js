// tools/content/status.js — DATA ONLY.
// Gate 1 status: what is built, what is not, how it can develop.
// Rendered to Word / PowerPoint / HTML by tools/render.js. Edit the wording here;
// never put content in the renderer.

module.exports = {
  title: "AI Suggested Replies for Freshdesk — Gate 1",
  subtitle: "Status: what is built, what is not, and how it can develop",
  intro:
    "A background job watches a small, named set of support agents' Freshdesk tickets and, when one is assigned or a customer replies, posts a private note that coaches the agent: what is verified, what to check or route, and a customer-ready draft only when it is genuinely grounded. The agent judges each note with one click. It is a two-week experiment — small agent set, private notes only.",
  sections: [
    {
      heading: "What is built",
      items: [
        { lead: "Live scheduler. ", text: "Supabase Edge Function polled every minute by pg_cron; deployed and posting. A DRY_RUN flag pauses posting while it keeps logging." },
        { lead: "Monitored-agent safety. ", text: "Acts only on tickets whose responder is one of the configured agents. Two independent filters (poll filter + a re-check of the reloaded ticket) enforce it; a colleague's ticket is never touched." },
        { lead: "Three-step reasoning. ", text: "analyse then retrieve then draft then verify (OpenAI gpt-4o). Verify only lowers confidence; it never invents text." },
        { lead: "Coach framing. ", text: "States what is verified, proposes concrete checks/next steps, routes correctly, and drafts a customer reply only when grounded — otherwise it abstains." },
        { lead: "Knowledge layer. ", text: "Stage 1: a curated known-incidents playbook with lifecycle (status, fix-released, post-fix instructions). Stage 2: a semantic index of resolved tickets that finds similar cases and cites them as clickable links." },
        { lead: "Deterministic safety gates. ", text: "Blocking rule for irreversible/sensitive actions; error-message-first; reply must match the analysis; every required customer step must appear in the reply; no false system-access claims." },
        { lead: "Evaluation + feedback. ", text: "Replay with exact dialogue-turn sync and no answer leakage; gate1_scorecard views; one-click verdict links on every note that fill the scorecard automatically." },
      ],
    },
    {
      heading: "What is not built (deliberately deferred)",
      items: [
        { lead: "Real-time concurrent-ticket awareness. ", text: "The AI sees similar resolved tickets, not what is happening across the queue right now. Design note exists; not built." },
        { lead: "Learning loop. ", text: "Verdicts are collected, but the model does not yet learn from them. Gate 2." },
        { lead: "Auto-refreshing precedent index. ", text: "The resolved-ticket index is a manual snapshot; new resolutions appear only after a re-sync." },
        { lead: "Broad multi-agent rollout. ", text: "Only a small named set is watched; wider rollout needs works-council and quality sign-off." },
        { lead: "Other data sources. ", text: "No Confluence, Jira, Planhat, Slack, Productboard/Linear — Freshdesk KB and past tickets only." },
        { lead: "UI, auth, dashboards, alerting. ", text: "Out of Gate 1 scope." },
      ],
    },
    {
      heading: "How it can be developed",
      items: [
        { lead: "Grow the incident playbook. ", text: "The largest quality lever — the agents' operational knowledge is what separates a good coach from a generic one." },
        { lead: "Real-time concurrent awareness. ", text: "Index recent/open tickets and surface emerging-incident signals (design note ready)." },
        { lead: "Scheduled re-sync. ", text: "Automate the resolved-ticket index refresh so precedent stays current." },
        { lead: "Learning loop (Gate 2). ", text: "Use the collected verdicts to tune generation toward the replies agents accept." },
        { lead: "Widen the agent set + add sources. ", text: "Extend to more agents once the bar is cleared; add Jira / Confluence / Planhat behind the same grounding rules." },
      ],
    },
  ],
  closing:
    "In short: the mechanism is complete and live for a small agent set; the next gains are knowledge (more curated incidents, real-time incident awareness) and a Gate 2 learning loop — not more prompt tuning.",
};

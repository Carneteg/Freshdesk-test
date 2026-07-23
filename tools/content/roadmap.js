// tools/content/roadmap.js — DATA ONLY.
// Gate 2+ development roadmap (data-source expansion). Mirrors docs/roadmap.md.
// Rendered to Word / PowerPoint / HTML by tools/render.js.

module.exports = {
  title: "Freshdesk AI Coach — Development Roadmap",
  subtitle: "From a live Gate 1 to a multi-source coach (Gate 2+)",
  intro:
    "Guiding principle: prove Gate 1 first, then add one data source at a time — measuring the impact of each before the next. Every source needs its own API access + DPA review (weeks of calendar time each).",
  sections: [
    {
      heading: "Guiding principles",
      items: [
        { lead: "Gate 1 first. ", text: "Do not integrate anything until gate1_scorecard clears the >50% bar." },
        { lead: "One source at a time. ", text: "Each source adds grounding and noise; measure the scorecard delta before the next." },
        { lead: "Requests in parallel, builds sequential. ", text: "Start access + DPA requests early even though you build one source at a time." },
        { lead: "Unified retrieval. ", text: "All sources use the same source-tagged grounding + hyperlinked citations as KB and past tickets." },
        { lead: "Writes stay minimal. ", text: "Only the private note + keyword tags are ever written; everything new is read-only." },
      ],
    },
    {
      heading: "Phase 0 — Close Gate 1 (measure, build nothing)",
      items: [
        { text: "Collect ~50 agent verdicts, read gate1_scorecard, decide." },
        { lead: "Why: ", text: "the whole point of Gate 1 — a green light (or a stop) before weeks on integrations." },
      ],
    },
    {
      heading: "Phase 1 — Jira (live incidents) · biggest impact",
      items: [
        { text: "Read-only feed of open/known incidents, matched to tickets by symptom." },
        { lead: "Why: ", text: "the biggest gap — the agent's edge is live incident knowledge. Replaces the manual playbook with a live feed." },
        { lead: "Effort/Risk: ", text: "M / low-medium (read-only, less PII-sensitive)." },
      ],
    },
    {
      heading: "Phase 2 — Confluence (internal knowledge)",
      items: [
        { text: "Index relevant spaces (embeddings) and retrieve like the KB." },
        { lead: "Why: ", text: "the written internal know-how the thin Freshdesk KB lacks — lifts how-to accuracy." },
        { lead: "Effort/Risk: ", text: "M / low-medium (scope the spaces)." },
      ],
    },
    {
      heading: "Parallel track — Learning loop (Gate 2 core)",
      items: [
        { text: "Tune / fine-tune generation on the collected verdicts." },
        { lead: "Why: ", text: "the corpus is already being collected; the model starts learning from accepted replies. Needs no external source." },
      ],
    },
    {
      heading: "Phase 3 — Planhat (customer context)",
      items: [
        { text: "Read-only account, tier and relationship injected into the analysis." },
        { lead: "Why: ", text: "better routing + the deletion/sensitive-action safety check (verify relationship/authority)." },
        { lead: "Effort/Risk: ", text: "M / high (customer PII — needs a proper DPA review). Sequenced after Jira/Confluence." },
      ],
    },
    {
      heading: "Phase 4 — Slack + Productboard / Linear (last, incremental)",
      items: [
        { lead: "Slack: ", text: "recent product news as freshness context — lower, noisier signal." },
        { lead: "Productboard / Linear: ", text: "check if a requested feature is already logged/planned; route and set expectations." },
        { lead: "Effort/Risk: ", text: "S-M each / low." },
      ],
    },
    {
      heading: "Each source → the gap it fills",
      items: [
        { lead: "Jira — ", text: "live & known incidents (the agent's #1 edge)." },
        { lead: "Confluence — ", text: "written internal know-how the KB lacks." },
        { lead: "Planhat — ", text: "customer identity & relationship (routing + safety)." },
        { lead: "Slack — ", text: "recent product changes (freshness)." },
        { lead: "Productboard / Linear — ", text: "feature-request routing & expectations." },
      ],
    },
  ],
  closing:
    "Recommended order: Gate 1 measurement → Jira → Confluence → (learning loop in parallel) → Planhat → Slack / Productboard / Linear.",
};

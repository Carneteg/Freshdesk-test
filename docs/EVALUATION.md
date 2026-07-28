# Evaluation

## Immutable evidence

Replay uses `INSERT`, never `UPSERT`. A judged generation is never replaced by a
new prompt, model, retrieval configuration, or tiering variant. Reviews reference
one generation ID.

## Cohorts

- `learning` — only cohort allowed as gold-answer exemplars.
- `development` — prompt/tr threshold decisions.
- `holdout` — final measurement only; never an exemplar.

Replay previews the selected sample and stops before OpenAI. Rerun with
`REPLAY_APPROVED=true` only after approving the IDs/subjects.

## Primary metrics

- Reply-ready precision: usable / judged for `REPLY_READY`.
- False-green rate: unusable / judged for `REPLY_READY`.
- Abstention accuracy: correct abstentions on cases requiring agent judgement.
- Critical error rate: legal, deletion, access, PII, false promise, invented feature.
- Agent utility: usable next steps and time saved.
- Knowledge-gap yield: actionable missing documentation.

The old overall `>50% usable` figure is insufficient on its own. Critical errors
should be effectively zero. Read cohort and coach-mode views separately.

## Learning-loop hygiene

Gold answers are style/work-method examples, never factual sources. The current
implementation:

- learns only from the locked learning cohort;
- excludes the current ticket;
- selects at most four examples in the same language;
- keeps development and holdout out of the prompt.

Semantic/topic/product-area relevance remains a follow-up before scaling the loop.

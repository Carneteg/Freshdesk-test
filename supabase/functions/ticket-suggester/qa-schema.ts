export const QA_ASSESSMENT_JSON_SCHEMA = {
  name: "simployer_qa_assessment",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["ticketSummary", "assumptionsOrMissingContext", "scorecard", "totalScore", "verdict", "needsHumanReview", "topThreeImprovements", "recommendedReply"],
    properties: {
      ticketSummary: { type: "string" },
      assumptionsOrMissingContext: { type: "array", items: { type: "string" } },
      scorecard: {
        type: "array", minItems: 7, maxItems: 7,
        items: {
          type: "object", additionalProperties: false,
          required: ["criterionId", "criterion", "score", "weightedPoints", "rationale", "improvementSuggestion"],
          properties: {
            criterionId: { type: "string", enum: ["tone", "accuracy", "clarity", "empathy", "resolution_intent", "efficiency", "follow_through_signal"] },
            criterion: { type: "string", enum: ["Tone", "Accuracy", "Clarity", "Empathy", "Resolution intent", "Efficiency", "Follow-through signal"] },
            score: { type: "integer", minimum: 1, maximum: 5 },
            weightedPoints: { type: "number", minimum: 0, maximum: 20 },
            rationale: { type: "string" },
            improvementSuggestion: { type: "string" },
          },
        },
      },
      totalScore: { type: "integer", minimum: 0, maximum: 100 },
      verdict: { type: "string", enum: ["Excellent", "Good", "Acceptable", "Needs review"] },
      needsHumanReview: { type: "boolean" },
      topThreeImprovements: { type: "array", maxItems: 3, items: { type: "string" } },
      recommendedReply: { type: "string" },
    },
  },
} as const;

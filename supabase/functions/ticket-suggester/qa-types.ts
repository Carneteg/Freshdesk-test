export type QaCriterionId =
  | "tone"
  | "accuracy"
  | "clarity"
  | "empathy"
  | "resolution_intent"
  | "efficiency"
  | "follow_through_signal";

export type QaVerdict = "Excellent" | "Good" | "Acceptable" | "Needs review";

export interface QaCriterionDefinition {
  id: QaCriterionId;
  name: string;
  weight: number;
  description: string;
}

export interface QaAssessmentInput {
  customerMessage: string;
  ticketContext: string;
  agentReply: string;
  requirements?: string;
  languageOverride?: string;
}

export interface QaCriterionAssessment {
  criterionId: QaCriterionId;
  criterion: string;
  score: 1 | 2 | 3 | 4 | 5;
  weightedPoints: number;
  rationale: string;
  improvementSuggestion: string;
}

export interface QaAssessment {
  ticketSummary: string;
  assumptionsOrMissingContext: string[];
  scorecard: QaCriterionAssessment[];
  totalScore: number;
  verdict: QaVerdict;
  needsHumanReview: boolean;
  topThreeImprovements: string[];
  recommendedReply: string;
}

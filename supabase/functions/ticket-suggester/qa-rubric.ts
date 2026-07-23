import type { QaCriterionDefinition, QaCriterionId, QaVerdict } from "./qa-types.ts";

export const QA_CRITERIA: readonly QaCriterionDefinition[] = [
  { id: "tone", name: "Tone", weight: 15, description: "Professional, confident and adapted to the customer's emotional situation." },
  { id: "accuracy", name: "Accuracy", weight: 20, description: "Correct and complete based only on supplied context. Missing context must be marked as not verifiable." },
  { id: "clarity", name: "Clarity", weight: 15, description: "Easy to understand, logically structured and free from unnecessary jargon." },
  { id: "empathy", name: "Empathy", weight: 15, description: "Acknowledges the customer's situation when relevant, without exaggeration." },
  { id: "resolution_intent", name: "Resolution intent", weight: 15, description: "Provides a clear solution or next step, with ownership and timeline when relevant and known." },
  { id: "efficiency", name: "Efficiency", weight: 10, description: "Appropriately concise, without repetition or filler." },
  { id: "follow_through_signal", name: "Follow-through signal", weight: 10, description: "Makes it clear who will do what next." },
] as const;

export const QA_TOTAL_WEIGHT = QA_CRITERIA.reduce((sum, c) => sum + c.weight, 0);
if (QA_TOTAL_WEIGHT !== 100) throw new Error(`QA weights must total 100, got ${QA_TOTAL_WEIGHT}.`);

export function getCriterionWeight(id: QaCriterionId): number {
  const criterion = QA_CRITERIA.find((item) => item.id === id);
  if (!criterion) throw new Error(`Unknown QA criterion: ${id}`);
  return criterion.weight;
}

export function calculateWeightedPoints(score: number, weight: number): number {
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    throw new Error(`Score must be an integer from 1 to 5, got ${score}.`);
  }
  return Math.round(((score / 5) * weight) * 10) / 10;
}

export function calculateTotalScore(scores: ReadonlyArray<{ criterionId: QaCriterionId; score: number }>): number {
  const total = scores.reduce((sum, item) => sum + calculateWeightedPoints(item.score, getCriterionWeight(item.criterionId)), 0);
  return Math.round(total);
}

export function determineVerdict(totalScore: number, accuracyScore: number): { verdict: QaVerdict; needsHumanReview: boolean } {
  if (accuracyScore <= 2) return { verdict: "Needs review", needsHumanReview: true };
  if (totalScore >= 90) return { verdict: "Excellent", needsHumanReview: false };
  if (totalScore >= 75) return { verdict: "Good", needsHumanReview: false };
  if (totalScore >= 60) return { verdict: "Acceptable", needsHumanReview: false };
  return { verdict: "Needs review", needsHumanReview: false };
}

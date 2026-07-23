import { calculateTotalScore, calculateWeightedPoints, determineVerdict, getCriterionWeight, QA_CRITERIA } from "./qa-rubric.ts";
import type { QaAssessment } from "./qa-types.ts";

export function validateAndNormalizeAssessment(assessment: QaAssessment): QaAssessment {
  if (assessment.scorecard.length !== QA_CRITERIA.length) throw new Error(`Expected ${QA_CRITERIA.length} scorecard items.`);

  const scorecard = QA_CRITERIA.map((criterion, index) => {
    const item = assessment.scorecard[index];
    if (item.criterionId !== criterion.id) throw new Error(`Criterion ${index + 1} must be ${criterion.id}.`);
    return { ...item, criterion: criterion.name, weightedPoints: calculateWeightedPoints(item.score, getCriterionWeight(item.criterionId)) };
  });

  const totalScore = calculateTotalScore(scorecard);
  const accuracyScore = scorecard.find((item) => item.criterionId === "accuracy")?.score;
  if (!accuracyScore) throw new Error("Accuracy score is missing.");
  const review = determineVerdict(totalScore, accuracyScore);

  return { ...assessment, scorecard, totalScore, verdict: review.verdict, needsHumanReview: review.needsHumanReview };
}

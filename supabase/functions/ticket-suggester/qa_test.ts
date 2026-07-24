// Unit tests for the QA Coach pure functions (CLAUDE.md §8 — cheap tests for the
// pure surface). The LLM call itself is exercised by replay, not here. These lock
// down the DETERMINISTIC core (weights, weighted points, verdict, the validator's
// recompute) and the prompt builder — the parts that must never drift.
//
// Adapted from the package's tests/qa-rubric.test.ts to use the repo's @std/assert
// (the shipped copy imports std over https; the rest of this repo uses jsr).

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  calculateTotalScore,
  calculateWeightedPoints,
  determineVerdict,
  QA_CRITERIA,
  QA_TOTAL_WEIGHT,
} from "./qa-rubric.ts";
import { validateAndNormalizeAssessment } from "./qa-validator.ts";
import { buildQaCoachUserPrompt, QA_COACH_SYSTEM_PROMPT } from "./qa-system-prompt.ts";
import { QA_ASSESSMENT_JSON_SCHEMA } from "./qa-schema.ts";
import type { QaAssessment } from "./qa-types.ts";

Deno.test("weights total 100", () => assertEquals(QA_TOTAL_WEIGHT, 100));

Deno.test("weighted points", () => {
  assertEquals(calculateWeightedPoints(5, 20), 20);
  assertEquals(calculateWeightedPoints(4, 15), 12);
  assertEquals(calculateWeightedPoints(3, 10), 6);
});

Deno.test("invalid score throws", () => {
  assertThrows(() => calculateWeightedPoints(0, 15));
  assertThrows(() => calculateWeightedPoints(6, 15));
});

Deno.test("perfect score totals 100", () => {
  assertEquals(
    calculateTotalScore(QA_CRITERIA.map((c) => ({ criterionId: c.id, score: 5 }))),
    100,
  );
});

Deno.test("accuracy 1-2 forces a human review verdict regardless of total", () => {
  assertEquals(determineVerdict(90, 2), { verdict: "Needs review", needsHumanReview: true });
  assertEquals(determineVerdict(100, 1), { verdict: "Needs review", needsHumanReview: true });
});

Deno.test("verdict buckets", () => {
  assertEquals(determineVerdict(92, 5).verdict, "Excellent");
  assertEquals(determineVerdict(80, 5).verdict, "Good");
  assertEquals(determineVerdict(65, 5).verdict, "Acceptable");
  assertEquals(determineVerdict(40, 5).verdict, "Needs review");
});

// A model reply with deliberately WRONG arithmetic — the validator must overwrite
// weightedPoints/totalScore/verdict/needsHumanReview from the raw scores, not trust
// the model's numbers.
Deno.test("validator recomputes math and ignores the model's arithmetic", () => {
  const raw: QaAssessment = {
    ticketSummary: "x",
    assumptionsOrMissingContext: [],
    scorecard: QA_CRITERIA.map((c) => ({
      criterionId: c.id,
      criterion: "WRONG NAME",
      score: (c.id === "accuracy" ? 2 : 5) as 1 | 2 | 3 | 4 | 5,
      weightedPoints: 999, // nonsense — must be overwritten
      rationale: "r",
      improvementSuggestion: "s",
    })),
    totalScore: 0, // nonsense — must be overwritten
    verdict: "Excellent", // nonsense — accuracy=2 must force "Needs review"
    needsHumanReview: false,
    topThreeImprovements: [],
    recommendedReply: "hi",
  };
  const out = validateAndNormalizeAssessment(raw);
  // accuracy weighted = 2/5*20 = 8; other six at 5 = 15+15+15+15+10+10 = 80 → 88
  assertEquals(out.totalScore, 88);
  assertEquals(out.verdict, "Needs review");
  assertEquals(out.needsHumanReview, true);
  assertEquals(out.scorecard[0].criterion, "Tone"); // canonical name restored
  assertEquals(out.scorecard[1].weightedPoints, 8); // accuracy recomputed
});

Deno.test("validator rejects a scorecard in the wrong order", () => {
  const raw = validAssessment();
  // swap the first two criteria
  [raw.scorecard[0], raw.scorecard[1]] = [raw.scorecard[1], raw.scorecard[0]];
  assertThrows(() => validateAndNormalizeAssessment(raw));
});

Deno.test("buildQaCoachUserPrompt falls back to 'Not provided.' for empty fields", () => {
  // customerMessage/ticketContext/agentReply required; requirements + languageOverride
  // empty here → 2 fallbacks (plus the 3 required ones passed as blank → 5 total).
  const out = buildQaCoachUserPrompt({ customerMessage: "", ticketContext: "", agentReply: "" });
  assertEquals(out.split("Not provided.").length - 1, 5);
});

Deno.test("buildQaCoachUserPrompt inserts values and keeps section order", () => {
  const out = buildQaCoachUserPrompt({
    customerMessage: "I can't log in.",
    ticketContext: "KB: reset via /login.",
    agentReply: "Try resetting your password.",
    requirements: "Answer in English.",
  });
  assert(out.includes("I can't log in."));
  assert(out.includes("KB: reset via /login."));
  assert(out.includes("Try resetting your password."));
  assert(out.includes("Answer in English."));
  assert(out.indexOf("CUSTOMER'S ORIGINAL MESSAGE") < out.indexOf("AGENT REPLY TO ASSESS"));
  assert(out.includes("Do not use knowledge outside supplied content"));
});

Deno.test("schema is strict with a 7-item scorecard carrying both id and name", () => {
  assertEquals(QA_ASSESSMENT_JSON_SCHEMA.strict, true);
  const card = QA_ASSESSMENT_JSON_SCHEMA.schema.properties.scorecard;
  assertEquals(card.minItems, 7);
  assertEquals(card.maxItems, 7);
  // The schema enums are readonly tuples (as const); compare as plain string arrays
  // so assertEquals doesn't infer the fixed-length tuple type for both sides.
  assertEquals<readonly string[]>(card.items.properties.criterionId.enum, QA_CRITERIA.map((c) => c.id));
  assertEquals<readonly string[]>(card.items.properties.criterion.enum, QA_CRITERIA.map((c) => c.name));
});

Deno.test("system prompt encodes the accuracy override and verdict buckets", () => {
  assert(QA_COACH_SYSTEM_PROMPT.includes("If Accuracy is 1 or 2"));
  for (const v of ["Excellent", "Good", "Acceptable", "Needs review"]) {
    assert(QA_COACH_SYSTEM_PROMPT.includes(v), `verdict ${v} missing from prompt`);
  }
});

function validAssessment(): QaAssessment {
  return {
    ticketSummary: "x",
    assumptionsOrMissingContext: [],
    scorecard: QA_CRITERIA.map((c) => ({
      criterionId: c.id,
      criterion: c.name,
      score: 4 as 1 | 2 | 3 | 4 | 5,
      weightedPoints: 0,
      rationale: "r",
      improvementSuggestion: "s",
    })),
    totalScore: 0,
    verdict: "Good",
    needsHumanReview: false,
    topThreeImprovements: [],
    recommendedReply: "hi",
  };
}

import type { Cuisine, MealType } from "./types";

export type ClassificationSource = "correction" | "jev" | "regex";

export interface RecipeClassificationDetail {
  videoId: string;
  title: string;
  channelName: string;
  regex: { mealTypes: MealType[]; cuisine: Cuisine | null };
  /** Jev's raw probabilities, present when Jev answered (fresh or cached). */
  jev: {
    meal?: Partial<Record<MealType, number>>;
    cuisine?: { choice: Cuisine | "unclear"; confidence: number; probabilities?: Record<string, number> };
  };
  final: { mealTypes: MealType[]; cuisine: Cuisine | null };
  source: { meal: ClassificationSource; cuisine: ClassificationSource };
}

export interface ConfidenceBuckets {
  "0.9+": number;
  "0.7-0.9": number;
  "0.5-0.7": number;
  "<0.5": number;
}

export interface FieldOutcomes {
  corrected: number;
  decidedByJev: number;
  regexFallback: number;
  /** Jev decided and the result differs from what the regex would have said. */
  changedFromRegex: number;
  /** Distribution of Jev's top confidence per recipe (meal: highest yes probability). */
  confidence: ConfidenceBuckets;
}

export interface JevCallMetrics {
  calls: number;
  succeeded: number;
  failed: number;
  retried: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: { p50: number | null; p95: number | null; max: number | null };
}

export interface ClassificationRunSummary {
  generatedAt: string;
  model: string;
  recipes: number;
  jevCalls: number;
  costUsd: number;
  latencyP50Ms: number | null;
  mealDecidedByJev: number;
  cuisineDecidedByJev: number;
  mealChangedFromRegex: number;
  cuisineChangedFromRegex: number;
  failedCalls: number;
}

export interface ClassificationReport {
  version: 1;
  generatedAt: string;
  model: string;
  threshold: number;
  recipes: number;
  meal: FieldOutcomes;
  cuisine: FieldOutcomes & { unclear: number };
  /** Calls made in this run only; cached answers cost nothing. */
  thisRun: JevCallMetrics;
  /** Running totals across all recorded runs. */
  allTime: { runs: number; jevCalls: number; costUsd: number };
  /** Recipes where Jev's answer replaced a different regex answer. */
  disagreements: RecipeClassificationDetail[];
  /** Recipes whose best Jev confidence was close to the threshold. */
  borderline: RecipeClassificationDetail[];
  /** Recipes Jev confidently called "unclear" for cuisine. */
  unclear: RecipeClassificationDetail[];
  history: ClassificationRunSummary[];
}

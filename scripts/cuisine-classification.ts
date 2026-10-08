import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CUISINES, type Cuisine } from "../lib/types";
import { CUISINE_DESCRIPTIONS, CUISINE_UNCLEAR_DESCRIPTION } from "./classification-taxonomy";
import type { JevAnswers, JevQuestions } from "./jev-client";
import { AI_CONFIDENCE_THRESHOLD, type MealClassificationInput } from "./meal-classification";

export const CUISINE_CLASSIFIER_VERSION = "cuisine-v2-jev";
export const CUISINE_QUESTION = "cuisine";
export const CUISINE_UNCLEAR = "unclear";

/** Jev's cuisine pick; `cuisine: null` means Jev chose "unclear". */
export interface AiCuisineResponse {
  cuisine: Cuisine | null;
  confidence: number;
}

export interface AiCuisineCache {
  entries: Record<string, AiCuisineResponse>;
}

export function cuisineJevQuestions(): JevQuestions {
  return {
    [CUISINE_QUESTION]: {
      type: "choice",
      instructions:
        "Based only on this recipe's title and description, which cuisine does the dish belong to? " +
        "Ignore promotional text and hashtags. Choose unclear rather than guessing.",
      criteria: { ...CUISINE_DESCRIPTIONS, [CUISINE_UNCLEAR]: CUISINE_UNCLEAR_DESCRIPTION }
    }
  };
}

export function cuisineResponseFromJev(answers: JevAnswers): AiCuisineResponse | null {
  const answer = answers[CUISINE_QUESTION];
  if (answer?.type !== "choice") return null;
  return validateAiCuisineResponse({
    cuisine: answer.choice === CUISINE_UNCLEAR ? null : answer.choice,
    confidence: answer.confidence
  });
}

export function validateAiCuisineResponse(value: unknown): AiCuisineResponse | null {
  if (typeof value !== "object" || value === null) return null;
  const { cuisine, confidence } = value as Record<string, unknown>;
  if (cuisine !== null && !CUISINES.some((option) => option === cuisine)) return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return { cuisine: cuisine as Cuisine | null, confidence };
}

/**
 * Returns Jev's cuisine when it is confident: a cuisine, or `null` for a confident
 * "unclear". Returns `undefined` when the response is invalid or below the
 * threshold, so the caller can fall back to the regex rules.
 */
export function applyAiCuisineResponse(response: unknown): Cuisine | null | undefined {
  const validated = validateAiCuisineResponse(response);
  return validated && validated.confidence >= AI_CONFIDENCE_THRESHOLD ? validated.cuisine : undefined;
}

export function cuisineClassificationCacheKey(input: MealClassificationInput, model = ""): string {
  return createHash("sha256")
    .update(JSON.stringify({ title: input.title, description: input.description, classifier: CUISINE_CLASSIFIER_VERSION, model }))
    .digest("hex");
}

export async function readAiCuisineCache(cachePath: string): Promise<AiCuisineCache> {
  try {
    const value: unknown = JSON.parse(await readFile(cachePath, "utf8"));
    const entries = typeof value === "object" && value !== null ? (value as { entries?: unknown }).entries : undefined;
    if (typeof entries !== "object" || entries === null) return { entries: {} };
    return {
      entries: Object.fromEntries(
        Object.entries(entries).flatMap(([key, response]) => {
          const validated = validateAiCuisineResponse(response);
          return validated ? [[key, validated]] : [];
        })
      )
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: {} };
    throw error;
  }
}

export async function writeAiCuisineCache(cachePath: string, cache: AiCuisineCache): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

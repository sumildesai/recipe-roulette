import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MEAL_TYPES, type MealType } from "../lib/types";
import { ENTREE_RULE, MEAL_TYPE_DESCRIPTIONS, MEAL_TYPE_RULES, type ClassificationRule } from "./classification-taxonomy";
import type { JevAnswers, JevQuestions } from "./jev-client";

export const AI_CLASSIFIER_VERSION = "meal-type-v4-jev";
export const AI_PROMPT_VERSION = "2026-10-07";
export const AI_CONFIDENCE_THRESHOLD = 0.7;

export interface MealClassificationEvidence {
  source: "title" | "structured_metadata" | "prose" | "ai";
  label: MealType;
  confidence: number;
  reference: string;
}

export interface MealClassification {
  labels: MealType[];
  evidence: MealClassificationEvidence[];
  needsAi: boolean;
}

export interface MealClassificationInput {
  title: string;
  description: string;
}

export interface AiMealLabel {
  label: MealType;
  confidence: number;
  evidence: string;
}

export interface AiMealResponse {
  labels: AiMealLabel[];
}

export interface AiMealCache {
  entries: Record<string, AiMealResponse>;
}

// Covers both general praise phrasing ("perfect for dinner") and serving-suggestion
// phrasing ("pairs well with a refreshing drink", "serve with a side of dessert").
// Matches against all meal-type words, not just breakfast/lunch/dinner, since
// serving suggestions incidentally mentioning drinks, snacks, or desserts alongside
// a savory entree were previously slipping through as prose evidence.
const BOILERPLATE_SOURCE =
  "\\b(?:perfect|ideal|great|suitable|works?|good|goes?|pairs?|paired|serve[sd]?|enjoy(?:ed)?|along)\\b" +
  "[^.!?\\n]{0,120}" +
  "\\b(?:breakfast|lunch|dinner|snacks?|drinks?|desserts?|tea|coffee)\\b";
const BOILERPLATE = new RegExp(BOILERPLATE_SOURCE, "i");
const BOILERPLATE_GLOBAL = new RegExp(BOILERPLATE_SOURCE, "gi");
const HASH_TAG_SOURCE = "#\\w+";
const HASH_TAG = new RegExp(HASH_TAG_SOURCE);
const HASH_TAG_GLOBAL = new RegExp(HASH_TAG_SOURCE, "g");
const REGEX_CACHE = new Map<string, RegExp>();

export function inferMealClassification({ title, description }: MealClassificationInput): MealClassification {
  const titleEvidence = evidenceForText(sanitizeWeakSignals(title), "title", 1, title.trim());
  const metadataEvidence = structuredEvidence(description);
  const titleLabels = new Set(titleEvidence.map(({ label }) => label));
  const metadataLabels = new Set(metadataEvidence.map(({ label }) => label));

  if (titleLabels.size && metadataLabels.size && !setsOverlap(titleLabels, metadataLabels)) {
    return { labels: [], evidence: [...titleEvidence, ...metadataEvidence], needsAi: true };
  }

  const strongEvidence = [...titleEvidence, ...metadataEvidence];
  if (strongEvidence.length) return { labels: uniqueLabels(strongEvidence), evidence: strongEvidence, needsAi: false };

  const proseEvidence = proseEvidenceFor(description);
  const entreeEvidence = entreeEvidenceFor(title, description);

  // A generic entree signal (paneer, curry, casserole, etc.) is a strong indicator
  // the recipe is a savory main dish. If weak prose evidence disagrees with it (e.g.
  // a passing mention of "drink" or "dessert" as a serving suggestion), don't let the
  // prose evidence silently win; defer to AI classification instead.
  if (proseEvidence.length && entreeEvidence.length) {
    const proseLabels = new Set(proseEvidence.map(({ label }) => label));
    if (!proseLabels.has("lunch") && !proseLabels.has("dinner")) {
      return { labels: [], evidence: [...proseEvidence, ...entreeEvidence], needsAi: true };
    }
  }

  if (proseEvidence.length) return { labels: uniqueLabels(proseEvidence), evidence: proseEvidence, needsAi: false };

  if (entreeEvidence.length) return { labels: ["lunch", "dinner"], evidence: entreeEvidence, needsAi: false };

  return { labels: [], evidence: [], needsAi: true };
}

export function validateAiMealResponse(value: unknown): AiMealResponse | null {
  if (!isRecord(value) || !Array.isArray(value.labels)) return null;
  const labels: AiMealLabel[] = [];
  for (const item of value.labels) {
    if (
      !isRecord(item) ||
      !isMealType(item.label) ||
      typeof item.confidence !== "number" ||
      item.confidence < 0 ||
      item.confidence > 1 ||
      typeof item.evidence !== "string" ||
      !item.evidence.trim()
    ) return null;
    labels.push({ label: item.label, confidence: item.confidence, evidence: item.evidence.trim() });
  }
  return labels.length === new Set(labels.map(({ label }) => label)).size ? { labels } : null;
}

export function applyAiMealResponse(deterministic: MealClassification, response: unknown): MealClassification {
  const validated = validateAiMealResponse(response);
  if (!validated) return deterministic;
  const evidence = validated.labels
    .filter(({ confidence }) => confidence >= AI_CONFIDENCE_THRESHOLD)
    .map(({ label, confidence, evidence: reference }) => ({ source: "ai" as const, label, confidence, reference }));
  return evidence.length
    ? { labels: uniqueLabels(evidence), evidence, needsAi: false }
    : deterministic;
}

export function mealClassificationCacheKey(input: MealClassificationInput, model = ""): string {
  return createHash("sha256")
    .update(JSON.stringify({ title: input.title, description: input.description, classifier: AI_CLASSIFIER_VERSION, prompt: AI_PROMPT_VERSION, model }))
    .digest("hex");
}

export function mealQuestionName(mealType: MealType): string {
  return `meal_${mealType}`;
}

/**
 * One independent yes/no question per meal type, because a recipe can belong to
 * several meal types (for example both lunch and dinner).
 */
export function mealJevQuestions(): JevQuestions {
  return Object.fromEntries(MEAL_TYPES.map((mealType) => [mealQuestionName(mealType), {
    type: "noul" as const,
    instructions:
      `Based only on this recipe's title and description, is the dish commonly served as ${mealType}? ` +
      "Ignore promotional text, hashtags, and generic suggestions like 'perfect for any meal'.",
    criteria: {
      true: MEAL_TYPE_DESCRIPTIONS[mealType],
      false: `The dish is not typically served as ${mealType}.`
    }
  }]));
}

/**
 * Converts Jev answers into an AiMealResponse that keeps every meal type's
 * probability, so the confidence threshold can change without re-querying.
 */
export function mealResponseFromJev(answers: JevAnswers): AiMealResponse | null {
  const labels: AiMealLabel[] = [];
  for (const mealType of MEAL_TYPES) {
    const answer = answers[mealQuestionName(mealType)];
    if (answer?.type !== "noul") return null;
    labels.push({ label: mealType, confidence: answer.noul, evidence: `Jev noul probability ${answer.noul.toFixed(3)}` });
  }
  return validateAiMealResponse({ labels });
}

export async function readAiMealCache(cachePath: string): Promise<AiMealCache> {
  try {
    const value: unknown = JSON.parse(await readFile(cachePath, "utf8"));
    if (!isRecord(value) || !isRecord(value.entries)) return { entries: {} };
    return {
      entries: Object.fromEntries(
        Object.entries(value.entries).flatMap(([key, response]) => {
          const validated = validateAiMealResponse(response);
          return validated ? [[key, validated]] : [];
        })
      )
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: {} };
    throw error;
  }
}

export async function writeAiMealCache(cachePath: string, cache: AiMealCache): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function structuredEvidence(description: string): MealClassificationEvidence[] {
  const evidence: MealClassificationEvidence[] = [];
  for (const match of description.matchAll(/(?:^|\n)\s*(?:course|meal(?:\s*type)?|category)\s*:\s*([^\n]+)/gi)) {
    evidence.push(...evidenceForText(sanitizeWeakSignals(match[1]), "structured_metadata", 1, match[0].trim()));
  }
  return evidence;
}

function proseEvidenceFor(description: string): MealClassificationEvidence[] {
  return description
    .split(/[.!?\n]+/)
    .flatMap((sentence) => (BOILERPLATE.test(sentence) || HASH_TAG.test(sentence) ? [] : evidenceForText(sentence, "prose", 0.7)));
}

function sanitizeWeakSignals(text: string): string {
  return text.replace(BOILERPLATE_GLOBAL, " ").replace(HASH_TAG_GLOBAL, " ");
}

function evidenceForText(
  text: string,
  source: MealClassificationEvidence["source"],
  confidence: number,
  reference = text.trim()
): MealClassificationEvidence[] {
  return MEAL_TYPE_RULES
    .filter((rule) => matchesRule(text, rule))
    .map(({ value }) => ({ source, label: value, confidence, reference }));
}

function matchesRule(text: string, rule: ClassificationRule<MealType>): boolean {
  return rule.aliases.some((alias) => ruleRegex(alias).test(text)) &&
    !rule.exclusions?.some((alias) => ruleRegex(alias).test(text));
}

function entreeEvidenceFor(title: string, description: string): MealClassificationEvidence[] {
  const text = `${sanitizeWeakSignals(title)} ${sanitizeWeakSignals(description)}`;
  const match = ENTREE_RULE.aliases.find((alias) => ruleRegex(alias).test(text));
  if (!match) return [];
  return (["lunch", "dinner"] as const).map((label) => ({
    source: "prose" as const,
    label,
    confidence: 0.7,
    reference: `Generic entree signal: "${match}"`
  }));
}

function ruleRegex(alias: string): RegExp {
  const cached = REGEX_CACHE.get(alias);
  if (cached) return cached;
  const regex = new RegExp(`\\b${alias.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`, "i");
  REGEX_CACHE.set(alias, regex);
  return regex;
}

function uniqueLabels(evidence: MealClassificationEvidence[]): MealType[] {
  return [...new Set(evidence.map(({ label }) => label))];
}

function setsOverlap(left: Set<MealType>, right: Set<MealType>): boolean {
  return [...left].some((label) => right.has(label));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMealType(value: unknown): value is MealType {
  return typeof value === "string" && MEAL_TYPES.some((mealType) => mealType === value);
}

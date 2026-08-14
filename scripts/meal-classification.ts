import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MealType } from "../lib/types";
import { MEAL_TYPE_RULES, type ClassificationRule } from "./classification-taxonomy";

export const AI_CLASSIFIER_VERSION = "meal-type-v1";
export const AI_PROMPT_VERSION = "2026-08-14";
export const AI_CONFIDENCE_THRESHOLD = 0.8;

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

const BOILERPLATE = /\b(?:perfect|ideal|great|suitable|works?|good)\b[^.!?\n]{0,120}\b(?:breakfast|lunch|dinner)\b/i;
const HASH_TAG = /#\w+/;
const REGEX_CACHE = new Map<string, RegExp>();

export function inferMealClassification({ title, description }: MealClassificationInput): MealClassification {
  const titleEvidence = evidenceForText(title, "title", 1);
  const metadataEvidence = structuredEvidence(description);
  const titleLabels = new Set(titleEvidence.map(({ label }) => label));
  const metadataLabels = new Set(metadataEvidence.map(({ label }) => label));

  if (titleLabels.size && metadataLabels.size && !setsOverlap(titleLabels, metadataLabels)) {
    return { labels: [], evidence: [...titleEvidence, ...metadataEvidence], needsAi: true };
  }

  const strongEvidence = [...titleEvidence, ...metadataEvidence];
  if (strongEvidence.length) return { labels: uniqueLabels(strongEvidence), evidence: strongEvidence, needsAi: false };

  const proseEvidence = proseEvidenceFor(description);
  if (proseEvidence.length) return { labels: uniqueLabels(proseEvidence), evidence: proseEvidence, needsAi: false };

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

export function mealClassificationCacheKey(input: MealClassificationInput): string {
  return createHash("sha256")
    .update(JSON.stringify({ title: input.title, description: input.description, classifier: AI_CLASSIFIER_VERSION, prompt: AI_PROMPT_VERSION }))
    .digest("hex");
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

export async function classifyMealWithAi(input: MealClassificationInput, apiKey: string): Promise<AiMealResponse | null> {
  const response = await fetch(process.env.MEAL_CLASSIFIER_API_URL ?? "https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: ["Bearer", apiKey].join(" "), "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.MEAL_CLASSIFIER_MODEL ?? "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Classify recipe meal types only. Return labels only from breakfast, lunch, dinner, snack. " +
            "For every label require independent recipe-specific evidence; ignore promotional lists, hashtags, and boilerplate. " +
            "Return no labels when uncertain."
        },
        { role: "user", content: `Title: ${input.title}\nDescription: ${input.description}` }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "meal_type_classification",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["labels"],
            properties: {
              labels: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["label", "confidence", "evidence"],
                  properties: {
                    label: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                    evidence: { type: "string" }
                  }
                }
              }
            }
          }
        }
      }
    })
  });
  if (!response.ok) throw new Error(`Meal classifier failed (${response.status})`);
  const body: unknown = await response.json();
  const content = isRecord(body) && Array.isArray(body.choices) && isRecord(body.choices[0]) && isRecord(body.choices[0].message)
    ? body.choices[0].message.content
    : undefined;
  if (typeof content !== "string") return null;
  try {
    return validateAiMealResponse(JSON.parse(content));
  } catch {
    return null;
  }
}

function structuredEvidence(description: string): MealClassificationEvidence[] {
  const evidence: MealClassificationEvidence[] = [];
  for (const match of description.matchAll(/(?:^|\n)\s*(?:course|meal(?:\s*type)?|category)\s*:\s*([^\n]+)/gi)) {
    evidence.push(...evidenceForText(match[1], "structured_metadata", 1, match[0].trim()));
  }
  return evidence;
}

function proseEvidenceFor(description: string): MealClassificationEvidence[] {
  return description
    .split(/[.!?\n]+/)
    .flatMap((sentence) => (BOILERPLATE.test(sentence) || HASH_TAG.test(sentence) ? [] : evidenceForText(sentence, "prose", 0.7)));
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
  return value === "breakfast" || value === "lunch" || value === "dinner" || value === "snack";
}

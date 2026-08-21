import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import { MEAL_TYPES, type MealType } from "../lib/types";
import { ENTREE_RULE, MEAL_TYPE_RULES, type ClassificationRule } from "./classification-taxonomy";

export const AI_CLASSIFIER_VERSION = "meal-type-v3-copilot";
export const AI_PROMPT_VERSION = "2026-08-21";
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

export interface AiMealRequest {
  id: string;
  input: MealClassificationInput;
}

interface CopilotMealResponse {
  recipes: Array<AiMealResponse & { id: string }>;
}

const COPILOT_BATCH_SIZE = 20;

const BOILERPLATE_SOURCE = "\\b(?:perfect|ideal|great|suitable|works?|good)\\b[^.!?\\n]{0,120}\\b(?:breakfast|lunch|dinner)\\b";
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
  if (proseEvidence.length) return { labels: uniqueLabels(proseEvidence), evidence: proseEvidence, needsAi: false };

  const entreeEvidence = entreeEvidenceFor(title, description);
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

export async function classifyMealsWithCopilot(requests: AiMealRequest[], gitHubToken: string): Promise<Map<string, AiMealResponse>> {
  const baseDirectory = await mkdtemp(path.join(tmpdir(), "copilot-meal-classifier-"));
  const client = new CopilotClient({
    gitHubToken,
    useLoggedInUser: false,
    mode: "empty",
    baseDirectory,
    logLevel: "error"
  });
  const classifications = new Map<string, AiMealResponse>();
  await client.start();
  try {
    for (let index = 0; index < requests.length; index += COPILOT_BATCH_SIZE) {
      const batch = requests.slice(index, index + COPILOT_BATCH_SIZE);
      const session = await client.createSession({
        ...(process.env.MEAL_CLASSIFIER_MODEL ? { model: process.env.MEAL_CLASSIFIER_MODEL } : {}),
        availableTools: [],
        enableConfigDiscovery: false,
        enableHostGitOperations: false,
        enableSessionStore: false,
        enableSkills: false,
        infiniteSessions: { enabled: false },
        skipEmbeddingRetrieval: true
      });
      try {
        const response = await session.sendAndWait({ prompt: copilotMealPrompt(batch) }, 120_000);
        const expectedIds = new Set(batch.map(({ id }) => id));
        const parsed = validateCopilotMealResponse(response?.data.content, expectedIds);
        if (parsed) {
          parsed.recipes.forEach(({ id, labels }) => classifications.set(id, { labels }));
        } else {
          const raw = typeof response?.data.content === "string" ? response.data.content : String(response?.data.content);
          console.warn(
            `Copilot meal classification batch ${index / COPILOT_BATCH_SIZE + 1} returned invalid output ` +
            `(expected ${expectedIds.size} recipes). Raw response (truncated to 500 chars): ${raw.slice(0, 500)}`
          );
        }
      } catch (error) {
        console.warn(`Copilot meal classification batch ${index / COPILOT_BATCH_SIZE + 1} failed: ${error instanceof Error ? error.message : error}`);
      } finally {
        await session.disconnect();
      }
    }
  } finally {
    await client.stop();
    await rm(baseDirectory, { recursive: true, force: true });
  }
  return classifications;
}

export function validateCopilotMealResponse(value: unknown, expectedIds: Set<string>): CopilotMealResponse | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(value));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.recipes) || parsed.recipes.length !== expectedIds.size) return null;
  const recipes: CopilotMealResponse["recipes"] = [];
  const seen = new Set<string>();
  for (const item of parsed.recipes) {
    if (!isRecord(item) || typeof item.id !== "string" || !expectedIds.has(item.id) || seen.has(item.id)) return null;
    const response = validateAiMealResponse({ labels: item.labels });
    if (!response) return null;
    seen.add(item.id);
    recipes.push({ id: item.id, ...response });
  }
  return seen.size === expectedIds.size ? { recipes } : null;
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function copilotMealPrompt(requests: AiMealRequest[]): string {
  return [
    `Classify each recipe using only these labels: ${MEAL_TYPES.join(", ")}.`,
    "Require independent recipe-specific evidence for every label. Ignore promotional lists, hashtags, and boilerplate.",
    "Use an empty labels array when uncertain. Return only valid JSON with this shape, with no markdown code fences or other surrounding text:",
    '{"recipes":[{"id":"the supplied id","labels":[{"label":"breakfast","confidence":0.9,"evidence":"brief evidence"}]}]}',
    "Include every supplied id exactly once and do not add any other keys.",
    JSON.stringify(requests.map(({ id, input }) => ({ id, ...input })))
  ].join("\n");
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

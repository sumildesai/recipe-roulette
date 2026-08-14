import type { Cuisine, MealType, Recipe } from "../lib/types";
import { CUISINE_RULES, type ClassificationRule } from "./classification-taxonomy";
import { inferMealClassification, type MealClassification } from "./meal-classification";

export const CHANNELS = [
  { id: "UCe2JAC5FUfbxLCfAvBWmNJA", name: "Your Food Lab" },
  { id: "UCEHCDn_BBnk3uTK1M64ptyw", name: "Ranveer Brar" }
] as const;

export interface VideoSource {
  videoId: string;
  title: string;
  description: string;
  channelId: string;
  channelName: string;
  publishedAt: string;
  thumbnailUrl: string;
  durationSeconds: number | null;
}

export interface RecipeCorrection {
  title?: string;
  description?: string;
  cookingTimeMinutes?: number | null;
  mealTypes?: MealType[];
  cuisine?: Cuisine | null;
  vegetarian?: boolean | null;
}

export interface CatalogOverrides {
  include: string[];
  exclude: string[];
  corrections: Record<string, RecipeCorrection>;
}

type NormalizedRecipe = Omit<Recipe, "vegetarian"> & {
  vegetarian: boolean | null;
};
const REGEX_CACHE = new Map<string, RegExp>();

const NON_VEG = /\b(chicken|mutton|lamb|fish|prawn|shrimp|meat|keema|kebab|seafood|crab|salmon|tuna|beef|pork)\b/i;
const RECIPE_SIGNAL = /\b(recipe|cook|masala|curry|paneer|biryani|pasta|chaat|soup|cake|bread|paratha|naan|dal|sabzi|rice|noodles|dessert)\b/i;

export function classifyVegetarian(text: string): boolean {
  return !NON_VEG.test(text);
}

export function inferCookingTime(text: string): number | null {
  const normalized = text.replace(/\s+/g, " ");
  const explicit = [...normalized.matchAll(/\b(?:ready in|cook(?:ing)? time|total time|in)\s*:?\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\s*(?:minutes?|mins?)\b/gi)]
    .map((match) => Number(match[2] ?? match[1]))
    .filter((minutes) => minutes >= 5 && minutes <= 360);
  return explicit.length ? Math.max(...explicit) : null;
}

export function inferMealTypes(text: string): MealType[] {
  return inferMealClassification({ title: text, description: "" }).labels;
}

export function inferCuisine(text: string): Cuisine | null {
  for (const rule of CUISINE_RULES) if (matchesRule(text, rule)) return rule.value;
  return null;
}

export function isRecipeVideo(video: VideoSource): boolean {
  const text = `${video.title} ${video.description}`;
  return video.durationSeconds !== null && video.durationSeconds >= 90 && RECIPE_SIGNAL.test(text);
}

export function normalizeVideo(
  video: VideoSource,
  correction: RecipeCorrection = {},
  mealClassification: MealClassification = inferMealClassification({
    title: correction.title ?? video.title,
    description: correction.description ?? video.description
  })
): NormalizedRecipe {
  const text = `${correction.title ?? video.title} ${correction.description ?? video.description}`;
  return {
    id: video.videoId,
    videoId: video.videoId,
    title: cleanText(correction.title ?? video.title),
    description: cleanText(correction.description ?? video.description),
    channelId: video.channelId,
    channelName: video.channelName,
    publishedAt: new Date(video.publishedAt).toISOString(),
    thumbnailUrl: video.thumbnailUrl,
    videoUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
    durationSeconds: video.durationSeconds,
    cookingTimeMinutes: correction.cookingTimeMinutes !== undefined ? correction.cookingTimeMinutes : inferCookingTime(text),
    mealTypes: correction.mealTypes ?? mealClassification.labels,
    cuisine: correction.cuisine ?? inferCuisine(text),
    vegetarian: correction.vegetarian !== undefined ? correction.vegetarian : classifyVegetarian(text)
  };
}

export function applyOverrides(
  videos: VideoSource[],
  overrides: CatalogOverrides,
  mealClassifications = new Map<string, MealClassification>()
): Recipe[] {
  const excluded = new Set(overrides.exclude);
  const included = new Set(overrides.include);
  return videos
    .filter((video) => {
      const correction = overrides.corrections[video.videoId];
      if (excluded.has(video.videoId) || correction?.vegetarian === false) return false;
      if (included.has(video.videoId) || correction?.vegetarian === true) return true;
      const text = `${correction?.title ?? video.title} ${correction?.description ?? video.description}`;
      return isRecipeVideo(video) && classifyVegetarian(text) === true;
    })
    .map((video) => ({
      ...normalizeVideo(video, overrides.corrections[video.videoId], mealClassifications.get(video.videoId)),
      vegetarian: true as const
    }))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
}

export function parseIsoDuration(value: string): number | null {
  const match = value.match(/^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  return Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
}

function cleanText(value: string): string {
  return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function matchesRule<T extends string>(text: string, rule: ClassificationRule<T>): boolean {
  return matchesAnyAlias(text, rule.aliases) && !matchesAnyAlias(text, rule.exclusions);
}

function matchesAnyAlias(text: string, aliases: readonly string[] | undefined): boolean {
  if (!aliases || aliases.length === 0) return false;
  return aliases.some((alias) => createBoundarySafeRegex(alias).test(text));
}

function createBoundarySafeRegex(alias: string): RegExp {
  const cachedRegex = REGEX_CACHE.get(alias);
  if (cachedRegex) return cachedRegex;

  const escapedAlias = alias
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  const regex = new RegExp(`\\b${escapedAlias}\\b`, "i");
  REGEX_CACHE.set(alias, regex);
  return regex;
}

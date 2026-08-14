import type { Cuisine, DurationRangeMinutes, MealType, Recipe, RecipeDurations } from "../lib/types";
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
const MAX_SUPPORTED_DURATION_MINUTES = 24 * 60;
// Keep the optional sign so malformed negative values are consumed and rejected instead of reread as positive durations.
const NUMBER_PATTERN = "-?\\d+(?:\\.\\d+)?";
const UNIT_PATTERN = "(?:hours?|hrs?|hr|h|minutes?|mins?|min|m)";
const UNIT_PATTERN_WITH_BOUNDARY = `${UNIT_PATTERN}\\b`;
const DURATION_TOKEN_PATTERN = `${NUMBER_PATTERN}\\s*${UNIT_PATTERN_WITH_BOUNDARY}`;
const DURATION_EXPRESSION_PATTERN = `${DURATION_TOKEN_PATTERN}(?:\\s*(?:and\\s+)?${DURATION_TOKEN_PATTERN})?`;
const RANGE_SEPARATOR_PATTERN = "\\s*(?:-|–|—|to)\\s*";
const DURATION_RANGE_PATTERN = `(${DURATION_EXPRESSION_PATTERN}|${NUMBER_PATTERN}\\s*(?=${RANGE_SEPARATOR_PATTERN}\\d))(?:${RANGE_SEPARATOR_PATTERN}(${DURATION_EXPRESSION_PATTERN}|${NUMBER_PATTERN}\\s*(?=${UNIT_PATTERN_WITH_BOUNDARY})))?`;
const DURATION_REGEX = new RegExp(DURATION_RANGE_PATTERN, "gi");
const UNIT_REGEX = new RegExp(UNIT_PATTERN_WITH_BOUNDARY, "i");
const UNIT_MATCH_REGEX = new RegExp(UNIT_PATTERN_WITH_BOUNDARY, "gi");

const DURATION_LABELS = {
  preparation: ["prep(?:aration)?(?:\\s*time)?"],
  cooking: ["cook(?:ing)?(?:\\s*time)?"],
  resting: ["rest(?:ing)?(?:\\s*time)?", "chill(?:ing)?(?:\\s*time)?"],
  marination: ["marinat(?:ion|ing|e)(?:\\s*time)?"],
  total: ["total(?:\\s*time)?", "ready\\s+in"]
} as const satisfies Record<keyof Omit<RecipeDurations, "overall" | "overallSource">, readonly string[]>;

export function classifyVegetarian(text: string): boolean {
  return !NON_VEG.test(text);
}

/**
 * Infers the recipe duration used by legacy catalog and UI code.
 *
 * The value is the maximum minute bound of the inferred overall duration. Ranges are
 * therefore conservative for maximum-time filtering, explicit total durations take
 * precedence, and passive-only resting or marination durations do not create a
 * fallback active duration.
 */
export function inferCookingTime(text: string): number | null {
  return inferRecipeDurations(text).overall?.maxMinutes ?? null;
}

/**
 * Extracts labeled recipe durations from free-form recipe metadata.
 *
 * Supported units are minutes/mins/min/m and hours/hrs/hr/h, including singular,
 * plural, case-insensitive, mixed hour-minute, and range forms. Ranges are stored as
 * minimum and maximum minute values. When no reliable label is present, exactly one
 * unlabeled duration is treated as a total-time fallback; multiple unlabeled values
 * are ignored as ambiguous. Explicit total time is used as the overall duration for
 * filtering. Without an explicit total, preparation and cooking are summed as the
 * active-time fallback while resting and marination remain available but passive.
 */
export function inferRecipeDurations(text: string): RecipeDurations {
  const normalized = text.replace(/\s+/g, " ");
  const durations: RecipeDurations = {
    preparation: null,
    cooking: null,
    resting: null,
    marination: null,
    total: null,
    overall: null,
    overallSource: "none"
  };

  for (const component of Object.keys(DURATION_LABELS) as Array<keyof typeof DURATION_LABELS>) {
    const labelPattern = DURATION_LABELS[component].join("|");
    const regex = new RegExp(`\\b(?:${labelPattern})\\b\\s*(?::|=|-|–|—|is|for)?\\s*${DURATION_RANGE_PATTERN}`, "gi");
    for (const match of normalized.matchAll(regex)) {
      const range = parseDurationRangeMatch(match);
      if (!range) continue;
      durations[component] = combineLabeledDuration(durations[component], range);
    }
  }

  if (!hasLabeledDuration(durations)) {
    const unlabeled = [...normalized.matchAll(DURATION_REGEX)]
      .map(parseDurationRangeMatch)
      .filter((range): range is DurationRangeMinutes => range !== null);
    if (unlabeled.length === 1) {
      durations.total = unlabeled[0];
      durations.overall = unlabeled[0];
      durations.overallSource = "unlabeled-total";
      return durations;
    }
  }

  if (durations.total) {
    durations.overall = durations.total;
    durations.overallSource = "explicit-total";
    return durations;
  }

  const active = sumDurationRanges([durations.preparation, durations.cooking]);
  if (active) {
    durations.overall = active;
    durations.overallSource = "active-components";
  }
  return durations;
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
  const durations = inferRecipeDurations(text);
  const cookingTimeMinutes = correction.cookingTimeMinutes !== undefined
    ? correction.cookingTimeMinutes
    : durations.overall?.maxMinutes ?? null;
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
    cookingTimeMinutes,
    durations,
    mealTypes: correction.mealTypes ?? mealClassification.labels,
    cuisine: correction.cuisine ?? inferCuisine(text),
    vegetarian: correction.vegetarian !== undefined ? correction.vegetarian : classifyVegetarian(text)
  };
}

function parseDurationRangeMatch(match: RegExpMatchArray): DurationRangeMinutes | null {
  const secondExpression = match[2];
  const first = parseDurationExpression(match[1]) ?? (
    secondExpression ? parseDurationExpression(copyRangeUnit(secondExpression, match[1])) : null
  );
  if (first === null) return null;
  if (!secondExpression) return createDurationRange(first, first);

  const second = parseDurationExpression(copyRangeUnit(match[1], secondExpression));
  if (second === null) return null;
  return createDurationRange(Math.min(first, second), Math.max(first, second));
}

function copyRangeUnit(sourceExpression: string, targetExpression: string): string {
  if (UNIT_REGEX.test(targetExpression)) return targetExpression;
  const unit = sourceExpression.match(UNIT_MATCH_REGEX)?.at(-1);
  return unit ? `${targetExpression} ${unit}` : targetExpression;
}

function parseDurationExpression(value: string): number | null {
  let minutes = 0;
  let matched = false;
  const regex = new RegExp(`(${NUMBER_PATTERN})\\s*(${UNIT_PATTERN})\\b`, "gi");
  for (const match of value.matchAll(regex)) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount < 0) return null;
    const unit = match[2].toLowerCase();
    minutes += unit.startsWith("h") ? amount * 60 : amount;
    matched = true;
  }
  if (!matched || minutes < 1 || minutes > MAX_SUPPORTED_DURATION_MINUTES) return null;
  return Math.round(minutes);
}

function createDurationRange(minMinutes: number, maxMinutes: number): DurationRangeMinutes | null {
  if (
    minMinutes < 1 ||
    maxMinutes < minMinutes ||
    maxMinutes > MAX_SUPPORTED_DURATION_MINUTES
  ) {
    return null;
  }
  return { minMinutes, maxMinutes };
}

function combineLabeledDuration(
  current: DurationRangeMinutes | null,
  next: DurationRangeMinutes
): DurationRangeMinutes {
  if (!current) return next;
  return {
    minMinutes: Math.min(current.minMinutes, next.minMinutes),
    maxMinutes: Math.max(current.maxMinutes, next.maxMinutes)
  };
}

function sumDurationRanges(ranges: Array<DurationRangeMinutes | null>): DurationRangeMinutes | null {
  const present = ranges.filter((range): range is DurationRangeMinutes => range !== null);
  if (present.length === 0) return null;
  const total = present.reduce<DurationRangeMinutes>(
    (total, range) => ({
      minMinutes: total.minMinutes + range.minMinutes,
      maxMinutes: total.maxMinutes + range.maxMinutes
    }),
    { minMinutes: 0, maxMinutes: 0 }
  );
  return createDurationRange(total.minMinutes, total.maxMinutes);
}

function hasLabeledDuration(durations: RecipeDurations): boolean {
  return Boolean(durations.preparation || durations.cooking || durations.resting || durations.marination || durations.total);
}


export function isCatalogCandidate(
  video: VideoSource,
  overrides: CatalogOverrides,
  excluded: ReadonlySet<string> = new Set(overrides.exclude),
  included: ReadonlySet<string> = new Set(overrides.include)
): boolean {
  const correction = overrides.corrections[video.videoId];
  if (excluded.has(video.videoId) || correction?.vegetarian === false) return false;
  if (included.has(video.videoId) || correction?.vegetarian === true) return true;
  const text = `${correction?.title ?? video.title} ${correction?.description ?? video.description}`;
  return isRecipeVideo(video) && classifyVegetarian(text) === true;
}

export function applyOverrides(
  videos: VideoSource[],
  overrides: CatalogOverrides,
  mealClassifications = new Map<string, MealClassification>()
): Recipe[] {
  const excluded = new Set(overrides.exclude);
  const included = new Set(overrides.include);
  return videos
    .filter((video) => isCatalogCandidate(video, overrides, excluded, included))
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

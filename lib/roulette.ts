import type { Cuisine, MealType, Recipe } from "./types";

export interface RecipeFilters {
  mealTypes: readonly MealType[];
  cuisines: readonly Cuisine[];
  excludeEggs: boolean;
  sources: readonly string[];
  maxCookingTime: number | null;
}

/**
 * Filters recipes by selected facets and maximum overall duration.
 *
 * Maximum-time filtering compares against the recipe duration's maximum bound. If
 * enhanced duration metadata is unavailable, it falls back to the legacy
 * `cookingTimeMinutes` value. Recipes with unknown overall duration are included
 * only when no maximum-time filter is active.
 */
export function filterRecipes(recipes: Recipe[], filters: RecipeFilters): Recipe[] {
  return recipes.filter((recipe) => {
    if (
      filters.mealTypes.length > 0 &&
      !filters.mealTypes.some((mealType) => recipe.mealTypes.includes(mealType))
    ) {
      return false;
    }
    if (filters.cuisines.length > 0 && !filters.cuisines.some((cuisine) => recipe.cuisine === cuisine)) {
      return false;
    }
    if (filters.excludeEggs && recipe.ingredients?.includes("egg")) {
      return false;
    }
    if (filters.sources.length > 0 && !filters.sources.includes(recipe.channelName)) {
      return false;
    }
    if (filters.maxCookingTime !== null) {
      const filterDuration = recipe.durations?.overall?.maxMinutes ?? recipe.cookingTimeMinutes;
      return filterDuration !== null && filterDuration <= filters.maxCookingTime;
    }
    return true;
  });
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokenize(value: string): string[] {
  const normalized = normalizeSearchText(value);
  return normalized.length === 0 ? [] : normalized.split(/\s+/);
}

export function searchRecipes(recipes: Recipe[], query: string): Recipe[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return recipes;

  return recipes.filter((recipe) => {
    const haystack = normalizeSearchText(
      [recipe.title, recipe.description, recipe.cuisine ?? "", recipe.channelName, ...(recipe.ingredients ?? [])].join(" ")
    );
    return tokens.every((token) => haystack.includes(token));
  });
}

export function randomIndex(length: number, randomUint32: () => number = secureUint32): number {
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new RangeError("length must be a positive safe integer");
  }

  const range = 0x1_0000_0000;
  const limit = range - (range % length);
  let value = randomUint32();
  while (value >= limit) value = randomUint32();
  return value % length;
}

export function pickRandomRecipe(
  recipes: Recipe[],
  randomUint32?: () => number
): Recipe {
  if (recipes.length === 0) throw new RangeError("Cannot choose from an empty recipe list");
  return recipes[randomIndex(recipes.length, randomUint32)];
}

function secureUint32(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0];
}

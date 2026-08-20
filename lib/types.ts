export const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack", "drink", "dessert"] as const;
export const CUISINES = ["Indian", "Indo-Chinese", "Italian", "Middle Eastern", "Mexican", "Global"] as const;
export const INGREDIENTS = ["egg"] as const;

export type MealType = (typeof MEAL_TYPES)[number];
export type Cuisine = (typeof CUISINES)[number];
export type Ingredient = (typeof INGREDIENTS)[number];

export type RecipeDurationOverallSource = "explicit-total" | "active-components" | "unlabeled-total" | "none";

/**
 * Inclusive minimum and maximum bounds for a parsed recipe duration.
 */
export interface DurationRangeMinutes {
  minMinutes: number;
  maxMinutes: number;
}

/**
 * Parsed recipe duration components. Passive resting and marination remain
 * separate from the active-time fallback unless an explicit total is available.
 */
export interface RecipeDurations {
  preparation: DurationRangeMinutes | null;
  cooking: DurationRangeMinutes | null;
  resting: DurationRangeMinutes | null;
  marination: DurationRangeMinutes | null;
  total: DurationRangeMinutes | null;
  overall: DurationRangeMinutes | null;
  overallSource: RecipeDurationOverallSource;
}

export interface Recipe {
  id: string;
  videoId: string;
  title: string;
  description: string;
  channelId: string;
  channelName: string;
  publishedAt: string;
  thumbnailUrl: string;
  videoUrl: string;
  sourceType?: "youtube" | "website";
  sourceUrl?: string;
  durationSeconds: number | null;
  cookingTimeMinutes: number | null;
  /**
   * Enhanced duration metadata for generated catalogs. Optional for compatibility
   * with older serialized seed or cached catalogs that only include cookingTimeMinutes.
   */
  durations?: RecipeDurations;
  mealTypes: MealType[];
  cuisine: Cuisine | null;
  ingredients?: Ingredient[];
  vegetarian: boolean;
}

export interface Catalog {
  version: 1;
  source: "seed" | "youtube" | "generated";
  updatedThrough: string | null;
  sourceChannels: Array<{ id: string; name: string }>;
  recipes: Recipe[];
}

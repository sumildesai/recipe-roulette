export const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack", "drink", "dessert"] as const;
export const CUISINES = ["Indian", "Indo-Chinese", "Italian", "Middle Eastern", "Mexican", "Global"] as const;
export const INGREDIENTS = ["egg"] as const;

export type MealType = (typeof MEAL_TYPES)[number];
export type Cuisine = (typeof CUISINES)[number];
export type Ingredient = (typeof INGREDIENTS)[number];

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
  durationSeconds: number | null;
  cookingTimeMinutes: number | null;
  mealTypes: MealType[];
  cuisine: Cuisine | null;
  ingredients?: Ingredient[];
  vegetarian: true;
}

export interface Catalog {
  version: 1;
  source: "seed" | "youtube";
  updatedThrough: string | null;
  sourceChannels: Array<{ id: string; name: string }>;
  recipes: Recipe[];
}

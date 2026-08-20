import nytRecipes from "../data/nytimes-recipes.json";
import type { Cuisine, MealType, Recipe } from "../lib/types";

export const NYT_COOKING_SOURCE = { id: "nyt-cooking", name: "NYT Cooking" } as const;

export interface NytRecipeMetadata {
  id: string;
  title: string;
  url: string;
  mealTypes: MealType[];
  cuisine: Cuisine | null;
  vegetarian: true;
}

const METADATA_ONLY_DESCRIPTION = "Metadata-only NYT Cooking entry. The full recipe may require a subscription.";
const METADATA_PUBLISHED_AT = "1970-01-01T00:00:00.000Z";

export function loadNytRecipes(): Recipe[] {
  return (nytRecipes as NytRecipeMetadata[]).map(normalizeNytRecipe);
}

export function normalizeNytRecipe(recipe: NytRecipeMetadata): Recipe {
  return {
    id: recipe.id,
    videoId: recipe.id,
    title: recipe.title,
    description: METADATA_ONLY_DESCRIPTION,
    channelId: NYT_COOKING_SOURCE.id,
    channelName: NYT_COOKING_SOURCE.name,
    publishedAt: METADATA_PUBLISHED_AT,
    thumbnailUrl: "",
    videoUrl: recipe.url,
    sourceType: "website",
    sourceUrl: recipe.url,
    durationSeconds: null,
    cookingTimeMinutes: null,
    mealTypes: recipe.mealTypes,
    cuisine: recipe.cuisine,
    ingredients: [],
    vegetarian: recipe.vegetarian
  };
}

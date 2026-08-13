import { describe, expect, it } from "vitest";
import { filterRecipes, pickRandomRecipe, randomIndex } from "@/lib/roulette";
import type { Recipe } from "@/lib/types";

const recipe = (id: string, time: number | null, cuisine = "Indian"): Recipe => ({
  id,
  videoId: id,
  title: id,
  description: "",
  channelId: "channel",
  channelName: "Chef",
  publishedAt: "2026-01-01T00:00:00.000Z",
  thumbnailUrl: "",
  videoUrl: "",
  durationSeconds: 600,
  cookingTimeMinutes: time,
  mealTypes: ["dinner"],
  cuisine: cuisine as Recipe["cuisine"],
  vegetarian: true
});

describe("recipe filtering", () => {
  const recipes = [recipe("fast", 20), recipe("slow", 90), recipe("unknown", null), recipe("italian", 30, "Italian")];

  it("keeps unknown times with no cap and excludes them with an active cap", () => {
    expect(filterRecipes(recipes, { mealType: "", cuisine: "", maxCookingTime: null })).toHaveLength(4);
    expect(filterRecipes(recipes, { mealType: "", cuisine: "", maxCookingTime: 30 }).map(({ id }) => id))
      .toEqual(["fast", "italian"]);
  });

  it("combines meal and cuisine filters", () => {
    expect(filterRecipes(recipes, { mealType: "dinner", cuisine: "Italian", maxCookingTime: null }).map(({ id }) => id))
      .toEqual(["italian"]);
  });
});

describe("uniform random selection", () => {
  it("maps uint32 values to recipe indices", () => {
    expect(randomIndex(3, () => 5)).toBe(2);
    expect(pickRandomRecipe([recipe("a", 10), recipe("b", 20)], () => 1).id).toBe("b");
  });

  it("rejects modulo-biased values", () => {
    const values = [0xffff_ffff, 4];
    expect(randomIndex(3, () => values.shift()!)).toBe(1);
  });
});

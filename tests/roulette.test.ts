import { describe, expect, it } from "vitest";
import { filterRecipes, pickRandomRecipe, randomIndex, searchRecipes } from "@/lib/roulette";
import type { Recipe } from "@/lib/types";

const recipe = (
  id: string,
  time: number | null,
  cuisine = "Indian",
  overrides: Partial<Recipe> = {}
): Recipe => ({
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
  vegetarian: true,
  ...overrides
});

describe("recipe filtering", () => {
  const recipes = [recipe("fast", 20), recipe("slow", 90), recipe("unknown", null), recipe("italian", 30, "Italian")];

  it("keeps unknown times with no cap and excludes them with an active cap", () => {
    expect(filterRecipes(recipes, { mealType: "", cuisine: "", source: "", maxCookingTime: null })).toHaveLength(4);
    expect(filterRecipes(recipes, { mealType: "", cuisine: "", source: "", maxCookingTime: 30 }).map(({ id }) => id))
      .toEqual(["fast", "italian"]);
  });

  it("combines meal and cuisine filters", () => {
    expect(filterRecipes(recipes, { mealType: "dinner", cuisine: "Italian", source: "", maxCookingTime: null }).map(({ id }) => id))
      .toEqual(["italian"]);
  });

  it("filters by source channel", () => {
    const sourced = [
      recipe("yfl", 20, "Indian", { channelName: "Your Food Lab" }),
      recipe("rb", 20, "Indian", { channelName: "Ranveer Brar" })
    ];
    expect(filterRecipes(sourced, { mealType: "", cuisine: "", source: "Ranveer Brar", maxCookingTime: null }).map(({ id }) => id))
      .toEqual(["rb"]);
  });

  it("combines source with other filters", () => {
    const sourced = [
      recipe("yfl-fast", 20, "Indian", { channelName: "Your Food Lab" }),
      recipe("yfl-slow", 60, "Indian", { channelName: "Your Food Lab" }),
      recipe("rb-fast", 20, "Indian", { channelName: "Ranveer Brar" })
    ];
    expect(filterRecipes(sourced, { mealType: "dinner", cuisine: "Indian", source: "Your Food Lab", maxCookingTime: 30 }).map(({ id }) => id))
      .toEqual(["yfl-fast"]);
  });
});

describe("recipe search", () => {
  const paneer = recipe("paneer", 20, "Indian", {
    title: "Paneer Tikka",
    description: "A smoky grilled paneer starter",
    channelName: "Your Food Lab"
  });
  const biryani = recipe("biryani", 45, "Indian", {
    title: "Chicken Biryani",
    description: "Layered rice dish",
    channelName: "Ranveer Brar"
  });
  const pasta = recipe("pasta", 30, "Italian", {
    title: "Cafe pasta",
    description: "Creamy noodles with jalapeño",
    channelName: "Chef"
  });
  const items = [paneer, biryani, pasta];

  it("returns the unmodified list for an empty or whitespace-only query", () => {
    expect(searchRecipes(items, "")).toEqual(items);
    expect(searchRecipes(items, "   ")).toEqual(items);
  });

  it("matches case-insensitively", () => {
    expect(searchRecipes(items, "PANEER").map(({ id }) => id)).toEqual(["paneer"]);
  });

  it("matches multiple whitespace-separated tokens with AND semantics", () => {
    expect(searchRecipes(items, "paneer tikka").map(({ id }) => id)).toEqual(["paneer"]);
    expect(searchRecipes(items, "paneer biryani")).toEqual([]);
  });

  it("matches across title, description, cuisine, and channel", () => {
    expect(searchRecipes(items, "starter").map(({ id }) => id)).toEqual(["paneer"]);
    expect(searchRecipes(items, "indian").map(({ id }) => id)).toEqual(["paneer", "biryani"]);
    expect(searchRecipes(items, "ranveer").map(({ id }) => id)).toEqual(["biryani"]);
  });

  it("is diacritic and punctuation tolerant", () => {
    expect(searchRecipes(items, "jalapeno").map(({ id }) => id)).toEqual(["pasta"]);
    expect(searchRecipes(items, "cafe-pasta").map(({ id }) => id)).toEqual(["pasta"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(searchRecipes(items, "sushi")).toEqual([]);
  });

  it("does not mutate the input list", () => {
    const copy = [...items];
    searchRecipes(items, "paneer");
    expect(items).toEqual(copy);
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

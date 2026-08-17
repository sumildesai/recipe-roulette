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
  ingredients: [],
  vegetarian: true,
  ...overrides
});

describe("recipe filtering", () => {
  const recipes = [
    recipe("fast", 20),
    recipe("slow", 90),
    recipe("unknown", null),
    recipe("italian", 30, "Italian", { mealTypes: ["lunch"] })
  ];

  it("treats empty groups as unrestricted and composes with maximum time", () => {
    expect(filterRecipes(recipes, { mealTypes: [], cuisines: [], excludeEggs: false, sources: [], maxCookingTime: null }))
      .toHaveLength(4);
    expect(filterRecipes(recipes, { mealTypes: [], cuisines: [], excludeEggs: false, sources: [], maxCookingTime: 30 }).map(({ id }) => id))
      .toEqual(["fast", "italian"]);
  });

  it("uses OR semantics for multiple values in one group", () => {
    expect(filterRecipes(recipes, {
      mealTypes: ["dinner", "lunch"],
      cuisines: [],
      excludeEggs: false,
      sources: [],
      maxCookingTime: null
    }).map(({ id }) => id)).toEqual(["fast", "slow", "unknown", "italian"]);
  });

  it("uses AND semantics across groups", () => {
    const sourced = [
      recipe("yfl", 20, "Indian", { channelName: "Your Food Lab" }),
      recipe("rb", 20, "Indian", { channelName: "Ranveer Brar" }),
      recipe("italian-yfl", 20, "Italian", { channelName: "Your Food Lab" })
    ];
    expect(filterRecipes(sourced, {
      mealTypes: ["dinner"],
      cuisines: ["Indian", "Italian"],
      excludeEggs: false,
      sources: ["Your Food Lab"],
      maxCookingTime: null
    }).map(({ id }) => id)).toEqual(["yfl", "italian-yfl"]);
  });

  it("combines categorical groups with maximum time", () => {
    const sourced = [
      recipe("yfl-fast", 20, "Indian", { channelName: "Your Food Lab" }),
      recipe("yfl-slow", 60, "Indian", { channelName: "Your Food Lab" }),
      recipe("rb-fast", 20, "Indian", { channelName: "Ranveer Brar" })
    ];
    expect(filterRecipes(sourced, {
      mealTypes: ["dinner"],
      cuisines: ["Indian"],
      excludeEggs: false,
      sources: ["Your Food Lab"],
      maxCookingTime: 30
    }).map(({ id }) => id))
      .toEqual(["yfl-fast"]);
  });

  it("uses the documented maximum duration bound for range filtering", () => {
    const range = recipe("range", null, "Indian", {
      durations: {
        preparation: null,
        cooking: { minMinutes: 30, maxMinutes: 45 },
        resting: null,
        marination: null,
        total: null,
        overall: { minMinutes: 30, maxMinutes: 45 },
        overallSource: "active-components"
      }
    });
    expect(filterRecipes([range], { mealTypes: [], cuisines: [], sources: [], maxCookingTime: 30 }))
      .toEqual([]);
    expect(filterRecipes([range], { mealTypes: [], cuisines: [], sources: [], maxCookingTime: 45 }).map(({ id }) => id))
      .toEqual(["range"]);
  });

  it("uses explicit total duration for maximum-time filtering when component durations are available", () => {
    const explicitTotal = recipe("explicit-total", 150, "Indian", {
      durations: {
        preparation: { minMinutes: 10, maxMinutes: 10 },
        cooking: { minMinutes: 20, maxMinutes: 20 },
        resting: null,
        marination: { minMinutes: 120, maxMinutes: 120 },
        total: { minMinutes: 150, maxMinutes: 150 },
        overall: { minMinutes: 150, maxMinutes: 150 },
        overallSource: "explicit-total"
      }
    });
    expect(filterRecipes([explicitTotal], { mealTypes: [], cuisines: [], sources: [], maxCookingTime: 30 }))
      .toEqual([]);
    expect(filterRecipes([explicitTotal], { mealTypes: [], cuisines: [], sources: [], maxCookingTime: 150 }).map(({ id }) => id))
      .toEqual(["explicit-total"]);
  });

  it("excludes passive-only durations from maximum-time fallback", () => {
    const passiveOnly = recipe("passive-only", null, "Indian", {
      durations: {
        preparation: null,
        cooking: null,
        resting: { minMinutes: 30, maxMinutes: 30 },
        marination: { minMinutes: 120, maxMinutes: 120 },
        total: null,
        overall: null,
        overallSource: "none"
      }
    });
    expect(filterRecipes([passiveOnly], { mealTypes: [], cuisines: [], sources: [], maxCookingTime: 180 }))
      .toEqual([]);
  });

  it("does not mutate caller-owned filter collections", () => {
    const filters = {
      mealTypes: ["dinner"] as const,
      cuisines: ["Indian"] as const,
      excludeEggs: true,
      sources: ["Chef"] as const,
      maxCookingTime: null
    };
    filterRecipes(recipes, filters);
    expect(filters).toEqual({
      mealTypes: ["dinner"],
      cuisines: ["Indian"],
      excludeEggs: true,
      sources: ["Chef"],
      maxCookingTime: null
    });
  });

  it("excludes recipes containing egg when requested", () => {
    const eggRecipes = [
      recipe("egg-curry", 20, "Indian", { ingredients: ["egg"] }),
      recipe("paneer", 20),
      recipe("legacy", 20, "Indian", { ingredients: undefined })
    ];
    expect(filterRecipes(eggRecipes, {
      mealTypes: [],
      cuisines: [],
      excludeEggs: true,
      sources: [],
      maxCookingTime: null
    }).map(({ id }) => id)).toEqual(["paneer", "legacy"]);
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

  it("searches legacy recipes without ingredient metadata", () => {
    const legacy = recipe("legacy", 20, "Indian", { ingredients: undefined });
    expect(searchRecipes([legacy], "legacy")).toEqual([legacy]);
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

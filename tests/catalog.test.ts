import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  applyOverrides,
  classifyVegetarian,
  inferCookingTime,
  inferCuisine,
  inferMealTypes,
  parseIsoDuration,
  type VideoSource
} from "@/scripts/catalog";
import {
  applyAiMealResponse,
  inferMealClassification,
  mealClassificationCacheKey,
  readAiMealCache,
  validateAiMealResponse,
  writeAiMealCache
} from "@/scripts/meal-classification";

const video: VideoSource = {
  videoId: "recipe-1",
  title: "Easy Paneer Masala Recipe",
  description: "Vegetarian dinner ready in 30 minutes",
  channelId: "UCe2JAC5FUfbxLCfAvBWmNJA",
  channelName: "Your Food Lab",
  publishedAt: "2026-01-02T00:00:00Z",
  thumbnailUrl: "https://example.com/image.jpg",
  durationSeconds: 600
};

describe("catalog inference", () => {
  it("classifies recipes as vegetarian unless they contain a non-vegetarian signal", () => {
    expect(classifyVegetarian("pure veg paneer recipe")).toBe(true);
    expect(classifyVegetarian("paneer and chicken curry")).toBe(false);
    expect(classifyVegetarian("egg curry recipe")).toBe(true);
    expect(classifyVegetarian("anda chicken curry")).toBe(false);
    expect(classifyVegetarian("eggless besan bhurji")).toBe(true);
    expect(classifyVegetarian("tomato soup")).toBe(true);
  });

  describe("source-aware meal inference", () => {
    it("prioritizes title labels and structured metadata", () => {
      expect(inferMealClassification({
        title: "Quick Breakfast Poha",
        description: "Perfect for breakfast, lunch, or dinner."
      })).toMatchObject({ labels: ["breakfast"], needsAi: false });
      expect(inferMealClassification({
        title: "Vegetable Poha",
        description: "Course: Breakfast\nA quick weekday recipe."
      })).toMatchObject({ labels: ["breakfast"], needsAi: false });
    });

    it("rejects boilerplate and conflicting sources instead of guessing", () => {
      expect(inferMealClassification({
        title: "Vegetable Poha Recipe",
        description: "Perfect for breakfast, lunch, or dinner."
      })).toMatchObject({ labels: [], needsAi: true });
      expect(inferMealClassification({
        title: "Breakfast Paratha",
        description: "Course: Dinner"
      })).toMatchObject({ labels: [], needsAi: true });
    });

    it("retains meaningful multi-label recipes from an explicit title", () => {
      expect(inferMealClassification({
        title: "Breakfast Snack: Masala Toast",
        description: "Crisp and quick."
      })).toMatchObject({ labels: ["breakfast", "snack"], needsAi: false });
    });

    it("accepts only valid, sufficiently confident AI labels for implicit dishes", () => {
      const implicit = inferMealClassification({ title: "Traditional Poha", description: "Flattened rice with peanuts." });
      expect(implicit).toMatchObject({ labels: [], needsAi: true });
      expect(applyAiMealResponse(implicit, {
        labels: [{ label: "breakfast", confidence: 0.92, evidence: "Poha is a customary morning dish." }]
      })).toMatchObject({ labels: ["breakfast"], needsAi: false });
      expect(applyAiMealResponse(implicit, {
        labels: [{ label: "breakfast", confidence: 0.5, evidence: "Maybe breakfast." }]
      })).toEqual(implicit);
      expect(validateAiMealResponse({ labels: [] })).toEqual({ labels: [] });
      expect(validateAiMealResponse({ labels: [{ label: "brunch", confidence: 1, evidence: "Invalid taxonomy." }] })).toBeNull();
    });

    it("caches validated AI responses by metadata and classifier version", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "meal-cache-"));
      const cachePath = path.join(directory, "cache.json");
      const input = { title: "Poha", description: "Flattened rice" };
      const key = mealClassificationCacheKey(input);
      await writeAiMealCache(cachePath, {
        entries: { [key]: { labels: [{ label: "breakfast", confidence: 0.9, evidence: "Customary morning dish." }] } }
      });
      const cache = await readAiMealCache(cachePath);
      expect(cache.entries[key]?.labels[0].label).toBe("breakfast");
      expect(mealClassificationCacheKey({ ...input, title: "Dinner Poha" })).not.toBe(key);
      await rm(directory, { recursive: true });
    });
  });

  it("infers time, meal type, and cuisine", () => {
    expect(inferCookingTime("Total time: 45 mins")).toBe(45);
    expect(inferCookingTime("Cooking time: 20-25 minutes")).toBe(25);
    expect(inferCookingTime("A simple family recipe")).toBeNull();
    expect(inferMealTypes("Breakfast snack for tea time")).toEqual(["breakfast", "snack"]);
    expect(inferMealTypes("Quick brunch bowl")).toEqual(["breakfast"]);
    expect(inferMealTypes("Kitchen starter pack for students")).toEqual([]);
    expect(inferCuisine("Schezwan Hakka noodles")).toBe("Indo-Chinese");
    expect(inferCuisine("Schezwan paneer fried rice")).toBe("Indo-Chinese");
    expect(inferCuisine("Chettinad vegetable curry")).toBe("Indian");
    expect(inferCuisine("Thai style tofu bowl")).toBe("Global");
    expect(inferCuisine("Thai fried rice recipe")).toBe("Global");
    expect(inferCuisine("Complete thali platter menu")).toBeNull();
    expect(inferCuisine("Watch this kitchen tour")).toBeNull();
  });

  it("parses ISO 8601 video durations", () => {
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("not-a-duration")).toBeNull();
  });
});

describe("catalog overrides", () => {
  it("keeps recipes without non-vegetarian signals", () => {
    const ambiguous = {
      ...video,
      videoId: "ambiguous",
      title: "Simple family curry recipe",
      description: ""
    };
    const nonVegetarian = {
      ...video,
      videoId: "non-veg",
      title: "Paneer and chicken curry"
    };

    const recipes = applyOverrides([video, ambiguous, nonVegetarian], {
      include: [],
      exclude: [],
      corrections: {}
    });

    expect(recipes.map(({ id }) => id)).toEqual(["ambiguous", "recipe-1"]);
  });

  it("forces inclusion, exclusion, and metadata corrections", () => {
    const shortVideo = { ...video, videoId: "forced", durationSeconds: 30 };
    const recipes = applyOverrides([video, shortVideo], {
      include: ["forced"],
      exclude: ["recipe-1"],
      corrections: {
        forced: {
          title: "Corrected title",
          cuisine: "Mexican",
          cookingTimeMinutes: null,
          vegetarian: true
        }
      }
    });

    expect(recipes).toHaveLength(1);
    expect(recipes[0]).toMatchObject({
      id: "forced",
      title: "Corrected title",
      cuisine: "Mexican",
      cookingTimeMinutes: null,
      vegetarian: true
    });
  });

  it("sorts output deterministically", () => {
    const older = { ...video, videoId: "older", publishedAt: "2025-01-01T00:00:00Z" };
    const recipes = applyOverrides([older, video], { include: [], exclude: [], corrections: {} });
    expect(recipes.map(({ id }) => id)).toEqual(["recipe-1", "older"]);
  });
});

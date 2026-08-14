import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  applyOverrides,
  classifyVegetarian,
  inferCookingTime,
  inferRecipeDurations,
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
import { classifyMealTypes } from "@/scripts/generate-catalog";

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

  describe("classifyMealTypes orchestration", () => {
    const implicitVideo: VideoSource = {
      ...video,
      videoId: "implicit-poha",
      title: "Traditional Poha",
      description: "Flattened rice with peanuts."
    };
    const overrides = { include: [], exclude: [], corrections: {} };
    const previousClassifierKey = process.env.MEAL_CLASSIFIER_API_KEY;

    afterEach(() => {
      if (previousClassifierKey === undefined) delete process.env.MEAL_CLASSIFIER_API_KEY;
      else process.env.MEAL_CLASSIFIER_API_KEY = previousClassifierKey;
    });

    it("reuses a cache hit without calling the AI classifier", async () => {
      process.env.MEAL_CLASSIFIER_API_KEY = "test-key";
      const key = mealClassificationCacheKey({ title: implicitVideo.title, description: implicitVideo.description });
      const readAiMealCache = vi.fn().mockResolvedValue({
        entries: { [key]: { labels: [{ label: "breakfast", confidence: 0.9, evidence: "Customary morning dish." }] } }
      });
      const writeAiMealCache = vi.fn().mockResolvedValue(undefined);
      const classifyMealWithAi = vi.fn();

      const classifications = await classifyMealTypes([implicitVideo], overrides, {
        readAiMealCache,
        writeAiMealCache,
        classifyMealWithAi
      });

      expect(classifyMealWithAi).not.toHaveBeenCalled();
      expect(writeAiMealCache).not.toHaveBeenCalled();
      expect(classifications.get(implicitVideo.videoId)).toMatchObject({ labels: ["breakfast"], needsAi: false });
    });

    it("leaves the classification unresolved when the AI response is invalid", async () => {
      process.env.MEAL_CLASSIFIER_API_KEY = "test-key";
      const readAiMealCache = vi.fn().mockResolvedValue({ entries: {} });
      const writeAiMealCache = vi.fn().mockResolvedValue(undefined);
      const classifyMealWithAi = vi.fn().mockResolvedValue(null);

      const classifications = await classifyMealTypes([implicitVideo], overrides, {
        readAiMealCache,
        writeAiMealCache,
        classifyMealWithAi
      });

      expect(classifyMealWithAi).toHaveBeenCalledTimes(1);
      expect(writeAiMealCache).not.toHaveBeenCalled();
      expect(classifications.get(implicitVideo.videoId)).toMatchObject({ labels: [], needsAi: true });
    });

    it("leaves the classification unresolved when the AI request throws", async () => {
      process.env.MEAL_CLASSIFIER_API_KEY = "test-key";
      const readAiMealCache = vi.fn().mockResolvedValue({ entries: {} });
      const writeAiMealCache = vi.fn().mockResolvedValue(undefined);
      const classifyMealWithAi = vi.fn().mockRejectedValue(new Error("network error"));

      const classifications = await classifyMealTypes([implicitVideo], overrides, {
        readAiMealCache,
        writeAiMealCache,
        classifyMealWithAi
      });

      expect(classifyMealWithAi).toHaveBeenCalledTimes(1);
      expect(writeAiMealCache).not.toHaveBeenCalled();
      expect(classifications.get(implicitVideo.videoId)).toMatchObject({ labels: [], needsAi: true });
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

  describe("recipe duration inference", () => {
    it("parses minutes, hours, mixed units, case, and whitespace consistently", () => {
      expect(inferRecipeDurations("Total Time: 1 hour 15 minutes").total)
        .toEqual({ minMinutes: 75, maxMinutes: 75 });
      expect(inferRecipeDurations("cook time: 2 HRS").cooking)
        .toEqual({ minMinutes: 120, maxMinutes: 120 });
      expect(inferRecipeDurations("prep time:\t 10   mins").preparation)
        .toEqual({ minMinutes: 10, maxMinutes: 10 });
      expect(inferRecipeDurations("total time: 1h30m").total)
        .toEqual({ minMinutes: 90, maxMinutes: 90 });
    });

    it("keeps labeled preparation, cooking, resting, marination, and total durations distinct", () => {
      const durations = inferRecipeDurations(
        "Prep time: 15 minutes. Cooking time: 30 minutes. Resting time: 10 minutes. Marination time: 2 hours. Total time: 55 minutes."
      );

      expect(durations).toMatchObject({
        preparation: { minMinutes: 15, maxMinutes: 15 },
        cooking: { minMinutes: 30, maxMinutes: 30 },
        resting: { minMinutes: 10, maxMinutes: 10 },
        marination: { minMinutes: 120, maxMinutes: 120 },
        total: { minMinutes: 55, maxMinutes: 55 },
        overall: { minMinutes: 55, maxMinutes: 55 },
        overallSource: "explicit-total"
      });
    });

    it("stores ranges as min/max values and reports the maximum bound for compatibility", () => {
      const durations = inferRecipeDurations("Cooking time: 30-45 minutes");
      expect(durations.cooking).toEqual({ minMinutes: 30, maxMinutes: 45 });
      expect(durations.overall).toEqual({ minMinutes: 30, maxMinutes: 45 });
      expect(inferCookingTime("Cooking time: 30-45 minutes")).toBe(45);
    });

    it("uses a single unlabeled duration as a total fallback and ignores ambiguous unlabeled durations", () => {
      expect(inferRecipeDurations("A quick dinner in 35 minutes")).toMatchObject({
        total: { minMinutes: 35, maxMinutes: 35 },
        overallSource: "unlabeled-total"
      });
      expect(inferRecipeDurations("Chop 10 minutes and bake 20 minutes")).toMatchObject({
        total: null,
        overall: null,
        overallSource: "none"
      });
    });

    it("prefers explicit total time over active components and excludes passive components from active fallback", () => {
      expect(inferRecipeDurations("Prep time: 10 min. Cook time: 20 min. Resting time: 2 hours.").overall)
        .toEqual({ minMinutes: 30, maxMinutes: 30 });
      expect(inferRecipeDurations("Prep time: 10 min. Cook time: 20 min. Marination time: 2 hours. Total time: 150 min."))
        .toMatchObject({
          overall: { minMinutes: 150, maxMinutes: 150 },
          overallSource: "explicit-total"
        });
    });

    it("does not add duplicate labels for the same duration component", () => {
      expect(inferRecipeDurations("Cook time: 20 minutes. Cooking time: 30 minutes.").cooking)
        .toEqual({ minMinutes: 20, maxMinutes: 30 });
    });

    it("ignores malformed, negative, unsupported, and implausible durations", () => {
      expect(inferRecipeDurations("Cook time: -20 minutes")).toMatchObject({ cooking: null, overall: null });
      expect(inferRecipeDurations("Cook time: thirty minutes")).toMatchObject({ cooking: null, overall: null });
      expect(inferRecipeDurations("Cook time: 2 days")).toMatchObject({ cooking: null, overall: null });
      expect(inferRecipeDurations("Cook time: 200 hours")).toMatchObject({ cooking: null, overall: null });
      expect(inferRecipeDurations("Prep time: 13 hours. Cook time: 13 hours.")).toMatchObject({ overall: null });
    });
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

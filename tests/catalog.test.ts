import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  applyOverrides,
  CHANNELS,
  classifyVegetarian,
  classifyVegan,
  inferCookingTime,
  inferRecipeDurations,
  inferCuisine,
  inferIngredients,
  inferMealTypes,
  isRecipeVideo,
  parseIsoDuration,
  type VideoSource
} from "@/scripts/catalog";
import {
  applyAiMealResponse,
  inferMealClassification,
  mealClassificationCacheKey,
  readAiMealCache,
  validateCopilotMealResponse,
  validateAiMealResponse,
  writeAiMealCache
} from "@/scripts/meal-classification";
import { classifyMealTypes } from "@/scripts/generate-catalog";
import { normalizeNytRecipe } from "@/scripts/nytimes-recipes";

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

  it("confirms vegan recipes from explicit metadata or the dedicated vegan channel", () => {
    const rainbowPlantLife = CHANNELS.find(({ name }) => name === "Rainbow Plant Life");
    expect(rainbowPlantLife).toMatchObject({ id: "UCDbZvuDA_tZ6XP5wKKFuemQ", vegan: true });
    expect(classifyVegan("Creamy lentil pasta", rainbowPlantLife!.id)).toBe(true);
    expect(classifyVegan("Vegan lentil pasta", video.channelId)).toBe(true);
    expect(classifyVegan("Vegetarian paneer pasta", video.channelId)).toBe(false);
    expect(classifyVegan("Vegan chicken pasta", video.channelId)).toBe(false);
    expect(classifyVegan("Chicken pasta", rainbowPlantLife!.id)).toBe(false);
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

    it("recognizes common drink and dessert signals", () => {
      expect(inferMealClassification({
        title: "Fresh Mango Lassi",
        description: "A chilled yogurt drink."
      })).toMatchObject({ labels: ["drink"], needsAi: false });
      expect(inferMealClassification({
        title: "Chocolate Brownie Dessert",
        description: "Rich and fudgy."
      })).toMatchObject({ labels: ["dessert"], needsAi: false });
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
      expect(validateAiMealResponse({
        labels: [{ label: "dessert", confidence: 0.95, evidence: "A traditional sweet dish." }]
      })).not.toBeNull();
      expect(validateAiMealResponse({ labels: [{ label: "brunch", confidence: 1, evidence: "Invalid taxonomy." }] })).toBeNull();
    });

    it("accepts Copilot batches only when every requested recipe is mapped exactly once", () => {
      const valid = JSON.stringify({
        recipes: [{ id: "poha", labels: [{ label: "breakfast", confidence: 0.92, evidence: "A customary morning dish." }] }]
      });
      expect(validateCopilotMealResponse(valid, new Set(["poha"]))).toEqual({
        recipes: [{ id: "poha", labels: [{ label: "breakfast", confidence: 0.92, evidence: "A customary morning dish." }] }]
      });
      expect(validateCopilotMealResponse('{"recipes":[]}', new Set(["poha"]))).toBeNull();
      expect(validateCopilotMealResponse('{"recipes":[{"id":"other","labels":[]}]}', new Set(["poha"]))).toBeNull();
      expect(validateCopilotMealResponse("not json", new Set(["poha"]))).toBeNull();
      expect(validateCopilotMealResponse("```json\n" + valid + "\n```", new Set(["poha"]))).toEqual({
        recipes: [{ id: "poha", labels: [{ label: "breakfast", confidence: 0.92, evidence: "A customary morning dish." }] }]
      });
      expect(validateCopilotMealResponse("```\n" + valid + "\n```", new Set(["poha"]))).toEqual({
        recipes: [{ id: "poha", labels: [{ label: "breakfast", confidence: 0.92, evidence: "A customary morning dish." }] }]
      });
    });

    it("treats a generic entree with no explicit meal-time signal as both lunch and dinner", () => {
      expect(inferMealClassification({
        title: "Paneer Curry",
        description: "A rich main course made with paneer and tomato gravy."
      })).toMatchObject({ labels: ["lunch", "dinner"], needsAi: false });
    });

    it("does not force both when only lunch or dinner is explicitly mentioned alongside an entree word", () => {
      expect(inferMealClassification({
        title: "Paneer Curry",
        description: "Course: Dinner\nA rich main course."
      })).toMatchObject({ labels: ["dinner"], needsAi: false });
      expect(inferMealClassification({
        title: "Quick Lunch Dal",
        description: "A simple main course dal."
      })).toMatchObject({ labels: ["lunch"], needsAi: false });
    });

    it("does not classify a savory entree as a drink, snack, or dessert from an incidental serving suggestion", () => {
      expect(inferMealClassification({
        title: "Baked Palak Paneer Casserole Recipe",
        description: "Serve this baked palak paneer casserole hot, and pair it with a refreshing drink."
      })).toMatchObject({ labels: ["lunch", "dinner"], needsAi: false });
      expect(inferMealClassification({
        title: "Baked Palak Paneer Casserole Recipe",
        description: "This cheesy spinach paneer bake goes great with your evening tea or a cold drink."
      })).toMatchObject({ labels: ["lunch", "dinner"], needsAi: false });
      expect(inferMealClassification({
        title: "Paneer Tikka Curry",
        description: "A rich main course, best enjoyed with a side of dessert."
      })).toMatchObject({ labels: ["lunch", "dinner"], needsAi: false });
    });

    it("defers to AI when weak prose evidence conflicts with a strong entree signal", () => {
      expect(inferMealClassification({
        title: "Paneer Casserole",
        description: "A rich paneer main course. This snack is delicious too."
      })).toMatchObject({ labels: [], needsAi: true });
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
    const previousCopilotToken = process.env.COPILOT_GITHUB_TOKEN;
    const previousClassifierRequired = process.env.MEAL_CLASSIFIER_REQUIRED;

    afterEach(() => {
      vi.restoreAllMocks();
      if (previousCopilotToken === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
      else process.env.COPILOT_GITHUB_TOKEN = previousCopilotToken;
      if (previousClassifierRequired === undefined) delete process.env.MEAL_CLASSIFIER_REQUIRED;
      else process.env.MEAL_CLASSIFIER_REQUIRED = previousClassifierRequired;
    });

    it("fails when Copilot classification is required but its token is missing", async () => {
      delete process.env.COPILOT_GITHUB_TOKEN;
      process.env.MEAL_CLASSIFIER_REQUIRED = "true";

      await expect(classifyMealTypes([implicitVideo], overrides)).rejects.toThrow("COPILOT_GITHUB_TOKEN is required");
    });

    it("reuses a cache hit without calling the AI classifier", async () => {
      process.env.COPILOT_GITHUB_TOKEN = "test-key";
      const key = mealClassificationCacheKey({ title: implicitVideo.title, description: implicitVideo.description });
      const readAiMealCache = vi.fn().mockResolvedValue({
        entries: { [key]: { labels: [{ label: "breakfast", confidence: 0.9, evidence: "Customary morning dish." }] } }
      });
      const writeAiMealCache = vi.fn().mockResolvedValue(undefined);
      const classifyMealsWithCopilot = vi.fn();

      const classifications = await classifyMealTypes([implicitVideo], overrides, {
        readAiMealCache,
        writeAiMealCache,
        classifyMealsWithCopilot
      });

      expect(classifyMealsWithCopilot).not.toHaveBeenCalled();
      expect(writeAiMealCache).not.toHaveBeenCalled();
      expect(classifications.get(implicitVideo.videoId)).toMatchObject({ labels: ["breakfast"], needsAi: false });
    });

    it("leaves the classification unresolved when the AI response is invalid", async () => {
      process.env.COPILOT_GITHUB_TOKEN = "test-key";
      const readAiMealCache = vi.fn().mockResolvedValue({ entries: {} });
      const writeAiMealCache = vi.fn().mockResolvedValue(undefined);
      const classifyMealsWithCopilot = vi.fn().mockResolvedValue(new Map());

      const classifications = await classifyMealTypes([implicitVideo], overrides, {
        readAiMealCache,
        writeAiMealCache,
        classifyMealsWithCopilot
      });

      expect(classifyMealsWithCopilot).toHaveBeenCalledTimes(1);
      expect(writeAiMealCache).not.toHaveBeenCalled();
      expect(classifications.get(implicitVideo.videoId)).toMatchObject({ labels: [], needsAi: true });
    });

    it("applies and caches a successful Copilot classification", async () => {
      process.env.COPILOT_GITHUB_TOKEN = "test-key";
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const readAiMealCache = vi.fn().mockResolvedValue({ entries: {} });
      const writeAiMealCache = vi.fn().mockResolvedValue(undefined);
      const response = { labels: [{ label: "breakfast" as const, confidence: 0.92, evidence: "A customary morning dish." }] };
      const classifyMealsWithCopilot = vi.fn().mockResolvedValue(new Map([[implicitVideo.videoId, response]]));

      const classifications = await classifyMealTypes([implicitVideo], overrides, {
        readAiMealCache,
        writeAiMealCache,
        classifyMealsWithCopilot
      });

      expect(classifyMealsWithCopilot).toHaveBeenCalledWith([
        { id: implicitVideo.videoId, input: { title: implicitVideo.title, description: implicitVideo.description } }
      ], "test-key");
      expect(writeAiMealCache).toHaveBeenCalledWith(expect.stringContaining("meal-type-ai.json"), {
        entries: { [mealClassificationCacheKey({ title: implicitVideo.title, description: implicitVideo.description })]: response }
      });
      expect(classifications.get(implicitVideo.videoId)).toMatchObject({ labels: ["breakfast"], needsAi: false });
      expect(log).toHaveBeenCalledWith(expect.stringContaining(
        "sentToCopilot=1, validCopilotResponses=1, resolvedByCopilot=1, unresolved=0"
      ));
    });

    it("leaves the classification unresolved when the AI request throws", async () => {
      process.env.COPILOT_GITHUB_TOKEN = "test-key";
      const readAiMealCache = vi.fn().mockResolvedValue({ entries: {} });
      const writeAiMealCache = vi.fn().mockResolvedValue(undefined);
      const classifyMealsWithCopilot = vi.fn().mockRejectedValue(new Error("network error"));

      const classifications = await classifyMealTypes([implicitVideo], overrides, {
        readAiMealCache,
        writeAiMealCache,
        classifyMealsWithCopilot
      });

      expect(classifyMealsWithCopilot).toHaveBeenCalledTimes(1);
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
    expect(inferMealTypes("Rose lemonade mocktail")).toEqual(["drink"]);
    expect(inferMealTypes("Fresh ginger tea")).toEqual(["drink"]);
    expect(inferMealTypes("Classic gulab jamun sweet")).toEqual(["dessert"]);
    expect(inferMealTypes("Earl Grey tea cake")).toEqual(["dessert"]);
    expect(inferMealTypes("Kitchen starter pack for students")).toEqual([]);
    expect(inferCuisine("Schezwan Hakka noodles")).toBe("Indo-Chinese");
    expect(inferCuisine("Schezwan paneer fried rice")).toBe("Indo-Chinese");
    expect(inferCuisine("Chettinad vegetable curry")).toBe("Indian");
    expect(inferCuisine("Thai style tofu bowl")).toBe("Global");
    expect(inferCuisine("Thai fried rice recipe")).toBe("Global");
    expect(inferCuisine("Complete thali platter menu")).toBeNull();
    expect(inferCuisine("Watch this kitchen tour")).toBeNull();
    expect(inferIngredients("Masala egg curry")).toEqual(["egg"]);
    expect(inferIngredients("Anda bhurji")).toEqual(["egg"]);
    expect(inferIngredients("Eggless besan bhurji")).toEqual([]);
    expect(inferIngredients("An egg-free cake")).toEqual([]);
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
      expect(inferRecipeDurations("Cook time: thirty minutes. Serve after 10 minutes.")).toMatchObject({
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
      expect(inferRecipeDurations("Cook time: 1h30")).toMatchObject({ cooking: null, overall: null });
      expect(inferRecipeDurations("Cook time: 2 days")).toMatchObject({ cooking: null, overall: null });
      expect(inferRecipeDurations("Cook time: 200 hours")).toMatchObject({ cooking: null, overall: null });
      expect(inferRecipeDurations("Prep time: 13 hours. Cook time: 13 hours.")).toMatchObject({ overall: null });
    });
  });

  it("parses ISO 8601 video durations", () => {
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("not-a-duration")).toBeNull();
  });

  it("normalizes NYT Cooking metadata without recipe instructions", () => {
    expect(normalizeNytRecipe({
      id: "nyt-test",
      title: "Chocolate Chip Cookies",
      url: "https://cooking.nytimes.com/recipes/1015819-chocolate-chip-cookies",
      mealTypes: ["dessert"],
      cuisine: "Global",
      vegetarian: true
    })).toMatchObject({
      id: "nyt-test",
      title: "Chocolate Chip Cookies",
      channelName: "NYT Cooking",
      sourceType: "website",
      sourceUrl: "https://cooking.nytimes.com/recipes/1015819-chocolate-chip-cookies",
      thumbnailUrl: "",
      cookingTimeMinutes: null,
      mealTypes: ["dessert"],
      vegetarian: true
    });
  });

  it("includes clear drink recipes as catalog candidates", () => {
    expect(isRecipeVideo({
      ...video,
      title: "Mango Lassi",
      description: "A refreshing yogurt beverage."
    })).toBe(true);
    expect(isRecipeVideo({
      ...video,
      title: "Mango Milk Shake",
      description: "A refreshing drink."
    })).toBe(true);
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

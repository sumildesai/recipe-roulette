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
  mealJevQuestions,
  mealResponseFromJev,
  readAiMealCache,
  validateAiMealResponse,
  writeAiMealCache
} from "@/scripts/meal-classification";
import {
  applyAiCuisineResponse,
  cuisineClassificationCacheKey,
  cuisineJevQuestions,
  cuisineResponseFromJev,
  readAiCuisineCache,
  writeAiCuisineCache
} from "@/scripts/cuisine-classification";
import { buildJevQuestions, classifyWithJev } from "@/scripts/ai-classification";
import { decideWithJev, DEFAULT_JEV_MODEL, JEV_ENDPOINT, validateJevAnswers, type JevAnswers } from "@/scripts/jev-client";
import { classifyRecipes, type ClassifyRecipesDeps } from "@/scripts/generate-catalog";
import { CUISINES, MEAL_TYPES } from "@/lib/types";
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
      expect(applyAiMealResponse(implicit, {
        labels: [
          { label: "lunch", confidence: 0.72, evidence: "Jev noul probability 0.720" },
          { label: "dinner", confidence: 0.69, evidence: "Jev noul probability 0.690" }
        ]
      })).toMatchObject({ labels: ["lunch"], needsAi: false });
      expect(validateAiMealResponse({ labels: [] })).toEqual({ labels: [] });
      expect(validateAiMealResponse({
        labels: [{ label: "dessert", confidence: 0.95, evidence: "A traditional sweet dish." }]
      })).not.toBeNull();
      expect(validateAiMealResponse({ labels: [{ label: "brunch", confidence: 1, evidence: "Invalid taxonomy." }] })).toBeNull();
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

  describe("Jev client", () => {
    const questions = { ...mealJevQuestions(), ...cuisineJevQuestions() };
    const jevBody = (overrides: Record<string, unknown> = {}) => ({
      model: DEFAULT_JEV_MODEL,
      answers: {
        ...Object.fromEntries(MEAL_TYPES.map((mealType) => [`meal_${mealType}`, { type: "noul", noul: mealType === "breakfast" ? 0.93 : 0.04 }])),
        cuisine: { type: "choice", choice: "Indian", confidence: 0.91, probabilities: { Indian: 0.91, Global: 0.05, unclear: 0.04 } },
        ...overrides
      },
      usage: { input_tokens: 120, output_tokens: 8 }
    });

    it("asks one noul question per meal type and one cuisine choice including unclear", () => {
      expect(Object.keys(mealJevQuestions())).toEqual(MEAL_TYPES.map((mealType) => `meal_${mealType}`));
      expect(Object.values(mealJevQuestions()).every((question) => question.type === "noul")).toBe(true);
      const cuisine = cuisineJevQuestions().cuisine;
      expect(cuisine.type).toBe("choice");
      expect(Object.keys(cuisine.type === "choice" ? cuisine.criteria : {})).toEqual([...CUISINES, "unclear"]);
      expect(Object.keys(buildJevQuestions({ needsMeal: false, needsCuisine: true }))).toEqual(["cuisine"]);
      expect(Object.keys(buildJevQuestions({ needsMeal: true, needsCuisine: false }))).not.toContain("cuisine");
    });

    it("validates that every question is answered with the expected type", () => {
      expect(validateJevAnswers(jevBody(), questions)).toMatchObject({ meal_breakfast: { type: "noul", noul: 0.93 } });
      expect(validateJevAnswers(jevBody({ meal_lunch: undefined }), questions)).toBeNull();
      expect(validateJevAnswers(jevBody({ meal_lunch: { type: "choice", choice: "x", confidence: 1 } }), questions)).toBeNull();
      expect(validateJevAnswers(jevBody({ meal_lunch: { type: "noul", noul: 1.4 } }), questions)).toBeNull();
      expect(validateJevAnswers(jevBody({ cuisine: { type: "choice", choice: "Klingon", confidence: 0.9 } }), questions)).toBeNull();
      expect(validateJevAnswers({ answers: [] }, questions)).toBeNull();
    });

    it("maps Jev answers into meal and cuisine responses", () => {
      const answers = validateJevAnswers(jevBody(), questions) as JevAnswers;
      const meal = mealResponseFromJev(answers);
      expect(meal?.labels).toHaveLength(MEAL_TYPES.length);
      const implicit = inferMealClassification({ title: "Traditional Poha", description: "Flattened rice with peanuts." });
      expect(applyAiMealResponse(implicit, meal)).toMatchObject({ labels: ["breakfast"], needsAi: false });
      expect(cuisineResponseFromJev(answers)).toEqual({ cuisine: "Indian", confidence: 0.91 });

      const unclear = validateJevAnswers(jevBody({ cuisine: { type: "choice", choice: "unclear", confidence: 0.95 } }), questions) as JevAnswers;
      expect(cuisineResponseFromJev(unclear)).toEqual({ cuisine: null, confidence: 0.95 });
      expect(applyAiCuisineResponse({ cuisine: null, confidence: 0.95 })).toBeNull();
      expect(applyAiCuisineResponse({ cuisine: null, confidence: 0.5 })).toBeUndefined();
      expect(applyAiCuisineResponse({ cuisine: "Italian", confidence: 0.5 })).toBeUndefined();
      expect(applyAiCuisineResponse({ cuisine: "Italian", confidence: 0.69 })).toBeUndefined();
      expect(applyAiCuisineResponse({ cuisine: "Klingon", confidence: 0.9 })).toBeUndefined();
      expect(applyAiCuisineResponse({ cuisine: "Italian", confidence: 0.72 })).toBe("Italian");
      expect(applyAiCuisineResponse({ cuisine: "Italian", confidence: 0.85 })).toBe("Italian");
    });

    it("posts the decision request to OpenRouter with the API key and retries transient failures", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(jevBody()), { status: 200 }));
      const answers = await decideWithJev(
        { state: { title: "Poha" }, questions },
        { apiKey: "or-key", fetch: fetchMock, retryDelayMs: 0 }
      );
      expect(answers?.meal_breakfast).toEqual({ type: "noul", noul: 0.93 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(JEV_ENDPOINT);
      expect(init.headers).toMatchObject({ Authorization: "Bearer or-key", "Content-Type": "application/json" });
      expect(JSON.parse(init.body)).toMatchObject({ model: DEFAULT_JEV_MODEL, state: { title: "Poha" } });
    });

    it("returns null without retrying on non-transient errors or invalid bodies", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const unauthorized = vi.fn().mockResolvedValue(new Response("bad key", { status: 401 }));
      expect(await decideWithJev({ state: {}, questions }, { apiKey: "k", fetch: unauthorized, retryDelayMs: 0 })).toBeNull();
      expect(unauthorized).toHaveBeenCalledTimes(1);
      const invalid = vi.fn().mockResolvedValue(new Response(JSON.stringify({ answers: {} }), { status: 200 }));
      expect(await decideWithJev({ state: {}, questions }, { apiKey: "k", fetch: invalid, retryDelayMs: 0 })).toBeNull();
      expect(invalid).toHaveBeenCalledTimes(1);
    });

    it("sends one combined request per recipe with only the needed questions", async () => {
      const decide = vi.fn().mockImplementation(async ({ questions: asked }) =>
        validateJevAnswers(jevBody(), asked)
      );
      const results = await classifyWithJev([
        { id: "both", input: { title: "Poha", description: "" }, needsMeal: true, needsCuisine: true },
        { id: "cuisine-only", input: { title: "Toast", description: "" }, needsMeal: false, needsCuisine: true },
        { id: "nothing", input: { title: "x", description: "" }, needsMeal: false, needsCuisine: false }
      ], { apiKey: "k", decide });
      expect(decide).toHaveBeenCalledTimes(2);
      expect(Object.keys(decide.mock.calls[1][0].questions)).toEqual(["cuisine"]);
      expect(results.get("both")).toMatchObject({ meal: expect.any(Object), cuisine: { cuisine: "Indian" } });
      expect(results.get("cuisine-only")).toEqual({ cuisine: { cuisine: "Indian", confidence: 0.91 } });
      expect(results.has("nothing")).toBe(false);
    });

    it("caches validated cuisine responses and drops invalid entries", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "cuisine-cache-"));
      const cachePath = path.join(directory, "cache.json");
      const key = cuisineClassificationCacheKey({ title: "Poha", description: "" }, DEFAULT_JEV_MODEL);
      await writeAiCuisineCache(cachePath, {
        entries: { [key]: { cuisine: "Indian", confidence: 0.9 }, bad: { cuisine: "Klingon", confidence: 0.9 } as never }
      });
      expect((await readAiCuisineCache(cachePath)).entries).toEqual({ [key]: { cuisine: "Indian", confidence: 0.9 } });
      expect(cuisineClassificationCacheKey({ title: "Poha", description: "" }, "other-model")).not.toBe(key);
      await rm(directory, { recursive: true });
    });
  });

  describe("classifyRecipes orchestration", () => {
    const implicitVideo: VideoSource = {
      ...video,
      videoId: "implicit-toast",
      title: "Sourdough Avocado Toast",
      description: "Crusty bread topped with smashed avocado."
    };
    const implicitInput = { title: implicitVideo.title, description: implicitVideo.description };
    const overrides = { include: [], exclude: [], corrections: {} };
    const mealResponse = { labels: [{ label: "breakfast" as const, confidence: 0.92, evidence: "Jev noul probability 0.920" }] };
    const cuisineResponse = { cuisine: "Indian" as const, confidence: 0.9 };
    const previousKey = process.env.OPENROUTER_API_KEY;
    const previousRequired = process.env.CLASSIFIER_REQUIRED;
    const previousModel = process.env.JEV_MODEL;

    function deps(overridesForDeps: Partial<ClassifyRecipesDeps> = {}): ClassifyRecipesDeps {
      return {
        readAiMealCache: vi.fn().mockResolvedValue({ entries: {} }),
        writeAiMealCache: vi.fn().mockResolvedValue(undefined),
        readAiCuisineCache: vi.fn().mockResolvedValue({ entries: {} }),
        writeAiCuisineCache: vi.fn().mockResolvedValue(undefined),
        classifyWithJev: vi.fn().mockResolvedValue(new Map()),
        ...overridesForDeps
      };
    }

    afterEach(() => {
      vi.restoreAllMocks();
      for (const [name, value] of [["OPENROUTER_API_KEY", previousKey], ["CLASSIFIER_REQUIRED", previousRequired], ["JEV_MODEL", previousModel]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    it("fails when Jev classification is required but the OpenRouter key is missing", async () => {
      delete process.env.OPENROUTER_API_KEY;
      process.env.CLASSIFIER_REQUIRED = "true";

      await expect(classifyRecipes([implicitVideo], overrides, deps())).rejects.toThrow("OPENROUTER_API_KEY is required");
    });

    it("keeps regex results without calling Jev when the key is missing and not required", async () => {
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.CLASSIFIER_REQUIRED;
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const testDeps = deps();

      const { meals, cuisines } = await classifyRecipes([implicitVideo], overrides, testDeps);

      expect(testDeps.classifyWithJev).not.toHaveBeenCalled();
      expect(meals.get(implicitVideo.videoId)).toMatchObject({ labels: [], needsAi: true });
      expect(cuisines.size).toBe(0);
    });

    it("sends regex-resolved recipes to Jev and lets confident answers override the regex", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const resolvedVideo = { ...video, title: "Breakfast Paneer Masala" };
      expect(inferCuisine(`${resolvedVideo.title} ${resolvedVideo.description}`)).toBe("Indian");
      const testDeps = deps({
        classifyWithJev: vi.fn().mockResolvedValue(new Map([[resolvedVideo.videoId, {
          meal: { labels: [{ label: "lunch", confidence: 0.9, evidence: "Jev noul probability 0.900" }] },
          cuisine: { cuisine: "Indo-Chinese", confidence: 0.9 }
        }]]))
      });

      const { meals, cuisines } = await classifyRecipes([resolvedVideo], overrides, testDeps);

      expect(testDeps.classifyWithJev).toHaveBeenCalledWith(
        [expect.objectContaining({ id: resolvedVideo.videoId, needsMeal: true, needsCuisine: true })],
        expect.anything()
      );
      expect(applyOverrides([resolvedVideo], overrides, meals, cuisines)[0]).toMatchObject({ mealTypes: ["lunch"], cuisine: "Indo-Chinese" });
    });

    it("falls back to the regex when Jev is below the threshold", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const resolvedVideo = { ...video, title: "Breakfast Paneer Masala" };
      const testDeps = deps({
        classifyWithJev: vi.fn().mockResolvedValue(new Map([[resolvedVideo.videoId, {
          meal: { labels: [{ label: "lunch", confidence: 0.6, evidence: "Jev noul probability 0.600" }] },
          cuisine: { cuisine: "Italian", confidence: 0.6 }
        }]]))
      });

      const { meals, cuisines } = await classifyRecipes([resolvedVideo], overrides, testDeps);

      expect(cuisines.size).toBe(0);
      expect(applyOverrides([resolvedVideo], overrides, meals, cuisines)[0]).toMatchObject({ mealTypes: ["breakfast"], cuisine: "Indian" });
    });

    it("reuses cache hits without calling Jev", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const testDeps = deps({
        readAiMealCache: vi.fn().mockResolvedValue({ entries: { [mealClassificationCacheKey(implicitInput, DEFAULT_JEV_MODEL)]: mealResponse } }),
        readAiCuisineCache: vi.fn().mockResolvedValue({ entries: { [cuisineClassificationCacheKey(implicitInput, DEFAULT_JEV_MODEL)]: cuisineResponse } })
      });

      const { meals, cuisines } = await classifyRecipes([implicitVideo], overrides, testDeps);

      expect(testDeps.classifyWithJev).not.toHaveBeenCalled();
      expect(testDeps.writeAiMealCache).not.toHaveBeenCalled();
      expect(testDeps.writeAiCuisineCache).not.toHaveBeenCalled();
      expect(meals.get(implicitVideo.videoId)).toMatchObject({ labels: ["breakfast"], needsAi: false });
      expect(cuisines.get(implicitVideo.videoId)).toBe("Indian");
    });

    it("applies and caches a combined Jev classification", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const testDeps = deps({
        classifyWithJev: vi.fn().mockResolvedValue(new Map([[implicitVideo.videoId, { meal: mealResponse, cuisine: cuisineResponse }]]))
      });

      const { meals, cuisines } = await classifyRecipes([implicitVideo], overrides, testDeps);

      expect(testDeps.classifyWithJev).toHaveBeenCalledWith(
        [{ id: implicitVideo.videoId, input: implicitInput, needsMeal: true, needsCuisine: true }],
        { apiKey: "test-key", model: DEFAULT_JEV_MODEL }
      );
      expect(testDeps.writeAiMealCache).toHaveBeenCalledWith(expect.stringContaining("meal-type-ai.json"), {
        entries: { [mealClassificationCacheKey(implicitInput, DEFAULT_JEV_MODEL)]: mealResponse }
      });
      expect(testDeps.writeAiCuisineCache).toHaveBeenCalledWith(expect.stringContaining("cuisine-ai.json"), {
        entries: { [cuisineClassificationCacheKey(implicitInput, DEFAULT_JEV_MODEL)]: cuisineResponse }
      });
      expect(meals.get(implicitVideo.videoId)).toMatchObject({ labels: ["breakfast"], needsAi: false });
      expect(cuisines.get(implicitVideo.videoId)).toBe("Indian");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("jevRequests=1, validJevResponses=1"));
      expect(applyOverrides([implicitVideo], overrides, meals, cuisines)[0]).toMatchObject({ mealTypes: ["breakfast"], cuisine: "Indian" });
    });

    it("keeps a confident unclear cuisine null even when the regex finds one", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const resolvedVideo = { ...video, title: "Breakfast Paneer Masala" };
      const testDeps = deps({
        classifyWithJev: vi.fn().mockResolvedValue(new Map([[resolvedVideo.videoId, { cuisine: { cuisine: null, confidence: 0.9 } }]]))
      });

      const { cuisines } = await classifyRecipes([resolvedVideo], overrides, testDeps);

      expect(cuisines.get(resolvedVideo.videoId)).toBeNull();
      expect(applyOverrides([resolvedVideo], overrides, undefined, cuisines)[0].cuisine).toBeNull();
    });

    it("asks only for the fields that corrections leave open", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const testDeps = deps();
      const corrected = { ...overrides, corrections: { [implicitVideo.videoId]: { mealTypes: ["snack" as const] } } };

      await classifyRecipes([implicitVideo], corrected, testDeps);

      expect(testDeps.classifyWithJev).toHaveBeenCalledWith(
        [expect.objectContaining({ needsMeal: false, needsCuisine: true })],
        expect.anything()
      );
    });

    it("does not ask Jev about fields that corrections already set", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const testDeps = deps();
      const corrected = { ...overrides, corrections: { [implicitVideo.videoId]: { mealTypes: ["snack" as const], cuisine: "Indian" as const } } };

      await classifyRecipes([implicitVideo], corrected, testDeps);

      expect(testDeps.classifyWithJev).not.toHaveBeenCalled();
    });

    it("leaves classifications unresolved when Jev throws", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const testDeps = deps({ classifyWithJev: vi.fn().mockRejectedValue(new Error("network error")) });

      const { meals, cuisines } = await classifyRecipes([implicitVideo], overrides, testDeps);

      expect(testDeps.writeAiMealCache).not.toHaveBeenCalled();
      expect(testDeps.writeAiCuisineCache).not.toHaveBeenCalled();
      expect(meals.get(implicitVideo.videoId)).toMatchObject({ labels: [], needsAi: true });
      expect(cuisines.size).toBe(0);
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

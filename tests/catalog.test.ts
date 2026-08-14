import { describe, expect, it } from "vitest";
import {
  applyOverrides,
  classifyVegetarian,
  inferCookingTime,
  inferCuisine,
  inferMealTypes,
  parseIsoDuration,
  type VideoSource
} from "@/scripts/catalog";

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

  it("infers time, meal type, and cuisine", () => {
    expect(inferCookingTime("Total time: 45 mins")).toBe(45);
    expect(inferCookingTime("Cooking time: 20-25 minutes")).toBe(25);
    expect(inferCookingTime("A simple family recipe")).toBeNull();
    expect(inferMealTypes("Breakfast snack for tea time")).toEqual(["breakfast", "snack"]);
    expect(inferCuisine("Schezwan Hakka noodles")).toBe("Indo-Chinese");
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

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyOverrides, CHANNELS, isCatalogCandidate, parseIsoDuration, type CatalogOverrides, type VideoSource } from "./catalog";
import { classifyWithJev, type AiClassificationRequest, type AiClassificationResult } from "./ai-classification";
import {
  applyAiCuisineResponse,
  cuisineClassificationCacheKey,
  readAiCuisineCache,
  writeAiCuisineCache
} from "./cuisine-classification";
import { DEFAULT_JEV_MODEL } from "./jev-client";
import {
  applyAiMealResponse,
  inferMealClassification,
  mealClassificationCacheKey,
  readAiMealCache,
  writeAiMealCache,
  type MealClassification,
  type MealClassificationInput
} from "./meal-classification";
import type { Catalog, Cuisine } from "../lib/types";
import { loadNytRecipes, NYT_COOKING_SOURCE } from "./nytimes-recipes";

const API_ROOT = "https://www.googleapis.com/youtube/v3";
const outputPath = path.resolve(process.env.CATALOG_OUTPUT_PATH ?? "public/recipes.local.json");
const overridesPath = path.resolve("data/catalog-overrides.json");
const mealCachePath = path.resolve(".catalog-cache/meal-type-ai.json");
const cuisineCachePath = path.resolve(".catalog-cache/cuisine-ai.json");

async function main() {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error("YOUTUBE_API_KEY is required to generate the catalog");

  const overrides = JSON.parse(await readFile(overridesPath, "utf8")) as CatalogOverrides;
  const videos = (await Promise.all(CHANNELS.map((channel) => fetchChannelVideos(channel, apiKey)))).flat();
  const { meals, cuisines } = await classifyRecipes(videos, overrides);
  const recipes = [...applyOverrides(videos, overrides, meals, cuisines), ...loadNytRecipes()]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
  const catalog: Catalog = {
    version: 1,
    source: "generated",
    updatedThrough: recipes[0]?.publishedAt ?? null,
    sourceChannels: [...CHANNELS, NYT_COOKING_SOURCE].map(({ id, name }) => ({ id, name })),
    recipes
  };
  await writeFile(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  console.log(`Wrote ${recipes.length} recipes to ${outputPath}`);
}

export interface ClassifyRecipesDeps {
  readAiMealCache: typeof readAiMealCache;
  writeAiMealCache: typeof writeAiMealCache;
  readAiCuisineCache: typeof readAiCuisineCache;
  writeAiCuisineCache: typeof writeAiCuisineCache;
  classifyWithJev: typeof classifyWithJev;
}

export interface RecipeClassifications {
  meals: Map<string, MealClassification>;
  /**
   * Jev's confident cuisine per recipe (`null` = confidently unclear). Recipes
   * missing from the map fall back to the regex rules.
   */
  cuisines: Map<string, Cuisine | null>;
}

const defaultClassifyRecipesDeps: ClassifyRecipesDeps = {
  readAiMealCache,
  writeAiMealCache,
  readAiCuisineCache,
  writeAiCuisineCache,
  classifyWithJev
};

/**
 * Asks Jev for every candidate's meal types and cuisine, skipping fields already
 * set by a correction. The regex rules are the fallback when Jev fails or is
 * below the confidence threshold. Corrections always take priority.
 */
export async function classifyRecipes(
  videos: VideoSource[],
  overrides: CatalogOverrides,
  deps: ClassifyRecipesDeps = defaultClassifyRecipesDeps
): Promise<RecipeClassifications> {
  const excluded = new Set(overrides.exclude);
  const included = new Set(overrides.include);
  const candidates = videos.filter((video) => isCatalogCandidate(video, overrides, excluded, included));
  const inputs = new Map<string, MealClassificationInput>(candidates.map((video) => {
    const correction = overrides.corrections[video.videoId];
    return [video.videoId, { title: correction?.title ?? video.title, description: correction?.description ?? video.description }];
  }));
  const meals = new Map([...inputs].map(([videoId, input]) => [videoId, inferMealClassification(input)]));
  const cuisines = new Map<string, Cuisine | null>();
  const mealPending = new Set([...inputs.keys()].filter((videoId) => !overrides.corrections[videoId]?.mealTypes));
  const cuisinePending = new Set([...inputs.keys()].filter((videoId) => overrides.corrections[videoId]?.cuisine == null));

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterKey) {
    if (process.env.CLASSIFIER_REQUIRED === "true") throw new Error("OPENROUTER_API_KEY is required for Jev classification");
    if (candidates.length) console.warn("OPENROUTER_API_KEY is not set; classifying meal types and cuisines with regex rules only.");
    return { meals, cuisines };
  }

  const model = process.env.JEV_MODEL || DEFAULT_JEV_MODEL;
  const [mealCache, cuisineCache] = await Promise.all([deps.readAiMealCache(mealCachePath), deps.readAiCuisineCache(cuisineCachePath)]);
  const requests: AiClassificationRequest[] = [...new Set([...mealPending, ...cuisinePending])].flatMap((id) => {
    const input = inputs.get(id);
    if (!input) return [];
    const needsMeal = mealPending.has(id) && !mealCache.entries[mealClassificationCacheKey(input, model)];
    const needsCuisine = cuisinePending.has(id) && !cuisineCache.entries[cuisineClassificationCacheKey(input, model)];
    return needsMeal || needsCuisine ? [{ id, input, needsMeal, needsCuisine }] : [];
  });
  let jevResults = new Map<string, AiClassificationResult>();
  if (requests.length) {
    try {
      jevResults = await deps.classifyWithJev(requests, { apiKey: openRouterKey, model });
    } catch (error) {
      console.warn(`Jev classifier failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  let mealCacheChanged = false;
  let cuisineCacheChanged = false;
  let failures = 0;
  let mealsByJev = 0;
  for (const videoId of mealPending) {
    const input = inputs.get(videoId);
    const deterministic = meals.get(videoId);
    if (!input || !deterministic) continue;
    const key = mealClassificationCacheKey(input, model);
    const response = mealCache.entries[key] ?? jevResults.get(videoId)?.meal;
    if (!response) {
      failures++;
      continue;
    }
    if (!mealCache.entries[key]) {
      mealCache.entries[key] = response;
      mealCacheChanged = true;
    }
    const result = applyAiMealResponse(deterministic, response);
    if (result !== deterministic) mealsByJev++;
    meals.set(videoId, result);
  }
  for (const videoId of cuisinePending) {
    const input = inputs.get(videoId);
    if (!input) continue;
    const key = cuisineClassificationCacheKey(input, model);
    const response = cuisineCache.entries[key] ?? jevResults.get(videoId)?.cuisine;
    if (!response) {
      failures++;
      continue;
    }
    if (!cuisineCache.entries[key]) {
      cuisineCache.entries[key] = response;
      cuisineCacheChanged = true;
    }
    const cuisine = applyAiCuisineResponse(response);
    if (cuisine !== undefined) cuisines.set(videoId, cuisine);
  }
  if (mealCacheChanged) await deps.writeAiMealCache(mealCachePath, mealCache);
  if (cuisineCacheChanged) await deps.writeAiCuisineCache(cuisineCachePath, cuisineCache);

  const mealsSent = requests.filter(({ needsMeal }) => needsMeal).length;
  const cuisinesSent = requests.filter(({ needsCuisine }) => needsCuisine).length;
  console.log(
    `Classification summary: candidates=${candidates.length}, model=${model}, jevRequests=${requests.length}, ` +
    `validJevResponses=${jevResults.size}. ` +
    `Meal: corrected=${candidates.length - mealPending.size}, cacheHits=${mealPending.size - mealsSent}, sentToJev=${mealsSent}, ` +
    `decidedByJev=${mealsByJev}, regexFallback=${mealPending.size - mealsByJev}. ` +
    `Cuisine: corrected=${candidates.length - cuisinePending.size}, cacheHits=${cuisinePending.size - cuisinesSent}, sentToJev=${cuisinesSent}, ` +
    `decidedByJev=${cuisines.size} (unclear=${[...cuisines.values()].filter((value) => value === null).length}), ` +
    `regexFallback=${cuisinePending.size - cuisines.size}.`
  );
  if (failures) console.warn(`${failures} AI classifications failed or returned invalid output.`);
  return { meals, cuisines };
}

async function fetchChannelVideos(channel: (typeof CHANNELS)[number], apiKey: string): Promise<VideoSource[]> {
  const channelData = await youtube<{ items: Array<{ contentDetails: { relatedPlaylists: { uploads: string } } }> }>(
    "channels",
    { part: "contentDetails", id: channel.id },
    apiKey
  );
  const uploads = channelData.items[0]?.contentDetails.relatedPlaylists.uploads;
  if (!uploads) throw new Error(`Uploads playlist not found for ${channel.name}`);

  const snippets: Array<{
    videoId: string;
    title: string;
    description: string;
    publishedAt: string;
    thumbnailUrl: string;
  }> = [];
  let pageToken: string | undefined;
  do {
    const page = await youtube<{
      nextPageToken?: string;
      items: Array<{
        contentDetails: { videoId: string; videoPublishedAt: string };
        snippet: { title: string; description: string; thumbnails: Record<string, { url: string }> };
      }>;
    }>("playlistItems", { part: "snippet,contentDetails", playlistId: uploads, maxResults: "50", pageToken }, apiKey);
    snippets.push(...page.items.map((item) => ({
      videoId: item.contentDetails.videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      publishedAt: item.contentDetails.videoPublishedAt,
      thumbnailUrl: item.snippet.thumbnails.maxres?.url ?? item.snippet.thumbnails.high?.url ?? item.snippet.thumbnails.default?.url ?? ""
    })));
    pageToken = page.nextPageToken;
  } while (pageToken);

  const durations = new Map<string, number | null>();
  for (let index = 0; index < snippets.length; index += 50) {
    const ids = snippets.slice(index, index + 50).map(({ videoId }) => videoId);
    const details = await youtube<{ items: Array<{ id: string; contentDetails: { duration: string } }> }>(
      "videos",
      { part: "contentDetails", id: ids.join(",") },
      apiKey
    );
    details.items.forEach((item) => durations.set(item.id, parseIsoDuration(item.contentDetails.duration)));
  }

  return snippets.map((snippet) => ({
    ...snippet,
    channelId: channel.id,
    channelName: channel.name,
    durationSeconds: durations.get(snippet.videoId) ?? null
  }));
}

async function youtube<T>(resource: string, params: Record<string, string | undefined>, apiKey: string): Promise<T> {
  const url = new URL(`${API_ROOT}/${resource}`);
  for (const [name, value] of Object.entries(params)) if (value) url.searchParams.set(name, value);
  url.searchParams.set("key", apiKey);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`YouTube API ${resource} failed (${response.status})`);
  return response.json() as Promise<T>;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

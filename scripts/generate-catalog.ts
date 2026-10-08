import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyOverrides, CHANNELS, inferCuisine, isCatalogCandidate, parseIsoDuration, type CatalogOverrides, type VideoSource } from "./catalog";
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
  /** Cuisines assigned by the AI fallback, only for recipes the regex rules left unclassified. */
  cuisines: Map<string, Cuisine>;
}

const defaultClassifyRecipesDeps: ClassifyRecipesDeps = {
  readAiMealCache,
  writeAiMealCache,
  readAiCuisineCache,
  writeAiCuisineCache,
  classifyWithJev
};

/**
 * Runs the regex rules on every candidate, then sends only unresolved meal types
 * and unclassified cuisines to Jev. Corrections always take priority.
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
  const cuisines = new Map<string, Cuisine>();
  const mealUnresolved = new Set(
    [...meals].filter(([videoId, result]) => result.needsAi && !overrides.corrections[videoId]?.mealTypes).map(([videoId]) => videoId)
  );
  const cuisineUnresolved = new Set(
    [...inputs]
      .filter(([videoId, input]) => overrides.corrections[videoId]?.cuisine == null && inferCuisine(`${input.title} ${input.description}`) === null)
      .map(([videoId]) => videoId)
  );

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterKey) {
    if (process.env.CLASSIFIER_REQUIRED === "true") throw new Error("OPENROUTER_API_KEY is required for Jev classification");
    if (mealUnresolved.size || cuisineUnresolved.size) {
      console.warn(
        `${mealUnresolved.size} meal and ${cuisineUnresolved.size} cuisine classifications unresolved; ` +
        "set OPENROUTER_API_KEY to enable Jev classification."
      );
    }
    return { meals, cuisines };
  }

  const model = process.env.JEV_MODEL || DEFAULT_JEV_MODEL;
  const [mealCache, cuisineCache] = await Promise.all([deps.readAiMealCache(mealCachePath), deps.readAiCuisineCache(cuisineCachePath)]);
  const requests: AiClassificationRequest[] = [...new Set([...mealUnresolved, ...cuisineUnresolved])].flatMap((id) => {
    const input = inputs.get(id);
    if (!input) return [];
    const needsMeal = mealUnresolved.has(id) && !mealCache.entries[mealClassificationCacheKey(input, model)];
    const needsCuisine = cuisineUnresolved.has(id) && !cuisineCache.entries[cuisineClassificationCacheKey(input, model)];
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
  for (const videoId of mealUnresolved) {
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
    meals.set(videoId, applyAiMealResponse(deterministic, response));
  }
  for (const videoId of cuisineUnresolved) {
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
    if (cuisine) cuisines.set(videoId, cuisine);
  }
  if (mealCacheChanged) await deps.writeAiMealCache(mealCachePath, mealCache);
  if (cuisineCacheChanged) await deps.writeAiCuisineCache(cuisineCachePath, cuisineCache);

  const mealsRemaining = [...mealUnresolved].filter((id) => meals.get(id)?.needsAi).length;
  const mealsSent = requests.filter(({ needsMeal }) => needsMeal);
  const cuisinesSent = requests.filter(({ needsCuisine }) => needsCuisine);
  console.log(
    `Classification summary: candidates=${candidates.length}, model=${model}, jevRequests=${requests.length}, ` +
    `validJevResponses=${jevResults.size}. ` +
    `Meal: resolvedByRules=${candidates.length - mealUnresolved.size}, cacheHits=${mealUnresolved.size - mealsSent.length}, ` +
    `sentToJev=${mealsSent.length}, resolvedByJev=${mealsSent.filter(({ id }) => meals.get(id)?.needsAi === false).length}, ` +
    `unresolved=${mealsRemaining}. ` +
    `Cuisine: resolvedByRules=${candidates.length - cuisineUnresolved.size}, cacheHits=${cuisineUnresolved.size - cuisinesSent.length}, ` +
    `sentToJev=${cuisinesSent.length}, resolvedByJev=${cuisinesSent.filter(({ id }) => cuisines.has(id)).length}, ` +
    `unresolved=${cuisineUnresolved.size - cuisines.size}.`
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

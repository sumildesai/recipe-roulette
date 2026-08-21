import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyOverrides, CHANNELS, isCatalogCandidate, parseIsoDuration, type CatalogOverrides, type VideoSource } from "./catalog";
import {
  applyAiMealResponse,
  classifyMealsWithCopilot,
  inferMealClassification,
  mealClassificationCacheKey,
  readAiMealCache,
  writeAiMealCache,
  type AiMealResponse,
  type AiMealRequest
} from "./meal-classification";
import type { Catalog } from "../lib/types";
import { loadNytRecipes, NYT_COOKING_SOURCE } from "./nytimes-recipes";

const API_ROOT = "https://www.googleapis.com/youtube/v3";
const outputPath = path.resolve(process.env.CATALOG_OUTPUT_PATH ?? "public/recipes.local.json");
const overridesPath = path.resolve("data/catalog-overrides.json");
const aiCachePath = path.resolve(".catalog-cache/meal-type-ai.json");

async function main() {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error("YOUTUBE_API_KEY is required to generate the catalog");

  const overrides = JSON.parse(await readFile(overridesPath, "utf8")) as CatalogOverrides;
  const videos = (await Promise.all(CHANNELS.map((channel) => fetchChannelVideos(channel, apiKey)))).flat();
  const mealClassifications = await classifyMealTypes(videos, overrides);
  const recipes = [...applyOverrides(videos, overrides, mealClassifications), ...loadNytRecipes()]
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

export interface ClassifyMealTypesDeps {
  readAiMealCache: typeof readAiMealCache;
  writeAiMealCache: typeof writeAiMealCache;
  classifyMealsWithCopilot: typeof classifyMealsWithCopilot;
}

const defaultClassifyMealTypesDeps: ClassifyMealTypesDeps = {
  readAiMealCache,
  writeAiMealCache,
  classifyMealsWithCopilot
};

export async function classifyMealTypes(
  videos: VideoSource[],
  overrides: CatalogOverrides,
  deps: ClassifyMealTypesDeps = defaultClassifyMealTypesDeps
) {
  const excluded = new Set(overrides.exclude);
  const included = new Set(overrides.include);
  const candidates = videos.filter((video) => isCatalogCandidate(video, overrides, excluded, included));
  const inputs = new Map(candidates.map((video) => {
    const correction = overrides.corrections[video.videoId];
    const input = { title: correction?.title ?? video.title, description: correction?.description ?? video.description };
    return [video.videoId, input];
  }));
  const classifications = new Map(
    [...inputs].map(([videoId, input]) => [videoId, inferMealClassification(input)])
  );
  const unresolved = [...classifications.entries()].filter(([videoId, result]) => result.needsAi && !overrides.corrections[videoId]?.mealTypes);
  const copilotToken = process.env.COPILOT_GITHUB_TOKEN;
  if (!copilotToken) {
    if (process.env.MEAL_CLASSIFIER_REQUIRED === "true") throw new Error("COPILOT_GITHUB_TOKEN is required for Copilot classification");
    if (unresolved.length) console.warn(`${unresolved.length} meal classifications unresolved; set COPILOT_GITHUB_TOKEN to enable Copilot classification.`);
    return classifications;
  }

  const cache = await deps.readAiMealCache(aiCachePath);
  let cacheChanged = false;
  let failures = 0;
  const uncached: AiMealRequest[] = unresolved.flatMap(([videoId]) => {
    const input = inputs.get(videoId);
    return input && !cache.entries[mealClassificationCacheKey(input)] ? [{ id: videoId, input }] : [];
  });
  let copilotResponses = new Map<string, AiMealResponse>();
  if (uncached.length) {
    try {
      copilotResponses = await deps.classifyMealsWithCopilot(uncached, copilotToken);
    } catch (error) {
      console.warn(`Copilot meal classifier failed: ${error instanceof Error ? error.message : error}`);
    }
  }
  for (const [videoId, deterministic] of unresolved) {
    const input = inputs.get(videoId);
    if (!input) continue;
    const key = mealClassificationCacheKey(input);
    const response = cache.entries[key] ?? copilotResponses.get(videoId);
    if (!response) {
      failures++;
      continue;
    }
    if (!cache.entries[key]) {
      cache.entries[key] = response;
      cacheChanged = true;
    }
    classifications.set(videoId, applyAiMealResponse(deterministic, response));
  }
  if (cacheChanged) await deps.writeAiMealCache(aiCachePath, cache);
  const remaining = [...classifications.values()].filter(({ needsAi }) => needsAi).length;
  const copilotResolved = uncached.filter(({ id }) => classifications.get(id)?.needsAi === false).length;
  console.log(
    `Meal classification summary: candidates=${candidates.length}, resolvedWithoutCopilot=${candidates.length - unresolved.length}, ` +
    `cacheHits=${unresolved.length - uncached.length}, sentToCopilot=${uncached.length}, ` +
    `validCopilotResponses=${copilotResponses.size}, resolvedByCopilot=${copilotResolved}, unresolved=${remaining}.`
  );
  if (remaining) console.warn(`${remaining} meal classifications unresolved after AI classification.`);
  if (failures) console.warn(`${failures} AI classifications failed or returned invalid output.`);
  return classifications;
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

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyOverrides, CHANNELS, parseIsoDuration, type CatalogOverrides, type VideoSource } from "./catalog";
import type { Catalog } from "../lib/types";

const API_ROOT = "https://www.googleapis.com/youtube/v3";
const outputPath = path.resolve("public/recipes.json");
const overridesPath = path.resolve("data/catalog-overrides.json");

async function main() {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error("YOUTUBE_API_KEY is required to generate the catalog");

  const overrides = JSON.parse(await readFile(overridesPath, "utf8")) as CatalogOverrides;
  const videos = (await Promise.all(CHANNELS.map((channel) => fetchChannelVideos(channel, apiKey)))).flat();
  const recipes = applyOverrides(videos, overrides);
  const catalog: Catalog = {
    version: 1,
    source: "youtube",
    updatedThrough: recipes[0]?.publishedAt ?? null,
    sourceChannels: CHANNELS.map(({ id, name }) => ({ id, name })),
    recipes
  };
  await writeFile(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  console.log(`Wrote ${recipes.length} recipes to ${outputPath}`);
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

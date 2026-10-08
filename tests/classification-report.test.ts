import { describe, expect, it } from "vitest";
import type { ClassificationRunSummary, RecipeClassificationDetail } from "@/lib/classification-report";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildClassificationReport,
  callMetrics,
  HISTORY_LIMIT,
  isBaselineCandidate,
  percentile,
  pinBaselineReport,
  renderStepSummary
} from "@/scripts/classification-report";

function detail(overrides: Partial<RecipeClassificationDetail> & { videoId: string }): RecipeClassificationDetail {
  return {
    title: `Recipe ${overrides.videoId}`,
    channelName: "Ranveer Brar",
    regex: { mealTypes: ["dinner"], cuisine: "Indian" },
    jev: { meal: { dinner: 0.95 }, cuisine: { choice: "Indian", confidence: 0.97 } },
    final: { mealTypes: ["dinner"], cuisine: "Indian" },
    source: { meal: "jev", cuisine: "jev" },
    ...overrides
  };
}

const details: RecipeClassificationDetail[] = [
  detail({ videoId: "agree" }),
  detail({
    videoId: "momo",
    title: "Mushroom Momo | Pockets",
    regex: { mealTypes: ["drink"], cuisine: null },
    jev: { meal: { snack: 0.78, drink: 0.02 }, cuisine: { choice: "Indo-Chinese", confidence: 0.58 } },
    final: { mealTypes: ["snack"], cuisine: null },
    source: { meal: "jev", cuisine: "regex" }
  }),
  detail({
    videoId: "unclear",
    jev: { meal: { dinner: 0.4 }, cuisine: { choice: "unclear", confidence: 0.92 } },
    final: { mealTypes: ["dinner"], cuisine: null },
    source: { meal: "regex", cuisine: "jev" }
  }),
  detail({ videoId: "fixed", jev: {}, final: { mealTypes: ["snack"], cuisine: "Indian" }, source: { meal: "correction", cuisine: "correction" } })
];

const previousRun: ClassificationRunSummary = {
  generatedAt: "2026-10-05T05:17:00.000Z", model: "typesafe/jev-1.13", recipes: 3, jevCalls: 10, costUsd: 0.0005,
  latencyP50Ms: 320, mealDecidedByJev: 2, cuisineDecidedByJev: 2, mealChangedFromRegex: 1, cuisineChangedFromRegex: 0, failedCalls: 0
};

describe("classification report", () => {
  const report = buildClassificationReport({
    generatedAt: "2026-10-09T05:17:00.000Z",
    model: "typesafe/jev-1.13",
    threshold: 0.7,
    details,
    calls: [
      { ok: true, attempts: 1, latencyMs: 300, usage: { inputTokens: 1000, outputTokens: 100, cost: 0.00005 } },
      { ok: true, attempts: 2, latencyMs: 900, usage: { inputTokens: 1000, outputTokens: 100, cost: 0.00005 } },
      { ok: false, attempts: 3, latencyMs: 4000 }
    ],
    history: [previousRun]
  });

  it("counts who decided each field and where Jev changed the regex answer", () => {
    expect(report.meal).toMatchObject({ decidedByJev: 2, regexFallback: 1, corrected: 1, changedFromRegex: 1 });
    expect(report.cuisine).toMatchObject({ decidedByJev: 2, regexFallback: 1, corrected: 1, changedFromRegex: 1, unclear: 1 });
    expect(report.disagreements.map(({ videoId }) => videoId)).toEqual(["momo", "unclear"]);
    expect(report.unclear.map(({ videoId }) => videoId)).toEqual(["unclear"]);
  });

  it("buckets Jev confidence and finds borderline calls nearest the threshold first", () => {
    expect(report.meal.confidence).toEqual({ "0.9+": 1, "0.7-0.9": 1, "0.5-0.7": 0, "<0.5": 1 });
    expect(report.cuisine.confidence).toEqual({ "0.9+": 2, "0.7-0.9": 0, "0.5-0.7": 1, "<0.5": 0 });
    expect(report.borderline.map(({ videoId }) => videoId)).toEqual(["momo"]);
  });

  it("summarizes call cost, tokens, retries, and latency, and appends history", () => {
    expect(report.thisRun).toEqual({
      calls: 3, succeeded: 2, failed: 1, retried: 2, inputTokens: 2000, outputTokens: 200, costUsd: 0.0001,
      latencyMs: { p50: 300, p95: 900, max: 900 }
    });
    expect(report.history).toHaveLength(2);
    expect(report.history[1]).toMatchObject({ jevCalls: 3, costUsd: 0.0001, mealChangedFromRegex: 1, cuisineChangedFromRegex: 1 });
    expect(report.allTime).toEqual({ runs: 2, jevCalls: 13, costUsd: 0.0006 });
  });

  it("caps history length", () => {
    const long = buildClassificationReport({
      generatedAt: "2026-10-09T05:17:00.000Z", model: "m", threshold: 0.7, details: [], calls: [],
      history: Array.from({ length: HISTORY_LIMIT + 5 }, () => previousRun)
    });
    expect(long.history).toHaveLength(HISTORY_LIMIT);
    expect(callMetrics([]).latencyMs).toEqual({ p50: null, p95: null, max: null });
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
  });

  it("renders a markdown step summary with escaped titles", () => {
    const markdown = renderStepSummary(report);
    expect(markdown).toContain("## Jev classification report");
    expect(markdown).toContain("| Decided by Jev | 2 | 2 |");
    expect(markdown).toContain("Mushroom Momo \\| Pockets | drink / none | snack / none |");
  });
});

describe("baseline pinning", () => {
  const full = (recipes: number, succeeded: number) => buildClassificationReport({
    generatedAt: "2026-10-09T05:17:00.000Z", model: "m", threshold: 0.7, history: [],
    details: Array.from({ length: recipes }, (_, index) => detail({ videoId: `v${index}` })),
    calls: Array.from({ length: succeeded }, () => ({ ok: true, attempts: 1, latencyMs: 300 }))
  });

  it("pins only the first run where Jev answered for most of the catalog", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-"));
    const baselinePath = path.join(dir, "classification-baseline.json");
    try {
      expect(isBaselineCandidate(full(10, 10))).toBe(false);
      expect(await pinBaselineReport(baselinePath, full(100, 3))).toBe(false);
      expect(await pinBaselineReport(baselinePath, full(100, 95))).toBe(true);
      expect(await pinBaselineReport(baselinePath, full(120, 120))).toBe(false);
      expect(JSON.parse(await readFile(baselinePath, "utf8"))).toMatchObject({ recipes: 100, thisRun: { calls: 95 } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

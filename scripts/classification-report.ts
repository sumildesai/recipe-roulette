import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ClassificationReport,
  ClassificationRunSummary,
  ConfidenceBuckets,
  FieldOutcomes,
  JevCallMetrics,
  RecipeClassificationDetail
} from "../lib/classification-report";
import type { JevCallStats } from "./jev-client";

export const HISTORY_LIMIT = 100;
export const BORDERLINE_MARGIN = 0.1;
const LIST_LIMIT = 200;

export interface BuildReportInput {
  generatedAt: string;
  model: string;
  threshold: number;
  details: RecipeClassificationDetail[];
  calls: JevCallStats[];
  history: ClassificationRunSummary[];
}

export function buildClassificationReport(input: BuildReportInput): ClassificationReport {
  const { details, threshold } = input;
  const thisRun = callMetrics(input.calls);
  const meal = fieldOutcomes(details, "meal", topMealConfidence);
  const cuisine = fieldOutcomes(details, "cuisine", (detail) => detail.jev.cuisine?.confidence);
  const unclear = details.filter((detail) => detail.source.cuisine === "jev" && detail.final.cuisine === null);
  const summary: ClassificationRunSummary = {
    generatedAt: input.generatedAt,
    model: input.model,
    recipes: details.length,
    jevCalls: thisRun.calls,
    costUsd: thisRun.costUsd,
    latencyP50Ms: thisRun.latencyMs.p50,
    mealDecidedByJev: meal.decidedByJev,
    cuisineDecidedByJev: cuisine.decidedByJev,
    mealChangedFromRegex: meal.changedFromRegex,
    cuisineChangedFromRegex: cuisine.changedFromRegex,
    failedCalls: thisRun.failed
  };
  const history = [...input.history, summary].slice(-HISTORY_LIMIT);
  return {
    version: 1,
    generatedAt: input.generatedAt,
    model: input.model,
    threshold,
    recipes: details.length,
    meal,
    cuisine: { ...cuisine, unclear: unclear.length },
    thisRun,
    allTime: {
      runs: history.length,
      jevCalls: history.reduce((sum, run) => sum + run.jevCalls, 0),
      costUsd: roundUsd(history.reduce((sum, run) => sum + run.costUsd, 0))
    },
    disagreements: details.filter((detail) => mealChanged(detail) || cuisineChanged(detail)).slice(0, LIST_LIMIT),
    borderline: details
      .map((detail) => ({ detail, distance: borderlineDistance(detail, threshold) }))
      .filter(({ distance }) => distance < BORDERLINE_MARGIN)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, LIST_LIMIT)
      .map(({ detail }) => detail),
    unclear: unclear.slice(0, LIST_LIMIT),
    history
  };
}

export function mealChanged(detail: RecipeClassificationDetail): boolean {
  return detail.source.meal === "jev" && !sameSet(detail.final.mealTypes, detail.regex.mealTypes);
}

export function cuisineChanged(detail: RecipeClassificationDetail): boolean {
  return detail.source.cuisine === "jev" && detail.final.cuisine !== detail.regex.cuisine;
}

function fieldOutcomes(
  details: RecipeClassificationDetail[],
  field: "meal" | "cuisine",
  confidenceOf: (detail: RecipeClassificationDetail) => number | undefined
): FieldOutcomes {
  const confidence: ConfidenceBuckets = { "0.9+": 0, "0.7-0.9": 0, "0.5-0.7": 0, "<0.5": 0 };
  for (const detail of details) {
    const value = confidenceOf(detail);
    if (value === undefined) continue;
    confidence[value >= 0.9 ? "0.9+" : value >= 0.7 ? "0.7-0.9" : value >= 0.5 ? "0.5-0.7" : "<0.5"]++;
  }
  const changed = field === "meal" ? mealChanged : cuisineChanged;
  return {
    corrected: details.filter((detail) => detail.source[field] === "correction").length,
    decidedByJev: details.filter((detail) => detail.source[field] === "jev").length,
    regexFallback: details.filter((detail) => detail.source[field] === "regex").length,
    changedFromRegex: details.filter(changed).length,
    confidence
  };
}

function topMealConfidence(detail: RecipeClassificationDetail): number | undefined {
  const values = Object.values(detail.jev.meal ?? {});
  return values.length ? Math.max(...values) : undefined;
}

/** Smallest distance between the threshold and any Jev probability that decided (or nearly decided) a label. */
function borderlineDistance(detail: RecipeClassificationDetail, threshold: number): number {
  const values = [...Object.values(detail.jev.meal ?? {}), ...(detail.jev.cuisine ? [detail.jev.cuisine.confidence] : [])];
  return values.length ? Math.min(...values.map((value) => Math.abs(value - threshold))) : Infinity;
}

export function callMetrics(calls: JevCallStats[]): JevCallMetrics {
  const latencies = calls.filter(({ ok }) => ok).map(({ latencyMs }) => latencyMs).sort((a, b) => a - b);
  return {
    calls: calls.length,
    succeeded: calls.filter(({ ok }) => ok).length,
    failed: calls.filter(({ ok }) => !ok).length,
    retried: calls.filter(({ attempts }) => attempts > 1).length,
    inputTokens: calls.reduce((sum, call) => sum + (call.usage?.inputTokens ?? 0), 0),
    outputTokens: calls.reduce((sum, call) => sum + (call.usage?.outputTokens ?? 0), 0),
    costUsd: roundUsd(calls.reduce((sum, call) => sum + (call.usage?.cost ?? 0), 0)),
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.at(-1) ?? null }
  };
}

export function percentile(sorted: number[], fraction: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

function roundUsd(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

export const BASELINE_MIN_RECIPES = 20;

/**
 * The first run where Jev answered for most of the catalog (normally the first
 * full refresh) is pinned as a baseline so its call counts and cost survive
 * later, mostly cached runs.
 */
export function isBaselineCandidate(report: ClassificationReport): boolean {
  return report.recipes >= BASELINE_MIN_RECIPES && report.thisRun.succeeded >= report.recipes / 2;
}

/** Writes the baseline only if none exists yet. Returns whether it was written. */
export async function pinBaselineReport(baselinePath: string, report: ClassificationReport): Promise<boolean> {
  if (!isBaselineCandidate(report)) return false;
  try {
    await mkdir(path.dirname(baselinePath), { recursive: true });
    await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export async function readClassificationHistory(historyPath: string): Promise<ClassificationRunSummary[]> {
  try {
    const value: unknown = JSON.parse(await readFile(historyPath, "utf8"));
    return Array.isArray(value) ? value.filter((run): run is ClassificationRunSummary =>
      typeof run === "object" && run !== null && typeof run.generatedAt === "string" && typeof run.jevCalls === "number"
    ) : [];
  } catch {
    return [];
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function renderStepSummary(report: ClassificationReport): string {
  const usd = (value: number) => `$${value.toFixed(value < 0.01 ? 5 : 2)}`;
  const ms = (value: number | null) => (value === null ? "n/a" : `${value} ms`);
  const labels = (detail: RecipeClassificationDetail, side: "regex" | "final") =>
    `${detail[side].mealTypes.join(", ") || "none"} / ${detail[side].cuisine ?? "none"}`;
  const escape = (text: string) => text.replace(/\|/g, "\\|").slice(0, 80);
  const lines = [
    "## Jev classification report",
    "",
    `Model \`${report.model}\`, threshold ${report.threshold}, ${report.recipes} recipes.`,
    "",
    "| | Meal type | Cuisine |",
    "|---|---|---|",
    `| Decided by Jev | ${report.meal.decidedByJev} | ${report.cuisine.decidedByJev} |`,
    `| Changed from regex | ${report.meal.changedFromRegex} | ${report.cuisine.changedFromRegex} |`,
    `| Regex fallback | ${report.meal.regexFallback} | ${report.cuisine.regexFallback} |`,
    `| Corrections | ${report.meal.corrected} | ${report.cuisine.corrected} |`,
    `| Confidence 0.9+ / 0.7-0.9 / 0.5-0.7 / <0.5 | ${Object.values(report.meal.confidence).join(" / ")} | ${Object.values(report.cuisine.confidence).join(" / ")} |`,
    "",
    `**This run:** ${report.thisRun.calls} Jev calls (${report.thisRun.failed} failed, ${report.thisRun.retried} retried), ` +
      `${report.thisRun.inputTokens + report.thisRun.outputTokens} tokens, ${usd(report.thisRun.costUsd)}, ` +
      `latency p50 ${ms(report.thisRun.latencyMs.p50)} / p95 ${ms(report.thisRun.latencyMs.p95)}.`,
    `**All time:** ${report.allTime.runs} runs, ${report.allTime.jevCalls} calls, ${usd(report.allTime.costUsd)}.`,
    ""
  ];
  if (report.disagreements.length) {
    lines.push("### Where Jev overruled the regex (first 15)", "", "| Recipe | Regex | Jev |", "|---|---|---|");
    for (const detail of report.disagreements.slice(0, 15)) {
      lines.push(`| ${escape(detail.title)} | ${labels(detail, "regex")} | ${labels(detail, "final")} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

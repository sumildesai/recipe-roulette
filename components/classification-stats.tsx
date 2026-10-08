"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type {
  ClassificationReport,
  ConfidenceBuckets,
  FieldOutcomes,
  RecipeClassificationDetail
} from "@/lib/classification-report";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const CATALOG_VERSION = process.env.NEXT_PUBLIC_CATALOG_VERSION ?? "local";
const reportPaths = (name: string) => process.env.NODE_ENV === "production"
  ? [`${name}.json`]
  : [`${name}.local.json`, `${name}.json`];

async function fetchReport(name: string, signal: AbortSignal): Promise<ClassificationReport | null> {
  for (const reportPath of reportPaths(name)) {
    const response = await fetch(`${BASE_PATH}/${reportPath}?v=${encodeURIComponent(CATALOG_VERSION)}`, { signal, cache: "no-store" });
    if (response.ok) return response.json() as Promise<ClassificationReport>;
    if (response.status !== 404) throw new Error(`Report request failed (${response.status})`);
  }
  return null;
}

export function ClassificationStats() {
  const [report, setReport] = useState<ClassificationReport | null | undefined>(undefined);
  const [baseline, setBaseline] = useState<ClassificationReport | null>(null);
  const [view, setView] = useState<"latest" | "baseline">("latest");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetchReport("classification-baseline", controller.signal).then(setBaseline).catch(() => undefined);
    fetchReport("classification-report", controller.signal)
      .then(setReport)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load the report");
      });
    return () => controller.abort();
  }, []);

  return (
    <div className="page-shell stats-page">
      <header>
        <p className="eyebrow">Under the hood</p>
        <h1>How Jev sorted the recipes</h1>
        <p className="intro">
          Every recipe&apos;s meal type and cuisine is decided by Jev, a small decision model. The keyword rules only step in
          when Jev is unsure. Here is how the latest catalog refresh went.
        </p>
        <p><Link href="/">← Back to the roulette</Link></p>
      </header>
      {error ? (
        <section className="status error" role="alert"><p>{error}</p></section>
      ) : report === undefined ? (
        <section className="status"><p>Loading report…</p></section>
      ) : report === null && !baseline ? (
        <section className="status"><p>No classification report yet. One is published after the next catalog refresh.</p></section>
      ) : (
        <>
          {baseline && report && (
            <div className="stats-tabs" role="tablist" aria-label="Report">
              <button type="button" role="tab" aria-selected={view === "latest"} onClick={() => setView("latest")}>
                Latest run
              </button>
              <button type="button" role="tab" aria-selected={view === "baseline"} onClick={() => setView("baseline")}>
                First full run ({formatDate(baseline.generatedAt)})
              </button>
            </div>
          )}
          {view === "baseline" || !report ? (
            <>
              {baseline && (
                <p className="stats-note stats-baseline-note">
                  Pinned snapshot of the first refresh where Jev classified the whole catalog. Later runs never replace it.
                </p>
              )}
              {baseline && <Report report={baseline} />}
            </>
          ) : (
            <Report report={report} />
          )}
        </>
      )}
    </div>
  );
}

function Report({ report }: { report: ClassificationReport }) {
  const decided = report.meal.decidedByJev + report.cuisine.decidedByJev;
  const changed = report.meal.changedFromRegex + report.cuisine.changedFromRegex;
  return (
    <>
      <section className="stat-cards" aria-label="Headline numbers">
        <Card value={report.recipes} label="recipes classified" />
        <Card value={decided} label="labels decided by Jev" />
        <Card value={changed} label="labels where Jev overruled the keyword rules" />
        <Card value={formatUsd(report.allTime.costUsd)} label={`total Jev cost over ${report.allTime.runs} run${report.allTime.runs === 1 ? "" : "s"}`} />
      </section>

      <section className="stats-panel">
        <h2>Who decided each label</h2>
        <table>
          <thead><tr><th scope="col" /><th scope="col">Meal type</th><th scope="col">Cuisine</th></tr></thead>
          <tbody>
            <OutcomeRow label="Jev" field="decidedByJev" meal={report.meal} cuisine={report.cuisine} />
            <OutcomeRow label="Keyword rules (Jev unsure or unavailable)" field="regexFallback" meal={report.meal} cuisine={report.cuisine} />
            <OutcomeRow label="Manual corrections" field="corrected" meal={report.meal} cuisine={report.cuisine} />
            <OutcomeRow label="Jev disagreed with the keyword rules" field="changedFromRegex" meal={report.meal} cuisine={report.cuisine} />
          </tbody>
        </table>
        <p className="stats-note">
          Jev answers count when confidence is at least {report.threshold}. {report.cuisine.unclear} {report.cuisine.unclear === 1 ? "recipe was" : "recipes were"} confidently
          &ldquo;unclear&rdquo; for cuisine. Model <code>{report.model}</code>, generated {formatDate(report.generatedAt)}.
        </p>
      </section>

      <section className="stats-panel">
        <h2>How confident was Jev?</h2>
        <div className="confidence-grid">
          <ConfidenceBars title="Meal type (top answer)" buckets={report.meal.confidence} />
          <ConfidenceBars title="Cuisine" buckets={report.cuisine.confidence} />
        </div>
      </section>

      <section className="stats-panel">
        <h2>This run</h2>
        <ul className="run-facts">
          <li><strong>{report.thisRun.calls}</strong> new Jev calls (the rest came from cache)</li>
          <li><strong>{formatUsd(report.thisRun.costUsd)}</strong> spent</li>
          <li><strong>{report.thisRun.inputTokens + report.thisRun.outputTokens}</strong> tokens</li>
          <li>Latency p50 <strong>{formatMs(report.thisRun.latencyMs.p50)}</strong>, p95 <strong>{formatMs(report.thisRun.latencyMs.p95)}</strong></li>
          <li><strong>{report.thisRun.failed}</strong> failed, <strong>{report.thisRun.retried}</strong> retried</li>
        </ul>
      </section>

      <DetailTable
        title="Where Jev overruled the keyword rules"
        empty="Jev agreed with the keyword rules on every recipe."
        details={report.disagreements}
      />
      <DetailTable
        title="Borderline calls"
        empty="No answers landed near the confidence threshold."
        details={report.borderline}
        note={`Jev's confidence was within 0.1 of the ${report.threshold} threshold.`}
      />
      <DetailTable title="Cuisine: unclear" empty="Jev placed every recipe in a cuisine." details={report.unclear} />

      {report.history.length > 1 && (
        <section className="stats-panel">
          <h2>Run history</h2>
          <table>
            <thead>
              <tr><th scope="col">Run</th><th scope="col">Recipes</th><th scope="col">Jev calls</th><th scope="col">Cost</th><th scope="col">Overruled</th><th scope="col">p50</th></tr>
            </thead>
            <tbody>
              {[...report.history].reverse().map((run) => (
                <tr key={run.generatedAt}>
                  <td>{formatDate(run.generatedAt)}</td>
                  <td>{run.recipes}</td>
                  <td>{run.jevCalls}</td>
                  <td>{formatUsd(run.costUsd)}</td>
                  <td>{run.mealChangedFromRegex + run.cuisineChangedFromRegex}</td>
                  <td>{formatMs(run.latencyP50Ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

function Card({ value, label }: { value: number | string; label: string }) {
  return <div className="stat-card"><strong>{value}</strong><span>{label}</span></div>;
}

function OutcomeRow({ label, field, meal, cuisine }: { label: string; field: keyof Omit<FieldOutcomes, "confidence">; meal: FieldOutcomes; cuisine: FieldOutcomes }) {
  return <tr><th scope="row">{label}</th><td>{meal[field]}</td><td>{cuisine[field]}</td></tr>;
}

function ConfidenceBars({ title, buckets }: { title: string; buckets: ConfidenceBuckets }) {
  const total = Object.values(buckets).reduce((sum, value) => sum + value, 0) || 1;
  return (
    <div>
      <h3>{title}</h3>
      {(Object.entries(buckets) as Array<[keyof ConfidenceBuckets, number]>).map(([bucket, count]) => (
        <div className="confidence-row" key={bucket}>
          <span>{bucket}</span>
          <span className="confidence-bar" aria-hidden="true"><span style={{ width: `${(count / total) * 100}%` }} /></span>
          <span>{count}</span>
        </div>
      ))}
    </div>
  );
}

function DetailTable({ title, empty, details, note }: { title: string; empty: string; details: RecipeClassificationDetail[]; note?: string }) {
  return (
    <section className="stats-panel">
      <h2>{title} ({details.length})</h2>
      {note && <p className="stats-note">{note}</p>}
      {details.length === 0 ? <p>{empty}</p> : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th scope="col">Recipe</th><th scope="col">Keyword rules</th><th scope="col">Jev</th><th scope="col">Final</th></tr>
            </thead>
            <tbody>
              {details.map((detail) => (
                <tr key={detail.videoId}>
                  <th scope="row">
                    <a href={`https://www.youtube.com/watch?v=${detail.videoId}`} target="_blank" rel="noreferrer">{detail.title}</a>
                    <small>{detail.channelName}</small>
                  </th>
                  <td>{formatLabels(detail.regex.mealTypes, detail.regex.cuisine)}</td>
                  <td>{formatJev(detail)}</td>
                  <td>{formatLabels(detail.final.mealTypes, detail.final.cuisine)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function formatLabels(mealTypes: string[], cuisine: string | null): string {
  return `${mealTypes.join(", ") || "no meal"} · ${cuisine ?? "no cuisine"}`;
}

function formatJev(detail: RecipeClassificationDetail): string {
  const meal = Object.entries(detail.jev.meal ?? {})
    .filter(([, probability]) => (probability ?? 0) >= 0.3)
    .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
    .map(([label, probability]) => `${label} ${(probability ?? 0).toFixed(2)}`)
    .join(", ");
  const cuisine = detail.jev.cuisine ? `${detail.jev.cuisine.choice} ${detail.jev.cuisine.confidence.toFixed(2)}` : "";
  return [meal || (detail.jev.meal ? "no meal ≥ 0.30" : ""), cuisine].filter(Boolean).join(" · ") || "not asked";
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 5 : value < 1 ? 4 : 2)}`;
}

function formatMs(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value)} ms`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

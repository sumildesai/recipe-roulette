import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClassificationStats } from "@/components/classification-stats";
import { buildClassificationReport } from "@/scripts/classification-report";

const report = buildClassificationReport({
  generatedAt: "2026-10-09T05:17:00.000Z",
  model: "typesafe/jev-1.13",
  threshold: 0.7,
  calls: [{ ok: true, attempts: 1, latencyMs: 330, usage: { inputTokens: 1162, outputTokens: 185, cost: 0.00005 } }],
  history: [],
  details: [{
    videoId: "momo",
    title: "Mushroom Momo Pockets",
    channelName: "Ranveer Brar",
    regex: { mealTypes: ["drink"], cuisine: null },
    jev: { meal: { snack: 0.78, drink: 0.02 }, cuisine: { choice: "Indo-Chinese", confidence: 1 } },
    final: { mealTypes: ["snack"], cuisine: "Indo-Chinese" },
    source: { meal: "jev", cuisine: "jev" }
  }]
});

function serve(files: Record<string, unknown>) {
  const mock = vi.fn(async (url: string) => {
    const name = Object.keys(files).find((file) => url.includes(`/${file}?`));
    return name ? { ok: true, status: 200, json: async () => files[name] } : { ok: false, status: 404, json: async () => null };
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("ClassificationStats", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("shows headline numbers and where Jev overruled the keyword rules", async () => {
    const fetchMock = serve({ "classification-report.json": report });
    render(<ClassificationStats />);

    expect(await screen.findByText("Where Jev overruled the keyword rules (1)")).toBeInTheDocument();
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls.findIndex((url) => url.includes("classification-report.local.json")))
      .toBeLessThan(urls.findIndex((url) => url.includes("classification-report.json")));
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByText("labels where Jev overruled the keyword rules").previousSibling).toHaveTextContent("2");
    expect(screen.getAllByRole("link", { name: "Mushroom Momo Pockets" })[0]).toHaveAttribute("href", "https://www.youtube.com/watch?v=momo");
    expect(screen.getAllByText("drink · no cuisine")).toHaveLength(2);
    expect(screen.getByText("Borderline calls (1)")).toBeInTheDocument();
    expect(screen.getAllByText("snack 0.78 · Indo-Chinese 1.00")[0]).toBeInTheDocument();
  });

  it("explains when no report has been published yet", async () => {
    serve({});
    render(<ClassificationStats />);
    expect(await screen.findByText(/No classification report yet/)).toBeInTheDocument();
  });

  it("switches to the pinned first full run when a baseline exists", async () => {
    const baseline = { ...report, generatedAt: "2026-10-09T05:17:00.000Z", recipes: 812, thisRun: { ...report.thisRun, calls: 812 } };
    serve({ "classification-report.json": { ...report, generatedAt: "2026-10-12T05:17:00.000Z" }, "classification-baseline.json": baseline });
    render(<ClassificationStats />);

    const baselineTab = await screen.findByRole("tab", { name: /First full run/ });
    expect(screen.getByRole("tab", { name: "Latest run" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(baselineTab);
    expect(baselineTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/Later runs never replace it/)).toBeInTheDocument();
    expect(screen.getByText("recipes classified").previousSibling).toHaveTextContent("812");
  });
});

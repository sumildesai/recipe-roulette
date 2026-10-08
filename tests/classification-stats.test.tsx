import React from "react";
import { render, screen } from "@testing-library/react";
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

function respond(...responses: Array<{ ok: boolean; status: number; body?: unknown }>) {
  const mock = vi.fn();
  for (const { ok, status, body } of responses) mock.mockResolvedValueOnce({ ok, status, json: async () => body });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("ClassificationStats", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("shows headline numbers and where Jev overruled the keyword rules", async () => {
    const fetchMock = respond({ ok: false, status: 404 }, { ok: true, status: 200, body: report });
    render(<ClassificationStats />);

    expect(await screen.findByText("Where Jev overruled the keyword rules (1)")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toContain("classification-report.local.json");
    expect(fetchMock.mock.calls[1][0]).toContain("classification-report.json");
    expect(screen.getByText("labels where Jev overruled the keyword rules").previousSibling).toHaveTextContent("2");
    expect(screen.getAllByRole("link", { name: "Mushroom Momo Pockets" })[0]).toHaveAttribute("href", "https://www.youtube.com/watch?v=momo");
    expect(screen.getAllByText("drink · no cuisine")).toHaveLength(2);
    expect(screen.getByText("Borderline calls (1)")).toBeInTheDocument();
    expect(screen.getAllByText("snack 0.78 · Indo-Chinese 1.00")[0]).toBeInTheDocument();
  });

  it("explains when no report has been published yet", async () => {
    respond({ ok: false, status: 404 }, { ok: false, status: 404 });
    render(<ClassificationStats />);
    expect(await screen.findByText(/No classification report yet/)).toBeInTheDocument();
  });
});

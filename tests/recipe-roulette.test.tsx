import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecipeRoulette } from "@/components/recipe-roulette";
import type { Catalog } from "@/lib/types";

const catalog: Catalog = {
  version: 1,
  source: "seed",
  updatedThrough: "2026-01-01T00:00:00.000Z",
  sourceChannels: [],
  recipes: [
    {
      id: "one",
      videoId: "one",
      title: "Test Paneer",
      description: "",
      channelId: "channel",
      channelName: "Your Food Lab",
      publishedAt: "2026-01-01T00:00:00.000Z",
      thumbnailUrl: "https://example.com/one.jpg",
      videoUrl: "https://youtube.com/watch?v=one",
      durationSeconds: 600,
      cookingTimeMinutes: 30,
      mealTypes: ["dinner"],
      cuisine: "Indian",
      vegetarian: true
    }
  ]
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(catalog)
  }));
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }));
});

describe("RecipeRoulette", () => {
  it("shows loading, then the eligible catalog", async () => {
    render(<RecipeRoulette />);
    expect(screen.getByText("Loading recipes...")).toBeInTheDocument();
    expect(await screen.findByText("1 recipe ready to spin")).toBeInTheDocument();
  });

  it("supports keyboard spinning and exposes the result", async () => {
    render(<RecipeRoulette />);
    const button = await screen.findByRole("button", { name: "Spin" });
    button.focus();
    fireEvent.keyDown(button, { key: "Enter", code: "Enter" });
    fireEvent.click(button);
    expect(await screen.findByRole("heading", { name: "Test Paneer" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Watch recipe on YouTube/ })).toHaveAttribute("href", catalog.recipes[0].videoUrl);
  });

  it("shows an empty state when filters remove all recipes", async () => {
    render(<RecipeRoulette />);
    await screen.findByText("1 recipe ready to spin");
    fireEvent.change(screen.getByLabelText("Cuisine"), { target: { value: "Italian" } });
    expect(screen.getByText(/No recipes match/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spin" })).toBeDisabled();
  });

  it("surfaces catalog errors", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    render(<RecipeRoulette />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("could not be loaded"));
  });
});

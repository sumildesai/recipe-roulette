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

const searchCatalog: Catalog = {
  ...catalog,
  recipes: [
    catalog.recipes[0],
    {
      id: "two",
      videoId: "two",
      title: "Test Biryani",
      description: "Rice and spices",
      channelId: "channel2",
      channelName: "Ranveer Brar",
      publishedAt: "2026-01-01T00:00:00.000Z",
      thumbnailUrl: "https://example.com/two.jpg",
      videoUrl: "https://youtube.com/watch?v=two",
      durationSeconds: 900,
      cookingTimeMinutes: 45,
      mealTypes: ["dinner"],
      cuisine: "Indian",
      vegetarian: true
    }
  ]
};

const sourceCatalog: Catalog = {
  ...catalog,
  recipes: [
    catalog.recipes[0],
    {
      id: "two",
      videoId: "two",
      title: "Test Biryani",
      description: "Rice and spices",
      channelId: "channel2",
      channelName: "Ranveer Brar",
      publishedAt: "2026-01-01T00:00:00.000Z",
      thumbnailUrl: "https://example.com/two.jpg",
      videoUrl: "https://youtube.com/watch?v=two",
      durationSeconds: 900,
      cookingTimeMinutes: 45,
      mealTypes: ["dinner"],
      cuisine: "Indian",
      vegetarian: true
    },
    {
      id: "three",
      videoId: "three",
      title: "Test Pasta",
      description: "Creamy pasta",
      channelId: "channel",
      channelName: "Your Food Lab",
      publishedAt: "2026-01-01T00:00:00.000Z",
      thumbnailUrl: "https://example.com/three.jpg",
      videoUrl: "https://youtube.com/watch?v=three",
      durationSeconds: 600,
      cookingTimeMinutes: 30,
      mealTypes: ["dinner"],
      cuisine: "Italian",
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

  it("narrows the eligible count when typing a search query", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(searchCatalog)
    } as Response);
    render(<RecipeRoulette />);
    await screen.findByText("2 recipes ready to spin");
    fireEvent.change(screen.getByLabelText("Search recipes"), { target: { value: "biryani" } });
    expect(await screen.findByText("1 recipe ready to spin")).toBeInTheDocument();
  });

  it("shows the empty state when no recipe matches the query", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(searchCatalog)
    } as Response);
    render(<RecipeRoulette />);
    await screen.findByText("2 recipes ready to spin");
    fireEvent.change(screen.getByLabelText("Search recipes"), { target: { value: "sushi" } });
    expect(await screen.findByText(/No recipes match/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spin" })).toBeDisabled();
  });

  it("shows source options without duplicates and updates eligible counts", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sourceCatalog)
    } as Response);
    render(<RecipeRoulette />);
    await screen.findByText("3 recipes ready to spin");
    const sourceSelect = screen.getByLabelText("Source");
    expect(Array.from((sourceSelect as HTMLSelectElement).options).map((option) => option.textContent))
      .toEqual(["Any source", "Ranveer Brar", "Your Food Lab"]);
    fireEvent.change(sourceSelect, { target: { value: "Ranveer Brar" } });
    expect(await screen.findByText("1 recipe ready to spin")).toBeInTheDocument();
    fireEvent.change(sourceSelect, { target: { value: "" } });
    expect(await screen.findByText("3 recipes ready to spin")).toBeInTheDocument();
  });

  it("shows the empty state when source and cuisine filters have no overlap", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sourceCatalog)
    } as Response);
    render(<RecipeRoulette />);
    await screen.findByText("3 recipes ready to spin");
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "Ranveer Brar" } });
    await screen.findByText("1 recipe ready to spin");
    fireEvent.change(screen.getByLabelText("Cuisine"), { target: { value: "Italian" } });
    expect(await screen.findByText(/No recipes match/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spin" })).toBeDisabled();
  });

  it("clears the current selection when it no longer matches the query", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(searchCatalog)
    } as Response);
    render(<RecipeRoulette />);
    await screen.findByText("2 recipes ready to spin");
    fireEvent.change(screen.getByLabelText("Search recipes"), { target: { value: "paneer" } });
    await screen.findByText("1 recipe ready to spin");
    const button = screen.getByRole("button", { name: "Spin" });
    fireEvent.click(button);
    expect(await screen.findByRole("heading", { name: "Test Paneer" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search recipes"), { target: { value: "biryani" } });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Test Paneer" })).not.toBeInTheDocument());
  });

  it("clears the current selection when source changes and the recipe is no longer eligible", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sourceCatalog)
    } as Response);
    render(<RecipeRoulette />);
    await screen.findByText("3 recipes ready to spin");
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "Ranveer Brar" } });
    await screen.findByText("1 recipe ready to spin");
    const button = screen.getByRole("button", { name: "Spin" });
    fireEvent.click(button);
    expect(await screen.findByRole("heading", { name: "Test Biryani" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "Your Food Lab" } });
    await screen.findByText("2 recipes ready to spin");
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Test Biryani" })).not.toBeInTheDocument());
  });
});

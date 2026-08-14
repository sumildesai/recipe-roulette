"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CUISINES,
  MEAL_TYPES,
  type Catalog,
  type Cuisine,
  type MealType,
  type Recipe
} from "@/lib/types";
import { filterRecipes, pickRandomRecipe, searchRecipes } from "@/lib/roulette";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const CATALOG_VERSION = process.env.NEXT_PUBLIC_CATALOG_VERSION ?? "local";
const WHEEL_COLORS = ["#ff6b35", "#f7c548", "#39a96b", "#4b7bec", "#a55eea", "#ef5777"];

export function RecipeRoulette() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState("");
  const [mealTypes, setMealTypes] = useState<MealType[]>([]);
  const [cuisines, setCuisines] = useState<Cuisine[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [maxTime, setMaxTime] = useState(0);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selected, setSelected] = useState<Recipe | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [rotation, setRotation] = useState(0);
  const resultRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(
      `${BASE_PATH}/recipes.json?v=${encodeURIComponent(CATALOG_VERSION)}`,
      { signal: controller.signal, cache: "no-store" }
    )
      .then((response) => {
        if (!response.ok) throw new Error(`Catalog request failed (${response.status})`);
        return response.json() as Promise<Catalog>;
      })
      .then(setCatalog)
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError("The recipe catalog could not be loaded. Please refresh and try again.");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query), 200);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const sourceOptions = useMemo(
    () =>
      Array.from(new Set((catalog?.recipes ?? []).map((recipe) => recipe.channelName))).sort((a, b) =>
        a.localeCompare(b)
      ),
    [catalog]
  );

  const filtered = useMemo(
    () =>
      searchRecipes(
        filterRecipes(catalog?.recipes ?? [], {
          mealTypes,
          cuisines,
          sources,
          maxCookingTime: maxTime === 0 ? null : maxTime
        }),
        debouncedQuery
      ),
    [catalog, cuisines, debouncedQuery, maxTime, mealTypes, sources]
  );

  useEffect(() => {
    if (selected && !filtered.some((recipe) => recipe.id === selected.id)) {
      setSelected(null);
    }
  }, [filtered, selected]);

  function spin() {
    if (spinning || filtered.length === 0) return;
    const recipe = pickRandomRecipe(filtered);
    const turns = 5 + Math.floor(Math.random() * 3);
    setSpinning(true);
    setRotation((current) => current + turns * 360 + Math.floor(Math.random() * 360));
    window.setTimeout(() => {
      setSelected(recipe);
      setSpinning(false);
      window.setTimeout(() => resultRef.current?.focus(), 0);
    }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 900);
  }

  if (error) {
    return <section className="status error" role="alert"><h1>Recipe Roulette</h1><p>{error}</p></section>;
  }
  if (!catalog) {
    return <section className="status" aria-live="polite"><span className="loader" aria-hidden="true" /><p>Loading recipes...</p></section>;
  }

  return (
    <div className="page-shell">
      <header>
        <p className="eyebrow">Dinner indecision, solved</p>
        <h1>Recipe Roulette</h1>
        <p className="intro">Set a few preferences, spin the wheel, and cook along with a trusted chef.</p>
      </header>

      <section className="controls" aria-label="Recipe filters">
        <label htmlFor="search-recipes">
          Search recipes
          <input
            id="search-recipes"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name, cuisine, or channel"
            aria-describedby="eligible-count"
          />
        </label>
        <CheckboxGroup
          legend="Meal type"
          options={MEAL_TYPES}
          selected={mealTypes}
          formatLabel={capitalize}
          onChange={setMealTypes}
        />
        <CheckboxGroup
          legend="Cuisine"
          options={CUISINES}
          selected={cuisines}
          onChange={setCuisines}
        />
        <CheckboxGroup
          legend="Source"
          options={sourceOptions}
          selected={sources}
          onChange={setSources}
        />
        <label className="time-filter">
          <span>Maximum cooking time <strong>{maxTime === 0 ? "No limit" : `${maxTime} min`}</strong></span>
          <input
            type="range"
            min="0"
            max="120"
            step="15"
            value={maxTime}
            onChange={(event) => setMaxTime(Number(event.target.value))}
            aria-valuetext={maxTime === 0 ? "No time limit" : `${maxTime} minutes`}
          />
          <small>Recipes with unknown times are included only when there is no limit.</small>
        </label>
      </section>

      <section className="roulette-area" aria-label="Recipe roulette">
        <div className="wheel-wrap">
          <span className="pointer" aria-hidden="true" />
          <div
            className="wheel"
            role="img"
            aria-label={`Roulette wheel with ${filtered.length} eligible recipes`}
            style={{
              transform: `rotate(${rotation}deg)`,
              background: `conic-gradient(${WHEEL_COLORS.map((color, index) => `${color} ${index * (100 / WHEEL_COLORS.length)}% ${(index + 1) * (100 / WHEEL_COLORS.length)}%`).join(",")})`
            }}
          >
            <span aria-hidden="true">YFL</span><span aria-hidden="true">RB</span>
          </div>
          <button
            className="spin-button"
            onClick={spin}
            disabled={spinning || filtered.length === 0}
            aria-describedby="eligible-count"
          >
            {spinning ? "Spinning..." : "Spin"}
          </button>
        </div>
        <p id="eligible-count" className="eligible" aria-live="polite">
          {filtered.length === 0
            ? "No recipes match these filters. Try removing a filter."
            : `${filtered.length} recipe${filtered.length === 1 ? "" : "s"} ready to spin`}
        </p>
      </section>

      {selected && (
        <article className="result-card" ref={resultRef} tabIndex={-1} aria-live="polite">
          <Image
            src={selected.thumbnailUrl}
            alt=""
            width={480}
            height={360}
            unoptimized
          />
          <div>
            <p className="eyebrow">Tonight&apos;s pick</p>
            <h2>{selected.title}</h2>
            <p className="meta">
              <span>{selected.channelName}</span>
              {selected.cuisine && <span>{selected.cuisine}</span>}
              <span>{selected.cookingTimeMinutes === null ? "Time unknown" : `${selected.cookingTimeMinutes} min`}</span>
              <span>Vegetarian</span>
            </p>
            <div className="result-actions">
              <a href={selected.videoUrl} target="_blank" rel="noreferrer">Watch recipe on YouTube <span aria-hidden="true">↗</span></a>
              <button type="button" onClick={spin}>Spin again</button>
            </div>
          </div>
        </article>
      )}

      <footer>Recipes sourced from the official Your Food Lab and Ranveer Brar YouTube channels.</footer>
    </div>
  );
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

interface CheckboxGroupProps<T extends string> {
  legend: string;
  options: readonly T[];
  selected: readonly T[];
  formatLabel?: (value: T) => string;
  onChange: (values: T[]) => void;
}

function CheckboxGroup<T extends string>({
  legend,
  options,
  selected,
  formatLabel = (value) => value,
  onChange
}: CheckboxGroupProps<T>) {
  return (
    <fieldset className="checkbox-group">
      <legend>{legend}</legend>
      <div>
        {options.map((option) => (
          <label key={option}>
            <input
              type="checkbox"
              value={option}
              checked={selected.includes(option)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, option]
                    : selected.filter((value) => value !== option)
                )
              }
            />
            {formatLabel(option)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

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
const CATALOG_PATHS = process.env.NODE_ENV === "production"
  ? ["recipes.json"]
  : ["recipes.local.json", "recipes.json"];
const WHEEL_COLORS = ["#ff6b35", "#f7c548", "#39a96b", "#4b7bec", "#a55eea", "#ef5777"];

async function fetchCatalog(signal: AbortSignal): Promise<Catalog> {
  for (const [index, catalogPath] of CATALOG_PATHS.entries()) {
    const response = await fetch(
      `${BASE_PATH}/${catalogPath}?v=${encodeURIComponent(CATALOG_VERSION)}`,
      { signal, cache: "no-store" }
    );
    if (response.ok) return response.json() as Promise<Catalog>;
    if (response.status !== 404 || index === CATALOG_PATHS.length - 1) {
      throw new Error(`Catalog request failed (${response.status})`);
    }
  }
  throw new Error("Catalog request failed");
}

export function RecipeRoulette() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState("");
  const [mealTypes, setMealTypes] = useState<MealType[]>([]);
  const [cuisines, setCuisines] = useState<Cuisine[]>([]);
  const [excludeEggs, setExcludeEggs] = useState(false);
  const [veganOnly, setVeganOnly] = useState(false);
  const [sources, setSources] = useState<string[]>([]);
  const [maxTime, setMaxTime] = useState(0);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selected, setSelected] = useState<Recipe | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [rotation, setRotation] = useState(0);
  const resultRef = useRef<HTMLElement>(null);
  const mealTypeOptions = useMemo(
    () =>
      (process.env.NEXT_PUBLIC_DRINK_CLASSIFICATION_ENABLED === "true"
        ? MEAL_TYPES
        : MEAL_TYPES.filter((mealType) => mealType !== "drink")),
    []
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchCatalog(controller.signal)
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
          excludeEggs,
          veganOnly,
          sources,
          maxCookingTime: maxTime === 0 ? null : maxTime
        }),
        debouncedQuery
      ),
    [catalog, cuisines, debouncedQuery, excludeEggs, maxTime, mealTypes, sources, veganOnly]
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

  function resultActionLabel(recipe: Recipe): string {
    return recipe.sourceType === "website" ? `Open recipe on ${recipe.channelName}` : "Watch recipe on YouTube";
  }

  function sourceInitials(source: string): string {
    const acronym = source.match(/\b[A-Z0-9]{2,}\b/)?.[0];
    if (acronym) return acronym.slice(0, 3);
    const initials = source.match(/\b[A-Z0-9]/g)?.slice(0, 3).join("");
    return initials || source.slice(0, 3).toUpperCase();
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
        <p className="intro">Use the filters to narrow your options, then spin to get a random matching recipe.</p>
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
          options={mealTypeOptions}
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
        <div className="egg-filter">
          <span className="egg-filter-label">Dietary preference</span>
          <label>
            <input
              type="checkbox"
              checked={excludeEggs}
              onChange={(event) => setExcludeEggs(event.target.checked)}
            />
            Exclude eggs
          </label>
          <label>
            <input
              type="checkbox"
              checked={veganOnly}
              onChange={(event) => setVeganOnly(event.target.checked)}
            />
            Vegan only
          </label>
        </div>
        <CheckboxGroup
          legend="Source"
          options={sourceOptions}
          selected={sources}
          onChange={setSources}
        />
        <label className="time-filter">
          <span>Maximum recipe time <strong>{maxTime === 0 ? "No limit" : `${maxTime} min`}</strong></span>
          <input
            type="range"
            min="0"
            max="120"
            step="15"
            value={maxTime}
            onChange={(event) => setMaxTime(Number(event.target.value))}
            aria-valuetext={maxTime === 0 ? "No time limit" : `${maxTime} minutes`}
          />
          <small>Uses explicit totals when available; unknown times appear only with no limit.</small>
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
          {selected.thumbnailUrl ? (
            <Image
              src={selected.thumbnailUrl}
              alt=""
              width={480}
              height={360}
              unoptimized
            />
          ) : (
            <div className="result-placeholder" aria-hidden="true">{sourceInitials(selected.channelName)}</div>
          )}
          <div>
            <p className="eyebrow">Tonight&apos;s pick</p>
            <h2>{selected.title}</h2>
            <p className="meta">
              <span>{selected.channelName}</span>
              {selected.cuisine && <span>{selected.cuisine}</span>}
              {selected.ingredients?.includes("egg") && <span>Egg</span>}
              <span>{selected.cookingTimeMinutes === null ? "Time unknown" : `${selected.cookingTimeMinutes} min`}</span>
              {selected.vegan && <span>Vegan</span>}
              {selected.vegetarian && <span>Vegetarian</span>}
            </p>
            <div className="result-actions">
              <a href={selected.sourceUrl ?? selected.videoUrl} target="_blank" rel="noreferrer">{resultActionLabel(selected)} <span aria-hidden="true">↗</span></a>
              <button type="button" onClick={spin}>Spin again</button>
            </div>
          </div>
        </article>
      )}

      <footer>Recipes sourced from the official Your Food Lab, Ranveer Brar, and Rainbow Plant Life YouTube channels, plus metadata-only NYT Cooking entries.</footer>
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
  const summary =
    selected.length === 0 ? "Any" : selected.map((value) => formatLabel(value)).join(", ");
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function closeIfOutside(event: PointerEvent) {
      const element = detailsRef.current;
      if (!element || !element.open) return;
      if (event.target instanceof Node && element.contains(event.target)) return;
      element.open = false;
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const element = detailsRef.current;
      if (element?.open) element.open = false;
    }

    document.addEventListener("pointerdown", closeIfOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return (
    <details className="checkbox-dropdown" ref={detailsRef}>
      <summary>
        <span className="checkbox-dropdown-legend">{legend}</span>
        <span className="checkbox-dropdown-summary">{summary}</span>
      </summary>
      <fieldset className="checkbox-group">
        <legend className="visually-hidden">{legend}</legend>
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
    </details>
  );
}

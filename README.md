# Recipe Roulette

A static, accessible Next.js app that chooses a recipe uniformly at random from a local catalog sourced from the official **Your Food Lab**, **Ranveer Brar**, and **Rainbow Plant Life** YouTube channels, plus metadata-only **NYT Cooking** entries.

## Local development

Requirements: Node.js 22 and npm.

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. The checked-in `public/recipes.json` seed catalog intentionally remains a small offline fallback, so local development works without network access or an API key. GitHub Actions replaces it inside the deployment artifact with the full generated catalog; it does not commit that large generated file back to `main`. Production builds use Next.js static export and write to `out/`.

For full-catalog testing, place the generated catalog at `public/recipes.local.json`. This file is ignored by Git, and the development app prefers it automatically while falling back to the five-recipe seed when it is absent. The tracked `public/recipes.json` should always remain the small seed.

Set `NEXT_PUBLIC_DRINK_CLASSIFICATION_ENABLED=true` to re-enable the `Drink` meal-type filter in the UI. By default (unset or any value other than `true`), the `Drink` option is hidden.

## Catalog generation

The build-time generator queries only these hard-coded channel IDs:

| Channel | YouTube channel ID |
| --- | --- |
| Your Food Lab | `UCe2JAC5FUfbxLCfAvBWmNJA` |
| Ranveer Brar | `UCEHCDn_BBnk3uTK1M64ptyw` |
| Rainbow Plant Life | `UCDbZvuDA_tZ6XP5wKKFuemQ` |

Create a YouTube Data API v3 key, restrict it to that API, then run:

```bash
YOUTUBE_API_KEY=your-key npm run catalog:generate
```

The key is read only by `scripts/generate-catalog.ts`. It is never referenced by client code, stored in the catalog, or exposed through a `NEXT_PUBLIC_` variable.

The generator fetches each channel's uploads, normalizes text and durations, excludes short/non-recipe videos, infers meal type, cuisine, and stated cooking time, then merges in the NYT Cooking title/type metadata from `data/nytimes-recipes.json` before writing deterministic JSON to `public/recipes.json`. NYT entries intentionally store only public metadata (title, link, meal type, and cuisine), not paywalled recipe instructions. Classification taxonomy now lives in `scripts/classification-taxonomy.ts`, where meal/cuisine aliases are type-checked against supported `MealType` and `Cuisine` values. Cuisine policy is explicit: recognized non-core cuisine aliases map to `Global`, while recipes with no cuisine signal remain unclassified (`null`). Vegetarian classification excludes recipes with explicit meat terms; recipes without those signals are treated as vegetarian (`true`). Vegan metadata is assigned to Rainbow Plant Life recipes and recipes explicitly labeled vegan; the vegan filter excludes recipes whose vegan status is not confirmed. Unknown cooking times stay available when the UI has no time cap and are excluded when a cap is active.

### AI classification (Jev)

Every recipe's meal types and cuisine are classified by [Jev](https://openrouter.ai/) (`typesafe/jev-1.13`) through OpenRouter's `POST /api/alpha/decisions` endpoint. The regex rules are the fallback when Jev fails or isn't confident:

- **Meal type**: Jev answers one yes/no (`noul`) question per meal type, since a recipe can have several meal types. Labels with probability at least `0.7` are kept (Jev's yes/no scores for correct labels typically land around 0.7 to 0.9). If none reach `0.7`, the regex result is used.
- **Cuisine**: Jev answers one `choice` question over the supported cuisines plus `unclear`. A pick with confidence at least `0.7` is used, and a confident `unclear` keeps the cuisine `null`. Below `0.7`, the regex result is used.

Each recipe gets a single request containing both sets of questions. Question criteria come from `MEAL_TYPE_DESCRIPTIONS` and `CUISINE_DESCRIPTIONS` in `scripts/classification-taxonomy.ts`. Corrections in `data/catalog-overrides.json` always take priority; Jev is only asked about fields a correction leaves open. Validated responses are cached by content hash, classifier version, and model in `.catalog-cache/meal-type-ai.json` and `.catalog-cache/cuisine-ai.json`, so only new or edited videos are sent on later runs.

```bash
YOUTUBE_API_KEY=your-key OPENROUTER_API_KEY=your-openrouter-key npm run catalog:generate
```

Without `OPENROUTER_API_KEY`, the generator logs how many classifications remain unresolved and continues; set `CLASSIFIER_REQUIRED=true` to fail instead. `JEV_MODEL` overrides the model id. The key is read only by the generator scripts.

#### Classification report and `/stats`

Every catalog run also writes a classification report that compares the regex answer, Jev's probabilities, and the final label for every recipe. It includes outcome counts (Jev, regex fallback, correction), how often Jev overruled the regex, confidence buckets, borderline calls near the threshold, confident "unclear" cuisines, and per-call cost, tokens, retries, and latency. Cached answers keep their probabilities, so the comparison covers the full catalog even when only a few videos are new.

- The report goes to `public/classification-report.json` when the catalog output is `public/recipes.json`, and to `public/classification-report.local.json` otherwise (override with `CLASSIFICATION_REPORT_PATH`). Both are gitignored.
- The first run where Jev answers for at least half of a catalog of 20+ recipes (normally the first full refresh) is pinned to `public/classification-baseline.json` (`.local.json` locally; override with `CLASSIFICATION_BASELINE_PATH`). Later runs never overwrite it, and `/stats/` shows it under a "First full run" tab. To keep it permanently, even if the Actions cache is evicted, download it from the `classification-report` artifact and commit it. A committed baseline is never replaced. Delete it to pin a new one.
- Run history (the last 100 runs) is kept in `.catalog-cache/classification-history.json` (override with `CLASSIFICATION_HISTORY_PATH`).
- In GitHub Actions, the report is added to the job summary and uploaded as the `classification-report` artifact. The report and history are kept in their own cache, which every deploy restores, so the site's `/stats/` page keeps showing the latest refresh.

Duration parsing recognizes numeric minute and hour units (`minute`, `minutes`, `min`, `mins`, `m`, `hour`, `hours`, `hr`, `hrs`, `h`), mixed hour/minute values, case differences, ordinary whitespace variation, and ranges such as `30-45 minutes`. Ranges are stored as `minMinutes`/`maxMinutes`; maximum-time filtering compares against `maxMinutes` so a recipe must fit within the selected cap even at the high end of a stated range. Labeled preparation, cooking, resting, marination, and total times remain separate in the generated `durations` metadata. An explicit total time is the overall duration used for filtering; otherwise preparation and cooking are summed as active time. Resting and marination are treated as passive and do not count toward the active-time fallback unless the source provides an explicit total that includes them. If there is exactly one unlabeled duration and no duration label appears nearby, it is treated as a total-time fallback; multiple unlabeled durations, malformed values, negative values, implausibly long values, and unsupported units are ignored instead of guessed. Recipes with no parsed overall duration remain available when no maximum-time cap is active and are excluded when a cap is set.

### Overrides

Edit `data/catalog-overrides.json`:

```json
{
  "include": ["VIDEO_ID_TO_FORCE_INCLUDE"],
  "exclude": ["VIDEO_ID_TO_REMOVE"],
  "corrections": {
    "VIDEO_ID": {
      "title": "Corrected title",
      "cookingTimeMinutes": 45,
      "mealTypes": ["dinner"],
      "cuisine": "Indian",
      "vegetarian": true
    }
  }
}
```

Supported correction fields are `title`, `description`, `cookingTimeMinutes` (number or `null`), `mealTypes`, `cuisine`, and `vegetarian` (`true`, `false`, or `null`). Forced inclusion bypasses the normal recipe/length heuristic; exclusion always wins.

## Quality checks

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

Tests cover classification, metadata inference, overrides, deterministic output order, time/filter behavior, unbiased random selection, loading/error/empty states, and keyboard-triggered selection.

## GitHub Pages deployment

1. In repository settings, set **Pages > Source** to **GitHub Actions**.
2. Add `YOUTUBE_API_KEY` and `OPENROUTER_API_KEY` as repository Actions secrets.
3. Push to `main`, or run **Build and deploy Recipe Roulette** manually. Enable **Regenerate the catalog from YouTube and static recipe metadata before deploying** in the manual run to refresh the catalog immediately.

`.github/workflows/pages.yml` builds and deploys on pushes to `main`, scheduled runs every Monday and Friday at 05:17 UTC, and manual runs. Scheduled runs and manual runs with the refresh option regenerate the catalog using the secret, verify it, and save it to the Actions cache. Pushes to `main` and manual runs without the refresh option restore that cached catalog instead of regenerating it, so a deployment never replaces a generated catalog with the seed. A missing key or suspicious seed-sized result fails the refresh instead of silently publishing the starter catalog, which leaves the previously cached catalog intact for later deployments. The checked-in seed is deployed only until the first refresh populates the cache. Each deployment versions the catalog request with both the commit and workflow run IDs, preventing a same-commit manual refresh from reusing the previous deployment's cached catalog. The static build infers `/<repository-name>` as the `basePath` for project sites and no base path for `<owner>.github.io` user or organization sites, so assets and `recipes.json` work in either Pages layout. Pull requests use the checked-in seed and never receive the API secret.

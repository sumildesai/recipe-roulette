# Recipe Roulette

A static, accessible Next.js app that chooses a recipe uniformly at random from a local catalog sourced exclusively from the official **Your Food Lab** and **Ranveer Brar** YouTube channels.

## Local development

Requirements: Node.js 22 and npm.

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. The checked-in `public/recipes.json` seed catalog intentionally remains a small offline fallback, so local development works without network access or an API key. GitHub Actions replaces it inside the deployment artifact with the full generated catalog; it does not commit that large generated file back to `main`. Production builds use Next.js static export and write to `out/`.

## Catalog generation

The build-time generator queries only these hard-coded channel IDs:

| Channel | YouTube channel ID |
| --- | --- |
| Your Food Lab | `UCe2JAC5FUfbxLCfAvBWmNJA` |
| Ranveer Brar | `UCEHCDn_BBnk3uTK1M64ptyw` |

Create a YouTube Data API v3 key, restrict it to that API, then run:

```bash
YOUTUBE_API_KEY=your-key npm run catalog:generate
```

The key is read only by `scripts/generate-catalog.ts`. It is never referenced by client code, stored in the catalog, or exposed through a `NEXT_PUBLIC_` variable.

The generator fetches each channel's uploads, normalizes text and durations, excludes short/non-recipe videos, infers meal type, cuisine, and stated cooking time, and writes deterministic JSON to `public/recipes.json`. Classification taxonomy now lives in `scripts/classification-taxonomy.ts`, where meal/cuisine aliases are type-checked against supported `MealType` and `Cuisine` values. Cuisine policy is explicit: recognized non-core cuisine aliases map to `Global`, while recipes with no cuisine signal remain unclassified (`null`). Vegetarian classification is intentionally conservative: explicit meat terms produce `false`, clear vegetarian signals produce `true`, and ambiguous recipes remain `null`. Unknown cooking times stay available when the UI has no time cap and are excluded when a cap is active.

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
2. Add `YOUTUBE_API_KEY` as a repository Actions secret.
3. Push to `main`, or run **Build and deploy Recipe Roulette** manually. Enable **Regenerate the catalog from YouTube before deploying** in the manual run to refresh the catalog immediately.

`.github/workflows/pages.yml` builds and deploys on pushes to `main`, scheduled runs every Monday and Friday at 05:17 UTC, and manual runs. Scheduled runs and manual runs with the refresh option regenerate the catalog using the secret, verify it, and save it to the Actions cache. Pushes to `main` and manual runs without the refresh option restore that cached catalog instead of regenerating it, so a deployment never replaces a generated catalog with the seed. A missing key or suspicious seed-sized result fails the refresh instead of silently publishing the starter catalog, which leaves the previously cached catalog intact for later deployments. The checked-in seed is deployed only until the first refresh populates the cache. The static build infers `/<repository-name>` as the `basePath` for project sites and no base path for `<owner>.github.io` user or organization sites, so assets and `recipes.json` work in either Pages layout. Pull requests use the checked-in seed and never receive the API secret.

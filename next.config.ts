import type { NextConfig } from "next";

const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const inferredBasePath =
  process.env.GITHUB_ACTIONS === "true" &&
  repositoryName &&
  !repositoryName.endsWith(".github.io")
    ? `/${repositoryName}`
    : "";
const configuredBasePath =
  process.env.NEXT_PUBLIC_BASE_PATH ?? inferredBasePath;
const basePath =
  configuredBasePath && configuredBasePath !== "/"
    ? `/${configuredBasePath.replace(/^\/+|\/+$/g, "")}`
    : "";
const catalogVersion = [
  process.env.GITHUB_SHA?.slice(0, 12),
  process.env.GITHUB_RUN_ID
]
  .filter(Boolean)
  .join("-") || "local";

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  assetPrefix: basePath || undefined,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_CATALOG_VERSION: catalogVersion
  },
  images: { unoptimized: true },
  trailingSlash: true
};

export default nextConfig;

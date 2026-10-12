import { fileURLToPath } from "node:url";
import { PHASE_PRODUCTION_BUILD } from "next/constants.js";

// The monorepo is the root (a stray lockfile higher up would otherwise confuse Next).
const root = fileURLToPath(new URL("../..", import.meta.url));

// The API's address is baked into the client at build time. Without it a
// production build quietly pointed every phone at http://localhost:8787.
function checkApiUrl(value) {
  if (!value) throw new Error("NEXT_PUBLIC_API_URL must be set for a production build: the API's https:// address");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`NEXT_PUBLIC_API_URL isn't a URL: ${value}`);
  }
  if (url.protocol !== "https:") throw new Error(`NEXT_PUBLIC_API_URL must be https:// for a production build, not ${url.protocol}//`);
}

/** @type {import('next').NextConfig} */
const config = {
  outputFileTracingRoot: root,
  turbopack: { root },
  reactStrictMode: true,
  // Shared game rules (names, handles, looks) come straight from the backend's pure core.
  transpilePackages: ["@bp/core"],
  // Telegram blocks Mini App calls to other domains: the city is served from our own.
  poweredByHeader: false,
  // No server-side image optimization: it's the only thing that would run
  // sharp/libvips on our server, and the city ships its art pre-compressed.
  images: { unoptimized: true },
};

export default (phase) => {
  if (phase === PHASE_PRODUCTION_BUILD) checkApiUrl(process.env.NEXT_PUBLIC_API_URL);
  return config;
};

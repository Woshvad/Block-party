import { fileURLToPath } from "node:url";

// The monorepo is the root (a stray lockfile higher up would otherwise confuse Next).
const root = fileURLToPath(new URL("../..", import.meta.url));

/** @type {import('next').NextConfig} */
export default {
  outputFileTracingRoot: root,
  turbopack: { root },
  reactStrictMode: true,
  // Telegram blocks Mini App calls to other domains: the city is served from our own.
  poweredByHeader: false,
  // No server-side image optimization: it's the only thing that would run
  // sharp/libvips on our server, and the city ships its art pre-compressed.
  images: { unoptimized: true },
};

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

// The Mini App's own link (https://t.me/<bot>/<app>), also baked in. Without
// it crew invites are web links, which inside Telegram open the in-app
// browser as a guest who can't join, and guests get no "Open in Telegram"
// button. A build still works (CI has no bot), so it only warns.
function checkTelegramAppUrl(value, warn = console.warn) {
  if (!value) {
    warn("NEXT_PUBLIC_TG_APP_URL is not set: crew invites will be web links, and guests won't be offered the Mini App (README \"Deploying\")");
    return;
  }
  let url = null;
  try {
    url = new URL(value);
  } catch {
    // reported below
  }
  if (!url || url.protocol !== "https:" || url.hostname !== "t.me") warn(`NEXT_PUBLIC_TG_APP_URL should be the Mini App's https://t.me/<bot>/<app> link, not ${value}`);
}

const IMMUTABLE = "public, max-age=31536000, immutable";

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
  // The kit packs' folders are named after a hash of their files
  // (scripts/assets.mjs), so an address there never changes what it holds:
  // phones keep them for good. Next already does this for /_next/static, and
  // public/_headers says the same to static hosts. Nothing unversioned here.
  async headers() {
    return [{ source: "/assets/kenney/:path*", headers: [{ key: "Cache-Control", value: IMMUTABLE }] }];
  },
};

export default (phase, { warn } = {}) => {
  if (phase === PHASE_PRODUCTION_BUILD) {
    checkApiUrl(process.env.NEXT_PUBLIC_API_URL);
    checkTelegramAppUrl(process.env.NEXT_PUBLIC_TG_APP_URL, warn);
  }
  return config;
};

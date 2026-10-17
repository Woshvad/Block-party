import type { MetadataRoute } from "next";

// Lets a phone's browser add the city to the home screen, where it opens full
// screen like an app. No service worker: the city needs the network anyway.
// The icons are drawn by scripts/icons.mjs; the colours are the city's paper
// (app/globals.css).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Block Party",
    short_name: "Block Party",
    description: "A city that argues about the future, every day.",
    start_url: "/",
    display: "standalone",
    background_color: "#f3f1eb",
    theme_color: "#f3f1eb",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // The mark sits in the middle 60%, so a phone may crop it to its own shape.
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

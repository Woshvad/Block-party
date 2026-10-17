import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";

// The web manifest (app/manifest.ts) covers Android's home screen; iPhones
// read the apple-touch-icon and the appleWebApp tags instead.
export const metadata: Metadata = {
  title: "Block Party",
  description: "A city that argues about the future, every day.",
  icons: { icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }], apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }] },
  appleWebApp: { capable: true, title: "Block Party", statusBarStyle: "default" },
};
// The theme colour is the city's paper (app/globals.css), as in the manifest.
export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 1, userScalable: false, viewportFit: "cover", themeColor: "#f3f1eb" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Telegram's script sets viewport variables on <html> before React loads.
    <html lang="en" suppressHydrationWarning>
      <body>
        {/* The Telegram Mini App bridge (a no-op in a normal browser). */}
        <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
        {children}
      </body>
    </html>
  );
}

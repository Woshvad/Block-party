import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = { title: "Block Party", description: "A city that argues about the future, every day." };
export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 1, userScalable: false, viewportFit: "cover", themeColor: "#dfeaf5" };

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

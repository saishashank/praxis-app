import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import localFont from "next/font/local";
import { OfflineBadge } from "@/components/pwa/OfflineBadge";
import { RegisterSW } from "@/components/pwa/RegisterSW";
import { currentLook } from "@/lib/preferences/current";
import "./globals.css";
import "./text-size.css";

// Served from our origin (font-src 'self', D-130). D-884: Source Sans 3 for text and numbers (tabular
// figures, UXN-002), Source Serif 4 for titles. M18 D-1805: the files are committed (variable fonts, latin
// subset, SIL Open Font License 1.1, from Google Fonts) so the build never fetches fonts: the
// next/font/google fetch failed builds at random in CI.
const sourceSans = localFont({
  src: "./fonts/source-sans-3-latin-wght.woff2",
  weight: "400 700",
  style: "normal",
  variable: "--font-source-sans",
  display: "swap",
});
const sourceSerif = localFont({
  src: "./fonts/source-serif-4-latin-opsz-wght.woff2",
  weight: "600 700",
  style: "normal",
  variable: "--font-source-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Praxis",
  description: "Practice-only investment research. All trades are simulated.",
};

// M21 P1 (PLT-079): the installed app's browser bar and status bar follow the light palette.
export const viewport: Viewport = { themeColor: "#f5f7fb", width: "device-width", initialScale: 1 };

// Render per request so the CSP nonce set in the proxy reaches Next's own scripts.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await connection();
  // UXN-280: the signed-in user's theme, read server-side (no inline script, CSP).
  const { theme, motion, text_size: textSize } = await currentLook();
  return (
    <html
      lang="en"
      className={`${sourceSans.variable} ${sourceSerif.variable}`}
      data-theme={theme}
      data-motion={motion === "off" ? "off" : undefined}
      data-text-size={textSize === "large" ? "large" : undefined}
    >
      <body className="min-h-screen antialiased">
        {children}
        <OfflineBadge />
        <RegisterSW />
      </body>
    </html>
  );
}

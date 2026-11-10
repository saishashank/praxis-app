import type { Metadata } from "next";
import { connection } from "next/server";
import { Source_Sans_3, Source_Serif_4 } from "next/font/google";
import { currentLook } from "@/lib/preferences/current";
import "./globals.css";
import "./text-size.css";

// Self-hosted at build time by next/font (served from our origin; font-src 'self', D-130).
// D-884: Source Sans 3 for text and numbers (tabular figures, UXN-002), Source Serif 4 for titles.
const sourceSans = Source_Sans_3({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-source-sans",
  display: "swap",
});
const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-source-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Praxis",
  description: "Practice-only investment research. All trades are simulated.",
};

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
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}

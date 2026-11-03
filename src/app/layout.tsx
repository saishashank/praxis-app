import type { Metadata } from "next";
import { connection } from "next/server";
import { IBM_Plex_Sans, Source_Serif_4 } from "next/font/google";
import { currentLook } from "@/lib/preferences/current";
import "./globals.css";

// Self-hosted at build time by next/font (served from our origin; font-src 'self', D-130).
// D-884: IBM Plex Sans for text and numbers (tabular figures, UXN-002), Source Serif 4 for titles.
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-sans",
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
  const { theme, motion } = await currentLook();
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${sourceSerif.variable}`}
      data-theme={theme}
      data-motion={motion === "off" ? "off" : undefined}
    >
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}

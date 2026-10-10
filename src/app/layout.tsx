import type { Metadata } from "next";
import { connection } from "next/server";
import { Inter } from "next/font/google";
import { currentTheme } from "@/lib/preferences/current";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Praxis",
  description: "Practice-only investment research. All trades are simulated.",
};

// Render per request so the CSP nonce set in the proxy reaches Next's own scripts.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await connection();
  // UXN-280: the signed-in user's theme, read server-side (no inline script, CSP).
  const theme = await currentTheme();
  return (
    <html lang="en" className={inter.variable} data-theme={theme}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}

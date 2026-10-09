import type { Metadata } from "next";
import { connection } from "next/server";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Praxis",
  description: "Practice-only investment research. All trades are simulated.",
};

// Render per request so the CSP nonce set in the proxy reaches Next's own scripts.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await connection();
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}

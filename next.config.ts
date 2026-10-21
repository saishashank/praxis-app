import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

// "What the system learned" moved under the Reviews tab (M7 T18, decision 57). Permanent redirects keep
// every old /learning link working; the query string is carried over by Next.
export const learningRedirects = [
  { source: "/learning", destination: "/reviews/learned", permanent: true },
  {
    source: "/learning/lessons/:id",
    destination: "/reviews/learned/lessons/:id",
    permanent: true,
  },
  {
    source: "/learning/challengers/:id",
    destination: "/reviews/learned/challengers/:id",
    permanent: true,
  },
  { source: "/learning/:path*", destination: "/reviews/learned/:path*", permanent: true },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: { authInterrupts: true }, // forbidden() / unauthorized() (D-038)
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async redirects() {
    return learningRedirects;
  },
};

export default nextConfig;

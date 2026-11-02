import type { NextConfig } from "next";

// Keep equal to ABSENT_PATH / HIDE_HEADER in src/lib/http/gate.ts (a unit test checks this; the
// config must not import the gate, which pulls in the server runtime).
export const BLUEPRINT_ABSENT_PATH = "/_praxis-absent";
export const BLUEPRINT_HIDE_HEADER = "x-praxis-hide";

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

// The Blueprint reads these files at request time (specBrowser.ts, the model route); Next's file tracer
// cannot see paths built with process.cwd(), so they are listed here (B1). Keep equal to DOCS_ALLOW,
// SPEC_DIR and the model path (a unit test checks this).
export const BLUEPRINT_TRACE_INCLUDES = {
  "/blueprint": [
    "./docs/architecture/architecture.json",
    "./spec/*.md",
    "./docs/06_open_questions.md",
    "./docs/07_decision_log.md",
    "./docs/config-reference.md",
  ],
  "/api/blueprint/model": ["./docs/architecture/architecture.json"],
};

const nextConfig: NextConfig = {
  poweredByHeader: false,
  outputFileTracingIncludes: BLUEPRINT_TRACE_INCLUDES,
  experimental: { authInterrupts: true }, // forbidden() / unauthorized() (D-038)
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async rewrites() {
    // D-371: requests the proxy marked as not-for-this-user render the app's real 404.
    return {
      beforeFiles: [
        {
          source: "/(.*)",
          has: [{ type: "header" as const, key: BLUEPRINT_HIDE_HEADER, value: "1" }],
          destination: BLUEPRINT_ABSENT_PATH,
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  async redirects() {
    return learningRedirects;
  },
};

export default nextConfig;

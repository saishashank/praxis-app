// Web manifest (M21 P1, PLT-079, D-1231). Static and same-origin: relative URLs only, the light palette, the two
// brand icons. Public without a session (gate.ts PUBLIC_EXACT, the proxy matcher skips it). No push fields.
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Praxis",
    short_name: "Praxis",
    description: "Practice-only investment research. All trades are simulated.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f5f7fb",
    theme_color: "#f5f7fb",
    icons: [
      { src: "/brand/praxis-app-icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/praxis-app-icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}

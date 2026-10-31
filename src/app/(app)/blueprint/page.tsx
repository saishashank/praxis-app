// Blueprint (M16, WP1 placeholder). Pinned Owner only: everyone else gets the app's 404 (SEC-111).
// Not linked from any nav, sitemap or help text (SEC-112). Content arrives in WP5.
import type { Metadata } from "next";
import { requirePinnedOwner } from "@/lib/auth/blueprintGuard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function BlueprintPage() {
  await requirePinnedOwner("/blueprint");
  return <main data-testid="blueprint-shell" />;
}

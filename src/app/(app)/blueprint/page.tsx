// Blueprint (M16 WP5). Pinned Owner only: everyone else gets the app's 404 (SEC-111). Not linked from
// any nav, sitemap or help text (SEC-112). The diagram fetches the model from the pinned-Owner API; the
// URL is passed down from here so no client chunk carries it (D-372).
import type { Metadata } from "next";
import { BlueprintDiagram } from "@/components/blueprint/BlueprintDiagram";
import { requirePinnedOwner } from "@/lib/auth/blueprintGuard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Blueprint", robots: { index: false, follow: false } };

export default async function BlueprintPage() {
  await requirePinnedOwner("/blueprint");
  return (
    <main data-testid="blueprint-shell" className="min-w-0">
      <h1>Blueprint</h1>
      <BlueprintDiagram modelUrl="/api/blueprint/model" />
    </main>
  );
}

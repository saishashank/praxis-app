// Blueprint (M16 WP5). Pinned Owner only: everyone else gets the app's 404 (SEC-111). Not linked from
// any nav, sitemap or help text (SEC-112). The diagram fetches the model from the pinned-Owner API; the
// URL is passed down from here so no client chunk carries it (D-372). Live status is read here, on the
// server, and handed to the client as plain data (ARC-002).
import type { Metadata } from "next";
import Link from "next/link";
import { BlueprintDiagram } from "@/components/blueprint/BlueprintDiagram";
import { requirePinnedOwner } from "@/lib/auth/blueprintGuard";
import { loadModel } from "@/lib/blueprint/specBrowser";
import { mainDb } from "@/lib/db/client";
import { loadBlueprintStatus, type BlueprintModelLike } from "@/lib/ui/loaders/blueprint";
import { SpecBrowser } from "./SpecBrowser";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Blueprint", robots: { index: false, follow: false } };

type SearchParams = Promise<{ tab?: string; doc?: string; q?: string }>;

export default async function BlueprintPage({ searchParams }: { searchParams: SearchParams }) {
  await requirePinnedOwner("/blueprint");
  const sp = await searchParams;
  if (sp.tab === "spec") {
    return (
      <main data-testid="blueprint-shell" className="min-w-0">
        <h1>Blueprint</h1>
        <p>
          <Link href="/blueprint">Back to the diagrams</Link>
        </p>
        <SpecBrowser doc={sp.doc} q={sp.q} />
      </main>
    );
  }
  const status = await loadBlueprintStatus(
    { mainDb: mainDb(), now: new Date() },
    loadModel() as unknown as BlueprintModelLike,
  );
  return (
    <main data-testid="blueprint-shell" className="min-w-0">
      <h1>Blueprint</h1>
      <BlueprintDiagram modelUrl="/api/blueprint/model" status={status} />
    </main>
  );
}

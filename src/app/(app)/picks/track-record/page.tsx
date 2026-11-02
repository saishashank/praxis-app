// Track record, old route (UXN-043). The content now lives in the Track record tab of /picks (UXR-021,
// `?view=track`); this route stays for links and renders the same component (D-143: read-only).
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { envFor } from "@/lib/ui/loaders/shell";
import { parsePicksQuery } from "@/lib/ui/loaders/picks";
import { Breadcrumb } from "@/components/ui/Nav";
import { TrackRecordBody } from "../TrackRecordBody";
import { NOT_REAL_ORDERS } from "../text";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

export default async function TrackRecordPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireUser("read", "/picks/track-record");
  const env = await envFor(user);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") q.set(k, v);
  const query = await parsePicksQuery(env, q);
  if (query === null) notFound();

  return (
    <main className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-4 px-4 py-6">
      <Breadcrumb
        backHref="/picks"
        items={[{ label: "Picks", href: "/picks" }, { label: "Track record" }]}
      />
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Track record</h1>
        <p className="m-0 text-sm text-text-muted">
          Every pick as published, next to what happened. Price only — dividends not included.
          Nothing shown here can be changed afterwards. {NOT_REAL_ORDERS}
        </p>
      </header>
      {await TrackRecordBody({
        env,
        profile: query.profile,
        hrefFor: (p) => `/picks/track-record?profile=${encodeURIComponent(p)}`,
      })}
    </main>
  );
}

// D-201: the placeholder a signed-in page shows while its data loads. Next shows it the moment a tab
// or link is clicked (and prefetches it), so the header and tabs answer at once instead of waiting
// for the server to finish the whole page.
import { Skeleton } from "@/components/ui/Card";

export default function Loading() {
  return (
    <main className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-4 px-4 py-6">
      <div aria-hidden="true" className="h-8 w-40 animate-pulse rounded bg-surface-2" />
      <Skeleton lines={2} label="Loading the page" />
      <div aria-hidden="true" className="h-40 animate-pulse rounded-lg bg-surface-2" />
      <div aria-hidden="true" className="h-40 animate-pulse rounded-lg bg-surface-2" />
    </main>
  );
}

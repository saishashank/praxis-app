"use client";
// Breadcrumb and back link of the current page (UXN-033). The route table with its labels is only
// needed here, so the view is a lazy chunk (CrumbsView.tsx) that stays out of the first-load JS of
// every page (UX-005 budget). It still renders on the server.
import { lazy, Suspense } from "react";

const View = lazy(() => import("./CrumbsView").then((m) => ({ default: m.CrumbsView })));

export function Crumbs() {
  return (
    <Suspense fallback={null}>
      <View />
    </Suspense>
  );
}

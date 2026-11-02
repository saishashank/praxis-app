"use client";
// Breadcrumb and back link of the current page (UXN-033), from the pathname and the nav model. Labels
// are the model's generic ones, never the URL segments (a segment may be a code masked users must not
// see). Nothing is shown on a tab root or an unknown path.
import { usePathname } from "next/navigation";
import { Breadcrumb } from "@/components/ui/Nav";
import { breadcrumbFor } from "@/lib/ui/nav";

export function CrumbsView() {
  const { crumbs, backHref } = breadcrumbFor(usePathname() ?? "/");
  if (crumbs.length === 0) return null;
  return (
    <div className="page-frame pt-3">
      <Breadcrumb items={crumbs} backHref={backHref} />
    </div>
  );
}

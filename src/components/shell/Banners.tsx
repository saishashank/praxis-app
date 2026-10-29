"use client";
// Banners under the header (UX-015): market mode, a reduced header. Text comes from the shell loader.
// UXR-006 (one banner, once): the market-mode state ("data only", "off") is a dot in the region chip
// everywhere and ONE line on Home; no other page repeats it. Other notices (a reduced header) show on
// every page. The simulated/legal line lives in the footer only.
// These are standing notices present at page load, not live updates, so they carry no status/alert
// role (that would collide with each page's own status messages and be announced on every page).
import { usePathname } from "next/navigation";
import { AlertIcon, InfoIcon } from "@/components/ui/icons";

export type BannerView = { id: string; text: string };

/** Banner ids that describe the market mode; they appear on Home only (UXR-006). */
export const isModeBanner = (id: string): boolean => id.startsWith("mode:");

export function Banners({ banners }: { banners: BannerView[] }) {
  const onHome = (usePathname() ?? "/") === "/";
  const shown = banners.filter((b) => onHome || !isModeBanner(b.id));
  if (shown.length === 0) return null;
  return (
    <section aria-label="Notices" className="page-frame flex flex-col gap-2 pt-3">
      {shown.map((b) => {
        const warn = b.id.endsWith(":unavailable");
        return (
          <div
            key={b.id}
            data-banner={b.id}
            className={`flex min-w-0 items-start gap-2 rounded-lg border border-border bg-surface p-3 text-sm break-words ${warn ? "text-warning" : "text-text"}`}
          >
            {warn ? (
              <AlertIcon className="mt-0.5 shrink-0" />
            ) : (
              <InfoIcon className="mt-0.5 shrink-0" />
            )}
            <p className="m-0 min-w-0">{b.text}</p>
          </div>
        );
      })}
    </section>
  );
}

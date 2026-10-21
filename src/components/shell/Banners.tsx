// Banners under the header (UX-015): market mode, a reduced header. Text comes from the shell loader.
// These are standing notices present at page load, not live updates, so they carry no status/alert
// role (that would collide with each page's own status messages and be announced on every page).
import { AlertIcon, InfoIcon } from "@/components/ui/icons";

export type BannerView = { id: string; text: string };

export function Banners({ banners }: { banners: BannerView[] }) {
  if (banners.length === 0) return null;
  return (
    <section
      aria-label="Notices"
      className="mx-auto flex w-full max-w-[1200px] flex-col gap-2 px-4 pt-3"
    >
      {banners.map((b) => {
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

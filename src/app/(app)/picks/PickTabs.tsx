// Profile switch (UXR-021, UXR-002, UXN-040): a Segmented control (links, state in the URL; the selected
// profile has fill + check + "Selected") with the one-sentence rule of the chosen profile directly under
// it, taken from the stored `pick_profiles` caps. D-1849: the Today / History / Track record choice is the
// `ViewSelect` dropdown, passed in as `viewSelect` and shown on the same row as the profile tabs.
import type { ReactNode } from "react";
import { Segmented } from "@/components/ui/Segmented";
import { profileLabel } from "./text";
import { ProfileLabel } from "./ProfileLabel";

export function ProfileSwitch({
  profiles,
  current,
  hrefFor,
  rule,
  viewSelect = null,
  allHref,
}: {
  profiles: readonly string[];
  current: string;
  /** Link of a profile, e.g. (p) => `/picks?profile=${p}`. */
  hrefFor: (profile: string) => string;
  rule: string;
  /** The view dropdown; sits beside the profile tabs (wraps under them on a phone). */
  viewSelect?: ReactNode;
  /** D-1858: link of the "All profiles" choice (the History tab); omitted elsewhere. */
  allHref?: string;
}) {
  const items = profiles.map((p) => ({ value: p, label: profileLabel(p), href: hrefFor(p) }));
  if (allHref !== undefined) items.push({ value: "all", label: "All profiles", href: allHref });
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <Segmented label="Risk profile" value={current} items={items} />
        {viewSelect}
      </div>
      <p className="m-0 text-sm text-text-muted">
        {allHref !== undefined && current === "all" ? (
          <>All profiles: every pick published for the three risk profiles, newest first.</>
        ) : (
          <>
            <ProfileLabel profile={current} />: {rule}
          </>
        )}
      </p>
    </div>
  );
}

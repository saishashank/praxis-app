// Profile switch (UXR-021, UXR-002, UXN-040): a Segmented control (links, state in the URL; the selected
// profile has fill + check + "Selected") with the one-sentence rule of the chosen profile directly under
// it, taken from the stored `pick_profiles` caps.
import { Segmented } from "@/components/ui/Segmented";
import { profileLabel } from "./text";

export function ProfileSwitch({
  profiles,
  current,
  hrefFor,
  rule,
}: {
  profiles: readonly string[];
  current: string;
  /** Link of a profile, e.g. (p) => `/picks?profile=${p}`. */
  hrefFor: (profile: string) => string;
  rule: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Segmented
        label="Risk profile"
        value={current}
        items={profiles.map((p) => ({ value: p, label: profileLabel(p), href: hrefFor(p) }))}
      />
      <p className="m-0 text-sm text-text-muted">
        {profileLabel(current)}: {rule}
      </p>
    </div>
  );
}

/** Today / Track record tabs of the Picks page (UXR-021). */
export function ViewTabs({ current, profile }: { current: "today" | "track"; profile: string }) {
  const p = encodeURIComponent(profile);
  return (
    <Segmented
      label="Picks view"
      value={current}
      items={[
        { value: "today", label: "Today", href: `/picks?profile=${p}` },
        { value: "track", label: "Track record", href: `/picks?profile=${p}&view=track` },
      ]}
    />
  );
}

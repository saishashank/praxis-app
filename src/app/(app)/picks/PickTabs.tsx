// Profile switch (UXN-040): three chips (links, state in the URL) and the one-sentence rule of the
// chosen profile, taken from the stored `pick_profiles` caps.
import { Chips } from "@/components/ui/Nav";
import { profileLabel } from "./text";

export function ProfileSwitch({
  profiles,
  current,
  base,
  rule,
}: {
  profiles: readonly string[];
  current: string;
  /** "/picks" or "/picks/track-record" */
  base: string;
  rule: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Chips
        label="Risk profile"
        items={profiles.map((p) => ({
          href: `${base}?profile=${encodeURIComponent(p)}`,
          label: profileLabel(p),
          current: p === current,
        }))}
      />
      <p className="m-0 text-sm text-text-muted">
        {profileLabel(current)}: {rule}
      </p>
    </div>
  );
}

// D-1002: the risk profile's name in its own accent colour (token hue, readable in every theme).
// The words always carry the meaning; the colour only helps the eye.
import { hueStyle } from "@/components/ui/hue";
import { profileHue, profileLabel } from "./text";

export function ProfileLabel({
  profile,
  suffix = "",
  className = "",
}: {
  profile: string;
  suffix?: string;
  className?: string;
}) {
  return (
    <span
      data-profile={profile}
      style={hueStyle(profileHue(profile))}
      className={`font-semibold text-[var(--h-text)] ${className}`.trim()}
    >
      {profileLabel(profile)}
      {suffix}
    </span>
  );
}

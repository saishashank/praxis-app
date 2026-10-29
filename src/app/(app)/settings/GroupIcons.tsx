// Two-tone line icons for the Settings group headings (UXR-055): the stroke takes the group's section
// hue (currentColor), the soft fill is the same hue at low opacity. Decorative.
import type { ReactNode } from "react";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const UserIcon = () => (
  <Icon>
    <circle cx="12" cy="8" r="4" fill="currentColor" fillOpacity={0.25} />
    <path d="M4 20c1-4 4-6 8-6s7 2 8 6" />
  </Icon>
);
export const PaletteIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" fill="currentColor" fillOpacity={0.25} />
    <path d="M12 3v18M3 12h9" />
  </Icon>
);
export const ClockIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" fill="currentColor" fillOpacity={0.25} />
    <path d="M12 7v5l3 2" />
  </Icon>
);
export const GlobeIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" fill="currentColor" fillOpacity={0.25} />
    <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
  </Icon>
);
export const AboutIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" fill="currentColor" fillOpacity={0.25} />
    <path d="M12 11v5M12 8h.01" />
  </Icon>
);

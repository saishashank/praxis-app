// Shell icons (D-128: inline SVG, no icon package). Decorative (aria-hidden); the control that holds
// one carries the accessible name. 24-unit grid, stroke follows currentColor so every theme applies.
import type { ReactNode, SVGProps } from "react";

export type ShellIconProps = Omit<SVGProps<SVGSVGElement>, "children">;

function Svg({ children, ...rest }: ShellIconProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const HomeIcon = (p: ShellIconProps) => (
  <Svg {...p}>
    <path d="M3 11l9-8 9 8" />
    <path d="M5 10v10h14V10" />
  </Svg>
);
export const PicksIcon = (p: ShellIconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="4" />
  </Svg>
);
export const MarketIcon = (p: ShellIconProps) => (
  <Svg {...p}>
    <path d="M4 20V10" />
    <path d="M10 20V4" />
    <path d="M16 20v-8" />
    <path d="M22 20H2" />
  </Svg>
);
export const StrategiesIcon = (p: ShellIconProps) => (
  <Svg {...p}>
    <path d="M12 3l9 5-9 5-9-5 9-5z" />
    <path d="M3 13l9 5 9-5" />
  </Svg>
);
export const NewsIcon = (p: ShellIconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9h10M7 13h10M7 17h6" />
  </Svg>
);
export const ReviewsIcon = (p: ShellIconProps) => (
  <Svg {...p}>
    <path d="M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3V4z" />
    <path d="M9 9h6M9 13h6" />
  </Svg>
);
export const BellIcon = (p: ShellIconProps) => (
  <Svg {...p}>
    <path d="M6 9a6 6 0 1112 0c0 6 2 7 2 8H4c0-1 2-2 2-8z" />
    <path d="M10 21h4" />
  </Svg>
);
export const GearIcon = (p: ShellIconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
  </Svg>
);
export const ThemeIcon = (p: ShellIconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3v18" />
    <path d="M12 3a9 9 0 010 18z" fill="currentColor" />
  </Svg>
);
export const GlobeIcon = (p: ShellIconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a14 14 0 010 18M12 3a14 14 0 000 18" />
  </Svg>
);
export const MoreIcon = (p: ShellIconProps) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1.5" />
    <circle cx="12" cy="12" r="1.5" />
    <circle cx="19" cy="12" r="1.5" />
  </Svg>
);

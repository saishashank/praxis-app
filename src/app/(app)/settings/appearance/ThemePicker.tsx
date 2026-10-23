// The six themes as a radio group (UXN-280): a 2 x 3 grid of labelled choices. Names are the theme
// names only (the description is linked with aria-describedby), so they never collide with the
// header's "Appearance: X. Switch to Y." button. Server component: a plain form field.
import { THEMES, type Theme } from "@/lib/preferences/service";

export const THEME_LABEL: Record<Theme, string> = {
  dark: "Dark (default)",
  light: "Light",
  system: "Match device",
  midnight: "Midnight",
  dim: "Dim",
  high_contrast: "High contrast",
};

export const THEME_NOTE: Record<Theme, string> = {
  dark: "Dark blue-grey surfaces. The default.",
  light: "Light surfaces with dark text.",
  system: "Follows your device: light or dark.",
  midnight: "True black, for OLED screens.",
  dim: "A softer blue-grey dark.",
  high_contrast: "White on black with a yellow accent, for the strongest contrast.",
};

export function ThemePicker({ value }: { value: Theme }) {
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-lg font-medium">Colour scheme</legend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {THEMES.map((t) => (
          <div
            key={t}
            className="group/option flex min-h-14 min-w-0 items-start gap-2 rounded-lg border border-border bg-surface p-3 has-[:checked]:border-accent has-[:checked]:bg-surface-2 has-[:checked]:shadow-[0_0_0_1px_var(--color-accent)]"
          >
            <input
              type="radio"
              id={`theme-${t}`}
              name="theme"
              value={t}
              defaultChecked={t === value}
              aria-describedby={`theme-${t}-note`}
              className="mt-1"
            />
            <div className="min-w-0 flex-1">
              <label
                htmlFor={`theme-${t}`}
                className="flex flex-wrap items-center gap-2 text-sm font-medium"
              >
                {THEME_LABEL[t]}
                <span
                  aria-hidden="true"
                  className="hidden rounded-full bg-accent px-2 py-0.5 text-[0.7rem] font-semibold text-accent-contrast group-has-[:checked]/option:inline"
                >
                  ✓ Selected
                </span>
              </label>
              {t === value ? (
                <span className="text-[0.7rem] text-text-muted">Current setting</span>
              ) : null}
              <p id={`theme-${t}-note`} className="m-0 text-xs text-text-muted">
                {THEME_NOTE[t]}
              </p>
            </div>
          </div>
        ))}
      </div>
    </fieldset>
  );
}

// The header theme shortcut (UXN-280): one button that steps to the next of the six themes. A form
// with a server action, so it works without client JavaScript; the action saves the choice and
// revalidates the layout, so the new theme shows at once.
import { THEME_LABEL, nextTheme } from "@/lib/ui/nav";
import type { Theme } from "@/lib/preferences/service";
import { ThemeIcon } from "./icons";

export function ThemeCycle({ theme, action }: { theme: Theme; action: () => Promise<void> }) {
  const label = `Appearance: ${THEME_LABEL[theme]}. Switch to ${THEME_LABEL[nextTheme(theme)]}.`;
  return (
    <form action={action}>
      <button
        type="submit"
        aria-label={label}
        title={label}
        className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-md px-2 text-text hover:bg-surface-2"
      >
        <ThemeIcon />
      </button>
    </form>
  );
}

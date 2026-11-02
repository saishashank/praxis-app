// Class names of the Button variants. Kept apart from Button.tsx so client modules that only need the
// class string (the overlay triggers) do not pull the Button component into the first-load JS.
import { cn } from "./cn";

export type ButtonVariant = "default" | "secondary" | "danger" | "ghost";

const VARIANT: Record<ButtonVariant, string> = {
  default: "bg-accent text-accent-contrast hover:opacity-90 active:opacity-80",
  secondary:
    "ui-btn-secondary bg-surface text-text border border-border hover:bg-bg active:opacity-80",
  danger: "bg-danger text-accent-contrast hover:opacity-90 active:opacity-80",
  ghost: "text-accent hover:underline active:opacity-80",
};

export function buttonClass(variant: ButtonVariant = "default", extra?: string): string {
  return cn(
    "inline-flex min-h-6 min-w-6 items-center justify-center gap-1 rounded-md px-3 py-2 text-sm font-medium",
    "disabled:cursor-not-allowed disabled:opacity-60",
    VARIANT[variant],
    extra,
  );
}

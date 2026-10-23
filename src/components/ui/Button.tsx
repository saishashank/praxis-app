// Button (UXN-015): default / hover / focus (global 2 px ring) / active / disabled. A disabled button
// always says why (`disabledReason`, shown as visible text and linked with aria-describedby) so a
// greyed control is never a dead end. Server component; works as a form submit with a server action.
import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

export type ButtonVariant = "default" | "secondary" | "danger" | "ghost";

const VARIANT: Record<ButtonVariant, string> = {
  default: "bg-accent text-accent-contrast hover:opacity-90 active:opacity-80",
  secondary: "ui-btn-secondary bg-surface text-text border border-border hover:bg-bg active:opacity-80",
  danger: "bg-danger text-accent-contrast hover:opacity-90 active:opacity-80",
  ghost: "text-accent hover:underline active:opacity-80",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  /** Why the button is disabled. Setting it disables the button. */
  disabledReason?: string;
};

export function buttonClass(variant: ButtonVariant = "default", extra?: string): string {
  return cn(
    "inline-flex min-h-6 min-w-6 items-center justify-center gap-1 rounded-md px-3 py-2 text-sm font-medium",
    "disabled:cursor-not-allowed disabled:opacity-60",
    VARIANT[variant],
    extra,
  );
}

export function Button({
  variant = "default",
  disabledReason,
  className,
  disabled,
  type = "button",
  id,
  ...rest
}: ButtonProps) {
  const reasonId = disabledReason && id ? `${id}-reason` : undefined;
  const isDisabled = Boolean(disabled || disabledReason);
  const button = (
    <button
      {...rest}
      id={id}
      type={type}
      disabled={isDisabled}
      aria-describedby={reasonId ?? rest["aria-describedby"]}
      className={buttonClass(variant, className)}
    />
  );
  if (!disabledReason) return button;
  return (
    <span className="inline-flex flex-col gap-1">
      {button}
      <span id={reasonId} className="text-xs text-text-muted">
        {disabledReason}
      </span>
    </span>
  );
}

// Button (UXN-015): default / hover / focus (global 2 px ring) / active / disabled. A disabled button
// always says why (`disabledReason`, shown as visible text and linked with aria-describedby) so a
// greyed control is never a dead end. Server component; works as a form submit with a server action.
import type { ButtonHTMLAttributes } from "react";
import { buttonClass, type ButtonVariant } from "./buttonClass";

export { buttonClass, type ButtonVariant };

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  /** Why the button is disabled. Setting it disables the button. */
  disabledReason?: string;
};

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

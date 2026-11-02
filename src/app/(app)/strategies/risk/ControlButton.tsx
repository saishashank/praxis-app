"use client";
// Pause / resume / switch-off button with a confirmation step (UX-050; UXN-015). The button only
// opens a dialog; nothing is sent until "Confirm" is pressed, which submits `confirm=true` to the
// Owner-only server action. The server refuses anyone else, whatever this component renders.
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { controlErrorText, type ControlResult } from "./messages";

type Props = {
  scope: "execution" | "family";
  keyId: string;
  /** The state this button asks for. */
  state: "paused" | "enabled" | "killed";
  /** Name of the strategy or family, as shown to this viewer. */
  subject: string;
  label: string;
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  action: (fd: FormData) => Promise<ControlResult>;
};

// UXR-010: the control in the list is neutral (a toggle look, never red); the red treatment appears only
// on the confirm button inside the confirmation sheet.
export function ControlButton({
  scope,
  keyId,
  state,
  subject,
  label,
  title,
  description,
  confirmLabel,
  danger = false,
  action,
}: Props) {
  const [open, setOpen] = useState(false);
  const formId = `control-${scope}-${keyId}`;
  const [result, run, pending] = useActionState<ControlResult | null, FormData>(
    async (_prev, fd) => {
      const r = await action(fd);
      if ("ok" in r) setOpen(false); // success closes the sheet; an error stays visible inside it
      return r;
    },
    null,
  );
  const on = state !== "enabled"; // the toggle is "on" while the strategy runs, so asking for off/paused
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      trigger={
        <>
          <span
            aria-hidden="true"
            data-toggle={on ? "on" : "off"}
            className="relative inline-block h-5 w-9 shrink-0 rounded-full border border-border bg-surface-2"
          >
            <span
              className={`absolute top-0.5 size-3.5 rounded-full bg-text-muted ${on ? "left-0.5" : "right-0.5"}`}
            />
          </span>
          {label}
          <span className="sr-only"> {subject}</span>
        </>
      }
      triggerClassName="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm font-semibold text-text hover:bg-surface-2"
      title={title}
      description={description}
      primary={
        <Button
          type="submit"
          form={formId}
          variant={danger ? "danger" : "default"}
          disabled={pending}
        >
          {confirmLabel}
        </Button>
      }
    >
      <form id={formId} action={run} className="flex flex-col gap-3">
        <input type="hidden" name="scope" value={scope} />
        <input type="hidden" name="key" value={keyId} />
        <input type="hidden" name="state" value={state} />
        <input type="hidden" name="confirm" value="true" />
        <label className="flex flex-col gap-1 text-sm">
          <span>Reason (optional, kept in the audit log)</span>
          <input
            name="reason"
            maxLength={200}
            autoComplete="off"
            className="rounded-md border border-border bg-bg px-2 py-1 text-text"
          />
        </label>
        {result !== null && "error" in result ? (
          <p role="alert" className="m-0 text-sm text-danger">
            {controlErrorText(result.error)}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}

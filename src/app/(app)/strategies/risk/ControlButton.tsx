"use client";
// Pause / resume / switch-off button with a confirmation step (UX-050; UXN-015). The button only
// opens a dialog; nothing is sent until "Confirm" is pressed, which submits `confirm=true` to the
// Owner-only server action. The server refuses anyone else, whatever this component renders.
import * as Dialog from "@radix-ui/react-dialog";
import { useActionState, useState } from "react";
import { Button, buttonClass } from "@/components/ui/Button";
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
  const [result, run, pending] = useActionState<ControlResult | null, FormData>(
    async (_prev, fd) => {
      const r = await action(fd);
      if ("ok" in r) setOpen(false); // success closes the dialog; an error stays visible inside it
      return r;
    },
    null,
  );
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className={buttonClass(danger ? "danger" : "secondary")}>
        {label}
        <span className="sr-only"> {subject}</span>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-4 text-text break-words">
          <Dialog.Title className="m-0 text-lg font-semibold">{title}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            {description}
          </Dialog.Description>
          <form action={run} className="mt-4 flex flex-col gap-3">
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
            <div className="flex flex-wrap justify-end gap-2">
              <Dialog.Close className={buttonClass("secondary")}>Cancel</Dialog.Close>
              <Button type="submit" variant={danger ? "danger" : "default"} disabled={pending}>
                {confirmLabel}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

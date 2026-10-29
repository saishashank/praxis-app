"use client";
// A Users & roles action as a button that opens a confirm sheet (UXR-029, UXR-043). The sheet has one
// primary action, which submits the form inside it; red is used only on that primary button, and only
// for a destructive action (`danger`). Esc, the close button and a click outside close it without
// saving. On success the sheet closes and a toast says so. Without JavaScript the actions on this page
// are not offered (the page needs a session and the actions are server actions behind the sheet).
import { useCallback, useId, useState, type ReactNode } from "react";
import { buttonClass } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import type { ActionResult } from "@/lib/users/messages";
import { ActionForm } from "./ActionForm";

type Props = {
  /** Visible text of the trigger button. */
  label: string;
  /** Read by screen readers after the label, so rows of identical buttons are told apart. */
  forWhom?: string;
  title: string;
  description?: string;
  /** Text of the one primary button in the sheet. */
  submitLabel: string;
  danger?: boolean;
  action: (fd: FormData) => Promise<ActionResult>;
  /** Toast text after success. */
  doneText: string;
  /** Hidden inputs and fields of the form. */
  children: ReactNode;
};

export function ActionSheet({
  label,
  forWhom,
  title,
  description,
  submitLabel,
  danger,
  action,
  doneText,
  children,
}: Props) {
  const [open, setOpen] = useState(false);
  const formId = useId();
  const { toast } = useToast();
  const onSuccess = useCallback(() => {
    setOpen(false);
    toast(doneText);
  }, [toast, doneText]);
  return (
    <Sheet
      title={title}
      description={description}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <>
          {label}
          {forWhom ? <span className="sr-only"> {forWhom}</span> : null}
        </>
      }
      triggerClassName={buttonClass("secondary", "min-h-6")}
      primary={
        <button type="submit" form={formId} className={buttonClass(danger ? "danger" : "default")}>
          {submitLabel}
        </button>
      }
    >
      <ActionForm
        action={action}
        formId={formId}
        onSuccess={onSuccess}
        className="flex flex-col gap-3"
      >
        {children}
      </ActionForm>
    </Sheet>
  );
}

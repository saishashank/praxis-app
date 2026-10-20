"use client";
// Revocation is confirmed by a modal dialog (ROL-104). Native <dialog>; no inline scripts.
import { useCallback, useRef } from "react";
import { Button } from "@/components/ui/Button";
import type { ActionResult } from "@/lib/users/messages";
import { ActionForm } from "./ActionForm";

type Props = { userId: number; email: string; action: (fd: FormData) => Promise<ActionResult> };

export function RevokeButton({ userId, email, action }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useCallback(() => ref.current?.close(), []);
  return (
    <>
      <button
        type="button"
        className="min-h-6 text-accent underline"
        onClick={() => ref.current?.showModal()}
      >
        Revoke
      </button>
      <dialog
        ref={ref}
        aria-labelledby={`revoke-h-${userId}`}
        className="m-auto w-[min(90vw,28rem)] rounded-lg border border-border bg-surface p-6 text-left break-words text-text backdrop:bg-black/60"
      >
        <ActionForm action={action} onSuccess={close} className="flex flex-col gap-4">
          <input type="hidden" name="userId" value={userId} />
          <h3 id={`revoke-h-${userId}`} className="text-lg font-semibold">
            Revoke access for {email}? They are not emailed.
          </h3>
          <div className="flex gap-3">
            <Button type="submit" variant="danger">
              Confirm
            </Button>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
          </div>
        </ActionForm>
      </dialog>
    </>
  );
}

"use client";
// Revocation is confirmed by a modal dialog (ROL-104). Native <dialog>; no inline scripts.
import { useCallback, useRef } from "react";
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
        className="text-accent underline"
        onClick={() => ref.current?.showModal()}
      >
        Revoke
      </button>
      <dialog ref={ref} aria-labelledby={`revoke-h-${userId}`} className="rounded border p-6">
        <ActionForm action={action} onSuccess={close} className="flex flex-col gap-4">
          <input type="hidden" name="userId" value={userId} />
          <h3 id={`revoke-h-${userId}`} className="text-lg font-semibold">
            Revoke access for {email}? They are not emailed.
          </h3>
          <div className="flex gap-4">
            <button type="submit" className="rounded border px-3 py-1 font-medium">
              Confirm
            </button>
            <button type="button" className="rounded border px-3 py-1" onClick={close}>
              Cancel
            </button>
          </div>
        </ActionForm>
      </dialog>
    </>
  );
}

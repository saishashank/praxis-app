"use client";
// Form wrapper for the Users & roles actions: shows the error text for a returned code.
import { useActionState, useEffect, type ReactNode } from "react";
import { errorText, type ActionResult } from "@/lib/users/messages";

type Props = {
  action: (fd: FormData) => Promise<ActionResult>;
  children: ReactNode;
  className?: string;
  onSuccess?: () => void;
  /** DOM id, so a button outside the form (a sheet footer) can submit it with `form=`. */
  formId?: string;
};

export function ActionForm({ action, children, className, onSuccess, formId }: Props) {
  const [state, run] = useActionState<ActionResult | null, FormData>(
    (_prev, fd) => action(fd),
    null,
  );
  const done = state !== null && "ok" in state;
  useEffect(() => {
    if (done) onSuccess?.();
  }, [done, state, onSuccess]);
  return (
    <form id={formId} action={run} className={className}>
      {children}
      {state !== null && "error" in state && (
        <p role="alert" className="m-0 w-full text-sm text-danger">
          {errorText(state.error)}
        </p>
      )}
    </form>
  );
}

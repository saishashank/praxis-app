"use client";
// Edit form for one configuration key: shows the error text for a returned code.
import { useActionState, type ReactNode } from "react";
import { errorText } from "@/lib/users/messages";

type Result = { ok: true } | { error: string; message?: string };

type Props = {
  action: (fd: FormData) => Promise<Result>;
  children: ReactNode;
  className?: string;
};

export function ConfigForm({ action, children, className }: Props) {
  const [state, run] = useActionState<Result | null, FormData>((_prev, fd) => action(fd), null);
  return (
    <form action={run} className={className}>
      {children}
      {state !== null && "error" in state && (
        <p role="alert" className="text-sm text-red-700">
          {state.message ?? errorText(state.error)}
        </p>
      )}
      {state !== null && "ok" in state && (
        <p role="status" className="text-sm">
          Saved.
        </p>
      )}
    </form>
  );
}

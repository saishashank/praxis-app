"use client";
// Toast (UXR-046): one line, bottom centre, 4 s, optional Undo for reversible actions. A tiny provider
// plus `useToast()`; one toast at a time (a new one replaces the old). Announced politely (role=status).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export const TOAST_MS = 4000; // threshold-ok: UXR-046 duration

export type ToastOptions = { undo?: () => void; undoLabel?: string };
type Current = { id: number; message: string; undo?: () => void; undoLabel: string };
type ToastApi = { toast: (message: string, opts?: ToastOptions) => void; dismiss: () => void };

const Ctx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<Current | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setCurrent(null);
  }, []);

  const toast = useCallback(
    (message: string, opts?: ToastOptions) => {
      if (timer.current) clearTimeout(timer.current);
      seq.current += 1;
      setCurrent({
        id: seq.current,
        message,
        undo: opts?.undo,
        undoLabel: opts?.undoLabel ?? "Undo",
      });
      timer.current = setTimeout(dismiss, TOAST_MS);
    },
    [dismiss],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4"
      >
        {current ? (
          <div
            key={current.id}
            className="ui-toast pointer-events-auto flex max-w-full items-center gap-3 rounded-lg border border-border bg-surface px-4 py-2 text-sm text-text shadow-lg"
          >
            <span className="min-w-0 truncate">{current.message}</span>
            {current.undo ? (
              <button
                type="button"
                className="min-h-6 shrink-0 bg-transparent p-0 font-semibold text-accent underline"
                onClick={() => {
                  current.undo?.();
                  dismiss();
                }}
              >
                {current.undoLabel}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </Ctx.Provider>
  );
}

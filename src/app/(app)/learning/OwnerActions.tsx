"use client";
// Owner buttons of the minimal learning pages (M6 T14, decision 35; full screens are M7). Each button
// asks for a confirmation, then posts to the Owner route; a killed family asks a second time.
import { useState } from "react";

export type OwnerButton = {
  label: string;
  path: string;
  body?: Record<string, unknown>;
  prompt: string;
};

export function OwnerActions({ buttons }: { buttons: OwnerButton[] }) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function post(b: OwnerButton, extra: Record<string, unknown>): Promise<void> {
    const res = await fetch(b.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(b.body ?? {}), confirm: true, ...extra }),
    });
    const out = (await res.json().catch(() => ({}))) as { error?: string; family?: string };
    if (res.status === 409 && out.error === "second_confirmation_required") {
      if (window.confirm(`The family ${out.family ?? ""} is killed. Really continue?`)) {
        return post(b, { ...extra, confirm_killed: true });
      }
      setMessage("Cancelled.");
      return;
    }
    setMessage(
      res.ok ? "Done. Reload to see the new state." : `Refused: ${out.error ?? res.status}`,
    );
  }

  async function run(b: OwnerButton): Promise<void> {
    if (!window.confirm(b.prompt)) return;
    setBusy(true);
    try {
      await post(b, {});
    } catch {
      setMessage("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      {buttons.map((b) => (
        <button
          key={b.label}
          type="button"
          disabled={busy}
          onClick={() => void run(b)}
          className="rounded border px-3 py-1 text-sm"
        >
          {b.label}
        </button>
      ))}
      {message !== null && <p role="status">{message}</p>}
    </div>
  );
}

/** Opening the shadow results records the view once (ARN-082): the holdout then starts after it. */
export function ShadowResults({ path, children }: { path: string; children: React.ReactNode }) {
  const [sent, setSent] = useState(false);
  return (
    <details
      className="mt-4"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && !sent) {
          setSent(true);
          void fetch(path, { method: "POST" }).catch(() => undefined);
        }
      }}
    >
      <summary className="cursor-pointer text-sm font-medium">Forward shadow results</summary>
      {children}
    </details>
  );
}

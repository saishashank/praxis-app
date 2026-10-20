"use client";
// Owner buttons of the learning pages (D-125 routes, unchanged). The server renders them for the Owner
// only and the routes refuse everyone else. Each button asks for a confirmation, then posts to the
// audited Owner route; a killed family asks a second time (second_confirmation_required).
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";

export type OwnerButton = {
  label: string;
  path: string;
  body?: Record<string, unknown>;
  prompt: string;
  danger?: boolean;
};

export function OwnerActions({ buttons, label }: { buttons: OwnerButton[]; label: string }) {
  const router = useRouter();
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
      if (window.confirm(`The family ${out.family ?? ""} is switched off. Really continue?`)) {
        return post(b, { ...extra, confirm_killed: true });
      }
      setMessage("Cancelled.");
      return;
    }
    if (res.ok) {
      setMessage("Done.");
      router.refresh();
      return;
    }
    setMessage(`Refused: ${out.error ?? res.status}`);
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
    <div role="group" aria-label={label} className="mt-3 flex flex-wrap items-center gap-2">
      {buttons.map((b) => (
        <Button
          key={b.label}
          variant={b.danger ? "danger" : "secondary"}
          disabled={busy}
          onClick={() => void run(b)}
        >
          {b.label}
        </Button>
      ))}
      {message !== null && (
        <p role="status" className="m-0 text-sm">
          {message}
        </p>
      )}
    </div>
  );
}

/** Opening the shadow results records the view once (ARN-082): the holdout then starts after it. */
export function ShadowResults({ path, children }: { path: string; children: React.ReactNode }) {
  const [sent, setSent] = useState(false);
  return (
    <details
      className="mt-3"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && !sent) {
          setSent(true);
          void fetch(path, { method: "POST" }).catch(() => undefined);
        }
      }}
    >
      <summary className="inline-flex min-h-6 cursor-pointer items-center py-1 text-accent underline">
        Forward shadow results
      </summary>
      <div className="mt-2 text-sm">{children}</div>
    </details>
  );
}

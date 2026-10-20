"use client";
// Acknowledge and snooze for one alert (UXN-157, UXN-160). These call the existing routes
// POST /api/alerts/[key]/ack and /snooze (D-101): no new write path. The key may be an opaque `mk:`
// key for a masked viewer; the route resolves it on the server. Ack is final; P0 and the regime alert
// cannot be snoozed (the page passes `snoozable`).
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { SNOOZE_CHOICES, SNOOZE_LABEL, snoozeUntil, type SnoozeChoice } from "./text";

export function AlertActions({
  alertKey,
  label,
  acked,
  snoozable,
  snoozed,
}: {
  alertKey: string;
  /** Short, already masked description used in the button names. */
  label: string;
  acked: boolean;
  snoozable: boolean;
  snoozed: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const post = async (what: "ack" | "snooze", body?: unknown) => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await fetch(`/api/alerts/${encodeURIComponent(alertKey)}/${what}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      if (!r.ok) {
        setMessage(
          r.status === 400 || r.status === 409
            ? "This alert cannot be changed that way."
            : "Could not save. Try again.",
        );
        return;
      }
      setMessage(what === "ack" ? "Acknowledged." : "Snooze saved.");
      router.refresh();
    } catch {
      setMessage("Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="alert-actions">
      {acked ? null : (
        <Button
          variant="default"
          disabled={busy}
          aria-label={`Acknowledge: ${label}`}
          onClick={() => void post("ack")}
        >
          Acknowledge
        </Button>
      )}
      {!acked && snoozable
        ? SNOOZE_CHOICES.map((c: SnoozeChoice) => (
            <Button
              key={c}
              variant="secondary"
              disabled={busy}
              aria-label={`${SNOOZE_LABEL[c]}: ${label}`}
              onClick={() => void post("snooze", { until: snoozeUntil(c, new Date()) })}
            >
              {SNOOZE_LABEL[c]}
            </Button>
          ))
        : null}
      {!acked && snoozable && snoozed ? (
        <Button
          variant="ghost"
          disabled={busy}
          aria-label={`Clear snooze: ${label}`}
          onClick={() => void post("snooze", { until: null })}
        >
          Clear snooze
        </Button>
      ) : null}
      {!acked && !snoozable ? (
        <span className="text-xs text-text-muted">This alert cannot be snoozed or silenced.</span>
      ) : null}
      <span role="status" className="text-xs text-text-muted">
        {message}
      </span>
    </div>
  );
}

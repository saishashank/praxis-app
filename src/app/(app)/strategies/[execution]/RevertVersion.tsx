"use client";
// Owner-only "Revert to this version" (UX-032, BLD-R3-14). It does not write anything itself: it posts to
// the existing audited M6 Owner route `POST /api/learning/families/{family}/rollback` (audit event first,
// then the writer; D-125), which also checks the role, asks for `confirm`, and answers 409 when the
// family is killed so a second confirmation can be given. The change applies at the family's next
// restart, not now. Nothing is reverted until the Owner presses the confirm button in the dialog.
import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonClass } from "@/components/ui/Button";

type Phase = "idle" | "busy" | "needs_second" | "done" | "failed";

const REFUSAL: Record<string, string> = {
  same_version: "That is not an earlier version than the live one.",
  not_prior_live: "That version was never live, so it cannot be reverted to.",
  pending_exists: "A change is already waiting for the next restart.",
  unknown_version: "That version was not found.",
  market_data_only:
    "The strategies are not running yet (data-only mode), so nothing can be reverted.",
  forbidden: "Only the Owner can revert a version.",
  unavailable: "The change could not be saved. Please try again.",
};

export function RevertVersion({ family, versionId }: { family: string; versionId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function send(confirmKilled: boolean): Promise<void> {
    setPhase("busy");
    setMessage(null);
    try {
      const res = await fetch(`/api/learning/families/${encodeURIComponent(family)}/rollback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to_version: versionId,
          confirm: true,
          ...(confirmKilled ? { confirm_killed: true } : {}),
        }),
      });
      const out = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      if (res.status === 409 && out.error === "second_confirmation_required") {
        setPhase("needs_second");
        setMessage(
          "This strategy is switched off by its kill switch. Confirm again to schedule the revert anyway.",
        );
        return;
      }
      if (!res.ok) {
        setPhase("failed");
        setMessage(REFUSAL[out.error ?? ""] ?? `Refused: ${out.error ?? res.status}`);
        return;
      }
      setPhase("done");
      setMessage("Scheduled. The earlier version starts at the strategy's next restart.");
      router.refresh();
    } catch {
      setPhase("failed");
      setMessage(REFUSAL.unavailable!);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className={buttonClass("secondary")}>Revert to {versionId}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-4 text-text break-words">
          <Dialog.Title className="m-0 text-lg font-semibold">Revert to {versionId}?</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            The strategy goes back to this earlier version at its next restart. The step is recorded
            in the audit log and the change ledger.
          </Dialog.Description>
          {message ? (
            <p role="status" className="mt-3 text-sm">
              {message}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Dialog.Close className={buttonClass("secondary")}>
              {phase === "done" ? "Close" : "Cancel"}
            </Dialog.Close>
            {phase !== "done" ? (
              <button
                type="button"
                disabled={phase === "busy"}
                onClick={() => void send(phase === "needs_second")}
                className={buttonClass("danger")}
              >
                {phase === "needs_second" ? "Confirm again" : "Revert"}
              </button>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

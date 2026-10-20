"use client";
// Owner form of the family page (UX-071, KB-050): change numbers of the live version. The new version
// goes in as a challenger (the default of KB-050) through the audited route /api/learning/families/
// [family]/versions (D-125, unchanged). Only changed values are sent; the route checks the keys.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import type { ParamRow } from "@/lib/ui/loaders/knowledgeViews";

export function FamilyForm({ family, params }: { family: string; params: ParamRow[] }) {
  const router = useRouter();
  const numeric = params.filter((p) => p.value.trim() !== "" && Number.isFinite(Number(p.value)));
  const [values, setValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const changed = numeric.filter(
    (p) =>
      values[p.key] !== undefined &&
      values[p.key] !== "" &&
      Number(values[p.key]) !== Number(p.value),
  );

  async function submit() {
    if (changed.length === 0) return;
    const ask = `Create a new ${family} version with ${changed.length} changed value(s)? It enters as a challenger.`;
    if (!window.confirm(ask)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/learning/families/${encodeURIComponent(family)}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirm: true,
          params: Object.fromEntries(changed.map((p) => [p.key, Number(values[p.key])])),
        }),
      });
      const out = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        setMessage("Done. The new version is a challenger.");
        setValues({});
        router.refresh();
      } else {
        setMessage(`Refused: ${out.error ?? res.status}`);
      }
    } catch {
      setMessage("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (numeric.length === 0) return null;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {numeric.map((p) => (
          <label key={p.key} className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium break-words">{p.key.replace(/_/g, " ")}</span>
            <input
              type="number"
              step="any"
              min={p.min ?? undefined}
              max={p.max ?? undefined}
              placeholder={p.value}
              value={values[p.key] ?? ""}
              onChange={(e) => setValues({ ...values, [p.key]: e.target.value })}
              className="w-full rounded-md border border-border bg-bg p-2 font-mono text-text"
            />
            <span className="text-xs text-text-muted">
              Now {p.value}
              {p.min !== null && p.max !== null ? `; allowed ${p.min} to ${p.max}` : ""}
            </span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || changed.length === 0}>
          Create new version
        </Button>
        {message !== null ? (
          <p role="status" className="m-0 text-sm">
            {message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

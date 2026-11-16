"use client";
// The golden-set labelling form (M21 L1; UXN-318). One headline at a time, three radio groups, "Skip" and "Flag as unclear".
// Fully keyboard-operable: Tab and the arrow keys move between and within the groups (native radios), 1 to 4 choose within the
// focused group, S skips, U flags as unclear (not while typing in the quote box), Enter saves. The form is keyed by the
// item, so the next headline starts with an empty form and the focus on the first group.
import { useActionState, useEffect, useRef, useState } from "react";
import type { OwnerActionResult } from "@/lib/ownerTools/result";

type Choice = { value: string; label: string };
const GROUPS: { name: string; legend: string; choices: Choice[] }[] = [
  {
    name: "guidance",
    legend: "What does it say about the company's guidance?",
    choices: [
      { value: "up", label: "Raised" },
      { value: "same", label: "Unchanged" },
      { value: "down", label: "Lowered" },
      { value: "none", label: "No guidance" },
    ],
  },
  {
    name: "event_confirm",
    legend: "Does the headline confirm that the event happened?",
    choices: [
      { value: "confirmed", label: "Confirmed" },
      { value: "contradicted", label: "Contradicted" },
      { value: "unclear", label: "Unclear" },
    ],
  },
  {
    name: "tone",
    legend: "What is the tone?",
    choices: [
      { value: "negative", label: "Negative" },
      { value: "neutral", label: "Neutral" },
      { value: "positive", label: "Positive" },
    ],
  },
];

export function LabelForm({
  action,
  market,
  source,
  annId,
  title,
}: {
  action: (fd: FormData) => Promise<OwnerActionResult>;
  market: string;
  source: string;
  annId: string;
  title: string;
}) {
  const [state, run, pending] = useActionState<OwnerActionResult | null, FormData>(
    (_prev, fd) => action(fd),
    null,
  );
  const [span, setSpan] = useState("");
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.querySelector<HTMLInputElement>('input[type="radio"]')?.focus();
  }, []);

  const at = span === "" ? -1 : title.indexOf(span);
  const submit = (answer: string) => {
    const f = form.current;
    if (!f) return;
    const btn = f.querySelector<HTMLButtonElement>(`button[data-answer="${answer}"]`);
    if (btn) f.requestSubmit(btn);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t instanceof HTMLButtonElement) return; // Enter or Space on a button presses it
    const typing = t instanceof HTMLInputElement && t.type === "text";
    if (e.key === "Enter") {
      e.preventDefault();
      submit("labelled");
      return;
    }
    if (typing) return;
    const k = e.key.toLowerCase();
    if (k === "s") {
      e.preventDefault();
      submit("skip");
    } else if (k === "u") {
      e.preventDefault();
      submit("unclear");
    } else if (/^[1-4]$/.test(k)) {
      const group = t.closest("fieldset");
      const radios = group?.querySelectorAll<HTMLInputElement>('input[type="radio"]');
      const pick = radios?.[Number(k) - 1];
      if (pick) {
        e.preventDefault();
        pick.checked = true;
        pick.focus();
      }
    }
  };

  return (
    <form
      ref={form}
      action={run}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-4"
      data-testid="label-form"
    >
      <input type="hidden" name="market" value={market} />
      <input type="hidden" name="source" value={source} />
      <input type="hidden" name="ann_id" value={annId} />

      <p className="m-0 text-lg leading-snug" data-testid="label-headline">
        {at < 0 ? (
          title
        ) : (
          <>
            {title.slice(0, at)}
            <mark data-testid="label-span-mark">{span}</mark>
            {title.slice(at + span.length)}
          </>
        )}
      </p>

      {GROUPS.map((g) => (
        <fieldset key={g.name} className="m-0 flex flex-col gap-1 border-0 p-0">
          <legend className="mb-1 p-0 text-sm font-semibold">{g.legend}</legend>
          <div className="flex flex-wrap gap-2">
            {g.choices.map((c, i) => (
              <label
                key={c.value}
                className="flex min-h-11 cursor-pointer items-center gap-2 rounded border px-3 py-1 text-sm"
              >
                <input type="radio" name={g.name} value={c.value} required />
                <span>
                  {c.label} <span className="text-text-muted">({i + 1})</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}

      <div className="flex flex-col gap-1">
        <label htmlFor="label-span" className="text-sm font-semibold">
          Words from the headline that show why (optional)
        </label>
        <input
          id="label-span"
          name="span"
          type="text"
          maxLength={300}
          value={span}
          onChange={(e) => setSpan(e.target.value)}
          className="min-h-11 min-w-0 rounded border px-2 py-1 text-sm"
          aria-describedby="label-span-hint"
        />
        <p id="label-span-hint" className="m-0 text-xs text-text-muted">
          {span !== "" && at < 0
            ? "Those words are not in the headline."
            : "Copy a few words from the headline. They are highlighted above."}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          name="answer"
          value="labelled"
          data-answer="labelled"
          disabled={pending}
          className="min-h-11 rounded border px-4 py-1 text-sm font-semibold disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save answer (Enter)"}
        </button>
        <button
          type="submit"
          name="answer"
          value="skip"
          data-answer="skip"
          formNoValidate
          disabled={pending}
          className="min-h-11 rounded border px-4 py-1 text-sm disabled:opacity-60"
        >
          Skip (S)
        </button>
        <button
          type="submit"
          name="answer"
          value="unclear"
          data-answer="unclear"
          formNoValidate
          disabled={pending}
          className="min-h-11 rounded border px-4 py-1 text-sm disabled:opacity-60"
        >
          Flag as unclear (U)
        </button>
      </div>
      {state !== null && "error" in state ? (
        <p role="alert" className="m-0 text-sm text-red-700" data-testid="label-error">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

"use client";
// The V2 go-live steps (V2-S9, D-706): a read-only ordered guide with tick marks kept on THIS device only
// (localStorage, per-viewer convenience; it records nothing on the server and signs nothing off).
import { useEffect, useState } from "react";

type Step = {
  id: string;
  phase: string;
  label: string;
  help: string;
  after: string[];
};
type Props = {
  phases: { id: string; label: string }[];
  steps: Step[];
  guidePath: string;
};

const KEY = "praxis.v2golive.done";

function readDone(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(KEY);
    const v: unknown = raw === null ? {} : JSON.parse(raw);
    return typeof v === "object" && v !== null ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function V2Steps({ phases, steps, guidePath }: Props) {
  const [done, setDone] = useState<Record<string, boolean>>({});
  useEffect(() => {
    // the stored marks are read after mount: the server render has none
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDone(readDone());
  }, []);
  const toggle = (id: string, on: boolean): void => {
    const next = { ...done, [id]: on };
    setDone(next);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // storage blocked: the marks last until the page closes
    }
  };
  const label = new Map(steps.map((s) => [s.id, s.label]));
  const count = steps.filter((s) => done[s.id] === true).length;
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-sm text-text-muted" role="status">
        {count} of {steps.length} marked on this device. Full text: <code>{guidePath}</code>.
      </p>
      {phases.map((p) => (
        <section key={p.id} aria-label={p.label} className="flex flex-col gap-2">
          <h3 className="m-0 text-base font-semibold">{p.label}</h3>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {steps
              .filter((s) => s.phase === p.id)
              .map((s) => {
                const n = steps.indexOf(s) + 1;
                return (
                  <li key={s.id}>
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={done[s.id] === true}
                        onChange={(e) => toggle(s.id, e.target.checked)}
                      />
                      <span>
                        <span className="font-medium">
                          {n}. {s.label}
                        </span>
                        <span className="block text-text-muted">{s.help}</span>
                        {s.after.length > 0 && (
                          <span className="block text-text-muted">
                            After: {s.after.map((a) => label.get(a) ?? a).join("; ")}.
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
    </div>
  );
}

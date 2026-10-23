// Shared parts of the Settings pages (UXR-027 "one page, grouped rows with the current value on the
// right; tapping a row opens it", UXR-042 value row, UXR-003 current values visible before editing).
// The four sub-page tabs are gone: /settings holds every personal setting, and the detail pages
// (Appearance, Region & markets, About) are reached from its rows, with the shell breadcrumb leading
// back. No client code here: an editable row is a native <details>, so it works without JavaScript
// and by keyboard. Each page keeps its own <main> (D-137).
import Link from "next/link";
import type { ReactNode } from "react";

export function SettingsFrame({
  title = "Settings",
  intro,
  children,
}: {
  title?: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    // Settings rows read best at a form width; the data pages use the full screen width (D-170).
    <main className="mx-auto flex w-full min-w-0 flex-col gap-6 py-8" style={{ maxWidth: "64rem" }}>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="m-0 text-sm text-text-muted">{intro}</p>
      </header>
      {children}
      <p className="m-0 text-xs text-text-muted">
        Emails from this system never ask for keys or passwords. Sign in and do rotations only via
        your own bookmark.
      </p>
      <footer className="text-xs text-text-muted">
        Simulation for personal information only — not financial advice
      </footer>
    </main>
  );
}

/** A titled group of rows in one surface (UXR-009 "rows over boxes"). */
export function SettingsGroup({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`group-${id}`} className="flex min-w-0 flex-col gap-2">
      <h2 id={`group-${id}`} className="m-0 text-base font-semibold">
        {title}
      </h2>
      <div className="ui-card min-w-0 divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
        {children}
      </div>
    </section>
  );
}

/** One label / current value pair, shown inside a row. */
export type RowValue = { label: string; value: ReactNode };

function Values({ values }: { values: RowValue[] }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1.5">
      {values.map((v) => (
        <span key={v.label} className="flex min-w-0 items-baseline justify-between gap-4">
          <span className="text-sm text-text-muted">{v.label}</span>
          <span className="min-w-0 truncate text-right text-sm font-medium text-text">
            {v.value}
          </span>
        </span>
      ))}
    </span>
  );
}

const Chevron = ({ className = "" }: { className?: string }) => (
  <svg
    aria-hidden="true"
    viewBox="0 0 20 20"
    width="16"
    height="16"
    className={`shrink-0 text-text-muted transition-transform ${className}`}
  >
    <path d="M7 4l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" />
  </svg>
);

/**
 * An editable row: the current values are visible; opening it shows the form (one Save) in place.
 * `name` is the row's accessible title ("Appearance"), read before the values.
 */
export function EditRow({
  name,
  values,
  children,
  open = false,
}: {
  name: string;
  values: RowValue[];
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="group/row min-w-0" open={open}>
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-4 px-4 py-3 hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
        <span className="w-32 shrink-0 font-medium sm:w-44">{name}</span>
        <Values values={values} />
        <span className="ml-1 inline-flex items-center gap-1 text-xs text-accent">
          <span className="group-open/row:hidden">Change</span>
          <span className="hidden group-open/row:inline">Close</span>
          <Chevron className="group-open/row:rotate-90" />
        </span>
      </summary>
      <div className="border-t border-border bg-surface-2/40 px-4 py-4">{children}</div>
    </details>
  );
}

/** A row that opens a detail page (UXR-042: the whole row is the link). */
export function LinkRow({
  name,
  href,
  values = [],
  hint,
}: {
  name: string;
  href: string;
  values?: RowValue[];
  hint?: string;
}) {
  return (
    <Link
      href={href}
      className="flex min-h-14 items-center gap-4 px-4 py-3 text-text no-underline hover:bg-surface-2"
    >
      <span className="w-32 shrink-0 font-medium sm:w-44">{name}</span>
      {values.length > 0 ? (
        <Values values={values} />
      ) : (
        <span className="min-w-0 flex-1 text-sm text-text-muted">{hint}</span>
      )}
      <Chevron />
    </Link>
  );
}

export function Select({
  name,
  label,
  value,
  options,
  hint,
}: {
  name: string;
  label: string;
  value: string;
  options: Array<[string, string]>;
  hint?: string;
}) {
  const hintId = hint ? `${name}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={`field-${name}`} className="font-medium">
        {label}
      </label>
      <select
        id={`field-${name}`}
        name={name}
        defaultValue={value}
        aria-describedby={hintId}
        className="min-h-10 rounded-md border bg-surface px-2 py-1"
      >
        {options.map(([v, t]) => (
          <option key={v} value={v}>
            {t}
          </option>
        ))}
      </select>
      {hint ? (
        <span id={hintId} className="text-xs text-text-muted">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

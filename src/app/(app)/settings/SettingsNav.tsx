// Frame shared by the four Settings pages: heading with the role badge, the sub-navigation (links, no
// client code) and the fixed notes. Each page keeps its own <main> (D-137).
import Link from "next/link";
import type { ReactNode } from "react";
import { Tabs } from "@/components/ui/Nav";

export const SETTINGS_TABS = [
  { id: "personal", href: "/settings", label: "Personal" },
  { id: "appearance", href: "/settings/appearance", label: "Appearance" },
  { id: "region", href: "/settings/region", label: "Region & markets" },
  { id: "about", href: "/settings/about", label: "About" },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

export function SettingsFrame({
  tab,
  role,
  intro,
  children,
}: {
  tab: SettingsTab;
  role: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex w-full max-w-2xl min-w-0 flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <span className="rounded border px-2 py-0.5 text-xs" aria-label="Your role">
          {role}
        </span>
      </header>
      <Tabs
        label="Settings sections"
        items={SETTINGS_TABS.map((t) => ({ href: t.href, label: t.label, current: t.id === tab }))}
      />
      <p className="text-sm text-text-muted">{intro}</p>
      {children}
      <p className="text-xs">
        Emails from this system never ask for keys or passwords. Sign in and do rotations only via
        your own bookmark.
      </p>
      <nav>
        <Link href="/" className="text-sm text-accent underline">
          Home
        </Link>
      </nav>
      <footer className="text-xs text-text-muted">
        Simulation for personal information only — not financial advice
      </footer>
    </main>
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
        className="min-h-9 rounded border px-2 py-1"
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

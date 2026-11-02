"use client";
// Appearance rows: Theme (six option cards, live preview on the page while a card is highlighted,
// restored on cancel) and Motion On/Off (UXN-281; applied as data-motion="off" on <html>, the same
// attribute the root layout sets from the stored preference; prefers-reduced-motion is honoured in CSS).
import { THEMES } from "@/lib/preferences/service";
import type { ActionResult } from "@/lib/users/messages";
import { THEME_LABEL, THEME_NOTE } from "./appearance/ThemePicker";
import { ChoiceRow, setRootAttr } from "./SettingsRows";

type Action = (fd: FormData) => Promise<ActionResult>;

export function ThemeRow({ current, action }: { current: string; action: Action }) {
  return (
    <ChoiceRow
      label="Theme"
      field="theme"
      current={current}
      href="/settings/appearance"
      action={action}
      choices={THEMES.map((t) => ({ value: t, label: THEME_LABEL[t], note: THEME_NOTE[t] }))}
      onPreview={(v) => setRootAttr("data-theme", v)}
    />
  );
}

export function MotionRow({ current, action }: { current: string; action: Action }) {
  const apply = (v: string) => setRootAttr("data-motion", v === "off" ? "off" : null);
  return (
    <ChoiceRow
      label="Motion"
      field="motion"
      current={current}
      href="/settings/appearance"
      action={action}
      description="Off stops non-essential animation. It is also off automatically when your device asks for reduced motion."
      choices={[
        { value: "on", label: "On", note: "Animate transitions and sheets." },
        { value: "off", label: "Off", note: "No animation." },
      ]}
      onPreview={apply}
      onSaved={apply}
    />
  );
}

"use client";
// Settings rows (UXR-027, UXR-003, UXR-042, UXR-043, UXR-046; D-207 item 14). Each row is a ValueRow:
// label left, current value right. Tapping it opens a Sheet (bottom sheet on phones, 480 px drawer on
// desktop) holding ONE form with exactly one Save; saving closes the sheet and shows the toast "Saved".
// Without JavaScript every row is a plain link to its detail page (`href`), which carries the same
// form. A local ToastProvider is mounted here (the shell may later mount its own; the nearest wins).
import { useActionState, useId, useState, type ReactNode } from "react";
import { OptionCard, OptionGrid } from "@/components/ui/OptionCard";
import { Sheet } from "@/components/ui/Sheet";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import { ValueRow } from "@/components/ui/ValueRow";
import { errorText, type ActionResult } from "@/lib/users/messages";

type Action = (fd: FormData) => Promise<ActionResult>;
export type Choice = { value: string; label: string; note?: string };

const BTN =
  "ui-motion inline-flex min-h-11 items-center justify-center rounded-md border px-4 text-sm font-semibold";
const SAVE = `${BTN} border-accent bg-accent text-accent-contrast disabled:opacity-60`;

/** One row plus its sheet and the single form inside it. Closes and toasts "Saved" on success. */
function EditSheet({
  label,
  value,
  href,
  title,
  description,
  action,
  onSaved,
  onClosed,
  children,
}: {
  label: string;
  value: ReactNode;
  href: string;
  title: string;
  description?: string;
  action: Action;
  onSaved?: (fd: FormData) => void;
  onClosed?: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const [state, run, pending] = useActionState<ActionResult | null, FormData>(async (_p, fd) => {
    const r = await action(fd);
    if ("ok" in r) {
      setOpen(false);
      toast("Saved");
      onSaved?.(fd);
    }
    return r;
  }, null);
  const formId = `settings-form-${useId().replace(/[^a-z0-9]/gi, "")}`;

  return (
    <>
      <ValueRow
        label={label}
        value={value}
        href={href}
        onClick={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
      />
      <Sheet
        title={title}
        description={description}
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) onClosed?.();
        }}
        primary={
          <button type="submit" form={formId} disabled={pending} className={SAVE}>
            {pending ? "Saving…" : "Save"}
          </button>
        }
      >
        <form id={formId} action={run} className="flex flex-col gap-4">
          {children}
          {state !== null && "error" in state ? (
            <p role="alert" className="m-0 text-sm text-negative-text">
              {errorText(state.error)}
            </p>
          ) : null}
        </form>
      </Sheet>
    </>
  );
}

/** A row whose sheet is a set of option cards (one hidden field carries the choice). */
export function ChoiceRow({
  label,
  field,
  current,
  choices,
  href,
  title,
  description,
  action,
  onPreview,
  onSaved,
}: {
  label: string;
  field: string;
  current: string;
  choices: Choice[];
  href: string;
  title?: string;
  description?: string;
  action: Action;
  /** Live preview while a choice is highlighted; called with the stored value on cancel. */
  onPreview?: (value: string) => void;
  onSaved?: (value: string) => void;
}) {
  const [picked, setPicked] = useState(current);
  const [saved, setSaved] = useState(current);
  const shown = choices.find((c) => c.value === saved)?.label ?? saved;
  return (
    <EditSheet
      label={label}
      value={shown}
      href={href}
      title={title ?? label}
      description={description}
      action={action}
      onSaved={(fd) => {
        const v = String(fd.get(field) ?? saved);
        setSaved(v);
        onSaved?.(v);
      }}
      onClosed={() => {
        setPicked(saved);
        onPreview?.(saved);
      }}
    >
      <input type="hidden" name={field} value={picked} />
      <OptionGrid label={label}>
        {choices.map((c) => (
          <OptionCard
            key={c.value}
            title={c.label}
            description={c.note}
            selected={c.value === picked}
            onSelect={() => {
              setPicked(c.value);
              onPreview?.(c.value);
            }}
          />
        ))}
      </OptionGrid>
    </EditSheet>
  );
}

/** Quiet hours: two time fields, one Save, plus a "turn off" tick in the body (not a second Save). */
export function QuietRow({
  start,
  end,
  action,
  href,
}: {
  start: string | null;
  end: string | null;
  action: Action;
  href: string;
}) {
  const on = start && end;
  return (
    <EditSheet
      label="Quiet hours"
      value={on ? `${start}–${end}` : "Off"}
      href={href}
      title="Quiet hours"
      description="Melbourne time. Important (P1) and for-information (P2) alerts stay out of the bell count in this window; they are still listed in the inbox. Urgent (P0) alerts are always delivered."
      action={action}
    >
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Quiet from</span>
          <input
            type="time"
            name="quiet_start"
            defaultValue={start ?? "22:00"}
            className="min-h-11 rounded-md border border-border bg-surface px-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Quiet until</span>
          <input
            type="time"
            name="quiet_end"
            defaultValue={end ?? "07:00"}
            className="min-h-11 rounded-md border border-border bg-surface px-2"
          />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="quiet_off" value="1" />
        Turn quiet hours off
      </label>
    </EditSheet>
  );
}

/** Read-only sheet (no Save): fonts and attribution. Without JS it links to the About page. */
export function InfoRow({
  label,
  value,
  href,
  title,
  children,
}: {
  label: string;
  value: ReactNode;
  href: string;
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ValueRow
        label={label}
        value={value}
        href={href}
        onClick={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
      />
      <Sheet title={title} open={open} onOpenChange={setOpen}>
        {children}
      </Sheet>
    </>
  );
}

/** "Sign out everywhere": neutral row; red only inside the confirm sheet. */
export function SignOutEverywhereRow({
  action,
  href,
}: {
  action: (fd: FormData) => Promise<unknown>;
  href: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ValueRow
        label="Sign out everywhere"
        value=""
        href={href}
        onClick={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
      />
      <Sheet
        title="Sign out everywhere?"
        description="This ends your sessions on every device, including this one. You will need to sign in again."
        open={open}
        onOpenChange={setOpen}
        primary={
          <button
            type="submit"
            form="signout-everywhere-form"
            className={`${BTN} border-danger bg-danger text-accent-contrast`}
          >
            Sign out everywhere
          </button>
        }
      >
        <form
          id="signout-everywhere-form"
          action={async (fd: FormData) => {
            await action(fd);
          }}
        >
          <input type="hidden" name="confirm" value="sign_out_everywhere" />
        </form>
        <p className="m-0 text-sm">
          Only do this if you lost a device or suspect someone else has access.
        </p>
      </Sheet>
    </>
  );
}

/** A titled group with its section hue icon (UXR-055). */
export function Group({
  id,
  title,
  hue,
  icon,
  children,
}: {
  id: string;
  title: string;
  hue: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`group-${id}`} className="flex min-w-0 flex-col gap-2">
      <h2 id={`group-${id}`} className="m-0 flex items-center gap-2 text-base font-semibold">
        <span
          aria-hidden="true"
          className="inline-flex size-7 items-center justify-center rounded-full"
          style={{
            color: `var(--color-section-${hue})`,
            background: `color-mix(in srgb, var(--color-section-${hue}) var(--tint-tile), var(--color-surface-2))`,
          }}
        >
          {icon}
        </span>
        {title}
      </h2>
      <div className="ui-card min-w-0 overflow-hidden rounded-lg border border-border bg-surface px-3">
        {children}
      </div>
    </section>
  );
}

export function SettingsRoot({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

/** Apply a theme or motion preview/saved value to the root element (the layout does it on reload). */
export function setRootAttr(name: "data-theme" | "data-motion", value: string | null): void {
  const root = document.documentElement;
  if (value === null) root.removeAttribute(name);
  else root.setAttribute(name, value);
}

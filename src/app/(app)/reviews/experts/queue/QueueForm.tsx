"use client";
// Controls of the claims queue (M13-lite WP6; UXN-295). Each control is its own small form that posts to one
// server action; the server re-checks the role and writes the audit row. A refusal is shown in words next
// to the control. No state is kept here beyond the last result.
import { useActionState, useState } from "react";
import { Button, type ButtonVariant } from "@/components/ui/Button";

type Result = { ok: true } | { error: string };
type Act = (fd: FormData) => Promise<Result>;

const TEXT: Record<string, string> = {
  invalid: "Please check what you typed and try again.",
  forbidden: "You do not have access to do that.",
  not_found: "That item no longer exists.",
  illegal_edge: "That claim has already moved on, so this step is not allowed now.",
  not_confirmed: "Only a confirmed group can be used here.",
  final: "That group was merged away and cannot change.",
  unavailable: "Something went wrong. Please try again.",
};
const FIELD = "min-h-6 w-full rounded-md border border-border bg-bg p-2 text-text";

function Outcome({ state }: { state: Result | null }) {
  if (state === null) return null;
  if ("error" in state)
    return (
      <span role="alert" className="min-w-0 text-sm text-danger">
        {TEXT[state.error] ?? TEXT.unavailable}
      </span>
    );
  return (
    <span role="status" className="min-w-0 text-sm text-text-muted">
      Saved.
    </span>
  );
}

/** One button that posts hidden fields (confirm, park, reject, confirm group, bulk confirm). */
export function OneAction({
  action,
  fields,
  label,
  aria,
  variant = "secondary",
  extra,
}: {
  action: Act;
  fields: Record<string, string>;
  label: string;
  aria: string;
  variant?: ButtonVariant;
  /** An optional short reason box (reject, park). */
  extra?: { name: string; placeholder: string };
}) {
  const [state, run] = useActionState<Result | null, FormData>((_p, fd) => action(fd), null);
  return (
    <form action={run} className="flex min-w-0 flex-wrap items-center gap-2">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {extra ? (
        <input
          type="text"
          name={extra.name}
          maxLength={300}
          placeholder={extra.placeholder}
          aria-label={extra.placeholder}
          className={`${FIELD} sm:w-56`}
        />
      ) : null}
      <Button type="submit" variant={variant} aria-label={aria}>
        {label}
      </Button>
      <Outcome state={state} />
    </form>
  );
}

/** Edit the statement and the draft rule: a new version, and the claim counts as checked. */
export function EditClaim({
  action,
  claimId,
  statement,
  formalisation,
}: {
  action: Act;
  claimId: string;
  statement: string;
  formalisation: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [state, run] = useActionState<Result | null, FormData>((_p, fd) => action(fd), null);
  if (!open)
    return (
      <Button
        variant="secondary"
        aria-label={`Edit claim ${claimId}`}
        onClick={() => setOpen(true)}
      >
        Edit
      </Button>
    );
  return (
    <form action={run} className="flex min-w-0 flex-col gap-2">
      <input type="hidden" name="claim" value={claimId} />
      <label className="flex min-w-0 flex-col gap-1 text-sm">
        <span className="font-medium">Claim as written (up to 600 characters)</span>
        <textarea
          name="statement"
          required
          maxLength={600}
          rows={3}
          defaultValue={statement}
          className={FIELD}
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-sm">
        <span className="font-medium">Draft rule in words (up to 1,200 characters)</span>
        <textarea
          name="formalisation"
          maxLength={1200}
          rows={3}
          defaultValue={formalisation ?? ""}
          className={FIELD}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" aria-label={`Save the edit of claim ${claimId}`}>
          Save and mark checked
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Outcome state={state} />
      </div>
    </form>
  );
}

/** Choose a confirmed group; the claim then supports it (or contradicts it). */
export function MergeInto({
  action,
  fields,
  targets,
  idField,
  label,
  withRole,
}: {
  action: Act;
  fields: Record<string, string>;
  targets: { id: string; name: string }[];
  idField: string;
  label: string;
  withRole?: boolean;
}) {
  const [state, run] = useActionState<Result | null, FormData>((_p, fd) => action(fd), null);
  if (targets.length === 0) return null;
  return (
    <form action={run} className="flex min-w-0 flex-wrap items-center gap-2">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <select
        name={idField}
        required
        aria-label={label}
        defaultValue=""
        className={`${FIELD} sm:w-56`}
      >
        <option value="" disabled>
          {label}
        </option>
        {targets.map((t) => (
          <option key={t.id} value={t.id}>
            {t.id} {t.name}
          </option>
        ))}
      </select>
      {withRole ? (
        <select
          name="role"
          aria-label="Role in the group"
          defaultValue="supports"
          className={`${FIELD} sm:w-36`}
        >
          <option value="supports">supports</option>
          <option value="contradicts">contradicts</option>
        </select>
      ) : null}
      <Button type="submit" variant="secondary" aria-label={label}>
        {withRole ? "Add to group" : "Merge"}
      </Button>
      <Outcome state={state} />
    </form>
  );
}

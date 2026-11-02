// Users & roles (UX-111, ROL-101..107). Owner only. Shows the allowlist, the sharing
// acknowledgement, add / change role / revoke / sign-out-everywhere. The audit log has its own page (/audit, D-174).
// M7 T19c: restyled to the design system (cards, rows that become cards below 600 px).
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { requireUser } from "@/lib/auth/guard";
import { getConfig } from "@/lib/config/store";
import { authDb, mainDb } from "@/lib/db/client";
import { formatMelbourne } from "@/lib/health/format";
import { userPreferences } from "@/lib/preferences/read";
import { ACK_TEXT } from "@/lib/users/ack";
import {
  DEFAULT_MARKET,
  getSharingAck,
  listGrants,
  listUsers,
  type GrantRow,
} from "@/lib/users/service";
import { isGrantLive } from "@/lib/view/mask";
import { ActionForm } from "./ActionForm";
import { RCell, RHead, RRow, RTable } from "@/components/ui/ResponsiveTable";
import { ActionSheet } from "./ActionSheet";
import {
  addUserAction,
  changeRoleAction,
  grantUnmaskAction,
  recordSharingAckAction,
  revokeUnmaskAction,
  revokeUserAction,
  signOutEverywhereAction,
} from "./actions";

export const dynamic = "force-dynamic";

const FIELD = "min-h-6 min-w-0 rounded-md border border-border bg-bg p-2 text-text";

const LABEL = (r: string) => r.charAt(0).toUpperCase() + r.slice(1);

function who(id: number | null, names: Map<number, string>): string {
  if (id === null) return "System";
  return names.get(id) ?? `User #${id}`;
}

const DEFAULT_UNMASK_DAYS = 30; // threshold-ok: shown only if the key cannot be read; the key default is 30

function grantStatus(g: GrantRow, now: Date): "Live" | "Expired" | "Revoked" {
  if (g.revokedAt !== null) return "Revoked";
  return isGrantLive(g, now) ? "Live" : "Expired";
}

export default async function UsersPage() {
  const user = await requireUser("admin", "/users");
  const tf = (await userPreferences(user.id)).time_format;
  const db = authDb();
  const [users, ack, grants] = await Promise.all([
    listUsers(db),
    getSharingAck(db, DEFAULT_MARKET),
    listGrants(db),
  ]);
  const names = new Map<number, string>(users.map((u) => [u.id, u.email]));
  let defaultDays = DEFAULT_UNMASK_DAYS;
  try {
    const v = Number(await getConfig(mainDb(), "unmask_expiry"));
    if (Number.isInteger(v) && v > 0) defaultDays = v;
  } catch {
    // keep the default; the action reads the key again and validates it
  }
  const now = new Date();
  const grantable = users.filter((u) => u.role !== "owner" && u.status !== "revoked");

  return (
    <main className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Users &amp; roles</h1>
        <p className="m-0 text-sm text-text-muted">
          Who can sign in to Praxis, what each person can see, and the changes only you can make.
          Times are shown in Australia/Melbourne. Revocation takes effect on the next request.
        </p>
        <Link href="/" className="text-sm text-accent underline">
          Home
        </Link>
      </header>

      <Card aria-label="Sharing acknowledgement" title="Sharing acknowledgement">
        {ack ? (
          <p className="m-0">
            Recorded {formatMelbourne(ack.acknowledgedAt, tf)} by {who(ack.acknowledgedBy, names)}{" "}
            (market {ack.market}, text {ack.textVersion}).
          </p>
        ) : (
          <ActionForm action={recordSharingAckAction} className="flex flex-col gap-3">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="acknowledge" required className="mt-1" />
              <span>{ACK_TEXT}</span>
            </label>
            <Button type="submit" className="w-fit">
              Record acknowledgement
            </Button>
          </ActionForm>
        )}
      </Card>

      <Card aria-label="Users" title="Users">
        <RTable
          caption="Allowlisted users"
          headers={["Email", "Role", "Status", "Last change", "Actions"]}
        >
          {users.map((u) => (
            <RRow key={u.id}>
              <RHead>{u.email}</RHead>
              <RCell label="Role">{LABEL(u.role)}</RCell>
              <RCell label="Status">{LABEL(u.status)}</RCell>
              <RCell label="Last change">{formatMelbourne(u.updatedAt, tf)}</RCell>
              <RCell label="Actions">
                {u.status === "revoked" ? null : (
                  <div className="flex flex-wrap items-center justify-end gap-2 sm:justify-start">
                    {u.role !== "owner" && (
                      <ActionSheet
                        label="Change role"
                        forWhom={u.email}
                        title={`Change role for ${u.email}`}
                        description="The new role applies on their next request."
                        submitLabel="Save role"
                        doneText="Role saved"
                        action={changeRoleAction}
                      >
                        <input type="hidden" name="userId" value={u.id} />
                        <select
                          name="role"
                          defaultValue={u.role}
                          aria-label={`Role for ${u.email}`}
                          className={FIELD}
                        >
                          <option value="viewer">Viewer</option>
                          <option value="editor">Editor</option>
                        </select>
                      </ActionSheet>
                    )}
                    <ActionSheet
                      label="Sign out everywhere"
                      forWhom={u.email}
                      title={`Sign ${u.email} out everywhere?`}
                      description="Every device they are signed in on is signed out. They can sign in again."
                      submitLabel="Sign out everywhere"
                      doneText="Signed out everywhere"
                      action={signOutEverywhereAction}
                    >
                      <input type="hidden" name="userId" value={u.id} />
                    </ActionSheet>
                    {u.role !== "owner" && (
                      <ActionSheet
                        label="Revoke"
                        forWhom={u.email}
                        title={`Revoke access for ${u.email}?`}
                        description="They are not emailed. Revocation takes effect on their next request."
                        submitLabel="Revoke access"
                        danger
                        doneText="Access revoked"
                        action={revokeUserAction}
                      >
                        <input type="hidden" name="userId" value={u.id} />
                      </ActionSheet>
                    )}
                  </div>
                )}
              </RCell>
            </RRow>
          ))}
        </RTable>
      </Card>

      <Card aria-label="Unmask grants" title="Unmask grants">
        <div className="flex flex-col gap-3">
          <p className="m-0 text-sm text-text-muted">
            Editors and Viewers see stock codes and company names as &ldquo;Stock A&rdquo;,
            &ldquo;Stock B&rdquo; and so on. A grant lets one person see the real codes until it
            expires or you revoke it. You always see the real codes.
          </p>
          {grantable.length > 0 && (
            <ActionForm action={grantUnmaskAction} className="flex flex-wrap items-end gap-3">
              <label className="flex min-w-0 flex-col gap-1 text-sm">
                User
                <select name="userId" required className={FIELD}>
                  {grantable.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.email}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Days
                <input
                  type="number"
                  name="days"
                  min={1}
                  max={365}
                  defaultValue={defaultDays}
                  className={`${FIELD} w-24`}
                />
              </label>
              <Button type="submit" variant="secondary">
                Grant unmask
              </Button>
            </ActionForm>
          )}
          {grants.length === 0 ? (
            <EmptyState motif="list" hue="home" title="No grants yet." />
          ) : (
            <RTable
              caption="Unmask grants"
              headers={["User", "Granted", "Expires", "Status", "Actions"]}
            >
              {grants.map((g) => {
                const status = grantStatus(g, now);
                return (
                  <RRow key={g.id}>
                    <RHead>{who(g.userId, names)}</RHead>
                    <RCell label="Granted">{formatMelbourne(g.grantedAt, tf)}</RCell>
                    <RCell label="Expires">{formatMelbourne(g.expiresAt, tf)}</RCell>
                    <RCell label="Status">{status}</RCell>
                    <RCell label="Actions">
                      {status === "Live" && (
                        <ActionSheet
                          label="Revoke"
                          forWhom={`unmask grant: ${who(g.userId, names)}`}
                          title={`Revoke the unmask grant for ${who(g.userId, names)}?`}
                          description="They go back to seeing Stock A, Stock B and so on."
                          submitLabel="Revoke grant"
                          danger
                          doneText="Grant revoked"
                          action={revokeUnmaskAction}
                        >
                          <input type="hidden" name="grantId" value={g.id} />
                        </ActionSheet>
                      )}
                    </RCell>
                  </RRow>
                );
              })}
            </RTable>
          )}
        </div>
      </Card>

      <Card aria-label="Add user" title="Add user">
        <ActionForm action={addUserAction} className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            Google email
            <input
              type="email"
              name="email"
              required
              maxLength={254}
              autoComplete="off"
              className={FIELD}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Role
            <select name="role" defaultValue="viewer" className={FIELD}>
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
          </label>
          <Button type="submit" disabled={!ack} aria-describedby={ack ? undefined : "add-hint"}>
            Add user
          </Button>
          {!ack && (
            <p id="add-hint" className="m-0 w-full text-sm text-text-muted">
              Acknowledge sharing first
            </p>
          )}
        </ActionForm>
      </Card>

      <p className="m-0 text-sm text-text-muted">
        Every change made here is recorded in the{" "}
        <Link href="/audit" className="text-accent underline">
          Audit log
        </Link>
        .
      </p>

      <footer className="text-xs text-text-muted">
        Simulation for personal information only — not financial advice
      </footer>
    </main>
  );
}

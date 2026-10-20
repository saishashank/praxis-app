// Users & roles (UX-111, ROL-101..107). Owner only. Shows the allowlist, the sharing
// acknowledgement, add / change role / revoke / sign-out-everywhere, and the audit log.
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
  listAudit,
  listGrants,
  listUsers,
  type AuditRow,
  type GrantRow,
} from "@/lib/users/service";
import { isGrantLive } from "@/lib/view/mask";
import { ActionForm } from "./ActionForm";
import { RCell, RHead, RRow, RTable } from "@/components/ui/ResponsiveTable";
import { RevokeButton } from "./RevokeButton";
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
const LINK_BTN = "min-h-6 text-accent underline";

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

function target(a: AuditRow, names: Map<number, string>): string {
  if (a.targetId === null) return "";
  if (a.targetType === "app_user") return who(Number(a.targetId), names);
  return a.targetId;
}

export default async function UsersPage() {
  const user = await requireUser("admin", "/users");
  const tf = (await userPreferences(user.id)).time_format;
  const db = authDb();
  const [users, ack, events, grants] = await Promise.all([
    listUsers(db),
    getSharingAck(db, DEFAULT_MARKET),
    listAudit(db, 100),
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
              <RCell label="Role">
                {u.role === "owner" || u.status === "revoked" ? (
                  LABEL(u.role)
                ) : (
                  <ActionForm
                    action={changeRoleAction}
                    className="flex flex-wrap items-center justify-end gap-2 sm:justify-start"
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
                    <Button type="submit" variant="secondary">
                      Save
                    </Button>
                  </ActionForm>
                )}
              </RCell>
              <RCell label="Status">{LABEL(u.status)}</RCell>
              <RCell label="Last change">{formatMelbourne(u.updatedAt, tf)}</RCell>
              <RCell label="Actions">
                {u.status === "revoked" ? null : (
                  <div className="flex flex-wrap items-center justify-end gap-4 sm:justify-start">
                    <ActionForm action={signOutEverywhereAction}>
                      <input type="hidden" name="userId" value={u.id} />
                      <button
                        type="submit"
                        aria-label={`Sign out everywhere: ${u.email}`}
                        className={LINK_BTN}
                      >
                        Sign out everywhere
                      </button>
                    </ActionForm>
                    {u.role !== "owner" && (
                      <RevokeButton userId={u.id} email={u.email} action={revokeUserAction} />
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
            <EmptyState title="No grants yet." />
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
                        <ActionForm action={revokeUnmaskAction}>
                          <input type="hidden" name="grantId" value={g.id} />
                          <button
                            type="submit"
                            aria-label={`Revoke unmask grant: ${who(g.userId, names)}`}
                            className={LINK_BTN}
                          >
                            Revoke
                          </button>
                        </ActionForm>
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

      <Card aria-label="Audit log" title="Audit log">
        <div className="flex flex-col gap-3">
          <p className="m-0 text-sm text-text-muted">Latest 100 events, newest first.</p>
          <RTable caption="Audit log" headers={["When", "Event", "Actor", "Target", "Detail"]}>
            {events.map((a) => (
              <RRow key={a.id}>
                <RHead>
                  <span className="sm:whitespace-nowrap">{formatMelbourne(a.at, tf)}</span>
                </RHead>
                <RCell label="Event">
                  <span className="font-mono text-xs">{a.action}</span>
                </RCell>
                <RCell label="Actor">{who(a.actorUserId, names)}</RCell>
                <RCell label="Target">{target(a, names)}</RCell>
                <RCell label="Detail">
                  <span className="font-mono text-xs break-all">{a.detailJson ?? ""}</span>
                </RCell>
              </RRow>
            ))}
          </RTable>
        </div>
      </Card>

      <footer className="text-xs text-text-muted">
        Simulation for personal information only — not financial advice
      </footer>
    </main>
  );
}

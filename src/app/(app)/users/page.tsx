// Users & roles (UX-111, ROL-101..107). Owner only. Shows the allowlist, the sharing
// acknowledgement, add / change role / revoke / sign-out-everywhere, and the audit log.
import Link from "next/link";
import { requireUser } from "@/lib/auth/guard";
import { authDb } from "@/lib/db/client";
import { formatMelbourne } from "@/lib/health/format";
import { userPreferences } from "@/lib/preferences/read";
import { ACK_TEXT } from "@/lib/users/ack";
import {
  DEFAULT_MARKET,
  getSharingAck,
  listAudit,
  listUsers,
  type AuditRow,
} from "@/lib/users/service";
import { ActionForm } from "./ActionForm";
import { RevokeButton } from "./RevokeButton";
import {
  addUserAction,
  changeRoleAction,
  recordSharingAckAction,
  revokeUserAction,
  signOutEverywhereAction,
} from "./actions";

export const dynamic = "force-dynamic";

const LABEL = (r: string) => r.charAt(0).toUpperCase() + r.slice(1);

function who(id: number | null, names: Map<number, string>): string {
  if (id === null) return "System";
  return names.get(id) ?? `User #${id}`;
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
  const [users, ack, events] = await Promise.all([
    listUsers(db),
    getSharingAck(db, DEFAULT_MARKET),
    listAudit(db, 100),
  ]);
  const names = new Map<number, string>(users.map((u) => [u.id, u.email]));

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Users &amp; roles</h1>
        <p className="text-sm text-text-muted">
          Times are shown in Australia/Melbourne. Revocation takes effect on the next request.
        </p>
        <Link href="/" className="text-sm text-accent underline">
          Home
        </Link>
      </header>

      <section aria-labelledby="ack-h" className="flex flex-col gap-3">
        <h2 id="ack-h" className="text-xl font-semibold">
          Sharing acknowledgement
        </h2>
        {ack ? (
          <p>
            Recorded {formatMelbourne(ack.acknowledgedAt, tf)} by {who(ack.acknowledgedBy, names)}{" "}
            (market {ack.market}, text {ack.textVersion}).
          </p>
        ) : (
          <ActionForm action={recordSharingAckAction} className="flex flex-col gap-3">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="acknowledge" required className="mt-1" />
              <span>{ACK_TEXT}</span>
            </label>
            <button type="submit" className="w-fit rounded border px-3 py-1 font-medium">
              Record acknowledgement
            </button>
          </ActionForm>
        )}
      </section>

      <section aria-labelledby="users-h" className="flex flex-col gap-3">
        <h2 id="users-h" className="text-xl font-semibold">
          Users
        </h2>
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">Allowlisted users</caption>
          <thead>
            <tr>
              <th scope="col" className="py-2 pr-4">
                Email
              </th>
              <th scope="col" className="py-2 pr-4">
                Role
              </th>
              <th scope="col" className="py-2 pr-4">
                Status
              </th>
              <th scope="col" className="py-2 pr-4">
                Last change
              </th>
              <th scope="col" className="py-2">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-border align-top">
                <th scope="row" className="py-2 pr-4 font-medium">
                  {u.email}
                </th>
                <td className="py-2 pr-4">
                  {u.role === "owner" || u.status === "revoked" ? (
                    LABEL(u.role)
                  ) : (
                    <ActionForm action={changeRoleAction} className="flex items-center gap-2">
                      <input type="hidden" name="userId" value={u.id} />
                      <select
                        name="role"
                        defaultValue={u.role}
                        aria-label={`Role for ${u.email}`}
                        className="rounded border px-1 py-0.5"
                      >
                        <option value="viewer">Viewer</option>
                        <option value="editor">Editor</option>
                      </select>
                      <button type="submit" className="rounded border px-2 py-0.5">
                        Save
                      </button>
                    </ActionForm>
                  )}
                </td>
                <td className="py-2 pr-4">{LABEL(u.status)}</td>
                <td className="py-2 pr-4">{formatMelbourne(u.updatedAt, tf)}</td>
                <td className="py-2">
                  {u.status === "revoked" ? null : (
                    <div className="flex flex-wrap items-center gap-4">
                      <ActionForm action={signOutEverywhereAction}>
                        <input type="hidden" name="userId" value={u.id} />
                        <button
                          type="submit"
                          aria-label={`Sign out everywhere: ${u.email}`}
                          className="text-accent underline"
                        >
                          Sign out everywhere
                        </button>
                      </ActionForm>
                      {u.role !== "owner" && (
                        <RevokeButton userId={u.id} email={u.email} action={revokeUserAction} />
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="add-h" className="flex flex-col gap-3">
        <h2 id="add-h" className="text-xl font-semibold">
          Add user
        </h2>
        <ActionForm action={addUserAction} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Google email
            <input
              type="email"
              name="email"
              required
              maxLength={254}
              autoComplete="off"
              className="rounded border px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Role
            <select name="role" defaultValue="viewer" className="rounded border px-2 py-1">
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={!ack}
            aria-describedby={ack ? undefined : "add-hint"}
            className="rounded border px-3 py-1 font-medium disabled:opacity-50"
          >
            Add user
          </button>
          {!ack && (
            <p id="add-hint" className="text-sm">
              Acknowledge sharing first
            </p>
          )}
        </ActionForm>
      </section>

      <section aria-labelledby="audit-h" className="flex flex-col gap-3">
        <h2 id="audit-h" className="text-xl font-semibold">
          Audit log
        </h2>
        <p className="text-sm text-text-muted">Latest 100 events, newest first.</p>
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">Audit log</caption>
          <thead>
            <tr>
              <th scope="col" className="py-2 pr-4">
                When
              </th>
              <th scope="col" className="py-2 pr-4">
                Event
              </th>
              <th scope="col" className="py-2 pr-4">
                Actor
              </th>
              <th scope="col" className="py-2 pr-4">
                Target
              </th>
              <th scope="col" className="py-2">
                Detail
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map((a) => (
              <tr key={a.id} className="border-t border-border align-top">
                <td className="py-2 pr-4 whitespace-nowrap">{formatMelbourne(a.at, tf)}</td>
                <td className="py-2 pr-4 font-mono text-xs">{a.action}</td>
                <td className="py-2 pr-4">{who(a.actorUserId, names)}</td>
                <td className="py-2 pr-4">{target(a, names)}</td>
                <td className="py-2 font-mono text-xs break-all">{a.detailJson ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <footer className="text-xs text-text-muted">
        Simulation for personal information only — not financial advice
      </footer>
    </main>
  );
}

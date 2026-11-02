// Audit log (UX-111, ROL-101..107). Owner only. Moved off Users & roles to its own page (Owner
// 2026-10-23: "Audit log doesn't belong to the users and roles tab", D-174). Read-only: the latest
// 100 events, newest first, with who did what to whom.
import { Card } from "@/components/ui/Card";
import { RCell, RHead, RRow, RTable } from "@/components/ui/ResponsiveTable";
import { EmptyState } from "@/components/ui/States";
import { requireUser } from "@/lib/auth/guard";
import { authDb } from "@/lib/db/client";
import { formatMelbourne } from "@/lib/health/format";
import { userPreferences } from "@/lib/preferences/read";
import { listAudit, listUsers, type AuditRow } from "@/lib/users/service";

export const dynamic = "force-dynamic";

const AUDIT_LIMIT = 100; // threshold-ok: page size, the same as the old Users & roles card

function who(id: number | null, names: Map<number, string>): string {
  if (id === null) return "System";
  return names.get(id) ?? `User #${id}`;
}

function target(a: AuditRow, names: Map<number, string>): string {
  if (a.targetId === null) return "";
  if (a.targetType === "app_user") return who(Number(a.targetId), names);
  return a.targetId;
}

export default async function AuditPage() {
  const user = await requireUser("admin", "/audit");
  const tf = (await userPreferences(user.id)).time_format;
  const db = authDb();
  const [users, events] = await Promise.all([listUsers(db), listAudit(db, AUDIT_LIMIT)]);
  const names = new Map<number, string>(users.map((u) => [u.id, u.email]));
  return (
    <main className="mx-auto flex w-full min-w-0 flex-col gap-6 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="m-0 text-sm text-text-muted">
          Every Owner change, newest first (latest {AUDIT_LIMIT}). Read-only. Times are shown in
          Australia/Melbourne.
        </p>
      </header>
      {events.length === 0 ? (
        <EmptyState motif="list" hue="home" title="Nothing recorded yet">
          Changes you make (users, switches, sign-offs) appear here.
        </EmptyState>
      ) : (
        <Card aria-label="Audit log">
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
        </Card>
      )}
      <footer className="text-xs text-text-muted">
        Simulation for personal information only — not financial advice
      </footer>
    </main>
  );
}

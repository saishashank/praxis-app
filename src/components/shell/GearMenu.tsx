// The account menu (UXR-004 "Account is a person, not an icon"; ch.09 page map, UXN-033). The button is
// an avatar (initial letter in a circle, role on hover). The panel starts with the identity row (email,
// role), then Settings and Sign out, then a divider and the other pages the role may open (System
// health and, for the Owner, Usage, Ops checklist, Users & roles, Configuration and Data review).
// Items come from the nav model filtered by the role matrix; the pages refuse anyway. The button keeps
// its accessible name, "Account and settings menu".
import Link from "next/link";
import { gearFor } from "@/lib/ui/nav";
import type { Role } from "@/lib/auth/permissions";
import { MenuButton } from "./MenuButton";

export type Account = { email: string; name: string | null };

const ROLE_NAME: Record<Role, string> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };

/** The letter shown in the avatar: first letter of the name, else of the email, else "?". */
export function initialOf(account: Account | undefined): string {
  const src = (account?.name ?? "").trim() || (account?.email ?? "").trim();
  const ch = src.charAt(0);
  return ch ? ch.toUpperCase() : "?";
}

export function Avatar({
  account,
  role,
  size = "sm",
}: {
  account?: Account;
  role: Role;
  size?: "sm" | "lg";
}) {
  return (
    <span
      aria-hidden="true"
      title={ROLE_NAME[role]}
      className={`ui-avatar inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${
        size === "lg" ? "h-10 w-10 text-base" : "h-8 w-8 text-sm"
      }`}
    >
      {initialOf(account)}
    </span>
  );
}

const itemClass = "flex min-h-10 items-center rounded-md px-2 text-text hover:bg-surface-2";

export function GearMenu({
  role,
  account,
  signOut,
}: {
  role: Role;
  account?: Account;
  signOut: () => Promise<void>;
}) {
  const items = gearFor(role);
  const settings = items.filter((g) => g.id === "settings");
  const others = items.filter((g) => g.id !== "settings");
  return (
    <MenuButton
      label="Account and settings menu"
      title={ROLE_NAME[role]}
      icon={<Avatar account={account} role={role} />}
      className="rounded-full px-1"
    >
      <div className="flex items-center gap-3 px-2 pt-1 pb-3">
        <Avatar account={account} role={role} size="lg" />
        <p className="m-0 min-w-0 text-xs text-text-muted">
          {account?.email ? (
            <span className="block truncate text-sm font-medium text-text">{account.email}</span>
          ) : null}
          Signed in as <span className="font-semibold text-text">{ROLE_NAME[role]}</span>
        </p>
      </div>
      <ul className="m-0 list-none p-0">
        {settings.map((g) => (
          <li key={g.id}>
            <Link href={g.href} className={itemClass}>
              {g.label}
            </Link>
          </li>
        ))}
        <li>
          <form action={signOut}>
            <button type="submit" className={`${itemClass} w-full text-left font-medium`}>
              Sign out
            </button>
          </form>
        </li>
      </ul>
      {others.length > 0 ? (
        <ul className="m-0 mt-1 list-none border-t border-border p-0 pt-1">
          {others.map((g) => (
            <li key={g.id}>
              <Link href={g.href} className={itemClass}>
                {g.label}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </MenuButton>
  );
}

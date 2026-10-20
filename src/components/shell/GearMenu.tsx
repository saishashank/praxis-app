// The account (gear) menu (ch.09 page map, UXN-033): Settings, System health and, for the Owner,
// Usage, Ops checklist, Users & roles, Configuration and Data review, plus the role badge (UX-004)
// and Sign out. Items come from the nav model filtered by the role matrix; the pages refuse anyway.
import Link from "next/link";
import { gearFor } from "@/lib/ui/nav";
import type { Role } from "@/lib/auth/permissions";
import { GearIcon } from "./icons";
import { MenuButton } from "./MenuButton";

const ROLE_NAME: Record<Role, string> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };

export function GearMenu({ role, signOut }: { role: Role; signOut: () => Promise<void> }) {
  const items = gearFor(role);
  return (
    <MenuButton label="Account and settings menu" icon={<GearIcon />}>
      <p className="m-0 px-2 py-1 text-xs text-text-muted">
        Signed in as <span className="font-semibold text-text">{ROLE_NAME[role]}</span>
      </p>
      <ul className="m-0 list-none p-0">
        {items.map((g) => (
          <li key={g.id}>
            <Link
              href={g.href}
              className="flex min-h-10 items-center rounded-md px-2 text-text hover:bg-surface-2"
            >
              {g.label}
            </Link>
          </li>
        ))}
        <li>
          <form action={signOut}>
            <button
              type="submit"
              className="flex min-h-10 w-full items-center rounded-md px-2 text-left text-text hover:bg-surface-2"
            >
              Sign out
            </button>
          </form>
        </li>
      </ul>
    </MenuButton>
  );
}

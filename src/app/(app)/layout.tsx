// The signed-in shell (docs/M7_design.md 2.1, 4.2). This layout is NOT a guard: a layout does not
// re-run on every client navigation, so each page keeps its own requireUser (D-038). It reads the user
// only to choose menu items; without a user it renders the page alone (the page then redirects to
// sign-in). A failure to read the shell data shows a reduced header, never an error page.
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell";
import { signOutAction } from "@/lib/auth/actions";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/session";
import { currentTheme } from "@/lib/preferences/current";
import { envFor, loadShell, type ShellModel } from "@/lib/ui/loaders/shell";
import { cycleThemeAction } from "./settings/themeActions";

async function themeAction(): Promise<void> {
  "use server";
  await cycleThemeAction();
}

async function userOrNull(): Promise<CurrentUser | null> {
  try {
    return await getCurrentUser();
  } catch {
    return null;
  }
}

async function shellFor(user: CurrentUser): Promise<ShellModel> {
  try {
    return await loadShell(await envFor({ id: user.id, role: user.role }));
  } catch {
    return {
      state: "empty",
      user: { id: user.id, role: user.role },
      masked: true,
      market: null,
      bell: { count: 0, topTier: null },
      banners: [{ id: "shell:unavailable", text: "Some header information is unavailable." }],
    };
  }
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await userOrNull();
  if (!user) return <>{children}</>;
  const [shell, theme] = await Promise.all([shellFor(user), currentTheme()]);
  return (
    <AppShell
      role={user.role}
      theme={theme}
      market={shell.market}
      bell={shell.bell}
      banners={shell.banners}
      themeAction={themeAction}
      signOut={signOutAction}
      account={{ email: user.email, name: user.name }}
    >
      {children}
    </AppShell>
  );
}

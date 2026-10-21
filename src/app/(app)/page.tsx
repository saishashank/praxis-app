// Home = "Today" (UX-010 to UX-017, UXN-034). The guard is the first await; the loader returns an
// already masked view model (DAT-124), so this page never sees a code that the viewer may not see.
import { cookies } from "next/headers";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { loadHome } from "@/lib/ui/loaders/home";
import { HomeContent } from "./home/HomeContent";
import { welcomeCookieName } from "./home/welcome";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await requireUser("read", "/");
  const showWelcome = !(await cookies()).has(welcomeCookieName(user.id));
  let result = null;
  try {
    result = await loadHome({
      mainDb: mainDb(),
      authDb: authDb(),
      user: { id: user.id, role: user.role },
    });
  } catch {
    result = null; // the page says "Could not load Home"; the shell and menus still render
  }
  return (
    <main className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4 px-4 py-4">
      <HomeContent result={result} role={user.role} showWelcome={showWelcome} />
    </main>
  );
}

import { requireUser } from "@/lib/auth/guard";
import { signOutAction } from "@/lib/auth/actions";
import Link from "next/link";

export default async function HomePage() {
  const user = await requireUser("read", "/");
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-6 px-6 text-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/praxis-logo-light.svg"
        alt="Praxis logo"
        width={240}
        className="logo-light h-auto"
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/praxis-logo-dark.svg"
        alt="Praxis logo"
        width={240}
        className="logo-dark h-auto"
      />
      <h1 className="text-3xl font-semibold tracking-tight">Praxis</h1>
      <p className="text-muted">Practice-only investment research. All trades are simulated.</p>
      <p className="text-sm">Signed in as {user.role}</p>
      <form action={signOutAction}>
        <button type="submit" className="text-accent underline">
          Sign out
        </button>
      </form>
      <nav className="flex gap-6 text-sm">
        <Link href="/health" className="text-accent underline">
          System Health
        </Link>
        <Link href="/settings" className="text-accent underline">
          Settings
        </Link>
        {user.role === "owner" && (
          <Link href="/users" className="text-accent underline">
            Users &amp; roles
          </Link>
        )}
        {user.role === "owner" && (
          <Link href="/usage" className="text-accent underline">
            Usage
          </Link>
        )}
        {user.role === "owner" && (
          <Link href="/config" className="text-accent underline">
            Configuration
          </Link>
        )}
        <Link href="/privacy" className="text-accent underline">
          Privacy
        </Link>
        <Link href="/terms" className="text-accent underline">
          Terms
        </Link>
      </nav>
      <footer className="text-xs text-muted">
        Simulation for personal information only — not financial advice
      </footer>
    </main>
  );
}

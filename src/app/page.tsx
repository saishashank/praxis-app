import Link from "next/link";

export default function HomePage() {
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
      <nav className="flex gap-6 text-sm">
        <Link href="/privacy" className="text-accent underline">
          Privacy
        </Link>
        <Link href="/terms" className="text-accent underline">
          Terms
        </Link>
      </nav>
    </main>
  );
}

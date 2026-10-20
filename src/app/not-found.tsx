// Not found (404). Deliberately plain, like forbidden.tsx: it says nothing about whether the thing
// exists, so a masked user learns nothing from the difference between "hidden" and "missing".
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p>We could not find that page.</p>
      <Link href="/" className="inline-flex min-h-10 items-center text-accent underline">
        Go to the home page
      </Link>
    </main>
  );
}

// Rendered with status 403 when a page calls forbidden() (D-038, AT-02). Deliberately plain.
import Link from "next/link";

export default function Forbidden() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Forbidden</h1>
      <p>You do not have access to this page.</p>
      <Link href="/" className="text-accent underline">
        Go to the home page
      </Link>
    </main>
  );
}

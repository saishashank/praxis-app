import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Terms - Praxis" };

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-2xl space-y-4 px-6 py-12 leading-relaxed">
      <h1 className="text-2xl font-semibold">Terms</h1>
      <p className="text-sm text-muted">Last updated: 2026-10-09</p>
      <p>Praxis is a personal app for invited people only.</p>
      <ul className="list-disc space-y-2 pl-6">
        <li>All trading in Praxis is simulated paper trading. No real money is ever used.</li>
        <li>
          Nothing in Praxis is financial advice. Do not make real investment decisions from it.
        </li>
        <li>The app is provided as-is, with no warranty of any kind.</li>
        <li>Access can be removed at any time, for any reason, without notice.</li>
      </ul>
      <p>
        <Link href="/" className="text-accent underline">
          Back to home
        </Link>
      </p>
    </main>
  );
}

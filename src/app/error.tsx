"use client";
// Generic error page (UX-122): a plain message and the correlation id (Next's error digest) so the
// Owner can find the entry in the logs. Never the error message or stack: details are Owner-only,
// written to app_log by src/instrumentation.ts.
// A plain anchor, not next/link: this boundary is loaded on every route, and a client-side Link here
// costs a separate ~3 KB gzip copy of the Link runtime in every first load (bundle budget, UX-005). After
// an error a full page load of the home page is also the safer recovery.

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p>
        This page could not be shown. Nothing has been changed. Please try again, or go back to the
        home page.
      </p>
      <p className="text-sm text-text-muted">
        Reference: <span className="font-mono">{error.digest ?? "not available"}</span>
      </p>
      <div className="flex flex-wrap items-center justify-center gap-4">
        <button
          type="button"
          onClick={() => reset()}
          className="inline-flex min-h-10 items-center rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-contrast"
        >
          Try again
        </button>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- see the note at the top of this file */}
        <a href="/" className="inline-flex min-h-10 items-center text-accent underline">
          Go to the home page
        </a>
      </div>
    </main>
  );
}

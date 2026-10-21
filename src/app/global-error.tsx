"use client";
// Last-resort error page (UX-122): replaces the root layout, so it brings its own <html>, <body> and
// inline styles (the app stylesheet and theme are not guaranteed to load). Same content as error.tsx:
// no error text, only the correlation id.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0b0f15",
          color: "#e7ebf1",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <main style={{ maxWidth: "36rem", padding: "1.5rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.5rem", margin: "0 0 1rem" }}>Something went wrong</h1>
          <p>This page could not be shown. Nothing has been changed. Please try again.</p>
          <p style={{ color: "#9aa4b5", fontSize: "0.875rem" }}>
            Reference:{" "}
            <span style={{ fontFamily: "monospace" }}>{error.digest ?? "not available"}</span>
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              minHeight: "2.5rem",
              padding: "0.5rem 1rem",
              border: 0,
              borderRadius: "0.375rem",
              background: "#8fd3ff",
              color: "#0b0f15",
              fontSize: "0.875rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}

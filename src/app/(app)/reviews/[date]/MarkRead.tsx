"use client";
// "Mark as read" control of /reviews/<date> (Owner only; the page does not render it for others).
// With `auto` (arrival from the email link) the page posts the mark once after load.
import { useEffect, useRef, useState } from "react";
import { markReviewReadAction } from "./actions";

export function MarkRead({
  date,
  auto,
  alreadyRead,
}: {
  date: string;
  auto: boolean;
  alreadyRead: boolean;
}) {
  const [done, setDone] = useState(alreadyRead);
  const [error, setError] = useState<string | null>(null);
  const fired = useRef(false);

  async function post(via: "page" | "email_link") {
    const fd = new FormData();
    fd.set("d", date);
    fd.set("via", via);
    const r = await markReviewReadAction(fd);
    if ("error" in r) setError("Could not mark this review as read.");
    else {
      setError(null);
      setDone(true);
    }
  }

  useEffect(() => {
    if (auto && !alreadyRead && !fired.current) {
      fired.current = true;
      void post("email_link");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (done) return <p className="text-sm text-text-muted">Marked as read.</p>;
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        className="rounded border border-border px-3 py-1 text-sm"
        onClick={() => void post("page")}
      >
        Mark as read
      </button>
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
    </div>
  );
}

"use client";
// Notes (annotations, UX-071a, ROL-102b): the list and, for Owner and Editor, the add / edit / delete
// controls. Uses the existing audited route /api/learning/annotations (D-125; decision 11). The server
// decides what text a reader may see: a Viewer gets `text: null` and the line "Note added by <role> on
// <day>". `canChange` is computed on the server (author or Owner), so no user id reaches the browser.
import { EmptyState } from "@/components/ui/States";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import type { Note } from "@/lib/ui/loaders/knowledgeViews";

const MAX = 1000; // threshold-ok: ROL-102b annotation length

export function Notes({
  kind,
  id,
  notes,
  canWrite,
}: {
  kind: "lesson" | "hypothesis";
  id: string;
  notes: Note[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = `note-${kind}-${id}`.replace(/[^A-Za-z0-9_-]/g, "-");

  async function send(method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/learning/annotations", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setText("");
        setEditing(null);
        router.refresh();
      } else {
        setMessage("The note was not saved. Please try again.");
      }
    } catch {
      setMessage("The note was not saved. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {notes.length === 0 ? (
        <EmptyState compact motif="reviews" hue="reviews" title="No notes yet." />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
          {notes.map((n) => (
            <li key={n.id} className="min-w-0 break-words">
              {editing === n.id ? (
                <div className="flex flex-col gap-2">
                  <label htmlFor={`${field}-edit-${n.id}`} className="font-medium">
                    Edit note
                  </label>
                  <textarea
                    id={`${field}-edit-${n.id}`}
                    value={draft}
                    maxLength={MAX}
                    rows={3}
                    onChange={(e) => setDraft(e.target.value)}
                    className="w-full rounded-md border border-border bg-bg p-2 text-text"
                  />
                  <div className="flex gap-2">
                    <Button
                      disabled={busy || draft.trim().length === 0}
                      onClick={() => void send("PATCH", { id: n.id, text: draft })}
                    >
                      Save
                    </Button>
                    <Button variant="secondary" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : n.text === null ? (
                <>
                  Note added by {n.role} on {n.day}
                </>
              ) : (
                <>
                  {n.text}{" "}
                  <span className="text-text-muted">
                    ({n.role}, {n.day}
                    {n.edited ? ", edited" : ""})
                  </span>
                </>
              )}
              {n.canChange && editing !== n.id && n.text !== null ? (
                <span className="ml-2 inline-flex gap-1">
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setEditing(n.id);
                      setDraft(n.text ?? "");
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm("Delete this note?")) void send("DELETE", { id: n.id });
                    }}
                  >
                    Delete
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canWrite ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send("POST", { subject_kind: kind, subject_id: id, text });
          }}
        >
          <label htmlFor={field} className="text-sm font-medium">
            Add a note
          </label>
          <textarea
            id={field}
            value={text}
            maxLength={MAX}
            rows={3}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-md border border-border bg-bg p-2 text-text"
          />
          <div>
            <Button type="submit" disabled={busy || text.trim().length === 0}>
              Save note
            </Button>
          </div>
        </form>
      ) : null}
      {message !== null ? (
        <p role="alert" className="m-0 text-sm text-danger">
          {message}
        </p>
      ) : null}
    </div>
  );
}

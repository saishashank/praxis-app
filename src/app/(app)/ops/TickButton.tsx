"use client";
// "Mark done" button of one Ops task. Submits the task and the due date it was rendered with to the
// Owner-only server action; the server checks both again, so a stale page cannot tick a new date.
import { useActionState } from "react";
import { Button } from "@/components/ui/Button";
import { tickErrorText, type TickResult } from "./messages";

type Props = {
  task: string;
  due: string;
  title: string;
  action: (fd: FormData) => Promise<TickResult>;
};

export function TickButton({ task, due, title, action }: Props) {
  const [result, run, pending] = useActionState<TickResult | null, FormData>(
    async (_prev, fd) => action(fd),
    null,
  );
  return (
    <form action={run} className="flex flex-col items-start gap-1">
      <input type="hidden" name="task" value={task} />
      <input type="hidden" name="due" value={due} />
      <Button type="submit" variant="secondary" disabled={pending}>
        Mark done
        <span className="sr-only"> {title}</span>
      </Button>
      {result !== null && "error" in result ? (
        <p role="alert" className="m-0 text-sm text-danger">
          {tickErrorText(result.error)}
        </p>
      ) : null}
    </form>
  );
}

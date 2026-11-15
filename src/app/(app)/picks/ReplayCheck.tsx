// "Replay check: last N sessions" (D-1069, Owner O-84): the pick scorecard on the Track record page.
// Read-only, server-rendered, aggregates only (counts and percentages; no stock code, name or price),
// so a masked viewer sees the same figures with ISO weeks for the dates.
import { loadReplayCheck } from "@/lib/ui/loaders/pickScorecard";
import type { LoaderEnv } from "@/lib/ui/loaders/shell";
import { REPLAY_CAVEAT, REPLAY_EMPTY, REPLAY_EMPTY_TITLE, replayLines, replayTitle } from "./text";

const BOX = "min-w-0 rounded-lg border border-border bg-surface p-3 text-sm";

export async function ReplayCheck({ env }: { env: LoaderEnv }) {
  const view = await loadReplayCheck(env);
  if (view === null) {
    return (
      <section aria-label="Replay check" className={BOX} data-testid="replay-check">
        <h2 className="m-0 text-base font-semibold">{REPLAY_EMPTY_TITLE}</h2>
        <p className="m-0 mt-1 text-text-muted">{REPLAY_EMPTY}</p>
      </section>
    );
  }
  const lines = replayLines(view.summary);
  return (
    <section aria-label="Replay check" className={BOX} data-testid="replay-check">
      <h2 className="m-0 text-base font-semibold">{replayTitle(view.sessions)}</h2>
      <p className="m-0 mt-1 text-text-muted">
        {view.range}
        {view.partial ? " (some nights could not be scored)" : ""}
      </p>
      <p className="m-0 mt-2 font-medium break-words" data-testid="replay-gainers">
        {lines.gainers}
      </p>
      <p className="m-0 mt-1 break-words" data-testid="replay-losers">
        {lines.losers}
      </p>
      <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0" data-testid="replay-profiles">
        {lines.profiles.map((l) => (
          <li key={l} className="break-words">
            {l}
          </li>
        ))}
      </ul>
      {lines.strategy !== null ? (
        <p className="m-0 mt-1 break-words" data-testid="replay-strategy">
          {lines.strategy}
        </p>
      ) : null}
      {lines.cortex.length > 0 ? (
        <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0" data-testid="replay-cortex">
          {lines.cortex.map((l) => (
            <li key={l} className="break-words">
              {l}
            </li>
          ))}
        </ul>
      ) : null}
      {lines.misses !== null ? (
        <p className="m-0 mt-2 text-text-muted" data-testid="replay-misses">
          {lines.misses}
        </p>
      ) : null}
      <p className="m-0 mt-2 text-text-muted" data-testid="replay-caveat">
        {REPLAY_CAVEAT}
      </p>
    </section>
  );
}

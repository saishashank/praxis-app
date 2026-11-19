// The call part of one claim in the queue (M22 E3; KB-084, D-1435): what is proposed, in plain words, with a one-click
// confirm for a complete proposal and the typed form for any proposal that can still become a call.
import { confirmCallAction, typedCallAction } from "./actions";
import { OneAction, TypedCall } from "./QueueForm";
import type { CallEntry } from "./callBoard";

const BASIS: Record<string, string> = {
  close: "the closing price",
  open: "the opening price",
  unspecified: "the closing price (the summary does not say)",
};
const SOURCE: Record<string, string> = {
  rules: "read from the summary",
  model: "read by a model and checked against the summary",
  owner: "typed by a person",
};
const level = (micro: number | null, word: string): string =>
  micro === null ? "" : `, ${word} ${micro / 1_000_000}`;

export function CallBlock({
  claimId,
  entry,
  masked,
}: {
  claimId: string;
  entry: CallEntry | undefined;
  masked: boolean;
}) {
  if (entry === undefined) return null;
  if (entry.kind === "followed") {
    const c = entry.call;
    return (
      <span className="text-text-muted" data-queue-call-state="followed">
        Call: {masked ? "stock hidden" : c.code},{" "}
        {c.direction === "long" ? "expects a rise" : "expects a fall"}, from {c.callD}, followed for{" "}
        {c.horizonSessions} trading days.{" "}
        {c.tracked
          ? "It is followed as a paper call, never as a pick or an order."
          : "It is stored but not followed, because the stock is not in the active list."}
      </span>
    );
  }
  const p = entry.proposal;
  if (p.state === "not_trackable")
    return (
      <span className="text-text-muted" data-queue-call-state="not_trackable">
        Call proposal: {p.reason}
      </span>
    );
  const known = {
    code: masked ? null : p.code,
    direction: p.direction,
    date: p.callD,
    horizon: p.horizonSessions,
    basis: p.priceBasis === "open" ? "open" : "close",
  };
  return (
    <div
      className="flex min-w-0 flex-col gap-2"
      data-queue-call={claimId}
      data-queue-call-state={p.state}
    >
      {p.state === "complete" ? (
        <span>
          Proposed paper call ({SOURCE[p.source] ?? p.source}): {masked ? "stock hidden" : p.code},{" "}
          {p.direction === "long" ? "expects a rise" : "expects a fall"}, from {p.callD}, followed
          for {p.horizonSessions} trading days, priced at {BASIS[p.priceBasis]}
          {level(p.targetMicro, "target")}
          {level(p.stopMicro, "stop")}. It is not followed until you confirm it.
        </span>
      ) : (
        <span>
          Call proposal is incomplete. {p.reason} It is not followed until the missing parts are
          typed in and confirmed.
        </span>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {p.state === "complete" && !masked ? (
          <OneAction
            action={confirmCallAction}
            fields={{ claim: claimId, proposal: p.proposalId }}
            label="Follow this call"
            aria={`Follow the proposed call of claim ${claimId}`}
            variant="default"
          />
        ) : null}
        {masked ? null : <TypedCall action={typedCallAction} claimId={claimId} known={known} />}
      </div>
    </div>
  );
}

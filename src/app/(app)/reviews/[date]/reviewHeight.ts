// The review frame's starting height (M21 C1, D-1203). The frame cannot run a script, so the parent measures the
// frame document on load; until then the server hands the browser an estimate from the stored plain-text
// alternative, so the page does not jump much. Pure; kept out of the client file so a server component can call it.

export const REVIEW_FRAME_MIN_PX = 320;
export const REVIEW_FRAME_MAX_PX = 4000;
const LINE_PX = 28;

/** Pixels the frame needs: 28 px a text line of the stored plain-text version, clamped to 320..4,000. */
export function estimateReviewHeightPx(text: string | null | undefined): number {
  const lines = typeof text === "string" && text !== "" ? text.split("\n").length : 0;
  return clampReviewHeightPx(lines * LINE_PX);
}

export function clampReviewHeightPx(px: number): number {
  if (!Number.isFinite(px)) return REVIEW_FRAME_MIN_PX;
  return Math.min(REVIEW_FRAME_MAX_PX, Math.max(REVIEW_FRAME_MIN_PX, Math.ceil(px)));
}

// The registry lineage of an intraday-stream cell (M23 M3; VAL-118, VAL-120, D-1608, D-1723). Each cell of the stream (`v1`, then
// one per quarter after a failed look, D-670) is its own lineage, because a later cell is tested on new forward sessions only.
// Pure: a cell id such as `intraday_stream:AU:v1` or `intraday_stream:AU:v1:2031Q1` gives `intraday_stream_v1` or
// `intraday_stream_v1_2031Q1`; the market is its own column of the registry, so no market is part of the key.
export const STREAM_CELL_PREFIX = "intraday_stream";

/** The lineage key of a stream cell; null for an id that is not a stream cell of the market. */
export function streamLineage(cellId: string, market: string): string | null {
  const head = `${STREAM_CELL_PREFIX}:${market}:`;
  if (!cellId.startsWith(head)) return null;
  const rest = cellId.slice(head.length);
  return rest.length === 0 ? null : `${STREAM_CELL_PREFIX}_${rest.replace(/:/g, "_")}`;
}

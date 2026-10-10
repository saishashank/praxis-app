"""Yahoo EOD fetcher (M2 T5, design decision 2 / D-057, PLT-072, DAT-103).

Runs in the GitHub Actions job `ingest-batch1` (Python 3.12). It only FETCHES: it reads a JSON
request, downloads daily bars for `<code>.AX` through yfinance in chunks, and writes `bars.json`.
No database access, no secrets. A Node writer (src/lib/data/sources/yahoo.ts, then the T6 writer)
validates the file and writes Turso. Nothing is repaired or filled here (DAT-004): rows with an
unusable value are written with null so the validator rejects them visibly; days with no data at
all (non-trading days) are skipped.

Request file:  {"codes": ["ZZZ", ...], "start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}   (end inclusive)
Output file:   [{"code","date","open","high","low","close","volume","adj_close",
                 "source":"yahoo","published_at":null,"fetched_at"}, ...]

Throttle (decision 8): YAHOO_CHUNK_SIZE (default 100, 10..500) tickers per request and
YAHOO_MIN_GAP_S (default 5, 1..60) seconds minimum between requests. On a rate-limit response the
fetcher backs off and retries a bounded number of times, then exits non-zero (exit 3) so the stage
fails visibly instead of filling gaps.

Exit codes: 0 ok, 2 bad input/config or fetch error, 3 rate limited.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Iterable

DEFAULT_CHUNK_SIZE = 100
DEFAULT_MIN_GAP_S = 5
CHUNK_BOUNDS = (10, 500)
GAP_BOUNDS = (1, 60)
MAX_RETRIES = 2
BACKOFF_FACTOR = 4  # backoff = min_gap * BACKOFF_FACTOR ** attempt

CODE_RE = re.compile(r"^[A-Z0-9]{2,6}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class FetchError(Exception):
    """A fetch failed in a way that must fail the stage."""


class RateLimited(FetchError):
    """Yahoo asked us to slow down (HTTP 429) and retries are exhausted."""


class InputError(Exception):
    """The request file or the configuration is invalid."""


def _bounded_int(name: str, raw: str | None, default: int, bounds: tuple[int, int]) -> int:
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw.strip())
    except ValueError as exc:
        raise InputError(f"{name} must be a whole number") from exc
    if not bounds[0] <= value <= bounds[1]:
        raise InputError(f"{name} must be from {bounds[0]} to {bounds[1]}")
    return value


def load_throttle(env: dict[str, str] | None = None) -> tuple[int, int]:
    """(chunk_size, min_gap_s) from the environment, validated against the config bounds."""
    e = os.environ if env is None else env
    return (
        _bounded_int("YAHOO_CHUNK_SIZE", e.get("YAHOO_CHUNK_SIZE"), DEFAULT_CHUNK_SIZE, CHUNK_BOUNDS),
        _bounded_int("YAHOO_MIN_GAP_S", e.get("YAHOO_MIN_GAP_S"), DEFAULT_MIN_GAP_S, GAP_BOUNDS),
    )


def parse_request(raw: Any) -> tuple[list[str], str, str]:
    """Validate the request JSON. Returns (codes, start, end); codes are unique, order kept."""
    if not isinstance(raw, dict):
        raise InputError("request must be a JSON object")
    codes = raw.get("codes")
    if not isinstance(codes, list) or not codes:
        raise InputError("codes must be a non-empty list")
    seen: dict[str, None] = {}
    for c in codes:
        if not isinstance(c, str) or not CODE_RE.match(c):
            raise InputError("every code must be 2 to 6 upper-case letters or digits")
        seen[c] = None
    start, end = raw.get("start"), raw.get("end")
    for label, v in (("start", start), ("end", end)):
        if not isinstance(v, str) or not DATE_RE.match(v):
            raise InputError(f"{label} must be YYYY-MM-DD")
        try:
            date.fromisoformat(v)
        except ValueError as exc:
            raise InputError(f"{label} is not a real date") from exc
    if start > end:  # type: ignore[operator]
        raise InputError("start must not be after end")
    return list(seen), start, end  # type: ignore[return-value]


def chunks(items: list[str], size: int) -> Iterable[list[str]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


def _clean(v: Any) -> float | None:
    """A finite float, else None (NaN, inf and missing values are never filled)."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _volume(v: Any) -> int | None:
    f = _clean(v)
    if f is None:
        return None
    return int(f) if f == int(f) else None  # fractional volume is passed as null, not rounded


def _is_rate_limit(exc: BaseException) -> bool:
    name = type(exc).__name__
    text = str(exc)
    return "RateLimit" in name or "429" in text or "Too Many Requests" in text


def _frame_for(df: Any, ticker: str) -> Any:
    """The per-ticker sub-frame of a (possibly multi-index) yfinance result, or None."""
    try:
        return df[ticker]
    except (KeyError, TypeError):
        return None


def rows_from_frame(df: Any, codes: list[str], fetched_at: str) -> list[dict[str, Any]]:
    """Convert a yfinance download result to bar rows (no repair, all-NaN days skipped)."""
    out: list[dict[str, Any]] = []
    if df is None or getattr(df, "empty", True):
        return out
    single = len(codes) == 1
    for code in codes:
        sub = _frame_for(df, f"{code}.AX")
        if sub is None and single:
            sub = df  # single-ticker results may be flat
        if sub is None or getattr(sub, "empty", True):
            continue
        for idx, rec in sub.iterrows():
            o, h, lo, c = (_clean(rec.get(k)) for k in ("Open", "High", "Low", "Close"))
            adj = _clean(rec.get("Adj Close"))
            vol = _volume(rec.get("Volume"))
            if all(x is None for x in (o, h, lo, c, adj)):
                continue  # no data for the day (not a trading day for this code)
            day = idx.date() if hasattr(idx, "date") else date.fromisoformat(str(idx)[:10])
            out.append(
                {
                    "code": code,
                    "date": day.isoformat(),
                    "open": o,
                    "high": h,
                    "low": lo,
                    "close": c,
                    "volume": vol,
                    "adj_close": adj,
                    "source": "yahoo",
                    "published_at": None,
                    "fetched_at": fetched_at,
                }
            )
    return out


def fetch_all(
    codes: list[str],
    start: str,
    end: str,
    chunk_size: int,
    min_gap_s: int,
    download: Callable[..., Any],
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Download in chunks, never closer together than `min_gap_s`. Returns (rows, report)."""
    # yfinance treats `end` as exclusive; the request's `end` is inclusive.
    end_exclusive = (date.fromisoformat(end) + timedelta(days=1)).isoformat()
    rows: list[dict[str, Any]] = []
    last_request: float | None = None
    requests = 0
    retries = 0
    for chunk in chunks(codes, chunk_size):
        tickers = [f"{c}.AX" for c in chunk]
        attempt = 0
        while True:
            if last_request is not None:
                wait = min_gap_s - (clock() - last_request)
                if attempt > 0:
                    wait = max(wait, min_gap_s * BACKOFF_FACTOR**attempt)
                if wait > 0:
                    sleep(wait)
            last_request = clock()
            requests += 1
            try:
                df = download(
                    tickers=tickers,
                    start=start,
                    end=end_exclusive,
                    interval="1d",
                    auto_adjust=False,
                    group_by="ticker",
                    progress=False,
                    threads=False,
                )
                break
            except Exception as exc:  # noqa: BLE001 - classified below
                if _is_rate_limit(exc):
                    if attempt >= MAX_RETRIES:
                        raise RateLimited("rate limited by Yahoo; retries exhausted") from exc
                    attempt += 1
                    retries += 1
                    continue
                raise FetchError(f"download failed: {type(exc).__name__}") from exc
        rows.extend(rows_from_frame(df, chunk, now().strftime("%Y-%m-%dT%H:%M:%S.000Z")))
    got = {r["code"] for r in rows}
    report = {
        "requested": len(codes),
        "with_data": len(got),
        "missing": sorted(set(codes) - got),
        "rows": len(rows),
        "requests": requests,
        "rate_limit_retries": retries,
    }
    return rows, report


def run(
    request_path: str,
    output_path: str,
    env: dict[str, str] | None = None,
    download: Callable[..., Any] | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    with open(request_path, encoding="utf-8") as f:
        try:
            raw = json.load(f)
        except json.JSONDecodeError as exc:
            raise InputError("request file is not valid JSON") from exc
    codes, start, end = parse_request(raw)
    chunk_size, min_gap_s = load_throttle(env)
    if download is None:
        import yfinance as yf  # imported late so tests and --help work without it

        download = yf.download
    rows, report = fetch_all(codes, start, end, chunk_size, min_gap_s, download, sleep=sleep)
    tmp = f"{output_path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rows, f, allow_nan=False, separators=(",", ":"))
    os.replace(tmp, output_path)  # the file appears complete or not at all
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Fetch Yahoo daily bars into bars.json (no DB access).")
    ap.add_argument("--request", required=True, help="JSON file: codes, start, end")
    ap.add_argument("--output", required=True, help="where to write bars.json")
    ap.add_argument("--report", help="optional path for a counts-only JSON report")
    args = ap.parse_args(argv)
    try:
        report = run(args.request, args.output)
    except InputError as exc:
        print(f"yahoo_fetch: input error: {exc}", file=sys.stderr)
        return 2
    except RateLimited as exc:
        print(f"yahoo_fetch: {exc}", file=sys.stderr)
        return 3
    except FetchError as exc:
        print(f"yahoo_fetch: {exc}", file=sys.stderr)
        return 2
    summary = {k: v for k, v in report.items() if k != "missing"}
    summary["missing_count"] = len(report["missing"])
    print(f"yahoo_fetch: {json.dumps(summary)}")  # counts only, no codes (SEC-110 b)
    if args.report:
        with open(args.report, "w", encoding="utf-8") as f:
            json.dump(report, f)
    return 0


if __name__ == "__main__":
    sys.exit(main())

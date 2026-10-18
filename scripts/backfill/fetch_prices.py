"""Yahoo price-history fetch for one month (M4 T16a, D-092 draft; D-086, DAT-125).

Runs in the job `backfill-prices` with NO secrets and NO database. Reads plan.json
({"month","start","end","codes"}), downloads daily bars for `<code>.AX` with auto_adjust=False and
actions=True (Yahoo then returns split-adjusted, dividend-unadjusted bars plus the split column),
and writes prices.json {"month","vendor":"adjusted","bars":[{code,d,o,h,l,c,volume}],
"splits":[{code,exDate,ratio}]}. Nothing is repaired (DAT-004): an unusable value is written as
null so the Node validator rejects the month visibly. Stops at the first rate limit (no loop).
Counts only are printed. Tested by test_fetch_prices.py in CI only (no Python locally).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "ingest"))
import yahoo_fetch as yf_fetch  # noqa: E402  (shared throttle, cleaning and error classes)


def month_rows(df: Any, codes: list[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(bars, splits) from a yfinance frame; all-NaN days are skipped, split value 0/NaN ignored."""
    bars: list[dict[str, Any]] = []
    splits: list[dict[str, Any]] = []
    if df is None or getattr(df, "empty", True):
        return bars, splits
    single = len(codes) == 1
    for code in codes:
        sub = yf_fetch._frame_for(df, f"{code}.AX")
        if sub is None and single:
            sub = df
        if sub is None or getattr(sub, "empty", True):
            continue
        for idx, rec in sub.iterrows():
            o, h, lo, c = (yf_fetch._clean(rec.get(k)) for k in ("Open", "High", "Low", "Close"))
            if all(x is None for x in (o, h, lo, c)):
                continue
            day = idx.date() if hasattr(idx, "date") else date.fromisoformat(str(idx)[:10])
            bars.append(
                {
                    "code": code,
                    "d": day.isoformat(),
                    "o": o,
                    "h": h,
                    "l": lo,
                    "c": c,
                    "volume": yf_fetch._volume(rec.get("Volume")),
                }
            )
            ratio = yf_fetch._clean(rec.get("Stock Splits"))
            if ratio is not None and ratio > 0 and ratio != 1:
                splits.append({"code": code, "exDate": day.isoformat(), "ratio": ratio})
    return bars, splits


def fetch_month(
    plan: dict[str, Any],
    chunk_size: int,
    min_gap_s: int,
    download: Callable[..., Any],
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    codes = plan.get("codes")
    if (
        not isinstance(codes, list)
        or not codes
        or not all(isinstance(c, str) and yf_fetch.CODE_RE.match(c) for c in codes)
    ):
        raise yf_fetch.InputError("plan.codes must be a non-empty list of codes")
    month, start, end = plan.get("month"), plan.get("start"), plan.get("end")
    for v in (start, end):
        if not isinstance(v, str) or not yf_fetch.DATE_RE.match(v):
            raise yf_fetch.InputError("plan.start/end must be YYYY-MM-DD")
    if not isinstance(month, str) or not start.startswith(month) or start > end:
        raise yf_fetch.InputError("plan.month does not match start/end")
    end_exclusive = (date.fromisoformat(end) + timedelta(days=1)).isoformat()
    bars: list[dict[str, Any]] = []
    splits: list[dict[str, Any]] = []
    last: float | None = None
    for chunk in yf_fetch.chunks(codes, chunk_size):
        attempt = 0
        while True:
            if last is not None:
                wait = min_gap_s - (clock() - last)
                if attempt > 0:
                    wait = max(wait, min_gap_s * yf_fetch.BACKOFF_FACTOR**attempt)
                if wait > 0:
                    sleep(wait)
            last = clock()
            try:
                df = download(
                    tickers=[f"{c}.AX" for c in chunk],
                    start=start,
                    end=end_exclusive,
                    interval="1d",
                    auto_adjust=False,
                    actions=True,
                    group_by="ticker",
                    progress=False,
                    threads=False,
                )
                break
            except Exception as exc:  # noqa: BLE001 - classified below
                if yf_fetch._is_rate_limit(exc):
                    if attempt >= yf_fetch.MAX_RETRIES:
                        raise yf_fetch.RateLimited("rate limited by Yahoo; retries exhausted") from exc
                    attempt += 1
                    continue
                raise yf_fetch.FetchError(f"download failed: {type(exc).__name__}") from exc
        b, s = month_rows(df, chunk)
        bars.extend(b)
        splits.extend(s)
    bars.sort(key=lambda r: (r["code"], r["d"]))
    return {"month": month, "vendor": "adjusted", "bars": bars, "splits": splits}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Fetch one month of Yahoo bars (no DB, no secrets).")
    ap.add_argument("--plan", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args(argv)
    try:
        with open(args.plan, encoding="utf-8") as f:
            plan = json.load(f)
        chunk_size, min_gap_s = yf_fetch.load_throttle()
        import yfinance as yf  # imported late so tests work without it

        doc = fetch_month(plan, chunk_size, min_gap_s, yf.download)
    except yf_fetch.InputError as exc:
        print(f"fetch_prices: input error: {exc}", file=sys.stderr)
        return 2
    except yf_fetch.RateLimited as exc:
        print(f"fetch_prices: {exc}", file=sys.stderr)
        return 3
    except (yf_fetch.FetchError, OSError, json.JSONDecodeError) as exc:
        print(f"fetch_prices: failed ({type(exc).__name__})", file=sys.stderr)
        return 2
    tmp = f"{args.output}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, allow_nan=False, separators=(",", ":"))
    os.replace(tmp, args.output)
    print(f"fetch_prices: month={doc['month']} bars={len(doc['bars'])} splits={len(doc['splits'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

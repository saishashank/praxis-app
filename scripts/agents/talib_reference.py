"""TA-Lib reference fixture generator (M4 T16a, D-092 draft; D-053, D-081, AGT-032).

Computes SMA/EMA/RSI/ATR (the series `parseTaLibFixture` understands), Bollinger bands and the four
candle patterns used by src/lib/agents/patterns.ts (CDLENGULFING, CDLHAMMER, CDLMORNINGSTAR,
CDLPIERCING) on a SYNTHETIC deterministic OHLCV series (codes ZZ, no market data) and prints the
fixture JSON (format "praxis-talib-ref/1") to stdout and, when set, to the GitHub step summary.
Bollinger and pattern results go under the extra top-level key "extras", which the loader ignores.
No network, no files written, no secrets. Needs TA-Lib and numpy; tested by test_talib_reference.py
in CI with a fake talib module (no Python locally).
"""

from __future__ import annotations

import json
import math
import os
import sys
from typing import Any

FORMAT = "praxis-talib-ref/1"
TOLERANCE = 1e-6
N_BARS = 300
PATTERNS = ("CDLENGULFING", "CDLHAMMER", "CDLMORNINGSTAR", "CDLPIERCING")


def synthetic_series(n: int = N_BARS) -> dict[str, list[float]]:
    """Deterministic OHLCV: a drifting sine plus an LCG wobble, wide bodies and shadows (codes ZZ)."""
    state = 12345
    o, h, lo, c, v = [], [], [], [], []
    prev = 100.0
    for i in range(n):
        state = (1103515245 * state + 12345) % 2**31
        a = state / 2**31 - 0.5
        state = (1103515245 * state + 12345) % 2**31
        b = state / 2**31
        state = (1103515245 * state + 12345) % 2**31
        d = state / 2**31
        close = max(1.0, prev + 3.0 * math.sin(i / 7.0) + 4.0 * a)
        open_ = prev + 1.5 * (b - 0.5)
        high = max(open_, close) + 3.0 * d
        low = min(open_, close) - 3.0 * (1.0 - b) * d - 0.05
        o.append(round(open_, 4))
        h.append(round(high, 4))
        lo.append(round(low, 4))
        c.append(round(close, 4))
        v.append(float(1000 + int(5000 * d)))
        prev = close
    return {"open": o, "high": h, "low": lo, "close": c, "volume": v}


def clean(values: Any) -> list[float | None]:
    """NaN (TA-Lib lookback) to None."""
    return [None if (x is None or math.isnan(float(x))) else float(x) for x in values]


def build_fixture(talib: Any, np: Any, series: dict[str, list[float]]) -> dict[str, Any]:
    arr = {k: np.array(vals, dtype="float64") for k, vals in series.items()}
    expected = {
        "SMA_20": {"fn": "sma", "period": 20, "values": clean(talib.SMA(arr["close"], 20))},
        "EMA_20": {"fn": "ema", "period": 20, "values": clean(talib.EMA(arr["close"], 20))},
        "RSI_14": {"fn": "rsi", "period": 14, "values": clean(talib.RSI(arr["close"], 14))},
        "ATR_14": {
            "fn": "atr",
            "period": 14,
            "values": clean(talib.ATR(arr["high"], arr["low"], arr["close"], 14)),
        },
    }
    up, mid, low = talib.BBANDS(arr["close"], 20, 2, 2)
    patterns = {
        name: [int(x) for x in getattr(talib, name)(arr["open"], arr["high"], arr["low"], arr["close"])]
        for name in PATTERNS
    }
    return {
        "format": FORMAT,
        "name": "synthetic_zz_300",
        "generator": f"ta-lib=={talib.__version__}",
        "tolerance": TOLERANCE,
        "input": series,
        "expected": expected,
        "extras": {
            "bbands_20_2": {"upper": clean(up), "middle": clean(mid), "lower": clean(low)},
            "patterns": patterns,
        },
    }


def main() -> int:
    import numpy as np
    import talib

    fixture = build_fixture(talib, np, synthetic_series())
    text = json.dumps(fixture, allow_nan=False, indent=1)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("### TA-Lib reference fixture\n\n```json\n" + text + "\n```\n")
    hits = {k: sum(1 for x in v if x != 0) for k, v in fixture["extras"]["patterns"].items()}
    print(f"talib_reference: bars={N_BARS} pattern_hits={hits}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

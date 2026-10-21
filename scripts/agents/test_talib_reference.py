"""pytest for talib_reference.py with a fake talib/numpy (no TA-Lib needed). CI only (job
`python`); there is no Python on the Windows build machine."""

import json
import math

import talib_reference as tr


class FakeNp:
    @staticmethod
    def array(vals, dtype=None):
        return list(vals)


class FakeTalib:
    __version__ = "0.0.0-test"

    @staticmethod
    def _nan_head(vals, k):
        return [math.nan] * k + [float(x) for x in vals[k:]]

    SMA = EMA = RSI = staticmethod(lambda x, p: FakeTalib._nan_head(x, p - 1))
    ATR = staticmethod(lambda h, lo, c, p: FakeTalib._nan_head(c, p))
    BBANDS = staticmethod(lambda x, p, a, b: (FakeTalib._nan_head(x, p - 1),) * 3)
    CDLENGULFING = CDLHAMMER = CDLMORNINGSTAR = CDLPIERCING = staticmethod(
        lambda o, h, lo, c: [0, 100] * (len(c) // 2)
    )


def test_series_is_deterministic_and_valid():
    a, b = tr.synthetic_series(), tr.synthetic_series()
    assert a == b
    assert all(len(v) == tr.N_BARS for v in a.values())
    for i in range(tr.N_BARS):
        assert a["low"][i] > 0
        assert a["high"][i] >= max(a["open"][i], a["close"][i])
        assert a["low"][i] <= min(a["open"][i], a["close"][i])
        assert a["volume"][i] > 0


def test_fixture_shape_matches_loader_format():
    fx = tr.build_fixture(FakeTalib, FakeNp, tr.synthetic_series())
    assert fx["format"] == "praxis-talib-ref/1" and fx["generator"] == "ta-lib==0.0.0-test"
    assert set(fx["expected"]) == {"SMA_20", "EMA_20", "RSI_14", "ATR_14"}
    for e in fx["expected"].values():
        assert e["fn"] in ("sma", "ema", "rsi", "atr") and len(e["values"]) == tr.N_BARS
        assert e["values"][0] is None  # lookback NaN becomes null
    assert set(fx["extras"]["patterns"]) == set(tr.PATTERNS)
    json.dumps(fx, allow_nan=False)  # no NaN leaks into the JSON

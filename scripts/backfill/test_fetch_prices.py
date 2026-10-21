"""pytest for fetch_prices.py. yfinance is never imported: `download` is injected. CI only
(job `python`); there is no Python on the Windows build machine. Invented data, codes ZZ*."""

import json
import sys
import types

import pandas as pd
import pytest

import fetch_prices as fp
import yahoo_fetch as yf_fetch

PLAN = {"month": "2020-01", "start": "2020-01-01", "end": "2020-01-31", "codes": ["ZZA", "ZZB"]}


def frame(codes, split_on=None):
    idx = pd.date_range("2020-01-06", periods=3, freq="B")
    cols = pd.MultiIndex.from_product(
        [[f"{c}.AX" for c in codes], ["Open", "High", "Low", "Close", "Volume", "Stock Splits"]]
    )
    data = {}
    for ci, c in enumerate(codes):
        for i in range(3):
            b = 10 + ci + i
            for k, v in (
                ("Open", b),
                ("High", b + 1),
                ("Low", b - 1),
                ("Close", b),
                ("Volume", 1000 + i),
                ("Stock Splits", 2.0 if split_on == i else 0.0),
            ):
                data.setdefault((f"{c}.AX", k), []).append(float(v))
    return pd.DataFrame(data, index=idx, columns=cols)


def test_bars_and_splits():
    doc = fp.fetch_month(
        PLAN, 100, 1, lambda **kw: frame(["ZZA", "ZZB"], split_on=1), sleep=lambda s: None
    )
    assert doc["vendor"] == "adjusted" and doc["month"] == "2020-01"
    assert len(doc["bars"]) == 6
    assert doc["bars"][0] == {
        "code": "ZZA",
        "d": "2020-01-06",
        "o": 10.0,
        "h": 11.0,
        "l": 9.0,
        "c": 10.0,
        "volume": 1000,
    }
    assert [s["exDate"] for s in doc["splits"]] == ["2020-01-07", "2020-01-07"]
    assert doc["splits"][0]["ratio"] == 2.0


def test_auto_adjust_false_and_actions_and_exclusive_end():
    seen = []

    def dl(**kw):
        seen.append(kw)
        return frame(["ZZA", "ZZB"])

    fp.fetch_month(PLAN, 100, 1, dl, sleep=lambda s: None)
    assert seen[0]["auto_adjust"] is False and seen[0]["actions"] is True
    assert seen[0]["end"] == "2020-02-01" and seen[0]["tickers"] == ["ZZA.AX", "ZZB.AX"]


def test_chunking_waits_between_requests():
    sleeps, ticks = [], iter(range(0, 1000))
    fp.fetch_month(
        PLAN,
        1,
        5,
        lambda **kw: frame(["ZZA", "ZZB"]),
        sleep=sleeps.append,
        clock=lambda: float(next(ticks)),
    )
    assert len(sleeps) == 1 and sleeps[0] > 0


def test_rate_limit_stops_after_retries():
    def dl(**kw):
        raise Exception("429 Too Many Requests")

    with pytest.raises(yf_fetch.RateLimited):
        fp.fetch_month(PLAN, 100, 1, dl, sleep=lambda s: None)


@pytest.mark.parametrize(
    "bad", [{"codes": []}, {"codes": ["abc"]}, {"start": "2020-02-01"}, {"month": "2020-03"}]
)
def test_bad_plan(bad):
    with pytest.raises(yf_fetch.InputError):
        fp.fetch_month({**PLAN, **bad}, 100, 1, lambda **kw: frame(["ZZA"]))


def test_main_writes_file_and_prints_counts_only(tmp_path, monkeypatch, capsys):
    plan, out = tmp_path / "plan.json", tmp_path / "prices.json"
    plan.write_text(json.dumps(PLAN))
    mod = types.ModuleType("yfinance")
    mod.download = lambda **kw: frame(["ZZA", "ZZB"])
    monkeypatch.setitem(sys.modules, "yfinance", mod)
    monkeypatch.setattr(fp.time, "sleep", lambda s: None)
    assert fp.main(["--plan", str(plan), "--output", str(out)]) == 0
    assert json.loads(out.read_text())["bars"]
    assert "ZZA" not in capsys.readouterr().out

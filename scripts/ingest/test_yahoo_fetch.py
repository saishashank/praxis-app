"""pytest for yahoo_fetch.py. yfinance is never imported or called: `download` is injected.

Runs only in CI (job `python`); there is no Python on the Windows build machine. All data here is
invented (codes ZZ*, prices by formula).
"""

import json

import pandas as pd
import pytest

import yahoo_fetch as yf_fetch

FETCHED = "2026-01-01T07:30:00.000Z"


def frame(codes, days=3, nan_day=None):
    """A multi-ticker frame shaped like yfinance's group_by='ticker' output."""
    idx = pd.date_range("2020-01-06", periods=days, freq="B")
    cols = pd.MultiIndex.from_product(
        [[f"{c}.AX" for c in codes], ["Open", "High", "Low", "Close", "Adj Close", "Volume"]]
    )
    data = {}
    for ci, c in enumerate(codes):
        for i in range(days):
            base = 10 + ci + i * 0.5
            for k, v in (
                ("Open", base),
                ("High", base + 1),
                ("Low", base - 1),
                ("Close", base + 0.25),
                ("Adj Close", base + 0.2),
                ("Volume", 1000 + i),
            ):
                data.setdefault((f"{c}.AX", k), []).append(v)
    df = pd.DataFrame(data, index=idx, columns=cols)
    if nan_day is not None:
        df.iloc[nan_day] = float("nan")
    return df


class Recorder:
    """A fake yf.download that records calls and serves frames or raises."""

    def __init__(self, behaviour=None):
        self.calls = []
        self.behaviour = behaviour

    def __call__(self, **kw):
        self.calls.append(kw)
        if self.behaviour:
            return self.behaviour(len(self.calls), kw)
        codes = [t[:-3] for t in kw["tickers"]]
        return frame(codes)


class FakeRateLimit(Exception):
    pass


def make_clock():
    state = {"t": 0.0, "sleeps": []}

    def clock():
        return state["t"]

    def sleep(s):
        state["sleeps"].append(s)
        state["t"] += s

    return clock, sleep, state


# --- configuration ---------------------------------------------------------------------------


def test_throttle_defaults():
    assert yf_fetch.load_throttle({}) == (100, 5)


def test_throttle_from_env():
    assert yf_fetch.load_throttle({"YAHOO_CHUNK_SIZE": "250", "YAHOO_MIN_GAP_S": "10"}) == (250, 10)


@pytest.mark.parametrize(
    "env",
    [
        {"YAHOO_CHUNK_SIZE": "9"},
        {"YAHOO_CHUNK_SIZE": "501"},
        {"YAHOO_CHUNK_SIZE": "abc"},
        {"YAHOO_MIN_GAP_S": "0"},
        {"YAHOO_MIN_GAP_S": "61"},
        {"YAHOO_MIN_GAP_S": "1.5"},
    ],
)
def test_throttle_rejects_out_of_bounds(env):
    with pytest.raises(yf_fetch.InputError):
        yf_fetch.load_throttle(env)


def test_throttle_blank_uses_default():
    assert yf_fetch.load_throttle({"YAHOO_CHUNK_SIZE": " "}) == (100, 5)


# --- request parsing -------------------------------------------------------------------------


def test_parse_request_ok_and_dedupes():
    codes, start, end = yf_fetch.parse_request(
        {"codes": ["ZZZ", "ZZY", "ZZZ"], "start": "2020-01-06", "end": "2020-01-10"}
    )
    assert codes == ["ZZZ", "ZZY"]
    assert (start, end) == ("2020-01-06", "2020-01-10")


@pytest.mark.parametrize(
    "raw",
    [
        [],
        {"codes": [], "start": "2020-01-06", "end": "2020-01-10"},
        {"codes": "ZZZ", "start": "2020-01-06", "end": "2020-01-10"},
        {"codes": ["zzz"], "start": "2020-01-06", "end": "2020-01-10"},
        {"codes": [5], "start": "2020-01-06", "end": "2020-01-10"},
        {"codes": ["ZZZ"], "start": "2020-1-6", "end": "2020-01-10"},
        {"codes": ["ZZZ"], "start": "2020-02-30", "end": "2020-03-10"},
        {"codes": ["ZZZ"], "start": "2020-01-10", "end": "2020-01-06"},
        {"codes": ["ZZZ"], "start": "2020-01-06"},
    ],
)
def test_parse_request_rejects(raw):
    with pytest.raises(yf_fetch.InputError):
        yf_fetch.parse_request(raw)


# --- frame conversion ------------------------------------------------------------------------


def test_rows_from_frame_shape():
    rows = yf_fetch.rows_from_frame(frame(["ZZZ"], days=2), ["ZZZ"], FETCHED)
    assert rows[0] == {
        "code": "ZZZ",
        "date": "2020-01-06",
        "open": 10.0,
        "high": 11.0,
        "low": 9.0,
        "close": 10.25,
        "volume": 1000,
        "adj_close": 10.2,
        "source": "yahoo",
        "published_at": None,
        "fetched_at": FETCHED,
    }
    assert [r["date"] for r in rows] == ["2020-01-06", "2020-01-07"]


def test_all_nan_day_is_skipped_but_partial_nan_becomes_null():
    df = frame(["ZZZ"], days=3, nan_day=1)
    df.iloc[2, df.columns.get_loc(("ZZZ.AX", "Close"))] = float("nan")
    rows = yf_fetch.rows_from_frame(df, ["ZZZ"], FETCHED)
    assert [r["date"] for r in rows] == ["2020-01-06", "2020-01-08"]
    assert rows[1]["close"] is None  # never filled


def test_fractional_and_missing_volume_is_null():
    df = frame(["ZZZ"], days=2)
    # yfinance can return float volume columns; make the fixture column float so pandas accepts 10.5.
    df[("ZZZ.AX", "Volume")] = df[("ZZZ.AX", "Volume")].astype("float64")
    df.iloc[0, df.columns.get_loc(("ZZZ.AX", "Volume"))] = 10.5
    df.iloc[1, df.columns.get_loc(("ZZZ.AX", "Volume"))] = float("nan")
    rows = yf_fetch.rows_from_frame(df, ["ZZZ"], FETCHED)
    assert [r["volume"] for r in rows] == [None, None]


def test_empty_or_none_frame_gives_no_rows():
    assert yf_fetch.rows_from_frame(None, ["ZZZ"], FETCHED) == []
    assert yf_fetch.rows_from_frame(pd.DataFrame(), ["ZZZ"], FETCHED) == []


def test_code_missing_from_frame_is_skipped():
    rows = yf_fetch.rows_from_frame(frame(["ZZZ"]), ["ZZZ", "ZZY"], FETCHED)
    assert {r["code"] for r in rows} == {"ZZZ"}


def test_flat_single_ticker_frame():
    flat = frame(["ZZZ"], days=2)["ZZZ.AX"]
    rows = yf_fetch.rows_from_frame(flat, ["ZZZ"], FETCHED)
    assert len(rows) == 2 and rows[0]["code"] == "ZZZ"


# --- chunking and throttle -------------------------------------------------------------------


def test_chunks_split_and_use_ax_suffix_and_inclusive_end():
    dl = Recorder()
    clock, sleep, state = make_clock()
    codes = [f"ZZ{i}" for i in range(5)]
    rows, report = yf_fetch.fetch_all(
        codes, "2020-01-06", "2020-01-31", 2, 5, dl, sleep=sleep, clock=clock
    )
    assert [c["tickers"] for c in dl.calls] == [
        ["ZZ0.AX", "ZZ1.AX"],
        ["ZZ2.AX", "ZZ3.AX"],
        ["ZZ4.AX"],
    ]
    assert all(c["end"] == "2020-02-01" and c["start"] == "2020-01-06" for c in dl.calls)
    assert all(c["auto_adjust"] is False and c["threads"] is False for c in dl.calls)
    assert report["requests"] == 3 and report["rows"] == len(rows) == 15
    assert report["missing"] == []


def test_minimum_gap_between_requests():
    dl = Recorder()
    clock, sleep, state = make_clock()
    yf_fetch.fetch_all(["ZZ0", "ZZ1", "ZZ2"], "2020-01-06", "2020-01-10", 1, 7, dl, sleep, clock)
    assert state["sleeps"] == [7, 7]  # none before the first request


def test_no_sleep_when_the_gap_has_already_passed():
    clock, sleep, state = make_clock()

    def slow(n, kw):
        state["t"] += 30
        return frame([t[:-3] for t in kw["tickers"]])

    yf_fetch.fetch_all(["ZZ0", "ZZ1"], "2020-01-06", "2020-01-10", 1, 5, Recorder(slow), sleep, clock)
    assert state["sleeps"] == []


def test_missing_codes_are_reported():
    def only_first(n, kw):
        return frame(["ZZ0"])

    clock, sleep, _ = make_clock()
    _, report = yf_fetch.fetch_all(
        ["ZZ0", "ZZ1"], "2020-01-06", "2020-01-10", 10, 5, Recorder(only_first), sleep, clock
    )
    assert report["missing"] == ["ZZ1"]


# --- rate limits and errors ------------------------------------------------------------------


def test_backs_off_on_rate_limit_then_succeeds():
    def flaky(n, kw):
        if n < 3:
            raise FakeRateLimit("429 Too Many Requests")
        return frame(["ZZ0"])

    clock, sleep, state = make_clock()
    rows, report = yf_fetch.fetch_all(
        ["ZZ0"], "2020-01-06", "2020-01-10", 10, 5, Recorder(flaky), sleep, clock
    )
    assert rows and report["rate_limit_retries"] == 2 and report["requests"] == 3
    assert state["sleeps"] == [20, 80]  # min_gap * 4 ** attempt


def test_rate_limit_exhausted_fails_visibly():
    def always(n, kw):
        raise FakeRateLimit("Too Many Requests")

    clock, sleep, _ = make_clock()
    with pytest.raises(yf_fetch.RateLimited):
        yf_fetch.fetch_all(["ZZ0"], "2020-01-06", "2020-01-10", 10, 5, Recorder(always), sleep, clock)


def test_rate_limit_class_name_is_recognised():
    class YFRateLimitError(Exception):
        pass

    assert yf_fetch._is_rate_limit(YFRateLimitError("x"))
    assert not yf_fetch._is_rate_limit(ValueError("boom"))


def test_other_errors_fail_without_leaking_the_message():
    def boom(n, kw):
        raise ValueError("secret detail")

    clock, sleep, _ = make_clock()
    with pytest.raises(yf_fetch.FetchError) as ei:
        yf_fetch.fetch_all(["ZZ0"], "2020-01-06", "2020-01-10", 10, 5, Recorder(boom), sleep, clock)
    assert "secret detail" not in str(ei.value)


# --- run() and main() ------------------------------------------------------------------------


def write_request(tmp_path, **over):
    req = {"codes": ["ZZZ", "ZZY"], "start": "2020-01-06", "end": "2020-01-08", **over}
    p = tmp_path / "request.json"
    p.write_text(json.dumps(req))
    return str(p)


def test_run_writes_bars_json_with_the_agreed_fields(tmp_path):
    out = tmp_path / "bars.json"
    report = yf_fetch.run(write_request(tmp_path), str(out), env={}, download=Recorder(), sleep=lambda s: None)
    rows = json.loads(out.read_text())
    assert report["rows"] == len(rows) == 6
    assert set(rows[0]) == {
        "code", "date", "open", "high", "low", "close", "volume",
        "adj_close", "source", "published_at", "fetched_at",
    }
    assert all(r["source"] == "yahoo" and r["published_at"] is None for r in rows)
    assert not (tmp_path / "bars.json.tmp").exists()


def test_run_respects_chunk_size_from_env(tmp_path):
    dl = Recorder()
    yf_fetch.run(
        write_request(tmp_path),
        str(tmp_path / "bars.json"),
        env={"YAHOO_CHUNK_SIZE": "10"},
        download=dl,
        sleep=lambda s: None,
    )
    assert len(dl.calls) == 1


def test_run_rejects_invalid_json_request(tmp_path):
    p = tmp_path / "request.json"
    p.write_text("{nope")
    with pytest.raises(yf_fetch.InputError):
        yf_fetch.run(str(p), str(tmp_path / "o.json"), env={}, download=Recorder())


def test_nan_never_reaches_the_file(tmp_path):
    def with_nan(n, kw):
        df = frame(["ZZZ"], days=2)
        df.iloc[0, df.columns.get_loc(("ZZZ.AX", "Open"))] = float("nan")
        return df

    out = tmp_path / "bars.json"
    yf_fetch.run(
        write_request(tmp_path, codes=["ZZZ"]), str(out), env={}, download=Recorder(with_nan),
        sleep=lambda s: None,
    )
    text = out.read_text()
    assert "NaN" not in text
    assert json.loads(text)[0]["open"] is None


def test_main_exit_codes(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(yf_fetch, "run", lambda *a, **k: {"rows": 3, "missing": ["ZZY"], "requests": 1})
    assert yf_fetch.main(["--request", "r", "--output", str(tmp_path / "o.json")]) == 0
    printed = capsys.readouterr().out
    assert "missing_count" in printed and "ZZY" not in printed  # counts only

    report_path = tmp_path / "report.json"
    yf_fetch.main(["--request", "r", "--output", "o", "--report", str(report_path)])
    assert json.loads(report_path.read_text())["missing"] == ["ZZY"]

    def raiser(exc):
        def f(*a, **k):
            raise exc
        return f

    monkeypatch.setattr(yf_fetch, "run", raiser(yf_fetch.InputError("bad")))
    assert yf_fetch.main(["--request", "r", "--output", "o"]) == 2
    monkeypatch.setattr(yf_fetch, "run", raiser(yf_fetch.RateLimited("slow down")))
    assert yf_fetch.main(["--request", "r", "--output", "o"]) == 3
    monkeypatch.setattr(yf_fetch, "run", raiser(yf_fetch.FetchError("failed")))
    assert yf_fetch.main(["--request", "r", "--output", "o"]) == 2

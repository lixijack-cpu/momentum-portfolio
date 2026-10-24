#!/usr/bin/env python3
"""Tests for the monthly_returns half of the snapshot gate.

Run with plain ``python test_snapshot_gate.py``.  This repo has no pytest and no
requirements.txt -- it installs pandas and yfinance in the workflow and nothing else --
so the harness here is a handful of asserts rather than a framework.

``monthly_returns`` is the one certified section the refresher is allowed to touch, and
it may only touch the months since the account was funded.  Everything below exists to
keep that boundary honest: the five-day silent outage this dashboard already survived
came from a gate that was pinned too tightly, and the two-month stale heatmap came from
one that was not checked at all.
"""
from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import build_snapshot_cloud as b

SNAPSHOT = Path(__file__).with_name("portfolio_snapshot.json")

FAILURES: list[str] = []


def check(name: str, fn) -> None:
    try:
        fn()
    except AssertionError as exc:
        FAILURES.append(f"{name}: {exc}")
        print(f"FAIL  {name}\n        {exc}")
    except Exception as exc:  # noqa: BLE001 - a crash is a failure like any other
        FAILURES.append(f"{name}: {type(exc).__name__}: {exc}")
        print(f"ERROR {name}\n        {type(exc).__name__}: {exc}")
    else:
        print(f"ok    {name}")


def rejects(base: dict, updated: dict, fragment: str) -> None:
    try:
        b._validate_monthly_returns(base, updated)
    except b.SnapshotUpdateError as exc:
        assert fragment in str(exc), f"expected {fragment!r} in {str(exc)!r}"
        return
    raise AssertionError(f"expected rejection mentioning {fragment!r}, got none")


def fixture() -> dict:
    """A minimal snapshot shaped like the real one, funded 2026-07-26."""

    return {
        "as_of": "2026-08-21",
        "live": {"inception_date": "2026-07-26"},
        "monthly_returns": [
            {"month": "2026-05", "strategy": 0.021569, "spy": 0.052626},
            {"month": "2026-06", "strategy": 0.068685, "spy": -0.010293},
        ],
    }


def tail(month: str, strategy: float = 0.02, spy: float = 0.01) -> dict:
    return {"month": month, "strategy": strategy, "spy": spy, "partial": True}


# --------------------------------------------------------------------------
# The boundary
# --------------------------------------------------------------------------


def test_tail_append_is_allowed() -> None:
    base = fixture()
    updated = copy.deepcopy(base)
    updated["monthly_returns"] += [tail("2026-07"), tail("2026-08")]
    b._validate_monthly_returns(base, updated)


def test_tail_update_is_allowed() -> None:
    """The running month moves every session; that is the whole point of the exemption."""

    base = fixture()
    base["monthly_returns"].append(tail("2026-08", strategy=0.01))
    updated = copy.deepcopy(base)
    updated["monthly_returns"][-1] = tail("2026-08", strategy=0.022011)
    b._validate_monthly_returns(base, updated)


def test_certified_month_edit_is_rejected() -> None:
    base = fixture()
    updated = copy.deepcopy(base)
    updated["monthly_returns"][0]["strategy"] = 0.9
    rejects(base, updated, "Certified months before 2026-07 were modified")


def test_dropping_a_certified_month_is_rejected() -> None:
    base = fixture()
    updated = copy.deepcopy(base)
    del updated["monthly_returns"][0]
    rejects(base, updated, "Certified months before 2026-07 were modified")


def test_backdating_inception_cannot_unfreeze_history() -> None:
    """Moving the floor under a certified month does not make rewriting it legal.

    The floor comes from ``base``, so a backdated ``inception_date`` in the payload under
    inspection buys nothing.  ``validate`` also holds that field immutable, but it checks
    later in the pass -- this gate does not lean on that ordering.
    """

    base = fixture()
    updated = copy.deepcopy(base)
    updated["live"]["inception_date"] = "2026-05-01"
    updated["monthly_returns"][0]["strategy"] = 0.031415
    rejects(base, updated, "Certified months before 2026-07 were modified")


# --------------------------------------------------------------------------
# Shape of the tail itself
# --------------------------------------------------------------------------


def test_out_of_order_month_is_rejected() -> None:
    base = fixture()
    updated = copy.deepcopy(base)
    updated["monthly_returns"] += [tail("2026-08"), tail("2026-07")]
    rejects(base, updated, "not sorted")


def test_duplicate_month_is_rejected() -> None:
    base = fixture()
    updated = copy.deepcopy(base)
    updated["monthly_returns"] += [tail("2026-07"), tail("2026-07")]
    rejects(base, updated, "duplicate")


def test_month_ahead_of_as_of_is_rejected() -> None:
    base = fixture()
    updated = copy.deepcopy(base)
    updated["monthly_returns"] += [tail("2026-07"), tail("2026-08"), tail("2026-09")]
    rejects(base, updated, "past as_of")


def test_malformed_month_is_rejected() -> None:
    base = fixture()
    updated = copy.deepcopy(base)
    updated["monthly_returns"].append(tail("2026-7"))
    rejects(base, updated, "malformed month")


def test_out_of_range_return_is_rejected() -> None:
    base = fixture()
    updated = copy.deepcopy(base)
    updated["monthly_returns"].append(tail("2026-07", strategy=1.5))
    rejects(base, updated, "out of range")


def test_percent_scale_is_rejected() -> None:
    """A sibling writer publishes percents under different key names; catch the mix-up."""

    base = fixture()
    updated = copy.deepcopy(base)
    updated["monthly_returns"].append(tail("2026-07", strategy=1.7026, spy=1.0743))
    rejects(base, updated, "out of range")


def test_non_numeric_return_is_rejected() -> None:
    base = fixture()
    updated = copy.deepcopy(base)
    updated["monthly_returns"].append({"month": "2026-07", "strategy": None, "spy": 0.01})
    rejects(base, updated, "not a number")


def test_empty_monthly_returns_is_rejected() -> None:
    base = fixture()
    updated = copy.deepcopy(base)
    updated["monthly_returns"] = []
    rejects(base, updated, "missing or empty")


# --------------------------------------------------------------------------
# The live-month arithmetic
# --------------------------------------------------------------------------


def test_live_months_anchor_on_the_deposit() -> None:
    """First live month runs from $10,000, not from the first mark.

    Anchoring on the opening mark erases the funding-day cost and publishes +4.21%
    against a true +3.94%.
    """

    import pandas as pd

    rebase = 2.0
    curve = [
        {"d": "2026-07-26", "v": 9974.0 * rebase},
        {"d": "2026-07-31", "v": 10170.2610944072 * rebase},
        {"d": "2026-08-21", "v": 10394.1150326052 * rebase},
    ]
    series = pd.Series(
        [739.090027, 747.030029, 765.719971],
        index=pd.to_datetime(["2026-07-27", "2026-07-31", "2026-08-21"]),
    )
    rows = b._live_monthly_returns(curve, 10_000.0, rebase, series)

    assert [r["month"] for r in rows] == ["2026-07", "2026-08"], rows
    assert rows[0]["strategy"] == 0.017026, rows[0]
    assert rows[1]["strategy"] == 0.022011, rows[1]
    assert rows[0]["spy"] == 0.010743, rows[0]
    assert rows[1]["spy"] == 0.025019, rows[1]
    assert all(r["partial"] is True for r in rows), rows

    compounded = (1 + rows[0]["strategy"]) * (1 + rows[1]["strategy"]) - 1
    assert abs(compounded - 0.039412) < 5e-7, compounded
    benchmark = (1 + rows[0]["spy"]) * (1 + rows[1]["spy"]) - 1
    assert abs(benchmark - 0.036031) < 5e-7, benchmark


def test_rebase_factor_cancels() -> None:
    """The curve stores NAV x rebase_factor; every published figure is a ratio."""

    import pandas as pd

    series = pd.Series(
        [739.090027, 747.030029],
        index=pd.to_datetime(["2026-07-27", "2026-07-31"]),
    )
    out = []
    for rebase in (1.0, 14.856097, 500.0):
        curve = [{"d": "2026-07-31", "v": 10170.2610944072 * rebase}]
        out.append(b._live_monthly_returns(curve, 10_000.0, rebase, series))
    assert out[0] == out[1] == out[2], out


def test_missing_benchmark_month_publishes_nothing() -> None:
    """A strategy cell beside an invented SPY cell is worse than a blank row."""

    import pandas as pd

    curve = [{"d": "2026-07-31", "v": 1.0}, {"d": "2026-08-21", "v": 1.1}]
    series = pd.Series([739.090027], index=pd.to_datetime(["2026-07-27"]))
    assert b._live_monthly_returns(curve, 10_000.0, 1.0, series) == []
    assert b._live_monthly_returns(curve, 10_000.0, 1.0, None) == []
    assert b._live_monthly_returns([], 10_000.0, 1.0, series) == []


def test_merge_replaces_only_the_tail() -> None:
    snapshot = {
        "monthly_returns": [
            {"month": "2026-06", "strategy": 0.068685, "spy": -0.010293},
            {"month": "2026-07", "strategy": 0.0, "spy": 0.0},
        ]
    }
    b._merge_monthly_returns(snapshot, [tail("2026-07"), tail("2026-08")])
    assert [r["month"] for r in snapshot["monthly_returns"]] == [
        "2026-06",
        "2026-07",
        "2026-08",
    ]
    assert snapshot["monthly_returns"][0]["strategy"] == 0.068685
    assert snapshot["monthly_returns"][1]["strategy"] == 0.02


def test_merge_with_no_rows_is_a_noop() -> None:
    before = [{"month": "2026-06", "strategy": 0.068685, "spy": -0.010293}]
    snapshot = {"monthly_returns": copy.deepcopy(before)}
    b._merge_monthly_returns(snapshot, [])
    assert snapshot["monthly_returns"] == before


# --------------------------------------------------------------------------
# Against the real published payload
# --------------------------------------------------------------------------


def test_published_snapshot_passes_the_full_gate() -> None:
    if not SNAPSHOT.is_file():
        print("      (skipped: no portfolio_snapshot.json on disk)")
        return
    base = json.loads(SNAPSHOT.read_text())
    updated = copy.deepcopy(base)
    floor = str(base["live"]["inception_date"])[:7]
    if (
        str(base["monthly_returns"][-1]["month"]) < floor
        and str(base["as_of"]) <= "2026-08-21"
    ):
        updated["monthly_returns"] = base["monthly_returns"] + [
            tail("2026-07", 0.017026, 0.010743),
            tail("2026-08", 0.022011, 0.025019),
        ]
        updated["as_of"] = "2026-08-21"
    b.validate(base, updated)

    tampered = copy.deepcopy(updated)
    tampered["monthly_returns"][100] = dict(
        tampered["monthly_returns"][100], strategy=0.123456
    )
    rejects(base, tampered, "Certified months")


def test_holdings_ui_contract() -> None:
    """Exercise the browser renderer against holdings and conviction decoys."""

    test_file = Path(__file__).with_name("test_holdings_ui.js")
    completed = subprocess.run(
        ["node", str(test_file)],
        cwd=test_file.parent,
        capture_output=True,
        text=True,
        check=False,
    )
    output = "\n".join(part.strip() for part in (completed.stdout, completed.stderr) if part.strip())
    assert completed.returncode == 0, output


def test_sector_conviction_contract_is_score_free() -> None:
    clean = {
        "sector_conviction": {
            "Technology": [
                {"ticker": "AAA", "name": "Alpha Systems Inc"},
                {"ticker": "BBB", "name": "Beta Systems Inc"},
            ]
        }
    }
    b._validate_sector_conviction(clean)

    leaked = copy.deepcopy(clean)
    leaked["sector_conviction"]["Technology"][0]["FinalScore"] = 0.99
    try:
        b._validate_sector_conviction(leaked)
    except b.SnapshotUpdateError as exc:
        assert "other than ticker/name" in str(exc), str(exc)
        return
    raise AssertionError("expected a raw-score field to be rejected")


def test_sector_conviction_is_frozen_by_full_gate() -> None:
    if not SNAPSHOT.is_file():
        print("      (skipped: no portfolio_snapshot.json on disk)")
        return
    legacy = json.loads(SNAPSHOT.read_text())
    if "sector_conviction" in legacy:
        base = copy.deepcopy(legacy)
    else:
        base = {}
        for key, value in legacy.items():
            base[key] = value
            if key == "sector_history":
                base["sector_conviction"] = {
                    "Technology": [{"ticker": "AAA", "name": "Alpha Systems Inc"}]
                }
    updated = copy.deepcopy(base)
    b.validate(base, updated)

    sector = next(iter(updated["sector_conviction"]))
    updated["sector_conviction"][sector][0]["name"] = "Altered Name"
    try:
        b.validate(base, updated)
    except b.SnapshotUpdateError as exc:
        assert "sector_conviction" in str(exc), str(exc)
        return
    raise AssertionError("expected sector_conviction mutation to be rejected")


def funded_fixture() -> dict:
    """Small offline book with the incident's exact NAV and cash."""
    result = json.loads(SNAPSHOT.read_text())
    result["as_of"] = "2026-10-23"
    result["live"].update(nav=10711.61, cash=595.29, last_updated="2026-10-23",
                          days_live=2, rebase_factor=2, inception_nav=10000,
                          inception_date="2026-10-22", since_inception_return=.071161,
                          benchmark_return=None, excess_return=None,
                          benchmark_return_iwm=None, excess_return_iwm=None)
    result["equity_curve"]["live"] = [dict(d="2026-10-22", v=21252.8), dict(d="2026-10-23", v=21423.22)]
    result["holdings"].update(as_of="2026-10-23", price_as_of="2026-10-23", positions=[
        dict(ticker="AAA", name="Alpha", sector="Tech", shares=100, price=101.1632,
             value=10116.32, weight=10116.32 / 10711.61, rationale="Fixture")])
    result["monthly_returns"] = [r for r in result["monthly_returns"] if r["month"] < "2026-10"]
    return result


def refresh_offline(base, *, future=False):
    import pandas as pd
    dates = ["2026-10-22", "2026-10-23"] + (["2026-10-26"] if future else [])
    prices = [100.3111, 101.1632] + ([102.0] if future else [])
    closes = pd.DataFrame({"AAA": prices}, index=pd.to_datetime(dates))
    series = pd.Series([100., 101.], index=pd.to_datetime(["2026-10-22", dates[-1]]))
    with patch.object(b, "_download_closes", return_value=closes), \
         patch.object(b, "_benchmark_series", return_value=series), \
         patch.object(b, "_benchmark_series_for", return_value=series):
        return b.update_snapshot(base)[0]


def test_consistent_input_passes_same_day_and_next_session_refresh():
    for future in (False, True):
        base = funded_fixture()
        updated = refresh_offline(base, future=future)
        b.validate(base, updated)
        assert updated["live"]["cash"] == 595.29
        assert updated["live"]["nav"] == (10795.29 if future else 10711.61)
        assert base["live"]["nav"] == 10711.61, "refresh mutated its input"


def test_stale_positions_correct_nav_fails_before_download():
    base = funded_fixture()
    base["holdings"]["positions"][0].update(price=98.6917, value=9869.17)
    with patch.object(b, "_download_closes", side_effect=AssertionError("must reject before fetching")):
        try:
            b.update_snapshot(base)
        except b.SnapshotUpdateError as exc:
            assert "Input positions + cash" in str(exc), str(exc)
        else:
            raise AssertionError("incident input was accepted")


def test_legacy_stale_positions_are_rejected_by_observed_closes():
    base = funded_fixture()
    del base["live"]["cash"]
    base["holdings"]["positions"][0].update(price=98.6917, value=9869.17)
    try:
        refresh_offline(base)
    except b.SnapshotUpdateError as exc:
        assert "observed base closes" in str(exc), str(exc)
        return
    raise AssertionError("legacy incident input was accepted")


def test_already_corrupted_legacy_cash_is_rejected():
    base = funded_fixture()
    del base["live"]["cash"]
    base["live"]["nav"] = 10958.76
    base["equity_curve"]["live"][-1]["v"] = 10958.76 * 2
    try:
        refresh_offline(base)
    except b.SnapshotUpdateError as exc:
        assert "cash discontinuity" in str(exc), str(exc)
        return
    raise AssertionError("phantom cash passed legacy continuity")


def test_legacy_consistent_input_gets_explicit_cash():
    base = funded_fixture()
    del base["live"]["cash"]
    updated = refresh_offline(base)
    b.validate(base, updated)
    assert updated["live"]["cash"] == 595.29


def test_cash_discontinuity_rejected_even_when_output_reconciles():
    base = funded_fixture()
    updated = refresh_offline(base)
    updated["live"]["cash"] += 1
    updated["live"]["nav"] += 1
    updated["equity_curve"]["live"][-1]["v"] += 2
    try:
        b.validate(base, updated)
    except b.SnapshotUpdateError as exc:
        assert "changed cash" in str(exc), str(exc)
        return
    raise AssertionError("cash discontinuity passed")


def test_invalid_cash_and_legacy_cash_bounds_rejected():
    for cash in (-1, float("nan"), float("inf"), None):
        base = funded_fixture()
        base["live"]["cash"] = cash
        try:
            b.validate_input(base)
        except b.SnapshotUpdateError:
            continue
        raise AssertionError(f"accepted invalid cash {cash}")
    base = funded_fixture()
    del base["live"]["cash"]
    base["holdings"]["positions"][0].update(value=8000, price=80)
    try:
        b.validate_input(base)
    except b.SnapshotUpdateError as exc:
        assert "15%" in str(exc), str(exc)
        return
    raise AssertionError("accepted excessive legacy cash")


def test_correct_cash_cannot_hide_stale_prices_and_nav():
    base = funded_fixture()
    base["holdings"]["positions"][0].update(value=9869.17, price=98.6917)
    base["live"]["nav"] = 10464.46
    base["equity_curve"]["live"][-1]["v"] = 10464.46 * 2
    try:
        refresh_offline(base)
    except b.SnapshotUpdateError as exc:
        assert "holdings-implied" in str(exc), str(exc)
        return
    raise AssertionError("stale mark with a fresh date was accepted")


def test_failed_refresh_preserves_output_file():
    base = funded_fixture()
    base["holdings"]["positions"][0].update(value=9869.17, price=98.6917)
    with tempfile.TemporaryDirectory() as directory:
        source, destination = Path(directory) / "bad.json", Path(directory) / "published.json"
        source.write_text(json.dumps(base))
        destination.write_text("previous published bytes\n")
        with patch.object(sys, "argv", ["builder", "--input", str(source), "--output", str(destination), "--require-update"]), \
             patch.object(b, "_download_closes", side_effect=AssertionError("network forbidden")):
            assert b.main() == 1
        assert destination.read_text() == "previous published bytes\n"


def main() -> int:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            check(name, fn)
    print()
    if FAILURES:
        print(f"{len(FAILURES)} failure(s)")
        return 1
    print("all snapshot gate tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

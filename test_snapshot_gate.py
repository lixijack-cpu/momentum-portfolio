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
import sys
from pathlib import Path

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
    if str(base["monthly_returns"][-1]["month"]) < floor:
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

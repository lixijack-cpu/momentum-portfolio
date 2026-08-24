#!/usr/bin/env python3
"""Refresh the public dashboard's live prices without rebuilding the book.

``portfolio_snapshot.json`` is produced by the research pipeline and is the only
source of truth for the dashboard.  Between rebalances the book is buy-and-hold,
so the share counts are fixed and the only things that legitimately move day to
day are the prices.  This script therefore *updates* the published snapshot in
place; it never rebuilds it and never reads a holdings file.

An earlier version rebuilt holdings from ``portfolio_allocation.csv`` (the full
104-name production book) and re-derived the live NAV from the 85-name shadow
track.  Both are the wrong book: the dashboard publishes a 10-name small
account.  That is the regression the validation gate below exists to prevent.

Every certified section -- headline, the backtest/simulation/SPY curves, crash
table, sector history, notes -- is carried through untouched.  ``monthly_returns``
is frozen for every month the backtest covers; only the months the funded account
has actually been running are rebuilt here, because those move every session and
are the account's own marks rather than research output.
The gate runs against the finished payload *before* anything is written, and any
failure leaves the file on disk exactly as it was.

Depends only on pandas, yfinance, and the standard library.
"""
from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf


# The exact top-level shape index.html reads.  No more, no less.
EXPECTED_TOP_LEVEL = (
    "schema_version",
    "generated_at",
    "as_of",
    "headline",
    "equity_curve",
    "live",
    "crash_table",
    "sector_history",
    "monthly_returns",
    "holdings",
    "notes",
)

# Certified research output.  Nothing here may modify these.
FROZEN_TOP_LEVEL = (
    "schema_version",
    "headline",
    "crash_table",
    "sector_history",
    "notes",
)
FROZEN_CURVES = ("backtest", "simulation", "spy")

# ``monthly_returns`` is deliberately absent from FROZEN_TOP_LEVEL.  It is not
# wholly frozen and not wholly writable: every month the backtest covers is
# certified research output, while the months since the account was funded are
# its own marks and move daily.  ``_validate_monthly_returns`` enforces that
# split, and the boundary is read off ``live.inception_date`` rather than
# hard-coded to a month that would silently rot.
_MONTH_LABEL = re.compile(r"[0-9]{4}-[0-9]{2}")

# Fields every position must carry.  The research pipeline also ships display
# fields alongside them -- ``rationale`` today, something else tomorrow -- so the
# gate checks that these are PRESENT rather than that they are all there is.
# Pinning the exact tuple is what silently stopped this script for five days:
# ``rationale`` was added on 2026-08-14 and every run after it skipped with
# "Position RELY fields changed" while still reporting success.
REQUIRED_POSITION_FIELDS = ("ticker", "name", "sector", "weight", "value", "shares", "price")

# The only position fields a price refresh is allowed to move.  Everything else
# a position carries is frozen, whether or not this script knows what it means.
PRICED_POSITION_FIELDS = ("weight", "value", "price")

# A single session cannot plausibly move a diversified 10-name book this far.
# Anything larger is a bad Yahoo print, not a real return.  Checked step by step
# across a backfill: over several sessions the end-to-end move is a compounded
# return, not a bad print.
MAX_NAV_MOVE = 0.25

# Tolerate the odd halted or delisted name, but refuse to mark the whole book
# to market off a handful of quotes.
MIN_PRICE_COVERAGE = 0.8

# Ceiling on sessions written in one run.  The price panel is a month long, so
# this never binds in normal operation -- it exists so a corrupt or empty base
# curve cannot balloon the published history in a single pass.
MAX_BACKFILL_SESSIONS = 25

# The live-window benchmark.  This is the ONLY place it can be computed: the
# research repo's SPY parquet ends 2026-07-13 and ``equity_curve.spy`` stops at
# the last marked month, both of which predate the live inception -- so the
# published snapshot carries no SPY observation inside the live window at all.
BENCHMARK_TICKER = "SPY"


class SnapshotUpdateError(RuntimeError):
    """Raised when the snapshot cannot be refreshed safely."""


# ---------------------------------------------------------------------------
# Price retrieval
# ---------------------------------------------------------------------------


def _extract_close(download: pd.DataFrame, symbols: list[str]) -> pd.DataFrame:
    """Normalise yfinance's several response shapes into a Close-price frame."""

    if download.empty:
        raise SnapshotUpdateError("Yahoo Finance returned no price observations")

    if isinstance(download.columns, pd.MultiIndex):
        close = None
        for level in range(download.columns.nlevels):
            if "Close" in download.columns.get_level_values(level):
                close = download.xs("Close", axis=1, level=level, drop_level=True)
                break
        if close is None:
            raise SnapshotUpdateError("Yahoo Finance response has no Close field")
    else:
        if "Close" not in download.columns:
            raise SnapshotUpdateError("Yahoo Finance response has no Close field")
        close = download[["Close"]].copy()
        close.columns = [symbols[0]]

    if isinstance(close, pd.Series):
        close = close.to_frame(name=symbols[0])
    close.columns = [str(column).strip().upper() for column in close.columns]
    close.index = pd.to_datetime(close.index, errors="coerce")
    if getattr(close.index, "tz", None) is not None:
        close.index = close.index.tz_localize(None)
    close = close.loc[~close.index.isna()].sort_index()
    close = close.loc[:, ~close.columns.duplicated(keep="last")]
    return close.apply(pd.to_numeric, errors="coerce")


def _download_closes(tickers: list[str]) -> pd.DataFrame:
    # A month of sessions, not five days: a scheduled run that GitHub drops must
    # be recoverable on the next run rather than leaving a permanent hole in the
    # curve.  Still a single request.
    raw = yf.download(
        tickers,
        period="1mo",
        interval="1d",
        auto_adjust=False,
        progress=False,
        threads=True,
    )
    close = _extract_close(raw, tickers)

    # During the session yfinance labels the moving last trade as today's Close.
    # It is not a closing price yet and makes repeated same-day runs non-idempotent.
    # Today's row becomes eligible only once the regular session has actually ended.
    now_et = pd.Timestamp.now(tz="America/New_York")
    if now_et.weekday() < 5 and now_et.strftime("%H:%M") < "16:00":
        close = close.loc[close.index.date < now_et.date()]
    if close.empty:
        raise SnapshotUpdateError("Yahoo Finance returned no completed closing sessions")
    return close


def _benchmark_series(inception: str, price_as_of: str) -> "pd.Series | None":
    """SPY closes clamped to the book's own live window, or None if unavailable.

    A second request rather than another ticker on the holdings download: that one
    asks for ``period="1mo"``, which stopped covering the live window almost as soon
    as the account opened.  This one is anchored on the inception date, so the window
    keeps working as the track record lengthens.

    ``auto_adjust=True`` on purpose.  The account sweeps dividends into cash, so its
    NAV is a total return; the published headline benchmark is likewise a
    dividend-adjusted close.  Measuring against a price-only index would quietly book
    SPY's dividend yield as our alpha.

    Both ends are clamped to the book's own window.  The opening mark is the first
    session on or after inception, which is what resolves an inception date that
    falls on a weekend.  The closing mark is the last session on or before the day
    the book was actually priced -- that keeps the two returns measured over
    identical spans, and it also subsumes the incomplete-bar guard in
    ``_download_closes``, because ``price_as_of`` is already a completed session.
    """

    raw = yf.download(
        BENCHMARK_TICKER,
        start=inception,
        interval="1d",
        auto_adjust=True,
        progress=False,
        threads=False,
    )
    closes = _extract_close(raw, [BENCHMARK_TICKER])
    if BENCHMARK_TICKER not in closes.columns:
        return None

    series = closes[BENCHMARK_TICKER].dropna()
    series = series.loc[series > 0.0]
    series = series.loc[
        (series.index >= pd.Timestamp(inception))
        & (series.index <= pd.Timestamp(price_as_of))
    ]
    return None if series.empty else series


def _series_return(series: "pd.Series | None") -> float | None:
    """Total return across a clamped close series, or None if it cannot be measured."""

    if series is None or series.empty:
        return None
    first = float(series.iloc[0])
    last = float(series.iloc[-1])
    if first <= 0.0 or last <= 0.0:
        return None
    return round(last / first - 1.0, 8)


def _benchmark_return(inception: str, price_as_of: str) -> float | None:
    """Cumulative SPY return over the live window, or None if it cannot be measured."""

    return _series_return(_benchmark_series(inception, price_as_of))


def _live_monthly_returns(
    curve: list[dict],
    inception_nav: float,
    rebase_factor: float,
    series: "pd.Series | None",
) -> list[dict]:
    """Month-by-month live returns for the heatmap tail.

    The strategy leg comes off ``equity_curve.live``, whose values are NAV multiplied by
    ``rebase_factor``.  That factor is a constant, so it cancels in every ratio and the
    points are used as published -- the deposit anchor is simply scaled into the same
    units to match.

    The first live month is measured from the $10,000 deposit rather than from the first
    mark: the opening mark is already a mark-to-market of a deployed book, so anchoring on
    it erases the funding-day cost and overstates the account.  SPY is baselined on the
    first session on or after inception, which is exactly how ``_benchmark_return``
    measures it -- that is what makes these months compound back to
    ``live.benchmark_return`` instead of drifting away from the live block.

    Returns an empty list if any live month has no benchmark to sit against.  A strategy
    cell with an invented SPY cell next to it is worse than a blank row.
    """

    if not curve or series is None or series.empty:
        return []
    anchor = float(inception_nav) * float(rebase_factor)
    if anchor <= 0.0:
        return []

    # Both dicts keep the LAST observation of each month; the curve and the close
    # series are already date-ascending.
    nav_by_month: dict[str, float] = {}
    for point in curve:
        nav_by_month[str(point["d"])[:7]] = float(point["v"])
    spy_by_month: dict[str, float] = {}
    for stamp, close in series.items():
        spy_by_month[stamp.strftime("%Y-%m")] = float(close)

    rows: list[dict] = []
    previous_nav = anchor
    previous_spy = float(series.iloc[0])
    for month in sorted(nav_by_month):
        nav = nav_by_month[month]
        spy_close = spy_by_month.get(month)
        if spy_close is None or previous_spy <= 0.0 or previous_nav <= 0.0:
            return []
        rows.append(
            {
                "month": month,
                "strategy": round(nav / previous_nav - 1.0, 6),
                "spy": round(spy_close / previous_spy - 1.0, 6),
                "partial": True,
            }
        )
        previous_nav, previous_spy = nav, spy_close
    return rows


def _merge_monthly_returns(snapshot: dict, rows: list[dict]) -> None:
    """Swap the live tail of ``monthly_returns`` in place, leaving the backtest alone."""

    if not rows:
        return
    months = snapshot.get("monthly_returns")
    if not isinstance(months, list):
        return
    floor = rows[0]["month"]
    snapshot["monthly_returns"] = [
        row for row in months if str(row.get("month", "")) < floor
    ] + rows


def _session_prices(
    closes: pd.DataFrame, positions: list[dict], session: pd.Timestamp
) -> tuple[dict[str, float], list[str], int]:
    """Each ticker's last usable close on or before ``session``.

    Returns the prices, the tickers that had no usable close at all, and how many
    names actually *printed on* ``session``.

    A ticker with no fresh quote keeps the price already in the snapshot rather
    than failing the run -- a halted or delisted name should not freeze the whole
    dashboard.  Carrying the previous close forward is also what makes a
    backfilled session valuable: a name that did not print that day is held at its
    last real price, never at zero.

    The printed count is reported separately because carrying prices forward would
    otherwise make every session look fully covered: a day on which two names
    printed and eight were held over is a stale mark wearing a fresh date, and the
    coverage floor exists precisely to reject it.
    """

    window = closes.loc[closes.index <= session]
    prices: dict[str, float] = {}
    stale: list[str] = []
    printed = 0

    for position in positions:
        ticker = str(position["ticker"])
        series = (
            window[ticker].dropna()
            if ticker in window.columns
            else pd.Series(dtype="float64")
        )
        series = series.loc[series > 0.0]
        if series.empty:
            prices[ticker] = float(position["price"])
            stale.append(ticker)
            continue
        prices[ticker] = float(series.iloc[-1])
        if series.index[-1] == session:
            printed += 1

    return prices, stale, printed


def _session_nav(positions: list[dict], prices: dict[str, float], cash: float) -> float:
    """NAV implied by ``prices``, rounded exactly as the published values are.

    Position values are rounded before they are summed so this reconciles to the
    stored ``value`` fields to the cent, which is what the validation gate checks.
    """

    return round(
        sum(
            round(float(p["shares"]) * round(prices[str(p["ticker"])], 4), 2)
            for p in positions
        )
        + cash,
        2,
    )


# ---------------------------------------------------------------------------
# Snapshot update
# ---------------------------------------------------------------------------


def update_snapshot(base: dict) -> tuple[dict, dict]:
    """Return a price-refreshed copy of ``base`` plus a summary of what moved."""

    snapshot = copy.deepcopy(base)

    holdings = snapshot.get("holdings")
    if not isinstance(holdings, dict) or not isinstance(holdings.get("positions"), list):
        raise SnapshotUpdateError("snapshot.holdings.positions is missing or not a list")
    positions = holdings["positions"]
    if not positions:
        raise SnapshotUpdateError("snapshot.holdings.positions is empty")

    live = snapshot.get("live")
    if not isinstance(live, dict):
        raise SnapshotUpdateError("snapshot.live is missing")
    base_nav = float(live["nav"])
    rebase_factor = float(live["rebase_factor"])
    inception_nav = float(live["inception_nav"])

    # Weights do not sum to 1: the account holds a cash residual.  It is not
    # invested, so it rides through untouched while the equity is remarked.
    cash = round(base_nav - sum(float(p["value"]) for p in positions), 2)

    closes = _download_closes([str(p["ticker"]) for p in positions])

    # Live curve: fill every completed session the curve is missing, replace
    # today's point on a re-run, and refuse to walk backwards into already
    # published history.  Yahoo's close dates ARE the exchange's trading days,
    # so no holiday calendar is needed to know which sessions should exist.
    curve = snapshot["equity_curve"]["live"]
    last_published = str(curve[-1]["d"]) if curve else ""
    newest = closes.index[-1].strftime("%Y-%m-%d")
    if last_published > newest:
        raise SnapshotUpdateError(
            f"Latest close {newest} predates the published curve "
            f"({last_published}); refusing to rewrite history"
        )

    pending = [ts for ts in closes.index if ts.strftime("%Y-%m-%d") > last_published]
    if not pending:
        # The newest close is already published; re-mark it so a same-day re-run
        # stays idempotent rather than becoming a no-op.
        pending = [closes.index[-1]]
    if len(pending) > MAX_BACKFILL_SESSIONS:
        pending = pending[-MAX_BACKFILL_SESSIONS:]

    prices: dict[str, float] = {}
    stale: list[str] = []
    nav = base_nav
    written: list[str] = []
    skipped: list[str] = []

    for offset, session in enumerate(pending):
        session_iso = session.strftime("%Y-%m-%d")
        is_final = offset == len(pending) - 1
        session_prices, session_stale, printed = _session_prices(
            closes, positions, session
        )
        coverage = printed / len(positions)
        if coverage < MIN_PRICE_COVERAGE:
            # The newest session has to be trustworthy -- it sets the published
            # NAV.  An older backfill session is optional, so a thin one is left
            # as a hole rather than costing the whole update.
            if is_final:
                raise SnapshotUpdateError(
                    f"Only {coverage:.0%} of holdings printed a close on "
                    f"{session_iso} (need {MIN_PRICE_COVERAGE:.0%})"
                )
            skipped.append(session_iso)
            continue

        session_nav = _session_nav(positions, session_prices, cash)
        if session_nav <= 0.0:
            raise SnapshotUpdateError(
                f"Refreshed NAV is not positive on {session_iso}: {session_nav}"
            )

        point = {"d": session_iso, "v": round(session_nav * rebase_factor, 2)}
        if curve and str(curve[-1]["d"]) == session_iso:
            curve[-1] = point
        else:
            curve.append(point)
        written.append(session_iso)
        prices, stale, nav = session_prices, session_stale, session_nav

    if not written:
        raise SnapshotUpdateError("No session had enough priced holdings to publish")

    # Only the last session marks the book: the snapshot carries one set of
    # prices, and the validation gate requires the final curve point to equal
    # NAV * rebase_factor at ``as_of``.
    price_as_of = written[-1]
    for position in positions:
        # Value is derived from the price as STORED, not as fetched: the gate
        # recomputes shares * price from the published fields, so rounding the
        # price after multiplying leaves the two disagreeing on a large holding.
        price = round(prices[str(position["ticker"])], 4)
        position["price"] = price
        position["value"] = round(float(position["shares"]) * price, 2)
    for position in positions:
        position["weight"] = round(float(position["value"]) / nav, 8)

    holdings["as_of"] = price_as_of  # last_rebalance is owned by the research pipeline
    live["nav"] = nav
    live["since_inception_return"] = round(nav / inception_nav - 1.0, 8)
    live["days_live"] = len(curve)
    live["last_updated"] = price_as_of

    # Caught here rather than left to main(): the book has already been remarked at
    # this point, and losing a whole day of prices because Yahoo would not serve one
    # extra symbol is a bad trade.  --require-update would also turn it into a red
    # CI run for something that costs the page nothing.
    benchmark: float | None = None
    benchmark_series = None
    try:
        benchmark_series = _benchmark_series(str(live["inception_date"]), price_as_of)
        benchmark = _series_return(benchmark_series)
    except Exception as exc:  # noqa: BLE001 - the price refresh outranks the benchmark
        print(
            f"benchmark refresh skipped: {type(exc).__name__}: {exc}",
            file=sys.stderr,
        )

    # Null, never carried forward.  Pairing a stale benchmark with a fresh NAV does
    # not produce a conservative alpha, it produces a wrong one -- the same reason
    # the chart refuses to extend the SPY line across the gap where it runs out.
    # The dashboard hides the live view when these are null, so the failure mode is
    # a missing number rather than an invented one.
    live["benchmark_return"] = benchmark
    live["excess_return"] = (
        None
        if benchmark is None
        else round(float(live["since_inception_return"]) - benchmark, 8)
    )

    # Heatmap tail.  Rebuilt from the SAME close series the live block was measured
    # against, so the grid and the hero card cannot drift apart -- one fetch, one
    # baseline, two consumers.  The certified backtest months are untouched, and a
    # missing benchmark leaves the whole section exactly as the research pipeline
    # published it.
    live_months = _live_monthly_returns(
        curve, inception_nav, rebase_factor, benchmark_series
    )
    _merge_monthly_returns(snapshot, live_months)

    snapshot["as_of"] = price_as_of
    snapshot["generated_at"] = (
        datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    )

    summary = {
        "price_as_of": price_as_of,
        "positions": len(positions),
        "stale": stale,
        "nav": nav,
        "base_nav": base_nav,
        "nav_change": nav / base_nav - 1.0,
        "live_days": len(curve),
        "cash": cash,
        "backfilled": written[:-1],
        "skipped": skipped,
        "live_months": [row["month"] for row in live_months],
    }
    return snapshot, summary


# ---------------------------------------------------------------------------
# Validation gate
# ---------------------------------------------------------------------------


def _canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _validate_monthly_returns(base: dict, updated: dict) -> None:
    """Append-or-update only, and only from the live inception month forward.

    Every month the backtest covers is certified research output and is frozen exactly as
    if it were still listed in ``FROZEN_TOP_LEVEL``.  The months since the account was
    funded are not research output -- they are its own marks, and they move every session
    -- so the refresher owns that tail and nothing else.

    The boundary is read off ``live.inception_date`` rather than hard-coded to a month
    that would silently rot -- and off the BASE snapshot, not the updated one.  Reading it
    from the payload under inspection would let a backdated inception move the floor and
    unfreeze history underneath it.  ``validate`` does hold that field immutable, but it
    checks later in the pass, so taking the floor from ``base`` keeps this gate correct
    on its own rather than dependent on the order of the checks around it.
    """

    old = base.get("monthly_returns")
    new = updated.get("monthly_returns")
    if not isinstance(new, list) or not new:
        raise SnapshotUpdateError("monthly_returns is missing or empty")
    if not isinstance(old, list):
        raise SnapshotUpdateError("base monthly_returns is missing or not a list")

    floor = str(base["live"]["inception_date"])[:7]
    as_of_month = str(updated["as_of"])[:7]

    frozen_old = [row for row in old if str(row.get("month", "")) < floor]
    frozen_new = [row for row in new if str(row.get("month", "")) < floor]
    if _canonical(frozen_new) != _canonical(frozen_old):
        raise SnapshotUpdateError(
            f"Certified months before {floor} were modified "
            f"({len(frozen_old)} -> {len(frozen_new)} rows)"
        )

    labels = [str(row.get("month", "")) for row in new]
    if labels != sorted(labels):
        raise SnapshotUpdateError("monthly_returns is not sorted by month")
    if len(set(labels)) != len(labels):
        raise SnapshotUpdateError("monthly_returns has duplicate months")

    for row in new:
        month = str(row.get("month", ""))
        if not _MONTH_LABEL.fullmatch(month):
            raise SnapshotUpdateError(f"monthly_returns has a malformed month {month!r}")
        if month > as_of_month:
            raise SnapshotUpdateError(
                f"monthly_returns reaches {month}, past as_of {as_of_month}"
            )
        for field in ("strategy", "spy"):
            value = row.get(field)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise SnapshotUpdateError(
                    f"monthly_returns[{month}].{field} is not a number: {value!r}"
                )
            if not -1.0 < float(value) < 1.0:
                raise SnapshotUpdateError(
                    f"monthly_returns[{month}].{field} is out of range: {value!r}"
                )


def validate(base: dict, updated: dict) -> None:
    """Refuse to publish anything that is not a pure price refresh of ``base``."""

    if tuple(updated) != EXPECTED_TOP_LEVEL:
        raise SnapshotUpdateError(
            "Top-level keys changed.\n  expected: "
            f"{list(EXPECTED_TOP_LEVEL)}\n  got:      {list(updated)}"
        )

    for key in FROZEN_TOP_LEVEL:
        if _canonical(updated[key]) != _canonical(base[key]):
            raise SnapshotUpdateError(f"Certified section '{key}' was modified")
    _validate_monthly_returns(base, updated)
    for name in FROZEN_CURVES:
        if _canonical(updated["equity_curve"][name]) != _canonical(
            base["equity_curve"][name]
        ):
            raise SnapshotUpdateError(f"Certified curve 'equity_curve.{name}' was modified")
    if tuple(updated["equity_curve"]) != tuple(base["equity_curve"]):
        raise SnapshotUpdateError("equity_curve keys changed")

    old_positions = base["holdings"]["positions"]
    new_positions = updated["holdings"]["positions"]
    if len(new_positions) != len(old_positions):
        raise SnapshotUpdateError(
            f"Holdings count changed: {len(old_positions)} -> {len(new_positions)}. "
            "The dashboard publishes the small account, not the production book."
        )
    if updated["holdings"]["last_rebalance"] != base["holdings"]["last_rebalance"]:
        raise SnapshotUpdateError("holdings.last_rebalance was modified")

    for old, new in zip(old_positions, new_positions):
        missing = [f for f in REQUIRED_POSITION_FIELDS if f not in new]
        if missing:
            raise SnapshotUpdateError(
                f"Position {new.get('ticker')} is missing required field(s): {missing}"
            )
        if tuple(new) != tuple(old):
            raise SnapshotUpdateError(
                f"Position {new.get('ticker')} fields changed: "
                f"{list(old)} -> {list(new)}"
            )
        # Everything the refresh does not price is frozen, including fields this
        # script has no opinion about.
        for field in tuple(new):
            if field in PRICED_POSITION_FIELDS:
                continue
            if _canonical(new[field]) != _canonical(old[field]):
                raise SnapshotUpdateError(
                    f"Position {old['ticker']}.{field} changed: "
                    f"{old[field]!r} -> {new[field]!r}"
                )
        if not isinstance(new["price"], (int, float)) or new["price"] <= 0:
            raise SnapshotUpdateError(f"Position {new['ticker']} has a non-positive price")
        if new["weight"] <= 0:
            raise SnapshotUpdateError(f"Position {new['ticker']} has a non-positive weight")
        expected_value = round(float(new["shares"]) * float(new["price"]), 2)
        if abs(float(new["value"]) - expected_value) > 0.01:
            raise SnapshotUpdateError(
                f"Position {new['ticker']} breaks value == shares * price"
            )

    total_weight = sum(float(p["weight"]) for p in new_positions)
    if total_weight > 1.0 + 1e-6:
        raise SnapshotUpdateError(f"Weights sum to {total_weight:.6f}, above 100%")

    live = updated["live"]
    for field in ("inception_date", "inception_nav", "rebase_factor"):
        if live[field] != base["live"][field]:
            raise SnapshotUpdateError(f"live.{field} was modified")

    # The live view needs both numbers or neither: rendering a return with no
    # benchmark beside it, or an alpha with nothing to attribute it to, is worse
    # than not offering the view.
    benchmark = live.get("benchmark_return")
    excess = live.get("excess_return")
    if (benchmark is None) != (excess is None):
        raise SnapshotUpdateError(
            "live.benchmark_return and live.excess_return must be set together"
        )
    if benchmark is not None:
        implied = float(live["since_inception_return"]) - float(benchmark)
        if abs(float(excess) - implied) > 1e-6:
            raise SnapshotUpdateError(
                f"live.excess_return {float(excess):.8f} is not "
                f"since_inception_return - benchmark_return ({implied:.8f})"
            )

    nav = float(live["nav"])
    cash = round(float(base["live"]["nav"]) - sum(float(p["value"]) for p in old_positions), 2)
    expected_nav = sum(float(p["value"]) for p in new_positions) + cash
    if abs(nav - expected_nav) > 0.02:
        raise SnapshotUpdateError(
            f"live.nav {nav:.2f} does not reconcile to positions plus cash {expected_nav:.2f}"
        )

    curve = updated["equity_curve"]["live"]
    base_curve = base["equity_curve"]["live"]
    dates = [str(point["d"]) for point in curve]
    if dates != sorted(dates) or len(set(dates)) != len(dates):
        raise SnapshotUpdateError("equity_curve.live dates are not strictly increasing")
    if base_curve and _canonical(curve[0]) != _canonical(base_curve[0]):
        raise SnapshotUpdateError("The live inception anchor was modified")
    if len(curve) < len(base_curve):
        raise SnapshotUpdateError("equity_curve.live lost points")

    # Move guard, session by session.  Anchored on the last point this update
    # left untouched, so it covers both an appended backfill and a re-marked
    # final point.  Checking end-to-end instead would flag a multi-session gap's
    # compounded return as if it were a bad print.
    first_changed = len(base_curve)
    for index, point in enumerate(base_curve):
        if index >= len(curve) or _canonical(curve[index]) != _canonical(point):
            first_changed = index
            break
    values = [float(p["v"]) for p in curve[max(first_changed - 1, 0):]]
    for earlier, later in zip(values, values[1:]):
        if earlier <= 0.0:
            raise SnapshotUpdateError("equity_curve.live contains a non-positive value")
        step = later / earlier - 1.0
        if abs(step) > MAX_NAV_MOVE:
            raise SnapshotUpdateError(
                f"NAV moved {step:+.2%} in one session (limit {MAX_NAV_MOVE:.0%}); "
                "this looks like a bad price, not a return"
            )

    if live["days_live"] != len(curve):
        raise SnapshotUpdateError("live.days_live disagrees with the live curve length")
    expected_v = round(nav * float(live["rebase_factor"]), 2)
    if abs(float(curve[-1]["v"]) - expected_v) > 0.02:
        raise SnapshotUpdateError("The last live point is not NAV * rebase_factor")
    if str(curve[-1]["d"]) != str(updated["as_of"]):
        raise SnapshotUpdateError("as_of disagrees with the last live point")

    # Must serialise cleanly: NaN/Infinity would produce JSON the browser rejects.
    json.dumps(updated, separators=(",", ":"), allow_nan=False)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        default="portfolio_snapshot.json",
        help="Snapshot to refresh in place (also the base it is built from)",
    )
    parser.add_argument(
        "--input",
        default=None,
        help="Read the base from here instead of --output",
    )
    parser.add_argument(
        "--require-update",
        action="store_true",
        help=(
            "Exit non-zero if the refresh is skipped. The published file is still "
            "left untouched; this only makes the failure visible to CI."
        ),
    )
    args = parser.parse_args()

    destination = Path(args.output)
    source = Path(args.input) if args.input else destination

    # Anything that goes wrong from here on leaves the published file untouched.
    # Not writing is strictly safer than rewriting: a rewrite can fail mid-flight.
    #
    # Exiting 0 on a skip keeps a Yahoo outage from taking the page down, but on
    # its own it also hides a real breakage behind a green tick -- which is how a
    # schema change went unnoticed for five days.  --require-update lets the
    # scheduled job stay loud while keeping the same never-rewrite guarantee.
    try:
        base = json.loads(source.read_text(encoding="utf-8"))
        updated, summary = update_snapshot(base)
        validate(base, updated)
    except Exception as exc:  # noqa: BLE001 - the dashboard must never go down
        print(f"snapshot refresh skipped: {type(exc).__name__}: {exc}", file=sys.stderr)
        print(f"keeping the last known good snapshot at {destination}", file=sys.stderr)
        return 1 if args.require_update else 0

    payload = json.dumps(updated, separators=(",", ":"), allow_nan=False) + "\n"
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(payload, encoding="utf-8")
    temporary.replace(destination)

    print(
        f"refreshed {destination}: {summary['positions']} holdings priced "
        f"{summary['price_as_of']}, NAV {summary['base_nav']:,.2f} -> "
        f"{summary['nav']:,.2f} ({summary['nav_change']:+.2%}), "
        f"{summary['live_days']} live days, cash {summary['cash']:,.2f}"
    )
    if summary["backfilled"]:
        print(
            f"  BACKFILL: filled {len(summary['backfilled'])} missing session(s) "
            f"({', '.join(summary['backfilled'])})"
        )
    if summary["skipped"]:
        print(
            "  skipped (too few holdings priced): " + ", ".join(summary["skipped"])
        )
    if summary["stale"]:
        print("  kept previous price for: " + ", ".join(summary["stale"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

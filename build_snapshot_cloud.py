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
table, sector history, monthly returns, notes -- is carried through untouched.
The gate runs against the finished payload *before* anything is written, and any
failure leaves the file on disk exactly as it was.

Depends only on pandas, yfinance, and the standard library.
"""
from __future__ import annotations

import argparse
import copy
import json
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
    "monthly_returns",
    "notes",
)
FROZEN_CURVES = ("backtest", "simulation", "spy")

POSITION_FIELDS = ("ticker", "name", "sector", "weight", "value", "shares", "price")

# A single session cannot plausibly move a diversified 10-name book this far.
# Anything larger is a bad Yahoo print, not a real return.
MAX_NAV_MOVE = 0.25

# Tolerate the odd halted or delisted name, but refuse to mark the whole book
# to market off a handful of quotes.
MIN_PRICE_COVERAGE = 0.8


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
    raw = yf.download(
        tickers,
        period="5d",
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


def _latest_prices(
    closes: pd.DataFrame, positions: list[dict]
) -> tuple[dict[str, float], list[str], str]:
    """Last completed close per ticker.

    A ticker with no fresh quote keeps the price already in the snapshot rather
    than failing the run -- a halted or delisted name should not freeze the whole
    dashboard.  The as-of date is taken from the tickers that did price.
    """

    prices: dict[str, float] = {}
    stale: list[str] = []
    dates: list[pd.Timestamp] = []

    for position in positions:
        ticker = str(position["ticker"])
        series = (
            closes[ticker].dropna()
            if ticker in closes.columns
            else pd.Series(dtype="float64")
        )
        series = series.loc[series > 0.0]
        if series.empty:
            prices[ticker] = float(position["price"])
            stale.append(ticker)
            continue
        prices[ticker] = float(series.iloc[-1])
        dates.append(pd.Timestamp(series.index[-1]))

    if not dates:
        raise SnapshotUpdateError(
            "Yahoo Finance returned no usable close for any holding"
        )
    coverage = (len(positions) - len(stale)) / len(positions)
    if coverage < MIN_PRICE_COVERAGE:
        raise SnapshotUpdateError(
            f"Only {coverage:.0%} of holdings priced (need {MIN_PRICE_COVERAGE:.0%}); "
            "missing: " + ", ".join(stale)
        )
    return prices, stale, max(dates).strftime("%Y-%m-%d")


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
    prices, stale, price_as_of = _latest_prices(closes, positions)

    for position in positions:
        price = prices[str(position["ticker"])]
        position["price"] = round(price, 4)
        position["value"] = round(float(position["shares"]) * price, 2)

    nav = round(sum(float(p["value"]) for p in positions) + cash, 2)
    if nav <= 0.0:
        raise SnapshotUpdateError(f"Refreshed NAV is not positive: {nav}")
    for position in positions:
        position["weight"] = round(float(position["value"]) / nav, 8)

    # Live curve: replace today's point on a re-run, append a new session, and
    # refuse to walk backwards into already-published history.
    curve = snapshot["equity_curve"]["live"]
    point = {"d": price_as_of, "v": round(nav * rebase_factor, 2)}
    if curve and str(curve[-1]["d"]) > price_as_of:
        raise SnapshotUpdateError(
            f"Latest close {price_as_of} predates the published curve "
            f"({curve[-1]['d']}); refusing to rewrite history"
        )
    if curve and str(curve[-1]["d"]) == price_as_of:
        curve[-1] = point
    else:
        curve.append(point)

    holdings["as_of"] = price_as_of  # last_rebalance is owned by the research pipeline
    live["nav"] = nav
    live["since_inception_return"] = round(nav / inception_nav - 1.0, 8)
    live["days_live"] = len(curve)
    live["last_updated"] = price_as_of

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
    }
    return snapshot, summary


# ---------------------------------------------------------------------------
# Validation gate
# ---------------------------------------------------------------------------


def _canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


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
        if tuple(new) != POSITION_FIELDS:
            raise SnapshotUpdateError(
                f"Position {new.get('ticker')} fields changed: {list(new)}"
            )
        for field in ("ticker", "name", "sector", "shares"):
            if new[field] != old[field]:
                raise SnapshotUpdateError(
                    f"Position {old['ticker']}.{field} changed: {old[field]} -> {new[field]}"
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

    nav = float(live["nav"])
    move = nav / float(base["live"]["nav"]) - 1.0
    if abs(move) > MAX_NAV_MOVE:
        raise SnapshotUpdateError(
            f"NAV moved {move:+.2%} in one update (limit {MAX_NAV_MOVE:.0%}); "
            "this looks like a bad price, not a return"
        )
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
    args = parser.parse_args()

    destination = Path(args.output)
    source = Path(args.input) if args.input else destination

    # Anything that goes wrong from here on leaves the published file untouched.
    # Not writing is strictly safer than rewriting: a rewrite can fail mid-flight.
    try:
        base = json.loads(source.read_text(encoding="utf-8"))
        updated, summary = update_snapshot(base)
        validate(base, updated)
    except Exception as exc:  # noqa: BLE001 - the dashboard must never go down
        print(f"snapshot refresh skipped: {type(exc).__name__}: {exc}", file=sys.stderr)
        print(f"keeping the last known good snapshot at {destination}", file=sys.stderr)
        return 0

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
    if summary["stale"]:
        print("  kept previous price for: " + ", ".join(summary["stale"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

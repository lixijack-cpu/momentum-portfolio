#!/usr/bin/env python3
"""Refresh the public dashboard's live data without the research stack.

The builder deliberately depends only on pandas, yfinance, and the Python
standard library.  It reuses the certified backtest sections already present
in the public snapshot, then rebuilds holdings and live performance from the
two small CSV exports that can safely live in the public repository.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd
import yfinance as yf


STARTING_NAV = 10_000.0


class SnapshotBuildError(RuntimeError):
    """Raised when a cloud snapshot cannot be built without stale data."""


def _unique_paths(paths: list[Path]) -> list[Path]:
    seen: set[Path] = set()
    unique = []
    for path in paths:
        resolved = path.resolve()
        if resolved not in seen:
            seen.add(resolved)
            unique.append(resolved)
    return unique


def _roots() -> list[Path]:
    """Support both ``scripts/`` in the research repo and repo-root copies."""

    script = Path(__file__).resolve()
    script_root = script.parent.parent if script.parent.name == "scripts" else script.parent
    return _unique_paths([Path.cwd(), script_root])


def _find_input(nested: Path, flat: Path) -> Path:
    candidates = _unique_paths(
        [candidate for root in _roots() for candidate in (root / nested, root / flat)]
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise SnapshotBuildError(
        "Required input is missing; checked: "
        + ", ".join(str(candidate) for candidate in candidates)
    )


def _is_compatible_seed(payload: object) -> bool:
    if not isinstance(payload, dict):
        return False
    headline = payload.get("headline")
    curve = payload.get("equity_curve")
    return (
        isinstance(headline, dict)
        and "cagr" in headline
        and "sharpe" in headline
        and isinstance(curve, dict)
        and isinstance(curve.get("backtest"), list)
    )


def _load_seed() -> tuple[Path, dict]:
    """Load the site-compatible snapshot while preserving a newer local schema.

    ``portfolio_snapshot.json`` is the normal seed in both repositories.  The
    research worktree can temporarily contain the newer Phase 66 privacy-export
    schema at that path, while ``quant_fund_snapshot.json`` remains the dashboard-
    compatible seed.  Falling back avoids overwriting or publishing an incompatible
    in-progress artifact.
    """

    relative_candidates = (
        Path("reports/public/portfolio_snapshot.json"),
        Path("portfolio_snapshot.json"),
        Path("reports/public/quant_fund_snapshot.json"),
        Path("quant_fund_snapshot.json"),
    )
    checked = []
    for candidate in _unique_paths(
        [root / relative for root in _roots() for relative in relative_candidates]
    ):
        if not candidate.is_file():
            continue
        checked.append(candidate)
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if _is_compatible_seed(payload):
            return candidate, payload
    raise SnapshotBuildError(
        "No dashboard-compatible snapshot seed was found. Expected headline.cagr, "
        "headline.sharpe, and equity_curve.backtest in one of: "
        + ", ".join(str(path) for path in checked or relative_candidates)
    )


def _read_allocation(path: Path) -> pd.DataFrame:
    frame = pd.read_csv(path)
    required = {"ticker", "weight"}
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise SnapshotBuildError(f"{path} is missing columns: {', '.join(missing)}")

    frame = frame.copy()
    frame["ticker"] = frame["ticker"].astype("string").str.strip().str.upper()
    frame["weight"] = pd.to_numeric(frame["weight"], errors="coerce")
    frame = frame.loc[frame["weight"].fillna(0.0) > 0.0].copy()
    if frame.empty:
        raise SnapshotBuildError(f"{path} contains no positive-weight holdings")
    if frame["ticker"].isna().any() or (frame["ticker"] == "").any():
        raise SnapshotBuildError(f"{path} contains a blank ticker")
    duplicates = sorted(frame.loc[frame["ticker"].duplicated(False), "ticker"].unique())
    if duplicates:
        raise SnapshotBuildError(
            f"{path} contains duplicate tickers: {', '.join(duplicates)}"
        )
    if float(frame["weight"].sum()) > 1.000001:
        raise SnapshotBuildError(
            f"{path} weights sum to {frame['weight'].sum():.6f}, above 100%"
        )
    return frame.reset_index(drop=True)


def _extract_close(download: pd.DataFrame, symbols: list[str]) -> pd.DataFrame:
    if download.empty:
        raise SnapshotBuildError("Yahoo Finance returned no price observations")

    if isinstance(download.columns, pd.MultiIndex):
        close = None
        for level in range(download.columns.nlevels):
            values = download.columns.get_level_values(level)
            if "Close" in values:
                close = download.xs("Close", axis=1, level=level, drop_level=True)
                break
        if close is None:
            raise SnapshotBuildError("Yahoo Finance response has no Close field")
    else:
        if "Close" not in download.columns:
            raise SnapshotBuildError("Yahoo Finance response has no Close field")
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
    symbols = list(dict.fromkeys([*tickers, "SPY"]))
    raw = yf.download(
        symbols,
        period="5d",
        interval="1d",
        auto_adjust=False,
        progress=False,
        threads=True,
    )
    close = _extract_close(raw, symbols)
    # During the session yfinance labels the moving last trade as today's Close.
    # It is not a closing price yet and makes repeated same-day runs non-idempotent.
    # The scheduled job runs at 16:30 ET, so today's row becomes eligible only once
    # the regular session has actually ended.
    now_et = pd.Timestamp.now(tz="America/New_York")
    if now_et.weekday() < 5 and now_et.strftime("%H:%M") < "16:00":
        close = close.loc[close.index.date < now_et.date()]
    if close.empty:
        raise SnapshotBuildError("Yahoo Finance returned no completed closing sessions")
    missing = [
        symbol
        for symbol in symbols
        if symbol not in close.columns or close[symbol].dropna().empty
    ]
    if missing:
        raise SnapshotBuildError(
            "Yahoo Finance returned no completed 5-day closing price for: "
            + ", ".join(missing)
        )
    return close.reindex(columns=symbols)


def _history_from_seed(seed: dict) -> pd.DataFrame:
    rows = []
    for row in seed.get("daily_returns", []):
        if not isinstance(row, dict):
            continue
        rows.append(
            {
                "date": row.get("date"),
                "portfolio_return": row.get(
                    "portfolio_return", row.get("shadow_daily_return")
                ),
                "benchmark_return": row.get(
                    "benchmark_return", row.get("sp500_daily_return")
                ),
            }
        )
    return pd.DataFrame(rows, columns=["date", "portfolio_return", "benchmark_return"])


def _history_from_csv(path: Path) -> pd.DataFrame:
    frame = pd.read_csv(path)
    required = {"date", "shadow_daily_return", "sp500_daily_return"}
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise SnapshotBuildError(f"{path} is missing columns: {', '.join(missing)}")
    return frame.loc[:, list(required)].rename(
        columns={
            "shadow_daily_return": "portfolio_return",
            "sp500_daily_return": "benchmark_return",
        }
    )


def _calculated_history(closes: pd.DataFrame, allocation: pd.DataFrame) -> pd.DataFrame:
    tickers = allocation["ticker"].tolist()
    weights = allocation.set_index("ticker")["weight"]
    returns = closes[tickers].pct_change(fill_method=None)
    portfolio = returns.mul(weights, axis="columns").sum(
        axis="columns", min_count=len(tickers)
    )
    benchmark = closes["SPY"].pct_change(fill_method=None)
    return pd.DataFrame(
        {
            "date": closes.index,
            "portfolio_return": portfolio,
            "benchmark_return": benchmark,
        }
    ).dropna(subset=["portfolio_return", "benchmark_return"])


def _merge_history(
    seed: dict,
    history_path: Path,
    closes: pd.DataFrame,
    allocation: pd.DataFrame,
) -> pd.DataFrame:
    sources = [_history_from_seed(seed), _history_from_csv(history_path)]
    existing = pd.concat(
        [source for source in sources if not source.empty], ignore_index=True
    )
    existing["date"] = pd.to_datetime(existing["date"], errors="coerce")
    existing = existing.dropna(subset=["date"]).sort_values("date")
    existing = existing.drop_duplicates("date", keep="last")

    calculated = _calculated_history(closes, allocation)
    calculated = calculated.loc[~calculated["date"].isin(existing["date"])]
    merged = pd.concat([existing, calculated], ignore_index=True).sort_values("date")
    merged = merged.drop_duplicates("date", keep="first").reset_index(drop=True)
    for column in ("portfolio_return", "benchmark_return"):
        merged[column] = pd.to_numeric(merged[column], errors="coerce")
        invalid = merged[column].isna() | (merged[column] <= -1.0)
        if invalid.any():
            dates = merged.loc[invalid, "date"].dt.strftime("%Y-%m-%d").tolist()
            raise SnapshotBuildError(
                f"Invalid {column} observations on: {', '.join(dates)}"
            )
    if merged.empty:
        raise SnapshotBuildError("Live performance history is empty")
    return merged


def _latest_prices(closes: pd.DataFrame, tickers: list[str]) -> tuple[dict[str, float], str]:
    prices = {}
    dates = []
    for ticker in tickers:
        observations = closes[ticker].dropna()
        prices[ticker] = float(observations.iloc[-1])
        dates.append(pd.Timestamp(observations.index[-1]))
    return prices, max(dates).strftime("%Y-%m-%d")


def _display_name(value: object, ticker: str) -> str:
    if value is None or pd.isna(value) or not str(value).strip():
        return ticker
    return " ".join(word.title() for word in str(value).strip().split())


def _build_holdings(
    allocation: pd.DataFrame,
    prices: dict[str, float],
    nav: float,
    as_of: str,
    previous: object,
) -> tuple[dict, list[dict]]:
    ordered = allocation.sort_values("weight", ascending=False, kind="mergesort")
    positions = []
    for row in ordered.to_dict(orient="records"):
        ticker = str(row["ticker"])
        weight = float(row["weight"])
        price = prices[ticker]
        value = nav * weight
        sector = row.get("sector")
        if sector is None or pd.isna(sector) or not str(sector).strip():
            sector = "Other"
        positions.append(
            {
                "ticker": ticker,
                "name": _display_name(row.get("name"), ticker),
                "sector": str(sector),
                "weight": round(weight, 8),
                "value": round(value, 2),
                "shares": round(value / price, 4),
                "price": round(price, 4),
            }
        )

    last_rebalance = None
    if "rebalance" in allocation.columns:
        dates = pd.to_datetime(allocation["rebalance"], errors="coerce").dropna()
        if not dates.empty:
            last_rebalance = dates.max().strftime("%Y-%m-%d")
    if last_rebalance is None and isinstance(previous, dict):
        last_rebalance = previous.get("last_rebalance")
    return (
        {"as_of": as_of, "last_rebalance": last_rebalance, "positions": positions},
        positions,
    )


def _static_endpoint(seed: dict) -> float:
    curve = seed["equity_curve"]
    points = curve.get("simulation") or curve["backtest"]
    if not points or "v" not in points[-1]:
        raise SnapshotBuildError("Static equity curve has no terminal NAV")
    return float(points[-1]["v"])


def _rebuild_spy_curve(seed: dict, history: pd.DataFrame) -> list[dict]:
    static_end = str(seed["headline"].get("window_end", "9999-12-31"))
    static = [
        point
        for point in seed["equity_curve"].get("spy", [])
        if str(point.get("d", "")) <= static_end
    ]
    if not static:
        return seed["equity_curve"].get("spy", [])

    extension = history.loc[history["date"] > pd.Timestamp(static_end)].copy()
    values = float(static[-1]["v"]) * (1.0 + extension["benchmark_return"]).cumprod()
    return static + [
        {"d": stamp.strftime("%Y-%m-%d"), "v": round(float(value), 2)}
        for stamp, value in zip(extension["date"], values)
    ]


def build_snapshot() -> tuple[dict, dict[str, object]]:
    allocation_path = _find_input(
        Path("reports/portfolio_allocation.csv"), Path("portfolio_allocation.csv")
    )
    history_path = _find_input(
        Path("reports/shadow_live_track.csv"), Path("shadow_live_track.csv")
    )
    seed_path, snapshot = _load_seed()

    allocation = _read_allocation(allocation_path)
    tickers = allocation["ticker"].tolist()
    closes = _download_closes(tickers)
    prices, price_as_of = _latest_prices(closes, tickers)
    history = _merge_history(snapshot, history_path, closes, allocation)

    nav_series = STARTING_NAV * (1.0 + history["portfolio_return"]).cumprod()
    nav = float(nav_series.iloc[-1])
    rebase_factor = _static_endpoint(snapshot) / STARTING_NAV
    live_curve = [
        {
            "d": stamp.strftime("%Y-%m-%d"),
            "v": round(float(value) * rebase_factor, 2),
        }
        for stamp, value in zip(history["date"], nav_series)
    ]
    history_as_of = history["date"].iloc[-1].strftime("%Y-%m-%d")
    last_updated = pd.Timestamp(price_as_of).tz_localize("UTC").isoformat()
    live_stats = {
        "nav": round(nav, 2),
        "inception_date": history["date"].iloc[0].strftime("%Y-%m-%d"),
        "inception_nav": STARTING_NAV,
        "since_inception_return": round(nav / STARTING_NAV - 1.0, 8),
        "days_live": int(len(history)),
        "last_updated": history_as_of,
        "rebase_factor": round(rebase_factor, 8),
    }
    holdings, current_holdings = _build_holdings(
        allocation, prices, nav, price_as_of, snapshot.get("holdings")
    )
    daily_returns = [
        {
            "date": row.date.strftime("%Y-%m-%d"),
            "portfolio_return": round(float(row.portfolio_return), 10),
            "benchmark_return": round(float(row.benchmark_return), 10),
        }
        for row in history.itertuples(index=False)
    ]

    # Certified research sections remain untouched.  Only fields backed by the
    # public CSVs or current market closes are replaced or added here.
    snapshot["generated_at"] = last_updated
    snapshot["as_of"] = price_as_of
    snapshot["equity_curve"]["live"] = live_curve
    snapshot["equity_curve"]["spy"] = _rebuild_spy_curve(snapshot, history)
    snapshot["live"] = live_stats
    snapshot["holdings"] = holdings
    snapshot["current_holdings"] = current_holdings
    snapshot["live_equity_curve"] = live_curve
    snapshot["daily_returns"] = daily_returns
    snapshot["last_updated"] = last_updated
    snapshot["live_performance_stats"] = live_stats

    metadata = {
        "seed": seed_path,
        "allocation": allocation_path,
        "history": history_path,
        "price_as_of": price_as_of,
        "holdings": len(current_holdings),
        "live_days": len(history),
    }
    return snapshot, metadata


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        default="portfolio_snapshot.json",
        help="Destination JSON path",
    )
    args = parser.parse_args()

    try:
        snapshot, metadata = build_snapshot()
    except (OSError, ValueError, SnapshotBuildError) as exc:
        parser.exit(2, f"error: {exc}\n")

    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(
        json.dumps(snapshot, separators=(",", ":"), allow_nan=False) + "\n",
        encoding="utf-8",
    )
    temporary.replace(destination)

    print(
        f"wrote {destination} with {metadata['holdings']} holdings and "
        f"{metadata['live_days']} live days (prices {metadata['price_as_of']})"
    )
    print(f"  static seed: {metadata['seed']}")
    print(f"  allocation: {metadata['allocation']}")
    print(f"  live history: {metadata['history']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

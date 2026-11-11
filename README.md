# Systematic Equity Strategy

**Live Dashboard:** [lixijack-cpu.github.io/momentum-portfolio](https://lixijack-cpu.github.io/momentum-portfolio/)

A systematic, point-in-time US equity strategy combining fundamental and market signals with
dynamic regime-based risk management. Long-only, rebalanced monthly. Since 2026-11-09, in trend-off
and high-volatility regimes the retail paper account also holds a crisis-type macro ETF basket (gold,
Treasuries, the US dollar, or an inverse S&P 500 fund, each held long) in up to half of its cash floor.
The backtested results below predate this sleeve and do not include it.

**Backtested Performance (Dec 2005 – Jun 2026, 247 out-of-sample months, net of costs)**

| Metric | Retail Track | Institutional Track | Shadow Track | S&P 500 |
|---|---:|---:|---:|---:|
| CAGR | 17.11% | 14.00% | 12.28% | 11.04% |
| Sharpe Ratio | 0.921 | 0.942 | 1.076 | 0.642 |
| Max Drawdown (month-end) | −20.92% | −19.51% | −10.56% | — |
| Max Drawdown (daily marks) | −29.60% | −26.70% | −17.95% | −55.19% |

Drawdown is quoted on both bases because month-end sampling structurally understates it, and
both legs of the excess-return figure are measured over the same window.

**Live Paper Trading:** July 2026 → Present

## Method

Point-in-time data with no look-ahead and no survivorship bias. Every figure on the dashboard
is computed from a certified walk-forward run — the equity curve, crash windows, sector
history, and monthly returns are all measured, none are illustrative.

The 2011 EU debt crisis is reported even though the strategy underperformed the S&P 500 in
that window. A stress table in which every row wins is not a stress table.

Portfolio-level figures (NAV, returns, drawdowns, sector weights) are published after each
close. Individual positions entered within the last 7 days are embargoed to protect live
execution and are revealed once that window passes or the position is closed.

## Files

| File | Purpose |
|---|---|
| `index.html` | The dashboard — a single self-contained file |
| `*_snapshot.json` | Data feeds, published from the private research pipeline |
| `.github/workflows/pages.yml` | Validates the feeds and deploys the site to GitHub Pages |

*Personal research project. Not investment advice.*

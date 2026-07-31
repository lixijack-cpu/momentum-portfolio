# Systematic Equity Strategy

**Live Dashboard:** [lixijack-cpu.github.io/quant-fund](https://lixijack-cpu.github.io/quant-fund)

A systematic long-only US equity strategy combining fundamental quality and analyst-derived
signals. Monthly rebalancing with dynamic regime-based risk management.

**Backtested Performance (Dec 2005 – Jun 2026, 247 out-of-sample months, net of costs)**

| | Strategy | S&P 500 |
|---|---:|---:|
| CAGR | 13.81% | 11.04% |
| Sharpe Ratio | 0.943 | 0.642 |
| Max Drawdown (month-end) | −18.78% | — |
| Max Drawdown (daily marks) | −25.66% | −55.19% |

Excess return: **+277 bps/yr**. Drawdown is quoted on both bases because month-end sampling
structurally understates it, and both legs of the excess figure are measured over the same
window.

**Live Paper Trading:** July 2026 → Present

## Method

Point-in-time data with no look-ahead and no survivorship bias. Every figure on the dashboard
is computed from a certified walk-forward run — the equity curve, crash windows, sector
history, and monthly returns are all measured, none are illustrative.

The 2011 EU debt crisis is reported even though the strategy underperformed the S&P 500 in
that window. A stress table in which every row wins is not a stress table.

## Files

| File | Purpose |
|---|---|
| `index.html` | The dashboard — a single self-contained file |
| `portfolio_snapshot.json` | Data feed, refreshed from the research pipeline |
| `.github/workflows/pages.yml` | Deploys `main` to GitHub Pages on every push |

*Personal research project. Not investment advice.*

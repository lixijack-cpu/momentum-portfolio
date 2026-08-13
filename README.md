# Systematic Equity Strategy

**Live Dashboard:** [lixijack-cpu.github.io/quant-fund](https://lixijack-cpu.github.io/quant-fund)

A systematic long-only US equity strategy ranking stocks on earnings surprise relative to
analyst consensus (67%) and valuation (33%), combined at selection with an alternative-data
price signal. Monthly rebalancing with dynamic regime-based risk management.

**Backtested Performance (Dec 2005 – Jun 2026, 247 out-of-sample months, net of costs)**

| | Strategy | S&P 500 |
|---|---:|---:|
| CAGR | 14.00% | 11.04% |
| Sharpe Ratio | 0.942 | 0.642 |
| Max Drawdown (month-end) | −19.51% | — |
| Max Drawdown (daily marks) | −26.70% | −55.19% |

Excess return: **+296 bps/yr**. Drawdown is quoted on both bases because month-end sampling
structurally understates it, and both legs of the excess figure are measured over the same
window.

Figures are for the 104-stock institutional model. They reflect the Phase 74 two-factor score
adopted in Aug 2026, which removed an analyst-revision factor that testing showed did not
predict returns. That change improved every measured statistic above but did **not** reach
statistical significance against its predecessor — its bootstrap 95% confidence interval spans
zero — so it should be read as the best-supported configuration measured, not a proven edge.

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

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {harness} = require('./test_dashboard_dom');

(async () => {
  const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, 'institutional_hedged_snapshot.json')));
  const h = await harness('?account=hedged');
  assert.equal(h.run('CFG.label'), 'Hedged [Exp]');
  assert.equal(h.run('CFG.scale'), 1);
  assert.equal(h.run('CFG.base'), 10000);
  assert.equal(h.document.querySelectorAll('#account-tabs .tab').length, 4);
  assert.equal(h.document.getElementById('view-overview').hidden, true);
  assert.equal(h.document.getElementById('view-hedged').hidden, false);
  assert.equal(h.document.getElementById('view-tabs').hidden, false);
  assert.equal(h.document.getElementById('regime-banner').hidden, true);
  assert.equal(h.charts.length, 1, 'hedged has only its forward chart');
  const chart = h.charts[0];
  assert.equal(chart.data.datasets.map(d => d.label).join('|'), 'Hedged [Exp]|S&P 500');
  assert.equal(chart.data.labels.join('|'), snapshot.equity_curve.live.map(p => p.d).join('|'));
  assert.equal(chart.data.datasets[0].data.join('|'), snapshot.equity_curve.live.map(p => p.v).join('|'));
  assert.equal(chart.data.datasets[1].data.join('|'), snapshot.equity_curve.spy.map(p => p.v).join('|'));
  assert.equal(chart.data.datasets[0].data.length, snapshot.live.days_live);
  const signed = v => (v >= 0 ? '+' : '') + (100 * v).toFixed(2) + '%';
  const bps = v => (v >= 0 ? '+' : '') + Math.round(v * 10000) + ' bps';
  assert.equal(h.text('h-ret'), signed(snapshot.live.since_inception_return));
  assert.equal(h.text('h-spy'), signed(snapshot.live.benchmark_return));
  assert.equal(h.text('h-iwm'), signed(snapshot.live.benchmark_return_iwm));
  assert.equal(h.text('h-alpha'), bps(snapshot.live.excess_return));
  assert.ok(h.text('h-iwm-foot').includes(bps(snapshot.live.excess_return_iwm)));
  const window = snapshot.live.inception_date + ' to ' + snapshot.live.last_updated;
  assert.ok(h.text('h-spy-foot').includes(window));
  assert.ok(h.text('hedged-chart-sub').includes(window));
  assert.ok(h.text('h-daily').includes(signed(snapshot.live.daily_return)));
  assert.ok(h.text('h-daily-spy').includes(signed(snapshot.live.benchmark_daily_return)));
  assert.ok(h.text('h-daily-iwm').includes(signed(snapshot.live.benchmark_daily_return_iwm)));
  assert.ok(h.text('hedged-regime').includes(snapshot.regime.sleeve));
  assert.ok(h.text('hedged-regime').includes(snapshot.regime.state.replaceAll('_', ' ').toUpperCase()));
  assert.ok(chart.options.plugins.zoom.zoom.wheel.enabled);
  h.run('setTheme(true); setTheme(false);');
  assert.equal(h.charts.length, 1, 'theme switches reuse the active chart');
  assert.equal(chart.destroyed, undefined);
  assert.ok(fs.statSync(path.join(__dirname, 'institutional_hedged_snapshot.json')).size < 15000);
  assert.ok(h.text('pill-sub').includes('Live (simulated)'));
  assert.ok(h.text('hedged-asof').includes(snapshot.as_of));
  const rendered = h.text('hedged-holdings');
  assert.match(rendered, /Long Equity Book.*Macro ETF Sleeve.*Short Overlay/);
  for (const p of snapshot.holdings.positions) {
    assert.ok(rendered.includes(p.ticker), p.ticker);
    if (p.side === 'SHORT') {
      assert.ok(rendered.includes('SHORT'));
      assert.ok(rendered.includes((p.target_weight * 100).toFixed(2) + '% target'));
      assert.ok(p.value < 0);
    }
  }
  assert.doesNotMatch(rendered, /NaN|undefined|null/);
  // Both the canonical account and its existing alias support journal deep links.
  const alias = await harness('?account=institutional_hedged&view=journal');
  assert.equal(alias.document.getElementById('view-hedged').hidden, true);
  assert.equal(alias.document.getElementById('view-journal').hidden, false);
  assert.equal(alias.document.getElementById('view-tabs').hidden, false);
  assert.ok(alias.text('history-title').includes('Hedged'));
  assert.ok(alias.text('history-book').includes('$10,000'));
  assert.ok(alias.text('history-note').includes('Completed exits and holdings past the 7-day embargo window are fully unmasked'));
  assert.ok(alias.document.getElementById('history-body').children.length > 0);
  for (const account of ['shadow', 'hedged', 'institutional', 'hedged', '']) {
    await h.run(`loadModelData(${JSON.stringify(account)})`);
    assert.equal(h.document.getElementById('view-hedged').hidden, account !== 'hedged');
    assert.equal(h.document.getElementById('view-overview').hidden, account === 'hedged');
    assert.equal(h.document.getElementById('view-tabs').hidden, false);
    assert.equal(h.document.getElementById('view-journal').hidden, true);
  }
  await h.run("setView('journal')");
  for (const account of ['hedged', 'institutional', 'shadow', '', 'hedged']) {
    await h.run(`loadModelData(${JSON.stringify(account)})`);
    assert.equal(h.document.getElementById('view-journal').hidden, false);
    assert.equal(h.document.getElementById('view-hedged').hidden, true);
    assert.equal(h.document.getElementById('view-overview').hidden, true);
    const rowCount = h.document.getElementById('history-body').children.length;
    assert.equal(rowCount > 0, account !== 'shadow', `${account} clears and reloads its rows`);
    assert.doesNotMatch(h.text('history-body'), /NaN|undefined|null/);
  }
  await h.run("setView('overview')");
  assert.equal(h.document.getElementById('view-hedged').hidden, false);
  assert.equal(h.document.getElementById('view-journal').hidden, true);

  // A late hedged response cannot replace a more recently selected book's rows.
  h.run(`const originalFetch = fetch; let finishHistory;
    delete HISTORY_CACHE.hedged;
    fetch = url => String(url).includes('hedged_holdings_history')
      ? new Promise(resolve => { finishHistory = () => originalFetch(url).then(resolve); })
      : originalFetch(url);
    globalThis.pendingHistory = loadHistory('hedged');`);
  await h.run("loadModelData('institutional')");
  await h.run("loadHistory('institutional')");
  const institutionalRows = h.text('history-body');
  await h.run('finishHistory(); pendingHistory');
  assert.equal(h.text('history-body'), institutionalRows);
  assert.ok(h.text('history-book').includes('Institutional'));
  h.run(`fetch = url => String(url).includes('institutional_hedged_snapshot')
      ? new Promise(resolve => { finishHistory = () => originalFetch(url).then(resolve); })
      : originalFetch(url);
    globalThis.pendingModel = loadModelData('hedged');`);
  await h.run("loadModelData('')");
  await h.run('finishHistory(); pendingModel');
  assert.equal(h.run('CFG.label'), 'Retail');
  assert.equal(h.document.getElementById('view-hedged').hidden, true);
  assert.equal(h.errors.length, 0);
  assert.equal(chart.destroyed, true, 'switching accounts destroys the old forward chart');
  assert.equal(h.errors.length, 0);
  console.log('PASS hedged: $10,000 scale, journal deep links, all-account view switching, stale-fetch guard, masked shorts');
})().catch(err => { console.error(err); process.exitCode = 1; });

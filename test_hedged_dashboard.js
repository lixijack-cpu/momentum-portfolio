'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {harness} = require('./test_dashboard_dom');

(async () => {
  const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, 'institutional_hedged_snapshot.json')));
  const h = await harness('?account=hedged');
  assert.equal(h.run('CFG.label'), 'Hedged [Exp]');
  assert.equal(h.document.querySelectorAll('#account-tabs .tab').length, 4);
  assert.equal(h.document.getElementById('view-overview').hidden, true);
  assert.equal(h.document.getElementById('view-hedged').hidden, false);
  assert.equal(h.document.getElementById('view-tabs').hidden, true);
  assert.equal(h.document.getElementById('regime-banner').hidden, true);
  assert.equal(h.charts.length, 0, 'hedged must not borrow another model history');
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
  // Old deep links into a journal must land on the safe metadata view.
  const alias = await harness('?account=institutional_hedged&view=journal');
  assert.equal(alias.document.getElementById('view-hedged').hidden, false);
  assert.equal(alias.document.getElementById('view-journal').hidden, true);
  for (const account of ['shadow', 'hedged', 'institutional', 'hedged', '']) {
    await h.run(`loadModelData(${JSON.stringify(account)})`);
    assert.equal(h.document.getElementById('view-hedged').hidden, account !== 'hedged');
    assert.equal(h.document.getElementById('view-overview').hidden, account === 'hedged');
    assert.equal(h.document.getElementById('view-tabs').hidden, account === 'hedged');
  }
  assert.equal(h.errors.length, 0);
  console.log('PASS hedged: masked shorts, signed values, exposures, aliases and repeated account swaps');
})().catch(err => { console.error(err); process.exitCode = 1; });

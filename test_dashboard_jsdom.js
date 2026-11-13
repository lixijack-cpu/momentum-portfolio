'use strict';
// Run the actual dashboard in a standards-based DOM with offline data/Chart adapters.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const script = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const files = {'': 'portfolio_snapshot.json', institutional: 'institutional_snapshot.json', shadow: 'shadow_snapshot.json'};

async function verify(account, missingDates) {
  const dom = new JSDOM(source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''), {
    url: 'https://dashboard.invalid/' + (account ? '?account=' + account : ''), runScripts: 'outside-only'
  });
  const w = dom.window, errors = [];
  w.console.error = (...args) => errors.push(args.join(' '));
  w.matchMedia = () => ({matches: false, addEventListener() {}});
  w.HTMLCanvasElement.prototype.getContext = function () { return {canvas: this}; };
  w.Chart = class {
    static defaults = {font: {}, animation: {}, plugins: {tooltip: {}}};
    constructor(el, config) { this.data = config.data; this.options = config.options; }
    update() {} destroy() {} resetZoom() {}
  };
  w.fetch = async url => {
    const name = path.basename(url.split('?')[0]);
    assert.match(name, /^[\w-]+\.json$/);
    const payload = JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
    if (missingDates && payload.holdings) {
      for (const key of ['price_as_of', 'last_rebalance', 'target_as_of', 'latest_filing_date']) {
        payload.holdings[key] = null;
      }
    }
    return {ok: true, json: async () => payload};
  };
  w.eval(script.replace('\nboot();', '\nwindow.dashboardTest = {ready: boot(), cards: swapHeroCards, history: loadHistory, metrics: RiskMetrics, renderRisk: renderRiskMetrics};'));
  await w.dashboardTest.ready;
  await w.dashboardTest.history(account);
  const s = JSON.parse(fs.readFileSync(path.join(__dirname, files[account]), 'utf8'));
  for (const id of ['live-quarterly-strip', 'quarterly-body']) {
    assert.ok(w.document.getElementById(id).textContent.trim().length > 0);
    assert.doesNotMatch(w.document.getElementById(id).textContent, /NaN|null|undefined|Annualised|realised/i);
  }
  assert.equal(w.document.querySelectorAll('#quarterly-body tr').length, 8);
  assert.equal(w.document.getElementById('livestats').nextElementSibling.id, 'live-quarterly-strip');
  verifyMetricEdges(w.dashboardTest, s);
  for (const view of ['backtest', 'live']) {
    w.dashboardTest.cards(view);
    assert.equal(w.document.getElementById('hero-live-quarterly').hidden, view === 'backtest');
    assert.doesNotMatch(w.document.body.textContent, /\b(?:null|undefined|NaN)\b/);
    if (account) assert.doesNotMatch(w.document.body.textContent, /buy-and-hold/i);
  }
  for (const id of ['k-sharpe-foot', 'k-dd-foot']) {
    assert.ok(w.document.getElementById(id).textContent.includes(`${s.live.inception_date} to ${s.live.last_updated}`));
  }
  if (missingDates) {
    assert.equal(w.document.getElementById('hold-sub').textContent, '');
    assert.equal(w.document.getElementById('hold-sub').hidden, true);
  }
  assert.deepEqual(errors, []);
  dom.window.close();
  console.log(`PASS jsdom: ${account || 'retail'}; ${missingDates ? 'missing dates hidden' : 'real snapshot'}; no null/NaN/undefined; benchmark windows`);
}

async function verifyHedged() {
  const dom = new JSDOM(source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''), {
    url: 'https://dashboard.invalid/?account=hedged', runScripts: 'outside-only'
  });
  const w = dom.window, errors = [];
  w.console.error = (...args) => errors.push(args.join(' '));
  w.matchMedia = () => ({matches: false, addEventListener() {}});
  const charts = [];
  w.Chart = class {
    static defaults = {font: {}, animation: {}, plugins: {tooltip: {}}};
    constructor(_el, config) { this.data = config.data; this.options = config.options; charts.push(this); }
    update() {} destroy() { this.destroyed = true; } resetZoom() { this.reset = true; }
  };
  w.fetch = async url => ({ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(__dirname, path.basename(url.split('?')[0])), 'utf8'))});
  w.eval(script.replace('\nboot();', '\nwindow.dashboardTest = {metrics: RiskMetrics, renderRisk: renderRiskMetrics}; window.ready = boot();'));
  await w.ready;
  assert.deepEqual(errors, []);
  assert.equal(w.document.getElementById('view-hedged').hidden, false);
  assert.equal(w.document.getElementById('view-overview').hidden, true);
  const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, 'institutional_hedged_snapshot.json')));
  const risk = w.document.getElementById('hedged-quarterly');
  assert.ok(risk.textContent.trim().length > 0);
  const actualRisk = w.dashboardTest.metrics.getPerformanceMetrics(snapshot);
  assert.ok(risk.textContent.includes(actualRisk.current.label));
  assert.match(risk.textContent, /Live \(simulated\)/);
  assert.doesNotMatch(risk.textContent, /paper account/i);
  assert.doesNotMatch(risk.textContent, /NaN|null|undefined|Annualised|realised/i);
  const values = () => [...risk.querySelectorAll('.v')].map(e => e.textContent);
  // Freeze a four-mark example so this guard stays tested after nightly refreshes.
  const short = structuredClone(snapshot);
  short.monthly_returns = [];
  short.equity_curve.live = [{d:'2026-11-10',v:10000},{d:'2026-11-11',v:10057.9},
    {d:'2026-11-12',v:10038.21},{d:'2026-11-13',v:10053.1}];
  short.as_of = short.live.last_updated = '2026-11-13';
  short.live.inception_date = '2026-11-10';short.live.inception_nav = 10000;short.live.rebase_factor = 1;
  short.equity_curve.spy = [{d:'2026-11-10',v:10000},{d:'2026-11-13',v:10059.34}];
  w.dashboardTest.renderRisk(short);
  assert.match(risk.textContent, /Needs ≥15 sessions/);
  assert.match(risk.textContent, /4 sessions · 3 daily returns/);
  assert.deepEqual(values(), ['+0.53%', '—', '-0.20%', '+0.53%', '—', '-0.20%']);
  assert.match(risk.textContent, /Sortino — · Realized Vol —/);
  // A new weekday mark automatically enables all annualized metrics at n=15.
  const extended = structuredClone(short);
  let date = new Date(extended.equity_curve.live.at(-1).d + 'T00:00:00Z');
  while (extended.equity_curve.live.length < 17) {
    date.setUTCDate(date.getUTCDate() + 1);
    if ([0, 6].includes(date.getUTCDay())) continue;
    const v = extended.equity_curve.live.at(-1).v * (extended.equity_curve.live.length % 3 ? 1.004 : .997);
    extended.equity_curve.live.push({d: date.toISOString().slice(0,10), v});
  }
  extended.as_of = extended.live.last_updated = extended.equity_curve.live.at(-1).d;
  extended.live.benchmark_return = null; // No benchmark was observed for the synthetic extension.
  w.dashboardTest.renderRisk(extended);
  const computed = w.dashboardTest.metrics.getPerformanceMetrics(extended);
  assert.equal(computed.live.n, 16);
  assert.equal(values()[1], computed.current.sharpe.toFixed(2));
  assert.equal(values()[4], computed.live.sharpe.toFixed(2));
  assert.match(risk.textContent, new RegExp('Sortino ' + computed.live.sortino.toFixed(2).replace('.', '\\.')));
  assert.ok(Number.isFinite(computed.live.vol));
  assert.doesNotMatch(risk.textContent, /Needs ≥15|NaN|null|undefined|Annualised|realised/i);
  // SPY still ends on Nov 13: extending strategy marks cannot extend its comparison.
  assert.equal(computed.current.spy, null);
  assert.equal(computed.live.spy, null);
  w.dashboardTest.renderRisk(snapshot);
  const signed = v => (v >= 0 ? '+' : '') + (100 * v).toFixed(2) + '%';
  for (const [id, field] of [['h-ret', 'since_inception_return'], ['h-spy', 'benchmark_return'], ['h-iwm', 'benchmark_return_iwm']]) {
    assert.equal(w.document.getElementById(id).textContent, signed(snapshot.live[field]));
  }
  assert.match(w.document.getElementById('h-alpha').textContent, /^[+-]\d+ bps$/);
  assert.equal(charts.length, 1);
  assert.equal(charts[0].data.datasets.length, 2);
  assert.equal(charts[0].data.datasets[0].data.length, snapshot.live.days_live);
  assert.ok(w.document.getElementById('hedged-canvas'));
  w.document.getElementById('hedged-reset').click();
  assert.equal(charts[0].reset, true);
  w.document.getElementById('theme-toggle').click();
  assert.deepEqual(errors, []);
  const shorts = w.document.querySelectorAll('.short-badge');
  assert.ok(shorts.length > 0);
  for (const badge of shorts) {
    const row = badge.closest('tr');
    assert.match(row.textContent, /SHORT/);
    assert.match(row.querySelector('td:nth-child(3)').textContent, /-\d/);
    assert.match(row.querySelector('td:nth-child(4)').textContent, /-\$\d/);
  }
  assert.doesNotMatch(w.document.getElementById('view-hedged').textContent, /NaN|undefined|null/);
  w.document.querySelector('[data-view="journal"]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.document.getElementById('view-tabs').hidden, false);
  assert.equal(w.document.getElementById('view-journal').hidden, false);
  assert.equal(w.document.getElementById('view-hedged').hidden, true);
  const journal = w.document.getElementById('history-body');
  assert.ok(journal.children.length > 0);
  assert.doesNotMatch(journal.textContent, /NaN|undefined|null/);
  for (const ticker of ['UUP', 'GLD', 'SH']) {
    const row = [...journal.children].find(r => r.querySelector('.ticker-cell').textContent === ticker);
    assert.ok(row, `Macro ETF ${ticker} is disclosed`);
    assert.match(row.textContent, /BUY/);
  }
  for (const lock of ['LOCKED-#1', 'LOCKED-SHORT-#1']) {
    const row = [...journal.children].find(r => r.querySelector('.ticker-cell').textContent.startsWith(lock));
    assert.ok(row, `${lock} appears in journal`);
    for (const index of [3, 4, 5, 6, 7, 9]) assert.equal(row.children[index].textContent, '—');
  }
  w.document.querySelector('[data-view="overview"]').click();
  assert.equal(w.document.getElementById('view-hedged').hidden, false);
  assert.equal(w.document.getElementById('view-journal').hidden, true);
  assert.deepEqual(errors, []);
  dom.window.close();
  console.log('PASS jsdom: hedged overview and journal, macro disclosure, masked values, SHORT badges');
}

function verifyMetricEdges(api, snapshot) {
  const m = api.metrics, before = JSON.stringify(snapshot);
  const live = m.getLiveSeries(snapshot);
  assert.ok(live.every(p => ![0,6].includes(new Date(p.d+'T00:00:00Z').getUTCDay())));
  const retail = snapshot.live.inception_date === '2026-07-27';
  assert.equal(!!live[0].syntheticAnchor, retail);
  if (retail) {
    assert.equal(live[0].d,live[1].d);
    assert.equal(live[0].v,snapshot.live.inception_nav);
    assert.ok(live[1].v < live[0].v, 'opening-day loss remains observable');
  }
  // Zero deviation and a zero-length window stay finite or unavailable.
  const flat = Array.from({length: 17}, (_,i)=>({d:String(i),v:100}));
  const constant = m.computeWindowMetrics(flat);
  assert.equal(constant.vol,0);assert.equal(constant.sharpe,null);assert.equal(constant.sortino,null);
  assert.equal(m.computeWindowMetrics([]).ret,null);
  const varied = flat.map((p,i)=>({...p,v:100 + i + (i%2 ? 2 : -2)}));
  for (const n of [14,15,16]) {
    const result = m.computeWindowMetrics(varied.slice(0,n+1));
    for (const field of ['sharpe','sortino','vol']) {
      if (n<15) assert.equal(result[field],null); else assert.ok(Number.isFinite(result[field]));
    }
  }
  const q3 = m.getQuarterMetrics(snapshot,'2026-Q3');
  assert.equal(q3.start,snapshot.live.inception_date);
  assert.equal(q3.partial,true);
  assert.equal(q3.basis,'live');
  const changed = structuredClone(snapshot);
  // A huge simulation-end jump and weekend NAV cannot affect live quarter risk.
  changed.equity_curve.simulation.at(-1).v *= 100;
  changed.equity_curve.live.push({d:'2026-09-19',v:1});
  changed.equity_curve.live.reverse();
  assert.equal(JSON.stringify(m.getQuarterMetrics(changed,'2026-Q3')),JSON.stringify(q3));
  assert.equal(m.getQuarterMetrics(snapshot,'2025-Q4').basis,'backtest');
  // Incomplete months use daily endpoints for both sides, without stale SPY tails.
  changed.monthly_returns = changed.monthly_returns.filter(r=>r.month!=='2026-10');
  const missing = m.getQuarterMetrics(changed,'2026-Q4');
  assert.equal(missing.retBasis,'daily');assert.equal(missing.spy,null);
  const noSpy = structuredClone(snapshot);
  noSpy.monthly_returns.find(r=>r.month==='2026-10').spy = null;
  assert.equal(m.getQuarterMetrics(noSpy,'2026-Q4').spy,null);
  const q2 = m.getQuarterMetrics(snapshot,'2026-Q2');
  assert.equal(q2.start,'2026-03-31');assert.equal(q2.end,'2026-06-30');
  assert.equal(q2.basis,'simulation');assert.ok(Number.isFinite(q2.spy));
  // Rebased chart scales cannot change any live risk statistic.
  const scaled = structuredClone(snapshot);
  scaled.equity_curve.live.forEach(p=>p.v*=10);
  scaled.live.rebase_factor*=10;
  const scaledMetrics = m.computeWindowMetrics(m.getLiveSeries(scaled)), original = m.computeWindowMetrics(live);
  for(const field of ['ret','sharpe','sortino','vol','maxDD'])assert.ok(Math.abs(scaledMetrics[field]-original[field])<1e-10);
  assert.equal(JSON.stringify(snapshot),before,'pure helpers do not mutate snapshots');
}

(async () => {
  await verifyHedged();
  for (const account of Object.keys(files)) {
    await verify(account, false);
    await verify(account, true);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

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
  w.eval(script.replace('\nboot();', '\nwindow.dashboardTest = {ready: boot(), cards: swapHeroCards, history: loadHistory};'));
  await w.dashboardTest.ready;
  await w.dashboardTest.history(account);
  const s = JSON.parse(fs.readFileSync(path.join(__dirname, files[account]), 'utf8'));
  for (const view of ['backtest', 'live']) {
    w.dashboardTest.cards(view);
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
  w.Chart = class { static defaults = {font: {}, animation: {}, plugins: {tooltip: {}}}; };
  w.fetch = async url => ({ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(__dirname, path.basename(url.split('?')[0])), 'utf8'))});
  w.eval(script.replace('\nboot();', '\nwindow.ready = boot();'));
  await w.ready;
  assert.deepEqual(errors, []);
  assert.equal(w.document.getElementById('view-hedged').hidden, false);
  assert.equal(w.document.getElementById('view-overview').hidden, true);
  const shorts = w.document.querySelectorAll('.short-badge');
  assert.ok(shorts.length > 0);
  for (const badge of shorts) {
    const row = badge.closest('tr');
    assert.match(row.textContent, /SHORT/);
    assert.match(row.querySelector('td:nth-child(3)').textContent, /-\d/);
    assert.match(row.querySelector('td:nth-child(4)').textContent, /-\d/);
  }
  assert.doesNotMatch(w.document.getElementById('view-hedged').textContent, /NaN|undefined|null/);
  dom.window.close();
  console.log('PASS jsdom: hedged short badges, negative weights/values, isolated metadata view');
}

(async () => {
  await verifyHedged();
  for (const account of Object.keys(files)) {
    await verify(account, false);
    await verify(account, true);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

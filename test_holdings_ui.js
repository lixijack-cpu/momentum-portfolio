#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const indexPath = path.join(__dirname, 'index.html');
const source = fs.readFileSync(indexPath, 'utf8');
const start = source.indexOf('function renderHoldings(s) {');
const end = source.indexOf('\nfunction renderSectorConviction(s) {', start);
assert.notEqual(start, -1, 'renderHoldings is missing from index.html');
assert.notEqual(end, -1, 'renderHoldings boundary is missing from index.html');

const rendererSource = source.slice(start, end);
assert.match(
  rendererSource,
  /const positions = s\?\.holdings\?\.positions;/,
  'Current Portfolio must bind positions from holdings.positions',
);
assert.doesNotMatch(
  rendererSource,
  /sector_conviction/,
  'Current Portfolio must never read sector_conviction',
);

class FakeElement {
  constructor({fragment = false} = {}) {
    this.fragment = fragment;
    this.children = [];
    this.style = {};
    this.hidden = false;
    this._innerHTML = '';
    this.textContent = '';
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    if (value === '') this.children = [];
  }

  appendChild(child) {
    if (child.fragment) this.children.push(...child.children);
    else this.children.push(child);
    return child;
  }

  addEventListener() {}
}

const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, new FakeElement());
  return elements.get(id);
};
const money = value => '$' + Math.round(value).toLocaleString('en-US');
const money2 = value => '$' + value.toLocaleString('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const escapes = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};

const context = vm.createContext({
  CFG: {scale: 1, base: 10_000},
  document: {
    getElementById: element,
    createDocumentFragment: () => new FakeElement({fragment: true}),
    createElement: () => new FakeElement(),
  },
  money,
  money2,
  signedPct: value => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`,
  pct: (value, places = 2) => `${(value * 100).toFixed(places)}%`,
  esc: value => String(value == null ? '' : value).replace(/[&<>"']/g, char => escapes[char]),
  sectorColors: () => ['#111111', '#222222', '#333333'],
  token: () => '#999999',
});
vm.runInContext(rendererSource, context, {filename: 'index.html#renderHoldings'});

const position = (ticker, name, sector, weight, value, shares, price, rationale) => ({
  ticker,
  name,
  sector,
  weight,
  value,
  shares,
  price,
  rationale,
});

const fixture = {
  holdings: {
    as_of: '2026-09-15',
    price_as_of: '2026-09-15',
    last_rebalance: '2026-05-31',
    target_as_of: '2026-09-15',
    latest_filing_date: '2026-08-06',
    positions: [
      position('FAF', 'First American Financial', 'Finance', 0.10934, 1097.25, 15, 73.15, 'Funded holding one'),
      position('NGVT', 'Ingevity Corp', 'Chemicals', 0.108817, 1088.17, 20, 54.41, 'Funded holding two'),
      position('MLI', 'Mueller Industries', 'Manufacturing', 0.101642, 1016.42, 17, 59.79, 'Funded holding three'),
    ],
  },
  sector_history: {sectors: ['Finance', 'Chemicals', 'Manufacturing']},
  sector_conviction: {
    Business: [{ticker: 'ZBRA', name: 'Zebra Technologies'}],
    Technology: [{ticker: 'MU', name: 'Micron Technology'}],
    Healthcare: [{ticker: 'KVUE', name: 'Kenvue'}],
  },
  live: {nav: 10_000, since_inception_return: 0.01, days_live: 42},
};

context.renderHoldings(fixture);

assert.equal(
  element('hold-sub').textContent,
  'Priced as of 2026-09-15 · Target rebalance date 2026-05-31 · Model scan 2026-09-15 · Latest SEC filing 2026-08-06',
);

const rows = element('holdings').children;
assert.equal(rows.length, 3);
const rowHtml = rows.map(row => row.innerHTML);
const tickers = rowHtml.map(html => html.match(/<div class="tkr">([^<]+)<\/div>/)[1]);
assert.deepEqual(tickers, ['FAF', 'NGVT', 'MLI']);
assert.ok(rowHtml[0].includes('First American Financial'));
assert.ok(rowHtml[0].includes('Finance'));
assert.ok(rowHtml[0].includes('10.9%'));
assert.ok(rowHtml[0].includes('15 shares'));
assert.ok(rowHtml[0].includes('$73.15 price'));
assert.ok(rowHtml[0].includes('$1,097.25 value'));
assert.ok(rowHtml[0].includes('Funded holding one'));
assert.doesNotMatch(rowHtml.join('\n'), /ZBRA|MU|KVUE/);

assert.throws(
  () => context.renderHoldings({sector_conviction: fixture.sector_conviction}),
  /snapshot\.holdings\.positions must be an array/,
  'sector conviction must never be accepted as a holdings fallback',
);
const missingPrice = structuredClone(fixture);
delete missingPrice.holdings.positions[0].price;
assert.throws(
  () => context.renderHoldings(missingPrice),
  /holdings\.positions\[0\]\.price must be a finite number/,
  'every displayed position must satisfy the holdings position schema',
);

// Institutional book (target weights, shares: null)
const instFixture = structuredClone(fixture);
instFixture.holdings.positions = [
  position('BMY', 'Bristol Myers Squibb Co', 'Healthcare', 0.00864, 92.29, null, 61.12, 'Fundamental signal'),
];
context.CFG = {scale: 500, base: 5_000_000};
context.renderHoldings(instFixture);
const instRows = element('holdings').children;
assert.equal(instRows.length, 1);
assert.ok(instRows[0].innerHTML.includes('$61.12 price'));
assert.ok(instRows[0].innerHTML.includes('$46,145.00 value'));
assert.ok(!instRows[0].innerHTML.includes('shares'));

// Shadow book (target weights, shares: null, price: null)
const shadowFixture = structuredClone(fixture);
shadowFixture.holdings.positions = [
  position('KO', 'Coca Cola Co', 'Consumer NonDurables', 0.039674, 401.71, null, null, 'Selected by quantitative model'),
];
context.CFG = {scale: 500, base: 5_000_000};
context.renderHoldings(shadowFixture);
const shadowRows = element('holdings').children;
assert.equal(shadowRows.length, 1);
assert.ok(shadowRows[0].innerHTML.includes('$200,855.00 value'));
assert.ok(!shadowRows[0].innerHTML.includes('shares'));
assert.ok(!shadowRows[0].innerHTML.includes('price'));

shadowFixture.holdings.price_as_of = null;
context.renderHoldings(shadowFixture);
assert.match(element('hold-sub').textContent, /Position price date unavailable; prices omitted/);
instFixture.holdings.price_as_of = '2026-09-14';
context.renderHoldings(instFixture);
assert.match(element('hold-sub').textContent, /Priced as of 2026-09-14/);
assert.doesNotMatch(source, /remarked at each monthly rebalance|only updated monthly/);

// Reset CFG
context.CFG = {scale: 1, base: 10_000};

console.log('ok: Current Portfolio renders FAF, NGVT, MLI from holdings.positions only');

const historyStart = source.indexOf('const HISTORY_PAGE = 250;');
const historyEnd = source.indexOf('\nfunction populateHistoryMonths()', historyStart);
assert.notEqual(historyStart, -1, 'Trade Journal helpers are missing from index.html');
assert.notEqual(historyEnd, -1, 'Trade Journal helper boundary is missing from index.html');

const historySource = source.slice(historyStart, historyEnd);
assert.match(
  historySource,
  /rows\.filter\(r => r\.status === 'IN' \|\| r\.status === 'OUT'\)/,
  'Trade Journal must include IN and OUT rows explicitly',
);

const historyElements = new Map();
const historyElement = id => {
  if (!historyElements.has(id)) historyElements.set(id, new FakeElement());
  return historyElements.get(id);
};
historyElement('history-month').value = '';
historyElement('history-ticker').value = '';

const historyContext = vm.createContext({
  document: {
    getElementById: historyElement,
    createDocumentFragment: () => new FakeElement({fragment: true}),
    createElement: () => new FakeElement(),
  },
  money2,
  esc: context.esc,
});
vm.runInContext(historySource, historyContext, {filename: 'index.html#TradeJournal'});

const tradeFixtureRows = [
  {
    date: '2026-09-02', ticker: 'QLYS', shares: 5, price: 177.01,
    value: 885.05, ret: 0, pnl: 0, status: 'IN',
  },
  {
    date: '2026-09-03', ticker: 'QLYS', shares: 6, price: 174.35,
    value: 1046.10, ret: -1.5, pnl: -13.30, status: 'HOLD',
  },
  {
    date: '2026-09-10', ticker: 'QLYS', shares: 6, price: 161.57,
    value: 969.42, ret: -5.14, pnl: -52.68, status: 'OUT',
  },
];
for (let i = 1; i <= 17; i += 1) {
  tradeFixtureRows.push({
    date: `2026-08-${String(i).padStart(2, '0')}`,
    ticker: `EXIT${String(i).padStart(2, '0')}`,
    shares: i,
    price: 100 + i,
    value: i * (100 + i),
    ret: -i / 10,
    pnl: -i,
    status: 'OUT',
  });
}

const tradeFixture = {live_daily: {}};
const historyFields = {
  dates: 'date', tickers: 'ticker', shares: 'shares', prices: 'price', values: 'value',
  daily_return_pct: 'ret', daily_pnl: 'pnl', status: 'status',
};
for (const [arrayName, field] of Object.entries(historyFields)) {
  tradeFixture.live_daily[arrayName] = tradeFixtureRows.map(row => row[field]);
}
historyContext.tradeFixture = tradeFixture;
vm.runInContext(
  'const decoded = decodeHistory(tradeFixture);'
    + ' historyRows = decoded.rows; historyRows.isWeight = decoded.isWeight; renderHistory();',
  historyContext,
);

const historyHtml = historyElement('history-body').children.map(row => row.innerHTML);
assert.equal(historyHtml.length, 19, 'one BUY and 18 SELL rows should be visible');
assert.equal(historyHtml.filter(html => html.includes('>SELL</span>')).length, 18);
assert.equal(historyHtml.filter(html => html.includes('>BUY</span>')).length, 1);
assert.doesNotMatch(historyHtml.join('\n'), />HOLD<|status-hold/);

const qlysRows = historyHtml.filter(html => html.includes('>QLYS</td>'));
assert.equal(qlysRows.length, 2, 'QLYS BUY and SELL must both be displayed');
assert.ok(qlysRows.some(html => html.includes('2026-09-02') && html.includes('status-in">BUY')));
assert.ok(qlysRows.some(html => html.includes('2026-09-10') && html.includes('status-out">SELL')));

console.log('ok: Trade Journal renders QLYS BUY/SELL, 18 SELL rows, and excludes HOLD');

// A weight-only book publishes no contribution. Its journal must show "—", not a
// fabricated 0.00 pp accumulated from nulls.
historyContext.weightFixture = {live_daily: {
  dates: ['2026-09-30', '2026-10-01', '2026-10-02'],
  tickers: ['NULLPNL', 'NULLPNL', 'NULLPNL'],
  target_weight: [0.01, 0.01, 0.01],
  prices: [50, 51, null],
  daily_return_pct: [null, null, null],
  contribution_pp: [null, null, null],
  status: ['IN', 'HOLD', 'OUT'],
}};
vm.runInContext(
  'const decodedW = decodeHistory(weightFixture);'
    + ' historyRows = decodedW.rows; historyRows.isWeight = decodedW.isWeight; renderHistory();',
  historyContext,
);
const weightHtml = historyElement('history-body').children.map(row => row.innerHTML).join('\n');
assert.match(weightHtml, /NULLPNL/);
assert.doesNotMatch(weightHtml, /0\.00 pp/, 'null contributions must not render as 0.00 pp');
assert.ok(vm.runInContext('decodedW.rows.every(r => r.cumPnl === null)', historyContext));

console.log('ok: Trade Journal leaves cumulative contribution blank when none is published');

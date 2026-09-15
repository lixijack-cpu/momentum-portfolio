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
  'Priced as of 2026-09-15 · Last rebalance 2026-05-31 · Model scan 2026-09-15 · Latest SEC filing 2026-08-06',
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

console.log('ok: Current Portfolio renders FAF, NGVT, MLI from holdings.positions only');

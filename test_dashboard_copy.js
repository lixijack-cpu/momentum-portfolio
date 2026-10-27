#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {harness,normalize}=require('./test_dashboard_dom');
const files={'':'portfolio_snapshot.json',institutional:'institutional_snapshot.json',shadow:'shadow_snapshot.json'};
const snapshots=Object.fromEntries(Object.entries(files).map(([a,f])=>[a,JSON.parse(fs.readFileSync(path.join(__dirname,f),'utf8'))]));
const pct=(v,n=2)=>(v*100).toFixed(n)+'%';
const signed=(v,n=2)=>(v>=0?'+':'')+pct(v,n);
const dollars=(v,dp=0)=>'$'+v.toLocaleString('en-US',{minimumFractionDigits:dp,maximumFractionDigits:dp});
const range=(rows,key='d')=>`${rows[0][key]} to ${rows.at(-1)[key]}`;
const label=account=>account ? 'Live (simulated)' : 'Live (paper account)';
const includes=(text,expected,where)=>assert.ok(text.includes(expected),`${where}: expected ${JSON.stringify(expected)} in ${JSON.stringify(text)}`);

function inspectStrings(h) {
  // Static HTML whitespace collapses in a browser. Direct text writes and tooltip/
  // accessibility strings are checked before normalization, so doubled spaces fail.
  for(const {id,text} of h.writes) {
    assert.doesNotMatch(text,/\b(?:undefined|NaN|null)\b/,id);
    assert.doesNotMatch(text,/ {2,}/,`double spaces in #${id}`);
  }
  function walk(el) {
    if(el.tagName==='#text') {
      assert.doesNotMatch(normalize(el.textContent),/\b(?:undefined|NaN|null)\b/);
    }
    for(const [key,value] of Object.entries(el.attributes)) if(['title','aria-label','placeholder','content'].includes(key)) {
      assert.doesNotMatch(value,/\b(?:undefined|NaN|null)\b| {2,}/,`${el.tagName} ${key}`);
    }
    el.children.forEach(walk);
  }
  walk(h.document);
  assert.doesNotMatch(normalize(h.document.body.textContent),/Annualised|colours?|realised|104-stock|10-Stock|607 bps|296 bps|no live capital/i);
  includes(normalize(h.document.getElementById('ftr').textContent),'No real capital is deployed.','footer');
}

async function verify(h,account,s) {
  const sim=!!account, scale=sim?500:1, live=s.live, head=s.headline, n=s.holdings.positions.length;
  const type=label(account), name=sim?account[0].toUpperCase()+account.slice(1):'Retail';
  assert.equal(live.days_live,s.equity_curve.live.length,'session count must count published daily marks');
  if(account==='institutional') assert.equal(new Set(s.holdings.positions.map(p=>p.weight)).size,1,'equal-weighted copy requires equal target weights');
  assert.equal(h.run('CFG.label'),name);
  includes(h.text('model-description'),`${n} ${sim?'model target names':'paper-account holdings'}`,'model count');
  includes(h.text('about-book'),`${n} ${sim?'model target names':'paper-account holdings'}`,'about count');
  const tab=h.document.querySelectorAll('#account-tabs .tab').find(t=>t.dataset.account===account);
  assert.equal(tab.querySelector('.count').textContent,`${n} names`);

  const metrics=h.text('about-metrics');
  for(const value of [pct(head.cagr)+' CAGR','Sharpe '+head.sharpe.toFixed(3),`${head.excess_vs_spy_bps>=0?'+':''}${head.excess_vs_spy_bps} bps/yr`,
    `${pct(head.max_drawdown,1)} max drawdown (${head.max_drawdown_basis})`,`${pct(head.max_drawdown_daily,1)} max drawdown (daily marks)`]) includes(metrics,value,'about metric');
  includes(h.text('about-method'),`${head.months_oos} out-of-sample months (${head.window_start} to ${head.window_end})`,'headline window');
  for(const key of ['backtest','simulation','live']) includes(h.text('curve-sub'),range(s.equity_curve[key]),`${key} chart range`);
  includes(h.text('curve-sub'),`strategy start ${head.window_start}`,'strategy start');
  const chart=h.charts.at(-2);
  assert.deepEqual(chart.data.datasets.map(d=>d.label).join('|'),`S&P 500|Walk-forward backtest|2026 simulation|${type}`);
  includes(h.text('curve-title'),dollars(live.inception_nav*scale),'chart base');
  includes(h.text('rebase-note'),dollars(live.inception_nav),'unscaled starting NAV');
  if(sim) includes(h.text('rebase-note'),dollars(live.inception_nav*scale),'display notional');

  h.run("swapHeroCards('backtest')");
  assert.equal(h.text('k-cagr'),pct(head.cagr));
  assert.equal(h.text('k-sharpe'),head.sharpe.toFixed(3));
  assert.equal(h.text('k-dd'),pct(head.max_drawdown,1));
  includes(h.text('k-dd-label'),head.max_drawdown_basis,'drawdown label');
  includes(h.text('k-dd-foot'),pct(head.max_drawdown_daily,1)+' on daily marks','daily drawdown');
  includes(h.text('k-cagr-foot'),pct(head.benchmark_cagr),'benchmark CAGR');
  includes(h.text('k-sharpe-foot'),head.benchmark_sharpe.toFixed(3),'benchmark Sharpe');
  includes(h.text('k-edge-foot'),pct(head.benchmark_max_drawdown,1)+' (daily marks)','benchmark drawdown');
  includes(h.text('k-edge'),String(head.excess_vs_spy_bps),'historical excess');
  h.run("swapHeroCards('live')");
  if(live.benchmark_return!=null) {
    assert.equal(h.text('k-cagr'),signed(live.since_inception_return));
    assert.equal(h.text('k-sharpe'),signed(live.benchmark_return));
    assert.equal(h.text('k-dd'),live.benchmark_return_iwm!=null?signed(live.benchmark_return_iwm):'—');
    includes(h.text('k-cagr-foot'),dollars(live.nav,2),'live hero source NAV');
    if(sim) includes(h.text('k-cagr-foot'),'Source NAV','unscaled source NAV label');
    includes(h.text('k-cagr-foot'),`Live start ${live.inception_date}`,'live start');
    includes(h.text('k-sharpe-foot'),`${Math.round(live.excess_return*10000)} bps`,'SPY return difference');
    if(live.excess_return_iwm!=null) includes(h.text('k-dd-foot'),`${Math.round(live.excess_return_iwm*10000)} bps`,'IWM return difference');
    assert.equal(h.text('k-edge'),`${live.days_live} trading sessions`);
    const banner=h.text('live-context-banner');
    for(const v of [name,type,`${n} ${sim?'target names':'holdings'}`,live.inception_date,live.last_updated,head.window_start,head.window_end,`${head.months_oos} out-of-sample months`,pct(head.cagr),head.sharpe.toFixed(3),String(head.excess_vs_spy_bps),pct(head.max_drawdown,1),pct(head.max_drawdown_daily,1)]) includes(banner,v,'live banner');
  }
  includes(h.text('pill-nav'),dollars(live.nav*scale,2),'pill NAV');
  includes(h.text('pill-sub'),type,'pill type');
  includes(h.text('pill-sub'),`${live.days_live} trading sessions`,'pill sessions');
  includes(h.text('pill-sub'),s.as_of,'pill mark');
  assert.equal(h.text('l-nav'),dollars(live.nav*scale,2));
  assert.equal(h.text('l-ret'),signed(live.since_inception_return));
  assert.equal(h.text('l-days'),String(live.days_live));
  if(sim) for(const id of ['l-nav-k','l-ret-k','l-days-k']) includes(h.text(id),'Live (simulated)',id);

  const historical=s.monthly_returns.filter(r=>r.month<=head.window_end.slice(0,7));
  const liveMonths=s.monthly_returns.filter(r=>r.month>head.window_end.slice(0,7));
  for(const expected of [range(s.monthly_returns,'month'),`${historical.length} historical months`,range(historical,'month'),`${liveMonths.length} ${type} months`,range(liveMonths,'month')]) includes(h.text('heat-sub'),expected,'heatmap split');
  for(const partial of s.monthly_returns.filter(r=>r.partial)) includes(h.text('heat-sub'),partial.month,'partial month');
  const heatTitles=h.document.getElementById('heat-grid').querySelectorAll('[title]').map(el=>el.title);
  for(const month of s.monthly_returns) {
    const stage=month.month<=s.equity_curve.backtest.at(-1).d.slice(0,7) ? 'Walk-forward backtest'
      : month.month<=head.window_end.slice(0,7) ? '2026 simulation' : type;
    const note=stage+(month.partial?'; partial month':'');
    for(const [series,key] of [['Portfolio','strategy'],['S&P 500','spy']]) {
      if(month[key]!=null) assert.ok(heatTitles.includes(`${series} · ${month.month} (${note}): ${signed(month[key])}`),`${series} tooltip ${month.month}`);
    }
  }
  includes(h.text('sector-sub'),`${s.sector_history.months[0]} to ${s.sector_history.months.at(-1)}`,'sector range');
  includes(h.text('sector-sub'),'reference configuration','sector provenance');
  if(s.regime) {
    includes(h.text('rb-asof'),s.regime.as_of,'regime source date');
    assert.equal(h.text('rb-exposure'),`${+(s.regime.gross_exposure*100).toFixed(1)}% target exposure`);
    assert.equal(h.text('rb-eq-wt'),Math.round(s.regime.equity_weight*100)+'%');
    assert.equal(h.text('rb-macro-wt'),Math.round(s.regime.macro_etf_weight*100)+'%');
  }
  for(const r of s.crash_table) for(const v of [r.period,pct(r.strategy,1),pct(r.spy,1),r.edge_pp.toFixed(1)+'pp']) includes(h.text('crash-body'),v,'stress-window value');
  for(const r of s.crash_table) for(const k of ['strategy_max_drawdown_monthly','spy_max_drawdown_monthly']) if(r[k]!=null) includes(h.text('crash-body'),pct(r[k],1),'month-end stress-window value');
  const locked=s.holdings.positions.filter(p=>/^LOCKED-#\d+$/.test(p.ticker));
  for(const p of locked) { assert.equal(p.price,null,p.ticker+' price'); assert.equal(p.shares,null,p.ticker+' shares'); }
  if(locked.length) includes(h.text('hold-disclaimer'),'Active positions are embargoed for 30 days to protect live execution','embargo note');

  // All position rows, including collapsed ones, must retain prices/nulls and values.
  h.document.getElementById('holdings').querySelector('.show-all')?.click();
  const rows=h.document.getElementById('holdings').querySelectorAll('.holding');
  assert.equal(rows.length,n);
  for(const p of s.holdings.positions) {
    const row=rows.find(r=>r.querySelector('.tkr').textContent===p.ticker); assert.ok(row,p.ticker);
    includes(normalize(row.textContent),dollars(p.value*scale,2)+' value',p.ticker);
    if(p.shares===null) assert.doesNotMatch(row.textContent,/\bshares\b/);
    if(p.price===null) assert.doesNotMatch(row.textContent,/\bprice\b/);
    else includes(normalize(row.textContent),dollars(p.price,2)+' price',p.ticker);
  }
  if(s.holdings.price_as_of) includes(h.text('hold-sub'),s.holdings.price_as_of,'price date');
  else includes(h.text('hold-sub'),'price date unavailable; prices omitted','missing price date');

  // Chart labels, callback output, and empty states are user-visible copy too.
  for(const dataset of chart.data.datasets) {
    const point=dataset.data.at(-1);
    const tip=chart.options.plugins.tooltip.callbacks.label({dataset,parsed:point});
    assert.equal(tip,`${dataset.label}: ${dollars(point.y)}`);
    assert.doesNotMatch(tip,/undefined|NaN|null| {2,}/);
  }
  const missing=chart.options.plugins.tooltip.callbacks.afterBody([{dataset:{label:type},parsed:{x:0,y:1}}]);
  assert.equal(missing,'S&P 500 comparison unavailable for this date');
  await h.run(`loadHistory(${JSON.stringify(account)})`);
  if(sim) {
    for(const id of ['model-description','view-overview','view-journal','pill-sub']) assert.doesNotMatch(h.text(id),/\bretail\b|10-Stock|\bfunded\b/i,id);
    assert.doesNotMatch(h.text('history-body'),/\bBUY\b|\bSELL\b/);
  }
  for(const name of ['EMPTY_NO_DATA','EMPTY_SHADOW','EMPTY_FILTER','EMPTY_ERROR']) {
    const raw=h.run(name); assert.match(raw,/<\/strong> /,name+' sentence spacing');
  }
  inspectStrings(h);
  assert.equal(h.errors.length,0);
}

(async()=>{
  const before=Object.fromEntries(Object.values(files).map(f=>[f,fs.readFileSync(path.join(__dirname,f),'utf8')]));
  for(const account of Object.keys(files)) {
    const h=await harness(account?'?account='+account:'');
    await verify(h,account,snapshots[account]);
    console.log(`ok: ${account||'retail'} — real snapshot, both hero views, all positions, tooltips, journal and accessible text`);
  }
  const transitions=await harness('?account=production');
  await verify(transitions,'institutional',snapshots.institutional);
  for(const account of ['shadow','','institutional']) {
    assert.equal(await transitions.run(`loadModelData(${JSON.stringify(account)})`),true);
    await verify(transitions,account,snapshots[account]);
  }
  console.log('ok: production alias and repeated book switches clear stale claims');
  // Mutating in memory proves claims follow fields, not today’s hardcoded values.
  const changed=structuredClone(snapshots.shadow);
  changed.headline.cagr=.1555;changed.headline.sharpe=.8765;changed.headline.excess_vs_spy_bps=448;
  changed.headline.max_drawdown=-.142;changed.headline.max_drawdown_daily=-.221;
  changed.holdings.positions=changed.holdings.positions.slice(0,4);
  changed.live.inception_date='2026-07-23';changed.equity_curve.live[0].d=changed.live.inception_date;
  changed.as_of=changed.live.last_updated='2026-10-26';changed.live.days_live++;
  changed.equity_curve.live.push({...changed.equity_curve.live.at(-1),d:changed.as_of});
  const varied=await harness('?account=shadow',{'shadow_snapshot.json':changed});
  await verify(varied,'shadow',changed);
  console.log('ok: changed metrics, count, live date and session count propagate without data writes');
  for(const [file,text] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(__dirname,file),'utf8'),text,file+' changed');
  console.log('all dashboard copy tests passed (offline; snapshot files unchanged)');
})().catch(error=>{console.error(error);process.exitCode=1;});

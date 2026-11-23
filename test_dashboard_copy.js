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
const equityChart=h=>h.charts.filter(c=>c.element===h.document.getElementById('equity')&&!c.destroyed).at(-1);
// Synthetic daily SPY for the live window: any path that starts at the deposit base and
// ends at the published benchmark return exercises the same reconciliation as real data.
function withSpyLive(snap) {
  const s=structuredClone(snap), dates=[...new Set(s.equity_curve.live.map(p=>p.d))].sort();
  const end=s.live.inception_nav*(1+s.live.benchmark_return), n=dates.length-1;
  s.equity_curve.spy_live=dates.map((d,i)=>({d,v:i===n?Math.round(end*100)/100:Math.round((s.live.inception_nav+(end-s.live.inception_nav)*i/n+(i%2?15:-15)*(i>0))*100)/100}));
  return s;
}
function verifyLiveChart(h,s,scale,type) {
  const c=equityChart(h), live=s.live, spyLive=s.equity_curve.spy_live;
  assert.equal(c.$mode,'live');
  assert.equal(c.data.datasets.map(d=>d.label).join('|'),spyLive?`S&P 500 (Live)|${type}`:type);
  const line=c.data.datasets.find(d=>d.role==='live').data;
  const near=(got,want,tol,what)=>assert.ok(Math.abs(got-want)<=tol,`${what}: ${got} vs ${want}`);
  near(line[0].y,live.inception_nav*scale,1e-6*scale*live.inception_nav,'live chart starts at the unrebased deposit');
  near(line.at(-1).y,live.nav*scale,0.01*scale,'live chart ends at true NAV');
  near(line.at(-1).y/line[0].y-1,live.since_inception_return,1e-4,'plotted live return equals the hero card');
  if(live.inception_date==='2026-07-27') {
    assert.equal(line[0].syntheticAnchor,true); assert.equal(line[1].x,line[0].x);
    assert.ok(line[1].y<line[0].y,'opening-day dip is plotted');
  }
  includes(h.text('curve-title'),`${dollars(live.inception_nav*scale)} since ${live.inception_date}`,'live chart title');
  includes(h.text('rebase-note'),'Unrebased live track','live rebase note');
  const tip=c.options.plugins.tooltip.callbacks;
  const lastLive={dataset:c.data.datasets.find(d=>d.role==='live'),parsed:line.at(-1),raw:line.at(-1)};
  if(spyLive) {
    const bench=c.data.datasets.find(d=>d.role==='bench').data;
    near(bench[0].y,live.inception_nav*scale,1e-9,'S&P 500 (Live) base');
    near(bench.at(-1).y/bench[0].y-1,live.benchmark_return,1e-4,'S&P 500 (Live) equals the S&P 500 card');
    assert.match(tip.afterBody([lastLive]),/^Relative curve value vs S&P 500 \(Live\): [+-]\d+\.\d%$/);
    includes(h.text('curve-sub'),'same window as the S&P 500 card','live benchmark basis');
  } else {
    assert.equal(tip.afterBody([lastLive]),'S&P 500 comparison unavailable for this date');
    includes(h.text('curve-sub'),'S&P 500 live series not in this snapshot','missing live benchmark');
  }
  for(const dataset of c.data.datasets) for(const point of [dataset.data[0],dataset.data.at(-1)])
    assert.doesNotMatch(tip.label({dataset,parsed:point,raw:point}),/undefined|NaN|null| {2,}/);
  if(live.inception_date==='2026-07-27') assert.equal(tip.label({dataset:c.data.datasets.find(d=>d.role==='live'),parsed:line[0],raw:line[0]}),`${type} (opening deposit): ${dollars(line[0].y)}`);
}
function verifyHeatmapSplit(h,s,type) {
  const histEnd=s.headline.window_end.slice(0,7), M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const titles=h.document.getElementById('heat-grid').querySelectorAll('[title]').map(el=>el.title);
  const labels=h.document.getElementById('heat-grid').querySelectorAll('.heat-year-col').map(el=>el.textContent);
  for(const y of [...new Set(s.monthly_returns.map(r=>r.month.slice(0,4)))]) {
    const inYear=s.monthly_returns.filter(r=>r.month.startsWith(y));
    const segs=[['hist',inYear.filter(r=>r.month<=histEnd)],['live',inYear.filter(r=>r.month>histEnd)]].filter(([,rows])=>rows.length);
    for(const [seg,rows] of segs) {
      const comp=k=>rows.filter(r=>r[k]!=null).reduce((v,r)=>v*(1+r[k]),1)-1;
      const months=rows.map(r=>Number(r.month.slice(5))-1);
      let basis=`${y} displayed months compounded`, label=y;
      if(segs.length===2&&seg==='hist') { basis=`${y} ${M[months[0]]}–${M[months.at(-1)]} simulation compounded; excludes the live track`; label=months[0]===0&&months.at(-1)===5?`${y} (Sim H1)`:`${y} (Sim)`; }
      if(segs.length===2&&seg==='live') {
        basis=`${y} ${type} since ${s.live.inception_date} compounded; equals the live-track return`; label=`${y} (Live)`;
        // The live row is the live track: it must reconcile to the hero cards.
        assert.ok(Math.abs(comp('strategy')-s.live.since_inception_return)<1e-5,`${y} live row vs since_inception_return`);
        assert.ok(Math.abs(comp('spy')-s.live.benchmark_return)<1e-5,`${y} live row vs benchmark_return`);
      }
      assert.ok(labels.includes(label),`heatmap row ${label}`);
      assert.ok(titles.includes(`Portfolio · ${basis}: ${signed(comp('strategy'))}`),`Portfolio total ${label}`);
      assert.ok(titles.includes(`S&P 500 · ${basis}: ${signed(comp('spy'))}`),`S&P 500 total ${label}`);
    }
    // No total anywhere compounds across the simulation-to-live boundary.
    if(segs.length===2) {
      const spliced=inYear.reduce((v,r)=>v*(1+r.strategy),1)-1;
      assert.ok(!titles.some(t=>t.startsWith(`Portfolio · ${y}`)&&t.endsWith(`: ${signed(spliced)}`)&&!/\d{4}-\d{2} \(/.test(t)),`${y} spliced total must not be shown`);
    }
  }
  includes(h.text('heat-sub'),'never bridge the simulation and the live track','heatmap split copy');
}
const includes=(text,expected,where)=>assert.ok(text.includes(expected),`${where}: expected ${JSON.stringify(expected)} in ${JSON.stringify(text)}`);

// Independent reference calculation from published marks; never calls the UI helpers.
function dailyReference(points) {
  const returns = points.slice(1).map((p,i)=>p.v/points[i].v-1), n=returns.length;
  const drawdowns = points.map((p,i)=>p.v/Math.max(...points.slice(0,i+1).map(p=>p.v))-1);
  const mean=returns.reduce((a,b)=>a+b,0)/n;
  const vol=n>=15?Math.sqrt(252*returns.reduce((a,r)=>a+(r-mean)**2,0)/(n-1)):null;
  const downside=n>=15?Math.sqrt(252*returns.reduce((a,r)=>a+Math.min(r,0)**2,0)/n):null;
  return {n,ret:points.at(-1).v/points[0].v-1,maxDD:Math.min(...drawdowns),vol,
    sharpe:vol>0?252*mean/vol:null,sortino:downside>0?252*mean/downside:null};
}
function referenceSegments(s) {
  const clean=rows=>[...new Map((rows||[]).filter(p=>p.d<=s.as_of&&![0,6].includes(new Date(p.d+'T00:00:00Z').getUTCDay()))
    .map(p=>[p.d,{...p}])).values()].sort((a,b)=>a.d.localeCompare(b.d));
  const live=clean(s.equity_curve.live).filter(p=>p.d>=s.live.inception_date).map(p=>({...p,v:p.v/(Number(s.live.rebase_factor)||1)}));
  if(Math.abs(live[0].v/s.live.inception_nav-1)>1e-4)live.unshift({d:s.live.inception_date,v:s.live.inception_nav});
  return {backtest:clean(s.equity_curve.backtest),simulation:clean(s.equity_curve.simulation),live};
}
function verifyRisk(h,s) {
  const segments=referenceSegments(s), live=dailyReference(segments.live);
  const ratio=v=>v==null?'—':v.toFixed(2), percent=v=>v==null?'—':pct(v);
  const actual=h.run('RiskMetrics.getPerformanceMetrics(SNAP)');
  const near=(got,want,label)=>want==null?assert.equal(got,null,label):assert.ok(Math.abs(got-want)<1e-10,`${label}: ${got} vs ${want}`);
  for(const k of ['n','ret','maxDD','vol','sharpe','sortino'])near(actual.live[k],live[k],'live '+k);
  const rows=h.document.getElementById('quarterly-body').querySelectorAll('tr');
  assert.equal(rows.length,8);
  for(let i=0;i<8;i++) {
    const date=new Date(s.as_of+'T00:00:00Z');date.setUTCDate(1);date.setUTCMonth(Math.floor(date.getUTCMonth()/3)*3-i*3);
    const start=date.toISOString().slice(0,10), year=date.getUTCFullYear(), month=date.getUTCMonth();
    const end=new Date(Date.UTC(year,month+3,0)).toISOString().slice(0,10);
    const windows=Object.entries(segments).map(([basis,p])=>{
      const inside=p.filter(p=>p.d>=start&&p.d<=end), anchor=p.filter(p=>p.d<start).at(-1);
      return {basis,points:anchor?[anchor,...inside]:inside,partial:!anchor,inside:inside.length};
    }).filter(w=>w.inside&&w.points.length>1);
    const w=windows.at(-1), expected=dailyReference(w.points), m=actual.quarters[i];
    const months=s.monthly_returns.filter(r=>r.month>=start.slice(0,7)&&r.month<=end.slice(0,7)&&r.month<=s.as_of.slice(0,7));
    const ret=months.reduce((v,r)=>v*(1+r.strategy),1)-1, spy=months.reduce((v,r)=>v*(1+r.spy),1)-1;
    assert.equal(m.basis,w.basis);assert.equal(m.partial,w.partial);
    assert.equal(m.start,w.points[0].d);assert.equal(m.end,w.points.at(-1).d);
    for(const k of ['n','maxDD','vol','sharpe','sortino'])near(m[k],expected[k],m.key+' '+k);
    near(m.ret,ret,m.key+' return');near(m.spy,spy,m.key+' SPY');
    const cells=rows[i].querySelectorAll('td');
    assert.deepEqual(cells.slice(2).map(c=>c.textContent),[signed(ret),signed(spy),ratio(expected.sharpe),ratio(expected.sortino),percent(expected.vol),pct(expected.maxDD)]);
    includes(cells[1].textContent,w.points[0].d,'quarter daily start');
    includes(cells[1].textContent,w.points.at(-1).d,'quarter daily end');
    if(w.partial)includes(cells[1].textContent,'partial live','partial daily coverage');
  }
  const q=actual.current, strip=h.text('live-quarterly-strip');
  for(const value of [q.label,signed(q.ret),signed(q.spy),ratio(q.sharpe),pct(q.maxDD),ratio(live.sharpe),ratio(live.sortino),percent(live.vol),pct(live.maxDD)])includes(strip,value,'risk strip');
  assert.equal(h.document.getElementById('live-quarterly-strip').parentNode,h.document.getElementById('livestats').parentNode);
  for(const id of ['live-quarterly-strip','quarterly-body','hero-live-quarterly'])assert.doesNotMatch(h.text(id),/NaN|null|undefined|Annualised|realised/i);
  // Current snapshot sanity values are a second oracle, beyond reference formulas.
  const account=h.run('CFG.label').toLowerCase();
  if(s.as_of==='2026-11-13'&&s.live.inception_date===(account==='retail'?'2026-07-27':'2026-07-24')) {
    const golden={retail:['+2.66%','1.32','1.64','19.27%','-5.87%','+30.25%','5.71','-2.56%'],
      institutional:['+3.71%','2.23','3.34','13.27%','-3.42%','+18.09%','5.03','-2.43%'],
      shadow:['+2.15%','1.23','1.64','14.52%','-4.77%','+13.74%','5.09','-1.81%']}[account];
    if(golden)assert.deepEqual([signed(q.ret),q.sharpe.toFixed(2),q.sortino.toFixed(2),pct(q.vol),pct(q.maxDD),signed(actual.quarters[2].ret),actual.quarters[2].sharpe.toFixed(2),pct(actual.quarters[2].maxDD)],golden);
  }
}

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
  // The selected hero view persists across book switches and drives the main chart.
  h.run("swapHeroCards('backtest')");
  assert.equal(live.days_live,s.equity_curve.live.length,'session count must count published daily marks');
  if(sim) assert.doesNotMatch(normalize(h.document.body.textContent), /buy-and-hold/i);
  assert.equal(h.run('CFG.label'),name);
  verifyRisk(h,s);
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
  const chart=equityChart(h);
  assert.equal(chart.$mode,'backtest');
  assert.deepEqual(chart.data.datasets.map(d=>d.label).join('|'),`S&P 500|Walk-forward backtest|2026 simulation|${type}`);
  includes(h.text('curve-title'),dollars(live.inception_nav*scale),'chart base');
  includes(h.text('rebase-note'),dollars(live.inception_nav),'unscaled starting NAV');
  if(sim) includes(h.text('rebase-note'),dollars(live.inception_nav*scale),'display notional');

  h.run("swapHeroCards('backtest')");
  assert.equal(h.document.getElementById('hero-live-quarterly').hidden,true);
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
  assert.equal(h.document.getElementById('hero-live-quarterly').hidden,false);
  if(live.benchmark_return!=null) {
    verifyLiveChart(h,s,scale,type);
    assert.equal(h.text('k-cagr'),signed(live.since_inception_return));
    assert.equal(h.text('k-sharpe'),signed(live.benchmark_return));
    assert.equal(h.text('k-dd'),live.benchmark_return_iwm!=null?signed(live.benchmark_return_iwm):'—');
    includes(h.text('k-cagr-foot'),dollars(live.nav,2),'live hero source NAV');
    if(sim) includes(h.text('k-cagr-foot'),'Source NAV','unscaled source NAV label');
    includes(h.text('k-cagr-foot'),`Live start ${live.inception_date}`,'live start');
    includes(h.text('k-sharpe-foot'),`${Math.round(live.excess_return*10000)} bps`,'SPY return difference');
    if(live.excess_return_iwm!=null) includes(h.text('k-dd-foot'),`${Math.round(live.excess_return_iwm*10000)} bps`,'IWM return difference');
    for (const id of ['k-sharpe-foot', 'k-dd-foot']) includes(h.text(id), `${live.inception_date} to ${live.last_updated}`, 'per-track benchmark window');
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
  verifyHeatmapSplit(h,s,type);
  includes(h.text('sector-sub'),`${s.sector_history.months[0]} to ${s.sector_history.months.at(-1)}`,'sector range');
  includes(h.text('sector-sub'),'reference configuration','sector provenance');
  if(s.regime) {
    const r=s.regime, shown=id=>!h.document.getElementById(id).hidden;
    includes(h.text('rb-asof'),r.as_of,'regime source date');
    // The banner states the macro regime signal, never the account deployment label.
    assert.equal(h.text('rb-state'),r.state.replace(/_/g,' ').toUpperCase());
    assert.doesNotMatch(h.text('rb-state'),/INVESTED/);
    assert.equal(h.text('rb-exposure'),`${(r.gross_exposure*100).toFixed(1)}% invested`);
    assert.equal(h.text('rb-eq-wt'),Math.round(r.equity_weight*100)+'%');
    assert.equal(h.text('rb-cash'),Math.round(r.cash_weight*100)+'%');
    assert.equal(shown('rb-macro-seg'),r.macro_etf_weight>0);
    if(r.macro_etf_weight>0) assert.equal(h.text('rb-macro-wt'),Math.round(r.macro_etf_weight*100)+'%');
    if(r.macro_signal_longs.every(t=>!r.macro_holdings.includes(t))) {
      assert.equal(h.text('rb-signal-label'),'Macro signal (unheld):');
      assert.equal(h.text('rb-longs'),r.macro_signal_longs.join(', '));
    }
    assert.equal(shown('rb-defcash-seg'),r.macro_signal_cash.length>0);
    assert.equal(h.text('rb-defcash'),r.macro_signal_cash.join(', '));
    assert.doesNotMatch(normalize(h.document.getElementById('regime-banner').textContent),/\bNone\b/);
  }
  for(const r of s.crash_table) for(const v of [r.period,pct(r.strategy,1),pct(r.spy,1),r.edge_pp.toFixed(1)+'pp']) includes(h.text('crash-body'),v,'stress-window value');
  for(const r of s.crash_table) for(const k of ['strategy_max_drawdown_monthly','spy_max_drawdown_monthly']) if(r[k]!=null) includes(h.text('crash-body'),pct(r[k],1),'month-end stress-window value');
  const locked=s.holdings.positions.filter(p=>/^LOCKED-#\d+$/.test(p.ticker));
  for(const p of locked) { assert.equal(p.price,null,p.ticker+' price'); assert.equal(p.shares,null,p.ticker+' shares'); }
  if(locked.length) includes(h.text('hold-disclaimer'),'Active positions are embargoed for 7 days to protect live execution','embargo note');

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
  else assert.doesNotMatch(h.text('hold-sub'), /Priced as of/);

  // Chart labels, callback output, and empty states are user-visible copy too.
  for(const dataset of chart.data.datasets) {
    const point=dataset.data.at(-1);
    const tip=chart.options.plugins.tooltip.callbacks.label({dataset,parsed:point});
    assert.equal(tip,`${dataset.label}: ${dollars(point.y)}`);
    assert.doesNotMatch(tip,/undefined|NaN|null| {2,}/);
  }
  const missing=chart.options.plugins.tooltip.callbacks.afterBody([{dataset:{label:type},parsed:{x:0,y:1}}]);
  assert.equal(missing,'S&P 500 comparison unavailable for this date; select Live Track for the live-window benchmark');
  await h.run(`loadHistory(${JSON.stringify(account)})`);
  if(locked.length > 0) {
    includes(h.text('hold-embargo-explainer'),'7-Day Execution Embargo','embargo explainer');
    includes(h.text('hold-embargo-explainer'),'immediately upon exit in the Trade Journal','embargo unmasking');
    includes(h.text('history-note'),'Completed exits and holdings past the 7-day embargo window are fully unmasked','journal unmasking');
  }
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
  delete changed.equity_curve.spy_live; // the invented live window has no matching SPY curve
  const varied=await harness('?account=shadow',{'shadow_snapshot.json':changed});
  await verify(varied,'shadow',changed);
  console.log('ok: changed metrics, count, live date and session count propagate without data writes');
  // Live Track chart with the live-window benchmark present, for every book, and after
  // switching books while Live Track stays selected.
  for(const account of Object.keys(files)) {
    const snap=withSpyLive(snapshots[account]), file=files[account];
    const h=await harness(account?'?account='+account:'',{[file]:snap});
    await verify(h,account,snap);
  }
  const sticky=await harness('',{[files['']]:withSpyLive(snapshots['']),[files.institutional]:withSpyLive(snapshots.institutional),[files.shadow]:snapshots.shadow});
  sticky.run("swapHeroCards('live')");
  for(const account of ['institutional','shadow','']) {
    assert.equal(await sticky.run(`loadModelData(${JSON.stringify(account)})`),true);
    const snap=account==='shadow'?snapshots.shadow:withSpyLive(snapshots[account]);
    assert.equal(equityChart(sticky).$mode,'live',`${account||'retail'} keeps Live Track chart`);
    verifyLiveChart(sticky,snap,account?500:1,label(account));
    assert.equal(sticky.charts.filter(c=>c.element===sticky.document.getElementById('equity')&&!c.destroyed).length,1,'one live equity chart instance');
  }
  // Rapid cycling through every tab, both views and the journal leaves no stale chart
  // instance, no ghost series and no null/NaN/undefined text behind.
  for(let round=0;round<3;round++) for(const account of ['hedged','shadow','institutional','','hedged','']) {
    assert.equal(await sticky.run(`loadModelData(${JSON.stringify(account)})`),true);
    // The hero selector lives on the non-hedged overview; the hedged tab has its own chart.
    if(account!=='hedged') sticky.run(`swapHeroCards(${JSON.stringify(round%2?'backtest':'live')})`);
    for(const view of ['journal','overview']) sticky.document.querySelector(`[data-view="${view}"]`).click();
    const live=sticky.charts.filter(c=>c.element===sticky.document.getElementById('equity')&&!c.destroyed);
    assert.equal(live.length,account==='hedged'?0:1,`${account||'retail'} equity chart instances`);
    if(account!=='hedged') assert.equal(live[0].$mode,round%2?'backtest':'live');
  }
  inspectStrings(sticky);
  sticky.run("swapHeroCards('backtest')");
  assert.equal(equityChart(sticky).$mode,'backtest');
  assert.equal(sticky.errors.length,0);
  console.log('ok: Live Track chart plots unrebased NAV vs S&P 500 (Live), with and without spy_live, across book switches');
  // Exact banner copy: macro regime signal and account book side by side.
  const bannerCase=async(account,file,regime)=>{
    const snap=structuredClone(snapshots[account]); Object.assign(snap.regime,regime);
    const h=await harness('?account='+account,{[file]:snap});
    const t=id=>h.text(id), shown=id=>!h.document.getElementById(id).hidden;
    inspectStrings(h); assert.equal(h.errors.length,0);
    return {t,shown};
  };
  const signal={state:'trend_off',macro_signal_longs:['UUP','USO'],macro_signal_cash:['TLT','IEF','TIP','HYG','GLD','DBA']};
  let b=await bannerCase('institutional','institutional_snapshot.json',{...signal,gross_exposure:.49045,equity_weight:.49045,
    macro_etf_weight:0,cash_weight:.50955,macro_holdings:[],deployment_state:'partly_invested'});
  assert.equal(b.t('rb-state'),'TREND OFF');
  assert.equal(`${b.t('rb-exposure')} · Equities ${b.t('rb-eq-wt')} · Cash ${b.t('rb-cash')}`,'49.0% invested · Equities 49% · Cash 51%');
  assert.equal(b.shown('rb-macro-seg'),false);
  assert.equal(`${b.t('rb-signal-label')} ${b.t('rb-longs')} · Defensive cash signals: ${b.t('rb-defcash')}`,
    'Macro signal (unheld): UUP, USO · Defensive cash signals: TLT, IEF, TIP, HYG, GLD, DBA');
  b=await bannerCase('','portfolio_snapshot.json',{...signal,gross_exposure:.937,equity_weight:.937,macro_etf_weight:0,
    cash_weight:.063,macro_holdings:[],deployment_state:'fully_invested'});
  assert.equal(`${b.t('rb-state')} | ${b.t('rb-exposure')} · Equities ${b.t('rb-eq-wt')} · Cash ${b.t('rb-cash')}`,
    'TREND OFF | 93.7% invested · Equities 94% · Cash 6%');
  b=await bannerCase('shadow','shadow_snapshot.json',{...signal,macro_holdings:['UUP']});
  assert.equal(b.t('rb-signal-label'),'Macro signal:');
  assert.equal(b.t('rb-longs'),'UUP (held), USO (unheld)');
  b=await bannerCase('shadow','shadow_snapshot.json',{state:'risk_on',macro_signal_longs:[],macro_signal_cash:[]});
  assert.equal(b.t('rb-state'),'RISK ON');
  assert.equal(b.shown('rb-signal-seg'),false); assert.equal(b.shown('rb-defcash-seg'),false);
  console.log('ok: regime banner separates the macro signal (unheld ETFs) from account exposure');
  for(const [file,text] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(__dirname,file),'utf8'),text,file+' changed');
  console.log('all dashboard copy tests passed (offline; snapshot files unchanged)');
})().catch(error=>{console.error(error);process.exitCode=1;});

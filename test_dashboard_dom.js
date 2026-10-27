'use strict';
// Offline DOM/Chart adapters for running the complete production dashboard script.
// This is a text/interaction harness, not a layout engine or a substitute for screenshots.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const decode = s => String(s).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, key) => {
  if (key[0] === '#') return String.fromCodePoint(key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : +key.slice(1));
  return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0'}[key.toLowerCase()];
});
const normalize = text => text.replace(/\s+/g, ' ').trim();
const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));

function createDocument(source) {
  const writes = [];
  class Element {
    constructor(tag = '#fragment', text = '') {
      this.tagName = tag.toLowerCase(); this.children = []; this.parentNode = null;
      this.attributes = {}; this.dataset = {}; this.style = {}; this.events = {};
      this.hidden = false; this.value = ''; this._text = text;
      this.classList = {
        contains: c => this.className.split(/\s+/).includes(c),
        add: (...cs) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...cs])].join(' '); },
        remove: (...cs) => { this.className = this.className.split(/\s+/).filter(c => !cs.includes(c)).join(' '); },
        toggle: (c, force) => { const on = force == null ? !this.classList.contains(c) : force; this.classList[on ? 'add' : 'remove'](c); return on; }
      };
    }
    get className() { return this.attributes.class || ''; }
    set className(v) { this.attributes.class = String(v); }
    get id() { return this.attributes.id || ''; }
    get title() { return this.attributes.title || ''; }
    set title(v) { this.setAttribute('title', v); }
    setAttribute(k,v) {
      this.attributes[k] = String(v);
      if (k === 'hidden') this.hidden = true;
      if (k === 'value') this.value = String(v);
      if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_,c)=>c.toUpperCase())] = String(v);
    }
    getAttribute(k) { return this.attributes[k] ?? null; }
    removeAttribute(k) { delete this.attributes[k]; if (k === 'hidden') this.hidden = false; }
    get textContent() { return this.tagName === '#text' ? this._text : this.children.map(c => c.textContent).join(''); }
    set textContent(v) {
      writes.push({id:this.id, text:String(v)});
      this.replaceChildren(new Element('#text', String(v)));
    }
    get innerHTML() { return this.children.map(c => c.tagName === '#text' ? c._text : `<${c.tagName}>${c.innerHTML}</${c.tagName}>`).join(''); }
    set innerHTML(v) { this.replaceChildren(...parse(String(v)).children); }
    appendChild(c) {
      if (c.tagName === '#fragment') { for (const child of [...c.children]) this.appendChild(child); return c; }
      c.parentNode = this; this.children.push(c); return c;
    }
    append(...nodes) { nodes.forEach(n => this.appendChild(typeof n === 'string' ? new Element('#text', n) : n)); }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    addEventListener(type, fn, options) { (this.events[type] ||= []).push({fn, once:!!options?.once}); }
    click() {
      const event = {target:this};
      for (let e=this; e; e=e.parentNode) {
        for (const h of [...(e.events.click || [])]) { h.fn(event); if (h.once) e.events.click = e.events.click.filter(x=>x!==h); }
      }
    }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c=>c!==this); }
    matches(selector) {
      if (selector[0] === '#') return this.id === selector.slice(1);
      if (selector[0] === '.') return this.classList.contains(selector.slice(1));
      const attr = /^\[([^=\]]+)(?:="?([^"\]]+)"?)?\]$/.exec(selector);
      if (attr) return attr[2] == null ? this.getAttribute(attr[1]) != null : this.getAttribute(attr[1]) === attr[2];
      return this.tagName === selector.toLowerCase();
    }
    closest(selector) { for (let e=this;e;e=e.parentNode) if(e.matches(selector)) return e; return null; }
    querySelectorAll(selector) {
      const parts = selector.trim().split(/\s+/); const found=[];
      const visit=e=>{for(const c of e.children) {
        if(c.matches(parts.at(-1))) {
          let ancestor=c.parentNode, i=parts.length-2;
          while(ancestor && i>=0) { if(ancestor.matches(parts[i])) i--; ancestor=ancestor.parentNode; }
          if(i<0) found.push(c);
        }
        visit(c);
      }};
      visit(this); return found;
    }
    querySelector(s) { return this.querySelectorAll(s)[0] || null; }
    getContext() { return {canvas:this}; }
  }
  function parse(html) {
    const root = new Element(); const stack=[root];
    const cleaned=html.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'');
    for(const token of cleaned.match(/<[^>]+>|[^<]+/g) || []) {
      if(token.startsWith('<!')) continue;
      if(token.startsWith('</')) {
        const tag=token.slice(2,-1).trim().toLowerCase();
        for(let i=stack.length-1;i>0;i--) if(stack[i].tagName===tag){stack.length=i;break;}
      } else if(token.startsWith('<')) {
        const match=/^<([\w-]+)([\s\S]*?)\/?\s*>$/.exec(token); if(!match) throw new Error('Unparsed HTML: '+token);
        const el=new Element(match[1]);
        for(const a of match[2].matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) el.setAttribute(a[1],decode(a[2]??a[3]??a[4]??''));
        stack.at(-1).appendChild(el); if(!VOID.has(el.tagName) && !token.endsWith('/>')) stack.push(el);
      } else stack.at(-1).appendChild(new Element('#text',decode(token)));
    }
    return root;
  }
  const document=parse(source);
  document.documentElement=document.querySelector('html'); document.body=document.querySelector('body');
  document.getElementById=id=>document.querySelector('#'+id);
  document.createElement=tag=>new Element(tag);
  document.createDocumentFragment=()=>new Element();
  return {document,writes};
}

async function harness(search = '', overrides = {}) {
  const source=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
  const {document,writes}=createDocument(source); const charts=[]; const errors=[];
  class Chart {
    static defaults={font:{},animation:{},plugins:{tooltip:{}}};
    constructor(_element,config){this.config=config;this.data=config.data;this.options=config.options;charts.push(this);}
    update(){} destroy(){} resetZoom(){}
  }
  const window={location:{search,pathname:'/momentum-portfolio/'},matchMedia:()=>({matches:false,addEventListener(){}}),addEventListener(){},innerWidth:1280};
  const context=vm.createContext({document,window,Chart,URLSearchParams,Intl,Date,Blob,URL,
    localStorage:{getItem:()=>null,setItem(){}},getComputedStyle:()=>({getPropertyValue:()=> '#123456'}),
    console:{log(){},warn(){},error(...args){errors.push(args.map(String).join(' '));}},setTimeout,clearTimeout,
    history:{replaceState(_state,_title,url){window.location.search=url.startsWith('?')?url:'';}},
    fetch:async url=>{
      const name=path.basename(url.split('?')[0]);
      if(!/^[\w-]+\.json$/.test(name)) throw new Error('Offline harness refuses '+url);
      return {ok:true,json:async()=>structuredClone(overrides[name] || JSON.parse(fs.readFileSync(path.join(__dirname,name),'utf8')))};
    }
  });
  const scripts=[...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
  if(!scripts.includes('\nboot();')) throw new Error('Dashboard boot call missing');
  vm.runInContext(scripts.replace('\nboot();','\nglobalThis.ready = boot();'),context,{filename:'index.html'});
  await context.ready;
  if(errors.length) throw new Error(errors.join('\n'));
  const run=code=>vm.runInContext(code,context);
  const text=id=>normalize(document.getElementById(id).textContent);
  return {source,document,writes,charts,errors,context,run,text};
}
module.exports={harness,normalize};

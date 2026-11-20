// Rules & sources screen: every rule and spec with its value, status, source and checked date;
// the list of unconfirmed values; the trader's own confirmations; app version and data dates.
// Also the "confirm a symbol" sheet (from Trade or here): MT5 Specification values plus the
// real-trade check. The engine merges the values (resolveInstrument) and checks the trade (checkFill):
// only a trade big enough to tell two contract sizes apart can settle a disagreement, and a check that
// doesn't match blocks that symbol.

import {
  esc, fmtMoney, fmtPlain, fmtISODate, fmtTimeIST, istDateISO, unwrap, wrapperMeta, isWrapper, statusTag,
  isUrl, describeValue, describePurchase, RULE_LABELS, openSheet, plural, APP_VERSION,
} from '../ui.js';
import { symbolsOf, confKey, confirmationIssues, CFD_CONFIRMABLE } from '../store.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const PLAN_KEYS = ['sizes', 'dailyLoss', 'maxLoss', 'consistency', 'news', 'marginCapPct', 'minHoldSeconds', 'contractCaps'];
const SKIP_PLAN = new Set(['id', 'name', 'stages', 'purchased', 'notModelled', 'family', ...PLAN_KEYS]);
const SPEC_KEYS = { cfd: ['contract', 'profitCurrency', 'volumeStep', 'volumeMin', 'volumeMax', 'priceSanity'], futures: ['tickSize', 'tickValue', 'quoteUnit', 'exchange', 'micro', 'capWeight', 'priceSanity'] };
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD'];

let screen = null;

export async function render(root, ctx) {
  screen = { root, ctx };
  await paint();
  root.addEventListener('click', onClick);
  root.addEventListener('toggle', onToggle, true);
  return () => { screen = null; };
}

async function paint() {
  if (!screen) return;
  const { root, ctx } = screen;
  const confs = await ctx.store.getAll('confirmations');
  const confMap = new Map(confs.map((c) => [c.key, c]));
  screen.confMap = confMap;
  const open = new Set([...root.querySelectorAll('details[open][data-key]')].map((d) => d.dataset.key));
  const un = collectUnconfirmed(ctx, confMap);
  const total = un.rules.length + un.symbols.reduce((n, g) => n + g.items.length, 0);
  const lede = total
    ? `${plural(total, 'value')} unconfirmed. Each one blocks the sizes that need it until it is confirmed.`
    : 'Every value the sizes depend on has a source.';
  root.innerHTML = `<div class="title-row"><p class="lede">${esc(lede)}</p></div>
    ${ctx.data.problems.length ? `<section class="card"><h2 class="card-title">Files with problems</h2><ul class="msgs">${ctx.data.problems.map((p) => `<li class="msg msg-neg">${esc(p.message)}</li>`).join('')}</ul></section>` : ''}
    ${unconfirmedHtml(un)}
    ${confirmationsHtml(ctx, confs)}
    <h2 class="section-title">Firms and plans</h2>
    ${ctx.data.firms.map((f) => firmHtml(ctx, f)).join('') || '<p class="muted">No firm rules loaded.</p>'}
    <h2 class="section-title">Symbols</h2>
    ${ctx.data.instruments.map((file) => fileHtml(file)).join('') || '<p class="muted">No symbol lists loaded.</p>'}
    ${appHtml(ctx)}`;
  for (const d of root.querySelectorAll('details[data-key]')) if (open.has(d.dataset.key)) { d.open = true; fillLazy(d); }
}

// ---------- One rule row ----------
function sourceHtml(m) {
  if (!m) return '';
  const bits = [];
  if (m.source) {
    if (isUrl(m.source)) {
      let host = m.source;
      try { host = new URL(m.source).hostname.replace(/^www\./, ''); } catch { /* keep the text */ }
      bits.push(`<a href="${esc(m.source)}" target="_blank" rel="noopener noreferrer">${esc(host)}</a>`);
    } else bits.push(esc(m.source));
  }
  if (m.checked) bits.push(`checked ${esc(fmtISODate(String(m.checked).slice(0, 10)))}`);
  return bits.join(' · ');
}

function ruleRow(label, key, w, extra = '') {
  const m = wrapperMeta(w);
  const v = isWrapper(w) ? unwrap(w) : w;
  const value = describeValue(key, v, m ? m.status : null);
  const tag = m ? statusTag(m.status) : (v === null || v === undefined ? '<span class="tag tag-neutral">No rule</span>' : '<span class="tag tag-neutral">No source given</span>');
  return `<div class="rule">
    <div class="rule-l"><span class="rule-label">${esc(label)}</span><span class="rule-value">${esc(value)}${extra}</span>
      ${m && m.note ? `<span class="rule-note">${esc(m.note)}</span>` : ''}</div>
    <div class="rule-r">${tag}${m ? `<span class="rule-src">${sourceHtml(m)}</span>` : ''}</div>
  </div>`;
}

// ---------- Firms ----------
function firmHtml(ctx, firm) {
  const plans = Array.isArray(firm.plans) ? firm.plans : [];
  const un = countUnconfirmedFirm(firm);
  const fd = ctx.firmDayFor(firm);
  const clockExtra = fd ? ` That is ${esc(fmtTimeIST(fd.nextResetUTC))} IST for the next reset.` : '';
  const head = [firm.market === 'futures' ? 'Futures' : 'CFD', firm.platform, plural(plans.length, 'plan'),
    un.blocking ? `${un.blocking} unconfirmed` : '', un.notSetUp ? 'loss limits not set up' : ''].filter(Boolean).join(' · ');
  return `<details class="card fold" data-key="firm:${esc(firm.id)}">
    <summary><span class="fold-title">${esc(firm.name || firm.id)}</span><span class="fold-sub">${esc(head)}</span></summary>
    <div class="fold-body">
      ${firm.clock !== undefined ? ruleRow(RULE_LABELS.clock, 'clock', firm.clock, clockExtra) : ''}
      ${firm.breach !== undefined ? ruleRow(RULE_LABELS.breach, 'breach', firm.breach) : ''}
      ${plans.map((p) => planHtml(p)).join('')}
      ${notModelledHtml(firm.notModelled, `Not checked by Risk Desk (${firm.name || firm.id})`)}
    </div>
  </details>`;
}

function planHtml(plan) {
  const rows = [];
  if (plan.purchased) rows.push(`<p class="rule-group-sub">${esc(describePurchase(plan.purchased))}</p>`);
  rows.push(ruleRow(RULE_LABELS.sizes, 'sizes', plan.sizes));
  for (const st of Array.isArray(plan.stages) ? plan.stages : []) {
    rows.push(ruleRow(`${st.name || st.id} target${st.funded ? ' (funded)' : ''}`, 'target', st.target === undefined ? null : st.target));
  }
  for (const k of PLAN_KEYS.slice(1)) if (plan[k] !== undefined) rows.push(ruleRow(RULE_LABELS[k] || k, k, plan[k]));
  for (const [k, w] of Object.entries(plan)) if (!SKIP_PLAN.has(k) && isWrapper(w)) rows.push(ruleRow(RULE_LABELS[k] || k, k, w));
  return `<div class="rule-group"><h3 class="rule-group-title">${esc(plan.name || plan.id)}</h3>${rows.join('')}${notModelledHtml(plan.notModelled, 'Not checked for this plan')}</div>`;
}

function notModelledHtml(list, title) {
  if (!Array.isArray(list) || !list.length) return '';
  return `<div class="rule-group"><p class="rule-group-sub">${esc(title)}</p><ul class="plain-list">${list.map((x) => `<li>${esc(typeof x === 'string' ? x : JSON.stringify(x))}</li>`).join('')}</ul></div>`;
}

// Futures programs have no loss rules set up (decision Q1): those gaps don't block, so they are counted
// apart. A futures clock or contract limit that is unconfirmed does block (the engine gives NO TRADE).
const blocksOnFutures = (key) => key === 'clock' || key === 'contractCaps';

function countUnconfirmedFirm(firm) {
  const out = { blocking: 0, notSetUp: 0 };
  const fut = firm.market === 'futures';
  const look = (key, w) => {
    const m = wrapperMeta(w);
    if (!m || m.status !== 'unconfirmed') return;
    if (fut && !blocksOnFutures(key)) out.notSetUp++; else out.blocking++;
  };
  look('clock', firm.clock); look('breach', firm.breach);
  for (const p of firm.plans || []) {
    for (const k of PLAN_KEYS) look(k, p[k]);
    for (const st of p.stages || []) look('target', st.target);
  }
  return out;
}

// ---------- Symbol files (rendered when opened) ----------
function fileHtml(file) {
  const syms = symbolsOf(file);
  return `<details class="card fold" data-key="file:${esc(file.id)}" data-lazy="file" data-file="${esc(file.id)}">
    <summary><span class="fold-title">${esc(file.title || file.id)}</span><span class="fold-sub">${esc([file.market === 'futures' ? 'Futures' : 'CFD', plural(syms.length, 'symbol'), file.checked ? `checked ${fmtISODate(file.checked)}` : ''].filter(Boolean).join(' · '))}</span></summary>
    <div class="fold-body" data-body></div>
  </details>`;
}

function fillLazy(d) {
  if (!screen || d.dataset.filled || d.dataset.lazy !== 'file') return;
  const file = screen.ctx.data.instrumentsById.get(d.dataset.file);
  const body = d.querySelector('[data-body]');
  if (!file || !body) return;
  d.dataset.filled = '1';
  const classes = file.classes && typeof file.classes === 'object' ? file.classes : {};
  const parts = [];
  for (const [id, c] of Object.entries(classes)) {
    const rows = [];
    for (const [k, w] of Object.entries(c || {})) if (k !== 'label') rows.push(ruleRow(RULE_LABELS[k] || k, k, w));
    parts.push(`<div class="rule-group"><h3 class="rule-group-title">${esc(c && c.label ? c.label : id)}</h3>${rows.join('') || '<p class="muted">No class-wide values.</p>'}</div>`);
  }
  const keys = SPEC_KEYS[file.market] || SPEC_KEYS.cfd;
  for (const s of symbolsOf(file)) {
    const conf = screen.confMap.get(confKey(file.id, s.symbol)) || null;
    const inst = screen.ctx.resolveSymbol(file, s.symbol, conf, null);
    const shown = inst || s;
    const gaps = screen.ctx.specGaps(inst, file.market);
    const issues = inst ? confirmationIssues(inst, conf) : [`Risk Desk couldn't read the values for ${s.symbol}, so it can't be sized. Reload the page.`];
    parts.push(`<div class="rule-group"><h3 class="rule-group-title">${esc(s.symbol)} <span class="muted">${esc(s.name || '')}</span>
      ${file.market === 'cfd' ? `<button type="button" class="btn btn-small" data-confirm="${esc(file.id)}" data-symbol="${esc(s.symbol)}">${gaps.length ? 'Confirm from MT5' : 'Your MT5 values'}</button>` : ''}</h3>
      ${keys.filter((k) => shown[k] !== undefined).map((k) => ruleRow(RULE_LABELS[k] || k, k, shown[k])).join('')}
      ${issues.map((m) => `<p class="msg msg-neg">${esc(m)}</p>`).join('')}</div>`);
  }
  body.innerHTML = parts.join('');
}

function onToggle(e) {
  const d = e.target;
  if (d && d.tagName === 'DETAILS' && d.open) fillLazy(d);
}

// ---------- Unconfirmed list ----------
function collectUnconfirmed(ctx, confMap) {
  const rules = [], conflicts = [], notSetUp = [];
  const look = (path, w, futures = false) => {
    const m = wrapperMeta(w);
    if (!m) return;
    // Futures programs have no loss rules set up (decision Q1): they are listed, but they don't block.
    if (m.status === 'unconfirmed') (futures ? notSetUp : rules).push({ path, note: m.note });
    if (m.status === 'conflict') conflicts.push({ path, note: m.note });
  };
  for (const f of ctx.data.firms) {
    const fn = f.name || f.id;
    const fut = f.market === 'futures';
    look(`${fn} · ${RULE_LABELS.clock}`, f.clock);
    look(`${fn} · ${RULE_LABELS.breach}`, f.breach, fut);
    for (const p of f.plans || []) {
      const pn = `${fn} · ${p.name || p.id}`;
      for (const k of PLAN_KEYS) look(`${pn} · ${RULE_LABELS[k] || k}`, p[k], fut && !blocksOnFutures(k));
      for (const st of p.stages || []) look(`${pn} · ${st.name || st.id} target`, st.target, fut);
    }
  }
  const symbols = [];
  for (const file of ctx.data.instruments) {
    for (const [id, c] of Object.entries(file.classes || {})) {
      for (const [k, w] of Object.entries(c || {})) if (k !== 'label') look(`${file.title || file.id} · ${(c && c.label) || id} · ${RULE_LABELS[k] || k}`, w);
    }
    const groups = new Map();
    for (const s of symbolsOf(file)) {
      const inst = ctx.resolveSymbol(file, s.symbol, confMap.get(confKey(file.id, s.symbol)) || null, null);
      // A symbol the engine can't resolve is listed by what the data file itself leaves unconfirmed.
      const gaps = ctx.specGaps(inst || s, file.market);
      if (!gaps.length) continue;
      const label = gaps.map((g) => (RULE_LABELS[g] || g).toLowerCase()).join(', ');
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(s.symbol);
    }
    for (const [label, items] of groups) symbols.push({ file, label, items });
  }
  return { rules, conflicts, symbols, notSetUp };
}

function unconfirmedHtml(un) {
  if (!un.rules.length && !un.symbols.length && !un.conflicts.length && !un.notSetUp.length) return '';
  const rules = un.rules.map((r) => `<li><span class="rule-label">${esc(r.path)}</span>${r.note ? `<span class="rule-note">${esc(r.note)}</span>` : ''}</li>`).join('');
  const syms = un.symbols.map((g) => `<div class="unc-group">
      <p class="rule-label">${esc(g.file.title || g.file.id)}: ${plural(g.items.length, 'symbol')} need${g.items.length === 1 ? 's' : ''} ${esc(g.label)}</p>
      ${g.file.market === 'cfd' ? `<div class="chips-wrap">${g.items.map((s) => `<button type="button" class="chip chip-small" data-confirm="${esc(g.file.id)}" data-symbol="${esc(s)}">${esc(s)}</button>`).join('')}</div>`
        : `<p class="hint">${esc(g.items.join(', '))}. These come from the exchange's contract pages, so the rules file needs updating.</p>`}
    </div>`).join('');
  const conf = un.conflicts.map((r) => `<li><span class="rule-label">${esc(r.path)}</span>${r.note ? `<span class="rule-note">${esc(r.note)}</span>` : ''}</li>`).join('');
  return `<section class="card" aria-labelledby="unc-h"><h2 class="card-title" id="unc-h">Needs confirming</h2>
    ${syms ? `<p class="hint">Tap a symbol to type its values from the MT5 Specification window.</p>${syms}` : ''}
    ${rules ? `<p class="rule-group-sub">Rules without a source</p><ul class="plain-list unc-list">${rules}</ul>` : ''}
    ${conf ? `<p class="rule-group-sub">Firm pages disagree (the stricter reading is used)</p><ul class="plain-list unc-list">${conf}</ul>` : ''}
    ${un.notSetUp.length ? `<details class="mini-fold"><summary>Futures rules not set up (${un.notSetUp.length}). They don't block: futures sizes use your risk setting and the firm's contract limits, if any</summary><ul class="plain-list unc-list">${un.notSetUp.map((r) => `<li><span class="rule-label">${esc(r.path)}</span>${r.note ? `<span class="rule-note">${esc(r.note)}</span>` : ''}</li>`).join('')}</ul></details>` : ''}
  </section>`;
}

// ---------- Your confirmations ----------
function confirmationsHtml(ctx, confs) {
  if (!confs.length) {
    return `<section class="card" aria-labelledby="yours-h"><h2 class="card-title" id="yours-h">Your confirmations</h2>
      <p class="muted">None yet. Values you type from MT5 and your real-trade checks show here, with their dates.</p></section>`;
  }
  const rows = [...confs].sort((a, b) => String(a.key).localeCompare(String(b.key))).map((c) => {
    const file = ctx.data.instrumentsById.get(c.instruments);
    const sym = file ? symbolsOf(file).find((s) => s.symbol === c.symbol) || null : null;
    const inst = file && sym ? ctx.resolveSymbol(file, c.symbol, c, null) : null;
    const typed = Object.entries(c.specs || {}).filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${(RULE_LABELS[k] || k).toLowerCase()} ${isNum(v) ? fmtPlain(v) : v}`).join(' · ');
    let check = 'No real-trade check';
    const rc = sym ? realCheck(ctx, sym, inst, c) : null;
    if (c.realTrade && rc) check = checkSummary(rc);
    const bad = file && sym && (!inst || confirmationIssues(inst, c).length);
    return `<li class="rule">
      <div class="rule-l"><span class="rule-label">${esc(c.symbol)} <span class="muted">${esc(file ? file.title || file.id : c.instruments)}</span></span>
        <span class="rule-value">${esc(typed || 'No values typed')}</span>
        <span class="rule-note">${esc(check)}${c.specsCheckedOn ? ` · values typed ${esc(fmtISODate(c.specsCheckedOn))}` : ''}${c.realTrade && c.realTrade.checkedOn ? ` · trade checked ${esc(fmtISODate(c.realTrade.checkedOn))}` : ''}</span></div>
      <div class="rule-r">${bad ? '<span class="tag tag-neg">Blocks this symbol</span>' : '<span class="tag tag-info">From your MT5</span>'}
        ${file ? `<button type="button" class="btn btn-small" data-confirm="${esc(c.instruments)}" data-symbol="${esc(c.symbol)}">Open</button>` : '<span class="rule-src">Its symbol list didn\'t load</span>'}</div>
    </li>`;
  }).join('');
  return `<section class="card" aria-labelledby="yours-h"><h2 class="card-title" id="yours-h">Your confirmations</h2><ul class="rows-plain">${rows}</ul></section>`;
}

// ---------- App ----------
function appHtml(ctx) {
  const files = ctx.data.files.map((f) => `<li><span>${esc(f.title)}</span> <span class="muted">${esc(f.path)}${f.checked ? ` · checked ${esc(fmtISODate(f.checked))}` : ''}</span></li>`).join('');
  const s = ctx.settings;
  return `<section class="card" aria-labelledby="app-h"><h2 class="card-title" id="app-h">This app</h2>
    <dl class="kv">
      <div><dt>Version</dt><dd class="num">${esc(APP_VERSION)}</dd></div>
      <div><dt>Margin cap</dt><dd class="num">${esc(fmtPlain(s.marginCapPct))}% of equity</dd></div>
      <div><dt>Futures slippage on the stop</dt><dd class="num">${esc(plural(s.futuresSlippageTicks, 'tick'))}</dd></div>
      <div><dt>Cushion kept above every floor</dt><dd class="num">${esc(fmtMoney(s.floorCushionUSD))}</dd></div>
      <div><dt>Storage</dt><dd>${ctx.store && ctx.store.persistent ? 'This device only' : 'Not saved (private window)'}</dd></div>
    </dl>
    <p class="rule-group-sub">Rules files loaded</p>
    <ul class="plain-list">${files || '<li class="muted">None</li>'}</ul>
    <p class="hint">All times are shown in India time (IST). Each firm's day is worked out in its own time zone, so US daylight saving is handled.</p>
  </section>`;
}

function onClick(e) {
  if (!screen) return;
  const b = e.target.closest('[data-confirm]');
  if (b) openConfirmSheet(screen.ctx, b.dataset.confirm, b.dataset.symbol, { onSaved: () => paint() });
}

// ---------- The confirm-a-symbol sheet ----------
const FIELD_LABELS = { contract: 'Contract size', profitCurrency: 'Profit currency', volumeStep: 'Volume step', volumeMin: 'Minimal volume', volumeMax: 'Maximal volume' };
const fmtContract = (x) => (isNum(x) ? Number(x.toPrecision(4)).toLocaleString('en-US', { maximumFractionDigits: 6 }) : '—');

export async function openConfirmSheet(ctx, fileId, symbol, { onSaved } = {}) {
  const file = ctx.data.instrumentsById.get(fileId);
  const sym = file ? symbolsOf(file).find((s) => s.symbol === symbol) : null;
  if (!file || !sym) { ctx.toast("This symbol's list didn't load."); return; }
  if (!ctx.calc) { ctx.toast("The calculator isn't loaded, so values can't be checked."); return; }
  const key = confKey(fileId, symbol);
  const st = {
    conf: await ctx.store.get('confirmations', key),
    typed: {}, trade: { lots: '', open: '', close: '', profit: '', conversion: '' }, errors: {}, saved: false, confirmRemove: false, justChecked: false,
    check: null, issues: [],
  };
  for (const f of CFD_CONFIRMABLE) {
    const v = st.conf && st.conf.specs ? st.conf.specs[f] : undefined;
    st.typed[f] = v === undefined || v === null ? '' : String(v);
  }
  let body = null;
  const paintSheet = () => {
    const inst = ctx.resolveSymbol(file, symbol, st.conf, null);
    st.check = realCheck(ctx, sym, inst, st.conf);
    st.issues = inst ? confirmationIssues(inst, st.conf) : [`Risk Desk couldn't read the values for ${symbol}, so it can't be sized. Reload the page.`];
    // The conversion price box: for the profit currency in use, else the one typed, else the data file's.
    const P = (inst && unwrap(inst.profitCurrency)) || (st.typed.profitCurrency || null) || unwrap(sym.profitCurrency) || null;
    st.need = P ? ctx.conversionNeed(P, sym.base, sym.quote) : null;
    body.innerHTML = sheetHtml(file, sym, inst, st);
  };
  openSheet({
    title: `${symbol}: your MT5 values`,
    html: '',
    onMount: (b) => {
      body = b;
      paintSheet();
      b.addEventListener('input', (e) => {
        const t = e.target;
        if (t.dataset.c) st.typed[t.dataset.c] = t.value;
        if (t.dataset.t) st.trade[t.dataset.t] = t.value;
      });
      b.addEventListener('change', (e) => { if (e.target.dataset.c) st.typed[e.target.dataset.c] = e.target.value; });
      b.addEventListener('click', async (e) => {
        const act = e.target.closest('[data-act]');
        if (!act) return;
        if (act.dataset.act === 'save') await saveSheet(ctx, file, symbol, st);
        else if (act.dataset.act === 'clear-check') {
          if (st.conf && Object.keys(st.conf.specs || {}).length) await writeConf(ctx, file, symbol, st, { ...st.conf, realTrade: null, updatedAt: new Date().toISOString() }, 'Check cleared.');
          else { await ctx.store.delete('confirmations', key); st.conf = null; st.saved = true; ctx.toast('Check cleared.'); }
        }
        else if (act.dataset.act === 'remove') st.confirmRemove = true;
        else if (act.dataset.act === 'remove-no') st.confirmRemove = false;
        else if (act.dataset.act === 'remove-yes') {
          await ctx.store.delete('confirmations', key);
          st.conf = null; st.saved = true; st.confirmRemove = false;
          for (const f of CFD_CONFIRMABLE) st.typed[f] = '';
          ctx.toast(`Removed your values for ${symbol}.`);
        } else return;
        paintSheet();
      });
    },
    onClose: () => { if (st.saved && onSaved) onSaved(); },
  });
}

function sheetHtml(file, sym, inst, st) {
  const e = st.errors;
  const err = (k) => (e[k] ? `<p class="field-msg is-bad">${esc(e[k])}</p>` : '');
  const specRows = CFD_CONFIRMABLE.map((f) => {
    const dataW = sym[f], m = wrapperMeta(dataW), dv = unwrap(dataW);
    const now = inst ? inst[f] : undefined, nm = wrapperMeta(now), nv = unwrap(now);
    const dataText = dv === null || dv === undefined ? 'not known' : f === 'contract' ? `${fmtPlain(dv)} units per lot` : f === 'profitCurrency' ? String(dv) : `${fmtPlain(dv)} lots`;
    const useText = nv === null || nv === undefined ? 'nothing usable' : f === 'contract' ? fmtPlain(nv) : f === 'profitCurrency' ? String(nv) : `${fmtPlain(nv)} lots`;
    const input = f === 'profitCurrency'
      ? `<select id="c-${f}" data-c="${f}"><option value="">Choose from MT5</option>${[...new Set([...CURRENCIES, ...(typeof dv === 'string' && /^[A-Z]{3}$/.test(dv) ? [dv] : [])])].map((c) => `<option ${st.typed[f] === c ? 'selected' : ''}>${c}</option>`).join('')}</select>`
      : `<input id="c-${f}" data-c="${f}" type="text" inputmode="decimal" autocomplete="off" value="${esc(st.typed[f])}">`;
    return `<div class="spec-row">
      <label for="c-${f}">${FIELD_LABELS[f]}</label>${input}
      <p class="spec-now">Data file: ${esc(dataText)} ${m ? statusTag(m.status) : ''}</p>
      <p class="spec-now">In use: ${esc(useText)} ${nm ? statusTag(nm.status) : ''}</p>
      ${nm && nm.note && nm.status !== (m && m.status) ? `<p class="spec-note">${esc(nm.note)}</p>` : ''}
      ${err(f)}</div>`;
  }).join('');
  const need = st.need || null;
  const rt = st.conf && st.conf.realTrade;
  const tf = (k, label, money) => `<div class="field"><label for="t-${k}">${esc(label)}</label>
    <input id="t-${k}" data-t="${k}" data-money="${money ? '1' : ''}" type="text" inputmode="decimal" autocomplete="off" value="${esc(st.trade[k])}">${err('t-' + k)}</div>`;
  return `
    <p class="hint">In MT5, open Market Watch, right-click ${esc(sym.symbol)} and choose Specification. Type what it shows. A box left blank keeps the value in use.</p>
    ${(st.issues || []).map((m) => `<p class="msg msg-neg">${esc(m)}</p>`).join('')}
    <div class="spec-rows">${specRows}</div>
    ${inst && Array.isArray(inst.notes) ? inst.notes.filter((m) => typeof m === 'string' && m).map((m) => `<p class="msg msg-info">${esc(m)}</p>`).join('') : ''}
    <h3 class="sheet-sub">Check against a real trade</h3>
    <p class="hint">The Specification window can be misread (a cut-off digit, or two symbols with similar names). A real trade settles it. Use an open or closed ${esc(sym.symbol)} trade: its volume, open price, current or close price, and the profit MT5 shows (not counting commission or swap). Pick one with a profit or loss of at least $1: a smaller one can't tell two contract sizes apart.</p>
    <div class="fields">
      ${tf('lots', 'Volume (lots)')}${tf('open', 'Open price')}${tf('close', 'Current or close price')}${tf('profit', 'Profit in MT5 ($)', true)}
      ${need && need.pair ? tf('conversion', `${need.pair} price when it closed`) : ''}
    </div>
    ${checkHtml(st.check, rt, sym.symbol)}
    ${e._form ? `<p class="msg msg-neg">${esc(e._form)}</p>` : ''}
    <div class="row-actions"><button type="button" class="btn btn-primary" data-act="save">Save</button><button type="button" class="btn btn-quiet" data-close>Close</button></div>
    ${st.conf ? `<div class="sheet-danger">${st.confirmRemove
      ? `<p>Remove every value you typed for ${esc(sym.symbol)}, and its real-trade check?</p><div class="row-actions"><button type="button" class="btn btn-danger" data-act="remove-yes">Remove</button><button type="button" class="btn btn-quiet" data-act="remove-no">Keep</button></div>`
      : `<button type="button" class="btn btn-small btn-danger-quiet" data-act="remove">Remove my values for ${esc(sym.symbol)}…</button>`}</div>` : ''}`;
}

// The saved real trade, checked by the engine (checkFill) against the contract size being tested: the one
// the trader typed, or else the one in use, or else the data file's. If the engine's resolved symbol carries
// its own check, that one is shown. Null when no trade is saved.
function realCheck(ctx, sym, inst, conf) {
  const rt = conf && conf.realTrade;
  if (!rt || typeof rt !== 'object') return null;
  if (inst && inst.check && typeof inst.check === 'object') return { ...inst.check, contractTested: inst.check.contractTested ?? null };
  const specs = conf.specs && typeof conf.specs === 'object' ? conf.specs : {};
  const pick = (f) => {
    const typed = specs[f];
    if (typed !== undefined && typed !== null && typed !== '') return typed;
    const inUse = inst ? unwrap(inst[f]) : null;
    return inUse !== null && inUse !== undefined ? inUse : unwrap(sym[f]);
  };
  const contract = pick('contract'), profitCurrency = pick('profitCurrency');
  const tested = { status: 'your-mt5', source: 'The value being checked', checked: rt.checkedOn || null };
  const candidate = {
    ...(inst || sym),
    contract: { ...tested, value: contract ?? null },
    profitCurrency: { ...tested, value: profitCurrency ?? null },
  };
  const r = ctx.checkFill({ instrument: candidate, fill: { lots: rt.lots, open: rt.open, close: rt.close, profit: rt.profit }, conversionPrice: rt.conversionPrice ?? null });
  return { ...r, contractTested: isNum(contract) ? contract : null, profitCurrencyTested: profitCurrency ?? null };
}

// One line for the list of confirmations. The engine's checkFill (DESIGN 5.6): match true only with
// decisive true; match false is a clear mismatch (|profit| ≥ $1, more than 1% off; decisive stays false)
// and blocks the symbol; match null is a trade too small to settle anything, or no contract size to test.
export function checkSummary(c) {
  if (!c || !c.ok) return "Real trade check can't be read";
  if (c.match === true && c.decisive) return 'Real trade matches';
  if (c.match === false) return "Real trade doesn't match: blocked";
  if (c.contractTested === null || c.contractTested === undefined) return 'Real trade saved, no contract size to compare';
  return 'Real trade too small to settle anything';
}

export function checkHtml(c, rt, symbol) {
  if (!rt) return '';
  const clear = '<button type="button" class="btn btn-small btn-quiet" data-act="clear-check">Clear this check</button>';
  const when = rt.checkedOn ? ` (checked ${esc(fmtISODate(rt.checkedOn))})` : '';
  if (!c) return `<div class="check-out"><p class="msg msg-info">A real trade is saved${when}.</p>${clear}</div>`;
  if (!c.ok) return `<div class="check-out"><p class="msg msg-neg">The saved real trade can't be checked: ${esc((c.errors && c.errors[0]) || c.message || 'its numbers are incomplete.')}</p>${clear}</div>`;
  const shown = isNum(rt.profit) ? fmtMoney(Math.abs(rt.profit)) : '';
  const implied = isNum(c.impliedContract)
    ? `From MT5's numbers the contract size is about ${fmtContract(c.impliedContract)}${c.profitCurrencyTested && c.profitCurrencyTested !== 'USD' ? ` (profit in ${c.profitCurrencyTested})` : ''}.` : '';
  const expected = isNum(c.expectedProfit) && isNum(c.contractTested)
    ? `With a contract size of ${fmtContract(c.contractTested)}, this trade should show ${fmtMoney(c.expectedProfit)}${shown ? `; MT5 shows ${shown}` : ''}.` : '';
  const engineSays = typeof c.message === 'string' && c.message.trim() ? c.message.trim() : '';
  let tone, lead;
  if (c.decisive && c.match === true) { tone = 'pos'; lead = `Match${when}.`; }
  else if (c.match === false) { tone = 'neg'; lead = `Doesn't match${when}. ${symbol} is blocked until the contract size is fixed or this check is cleared.`; }
  else if ((c.match === undefined || c.match === null) && !engineSays) { tone = 'warn'; lead = 'Type the contract size above to compare.'; }
  else { tone = 'warn'; lead = `Not settled${when}.`; }
  const text = [lead, engineSays && !lead.includes(engineSays) ? engineSays : '', implied, expected].filter(Boolean).join(' ');
  return `<div class="check-out" aria-live="polite"><p class="msg msg-${tone}">${esc(text)}</p>${clear}</div>`;
}

async function saveSheet(ctx, file, symbol, st) {
  const e = {};
  const read = (text, money) => { try { return ctx.calc.readNum(text, { money }); } catch { return { ok: false, message: "This isn't a number." }; } };
  const specs = {};
  for (const f of CFD_CONFIRMABLE) {
    const t = String(st.typed[f] || '').trim();
    if (!t) continue;
    if (f === 'profitCurrency') {
      if (!/^[A-Z]{3}$/.test(t)) e[f] = 'Pick the currency MT5 shows.';
      else specs[f] = t;
      continue;
    }
    const r = read(t, f === 'contract');
    if (!r.ok) e[f] = r.message;
    else if (!(r.value > 0)) e[f] = 'This must be more than 0.';
    else specs[f] = r.value;
  }
  if (isNum(specs.volumeMin) && isNum(specs.volumeMax) && specs.volumeMax < specs.volumeMin) e.volumeMax = 'The maximal volume is below the minimal volume.';
  // The real trade: all or nothing.
  const tr = st.trade;
  const any = ['lots', 'open', 'close', 'profit', 'conversion'].some((k) => String(tr[k]).trim());
  let realTrade = st.conf && st.conf.realTrade ? st.conf.realTrade : null;
  if (any) {
    const vals = {};
    for (const [k, money] of [['lots', false], ['open', false], ['close', false], ['profit', true]]) {
      const r = read(tr[k], money);
      if (!r.ok) e['t-' + k] = r.message;
      else if (r.empty) e['t-' + k] = 'Fill this in for the check.';
      else vals[k] = k === 'profit' ? Math.abs(r.value) : r.value;
    }
    for (const k of ['lots', 'open', 'close', 'profit']) if (isNum(vals[k]) && !(vals[k] > 0)) e['t-' + k] = 'This must be more than 0.';
    if (String(tr.conversion).trim()) {
      const r = read(tr.conversion, false);
      if (!r.ok) e['t-conversion'] = r.message;
      else if (!(r.value > 0)) e['t-conversion'] = 'This must be more than 0.';
      else vals.conversionPrice = r.value;
    }
    if (!Object.keys(e).some((k) => k.startsWith('t-'))) {
      const today = istDateISO(new Date());
      realTrade = { lots: vals.lots, open: vals.open, close: vals.close, profit: vals.profit, conversionPrice: isNum(vals.conversionPrice) ? vals.conversionPrice : null, checkedOn: today, at: new Date().toISOString() };
    }
  }
  st.errors = e;
  if (Object.keys(e).length) return;
  const prev = st.conf || {};
  const sameSpecs = JSON.stringify(prev.specs || {}) === JSON.stringify(specs);
  const next = {
    key: confKey(file.id, symbol), instruments: file.id, symbol, specs,
    specsCheckedOn: sameSpecs && prev.specsCheckedOn ? prev.specsCheckedOn : istDateISO(new Date()),
    realTrade, updatedAt: new Date().toISOString(),
  };
  if (!Object.keys(specs).length && !realTrade) {
    if (st.conf) { await ctx.store.delete('confirmations', next.key); st.conf = null; st.saved = true; ctx.toast(`Removed your values for ${symbol}.`); }
    else ctx.toast('Nothing to save yet. Type a value from MT5 or a real trade.');
    return;
  }
  await writeConf(ctx, file, symbol, st, next, null);
  if (any) st.trade = { lots: '', open: '', close: '', profit: '', conversion: '' };
  const inst = ctx.resolveSymbol(file, symbol, next, null);
  const blocked = !inst || confirmationIssues(inst, next).length > 0;
  ctx.toast(blocked ? `Saved. ${symbol} is blocked: see the message.` : `Saved your ${symbol} values.`);
}

async function writeConf(ctx, file, symbol, st, conf, toastText) {
  try {
    await ctx.store.put('confirmations', conf);
    st.conf = conf;
    st.saved = true;
    st.errors = {};
    if (toastText) ctx.toast(toastText);
  } catch (err) {
    console.error(err);
    st.errors = { _form: "Couldn't save on this device. Try again." };
  }
}

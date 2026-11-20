// Risk Desk: boot, data loading, hash router and screen switching.
// The screens never compute a size, a floor or a rule: they call engine/calc.js through ctx.calc and show
// what it returns. If the calculator or a data file is missing, the app says so and sizes nothing.

import { APP_VERSION, esc, toast, fmtTimeIST, istInfo, dataPathsFromIndex, unwrap, toDate } from './ui.js';
import { openStore, loadSettings, rollAccountDay, symbolInput, classIdsOf, DEFAULT_SETTINGS } from './store.js';
import * as trade from './screens/trade.js';
import * as accounts from './screens/accounts.js';
import * as journal from './screens/journal.js';
import * as rules from './screens/rules.js';
import * as backup from './screens/backup.js';

const SCREENS = {
  trade: { mod: trade, title: 'Trade' },
  accounts: { mod: accounts, title: 'Accounts' },
  journal: { mod: journal, title: 'Journal' },
  rules: { mod: rules, title: 'Rules & sources' },
  backup: { mod: backup, title: 'Backup' },
};
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const ctx = {
  version: APP_VERSION,
  calc: null,
  calcProblem: null,
  store: null,
  data: { firms: [], firmById: new Map(), instruments: [], instrumentsById: new Map(), files: [], problems: [] },
  classIds: [],                      // class ids of the loaded symbol lists (a personal plan's class rules use them)
  settings: { ...DEFAULT_SETTINGS },
  // Memory only: cleared when the app closes. restores counts the backups brought back since the app
  // opened, so a screen can drop what it remembered about the data that was replaced.
  session: { restores: 0 },
  route: { name: 'trade', params: [] },
  toast,
  go,
  refresh: () => route({ keepScroll: true }),
  setTitle,
  firmDayFor,
  floorsFor,
  evaluate,
  resolveSymbol,
  checkFill,
  specGaps,
  conversionNeed,
  productBanned,
  rollDays,
};

let cleanup = null;
let routeToken = 0;
const problems = new Map();          // app-wide messages shown in the banner

// ---------- Engine (engine/calc.js) ----------
const ENGINE_EXPORTS = ['evaluateTrade', 'readNum', 'firmDay', 'istParts', 'floors', 'resolveInstrument', 'checkFill', 'conversionNeed', 'sizeSpecGaps', 'productBanned'];
async function loadCalc() {
  try {
    const m = await import('../engine/calc.js');
    if (ENGINE_EXPORTS.some((k) => typeof m[k] !== 'function')) {
      ctx.calcProblem = "The calculator file is incomplete, so Risk Desk can't read numbers or size trades. The app files need fixing.";
      return;
    }
    ctx.calc = Object.fromEntries(ENGINE_EXPORTS.map((k) => [k, m[k]]));
  } catch (e) {
    console.error(e);
    ctx.calcProblem = "The calculator file didn't load, so Risk Desk can't read numbers or size trades. Reload the page. If this stays, the app files need fixing.";
  }
}

// One symbol, resolved by the engine for evaluateTrade (DESIGN 5): the data file's entry, its class, the
// trader's own values and the plan's published fee. Null when the symbol isn't in the file or the engine
// can't resolve it; the screens then show NO TRADE for that symbol (fail closed).
function resolveSymbol(file, symbolId, conf = null, plan = null) {
  if (!ctx.calc) return null;
  const input = symbolInput(file, symbolId, conf, plan);
  if (!input) return null;
  try {
    const inst = ctx.calc.resolveInstrument(input);
    return inst && typeof inst === 'object' ? inst : null;
  } catch (e) {
    console.error(e);
    return null;
  }
}

// The values a size needs that a resolved symbol still lacks (the engine decides), for the
// "Needs your MT5 values" tags. An empty list when the engine can't tell: the size itself is blocked then.
function specGaps(inst, market) {
  if (!ctx.calc || !inst) return [];
  try {
    const g = ctx.calc.sizeSpecGaps(inst, market);
    return Array.isArray(g) ? g.filter((x) => typeof x === 'string') : [];
  } catch (e) {
    console.error(e);
    return [];
  }
}

// Which USD price turns a profit currency into dollars (the engine decides), to show the right box.
// Null when none is needed or the engine can't tell (the engine then blocks the size itself).
function conversionNeed(profitCurrency, base, quote) {
  if (!ctx.calc) return null;
  try {
    const r = ctx.calc.conversionNeed(profitCurrency, base, quote);
    return r && typeof r === 'object' ? r : null;
  } catch (e) {
    console.error(e);
    return null;
  }
}

// Does the firm's product list leave this futures symbol out of the plan (a limit of 0 for the account
// size)? The engine decides (productBanned); this only marks the symbol "Not allowed" in the list and lets
// the card ask the engine before any price is typed. False when the engine can't tell: evaluateTrade
// still gives NO TRADE for a product the firm doesn't allow.
function productBanned(plan, accountSize, symbol) {
  if (!ctx.calc || typeof ctx.calc.productBanned !== 'function' || !plan || typeof symbol !== 'string') return false;
  try {
    return ctx.calc.productBanned(plan, accountSize, symbol) === true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

// The engine's real-trade check, closed on failure (the confirm sheet only shows what it returns).
function checkFill(args) {
  const no = (m) => ({ ok: false, errors: [m], impliedContract: null, expectedProfit: null, match: undefined, decisive: false, message: m });
  if (!ctx.calc) return no(ctx.calcProblem || "The calculator isn't loaded, so the trade can't be checked.");
  try {
    const r = ctx.calc.checkFill(args);
    if (!r || typeof r !== 'object') return no('The check gave no answer.');
    return { ...r, errors: Array.isArray(r.errors) ? r.errors.filter((x) => typeof x === 'string') : [] };
  } catch (e) {
    console.error(e);
    return no(`The check stopped with an error. (${e && e.message ? e.message : 'unknown error'})`);
  }
}

// The firm's trading day. Tries the clock's value first, then the whole clock entry; anything that
// doesn't give a sensible day (reset before now, next reset after now) counts as "can't tell".
function firmDayFor(firm, now = new Date()) {
  if (!ctx.calc || !firm || !firm.clock) return null;
  const forms = [unwrap(firm.clock), firm.clock];
  for (const c of forms) {
    if (!c || typeof c !== 'object') continue;
    try {
      const r = ctx.calc.firmDay(c, now);
      const last = toDate(r && r.lastResetUTC), next = toDate(r && r.nextResetUTC);
      if (r && typeof r.dayKey === 'string' && r.dayKey && last && next && last <= now && now < next) {
        return { ...r, lastResetUTC: last, nextResetUTC: next };
      }
    } catch { /* try the other form */ }
  }
  return null;
}

function floorsFor(account, plan, firm) {
  if (!ctx.calc || !account || !plan || !firm) return null;
  try {
    const r = ctx.calc.floors(account, plan, firm);
    return r && typeof r === 'object' ? r : null;
  } catch {
    return null;
  }
}

// evaluateTrade, closed on failure: anything odd becomes NO TRADE with a reason the trader can read.
function evaluate(input) {
  const stop = (message, code = 'APP_ERROR') => ({ status: 'NO_TRADE', size: 0, unit: null, sizeText: '0', direction: null,
    reasons: [{ code, message }], notices: [], working: [], risk: null, limits: null, margin: null, reward: null, capped: null });
  if (!ctx.calc) return stop(ctx.calcProblem || "The calculator isn't loaded, so there is no size.");
  let r;
  try {
    r = ctx.calc.evaluateTrade(input);
  } catch (e) {
    console.error(e);
    return stop(`The calculator stopped with an error, so there is no size. (${e && e.message ? e.message : 'unknown error'})`);
  }
  if (!r || typeof r !== 'object') return stop('The calculator gave no answer, so there is no size.');
  const reasons = Array.isArray(r.reasons) ? r.reasons.filter((x) => x && typeof x.message === 'string') : [];
  const out = { ...r, reasons, notices: Array.isArray(r.notices) ? r.notices.filter((x) => x && typeof x.message === 'string') : [],
    working: Array.isArray(r.working) ? r.working : [] };
  if (r.status === 'GO') {
    if (!(typeof r.size === 'number' && Number.isFinite(r.size) && r.size > 0)) return stop('The calculator said GO without a usable size, so this is treated as NO TRADE.');
    // GO never comes with a reason not to trade. If it ever did, the reason wins: NO TRADE, no size, so no
    // Copy and no Log trade (a product the firm doesn't allow can never be copied or logged).
    if (reasons.length) return { ...out, status: 'NO_TRADE', size: 0, capped: null };
    return out;
  }
  if (r.status !== 'NO_TRADE') return stop('The calculator gave an unclear answer, so this is treated as NO TRADE.');
  if (!reasons.length) out.reasons = [{ code: 'NO_REASON', message: 'NO TRADE. The calculator gave no reason.' }];
  out.size = 0;
  return out;
}

// ---------- Data files ----------
async function loadData() {
  const d = ctx.data;
  let index;
  try {
    const res = await fetch('data/index.json');
    if (!res.ok) throw new Error(String(res.status));
    index = await res.json();
  } catch {
    d.problems.push({ file: 'data/index.json', message: "The list of rules files is missing, so no firm rules or symbols are loaded. Nothing can be sized." });
    return;
  }
  const paths = dataPathsFromIndex(index);
  if (!paths.length) d.problems.push({ file: 'data/index.json', message: 'The list of rules files is empty. Nothing can be sized.' });
  const results = await Promise.all(paths.map(async (p) => {
    try {
      const res = await fetch(p);
      if (!res.ok) throw new Error(String(res.status));
      return { p, json: await res.json() };
    } catch {
      return { p, json: null };
    }
  }));
  for (const { p, json } of results) {
    if (!json || typeof json !== 'object') {
      d.problems.push({ file: p, message: `The rules file ${p} is missing or unreadable. Anything that needs it shows NO TRADE.` });
      continue;
    }
    if (Array.isArray(json.plans) && typeof json.id === 'string') {
      if (d.firmById.has(json.id)) { d.problems.push({ file: p, message: `Two rules files use the firm id "${json.id}". The second one (${p}) is ignored.` }); continue; }
      d.firms.push(json);
      d.firmById.set(json.id, json);
      d.files.push({ path: p, kind: 'firm', id: json.id, title: json.name || json.id, checked: latestChecked(json) });
    } else if (Array.isArray(json.symbols) && typeof json.id === 'string') {
      if (d.instrumentsById.has(json.id)) { d.problems.push({ file: p, message: `Two symbol files use the id "${json.id}". The second one (${p}) is ignored.` }); continue; }
      d.instruments.push(json);
      d.instrumentsById.set(json.id, json);
      d.files.push({ path: p, kind: 'instruments', id: json.id, title: json.title || json.id, checked: latestChecked(json) });
    } else {
      d.problems.push({ file: p, message: `The file ${p} is not a firm or a symbol list, so it was skipped.` });
    }
  }
  for (const f of d.firms) {
    for (const id of [].concat(f.instruments || [])) {
      if (typeof id === 'string' && !d.instrumentsById.has(id)) d.problems.push({ file: id, message: `${f.name || f.id} needs the symbol list "${id}", which didn't load. Its accounts show NO TRADE.` });
    }
  }
}

// The newest "checked" date anywhere in a data file.
function latestChecked(obj) {
  let best = typeof obj.checked === 'string' ? obj.checked : '';
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 8) return;
    if (!Array.isArray(v) && typeof v.checked === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.checked) && v.checked > best) best = v.checked.slice(0, 10);
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  walk(obj, 0);
  return best || null;
}

// ---------- The firm's day: reset today's fields at each firm's reset ----------
async function rollDays(now = new Date()) {
  if (!ctx.store || !ctx.calc) return 0;
  const list = await ctx.store.getAll('accounts');
  const changed = [];
  for (const a of list) {
    const fd = firmDayFor(ctx.data.firmById.get(a.firmId), now);
    if (!fd) continue;
    const r = rollAccountDay(a, fd.dayKey);
    if (r.changed) changed.push(r.account);
  }
  if (changed.length) await ctx.store.putMany('accounts', changed);
  return changed.length;
}

// ---------- Shell ----------
function setTitle(text) {
  const h = document.getElementById('screen-title');
  if (h) h.textContent = text;
  document.title = text === 'Trade' ? 'Risk Desk' : `${text} · Risk Desk`;
}

function setActiveNav(name) {
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

function tickClock(now = new Date()) {
  const el = document.getElementById('clock');
  if (!el) return;
  let text = null;
  if (ctx.calc) {
    try {
      const p = ctx.calc.istParts(now);
      if (p && typeof p.hh === 'number' && typeof p.mm === 'number') {
        const h = p.hh % 24;
        text = `${WEEKDAY[p.weekday] || ''} ${((h + 11) % 12) + 1}:${String(p.mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`.trim();
      }
    } catch { /* fall back below */ }
  }
  if (!text) {
    const p = istInfo(now);
    text = p ? `${WEEKDAY[p.weekday]} ${fmtTimeIST(now)}` : '';
  }
  el.innerHTML = `<span class="clock-time num">${esc(text)}</span> <span class="clock-zone">IST</span>`;
}

function setProblem(key, message) {
  if (message) problems.set(key, message); else problems.delete(key);
  const box = document.getElementById('banner');
  if (!box) return;
  const items = [...problems.entries()];
  box.hidden = items.length === 0;
  box.innerHTML = items.map(([k, m]) => k === 'update'
    ? `<p class="banner-row">${esc(m)} <button type="button" class="btn btn-small" data-act="reload">Reload</button></p>`
    : `<p class="banner-row">${esc(m)}</p>`).join('');
}

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, ...rest] = h.split('/');
  let params = [];
  try { params = rest.filter(Boolean).map(decodeURIComponent); } catch { params = []; }
  return SCREENS[name] ? { name, params } : { name: 'trade', params: [] };
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route({ keepScroll = false } = {}) {
  const token = ++routeToken;
  const { name, params } = parseHash();
  const sameScreen = ctx.route.name === name && ctx.route.params.join('/') === params.join('/');
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  ctx.route = { name, params };
  setActiveNav(name);
  setTitle(SCREENS[name].title);
  const main = document.getElementById('main');
  const y = window.scrollY;
  main.innerHTML = '';
  const root = document.createElement('div');
  root.className = `screen screen-${name}`;
  main.appendChild(root);
  let c = null;
  try {
    c = await SCREENS[name].mod.render(root, ctx, params);
  } catch (e) {
    console.error(e);
    root.innerHTML = `<section class="panel"><p class="msg msg-neg">This screen hit a problem and couldn't show. Reload the page. (${esc(e && e.message ? e.message : 'unknown error')})</p></section>`;
  }
  if (token !== routeToken) { if (typeof c === 'function') c(); return; }
  cleanup = typeof c === 'function' ? c : null;
  if (keepScroll && sameScreen) window.scrollTo(0, y);
  else if (!sameScreen) { window.scrollTo(0, 0); main.focus({ preventScroll: true }); }
}

// ---------- Offline (service worker) ----------
let waitingWorker = null;            // the new version, installed and waiting for Reload
let reloadAsked = false;             // Reload was tapped in the banner

// One listener on the banner, for as long as the page is open: every tap on Reload asks the waiting
// version to take over. Taps anywhere else in the banner do nothing.
function wireBanner() {
  const box = document.getElementById('banner');
  if (!box) return;
  box.addEventListener('click', (e) => {
    const btn = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-act="reload"]') : null;
    if (!btn || !waitingWorker) return;
    reloadAsked = true;
    try { waitingWorker.postMessage({ type: 'SKIP_WAITING' }); } catch (err) { console.warn('The new version did not answer:', err); }
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  const sw = navigator.serviceWorker;
  // Reload only when a new version takes over a page that was already running one, or after Reload was
  // tapped. On the very first visit the first version takes control (clients.claim) and the page is
  // already up to date: reloading then would only throw away anything half typed.
  const hadController = !!sw.controller;
  let reloading = false;
  sw.addEventListener('controllerchange', () => {
    if (reloading || !(hadController || reloadAsked)) return;
    reloading = true;
    location.reload();
  });
  sw.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    const offerUpdate = (w) => {
      waitingWorker = w;
      setProblem('update', 'A new version of Risk Desk is ready.');
    };
    if (reg.waiting && sw.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => { if (w.state === 'installed' && sw.controller) offerUpdate(w); });
    });
  }).catch((e) => console.warn('Offline mode is not available:', e));
}

// ---------- Boot ----------
async function boot() {
  tickClock();
  wireBanner();
  const [, store] = await Promise.all([loadCalc(), openStore(), loadData()]);
  ctx.store = store;
  ctx.classIds = classIdsOf(ctx.data.instruments);
  try { ctx.settings = await loadSettings(store); } catch { ctx.settings = { ...DEFAULT_SETTINGS }; }
  if (ctx.calcProblem) setProblem('calc', ctx.calcProblem);
  if (!store.persistent) setProblem('store', "This browser won't save anything here (private window or blocked storage). Accounts and the journal disappear when you close the page.");
  if (ctx.data.problems.length) setProblem('data', ctx.data.problems.length === 1 ? ctx.data.problems[0].message : `${ctx.data.problems.length} rules files have problems. Rules & sources lists them.`);
  try { await rollDays(); } catch (e) { console.error(e); }
  tickClock();
  window.addEventListener('hashchange', () => route());
  await route();
  setInterval(async () => {
    tickClock();
    let rolled = 0;
    try { rolled = await rollDays(); } catch { /* keep going */ }
    const mod = SCREENS[ctx.route.name].mod;
    if (typeof mod.onTick === 'function') { try { await mod.onTick(ctx, { rolled }); } catch (e) { console.error(e); } }
  }, 30000);
  registerServiceWorker();
}

boot().catch((e) => {
  console.error(e);
  const main = document.getElementById('main');
  if (main) main.innerHTML = `<section class="panel"><p class="msg msg-neg">Risk Desk couldn't start. Reload the page. (${esc(e && e.message ? e.message : 'unknown error')})</p></section>`;
});

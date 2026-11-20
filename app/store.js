// Risk Desk: storage on this device only (IndexedDB), plus backup and personal-plan checks.
// Stores: accounts, journal, confirmations, personalPlans, settings. Nothing is sent anywhere.
// Trade prices are never stored here: the Trade screen keeps them in memory and clears them.
// IndexedDB is opened only when openStore() is called, so tests can import the pure helpers in Node.

import { APP_VERSION, unwrap, wrapperMeta, isHHMM, isISODate, toDate } from './ui.js';

const DB_NAME = 'risk-desk';
const DB_VERSION = 1;
export const STORES = ['accounts', 'journal', 'confirmations', 'personalPlans', 'settings'];
export const STORE_KEYS = { accounts: 'id', journal: 'id', confirmations: 'key', personalPlans: 'id', settings: 'key' };
export const STORE_LABELS = { accounts: 'Accounts', journal: 'Journal entries', confirmations: 'Symbol confirmations', personalPlans: 'Personal plans', settings: 'Settings' };

// App safety settings (DESIGN Q9, Q10). They can be made stricter, never looser.
export const DEFAULT_SETTINGS = Object.freeze({ marginCapPct: 80, futuresSlippageTicks: 1, floorCushionUSD: 0.01 });
export const BACKUP_FORMAT = 'risk-desk-backup';
export const BACKUP_VERSION = 1;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

// ---------- Opening the store ----------
export async function openStore() {
  try {
    return idbStore(await openIDB());
  } catch (e) {
    return memoryStore(e);
  }
}

function openIDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) { reject(new Error('This browser has no IndexedDB.')); return; }
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: STORE_KEYS[name] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB did not open.'));
    req.onblocked = () => reject(new Error('Another Risk Desk tab is updating the storage. Close it and reload.'));
  });
}

function idbStore(db) {
  // A newer Risk Desk in another tab may need to upgrade the storage: let it, and reload this tab.
  db.onversionchange = () => { db.close(); if (typeof location !== 'undefined') location.reload(); };
  const finished = (t) => new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error || new Error('The save failed.'));
    t.onabort = () => reject(t.error || new Error('The save was stopped.'));
  });
  const read = (name, fn) => new Promise((resolve, reject) => {
    const r = fn(db.transaction(name, 'readonly').objectStore(name));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  // Several writes in ONE transaction over the named stores: every write that work() queues is saved, or
  // none is. The browser undoes them all when one fails. A write that can't even be queued (a record
  // without its key, a value that can't be copied) stops the transaction here, so the writes queued
  // before it are not saved either.
  const together = async (names, work) => {
    const t = db.transaction(names, 'readwrite');
    const done = finished(t);
    try {
      work((name) => t.objectStore(name));
    } catch (e) {
      done.catch(() => {});                      // the caller gets the first error, thrown below
      try { t.abort(); } catch { /* the transaction is over already */ }
      throw e;
    }
    await done;
  };
  return {
    kind: 'indexeddb',
    persistent: true,
    getAll: (name) => read(name, (s) => s.getAll()),
    get: (name, key) => read(name, (s) => s.get(key)).then((r) => (r === undefined ? null : r)),
    async put(name, value) {
      const t = db.transaction(name, 'readwrite');
      t.objectStore(name).put(clone(value));
      await finished(t);
      return value;
    },
    async putMany(name, values) {
      await together(name, (store) => { const s = store(name); for (const v of values) s.put(clone(v)); });
    },
    async delete(name, key) {
      const t = db.transaction(name, 'readwrite');
      t.objectStore(name).delete(key);
      await finished(t);
    },
    async replaceAll(data) {
      await together(STORES, (store) => {
        for (const n of STORES) {
          const s = store(n);
          s.clear();
          for (const v of data[n] || []) s.put(clone(v));
        }
      });
    },
    // Records for more than one store, saved together: all of them or none. Log trade uses it for the
    // journal entry and the account's new trade count and log time (DESIGN 6), so a failed save can't
    // leave a logged trade that the account doesn't know about.
    // writes: { journal: [entry], accounts: [account] }
    async putTogether(writes) {
      const rows = togetherRows(writes);
      if (!rows.length) return;
      await together([...new Set(rows.map(([n]) => n))], (store) => { for (const [n, v] of rows) store(n).put(clone(v)); });
    },
  };
}

// What putTogether was given, as [store name, record] pairs. Anything it can't save is refused before a
// single record is written: a store Risk Desk doesn't have, a list that isn't a list, a record without
// its key.
function togetherRows(writes) {
  if (!isObj(writes)) throw new Error('Nothing to save: the records are missing.');
  const rows = [];
  for (const [n, list] of Object.entries(writes)) {
    if (!STORES.includes(n)) throw new Error(`Risk Desk has no store called "${n}".`);
    if (!Array.isArray(list)) throw new Error(`The records for "${n}" are not a list.`);
    for (const v of list) {
      if (!isObj(v) || typeof v[STORE_KEYS[n]] !== 'string' || !v[STORE_KEYS[n]]) throw new Error(`A record for "${n}" has no ${STORE_KEYS[n]}.`);
      rows.push([n, v]);
    }
  }
  return rows;
}

// Used when IndexedDB is blocked (some private windows). Everything works until the page closes.
function memoryStore(err) {
  const maps = Object.fromEntries(STORES.map((n) => [n, new Map()]));
  return {
    kind: 'memory',
    persistent: false,
    reason: err && err.message ? err.message : String(err || ''),
    getAll: async (name) => [...maps[name].values()].map(clone),
    get: async (name, key) => (maps[name].has(key) ? clone(maps[name].get(key)) : null),
    async put(name, value) { maps[name].set(value[STORE_KEYS[name]], clone(value)); return value; },
    // Like the transactions above, the writes below are all or nothing: every record is copied first, and
    // only then are they put in place.
    async putMany(name, values) {
      const copies = values.map((v) => [v[STORE_KEYS[name]], clone(v)]);
      for (const [k, v] of copies) maps[name].set(k, v);
    },
    async delete(name, key) { maps[name].delete(key); },
    async replaceAll(data) {
      const next = STORES.map((n) => [n, (data[n] || []).map((v) => [v[STORE_KEYS[n]], clone(v)])]);
      for (const [n, copies] of next) { maps[n].clear(); for (const [k, v] of copies) maps[n].set(k, v); }
    },
    async putTogether(writes) {
      const copies = togetherRows(writes).map(([n, v]) => [n, v[STORE_KEYS[n]], clone(v)]);
      for (const [n, k, v] of copies) maps[n].set(k, v);
    },
  };
}

// ---------- Settings ----------
export async function loadSettings(store) {
  const rec = await store.get('settings', 'safety');
  const saved = rec && isObj(rec.value) ? rec.value : {};
  const out = { ...DEFAULT_SETTINGS };
  const ok = checkSafety({ ...DEFAULT_SETTINGS, ...saved });
  if (ok.ok) Object.assign(out, ok.values);
  return out;
}
// Stricter only: margin cap at most 80%, slippage at least 1 tick, cushion at least 1 cent.
export function checkSafety(v) {
  const errors = [];
  const values = {};
  const m = v.marginCapPct, s = v.futuresSlippageTicks, c = v.floorCushionUSD;
  if (!isNum(m) || m <= 0 || m > DEFAULT_SETTINGS.marginCapPct) errors.push(`Margin cap must be more than 0% and at most ${DEFAULT_SETTINGS.marginCapPct}%.`);
  else values.marginCapPct = m;
  if (!isNum(s) || !Number.isInteger(s) || s < DEFAULT_SETTINGS.futuresSlippageTicks || s > 50) errors.push('Futures slippage must be a whole number of ticks, at least 1.');
  else values.futuresSlippageTicks = s;
  if (!isNum(c) || c < DEFAULT_SETTINGS.floorCushionUSD || c > 100000) errors.push('The cushion above the floor must be at least $0.01.');
  else values.floorCushionUSD = c;
  return { ok: errors.length === 0, errors, values };
}

// ---------- Accounts ----------
// Numbers the floors and the room depend on. Editing any of them stamps updatedAt (DESIGN §4.4).
export const BALANCE_FIELDS = ['balance', 'equity', 'resetBalance', 'resetEquity', 'peakClosedBalance', 'otherOpenRisk', 'marginUsed'];
export const MONEY_FIELDS = ['balance', 'equity', 'resetBalance', 'resetEquity', 'peakClosedBalance', 'bestDayProfit', 'todayResult', 'otherOpenRisk', 'marginUsed'];
export const RISK_TYPES = ['pctOfSize', 'pctOfBalance', 'usd', 'personalPlan'];

// Why an account's numbers are out of date, for the screens' warnings and the form's "check every box".
// The engine makes the decision (STALE_BALANCES); this only lets the lists and forms say it in words.
// Returns null when the numbers are current, or { kind, at }:
//   'none'        no numbers typed yet (or their update time can't be read)
//   'future'      the update time is later than now (the phone's clock was ahead), so it proves nothing
//   'beforeReset' typed before the firm's last reset
//   'badLog'      a trade was logged, but its time can't be read (at: null), so the numbers can't be shown
//                 to include it
//   'afterLog'    a trade was logged after they were typed (Log trade stamps lastLoggedAt)
export const FUTURE_SLACK_MS = 5 * 60 * 1000;
export function numbersState(account, fd, now = new Date()) {
  const upd = toDate(account && account.updatedAt);
  if (!upd) return { kind: 'none', at: null };
  if (upd.getTime() > now.getTime() + FUTURE_SLACK_MS) return { kind: 'future', at: upd };
  if (fd && fd.lastResetUTC && upd < fd.lastResetUTC) return { kind: 'beforeReset', at: upd };
  if (loggedUnreadable(account)) return { kind: 'badLog', at: null };
  const logged = toDate(account.lastLoggedAt);
  if (logged && logged > upd) return { kind: 'afterLog', at: logged };
  return null;
}
// A logged-trade time is saved but can't be read (text that isn't a time, or a number like 1e20).
export function loggedUnreadable(account) {
  const v = account ? account.lastLoggedAt : null;
  return v !== null && v !== undefined && v !== '' && !toDate(v);
}

// At the firm's reset: today's result and trades go back to 0, news times and the reset values are
// cleared (the trader types the new reset values; old ones are never carried into a new day).
// An account with no day stamp keeps its values and is only stamped (the safer side).
export function rollAccountDay(account, dayKey) {
  if (!account || !dayKey || account.dayKey === dayKey) return { changed: false, account };
  if (!account.dayKey) return { changed: true, account: { ...account, dayKey } };
  return {
    changed: true,
    account: { ...account, dayKey, todayResult: 0, tradesToday: 0, newsToday: [], resetBalance: null, resetEquity: null },
  };
}

export function checkAccount(a) {
  const e = [];
  if (!isObj(a)) return ['not a record'];
  for (const k of ['id', 'firmId', 'planId', 'stageId']) if (typeof a[k] !== 'string' || !a[k]) e.push(`${k} is missing`);
  if (!isNum(a.size) || a.size <= 0) e.push('the account size is missing');
  for (const k of MONEY_FIELDS) {
    const v = a[k];
    if (v === null || v === undefined) continue;
    if (!isNum(v)) e.push(`${k} is not a number`);
    else if (k !== 'todayResult' && v < 0) e.push(`${k} is negative`);
  }
  if (a.tradesToday !== null && a.tradesToday !== undefined && !(Number.isInteger(a.tradesToday) && a.tradesToday >= 0)) e.push('trades today is not a whole number');
  if (a.purchasedOn !== null && a.purchasedOn !== undefined && !isISODate(a.purchasedOn)) e.push('the purchase date is not a date');
  // Which plan the firm's support said an account bought on a rule-change day follows (a plan id), or null.
  if (a.planBySupport !== null && a.planBySupport !== undefined && !(typeof a.planBySupport === 'string' && a.planBySupport.trim())) e.push('the plan the firm\'s support named is not a plan id');
  if (a.updatedAt !== null && a.updatedAt !== undefined && !toDate(a.updatedAt)) e.push('the last update time is not a time');
  if (a.lastLoggedAt !== null && a.lastLoggedAt !== undefined && !toDate(a.lastLoggedAt)) e.push('the time of the last logged trade is not a time');
  const r = a.riskMethod;
  if (r !== null && r !== undefined) {
    if (!isObj(r) || !RISK_TYPES.includes(r.type)) e.push('the risk method is not one Risk Desk knows');
    else {
      if (r.value !== null && r.value !== undefined && !(isNum(r.value) && r.value > 0)) e.push('the risk value is not a positive number');
      if (r.maxPctOfSize !== null && r.maxPctOfSize !== undefined && !(isNum(r.maxPctOfSize) && r.maxPctOfSize > 0)) e.push('the max risk is not a positive number');
    }
  }
  if (a.newsToday !== undefined && a.newsToday !== null) {
    if (!Array.isArray(a.newsToday) || a.newsToday.some((n) => !isObj(n) || !isHHMM(n.timeIST) || typeof n.currency !== 'string')) e.push('the news times are not in HH:MM form');
  }
  return e;
}

// ---------- Personal plan (DESIGN §4.3) ----------
const PLAN_KEYS = ['id', 'name', 'version', 'source', 'notes', 'risk', 'halfSizeClasses', 'maxTradesPerDay',
  'noSecondTradeIfFirstLostMorePctOfSize', 'fundedStopForDayAtProfitPctOfSize', 'blockIfOneMoreFullLossReachesDailyLimit',
  'noNewTradesIST', 'onlyBetweenIST', 'noTradeDays', 'requireStopAndTarget', 'importedAt'];
const RULE_KEYS = PLAN_KEYS.slice(5, 15);

// Class ids the loaded symbol lists use ("fx", "metal", "index", "rates"…): the keys of each file's
// classes and every symbol's class. A plan's class rules only work with these exact ids.
export function classIdsOf(files) {
  const ids = new Set();
  for (const f of Array.isArray(files) ? files : []) {
    if (!isObj(f)) continue;
    if (isObj(f.classes)) for (const k of Object.keys(f.classes)) ids.add(k);
    for (const s of symbolsOf(f)) if (typeof s.class === 'string' && s.class) ids.add(s.class);
  }
  return [...ids].sort();
}

// The class id a mistyped name most likely means ("indices" → "index", "INDEX" → "index"), or null.
// Only a hint in the message: the plan is never changed for the trader.
const CLASS_SYNONYMS = {
  indices: 'index', indexes: 'index', indice: 'index', energies: 'energy', metals: 'metal', forex: 'fx',
  currencies: 'fx', currency: 'fx', cryptos: 'crypto', cryptocurrency: 'crypto', cryptocurrencies: 'crypto',
  grains: 'grain', soft: 'softs', rate: 'rates', treasuries: 'rates', bonds: 'rates',
};
export function suggestClass(name, ids) {
  const known = ids instanceof Set ? ids : new Set(ids || []);
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return null;
  if (known.has(n)) return n;
  if (CLASS_SYNONYMS[n] && known.has(CLASS_SYNONYMS[n])) return CLASS_SYNONYMS[n];
  for (const c of [n.replace(/ies$/, 'y'), n.replace(/es$/, ''), n.replace(/s$/, ''), `${n}s`]) if (c !== n && known.has(c)) return c;
  return null;
}

// Every class name in a plan's class rules that the loaded symbol lists don't use: [{ name, where, suggestion }].
export function unknownPlanClasses(plan, ids) {
  const known = ids instanceof Set ? ids : new Set(ids || []);
  const out = [];
  if (!isObj(plan) || !known.size) return out;
  const look = (list, where) => {
    for (const c of Array.isArray(list) ? list : []) {
      if (typeof c === 'string' && !known.has(c) && !out.some((x) => x.name === c)) out.push({ name: c, where, suggestion: suggestClass(c, known) });
    }
  };
  look(plan.halfSizeClasses, 'halfSizeClasses');
  for (const w of Array.isArray(plan.onlyBetweenIST) ? plan.onlyBetweenIST : []) look(w && w.classes, 'onlyBetweenIST');
  for (const d of Array.isArray(plan.noTradeDays) ? plan.noTradeDays : []) look(d && d.classes, 'noTradeDays');
  return out;
}
export function classNameHelp(name, ids) {
  const known = ids instanceof Set ? ids : new Set(ids || []);
  const s = suggestClass(name, known);
  return `${s ? `Use ${s}, not ${name}. ` : ''}The classes are: ${[...known].sort().join(', ')}.`;
}

// opts.classIds: the class ids of the loaded symbol lists (classIdsOf). When given, a class name the app
// doesn't use is refused: the engine compares names exactly, so "indices" would never match "index" and
// the rule would silently do nothing. When the list is empty (no symbol list loaded) the names can't be
// checked, and the plan gets a warning.
export function validatePersonalPlan(p, { classIds } = {}) {
  const errors = [], warnings = [];
  if (!isObj(p)) return { ok: false, errors: ['This is not a plan. A plan is one JSON object, starting with {.'], warnings, plan: null };
  const plan = {};
  const known = classIds === undefined || classIds === null ? null : new Set(classIds);
  const str = (k, label) => {
    if (typeof p[k] !== 'string' || !p[k].trim()) errors.push(`${label} is missing.`);
    else plan[k] = p[k].trim().slice(0, 120);
  };
  const pct = (v) => isNum(v) && v > 0 && v <= 100;
  const bool = (k) => {
    if (p[k] === undefined) return;
    if (typeof p[k] !== 'boolean') errors.push(`"${k}" must be true or false.`);
    else plan[k] = p[k];
  };
  let noDataWarned = false;
  const classes = (v, where) => {
    if (!Array.isArray(v) || !v.length || v.some((c) => typeof c !== 'string' || !c.trim())) { errors.push(`${where}: "classes" must be a list of names, like ["index", "fx"].`); return null; }
    const list = v.map((c) => c.trim());
    if (known && !known.size) {
      if (!noDataWarned) warnings.push("The symbol lists didn't load, so the class names in this plan can't be checked. Check the plan again once they load.");
      noDataWarned = true;
    } else if (known) {
      const bad = list.filter((c) => !known.has(c));
      for (const c of bad) errors.push(`${where}: "${c}" isn't a class Risk Desk uses, so this rule would never apply. ${classNameHelp(c, known)}`);
      if (bad.length) return null;
    }
    return list;
  };
  const timeWindow = (w, where) => {
    if (!isObj(w) || !isHHMM(w.from) || !isHHMM(w.to)) { errors.push(`${where}: times must look like "22:15" (24-hour, IST).`); return null; }
    if (w.from === w.to) { errors.push(`${where}: the start and end times are the same.`); return null; }
    return { from: w.from, to: w.to };
  };

  str('id', 'The plan id');
  str('name', 'The plan name');
  if (p.version === undefined) plan.version = 1;
  else if (isNum(p.version) && p.version >= 0) plan.version = p.version;
  else errors.push('"version" must be a number.');
  for (const k of ['source', 'notes']) if (typeof p[k] === 'string') plan[k] = p[k].slice(0, 500);

  if (p.risk !== undefined) {
    const r = p.risk;
    if (!isObj(r)) errors.push('"risk" must be an object.');
    else {
      const out = {};
      for (const k of ['evalPctOfSize', 'fundedPctOfSize']) {
        if (!pct(r[k])) errors.push(`"risk.${k}" must be a percentage above 0 (0.5 means 0.5% of the account size).`);
        else { out[k] = r[k]; if (r[k] > 5) warnings.push(`"risk.${k}" is ${r[k]}% of the account size on one trade. Check it is not a typo.`); }
      }
      for (const k of ['roomDivisorEval', 'roomDivisorFunded']) {
        if (!(isNum(r[k]) && r[k] >= 1)) errors.push(`"risk.${k}" must be a number of 1 or more.`);
        else out[k] = r[k];
      }
      if (r.wholeDollars !== undefined) {
        if (typeof r.wholeDollars !== 'boolean') errors.push('"risk.wholeDollars" must be true or false.');
        else out.wholeDollars = r.wholeDollars;
      }
      for (const k of Object.keys(r)) if (!['evalPctOfSize', 'fundedPctOfSize', 'roomDivisorEval', 'roomDivisorFunded', 'wholeDollars'].includes(k)) warnings.push(`"risk.${k}" is not used by Risk Desk and was left out.`);
      plan.risk = out;
    }
  }
  if (p.halfSizeClasses !== undefined) { const c = classes(p.halfSizeClasses, '"halfSizeClasses"'); if (c) plan.halfSizeClasses = c; }
  if (p.maxTradesPerDay !== undefined) {
    if (!(Number.isInteger(p.maxTradesPerDay) && p.maxTradesPerDay >= 1)) errors.push('"maxTradesPerDay" must be a whole number, 1 or more.');
    else plan.maxTradesPerDay = p.maxTradesPerDay;
  }
  for (const k of ['noSecondTradeIfFirstLostMorePctOfSize', 'fundedStopForDayAtProfitPctOfSize']) {
    if (p[k] === undefined) continue;
    if (!pct(p[k])) errors.push(`"${k}" must be a percentage above 0.`);
    else plan[k] = p[k];
  }
  bool('blockIfOneMoreFullLossReachesDailyLimit');
  bool('requireStopAndTarget');
  if (p.noNewTradesIST !== undefined) {
    if (!Array.isArray(p.noNewTradesIST)) errors.push('"noNewTradesIST" must be a list.');
    else plan.noNewTradesIST = p.noNewTradesIST.map((w, i) => timeWindow(w, `"noNewTradesIST" item ${i + 1}`)).filter(Boolean);
  }
  if (p.onlyBetweenIST !== undefined) {
    if (!Array.isArray(p.onlyBetweenIST)) errors.push('"onlyBetweenIST" must be a list.');
    else plan.onlyBetweenIST = p.onlyBetweenIST.map((w, i) => {
      const where = `"onlyBetweenIST" item ${i + 1}`;
      const t = timeWindow(w, where), c = isObj(w) ? classes(w.classes, where) : null;
      return t && c ? { classes: c, ...t } : null;
    }).filter(Boolean);
  }
  if (p.noTradeDays !== undefined) {
    if (!Array.isArray(p.noTradeDays)) errors.push('"noTradeDays" must be a list.');
    else plan.noTradeDays = p.noTradeDays.map((d, i) => {
      const where = `"noTradeDays" item ${i + 1}`;
      if (!isObj(d) || !(Number.isInteger(d.weekdayIST) && d.weekdayIST >= 0 && d.weekdayIST <= 6)) { errors.push(`${where}: "weekdayIST" must be 0 (Sunday) to 6 (Saturday).`); return null; }
      const c = classes(d.classes, where);
      return c ? { classes: c, weekdayIST: d.weekdayIST } : null;
    }).filter(Boolean);
  }
  for (const k of Object.keys(p)) if (!PLAN_KEYS.includes(k)) warnings.push(`"${k}" is not a rule Risk Desk knows. It was left out.`);
  if (!RULE_KEYS.some((k) => plan[k] !== undefined)) errors.push('This plan has no rules in it.');
  return { ok: errors.length === 0, errors, warnings, plan: errors.length ? null : plan };
}

// ---------- Backup ----------
export async function exportAll(store, now = new Date()) {
  const data = {};
  for (const n of STORES) data[n] = await store.getAll(n);
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, app: 'Risk Desk', appVersion: APP_VERSION, exportedAt: now.toISOString(), data };
}

// opts.classIds: as for validatePersonalPlan, so a backup can't bring back a plan whose class names the
// app doesn't use.
export function validateBackup(obj, { classIds } = {}) {
  const errors = [], warnings = [];
  const fail = (m) => ({ ok: false, errors: [m], warnings, counts: null, data: null });
  if (!isObj(obj)) return fail('This file is not a Risk Desk backup.');
  if (obj.format !== BACKUP_FORMAT) return fail('This file is not a Risk Desk backup: its format mark is missing.');
  if (!isNum(obj.version) || obj.version < 1) return fail('This backup has no version number.');
  if (obj.version > BACKUP_VERSION) return fail('This backup was made by a newer Risk Desk. Update the app first.');
  if (!isObj(obj.data)) return fail('This backup has no data in it.');
  const data = {}, counts = {};
  for (const n of STORES) {
    const rows = obj.data[n] === undefined ? [] : obj.data[n];
    if (!Array.isArray(rows)) { errors.push(`${STORE_LABELS[n]}: not a list.`); data[n] = []; counts[n] = 0; continue; }
    const key = STORE_KEYS[n], seen = new Set();
    rows.forEach((r, i) => {
      if (!isObj(r)) errors.push(`${STORE_LABELS[n]}: item ${i + 1} is not a record.`);
      else if (typeof r[key] !== 'string' || !r[key]) errors.push(`${STORE_LABELS[n]}: item ${i + 1} has no ${key}.`);
      else if (seen.has(r[key])) errors.push(`${STORE_LABELS[n]}: "${r[key]}" appears twice.`);
      else seen.add(r[key]);
    });
    data[n] = rows;
    counts[n] = rows.length;
  }
  for (const k of Object.keys(obj.data)) if (!STORES.includes(k)) warnings.push(`"${k}" is not part of Risk Desk and will be skipped.`);
  for (const a of data.accounts) if (isObj(a)) for (const m of checkAccount(a)) errors.push(`Account "${a.name || a.id}": ${m}.`);
  for (const p of data.personalPlans) {
    if (!isObj(p)) continue;
    const v = validatePersonalPlan(p, { classIds });
    for (const m of v.errors) errors.push(`Personal plan "${p.name || p.id}": ${m}`);
    for (const m of v.warnings.filter((w) => /class names/.test(w)).map((w) => `Personal plans: ${w}`)) if (!warnings.includes(m)) warnings.push(m);
  }
  for (const j of data.journal) if (isObj(j) && !toDate(j.createdAt)) errors.push(`Journal entry ${j.id}: its time is missing or can't be read.`);
  const safety = data.settings.find((s) => isObj(s) && s.key === 'safety');
  if (safety) {
    const c = checkSafety({ ...DEFAULT_SETTINGS, ...(isObj(safety.value) ? safety.value : {}) });
    if (!c.ok) errors.push(...c.errors.map((m) => `Settings: ${m}`));
  }
  return { ok: errors.length === 0, errors, warnings, counts, data, exportedAt: obj.exportedAt || null, appVersion: obj.appVersion || null };
}

// ---------- Symbols and the trader's confirmations ----------
export const CFD_CONFIRMABLE = ['contract', 'profitCurrency', 'volumeStep', 'volumeMin', 'volumeMax'];
export const confKey = (fileId, symbol) => `${fileId}:${symbol}`;

export function symbolsOf(file) {
  return file && Array.isArray(file.symbols) ? file.symbols.filter((s) => s && typeof s.symbol === 'string' && s.symbol) : [];
}

// The plan's published futures fee for one symbol (DESIGN Q10), or null when the plan publishes none.
// The fee table sits on the plan; this only finds the entry, the engine decides how it is used.
export function planFeesFor(plan, symbolId) {
  if (!isObj(plan) || typeof symbolId !== 'string') return null;
  const table = plan.fees;
  if (table === undefined || table === null) return null;
  const meta = wrapperMeta(table);
  const map = meta ? unwrap(table) : table;
  if (!isObj(map) || !Object.prototype.hasOwnProperty.call(map, symbolId)) return null;
  const entry = map[symbolId];
  if (entry === undefined || entry === null) return null;
  // An entry without its own status carries the table's (value, status, source, checked).
  if (meta && !wrapperMeta(entry)) return { value: clone(entry), status: meta.status, source: meta.source, checked: meta.checked, ...(meta.note ? { note: meta.note } : {}) };
  return clone(entry);
}

// What the engine's resolveInstrument needs for one symbol of a symbol list (DESIGN 5): the data file's
// symbol entry, its class entry, the trader's saved values for it (the confirm sheet's record:
// specs, specsCheckedOn, realTrade) and the plan's published fee for it. Data lookup only: merging the
// values, settling disagreements and the real-trade check are the engine's job. Futures specs come from
// the exchange, so a futures symbol never takes the trader's MT5 values. Null when the symbol isn't there.
export function symbolInput(file, symbolId, conf = null, plan = null) {
  const symbol = symbolsOf(file).find((s) => s.symbol === symbolId);
  if (!symbol) return null;
  const classInfo = isObj(file.classes) && typeof symbol.class === 'string' && isObj(file.classes[symbol.class]) ? file.classes[symbol.class] : null;
  const confirmation = isObj(conf) && file.market === 'cfd' ? conf : null;
  return { symbol, classInfo, confirmation, planFees: file.market === 'futures' ? planFeesFor(plan, symbolId) : null };
}

// Why a symbol is blocked by its own values, in plain words, from the instrument the engine resolved
// (resolveInstrument lists them in inst.issues: a typed value that disagrees with the data file, a real
// trade that doesn't match, a profit currency that isn't the pair's). If the list is missing, a value the
// trader typed that ended up unconfirmed is reported with its note, so a block is never silent.
const FIELD_WORDS = { contract: 'Contract size', profitCurrency: 'Profit currency', volumeStep: 'Volume step', volumeMin: 'Minimal volume', volumeMax: 'Maximal volume' };
export function confirmationIssues(inst, conf) {
  const out = [];
  if (!inst) return out;
  if (Array.isArray(inst.issues)) {
    for (const m of inst.issues) if (typeof m === 'string' && m && !out.includes(m)) out.push(m);
    return out;
  }
  const specs = isObj(conf) && isObj(conf.specs) ? conf.specs : {};
  const hasCheck = isObj(conf) && isObj(conf.realTrade);
  for (const f of CFD_CONFIRMABLE) {
    const typed = specs[f] !== undefined && specs[f] !== null && specs[f] !== '';
    if (!typed && !(hasCheck && f === 'contract')) continue;
    const m = wrapperMeta(inst[f]);
    if (!m || m.status !== 'unconfirmed') continue;
    out.push(`${FIELD_WORDS[f]}: ${m.note || 'your value and the data file disagree, so this symbol is blocked.'}`);
  }
  return out;
}

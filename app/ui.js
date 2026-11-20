// Risk Desk: shared helpers for the screens.
// Formatting, IST time, CSV, escaping, the copy button, the sheet and small data helpers.
// Nothing here touches the page when the file is imported, so tests can load it in Node.
// No trading math lives here: sizes, floors and rule checks come from engine/calc.js.

export const APP_VERSION = '1.0.0';
export const IST_ZONE = 'Asia/Kolkata';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
export const MINUS = '−';

// ---------- Escaping ----------
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) => ESC[c]);
}

// ---------- Numbers ----------
const money2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// $25,000.50 · −$500.00 · +$120.00 (sign: true). Missing → grey dash text.
export function fmtMoney(x, { sign = false, dash = '—' } = {}) {
  if (!isNum(x)) return dash;
  const abs = Math.abs(x);
  const body = '$' + money2.format(abs);
  if (x < 0 && abs >= 0.005) return MINUS + body;
  return (sign && x >= 0.005 ? '+' : '') + body;
}

// Grouped number with fixed decimals: fmtNum(100000) → "100,000".
export function fmtNum(x, decimals = 0, dash = '—') {
  if (!isNum(x)) return dash;
  const s = x.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return s.startsWith('-') ? MINUS + s.slice(1) : s;
}

// A number shown as typed in a data file or a working step: up to 6 decimals, grouped.
export function fmtPlain(x) {
  if (!isNum(x)) return x === null || x === undefined ? '—' : String(x);
  const s = x.toLocaleString('en-US', { maximumFractionDigits: 6 });
  return s.startsWith('-') ? MINUS + s.slice(1) : s;
}

// Percent given in percent units: 0.5 → "0.5%", 1 → "1%".
export function fmtPct(p) {
  if (!isNum(p)) return '—';
  return `${Number(p.toFixed(4))}%`;
}

// Decimals of a volume step: 0.01 → 2, 1 → 0, 1e-7 → 7.
export function stepDecimals(step) {
  if (!isNum(step) || step <= 0) return 2;
  const s = String(step);
  if (s.includes('e-')) {
    const [m, e] = s.split('e-');
    return Number(e) + ((m.split('.')[1] || '').length);
  }
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

export function fmtSize(x, step) {
  if (!isNum(x)) return '—';
  return x.toFixed(stepDecimals(step));
}

// Plan sizes: 50000 → "$50K", 250001 → "$250,001".
export function fmtSizeK(n) {
  if (!isNum(n)) return '—';
  if (n >= 1000 && n % 1000 === 0) return `$${n / 1000}K`;
  return '$' + n.toLocaleString('en-US');
}

// The words that say which account this is, for the Trade status line and the Accounts list:
// firm · plan · size · stage. A stage whose name only repeats the plan's name is left out (Topstep's
// Trading Combine has one stage, also called Trading Combine). Blank bits are left out too.
export function accountBits(firmName, planName, size, stageName) {
  const key = (x) => String(x ?? '').trim().toLowerCase();
  const bits = [firmName, planName, fmtSizeK(size)];
  if (key(stageName) !== key(planName)) bits.push(stageName);
  return bits.map((x) => String(x ?? '').trim()).filter(Boolean);
}

export function fmtPrice(x, digits) {
  if (!isNum(x)) return '—';
  if (isNum(digits) && digits >= 0 && digits <= 10) return x.toFixed(digits);
  return String(x);
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + 's'}`;
}

// The number part of the engine's size text ("1.21 lots" → "1.21"), for the copy button.
export function sizeForCopy(sizeText, size, step) {
  const m = typeof sizeText === 'string' ? sizeText.trim().match(/^\d+(?:\.\d+)?/) : null;
  if (m) return m[0];
  return isNum(size) ? fmtSize(size, step) : '';
}

// ---------- Time (always shown in IST) ----------
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let partsFmt = null;

// An instant from a Date, ms or ISO text. Null for anything that isn't a real date: blank text, text that
// can't be read, NaN, or a number outside the range a Date can hold (|ms| > 8.64e15, like 1e20 in a
// backup). An Invalid Date object is never returned, so `!toDate(x)` always means "can't be read".
const MAX_DATE_MS = 8.64e15;
export function toDate(x) {
  if (x instanceof Date) return Number.isFinite(x.getTime()) ? x : null;
  if (typeof x === 'number') {
    if (!Number.isFinite(x) || Math.abs(x) > MAX_DATE_MS) return null;
    const d = new Date(x);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof x === 'string' && x.trim()) {
    const d = new Date(x);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

// Calendar parts of an instant in IST.
export function istInfo(when) {
  const d = toDate(when);
  if (!d) return null;
  if (!partsFmt) {
    partsFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: IST_ZONE, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
      hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
    });
  }
  const p = {};
  for (const { type, value } of partsFmt.formatToParts(d)) p[type] = value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    weekday: WEEKDAYS.indexOf(p.weekday), hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second),
  };
}

const pad2 = (n) => String(n).padStart(2, '0');
const h12 = (h, m) => `${((h + 11) % 12) + 1}:${pad2(m)} ${h < 12 ? 'AM' : 'PM'}`;

export function fmtTimeIST(when) {
  const p = istInfo(when);
  return p ? h12(p.hour, p.minute) : '—';
}
export function fmtDateIST(when) {
  const p = istInfo(when);
  return p ? `${p.day} ${MONTHS[p.month - 1]} ${p.year}` : '—';
}
export function fmtDateTimeIST(when) {
  const p = istInfo(when);
  return p ? `${p.day} ${MONTHS[p.month - 1]} ${p.year}, ${h12(p.hour, p.minute)} IST` : '—';
}
// "today 9:41 PM IST", "yesterday 9:41 PM IST", "17 Nov, 9:41 PM IST", "17 Nov 2025, 9:41 PM IST"
export function fmtWhenIST(when, now = new Date()) {
  const p = istInfo(when), n = istInfo(now);
  if (!p || !n) return '—';
  const t = `${h12(p.hour, p.minute)} IST`;
  const key = (x) => Date.UTC(x.year, x.month - 1, x.day);
  const days = Math.round((key(n) - key(p)) / 86400000);
  if (days === 0) return `today ${t}`;
  if (days === 1) return `yesterday ${t}`;
  if (p.year === n.year) return `${p.day} ${MONTHS[p.month - 1]}, ${t}`;
  return `${p.day} ${MONTHS[p.month - 1]} ${p.year}, ${t}`;
}
// 'YYYY-MM-DD' of the IST calendar day.
export function istDateISO(when) {
  const p = istInfo(when);
  return p ? `${p.year}-${pad2(p.month)}-${pad2(p.day)}` : '';
}
// 'HH:MM' in IST, 24-hour (for CSV and time inputs).
export function istTime24(when) {
  const p = istInfo(when);
  return p ? `${pad2(p.hour)}:${pad2(p.minute)}` : '';
}
// '22:15' → '10:15 PM'. Anything else is returned as typed.
export function hhmm12(text) {
  const m = typeof text === 'string' ? text.match(/^([01]\d|2[0-3]):([0-5]\d)$/) : null;
  return m ? h12(Number(m[1]), Number(m[2])) : String(text ?? '');
}
export function isHHMM(text) {
  return typeof text === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(text);
}
// '2026-11-10' → '10 Nov 2026' (a calendar date, no time zone involved).
export function fmtISODate(iso) {
  const m = typeof iso === 'string' ? iso.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  if (!m) return String(iso ?? '');
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}
export function isISODate(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, mo, d] = text.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
// 5h 49m · 12m · under 1m
export function fmtDuration(ms) {
  if (!isNum(ms)) return '—';
  const mins = Math.floor(Math.abs(ms) / 60000);
  if (mins < 1) return 'under 1m';
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h}h ${pad2(m)}m` : `${m}m`;
}

// ---------- CSV ----------
// One cell. Text that a spreadsheet would run as a formula gets a leading apostrophe.
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  if (/[",\r\n]|^\s|\s$/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
export function toCSV(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
export const csvMoney = (x) => (isNum(x) ? x.toFixed(2) : '');

// ---------- Value wrappers in the data files ----------
// A rule or spec is { value, status, source, checked, note }, or a plain value with those fields beside it.
export function isWrapper(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x) && typeof x.status === 'string';
}
export function unwrap(x) {
  if (!isWrapper(x)) return x;
  if ('value' in x) return x.value;
  const { status, source, checked, note, ...rest } = x;
  return rest;
}
export function wrapperMeta(x) {
  if (!isWrapper(x)) return null;
  return { status: x.status, source: x.source ?? null, checked: x.checked ?? null, note: x.note ?? null };
}

export const STATUS = {
  confirmed: { label: 'Confirmed on firm site', tone: 'pos' },
  'your-mt5': { label: 'From your MT5', tone: 'info' },
  'your-trades': { label: 'Matched your trades', tone: 'info' },
  conflict: { label: 'Firm pages disagree', tone: 'warn' },
  unconfirmed: { label: 'Unconfirmed', tone: 'neg' },
  sanity: { label: 'Typo check', tone: 'neutral' },   // only priceSanity: a wide range, not a firm rule (DESIGN 3)
};
export function statusInfo(status) {
  return STATUS[status] || { label: 'Unknown status', tone: 'neg' };
}
export function statusTag(status) {
  const s = statusInfo(status);
  return `<span class="tag tag-${s.tone}">${esc(s.label)}</span>`;
}
export function isUrl(s) {
  return typeof s === 'string' && /^https?:\/\/[^\s]+$/i.test(s.trim());
}

// ---------- The data index ----------
// data/index.json may be a list of paths, { files: [...] }, or { firms: [...], instruments: [...] }.
// Entries may be strings or { path } / { file } objects. Every path is kept inside data/ and must be .json.
export function dataPathsFromIndex(index) {
  const out = [];
  const add = (entry) => {
    let p = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? (entry.path || entry.file || entry.href) : null;
    if (typeof p !== 'string') return;
    p = p.trim().replace(/^\.\//, '');
    if (!p || p.includes('..') || p.includes('://') || p.startsWith('/') || !p.endsWith('.json')) return;
    if (!p.startsWith('data/')) p = 'data/' + p;
    if (p === 'data/index.json' || out.includes(p)) return;
    out.push(p);
  };
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach((e) => (Array.isArray(e) || (e && typeof e === 'object' && !e.path && !e.file && !e.href) ? walk(e) : add(e)));
    else if (v && typeof v === 'object') {
      for (const k of ['files', 'firms', 'instruments']) if (v[k]) walk(v[k]);
    }
  };
  walk(index);
  return out;
}

// ---------- Plans whose rules depend on the purchase date ----------
// Tradeify FX Daily is two plans (daily-legacy and daily-new). They are shown as one choice, and the
// purchase date picks the plan. Plans are grouped by the id before the last "-".
export function planFamilies(plans) {
  const fams = [];
  const byKey = new Map();
  for (const p of Array.isArray(plans) ? plans : []) {
    if (!p || typeof p.id !== 'string') continue;
    const cond = unwrap(p.purchased);
    const dated = !!(cond && (cond.before || cond.onOrAfter));
    const key = dated ? (p.family || p.id.replace(/-[^-]+$/, '')) : p.id;
    let f = byKey.get(key);
    if (!f) { f = { key, plans: [], byDate: false, name: '' }; byKey.set(key, f); fams.push(f); }
    f.plans.push(p);
    f.byDate = f.byDate || dated;
  }
  for (const f of fams) f.name = f.plans.length > 1 ? commonName(f.plans.map((p) => p.name || p.id)) : (f.plans[0].name || f.plans[0].id);
  return fams;
}
function commonName(names) {
  const words = names.map((n) => String(n).split(/\s+/));
  const out = [];
  for (let i = 0; i < words[0].length; i++) {
    const w = words[0][i];
    if (words.every((ws) => ws[i] === w)) out.push(w); else break;
  }
  let s = out.join(' ');
  // The names differ after the shared words: cut back to the last separator ("Daily (1-Step), bought" → "Daily (1-Step)").
  const cut = Math.max(s.lastIndexOf(','), s.lastIndexOf(';'), s.lastIndexOf(' ·'), s.lastIndexOf(' —'), s.lastIndexOf(' –'), s.lastIndexOf(' - '));
  if (cut > 0) s = s.slice(0, cut);
  s = s.replace(/[\s,;:·—–-]+$/, '').trim();
  const opens = (s.match(/\(/g) || []).length, closes = (s.match(/\)/g) || []).length;
  if (opens > closes) s = s.replace(/\s*\([^)]*$/, '').trim();
  return s || String(names[0]);
}
// The plan in a family that applies to a purchase date ('YYYY-MM-DD'). null when none or several match.
export function pickPlanByPurchase(plans, dateISO) {
  if (!isISODate(dateISO)) return null;
  const hits = (plans || []).filter((p) => {
    const c = unwrap(p.purchased);
    if (!c) return false;
    if (c.before && !(dateISO < c.before)) return false;
    if (c.onOrAfter && !(dateISO >= c.onOrAfter)) return false;
    return !!(c.before || c.onOrAfter);
  });
  return hits.length === 1 ? hits[0] : null;
}
export function describePurchase(cond) {
  const c = unwrap(cond);
  if (!c) return 'Any purchase date';
  if (c.before && c.onOrAfter) return `Bought from ${fmtISODate(c.onOrAfter)} to before ${fmtISODate(c.before)}`;
  if (c.before) return `Bought before ${fmtISODate(c.before)}`;
  if (c.onOrAfter) return `Bought on or after ${fmtISODate(c.onOrAfter)}`;
  return 'Any purchase date';
}

// ---------- Rules in plain words ----------
export const RULE_LABELS = {
  clock: 'Trading day', breach: 'Breach', sizes: 'Account sizes', purchased: 'Purchase date', target: 'Profit target',
  dailyLoss: 'Daily loss limit', maxLoss: 'Max loss limit', consistency: 'Best-day rule', news: 'News rule',
  marginCapPct: 'Margin limit', minHoldSeconds: 'Minimum hold', contractCaps: 'Contract limits', leverage: 'Leverage',
  commission: 'Commission', contract: 'Contract size', profitCurrency: 'Profit currency', volumeStep: 'Volume step',
  volumeMin: 'Smallest order', volumeMax: 'Largest order', tickSize: 'Tick size', tickValue: 'Tick value',
  quoteUnit: 'Price unit', exchange: 'Exchange', micro: 'Micro contract', capWeight: 'Counts toward the mini limit as',
  fees: 'Published fees per contract (round trip)', priceSanity: 'Usual price range (typo check)',
};
const NONE_TEXT = {
  target: 'No profit target', dailyLoss: 'No daily loss limit', maxLoss: 'No max loss limit', consistency: 'No best-day rule',
  news: 'No news rule', marginCapPct: 'No firm margin limit', minHoldSeconds: 'No minimum hold', contractCaps: 'No contract limits',
  volumeMax: 'No largest order set', purchased: 'Any purchase date', micro: 'No micro contract', commission: 'No commission',
};
export function zoneName(zone) {
  if (!zone || typeof zone !== 'string') return '';
  if (zone === 'UTC' || zone === 'Etc/UTC') return 'UTC';
  if (zone === IST_ZONE) return 'IST';
  return zone.split('/').pop().replace(/_/g, ' ') + ' time';
}
const pctOf = (v) => (isNum(v) ? fmtPct(v) : '?%');

export function describeValue(key, v, status) {
  if (v === null || v === undefined) {
    if (status === 'unconfirmed') return 'Not known yet';
    return NONE_TEXT[key] || 'None';
  }
  try {
    switch (key) {
      case 'sizes': return Array.isArray(v) ? v.map(fmtSizeK).join(', ') : String(v);
      case 'purchased': return describePurchase(v);
      case 'target': return isNum(v.pctOfSize) ? `${pctOf(v.pctOfSize)} of the account size` : generic(v);
      case 'dailyLoss': {
        const from = v.from === 'closedBalanceAtReset' ? 'your closed balance at the daily reset'
          : v.from === 'higherOfBalanceEquityAtReset' ? 'the higher of your balance and equity at the daily reset'
          : String(v.from || 'the daily reset level');
        return `${pctOf(v.pctOfSize)} of the account size below ${from}.`;
      }
      case 'maxLoss':
        if (v.type === 'static') return `${pctOf(v.pctOfSize)} of the account size below the starting balance. It never moves.`;
        if (v.type === 'trailing') {
          return `${pctOf(v.pctOfSize)} of the account size below your highest closed balance. It stops rising at the starting balance.`
            + (v.lockOnPayoutRequest ? ' It locks at the starting balance on your first payout request.' : '');
        }
        return generic(v);
      case 'consistency':
        return `Best day at most ${pctOf(v.pctBestDay)} of total profit (${v.appliesTo === 'payout' ? 'to request a payout' : 'in the evaluation'}). Shown for information. It never blocks a trade.`;
      case 'news': {
        const who = v.appliesTo === 'funded' ? 'Funded accounts' : v.appliesTo === 'all' ? 'All stages' : String(v.appliesTo || 'Accounts');
        return `${who}: no opening, closing or changing trades from ${v.minutesBefore} min before to ${v.minutesAfter} min after high-impact news for the symbol's currencies.`;
      }
      case 'marginCapPct': return `Margin use above ${pctOf(v)} is not allowed.`;
      case 'minHoldSeconds': return `Hold each trade at least ${v >= 60 && v % 60 === 0 ? plural(v / 60, 'minute') : plural(v, 'second')}. A reminder: it can't be checked before the trade.`;
      case 'contractCaps': return describeCaps(v);
      case 'clock': return `The day starts at ${v.dayStartsAt} ${zoneName(v.zone)}.`;
      case 'breach': {
        const a = v.touchIsBreach ? 'Touching a floor counts as a breach' : 'Going below a floor is a breach';
        const b = v.checkedOn === 'equity' ? 'checked on equity, so open trades count' : v.checkedOn ? `checked on ${v.checkedOn}` : '';
        return b ? `${a}, ${b}.` : `${a}.`;
      }
      case 'leverage': return isNum(v) ? `1:${v}` : generic(v);
      case 'commission': return describeCommission(v);
      case 'contract': return isNum(v) ? `${fmtPlain(v)} units per lot` : generic(v);
      case 'volumeStep': case 'volumeMin': case 'volumeMax': return isNum(v) ? `${fmtPlain(v)} lots` : generic(v);
      case 'tickValue': return isNum(v) ? `${fmtMoney(v)} a tick` : generic(v);
      case 'capWeight': return isNum(v) ? `${fmtPlain(v)} of a mini` : generic(v);
      case 'micro': return v ? String(v) : 'No micro contract';
      case 'fees': return describeFees(v);
      case 'priceSanity': return isNum(v.min) && isNum(v.max) ? `${fmtPlain(v.min)} to ${fmtPlain(v.max)}` : generic(v);
      default: return generic(v);
    }
  } catch {
    return generic(v);
  }
}
function describeCommission(c) {
  if (!c || typeof c !== 'object') return generic(c);
  const a = c.amount;
  switch (c.type) {
    case 'perLotPerSide': return `${fmtMoney(a)} per lot, charged when you open and again when you close`;
    case 'perLotRoundTrip': return `${fmtMoney(a)} per lot, round trip`;
    case 'pctNotionalPerSide': return `${pctOf(a)} of the trade's value, when you open and again when you close`;
    case 'perContractRoundTrip': return `${fmtMoney(a)} per contract, round trip`;
    case 'perContractPerSide': return `${fmtMoney(a)} per contract, charged when you open and again when you close`;
    case 'none': return 'No commission';
    default: return generic(c);
  }
}
// A plan's published futures fees: { ES: 3.78, … } (a number is the round trip per contract) or commission objects.
function describeFees(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return generic(v);
  const parts = Object.entries(v).map(([sym, x]) => `${sym} ${isNum(x) ? fmtMoney(x) : x && typeof x === 'object' ? describeCommission(x) : generic(x)}`);
  return parts.length ? `${parts.join(', ')}.` : 'None';
}
function describeCaps(v) {
  const parts = [];
  if (v.bySize && typeof v.bySize === 'object') {
    for (const [size, cap] of Object.entries(v.bySize)) {
      const bits = [];
      if (cap && isNum(cap.minis)) bits.push(plural(cap.minis, 'mini'));
      if (cap && isNum(cap.micros)) bits.push(plural(cap.micros, 'micro'));
      parts.push(`${fmtSizeK(Number(size))}: ${bits.join(' or ') || generic(cap)}`);
    }
  }
  if (v.productCaps && typeof v.productCaps === 'object') {
    for (const [sym, caps] of Object.entries(v.productCaps)) {
      const bits = caps && typeof caps === 'object' ? Object.entries(caps).map(([s, n]) => `${n} at ${fmtSizeK(Number(s))}`) : [String(caps)];
      parts.push(`${sym}: ${bits.join(', ')}`);
    }
  }
  if (v.mixAllowed === true) parts.push('Minis and micros can be held together');
  if (v.mixAllowed === false) parts.push('Minis and micros can\'t be held together');
  return parts.length ? parts.join('; ') + '.' : generic(v);
}
function generic(v) {
  if (v === null || v === undefined) return 'None';
  if (typeof v !== 'object') return typeof v === 'number' ? fmtPlain(v) : String(v);
  if (Array.isArray(v)) return v.map(generic).join(', ');
  return Object.entries(v).map(([k, x]) => `${k} ${typeof x === 'object' && x !== null ? JSON.stringify(x) : x}`).join(', ');
}

// Which USD price converts a profit currency (conversionNeed), which values a size still lacks
// (sizeSpecGaps), the trader's values merged into a symbol (resolveInstrument) and the real-trade check
// (checkFill) live in engine/calc.js, like every other calculation. The screens only show what they return.

// ---------- Small DOM helpers (only used in the browser) ----------
export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export function newId(prefix = '') {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return prefix + c.randomUUID();
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'offscreen';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

let toastTimer = 0;
export function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// A bottom sheet on phones, a centred panel on wider screens. Returns a close function.
let sheetCount = 0;
export function openSheet({ title, html, onMount, onClose }) {
  const dlg = document.createElement('dialog');
  const id = `sheet-title-${++sheetCount}`;
  dlg.className = 'sheet';
  dlg.setAttribute('aria-labelledby', id);
  dlg.innerHTML = `<div class="sheet-head"><h2 class="sheet-title" id="${id}">${esc(title)}</h2>`
    + `<button type="button" class="icon-btn" data-close aria-label="Close">${ICONS.close}</button></div>`
    + `<div class="sheet-body">${html}</div>`;
  document.body.appendChild(dlg);
  let closed = false;
  const close = () => { if (dlg.open) dlg.close(); else finish(); };
  const finish = () => { if (closed) return; closed = true; dlg.remove(); if (onClose) onClose(); };
  dlg.addEventListener('close', finish);
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === dlg) close(); });
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  if (onMount) onMount(dlg.querySelector('.sheet-body'), close);
  return close;
}

// Download a text file made on the device (nothing is uploaded).
export function downloadFile(name, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// Outline icons, 20px, one stroke width. Used in the navigation and a few controls.
const svg = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const ICONS = {
  trade: svg('<path d="M4 19h16"/><path d="M7 15V9"/><path d="M12 15V5"/><path d="M17 15v-4"/>'),
  accounts: svg('<rect x="3.5" y="6" width="17" height="13" rx="2.5"/><path d="M3.5 10h17"/><path d="M8 6V4.5h8V6"/>'),
  journal: svg('<path d="M6 3.5h10.5a2 2 0 0 1 2 2v15H8a2 2 0 0 1-2-2z"/><path d="M6 18.5a2 2 0 0 1 2-2h10.5"/><path d="M10 8h5"/>'),
  rules: svg('<path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>'),
  backup: svg('<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/>'),
  close: svg('<path d="M6 6l12 12"/><path d="M18 6 6 18"/>'),
  copy: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>'),
  plus: svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  link: svg('<path d="M14 5h5v5"/><path d="M19 5l-8 8"/><path d="M17 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 18.5v-10A1.5 1.5 0 0 1 5.5 7H10"/>'),
};

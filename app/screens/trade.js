// Trade screen: pick an account → enter the trade → see the size, GO or NO TRADE, and the room left.
// Every number in the result card comes from the engine (ctx.evaluate → engine/calc.js evaluateTrade), and
// every symbol is resolved by the engine (ctx.resolveSymbol → engine/calc.js resolveInstrument).
// Prices live in memory only. They are cleared when the account or symbol changes, after logging, when the
// firm's trading day changes, and after 30 minutes without changes: on every 30-second tick, whenever the
// screen is shown again, and before a trade is logged.
// Copy and Log trade work the trade out again at the tap (the time windows move with the clock), and act
// only when the engine still gives the same GO and size that the card shows.
// The account chips are drawn before anything that can fail, so another account can always be picked.

import {
  esc, fmtMoney, fmtPct, fmtPlain, fmtPrice, fmtTimeIST, fmtWhenIST, fmtDuration, sizeForCopy,
  unwrap, wrapperMeta, copyText, newId, ICONS, plural, hhmm12, describeValue, toDate, accountBits,
} from '../ui.js';
import { symbolsOf, confKey, numbersState, unknownPlanClasses, confirmationIssues } from '../store.js';
import { openConfirmSheet } from './rules.js';

const STALE_MS = 30 * 60 * 1000;
const S = {
  accountId: null,
  symKey: null,
  keepName: null,
  f: blank(),
  lastInput: 0,               // when a price box last changed (Date.now())
  fDayKey: null,              // the firm's trading day when the first price was typed
  lastPrices: new Map(),      // last entry typed per symbol this session: only for the engine's price check
  // The line under the symbol box. Text: why the prices were cleared. Or the trade just logged, as
  // { accountId, at, sizeText, unit, symbol }: its words are made when the screen is drawn (noteText), with
  // the account's name as it is then, and it goes once the account's numbers are no longer older than it.
  note: '',
  focus: null,
  picking: false,             // true while a picked symbol's boxes are being drawn (see holdEntryKeys)
  loggedSig: '',              // the card last logged: its account (with the account's update and log times), symbol, prices
  logging: false,             // a Log trade tap is being saved: a second tap does nothing
  convConfirmed: '',          // the conversion price the trader said is right (memory only; cleared with the box)
  // Treasury futures: the entry, stop and target text the trader said are decimal prices, as
  // "entry|stop|target" (memory only). The engine takes it only while it matches the three boxes exactly.
  // Cleared whenever one of those boxes, the symbol or the account changes, when prices are cleared, and
  // after Log trade.
  decConfirmed: '',
  restores: 0,                // backups brought back so far (ctx.session.restores), to notice a new one
};
let current = null;           // { root, ctx, view, last } of the screen on display
let cardVisible = true;       // whether the result card is on screen (for the phone's mini bar)

function blank() {
  return { entry: '', stop: '', target: '', buffer: '', conversion: '', fees: '', risk: '' };
}
const fieldsBlank = () => Object.values(S.f).every((x) => !String(x).trim());
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));

const CAP_WORDS = { room: 'the room above the floor', margin: 'the margin limit', firmCap: "the firm's contract limit", volumeMax: 'the largest order the platform takes' };
// What follows a percentage ("0.5%" from fmtPct, which already ends in %): "0.5% of the account size".
const METHOD_WORDS = { pctOfSize: ' of the account size', pctOfBalance: ' of the balance', usd: 'fixed dollars', personalPlan: 'from your plan' };
const CLEAR_NOTES = {
  day: 'A new trading day started, so the prices were cleared.',
  old: "Prices were cleared after 30 minutes without changes, so an old price can't size a new trade.",
};
// What the trader can do about a NO TRADE reason (the engine's message says why).
const ACCOUNT_CODES = new Set(['STALE_BALANCES', 'ACCOUNT_INVALID', 'RISK_MAX_NOT_SET', 'RISK_NOT_SET', 'BREACHED', 'PURCHASE_DATE_UNCLEAR']);
const PLAN_CODES = new Set(['PLAN_INVALID']);
const PRICE_CODES = new Set(['PRICE_CHECK', 'PRICE_JUMP', 'STOP_EQUALS_ENTRY', 'TARGET_WRONG_SIDE', 'TARGET_REQUIRED']);
const CONVERSION_CODES = new Set(['CONVERSION_SUSPECT', 'CONVERSION_MISSING', 'CONVERSION_RANGE']);
// A conversion price the engine doubts (outside its usual range, or close to the trade's own price). The
// trader can say it is right: the engine then lets it through with a notice (trade.conversionConfirmed).
const DOUBTED_CONVERSION = new Set(['CONVERSION_RANGE', 'CONVERSION_SUSPECT']);
const isPriceCode = (code) => PRICE_CODES.has(code) || /^PRICE_|DECIMAL|GRID|TREASURY|32ND/.test(String(code));
const PRICE_BOXES = new Set(['entry', 'stop', 'target']);
// The three price boxes as typed, trimmed and joined: what "These are decimal prices" confirms (DESIGN 5.5).
const pricesTyped = () => [S.f.entry, S.f.stop, S.f.target].map((x) => String(x ?? '').trim()).join('|');
const hasReason = (res, code) => !!(res && Array.isArray(res.reasons) && res.reasons.some((r) => r && r.code === code));

// ---------- Loading what the screen needs ----------
// The account on the chips. Never throws, so the chips can always be drawn.
function pickAccount(accounts) {
  if (S.accountId && !accounts.some((a) => a.id === S.accountId)) {
    S.accountId = null; S.symKey = null; S.f = blank(); S.fDayKey = null; S.note = ''; S.loggedSig = ''; S.convConfirmed = ''; S.decConfirmed = '';
  }
  if (!S.accountId && accounts.length === 1) S.accountId = accounts[0].id;
}

async function loadView(ctx, accounts) {
  pickAccount(accounts);
  const acct = accounts.find((a) => a.id === S.accountId) || null;
  const firm = acct ? ctx.data.firmById.get(acct.firmId) || null : null;
  const plan = firm && Array.isArray(firm.plans) ? firm.plans.find((p) => p && p.id === acct.planId) || null : null;
  const stage = plan && Array.isArray(plan.stages) ? plan.stages.find((s) => s && s.id === acct.stageId) || null : null;
  const fileIds = firm ? [].concat(firm.instruments || []).filter((x) => typeof x === 'string') : [];
  const files = fileIds.map((id) => ctx.data.instrumentsById.get(id)).filter(Boolean);
  const confs = new Map((await ctx.store.getAll('confirmations')).map((c) => [c.key, c]));
  const symbols = [];
  for (const file of files) {
    for (const s of symbolsOf(file)) {
      const key = confKey(file.id, s.symbol);
      const conf = confs.get(key) || null;
      const inst = ctx.resolveSymbol(file, s.symbol, conf, plan);
      const cls = file.classes && typeof file.classes === 'object' ? file.classes[s.class] : null;
      symbols.push({
        key, fileId: file.id, symbol: s.symbol, name: s.name || '', classId: typeof s.class === 'string' ? s.class : '',
        classLabel: (cls && cls.label) || s.class || 'Other', market: file.market, data: s, conf, inst,
        gaps: ctx.specGaps(inst, file.market), issues: confirmationIssues(inst, conf),
        // A futures product the firm's own list leaves out of this plan (the engine decides): "Not allowed".
        banned: file.market === 'futures' && !!plan && ctx.productBanned(plan, acct.size, s.symbol),
      });
    }
  }
  if (S.symKey && !symbols.some((x) => x.key === S.symKey)) {
    // After an account switch, keep the same symbol name if this account's list has it.
    const same = S.keepName ? symbols.find((x) => x.symbol === S.keepName) : null;
    S.symKey = same ? same.key : null;
  }
  S.keepName = null;
  let personalPlan = null;
  if (acct && acct.personalPlanId) personalPlan = await ctx.store.get('personalPlans', acct.personalPlanId);
  return { accounts, acct, firm, plan, stage, fileIds, files, symbols, personalPlan, sym: symbols.find((x) => x.key === S.symKey) || null };
}

// ---------- Old prices ----------
// Why the typed prices can't be used any more: 'day' (typed on an earlier trading day of this account's
// firm) or 'old' (30 minutes without a change, or no time known). Null when they are fine or blank.
function expiry(ctx, v) {
  if (fieldsBlank()) return null;
  if (S.fDayKey && v && v.firm) {
    const fd = ctx.firmDayFor(v.firm);
    if (fd && fd.dayKey !== S.fDayKey) return 'day';
  }
  if (!S.lastInput || Date.now() - S.lastInput > STALE_MS) return 'old';
  return null;
}
function clearPrices(why, v) {
  rememberPrice(v);
  S.f = blank();
  S.fDayKey = null;
  S.lastInput = 0;
  S.loggedSig = '';
  S.convConfirmed = '';
  S.decConfirmed = '';
  S.note = CLEAR_NOTES[why] || '';
}

// The line under the symbol box, in words. The note about a logged trade is for the account it was logged
// on, while that account's numbers are still older than the trade. Once they have been updated (or the
// account isn't the one on screen any more) the note is dropped.
function noteText(v) {
  const n = S.note;
  if (!n) return '';
  if (typeof n === 'string') return n;
  const a = v ? v.acct : null;
  const at = toDate(n.at);
  const updated = a ? toDate(a.updatedAt) : null;
  if (!a || a.id !== n.accountId || !at || (updated && updated >= at)) { S.note = ''; return ''; }
  return `Logged ${n.sizeText} ${n.unit} ${n.symbol}. Prices are cleared. Before the next trade, update ${a.name || 'this account'}: balance, equity and other open trades.`;
}

// ---------- Render ----------
export async function render(root, ctx) {
  const accounts = (await ctx.store.getAll('accounts')).sort(byName);
  if (!accounts.length) {
    current = null;
    root.innerHTML = `<section class="card first-run">
      <h2 class="card-title">Add your first account</h2>
      <p>Pick the firm, the plan, the size and today's numbers. Then come back here to size a trade.</p>
      <a class="btn btn-primary" href="#/accounts/new">Add an account</a>
    </section>`;
    return null;
  }
  // A backup was brought back since this screen was last drawn: the accounts and the journal are other
  // ones now, so the note about a logged trade and the "already logged" check no longer apply.
  const restores = ctx.session && Number.isInteger(ctx.session.restores) ? ctx.session.restores : 0;
  if (restores !== S.restores) { S.restores = restores; S.note = ''; S.loggedSig = ''; }
  pickAccount(accounts);
  let v = null, body;
  try {
    v = await loadView(ctx, accounts);
    const why = expiry(ctx, v);
    if (why) clearPrices(why, v);
    body = bodyHtml(ctx, v);
  } catch (e) {
    console.error(e);
    v = null;
    body = `<section class="card"><p class="msg msg-neg">This account couldn't be shown, so nothing is sized for it. Pick another account, or open it in Accounts and save it again. (${esc(e && e.message ? e.message : 'unknown error')})</p></section>`;
  }
  current = v ? { root, ctx, view: v, last: null } : null;
  root.innerHTML = `${chipsHtml(accounts)}${body}<button type="button" class="minibar" id="minibar" hidden></button>`;
  wire(root, ctx);
  if (!v) return null;
  paint();
  if (S.focus) {
    const el = root.querySelector(`[data-f="${S.focus}"]`);
    S.focus = null;
    if (el) {
      el.focus({ preventScroll: false });
      // Digits held while the screen was drawn (holdEntryKeys) are already in the box: typing goes on after them.
      if (el.value && typeof el.setSelectionRange === 'function') { try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* not a text box */ } }
    }
  }
  return setupMiniBar(root);
}

function chipsHtml(accounts) {
  return `<div class="chips-row" role="radiogroup" aria-label="Account">${accounts.map((a) =>
    `<button type="button" class="chip" role="radio" aria-checked="${a.id === S.accountId}" data-acct="${esc(a.id)}">${esc(a.name || 'Account')}</button>`).join('')}
    <a class="chip chip-ghost" href="#/accounts/new">${ICONS.plus}<span>Add</span></a></div>`;
}

function bodyHtml(ctx, v) {
  return `
    <div class="acct-status" id="acct-status">${statusHtml(ctx, v)}</div>
    <div class="trade-grid">
      <section class="result-wrap" aria-label="Order size">
        <article class="card result" id="result" tabindex="-1" aria-live="polite" aria-atomic="false"></article>
      </section>
      <section class="card inputs" aria-label="Your trade">${v.acct ? inputsHtml(ctx, v) : '<p class="muted">Pick an account to start.</p>'}</section>
    </div>`;
}

function statusHtml(ctx, v) {
  const a = v.acct;
  if (!a) return '<p class="muted">Pick the account this trade is for.</p>';
  if (!v.firm) return `<p class="msg msg-neg">The rules for this account's firm didn't load, so nothing can be sized for it.</p>`;
  const now = new Date();
  const fd = ctx.firmDayFor(v.firm, now);
  // A stage that only repeats the plan's name is left out ("Topstep · Trading Combine · $50K").
  const bits = accountBits(v.firm.name || v.firm.id, v.plan ? v.plan.name || v.plan.id : 'plan missing', a.size, v.stage ? v.stage.name || v.stage.id : 'stage missing');
  const lines = [`<p class="status-line">${bits.map(esc).join(' · ')}</p>`];
  const fl = v.plan ? ctx.floorsFor(a, v.plan, v.firm) : null;
  const facts = [];
  if (fl && isNum(fl.room)) {
    const b = bindingOf(fl);
    facts.push(`Room <b class="num">${fmtMoney(fl.room)}</b>${b && b.name ? ` above the ${esc(String(b.name).toLowerCase())} floor` : ''}`);
  }
  facts.push(toDate(a.updatedAt) ? `numbers updated ${esc(fmtWhenIST(a.updatedAt, now))}` : 'no numbers typed yet');
  lines.push(`<p class="status-line muted">${facts.join(' · ')}</p>`);
  const st = numbersState(a, fd, now);
  if (st) {
    const why = st.kind === 'none' ? 'Type the balance and reset values first.'
      : st.kind === 'future' ? `These numbers carry a time in the future (${fmtWhenIST(st.at, now)}). Check the phone's clock, then save them again.`
      : st.kind === 'beforeReset' ? `These numbers were typed before today's reset at ${fmtTimeIST(fd.lastResetUTC)} IST.`
      : st.kind === 'badLog' ? "The time of your last logged trade can't be read. Update the balance, equity and other open trades."
      : `You logged a trade ${fmtWhenIST(st.at, now)}, after these numbers were typed. Update the balance, equity and other open trades.`;
    lines.push(`<p class="msg msg-warn">${esc(why)} <a href="#/accounts/${encodeURIComponent(a.id)}/trade">Update numbers</a></p>`);
  }
  const day = [];
  day.push(fd ? `Day resets ${esc(fmtTimeIST(fd.nextResetUTC))} IST, in ${esc(fmtDuration(fd.nextResetUTC - now))}` : "Can't tell when this firm's day resets");
  day.push(`${plural(Number.isInteger(a.tradesToday) ? a.tradesToday : 0, 'trade')} today`);
  if (isNum(a.todayResult) && a.todayResult !== 0) day.push(`today ${fmtMoney(a.todayResult, { sign: true })}`);
  lines.push(`<p class="status-line muted">${day.join(' · ')}</p>`);
  if (Array.isArray(a.newsToday) && a.newsToday.length) {
    const news = [...a.newsToday].sort((x, y) => String(x.timeIST).localeCompare(String(y.timeIST)))
      .map((n) => `${esc(hhmm12(n.timeIST))} ${esc(n.currency)}`).join(', ');
    lines.push(`<p class="status-line muted">News today (IST): ${news}</p>`);
  }
  return lines.join('');
}

function bindingOf(lim) {
  if (!lim) return null;
  const b = lim.binding;
  if (b && typeof b === 'object') return b;
  if (typeof b === 'string' && Array.isArray(lim.floors)) return lim.floors.find((f) => f && f.key === b) || { name: b };
  return null;
}

// ---------- Inputs ----------
function inputsHtml(ctx, v) {
  const sym = v.sym;
  const market = v.firm ? v.firm.market : 'cfd';
  const parts = [];
  parts.push(`<div class="field picker" id="picker">
    <label for="sym-q">Symbol</label>
    <input id="sym-q" type="search" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false"
      role="combobox" aria-expanded="false" aria-controls="sym-list" aria-autocomplete="list"
      value="${esc(sym ? sym.symbol : '')}" placeholder="Search symbols">
    <div class="pick-list" id="sym-list" role="listbox" aria-label="Symbols" hidden></div>
    ${sym ? symbolLine(sym) : (v.symbols.length ? '' : '<p class="msg msg-neg">No symbols loaded for this firm.</p>')}
  </div>`);
  const note = noteText(v);
  if (note) parts.push(`<p class="msg msg-info" id="trade-note">${esc(note)}</p>`);
  if (!sym) return parts.join('');
  const inst = sym.inst || {};
  const fx = sym.classId === 'fx';
  const conv = market === 'cfd' ? ctx.conversionNeed(unwrap(inst.profitCurrency), sym.data.base, sym.data.quote) : null;
  const targetRequired = !!(v.personalPlan && v.personalPlan.requireStopAndTarget);
  const unitLine = market === 'futures' ? quoteUnitText(sym) : '';
  const priceHelp = unitLine ? 'quote-unit' : '';
  parts.push('<div class="fields">');
  parts.push(field('entry', 'Entry price', { describedBy: priceHelp }));
  parts.push(field('stop', 'Stop price', { describedBy: priceHelp }));
  if (unitLine) parts.push(`<p class="hint quote-unit wide" id="quote-unit">${esc(unitLine)}</p>`);
  parts.push(field('target', targetRequired ? 'Target price (your plan needs one)' : 'Target price (optional)', { describedBy: priceHelp }));
  const fee = market === 'futures' ? describeFee(sym) : '';
  if (market === 'cfd') parts.push(field('buffer', fx ? 'Spread buffer (pips, optional)' : 'Spread buffer (price, optional)'));
  if (market === 'futures') parts.push(field('fees', fee ? 'Fees per contract, round trip ($, optional)' : 'Fees per contract, round trip ($)', { money: true }));
  if (conv) parts.push(field('conversion', conv.pair ? `${conv.pair} price now` : `${conv.currency} to USD price`, { extra: 'wide' }));
  parts.push('</div>');
  const hints = ['A stop below the entry means a buy; above it, a sell.'];
  if (conv && conv.pair) hints.push(`Profit on ${sym.symbol} is in ${conv.currency}. Copy the current ${conv.pair} price from MT5 so it can be turned into USD.`);
  if (market === 'cfd') hints.push('Buys fill at the ask and stops trigger on the bid. If your prices come from the bid chart, add the spread as a buffer.');
  if (market === 'futures') {
    hints.push(fee ? `Blank fees use the published fee: ${fee}. A typed fee below it is not used.` : 'Type your round-trip fee per contract from the firm\'s or broker\'s fee page. There is no size without it.');
  }
  parts.push(`<p class="hint">${hints.map(esc).join(' ')}</p>`);
  parts.push(riskHtml(v));
  return parts.join('');
}

// The unit a futures price is typed in, next to the price boxes. Treasury prices are quoted in 32nds on
// most platforms but are typed here as decimals: the same instruction the engine gives when a price is off
// its tick grid (PRICE_OFF_GRID), and the card shows each price back in 32nds (PRICE_32NDS).
function quoteUnitText(sym) {
  const w = sym.inst && sym.inst.quoteUnit !== undefined ? sym.inst.quoteUnit : sym.data.quoteUnit;
  const unit = unwrap(w);
  const m = wrapperMeta(w);
  const treasury = sym.classId === 'rates' && /32/.test(String(unit ?? ''));
  const bits = [];
  if (typeof unit === 'string' && unit) bits.push(`${sym.symbol} prices are in ${unit}.`);
  if (treasury) bits.push("Type Treasury prices as decimals with at least 4 decimal places: 110'16 = 110.5.");
  else if (m && m.note) bits.push(m.note);
  return bits.join(' ');
}

// The published futures fee, in words, when the data has a usable one (the engine applies it).
function describeFee(sym) {
  const inst = sym.inst || {};
  const w = inst.commission !== undefined ? inst.commission : inst.classInfo && inst.classInfo.commission !== undefined ? inst.classInfo.commission : sym.data.commission;
  const c = unwrap(w);
  const st = w && typeof w === 'object' && typeof w.status === 'string' ? w.status : 'plain';
  if (!c || typeof c !== 'object' || st === 'unconfirmed') return '';
  return describeValue('commission', c);
}

function symbolLine(sym) {
  const i = sym.inst;
  const bits = [sym.name, sym.classLabel].filter(Boolean);
  if (!i) {
    return `<p class="sym-line">${bits.map(esc).join(' · ')}</p><p class="msg msg-neg">Risk Desk couldn't read the values for ${esc(sym.symbol)}, so it can't be sized. Reload the page.</p>`;
  }
  const contract = unwrap(i.contract), step = unwrap(i.volumeStep), tick = unwrap(i.tickSize), tv = unwrap(i.tickValue);
  if (sym.market === 'cfd' && isNum(contract)) bits.push(`1 lot = ${fmtPlain(contract)}`);
  if (sym.market === 'cfd' && isNum(step)) bits.push(`step ${fmtPlain(step)}`);
  if (sym.market === 'futures' && isNum(tick)) bits.push(`tick ${fmtPlain(tick)}`);
  if (sym.market === 'futures' && isNum(tv)) bits.push(`${fmtMoney(tv)} a tick`);
  const needs = sym.banned ? '<span class="tag tag-neg">Not allowed</span>' : sym.gaps.length ? `<span class="tag tag-neg">Needs your MT5 values</span>` : '';
  const btn = sym.market === 'cfd' ? `<button type="button" class="link-btn" data-act="confirm">${sym.gaps.length ? 'Confirm values' : 'Symbol details'}</button>` : '';
  const issues = sym.issues.map((m) => `<p class="msg msg-neg">${esc(m)}</p>`).join('');
  return `<p class="sym-line">${bits.map(esc).join(' · ')} ${needs} ${btn}</p>${issues}`;
}

function field(key, label, { money = false, extra = '', describedBy = '' } = {}) {
  return `<div class="field ${extra}">
    <label for="f-${key}">${esc(label)}</label>
    <input id="f-${key}" data-f="${key}" data-money="${money ? '1' : ''}" type="text" inputmode="decimal" autocomplete="off" autocorrect="off" spellcheck="false" value="${esc(S.f[key])}" aria-describedby="f-${key}-msg${describedBy ? ` ${describedBy}` : ''}">
    <p class="field-msg" id="f-${key}-msg"></p>
  </div>`;
}

function riskHtml(v) {
  const r = v.acct.riskMethod || {};
  let how;
  if (r.type === 'personalPlan') how = v.personalPlan ? `your plan, ${esc(v.personalPlan.name)}` : 'your personal plan (missing on this device)';
  else if (r.type === 'usd') how = `<span class="num">${fmtMoney(r.value)}</span> a trade`;
  else if (r.type === 'pctOfSize' || r.type === 'pctOfBalance') how = `<span class="num">${fmtPct(r.value)}</span>${METHOD_WORDS[r.type]}`;
  else how = 'not set';
  const max = isNum(r.maxPctOfSize) ? `Max ${fmtPct(r.maxPctOfSize)} of the account size.` : 'No max set yet.';
  return `<div class="risk">
    <p class="risk-line">Risk from the account: <b>${how}</b>. <span class="muted">${max}</span> <a href="#/accounts/${encodeURIComponent(v.acct.id)}/trade">Change</a></p>
    ${field('risk', 'Risk on this trade instead ($, optional, up to your max)', { money: true })}
  </div>`;
}

// ---------- The result ----------
const failResult = (message, fix = '') => ({ status: 'NO_TRADE', size: 0, unit: null, sizeText: '0', direction: null,
  reasons: [{ code: 'APP_BLOCK', message, fix }], notices: [], working: [], risk: null, limits: null, margin: null, reward: null, capped: null });

function compute(ctx, v, now = new Date()) {
  const fail = (message, fix = '') => ({ result: failResult(message, fix) });
  if (!v.acct) return { wait: 'Pick an account.' };
  if (!v.firm) return fail("The rules for this account's firm didn't load. Nothing can be sized.", 'account');
  if (!v.plan) return fail("This account's plan isn't in the rules file. Edit the account and pick the plan again.", 'account');
  if (!v.stage) return fail("This account's stage isn't in the rules file. Edit the account and pick the stage again.", 'account');
  if (!v.files.length) return fail("This firm's symbol list didn't load. Nothing can be sized.");
  if (!ctx.calc) return fail(ctx.calcProblem || "The calculator isn't loaded, so there is no size.");
  const rm = v.acct.riskMethod || {};
  if (v.acct.personalPlanId && !v.personalPlan) return fail("This account's personal plan isn't on this device, so its rules can't be checked. Import it in Backup, or remove it from the account.", 'account');
  if (rm.type === 'personalPlan' && !v.personalPlan) return fail('This account takes its risk from a personal plan, and none is attached. Pick one in Accounts.', 'account');
  if (v.personalPlan) {
    // A plan whose class names the app doesn't use would have rules that never apply (DESIGN 4.3).
    const bad = unknownPlanClasses(v.personalPlan, ctx.classIds);
    if (bad.length) {
      const tip = bad.find((b) => b.suggestion);
      return fail(`Your plan "${v.personalPlan.name || v.personalPlan.id}" names ${bad.length === 1 ? 'a class' : 'classes'} Risk Desk doesn't use: ${bad.map((b) => b.name).join(', ')}. Its rules for ${bad.length === 1 ? 'it' : 'them'} would never apply.${tip ? ` Use ${tip.suggestion}, not ${tip.name}.` : ''} Fix the plan and import it again in Backup.`, 'backup');
    }
    if (rm.type === 'personalPlan' && !(v.personalPlan.risk && typeof v.personalPlan.risk === 'object')) {
      return fail("This account takes its risk from your plan, but the plan has no risk numbers. Pick another way to set the risk in Accounts.", 'account');
    }
  }
  if (!v.sym) return { wait: 'Pick a symbol.' };
  if (!v.sym.inst) return fail(`Risk Desk couldn't read the values for ${v.sym.symbol}, so it can't be sized. Reload the page.`);
  const market = v.firm.market;
  // A futures product the firm doesn't allow on this plan is NO TRADE whatever is typed, so the engine is
  // asked at once and the card says so the moment the symbol is picked. Anything else waits for prices.
  const banned = market === 'futures' && v.sym.banned === true;
  if (!S.f.entry.trim() && !S.f.stop.trim() && !banned) return { wait: 'Type the entry and the stop.' };
  const input = {
    account: v.acct, firm: v.firm, plan: v.plan, stage: v.stage, instrument: v.sym.inst,
    personalPlan: v.personalPlan || null, settings: { ...ctx.settings },
    trade: {
      entry: S.f.entry, stop: S.f.stop, target: S.f.target, riskOverride: S.f.risk,
      buffer: market === 'cfd' ? S.f.buffer : '', conversionPrice: S.f.conversion,
      // The conversion price the trader said is right, as typed then. The engine only takes it while it
      // reads as the same number as the conversion box (and it is cleared whenever the box changes).
      conversionConfirmed: S.convConfirmed !== '' ? S.convConfirmed : null,
      feesRoundTrip: market === 'futures' ? S.f.fees : '',
      // Treasury futures: the price text the trader said is decimal ("entry|stop|target"). The engine only
      // takes it while it matches the three boxes as they are now.
      decimalsConfirmed: market === 'futures' && S.decConfirmed !== '' ? S.decConfirmed : null,
      previousPrice: S.lastPrices.has(v.sym.key) ? S.lastPrices.get(v.sym.key) : null,
    },
    nowUTC: now,
  };
  const result = ctx.evaluate(input);
  // The symbol list says "Not allowed" from the engine's own product check. A size for the same symbol
  // would contradict it, so it is never shown, copied or logged.
  if (banned && result.status === 'GO') {
    return fail(`${v.firm.name || 'The firm'}'s product list doesn't allow ${v.sym.symbol} on this plan, but the calculator gave a size for it. The two must agree, so this is NO TRADE. Reload the page; if it stays, the app files need fixing.`);
  }
  return { result, input };
}

function unitOf(res, v) {
  if (res && (res.unit === 'contracts' || res.unit === 'lots')) return res.unit;
  return v && v.firm && v.firm.market === 'futures' ? 'contracts' : 'lots';
}
// The size as shown and copied ("1.21"), from the engine's size text.
function sizeShown(res, v) {
  if (res.status !== 'GO') return '0';
  const unit = unitOf(res, v);
  const step = v && v.sym && v.sym.inst ? unwrap(v.sym.inst.volumeStep) : null;
  return sizeForCopy(res.sizeText, res.size, isNum(step) ? step : unit === 'contracts' ? 1 : 0.01) || fmtPlain(res.size);
}
function headlineOf(res, unit) {
  if (res.status === 'GO') {
    return res.capped && typeof res.capped === 'object'
      ? `Capped by ${CAP_WORDS[res.capped.by] || 'a limit'}: your risk wanted ${fmtPlain(res.capped.from)} ${unit}. The smaller size breaks no rule.`
      : 'Inside every limit checked.';
  }
  return res.reasons && res.reasons[0] ? res.reasons[0].message : 'NO TRADE.';
}
// What the card says: the verdict, the size and the headline. A tick repaints when any of them changes.
function cardSig(c, v) {
  if (!c) return '';
  if (c.wait) return `wait|${c.wait}`;
  const r = c.result;
  return JSON.stringify([r.status, r.size, sizeShown(r, v), headlineOf(r, unitOf(r, v))]);
}

function paint(given) {
  if (!current) return;
  const { root, ctx, view: v } = current;
  const box = root.querySelector('#result');
  if (!box) return;
  let c = given || compute(ctx, v);
  let html;
  try {
    html = c.wait ? waitHtml(c.wait) : resultHtml(ctx, v, c.result);
  } catch (e) {
    console.error(e);
    c = { result: failResult(`The result couldn't be shown, so this is treated as NO TRADE. Reload the page. (${e && e.message ? e.message : 'unknown error'})`) };
    html = `<div class="result-top"><span class="verdict verdict-no">NO TRADE</span></div>
      <p class="headline">${esc(c.result.reasons[0].message)}</p>
      <div class="size-row"><p class="size"><span class="size-num num">0</span></p></div>`;
  }
  current.last = c;
  const wasOpen = !!(box.querySelector('details.working') || {}).open;
  box.className = 'card result ' + (c.wait ? 'is-wait' : c.result.status === 'GO' ? 'is-go' : 'is-no');
  box.innerHTML = html;
  if (wasOpen) { const d = box.querySelector('details.working'); if (d) d.open = true; }
  for (const el of box.querySelectorAll('[data-w]')) el.style.flexGrow = el.dataset.w;
  paintMiniBar(root, c);
  for (const el of root.querySelectorAll('[data-f]')) fieldMessage(ctx, el);
}

function waitHtml(text) {
  return `<p class="verdict-wait">${esc(text)}</p>
    <p class="size"><span class="size-num num is-empty">—</span></p>
    <p class="hint">Nothing is pre-filled. Every size comes from numbers you type for this trade.</p>`;
}

function resultHtml(ctx, v, res) {
  // Only GO gives Copy and Log trade. NO TRADE (a product the firm doesn't allow, for one) never does.
  const go = res.status === 'GO';
  const unit = unitOf(res, v);
  const sizeText = sizeShown(res, v);
  const dir = res.direction === 'buy' || res.direction === 'sell' ? res.direction : null;
  const meta = [dir ? `<span class="dir dir-${dir}">${dir === 'buy' ? 'Buy' : 'Sell'}</span>` : '',
    v.sym ? `<span>${esc(v.sym.symbol)}</span>` : '', v.acct ? `<span class="muted">${esc(v.acct.name)}</span>` : ''].join('');
  return `
    <div class="result-top">
      <span class="verdict ${go ? 'verdict-go' : 'verdict-no'}">${go ? 'GO' : 'NO TRADE'}</span>
      <span class="result-meta">${meta}</span>
    </div>
    <p class="headline">${esc(headlineOf(res, unit))}</p>
    ${actionsFor(ctx, res, v)}
    <div class="size-row">
      <p class="size"><span class="size-num num">${esc(sizeText)}</span><span class="size-unit">${unit}</span></p>
      ${go ? `<button type="button" class="btn btn-primary btn-copy" data-act="copy" data-copy="${esc(sizeText)}">${ICONS.copy}<span>Copy</span></button>` : ''}
    </div>
    ${roomHtml(res, v)}
    ${factsHtml(res, v, unit)}
    ${messagesHtml(res, v)}
    ${workingHtml(res)}
    ${go && v.acct ? `<div class="result-foot"><button type="button" class="btn btn-wide" data-act="log">Log trade</button>
      <p class="hint">Adds it to the journal and counts one more trade today on ${esc(v.acct.name)}. Then update its balance, equity and other open trades before the next trade.</p></div>` : ''}`;
}

// The USD pair typed in the conversion box for this symbol ("USDCHF"), from the engine; null when none.
function conversionPair(ctx, v) {
  if (!v || !v.sym || !v.sym.inst || !v.firm || v.firm.market !== 'cfd') return null;
  const conv = ctx.conversionNeed(unwrap(v.sym.inst.profitCurrency), v.sym.data.base, v.sym.data.quote);
  return conv && typeof conv.pair === 'string' && conv.pair ? conv.pair : null;
}

function actionsFor(ctx, res, v) {
  if (res.status === 'GO') return '';
  const reasons = Array.isArray(res.reasons) ? res.reasons : [];
  const codes = new Set(reasons.map((r) => r.code));
  const fixes = new Set(reasons.map((r) => r.fix).filter(Boolean));
  const out = [];
  // The firm's own product list leaves this symbol out of the plan: its note is with the plan's contract
  // limits on the Rules screen.
  if (codes.has('NOT_ALLOWED')) out.push('<a class="btn btn-small" href="#/rules">See the firm\'s note in Rules</a>');
  if (v.acct && ([...ACCOUNT_CODES].some((c) => codes.has(c)) || fixes.has('account'))) {
    out.push(`<a class="btn btn-small" href="#/accounts/${encodeURIComponent(v.acct.id)}/trade">Update the account</a>`);
  }
  if ([...PLAN_CODES].some((c) => codes.has(c)) || fixes.has('backup')) out.push('<a class="btn btn-small" href="#/backup">Check the plan in Backup</a>');
  if (v.sym && v.sym.market === 'cfd' && (codes.has('SPEC_UNCONFIRMED') || v.sym.gaps.length || v.sym.issues.length)) {
    out.push(`<button type="button" class="btn btn-small" data-act="confirm">Confirm ${esc(v.sym.symbol)}</button>`);
  }
  const priceCodes = [...codes].filter(isPriceCode);
  if (v.sym && priceCodes.length) {
    const target = priceCodes.every((c) => String(c).startsWith('TARGET_'));
    out.push(`<button type="button" class="btn btn-small" data-act="fix-field" data-field="${target ? 'target' : 'entry'}">${target ? 'Check the target' : 'Check the prices'}</button>`);
  }
  // A Treasury price that can be read as a decimal or as a 32nds quote (110.25 or 110'25): one tap says
  // the typed prices are decimals. The engine then sizes them and shows a notice (memory only).
  if (v.sym && codes.has('PRICE_AMBIGUOUS')) out.push('<button type="button" class="btn btn-small btn-quiet" data-act="confirm-decimals">These are decimal prices</button>');
  // The earlier price is only in memory. If it was the typo, the trader can drop it on purpose. It is shown
  // with the symbol's digits, as the engine's headline shows it ("2650.00").
  if (v.sym && codes.has('PRICE_JUMP') && S.lastPrices.has(v.sym.key)) {
    const digits = v.sym.data && Number.isInteger(v.sym.data.digits) ? v.sym.data.digits : null;
    out.push(`<button type="button" class="btn btn-small btn-quiet" data-act="forget-price">The earlier price, ${esc(fmtPrice(S.lastPrices.get(v.sym.key), digits))}, was wrong</button>`);
  }
  if (v.sym && [...codes].some((c) => CONVERSION_CODES.has(c))) out.push('<button type="button" class="btn btn-small" data-act="fix-field" data-field="conversion">Check the conversion price</button>');
  // The engine doubts the conversion price. If the trader has checked it against MT5, one tap says so; the
  // engine then sizes with it and shows a notice (memory only, cleared whenever the box changes).
  const typedConv = String(S.f.conversion || '').trim();
  if (v.sym && typedConv && [...codes].some((c) => DOUBTED_CONVERSION.has(c))) {
    const pair = conversionPair(ctx, v);
    out.push(`<button type="button" class="btn btn-small btn-quiet" data-act="confirm-conversion">The ${esc(pair || 'conversion')} price ${esc(typedConv)} is right</button>`);
  }
  return out.length ? `<div class="result-actions">${out.join('')}</div>` : '';
}

function roomHtml(res, v) {
  const L = res.limits;
  if (!L || typeof L !== 'object') return '';
  const rows = [['Daily room', L.dailyRoom], ['Max-loss room', L.maxRoom]];
  if (res.status === 'GO') rows.push(['Room after the stop', L.roomAfterStop]);
  if (!rows.some(([, x]) => isNum(x))) return '';
  const dl = v.plan ? v.plan.dailyLoss : undefined;
  const noDaily = dl === null || (!!dl && typeof dl === 'object' && 'value' in dl && dl.value === null && dl.status !== 'unconfirmed');
  const empty = (k) => (k === 'Daily room' && noDaily ? '<span class="muted">No daily limit</span>' : '<span class="muted">—</span>');
  let track = '';
  const atStop = res.risk && isNum(res.risk.atStop) ? res.risk.atStop : null;
  if (isNum(L.roomNow) && L.roomNow > 0 && atStop !== null && atStop >= 0 && res.status === 'GO') {
    const used = Math.min(1, atStop / L.roomNow);
    track = `<div class="track" role="img" aria-label="This trade's stop uses ${fmtMoney(atStop)} of ${fmtMoney(L.roomNow)} room">
      <span class="track-left" data-w="${(1 - used).toFixed(4)}"></span><span class="track-used" data-w="${used.toFixed(4)}"></span></div>
      <p class="track-key"><span><i class="key key-left"></i>Left after the stop</span><span><i class="key key-used"></i>This trade's stop</span></p>`;
  }
  const b = bindingOf(L);
  return `<section class="room" aria-label="Room left">
    <dl class="kv">${rows.map(([k, x]) => `<div><dt>${k}</dt><dd class="num">${isNum(x) ? fmtMoney(x) : empty(k)}</dd></div>`).join('')}</dl>
    ${track}
    ${b && b.name ? `<p class="hint">The ${esc(String(b.name).toLowerCase())} floor is the one that binds${isNum(b.level) ? `, at <span class="num">${fmtMoney(b.level)}</span>` : ''}.</p>` : ''}
  </section>`;
}

function factsHtml(res, v, unit) {
  const rows = [];
  const R = res.risk || {};
  const per = unit === 'contracts' ? 'contract' : 'lot';
  const rm = (v.acct && v.acct.riskMethod) || {};
  const how = isNum(R.override) ? 'typed for this trade'
    : (R.method === 'pctOfSize' || R.method === 'pctOfBalance') && isNum(rm.value) ? `${fmtPct(rm.value)}${METHOD_WORDS[R.method]}`
    : METHOD_WORDS[R.method] || '';
  // On NO TRADE the engine zeroes the size and every total that follows from it, so those rows are left
  // out; the budget, the loss per unit and the reward-to-risk still help the trader rework the trade.
  const go = res.status === 'GO';
  if (isNum(R.budget)) rows.push(['Risk budget', fmtMoney(R.budget), [how, isNum(R.max) ? `max ${fmtMoney(R.max)}` : ''].filter(Boolean).join(', ')]);
  if (go && isNum(R.atStop)) {
    const sub = [isNum(R.priceMove) ? `price move ${fmtMoney(R.priceMove)}` : '', isNum(R.commission) ? `costs ${fmtMoney(R.commission)}` : ''].filter(Boolean).join(' + ');
    rows.push(['Loss if the stop is hit', fmtMoney(R.atStop), sub]);
  }
  if (isNum(R.perUnit)) rows.push([`Loss per ${per}`, fmtMoney(R.perUnit), '']);
  // The engine works out margin for CFD only; for futures margin.perUnit is null and no row is shown.
  const M = res.margin;
  if (go && M && isNum(M.perUnit) && isNum(M.needed)) rows.push(['Margin needed', fmtMoney(M.needed), isNum(M.available) ? `available ${fmtMoney(M.available)}${isNum(M.capPct) ? ` (${fmtPct(M.capPct)} cap)` : ''}` : '']);
  const W = res.reward;
  if (W) {
    const rrP = isNum(W.rrPrice) ? `${fmtPlain(Number(W.rrPrice.toFixed(2)))}R on price` : '';
    const rrC = isNum(W.rrAfterCosts) ? `${fmtPlain(Number(W.rrAfterCosts.toFixed(2)))}R after costs` : '';
    if (go && isNum(W.total)) rows.push(['At the target', fmtMoney(W.total, { sign: true }), [rrP, rrC].filter(Boolean).join(', ')]);
    else if (!go && rrP) rows.push(['Target', rrP, rrC]);
  }
  if (!rows.length) return '';
  return `<dl class="kv facts">${rows.map(([k, val, sub]) => `<div><dt>${esc(k)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</dt><dd class="num">${esc(val)}</dd></div>`).join('')}</dl>`;
}

function messagesHtml(res, v) {
  const items = [];
  if (res.status !== 'GO') for (const r of (res.reasons || []).slice(1)) items.push(['neg', r.message]);
  for (const n of res.notices || []) items.push(['info', n.message]);
  if (res.status !== 'GO' && v.sym) for (const m of v.sym.issues) if (!items.some(([, x]) => x === m)) items.push(['neg', m]);
  if (!items.length) return '';
  return `<ul class="msgs">${items.map(([t, m]) => `<li class="msg msg-${t}">${esc(m)}</li>`).join('')}</ul>`;
}

function workingHtml(res) {
  const steps = (res.working || []).filter((s) => s && (s.label || s.detail));
  if (!steps.length) return '';
  const val = (x) => (isNum(x) ? fmtPlain(x) : x === null || x === undefined ? '' : String(x));
  return `<details class="working"><summary data-act="working">Show the working <span class="muted">(${plural(steps.length, 'step')})</span></summary>
    <ol class="steps">${steps.map((s) => `<li><div class="step-l"><span class="step-label">${esc(s.label || '')}</span>${s.detail ? `<span class="step-detail">${esc(s.detail)}</span>` : ''}</div><span class="step-v num">${esc(val(s.value))}</span></li>`).join('')}</ol>
  </details>`;
}

function fieldMessage(ctx, el) {
  const msg = el.parentElement && el.parentElement.querySelector('.field-msg');
  if (!msg || !ctx.calc) return;
  const text = el.value;
  if (!text.trim()) { msg.textContent = ''; el.removeAttribute('aria-invalid'); return; }
  let r;
  try { r = ctx.calc.readNum(text, { money: el.dataset.money === '1' }); } catch { r = { ok: false }; }
  if (r && r.ok) { msg.textContent = ''; el.removeAttribute('aria-invalid'); }
  else { msg.textContent = (r && r.message) || 'Use digits and a dot, like 1.08500.'; el.setAttribute('aria-invalid', 'true'); }
}

// ---------- The phone's mini bar (shows the size while the card is scrolled away) ----------
function paintMiniBar(root, c) {
  const bar = root.querySelector('#minibar');
  if (!bar) return;
  if (c.wait) { bar.dataset.empty = '1'; bar.innerHTML = ''; bar.hidden = true; return; }
  const go = c.result.status === 'GO';
  const v = current ? current.view : null;
  const size = sizeShown(c.result, v);
  const unit = unitOf(c.result, v);
  bar.dataset.empty = '';
  bar.hidden = cardVisible;
  bar.innerHTML = `<span class="mini-size num">${esc(size)}</span><span class="mini-unit">${esc(unit)}</span><span class="verdict verdict-small ${go ? 'verdict-go' : 'verdict-no'}">${go ? 'GO' : 'NO TRADE'}</span>`;
  bar.setAttribute('aria-label', `${go ? 'GO' : 'NO TRADE'}, ${size} ${unit}. Show the result.`);
}

function setupMiniBar(root) {
  const card = root.querySelector('#result');
  const bar = root.querySelector('#minibar');
  // Tapping outside the symbol list closes it (works with touch, where buttons don't take focus).
  const outside = (e) => {
    const picker = root.querySelector('#picker');
    const list = root.querySelector('#sym-list');
    if (picker && list && !list.hidden && !picker.contains(e.target)) closePicker(root, true);
  };
  document.addEventListener('pointerdown', outside);
  cardVisible = true;
  let io = null;
  if (card && bar && 'IntersectionObserver' in window) {
    io = new IntersectionObserver((entries) => {
      cardVisible = entries[0].isIntersecting;
      bar.hidden = cardVisible || bar.dataset.empty === '1';
    }, { threshold: 0.15 });
    io.observe(card);
  }
  return () => { document.removeEventListener('pointerdown', outside); if (io) io.disconnect(); };
}

// ---------- Events ----------
function wire(root, ctx) {
  root.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-acct]');
    if (chip) { selectAccount(ctx, chip.dataset.acct); return; }
    const pick = e.target.closest('[data-sym]');
    if (pick) { pickSymbol(ctx, pick.dataset.sym); return; }
    const act = e.target.closest('[data-act]');
    if (!act || !current) return;
    const v = current.view;
    if (act.dataset.act === 'copy') {
      // No await before the copy: Safari only copies inside the tap itself.
      copyAtTap(ctx, act);
    } else if (act.dataset.act === 'confirm-conversion') {
      if (!String(S.f.conversion || '').trim()) return;
      S.convConfirmed = S.f.conversion;
      paint();
      restoreFocus({ act: 'copy' });
    } else if (act.dataset.act === 'confirm-decimals') {
      // Only for the card on display, and only while it asks: the confirmation stands for the three price
      // boxes exactly as they are typed now.
      if (!current.last || !hasReason(current.last.result, 'PRICE_AMBIGUOUS')) return;
      S.decConfirmed = pricesTyped();
      paint();
      restoreFocus({ act: 'copy' });
    } else if (act.dataset.act === 'log') {
      await logTrade(ctx, act);
    } else if (act.dataset.act === 'confirm' && v.sym) {
      openConfirmSheet(ctx, v.sym.fileId, v.sym.symbol, { onSaved: () => ctx.refresh() });
    } else if (act.dataset.act === 'fix-field') {
      const field = ['conversion', 'target'].includes(act.dataset.field) ? act.dataset.field : 'entry';
      const el = current.root.querySelector(`[data-f="${field}"]`);
      if (el) { el.focus(); if (typeof el.select === 'function') el.select(); }
    } else if (act.dataset.act === 'forget-price' && v.sym) {
      S.lastPrices.delete(v.sym.key);
      ctx.toast(`Forgot the earlier ${v.sym.symbol} price. Check both prices against the chart before you trade.`);
      paint();
    }
  });
  root.addEventListener('input', (e) => {
    const el = e.target.closest('[data-f]');
    if (el) {
      if (!current) return;
      // A confirmed conversion price only stands for the text it was given for.
      if (el.dataset.f === 'conversion' && el.value !== S.f.conversion) S.convConfirmed = '';
      // "These are decimal prices" only stands for the entry, stop and target it was given for.
      if (PRICE_BOXES.has(el.dataset.f) && el.value !== S.f[el.dataset.f]) S.decConfirmed = '';
      S.f[el.dataset.f] = el.value;
      S.lastInput = Date.now();
      if (fieldsBlank()) S.fDayKey = null;
      else if (!S.fDayKey) { const fd = current.view.firm ? ctx.firmDayFor(current.view.firm) : null; S.fDayKey = fd ? fd.dayKey : null; }
      if (S.note) { S.note = ''; const n = root.querySelector('#trade-note'); if (n) n.remove(); }
      paint();
      return;
    }
    if (e.target.id === 'sym-q') openPicker(root, e.target.value);
  });
  const q = root.querySelector('#sym-q');
  if (q) {
    q.addEventListener('focus', () => { q.select(); openPicker(root, ''); });
    q.addEventListener('keydown', (e) => pickerKeys(root, e));
  }
  const bar = root.querySelector('#minibar');
  if (bar) bar.addEventListener('click', () => {
    const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const card = root.querySelector('#result');
    if (card) card.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
  });
}

function selectAccount(ctx, id) {
  if (id === S.accountId) return;
  const v = current ? current.view : null;
  const prev = v && v.sym ? v.sym : null;
  rememberPrice(v);
  S.accountId = id;
  S.f = blank();
  S.fDayKey = null;
  S.note = '';
  S.loggedSig = '';
  S.convConfirmed = '';
  S.decConfirmed = '';
  // Keep the same symbol name if the new account's list has it; prices are cleared either way.
  S.symKey = prev ? prev.key : null;
  S.keepName = prev ? prev.symbol : null;
  ctx.refresh();
}

function pickSymbol(ctx, key) {
  if (!current) return;
  closePicker(current.root, false);
  if (key !== S.symKey) {
    rememberPrice(current.view);
    S.symKey = key;
    S.f = blank();
    S.fDayKey = null;
    S.note = '';
    S.loggedSig = '';
    S.convConfirmed = '';
    S.decConfirmed = '';
  }
  S.focus = 'entry';
  // The old screen is removed at once and the new one takes a few hundredths of a second to draw. In that
  // gap no box has the focus, so digits typed then are held for the entry price (holdEntryKeys).
  S.picking = true;
  Promise.resolve(ctx.refresh()).finally(() => { S.picking = false; });
}

// A symbol was just picked and its price boxes are not on screen yet. A digit or a dot typed now is the
// start of the entry price: it is kept and shown in the entry box when the screen is drawn, so a fast typist
// never loses the first digit of a price. Only while nothing that takes text has the focus.
export function holdEntryKeys(e) {
  if (!S.picking || !e || e.ctrlKey || e.metaKey || e.altKey) return false;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return false;
  if (typeof e.key !== 'string' || !/^[0-9.]$/.test(e.key)) return false;
  S.f.entry += e.key;
  S.lastInput = Date.now();
  if (typeof e.preventDefault === 'function') e.preventDefault();
  return true;
}
if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('keydown', holdEntryKeys, true);

// The last entry typed for a symbol, kept in memory for the engine's "slipped decimal" check
// (trade.previousPrice). An entry the price checks flagged is never kept, so a typo can't become the
// price every later one is compared with.
function rememberPrice(v) {
  if (!v || !v.sym || !current || !current.ctx.calc) return;
  const last = current.last && current.last.result;
  if (last && Array.isArray(last.reasons) && last.reasons.some((x) => x && (x.code === 'PRICE_JUMP' || x.code === 'PRICE_CHECK'))) return;
  let r;
  try { r = current.ctx.calc.readNum(S.f.entry); } catch { r = null; }
  if (r && r.ok && !r.empty && isNum(r.value) && r.value > 0) S.lastPrices.set(v.sym.key, r.value);
}

// ---------- Symbol picker ----------
function openPicker(root, query) {
  const list = root.querySelector('#sym-list');
  const q = root.querySelector('#sym-q');
  if (!list || !current) return;
  const words = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hits = current.view.symbols.filter((s) => {
    const hay = `${s.symbol} ${s.name} ${s.classLabel}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const groups = new Map();
  for (const s of hits) { if (!groups.has(s.classLabel)) groups.set(s.classLabel, []); groups.get(s.classLabel).push(s); }
  list.innerHTML = hits.length ? [...groups.entries()].map(([label, items]) => `<div class="pick-group" role="group" aria-label="${esc(label)}">
      <p class="pick-group-title">${esc(label)}</p>
      ${items.map((s) => `<button type="button" class="pick" role="option" data-sym="${esc(s.key)}" aria-selected="${s.key === S.symKey}">
        <span class="pick-sym">${esc(s.symbol)}</span><span class="pick-name">${esc(s.name)}</span>${pickTag(s)}</button>`).join('')}
    </div>`).join('') : '<p class="pick-empty">No symbol matches. Try the code, like EURUSD, or a name, like gold.</p>';
  list.hidden = false;
  if (q) q.setAttribute('aria-expanded', 'true');
}

// The red tag beside a symbol in the list: why it can't be sized as it is.
function pickTag(s) {
  const tag = (text) => `<span class="tag tag-neg">${text}</span>`;
  if (!s.inst) return tag("Can't be read");
  if (s.banned) return tag('Not allowed');
  if (s.issues.length) return tag('Blocked');
  if (s.gaps.length) return tag('Needs MT5 values');
  return '';
}

function closePicker(root, restore) {
  const list = root && root.querySelector('#sym-list');
  const q = root && root.querySelector('#sym-q');
  if (!list || !q) return;
  list.hidden = true;
  q.setAttribute('aria-expanded', 'false');
  if (restore) q.value = current && current.view.sym ? current.view.sym.symbol : '';
}

function pickerKeys(root, e) {
  const list = root.querySelector('#sym-list');
  const opts = [...list.querySelectorAll('.pick')];
  if (e.key === 'Escape') { closePicker(root, true); return; }
  if (e.key === 'ArrowDown' && opts.length) { e.preventDefault(); if (list.hidden) openPicker(root, e.target.value); opts[0].focus(); return; }
  if (e.key === 'Enter' && opts.length && !list.hidden) { e.preventDefault(); opts[0].click(); }
}

// Arrow keys inside the list move between options.
document.addEventListener('keydown', (e) => {
  const opt = e.target && e.target.closest && e.target.closest('.pick');
  if (!opt || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Escape')) return;
  const all = [...document.querySelectorAll('#sym-list .pick')];
  const i = all.indexOf(opt);
  e.preventDefault();
  if (e.key === 'Escape') { const q = document.getElementById('sym-q'); if (q) q.focus(); return; }
  const next = e.key === 'ArrowDown' ? all[i + 1] : all[i - 1];
  if (next) next.focus(); else if (e.key === 'ArrowUp') { const q = document.getElementById('sym-q'); if (q) q.focus(); }
});

// ---------- Copy the size ----------
// The card can be up to 30 seconds old: a news window, a plan window or the firm's reset may have started
// since it was worked out. So the trade is worked out again at the tap, with the account shown on the card
// and the time now, before anything is copied. Only the same GO and size are copied; anything else is
// repainted and nothing is copied. Everything up to the copy itself is synchronous: Safari copies only
// inside the tap.
function copyAtTap(ctx, btn) {
  if (!current || !current.last || !current.last.result || current.last.result.status !== 'GO') return;
  const v = current.view;
  const shown = current.last.result;
  const why = expiry(ctx, v);
  if (why) {
    clearPrices(why, v);
    ctx.toast(`Nothing was copied. ${CLEAR_NOTES[why]}`);
    ctx.refresh();
    return;
  }
  const c = compute(ctx, v, new Date());
  const res = c.result;
  const text = res ? sizeShown(res, v) : '';
  const same = !!(res && res.status === 'GO' && res.size === shown.size && unitOf(res, v) === unitOf(shown, v) && text === sizeShown(shown, v));
  if (!same) {
    paint(c);
    const st = current.root.querySelector('#acct-status');
    if (st) st.innerHTML = statusHtml(ctx, v);
    ctx.toast(`Nothing was copied: ${notCopiedWhy(c, v)}`);
    return;
  }
  copyText(text).then((ok) => {
    ctx.toast(ok ? `Copied ${text}` : "Couldn't copy. Select the number and copy it.");
    const label = ok && btn && typeof btn.querySelector === 'function' ? btn.querySelector('span') : null;
    if (label) { label.textContent = 'Copied'; setTimeout(() => { if (label.isConnected) label.textContent = 'Copy'; }, 1600); }
  });
}
function notCopiedWhy(c, v) {
  if (!c || c.wait) return (c && c.wait) || 'there is no size now.';
  const r = c.result;
  if (r.status !== 'GO') return (r.reasons && r.reasons[0] && r.reasons[0].message) || 'this trade is NO TRADE now.';
  return `the size is now ${sizeShown(r, v)} ${unitOf(r, v)}. Check it, then copy again.`;
}

// ---------- Log the trade ----------
// The trade is worked out again at the tap, from the account as saved now and the time now. Only the same
// GO that is on the card is logged; anything else is repainted and nothing is saved. After logging, the
// account is stamped (lastLoggedAt): its balance, equity and other open trades no longer include this
// trade, so the engine gives NO TRADE until they are updated and saved.
// The journal entry and the account's stamp are saved together (store.putTogether): both or neither. If
// the save fails, nothing was logged, the card stays as it is, and the next tap tries again.
// A second tap while the first is saving does nothing. The same card can't be logged twice: the check
// covers the account's update and log times, so after the account is updated a re-entry at the same
// prices is a new trade and is logged.
async function logTrade(ctx, btn) {
  if (S.logging) return;
  if (!current || !current.last || !current.last.result || current.last.result.status !== 'GO') return;
  const shown = current.last;
  const shownView = current.view;
  if (!shownView.acct || !shownView.sym) return;
  const why = expiry(ctx, shownView);
  if (why) {
    clearPrices(why, shownView);
    ctx.toast(`Nothing was logged. ${CLEAR_NOTES[why]}`);
    await ctx.refresh();
    return;
  }
  const a = shownView.acct;
  const sig = JSON.stringify([a.id, a.updatedAt ?? null, a.lastLoggedAt ?? null, shownView.sym.key, S.f]);
  if (S.loggedSig === sig) { ctx.toast('This trade is already in the journal.'); return; }
  S.logging = true;
  if (btn) btn.disabled = true;
  let saved = false;
  try {
    await ctx.rollDays();
    const now = new Date();
    const accounts = (await ctx.store.getAll('accounts')).sort(byName);
    const v = await loadView(ctx, accounts);
    const again = expiry(ctx, v);
    if (again) {
      clearPrices(again, v);
      ctx.toast(`Nothing was logged. ${CLEAR_NOTES[again]}`);
      await ctx.refresh();
      return;
    }
    const c = compute(ctx, v, now);
    const res = c.result;
    const same = !!(res && res.status === 'GO' && v.acct && v.acct.id === shownView.acct.id && v.sym && v.sym.key === shownView.sym.key
      && res.size === shown.result.size && unitOf(res, v) === unitOf(shown.result, shownView));
    if (!same) {
      current.view = v;
      paint(c);
      const st = current.root.querySelector('#acct-status');
      if (st) st.innerHTML = statusHtml(ctx, v);
      ctx.toast(res && res.status === 'GO' ? 'The size changed since it was shown. Nothing was logged: check the new size.' : 'This trade is NO TRADE now. Nothing was logged: see the reason.');
      return;
    }
    const fd = ctx.firmDayFor(v.firm, now);
    const read = (t) => { try { const r = ctx.calc.readNum(t); return r && r.ok && !r.empty ? r.value : null; } catch { return null; } };
    const unit = unitOf(res, v);
    const entry = {
      id: newId('j-'), createdAt: now.toISOString(), dayKey: fd ? fd.dayKey : null,
      accountId: v.acct.id, accountName: v.acct.name || '', firmId: v.firm.id, firmName: v.firm.name || v.firm.id,
      planId: v.plan.id, planName: v.plan.name || v.plan.id, stageId: v.stage.id, stageName: v.stage.name || v.stage.id, accountSize: v.acct.size,
      market: v.firm.market, instrumentsId: v.sym.fileId, symbol: v.sym.symbol, digits: Number.isInteger(v.sym.data.digits) ? v.sym.data.digits : null,
      direction: res.direction || null, entry: read(S.f.entry), stop: read(S.f.stop), target: read(S.f.target),
      size: res.size, unit, sizeText: sizeShown(res, v),
      riskAtStop: res.risk && isNum(res.risk.atStop) ? res.risk.atStop : null,
      budget: res.risk && isNum(res.risk.budget) ? res.risk.budget : null,
      capped: res.capped && res.capped.by ? res.capped.by : null,
      outcome: null, pnl: null, notes: '', resultAt: null, addedToToday: false,
    };
    const fresh = await ctx.store.get('accounts', v.acct.id);
    if (!fresh) {
      ctx.toast("Nothing was logged. This account isn't on this device any more.");
      await ctx.refresh();
      return;
    }
    const n = (Number.isInteger(fresh.tradesToday) ? fresh.tradesToday : 0) + 1;
    // One step: the journal entry, and the account's trade count and log time. Both are saved, or neither.
    await ctx.store.putTogether({ journal: [entry], accounts: [{ ...fresh, tradesToday: n, lastLoggedAt: now.toISOString() }] });
    saved = true;
    S.loggedSig = sig;
    rememberPrice(v);
    S.f = blank();
    S.fDayKey = null;
    S.lastInput = 0;
    S.convConfirmed = '';
    S.decConfirmed = '';
    S.note = { accountId: v.acct.id, at: now.toISOString(), sizeText: entry.sizeText, unit, symbol: entry.symbol };
    ctx.toast(`Logged. ${v.acct.name || 'This account'}: ${plural(n, 'trade')} today. Update its balance, equity and other open trades next.`);
    await ctx.refresh();
  } catch (e) {
    console.error(e);
    // Before the save finished, nothing was written (the two writes are one step): the card is left as
    // it is and the next tap tries again. After it, the trade is logged: only the screen needs redrawing.
    ctx.toast(saved ? 'The trade was logged, but the screen could not be redrawn. Reload the page.' : "Nothing was logged. Couldn't save on this device. Try again.");
  } finally {
    S.logging = false;
    if (btn && btn.isConnected) btn.disabled = false;
  }
}

// ---------- Every 30 seconds ----------
// The clock moves the time rules (news windows, plan hours, the firm's day), so the trade is worked out
// again on every tick, wherever the focus is. The card is repainted when its verdict, size or headline
// changed (and on every tick when the focus is elsewhere); the focus goes back to the same control.
export async function onTick(ctx, { rolled } = {}) {
  if (!current || !current.root.isConnected) return;
  const v = current.view;
  // Prices typed with no firm day known are cleared at any reset (the safer side).
  const why = expiry(ctx, v) || (rolled && !S.fDayKey && !fieldsBlank() ? 'day' : null);
  if (why) clearPrices(why, v);
  if (why || rolled) { await ctx.refresh(); return; }
  const st = current.root.querySelector('#acct-status');
  if (st) st.innerHTML = statusHtml(ctx, v);
  const c = compute(ctx, v);
  const focus = focusInResult();
  if (focus && cardSig(c, v) === cardSig(current.last, v)) return;
  paint(c);
  if (focus) restoreFocus(focus);
}

// The control inside the result card that has the focus (by its data-act), or null when the focus is elsewhere.
function focusInResult() {
  const ae = document.activeElement;
  if (!ae || typeof ae.closest !== 'function' || !ae.closest('.result')) return null;
  const el = ae.closest('[data-act]');
  return { act: el && el.dataset ? el.dataset.act || '' : '' };
}
function restoreFocus(focus) {
  if (!current) return;
  const box = current.root.querySelector('#result');
  if (!box) return;
  const el = focus.act ? box.querySelector(`[data-act="${focus.act}"]`) : null;
  const target = el || box;
  if (typeof target.focus === 'function') target.focus({ preventScroll: true });
}

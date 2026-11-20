// Accounts screen: the list with each account's room and staleness, and the form:
// firm → plan (purchase date where the rules depend on it) → size → stage → today's numbers →
// today's result and trades → risk method and max → personal plan → today's news times.
// Numbers are read with the engine's strict reader. Nothing about a trade is stored here.

import {
  esc, fmtMoney, fmtPct, fmtSizeK, fmtTimeIST, fmtDateIST, fmtWhenIST, fmtISODate, unwrap, planFamilies, pickPlanByPurchase,
  describeValue, describePurchase, isISODate, istDateISO, isHHMM, hhmm12, newId, ICONS, plural, toDate, accountBits,
} from '../ui.js';
import { BALANCE_FIELDS, symbolsOf, numbersState, loggedUnreadable, unknownPlanClasses, classNameHelp } from '../store.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const lcFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
let F = null;              // the form draft while the form is open (memory only)
let formRoot = null;

// Messages that a pick (a chip, the date, the plan list) can fix. Once it has, the message goes at once.
const PICK_SIZE = 'Pick the account size.';
const TYPE_SIZE = 'Type the starting balance.';
const PICK_SIGN = 'Pick Profit or Loss.';

const RISK_CHOICES = [
  { id: 'pctOfSize', label: '% of account size' },
  { id: 'pctOfBalance', label: '% of balance' },
  { id: 'usd', label: '$ per trade' },
  { id: 'personalPlan', label: 'My personal plan' },
];

export async function render(root, ctx, params) {
  if (params[0]) return renderForm(root, ctx, params[0], params[1] === 'trade');
  F = null;
  return renderList(root, ctx);
}

// ---------- List ----------
async function renderList(root, ctx) {
  const list = (await ctx.store.getAll('accounts')).sort(byName);
  if (!list.length) {
    root.innerHTML = `<section class="card first-run">
      <h2 class="card-title">No accounts yet</h2>
      <p>Add each prop-firm account once: firm, plan, size and stage. Each morning, type its balance and reset values.</p>
      <a class="btn btn-primary" href="#/accounts/new">Add an account</a></section>`;
    return null;
  }
  const now = new Date();
  let needs = 0;
  const rows = list.map((a) => {
    const firm = ctx.data.firmById.get(a.firmId);
    const plan = firm && Array.isArray(firm.plans) ? firm.plans.find((p) => p.id === a.planId) : null;
    const stage = plan && Array.isArray(plan.stages) ? plan.stages.find((s) => s.id === a.stageId) : null;
    const fd = ctx.firmDayFor(firm, now);
    const fl = plan ? ctx.floorsFor(a, plan, firm) : null;
    const st = numbersState(a, fd, now);
    if (st || !firm) needs++;
    let room = '<span class="muted">—</span>', roomSub = '';
    if (fl && isNum(fl.room)) {
      room = fmtMoney(fl.room);
      roomSub = fl.binding && fl.binding.name ? `room above the ${esc(fl.binding.name.toLowerCase())} floor` : 'room';
    } else if (fl && Array.isArray(fl.notSetUp) && fl.notSetUp.length) roomSub = 'loss limits not set up';
    else if (fl && Array.isArray(fl.problems) && fl.problems.length) roomSub = esc(fl.problems[0]);
    let state;
    if (!firm) state = '<span class="msg-neg">Rules for this firm didn\'t load</span>';
    else if (fl && fl.breached) state = '<span class="msg-neg">Equity is at or below a floor</span>';
    else if (st && st.kind === 'none') state = '<span class="msg-warn">No numbers typed yet</span>';
    else if (st && st.kind === 'future') state = `<span class="msg-warn">Saved with a time in the future (${esc(fmtWhenIST(st.at, now))}): check the phone's clock, then save the numbers again</span>`;
    else if (st && st.kind === 'beforeReset') state = `<span class="msg-warn">Typed ${esc(fmtWhenIST(a.updatedAt, now))}, before today's reset</span>`;
    else if (st && st.kind === 'badLog') state = '<span class="msg-warn">The time of the last logged trade can\'t be read: update the numbers</span>';
    else if (st && st.kind === 'afterLog') state = `<span class="msg-warn">Trade logged ${esc(fmtWhenIST(st.at, now))}, after these numbers: update them</span>`;
    else state = `<span class="muted">Updated ${esc(fmtWhenIST(a.updatedAt, now))}</span>`;
    // A stage that only repeats the plan's name is left out ("Topstep · Trading Combine · $50K").
    const desc = accountBits(firm ? firm.name || firm.id : a.firmId, plan ? plan.name || plan.id : 'plan missing', a.size, stage ? stage.name || stage.id : 'stage missing');
    const support = supportLine(firm, a);
    return `<li><a class="row-link acct-row" href="#/accounts/${encodeURIComponent(a.id)}">
      <span class="row-main"><span class="row-title">${esc(a.name || 'Account')}</span><span class="row-sub">${desc.map(esc).join(' · ')}</span>${support ? `<span class="row-sub">${esc(support)}</span>` : ''}<span class="row-sub">${state}</span></span>
      <span class="row-figure"><span class="num">${room}</span><span class="row-sub">${roomSub}</span></span>
    </a></li>`;
  }).join('');
  const lede = needs ? `${plural(needs, 'account')} of ${list.length} need${needs === 1 ? 's' : ''} new numbers.` : 'Every account has numbers from today\'s trading day.';
  root.innerHTML = `<div class="title-row"><p class="lede">${esc(lede)}</p><a class="btn btn-primary" href="#/accounts/new">${ICONS.plus}<span>Add account</span></a></div>
    <section class="card list-card"><ul class="rows">${rows}</ul></section>`;
  return null;
}

// The plan id the trader recorded from the firm's support, read the way the engine reads it: trimmed text,
// or null when blank or not text.
const supportIdOf = (a) => (a && typeof a.planBySupport === 'string' && a.planBySupport.trim() ? a.planBySupport.trim() : null);

// The answer the trader recorded from the firm's support for an account bought on a rule-change day,
// in plain words, or '' when none is recorded. Like the engine, the answer only counts when the purchase
// date is the account plan's rule-change day; on any other date it is ignored, so it isn't shown.
export function supportLine(firm, a) {
  const id = supportIdOf(a);
  if (!id) return '';
  const plans = firm && Array.isArray(firm.plans) ? firm.plans : [];
  const own = plans.find((x) => x && x.id === a.planId);
  if (!own || !changeDayOf([own], a.purchasedOn)) return '';
  const p = plans.find((x) => x && x.id === id);
  const who = `${firm.name || firm.id} support`;
  const said = `${who} said this account follows ${p ? p.name || p.id : `"${id}", a plan that isn't in the rules file`}`;
  return `Bought on ${fmtISODate(a.purchasedOn)}: you recorded that ${said}.`;
}

// ---------- Form ----------
async function renderForm(root, ctx, idParam, fromTrade) {
  formRoot = root;
  const isNew = idParam === 'new';
  let original = null;
  // The firm's reset may have passed since the last 30-second roll: roll first, so the form never shows
  // (and never saves) yesterday's reset values, result or trade count under the new day.
  try { await ctx.rollDays(); } catch (e) { console.error(e); }
  if (!isNew) {
    original = await ctx.store.get('accounts', idParam);
    if (!original) {
      root.innerHTML = `<section class="card"><p class="msg msg-neg">This account isn't on this device any more.</p><a class="btn" href="#/accounts">Back to accounts</a></section>`;
      return null;
    }
  }
  if (!ctx.calc) {
    root.innerHTML = `<section class="card"><p class="msg msg-neg">${esc(ctx.calcProblem || "The calculator isn't loaded.")} Accounts can't be edited until it is back, because numbers can't be checked.</p></section>`;
    return null;
  }
  const plans = await ctx.store.getAll('personalPlans');
  const others = (await ctx.store.getAll('accounts')).filter((a) => !original || a.id !== original.id);
  F = draftFrom(ctx, original, isNew);
  F.fromTrade = fromTrade;
  F.plans = plans;
  F.others = others;
  paintForm(ctx);
  root.addEventListener('click', (e) => onClick(ctx, e));
  root.addEventListener('input', (e) => onInput(e));
  root.addEventListener('change', (e) => onChange(ctx, e));
  return () => { formRoot = null; };
}

const str = (v) => (v === null || v === undefined ? '' : String(v));

function draftFrom(ctx, a, isNew) {
  const firm = a ? ctx.data.firmById.get(a.firmId) : null;
  const fams = firm ? planFamilies(firm.plans) : [];
  const fam = a ? fams.find((f) => f.plans.some((p) => p.id === a.planId)) : null;
  const tr = a && isNum(a.todayResult) ? a.todayResult : null;
  const fd = firm ? ctx.firmDayFor(firm) : null;
  return {
    id: a ? a.id : newId('a-'),
    isNew,
    original: a,
    name: a ? str(a.name) : '',
    firmId: a ? a.firmId : '',
    familyKey: fam ? fam.key : '',
    purchasedOn: a && a.purchasedOn ? a.purchasedOn : '',
    planBySupport: supportIdOf(a) || '',
    planId: a ? a.planId : '',
    sizeText: a && isNum(a.size) ? String(a.size) : '',
    stageId: a ? a.stageId : '',
    t: {
      balance: str(a && a.balance), equity: str(a && a.equity), resetBalance: str(a && a.resetBalance), resetEquity: str(a && a.resetEquity),
      peakClosedBalance: str(a && a.peakClosedBalance), bestDayProfit: str(a && a.bestDayProfit), otherOpenRisk: str(a && a.otherOpenRisk),
      marginUsed: str(a && a.marginUsed), todayAmt: tr === null ? '' : String(Math.abs(tr)), tradesToday: str(a && a.tradesToday),
    },
    todaySign: tr === null || tr === 0 ? '' : tr > 0 ? 'profit' : 'loss',
    payoutRequested: !!(a && a.payoutRequested === true),
    riskType: a && a.riskMethod ? a.riskMethod.type || '' : '',
    riskValue: a && a.riskMethod ? str(a.riskMethod.value) : '',
    riskMax: a && a.riskMethod ? str(a.riskMethod.maxPctOfSize) : '',
    personalPlanId: a && a.personalPlanId ? a.personalPlanId : '',
    news: a && Array.isArray(a.newsToday) ? a.newsToday.map((n) => ({ timeIST: n.timeIST, currency: n.currency })) : [],
    newsToAll: false,
    formDayKey: fd ? fd.dayKey : null,
    storedDayKey: a ? a.dayKey ?? null : null,
    errors: {},              // messages from the last Save, by box
    shownErrors: 0,          // how many of them are on screen (the summary above Save follows this)
    confirmDelete: false,
    noChange: null,          // Save found nothing changed since a logged trade: { at } (a Date, or null if unreadable)
  };
}

// What the chosen firm and plan need on this form.
function shape(ctx) {
  const firm = F.firmId ? ctx.data.firmById.get(F.firmId) || null : null;
  const fams = firm ? planFamilies(firm.plans) : [];
  const fam = fams.find((f) => f.key === F.familyKey) || null;
  // Bought on the very day the rules changed: the date can't pick the plan. The plan the firm's support
  // named (picked on the form) is used; until then the date's plan is kept and the engine blocks.
  const changeDay = !!(fam && fam.byDate && changeDayOf(fam.plans, F.purchasedOn));
  const supportPlan = changeDay && F.planBySupport ? fam.plans.find((p) => p.id === F.planBySupport) || null : null;
  let plan = null;
  if (fam) plan = supportPlan || (fam.byDate ? pickPlanByPurchase(fam.plans, F.purchasedOn) : fam.plans[0]);
  F.planId = plan ? plan.id : '';
  const sizesW = plan ? unwrap(plan.sizes) : null;
  const sizes = Array.isArray(sizesW) ? sizesW.filter(isNum) : null;
  const stages = plan && Array.isArray(plan.stages) ? plan.stages : [];
  if (stages.length === 1) F.stageId = stages[0].id;
  if (F.stageId && !stages.some((s) => s.id === F.stageId)) F.stageId = '';
  const daily = plan ? unwrap(plan.dailyLoss) : null;
  const dailyFrom = daily && typeof daily === 'object' ? daily.from : null;
  const max = plan ? unwrap(plan.maxLoss) : null;
  const cons = plan ? unwrap(plan.consistency) : null;
  const news = plan ? unwrap(plan.news) : null;
  const market = firm ? firm.market : 'cfd';
  return {
    firm, fams, fam, plan, sizes, stages, market, changeDay, supportPlan,
    dailyFrom: dailyFrom === 'closedBalanceAtReset' || dailyFrom === 'higherOfBalanceEquityAtReset' ? dailyFrom : null,
    trailing: !!(max && typeof max === 'object' && max.type === 'trailing'),
    payoutLock: !!(max && typeof max === 'object' && max.lockOnPayoutRequest === true),
    consistency: !!(cons && typeof cons === 'object'),
    newsRule: news && typeof news === 'object' ? news : null,
    fd: firm ? ctx.firmDayFor(firm) : null,
  };
}

function paintForm(ctx) {
  if (!formRoot) return;
  const s = shape(ctx);
  const e = F.errors;
  // Every message drawn below is counted: the summary above Save shows only while one is on screen.
  let shown = 0;
  const err = (k) => { if (!e[k]) return ''; shown++; return `<p class="field-msg is-bad">${esc(e[k])}</p>`; };
  const chip = (group, value, label, on) => `<button type="button" class="chip" role="radio" aria-checked="${on}" data-pick="${group}" data-value="${esc(value)}">${esc(label)}</button>`;
  const numField = (key, label, hint = '', opts = {}) => `<div class="field ${opts.wide ? 'wide' : ''}">
      <label for="a-${key}">${esc(label)}</label>
      <input id="a-${key}" data-t="${key}" type="text" inputmode="${opts.whole ? 'numeric' : 'decimal'}" autocomplete="off" autocorrect="off" spellcheck="false" value="${esc(F.t[key])}">
      ${hint ? `<p class="hint">${esc(hint)}</p>` : ''}${err(key)}</div>`;
  const parts = [];

  // 1. Firm, plan, size, stage
  parts.push(`<section class="card form-card" aria-labelledby="sec-plan"><h2 class="card-title" id="sec-plan">Firm and plan</h2>
    <div class="field wide"><label for="a-name">Name on the chips</label>
      <input id="a-name" data-name type="text" autocomplete="off" maxlength="40" value="${esc(F.name)}">
      <p class="hint">Short, like "Classic 100K". Blank uses the firm, plan and size.</p></div>
    <div class="field wide"><span class="label" id="lbl-firm">Firm</span>
      <div class="chips-wrap" role="radiogroup" aria-labelledby="lbl-firm">${ctx.data.firms.length ? ctx.data.firms.map((f) => chip('firm', f.id, f.name || f.id, f.id === F.firmId)).join('') : '<p class="msg msg-neg">No firm rules loaded.</p>'}</div>${err('firm')}</div>
    ${s.firm ? `<div class="field wide"><span class="label" id="lbl-plan">Plan</span>
      <div class="chips-wrap" role="radiogroup" aria-labelledby="lbl-plan">${s.fams.map((f) => chip('family', f.key, f.name, f.key === F.familyKey)).join('')}</div>${err('plan')}</div>` : ''}
    ${s.fam && s.fam.byDate ? `<div class="field"><label for="a-bought">Date you bought it</label>
      <input id="a-bought" data-bought type="date" value="${esc(F.purchasedOn)}" max="${esc(istDateISO(new Date()))}">
      <p class="hint">${esc(s.fam.name)} has different rules by purchase date: ${s.fam.plans.map((p) => esc(lcFirst(describePurchase(p.purchased)))).join(' or ')}. A funded account uses the date its evaluation was bought.</p>${err('bought')}</div>
      ${s.changeDay ? supportHtml(s, chip) : ''}
      ${s.plan && (!s.changeDay || s.supportPlan) ? `<p class="msg msg-info wide">Rules used: <b>${esc(s.plan.name)}</b>${s.supportPlan ? `, as ${esc(s.firm.name || s.firm.id)} support told you` : ''}. ${esc(describeValue('maxLoss', unwrap(s.plan.maxLoss)))}</p>` : ''}` : ''}
    ${s.plan ? `<div class="field wide"><span class="label" id="lbl-size">Account size</span>
      ${s.sizes && s.sizes.length
        ? `<div class="chips-wrap" role="radiogroup" aria-labelledby="lbl-size">${s.sizes.map((n) => chip('size', String(n), fmtSizeK(n), F.sizeText === String(n))).join('')}</div>`
        : `<input id="a-size" data-size type="text" inputmode="decimal" autocomplete="off" aria-labelledby="lbl-size" value="${esc(F.sizeText)}"><p class="hint">This plan has no fixed list of sizes. Type the starting balance in dollars.</p>`}
      ${err('size')}</div>
    <div class="field wide"><span class="label" id="lbl-stage">Stage</span>
      <div class="chips-wrap" role="radiogroup" aria-labelledby="lbl-stage">${s.stages.map((st) => chip('stage', st.id, st.name || st.id, st.id === F.stageId)).join('')}</div>${err('stage')}</div>` : ''}
  </section>`);

  if (s.plan) {
    // 2. Today's numbers
    const resetWhen = s.fd ? `Taken at the reset ${fmtWhenIST(s.fd.lastResetUTC)}. Type them again each trading day.` : "Can't tell when this firm's day resets.";
    const st = F.original ? numbersState(F.original, s.fd, new Date()) : null;
    const staleMsg = !st || st.kind === 'none' ? ''
      : st.kind === 'beforeReset' ? `These were typed before today's reset at ${fmtTimeIST(s.fd.lastResetUTC)} IST. Check every box, then save.`
      : st.kind === 'afterLog' ? `You logged a trade ${fmtWhenIST(st.at)}, after these were typed. Update the balance and equity, and add that trade's loss at its stop to "Other open trades" if it is still open. Then save.`
      : st.kind === 'badLog' ? 'The time of your last logged trade can\'t be read. Update the balance and equity, and add the loss at the stop of any trade still open to "Other open trades". Then save.'
      : `These were saved with a time in the future (${fmtWhenIST(st.at)}), so they can't be trusted. Check the phone's clock, check every box, then save.`;
    parts.push(`<section class="card form-card" aria-labelledby="sec-nums"><h2 class="card-title" id="sec-nums">Today's numbers</h2>
      <p class="lede wide">From the firm's dashboard. ${F.original && toDate(F.original.updatedAt) ? `Last updated ${esc(fmtWhenIST(F.original.updatedAt))}.` : ''}</p>
      ${staleMsg ? `<p class="msg msg-warn wide">${esc(staleMsg)}</p>` : ''}
      <div class="fields">
        ${numField('balance', 'Balance', 'Your closed balance now.')}
        ${numField('equity', 'Equity now', 'Blank means the same as the balance. Type it when a trade is open.')}
        ${s.dailyFrom === 'closedBalanceAtReset' ? numField('resetBalance', 'Closed balance at the reset', resetWhen) : ''}
        ${s.dailyFrom === 'higherOfBalanceEquityAtReset' ? numField('resetBalance', 'Balance at the reset', resetWhen) + numField('resetEquity', 'Equity at the reset', 'The daily floor is measured from the higher of the two.') : ''}
        ${s.trailing ? numField('peakClosedBalance', 'Highest closed balance so far', 'The trailing floor follows it. Never below your balance.') : ''}
        ${s.consistency ? numField('bestDayProfit', "Best day's profit so far", 'For the best-day rule. Information only.') : ''}
        ${numField('otherOpenRisk', 'Other open trades: loss at their stops', "If your other open trades hit their stops: the total loss, plus any open profit you'd give back. Blank means none.")}
        ${s.market === 'cfd' ? numField('marginUsed', 'Margin in use now', 'From MT5. Blank means none.') : ''}
      </div>
      ${s.payoutLock ? `<label class="check wide"><input type="checkbox" data-payout ${F.payoutRequested ? 'checked' : ''}> I have asked for a payout on this account (the max-loss floor locks at the starting balance)</label>` : ''}
    </section>`);

    // 3. Today's result and trades
    parts.push(`<section class="card form-card" aria-labelledby="sec-today"><h2 class="card-title" id="sec-today">Today so far</h2>
      <p class="lede wide">${s.fd ? `Goes back to 0 at the firm's reset, ${esc(fmtTimeIST(s.fd.nextResetUTC))} IST.` : ''}</p>
      <div class="fields">
        <div class="field"><span class="label" id="lbl-today">Closed result today</span>
          <div class="seg" role="radiogroup" aria-labelledby="lbl-today">
            <button type="button" class="seg-btn" role="radio" aria-checked="${F.todaySign === 'profit'}" data-pick="sign" data-value="profit">Profit</button>
            <button type="button" class="seg-btn" role="radio" aria-checked="${F.todaySign === 'loss'}" data-pick="sign" data-value="loss">Loss</button>
          </div>
          <input id="a-todayAmt" data-t="todayAmt" type="text" inputmode="decimal" autocomplete="off" aria-labelledby="lbl-today" value="${esc(F.t.todayAmt)}">
          <p class="hint">0 if nothing has closed today.</p>${err('todayAmt')}</div>
        ${numField('tradesToday', 'Trades taken today', '0 if none. Logging a trade adds one.', { whole: true })}
      </div>
    </section>`);

    // 4. Risk
    const vLabel = F.riskType === 'usd' ? 'Risk per trade ($)' : F.riskType === 'pctOfBalance' ? 'Risk per trade (% of balance)' : 'Risk per trade (% of account size)';
    const pp = F.plans.find((p) => p.id === F.personalPlanId) || null;
    parts.push(`<section class="card form-card" aria-labelledby="sec-risk"><h2 class="card-title" id="sec-risk">Risk</h2>
      <div class="field wide"><span class="label" id="lbl-rm">How the risk is set</span>
        <div class="chips-wrap" role="radiogroup" aria-labelledby="lbl-rm">${RISK_CHOICES.map((c) => chip('risk', c.id, c.label, F.riskType === c.id)).join('')}</div>${err('riskType')}</div>
      <div class="fields">
        ${F.riskType && F.riskType !== 'personalPlan' ? `<div class="field"><label for="a-riskValue">${esc(vLabel)}</label>
          <input id="a-riskValue" data-risk="value" type="text" inputmode="decimal" autocomplete="off" value="${esc(F.riskValue)}">${err('riskValue')}</div>` : ''}
        <div class="field"><label for="a-riskMax">Never more than (% of account size)</label>
          <input id="a-riskMax" data-risk="max" type="text" inputmode="decimal" autocomplete="off" value="${esc(F.riskMax)}">
          <p class="hint">Required. Any trade above it is NO TRADE.</p>${err('riskMax')}</div>
        <div class="field"><label for="a-plan">Personal plan</label>
          <select id="a-plan" data-pplan>
            <option value="">None</option>
            ${F.plans.map((p) => `<option value="${esc(p.id)}" ${p.id === F.personalPlanId ? 'selected' : ''}>${esc(p.name || p.id)}</option>`).join('')}
          </select>
          <p class="hint">${F.plans.length ? 'Its rules (trades a day, time windows, risk) are checked on every trade.' : 'Import a plan in Backup to use one.'}</p>${err('personalPlanId')}</div>
      </div>
      ${pp && !pp.risk && F.riskType === 'personalPlan' ? '<p class="msg msg-neg wide">This plan has no risk numbers, so it can\'t set the risk. Pick another way to set the risk, or another plan.</p>' : ''}
      ${pp && !pp.risk && F.riskType && F.riskType !== 'personalPlan' ? '<p class="msg msg-info wide">This plan has no risk numbers: the risk comes from the setting above, and only the plan\'s other rules are checked.</p>' : ''}
      ${planClassHtml(ctx, pp)}
    </section>`);

    // 5. News
    const ccys = newsCurrencies(ctx, s.firm);
    parts.push(`<section class="card form-card" aria-labelledby="sec-news"><h2 class="card-title" id="sec-news">High-impact news today (IST)</h2>
      <p class="lede wide">${s.newsRule ? esc(describeValue('news', s.newsRule)) : "This plan has no news rule, so these times aren't checked."} Cleared at the firm's reset.</p>
      <ul class="news-list wide">${F.news.map((n, i) => `<li class="news-row">
        <input type="time" data-news-time="${i}" value="${esc(n.timeIST || '')}" aria-label="News time ${i + 1}, IST">
        <select data-news-ccy="${i}" aria-label="News currency ${i + 1}">${ccys.map((c) => `<option ${c === n.currency ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <button type="button" class="btn btn-small btn-quiet" data-news-remove="${i}">Remove</button>
        ${err('news' + i)}</li>`).join('')}</ul>
      <div class="row-actions wide"><button type="button" class="btn btn-small" data-act="news-add">${ICONS.plus}<span>Add a news time</span></button>
        ${F.others.length ? `<label class="check"><input type="checkbox" data-news-all ${F.newsToAll ? 'checked' : ''}> Use these times on my other ${plural(F.others.length, 'account')} too</label>` : ''}</div>
    </section>`);
  }

  // Save and delete
  F.shownErrors = shown;
  parts.push(`<div class="form-actions" id="form-actions">${formActionsHtml()}</div>`);
  if (!F.isNew) {
    parts.push(`<section class="card danger" aria-labelledby="sec-del"><h2 class="card-title" id="sec-del">Delete this account</h2>
      ${F.confirmDelete
        ? `<p>Delete <b>${esc(F.original.name || 'this account')}</b> from this device? Its journal entries stay. This can't be undone.</p>
           <div class="row-actions"><button type="button" class="btn btn-danger" data-act="delete-yes">Delete account</button><button type="button" class="btn btn-quiet" data-act="delete-no">Keep it</button></div>`
        : `<p class="muted">Removes it from this device. Journal entries stay.</p><button type="button" class="btn btn-danger-quiet" data-act="delete">Delete account…</button>`}
    </section>`);
  }
  const focused = document.activeElement && formRoot.contains(document.activeElement) ? focusKey(document.activeElement) : null;
  formRoot.innerHTML = `<div class="title-row"><p class="lede">${F.isNew ? 'A new account, saved on this device only.' : `Editing ${esc(F.original.name || 'account')}.`}</p></div>${parts.join('')}`;
  if (focused) { const el = formRoot.querySelector(focused); if (el) el.focus({ preventScroll: true }); }
}

// The purchase date is the very day the firm's rules changed (a plan's "before" or "on or after" date).
function changeDayOf(plans, dateISO) {
  if (!isISODate(dateISO)) return false;
  return (plans || []).some((p) => { const c = unwrap(p.purchased); return !!c && (c.before === dateISO || c.onOrAfter === dateISO); });
}

// Bought on the day the rules changed: the firm gave the day but not the time, so only its support can say
// which rules the account follows. One chip per plan of the family records their answer.
function supportHtml(s, chip) {
  const firmName = s.firm.name || s.firm.id;
  const day = fmtISODate(F.purchasedOn);
  const hint = s.supportPlan
    ? 'Your answer is kept with this account. If their support named other rules, pick those instead.'
    : `${firmName} didn't say what time on ${day} its rules changed, so the date can't tell which rules this account follows. Ask their support, then pick their answer. Until then this account shows NO TRADE.`;
  return `<div class="field wide"><span class="label" id="lbl-support">Which rules did ${esc(firmName)} support say this account follows?</span>
      <div class="chips-wrap" role="radiogroup" aria-labelledby="lbl-support">${s.fam.plans.map((p) => chip('support', p.id, p.name || p.id, p.id === F.planBySupport)).join('')}</div>
      <p class="${s.supportPlan ? 'hint' : 'msg msg-warn'}">${esc(hint)}</p></div>`;
}

// The Save area: the form's error summary, then the buttons. After Save found that nothing changed since a
// logged trade, it asks first: "Save anyway" or "Go back".
function formActionsHtml() {
  const e = F.errors || {};
  const summary = e._form || F.shownErrors ? `<p class="msg msg-neg" role="alert">${esc(e._form || 'Some boxes need fixing before this can be saved. They are marked below.')}</p>` : '';
  if (F.noChange) {
    return `${summary}<p class="msg msg-warn" role="alert" id="nochange-msg">${esc(noChangeText(F.noChange.at))}</p>
      <button type="button" class="btn btn-primary" data-act="save-anyway">Save anyway</button>
      <button type="button" class="btn btn-quiet" data-act="save-back">Go back</button>`;
  }
  return `${summary}<button type="button" class="btn btn-primary" data-act="save">Save account</button>
    <a class="btn btn-quiet" href="${F.fromTrade ? '#/trade' : '#/accounts'}">Cancel</a>`;
}
export function noChangeText(at, now = new Date()) {
  const tail = 'If it is still open, add its risk to Other open trades. If it closed, type the new balance and equity.';
  const d = toDate(at);
  if (!d) return `Nothing changed since your last logged trade, and its time can't be read. ${tail}`;
  const when = istDateISO(d) === istDateISO(now) ? `${fmtTimeIST(d)} IST` : `${fmtTimeIST(d)} IST on ${fmtDateIST(d)}`;
  return `Nothing changed since the trade you logged at ${when}. ${tail}`;
}
// What is wrong with the purchase date, or '' when it is fine (or this plan doesn't ask for one).
function boughtProblem(s, now) {
  if (!s.fam || !s.fam.byDate) return '';
  if (!F.purchasedOn) return 'Type the date you bought it. The rules depend on it.';
  if (!isISODate(F.purchasedOn)) return 'Use a real date.';
  if (F.purchasedOn > istDateISO(now)) return "That date hasn't happened yet.";
  if (!s.plan) return 'No rule set matches that date. Check the date.';
  return '';
}
// What is wrong with the personal plan picked for this account (pp: the plan, or null), or ''.
function planPickProblem(pp) {
  if (F.riskType === 'personalPlan' && pp && !pp.risk) return "This plan has no risk numbers, so it can't set the risk. Pick another way to set the risk, or another plan.";
  if (F.riskType === 'personalPlan' && !pp) return 'Pick the personal plan the risk comes from.';
  if (F.personalPlanId && !pp) return 'This plan is no longer on this device.';
  return '';
}

// A message from the last Save goes as soon as a pick has fixed what it was about: the firm, the plan,
// the purchase date, the size, the stage, Profit or Loss, the way the risk is set, the personal plan.
// One that still stands stays, in the words that fit what is on screen now. A box the trader types in
// keeps its message until the next Save.
function dropFixedMessages(ctx) {
  const e = F.errors;
  if (!e || !Object.keys(e).length) return;
  const s = shape(ctx);
  if (s.firm) delete e.firm;
  if (s.fam) delete e.plan;
  if (e.bought) {
    const m = boughtProblem(s, new Date());
    if (m) e.bought = m; else delete e.bought;
  }
  if (e.size && s.plan) {
    const chips = !!(s.sizes && s.sizes.length);
    if (chips && F.sizeText && s.sizes.includes(Number(F.sizeText))) delete e.size;
    else if (chips) e.size = PICK_SIZE;
    else if (e.size === PICK_SIZE) e.size = TYPE_SIZE;        // this plan has a box to type the size in
  }
  if (s.stages.some((st) => st.id === F.stageId)) delete e.stage;
  if (e.todayAmt === PICK_SIGN && F.todaySign) delete e.todayAmt;
  if (F.riskType) delete e.riskType;
  if (e.personalPlanId) {
    const m = planPickProblem(F.plans.find((p) => p.id === F.personalPlanId) || null);
    if (m) e.personalPlanId = m; else delete e.personalPlanId;
  }
}

// Balance, equity (blank = the balance) and other open trades (blank = none), as the floors use them.
function openNumbers(o) {
  const bal = isNum(o.balance) ? o.balance : null;
  return [bal, isNum(o.equity) ? o.equity : bal, isNum(o.otherOpenRisk) ? o.otherOpenRisk : 0];
}

// A plan saved before class names were checked can name a class the app doesn't use: say so here.
function planClassHtml(ctx, pp) {
  const bad = pp ? unknownPlanClasses(pp, ctx.classIds) : [];
  if (!bad.length) return '';
  return `<p class="msg msg-neg wide">This plan names ${bad.length === 1 ? 'a class' : 'classes'} Risk Desk doesn't use (${esc(bad.map((b) => b.name).join(', '))}), so this account shows NO TRADE until the plan is fixed. ${esc(classNameHelp(bad[0].name, ctx.classIds))} Fix the plan file and import it again in Backup.</p>`;
}

function focusKey(el) {
  if (el.dataset.pick) return `[data-pick="${el.dataset.pick}"][data-value="${CSS.escape(el.dataset.value)}"]`;
  if (el.id) return `#${CSS.escape(el.id)}`;
  return null;
}

function newsCurrencies(ctx, firm) {
  const set = new Set();
  for (const id of [].concat(firm && firm.instruments ? firm.instruments : [])) {
    for (const s of symbolsOf(ctx.data.instrumentsById.get(id))) for (const c of Array.isArray(s.newsCurrencies) ? s.newsCurrencies : []) if (typeof c === 'string' && /^[A-Z]{3}$/.test(c)) set.add(c);
  }
  for (const n of F.news) if (n.currency) set.add(n.currency);
  const list = [...set].sort();
  const base = list.length ? list : ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD'];
  return base.includes('USD') ? ['USD', ...base.filter((c) => c !== 'USD')] : base;
}

// ---------- Form events ----------
function onInput(e) {
  const t = e.target;
  if (!F) return;
  if (t.dataset.t) {
    F.t[t.dataset.t] = t.value;
    // A number is being typed: the "nothing changed" question no longer applies. Only the Save area is
    // redrawn, so the box being typed in keeps the focus.
    if (F.noChange) {
      F.noChange = null;
      const box = formRoot && formRoot.querySelector('#form-actions');
      if (box) box.innerHTML = formActionsHtml();
    }
  }
  else if (t.hasAttribute('data-name')) F.name = t.value;
  else if (t.hasAttribute('data-size')) F.sizeText = t.value;
  else if (t.dataset.risk === 'value') F.riskValue = t.value;
  else if (t.dataset.risk === 'max') F.riskMax = t.value;
  else if (t.dataset.newsTime !== undefined) F.news[Number(t.dataset.newsTime)].timeIST = t.value;
}

function onChange(ctx, e) {
  const t = e.target;
  if (!F) return;
  if (t.hasAttribute('data-bought')) {
    // Support's answer was for the rule-change day: any other date clears it.
    if (t.value !== F.purchasedOn) F.planBySupport = '';
    F.purchasedOn = t.value;
    dropFixedMessages(ctx);
    paintForm(ctx);
  }
  else if (t.hasAttribute('data-pplan')) { F.personalPlanId = t.value; dropFixedMessages(ctx); paintForm(ctx); }
  else if (t.dataset.newsCcy !== undefined) F.news[Number(t.dataset.newsCcy)].currency = t.value;
  else if (t.dataset.newsTime !== undefined) F.news[Number(t.dataset.newsTime)].timeIST = t.value;
  else if (t.hasAttribute('data-payout')) F.payoutRequested = t.checked;
  else if (t.hasAttribute('data-news-all')) F.newsToAll = t.checked;
}

async function onClick(ctx, e) {
  if (!F) return;
  const pick = e.target.closest('[data-pick]');
  if (pick) {
    const v = pick.dataset.value;
    switch (pick.dataset.pick) {
      case 'firm':
        if (F.firmId !== v) {
          F.firmId = v; F.familyKey = ''; F.planId = ''; F.purchasedOn = ''; F.planBySupport = ''; F.sizeText = ''; F.stageId = '';
          const fd = ctx.firmDayFor(ctx.data.firmById.get(v));
          F.formDayKey = fd ? fd.dayKey : null;
          if (F.errors.size) F.errors.size = PICK_SIZE;       // the size was emptied: what still stands is that none is chosen
        }
        break;
      case 'family':
        if (F.familyKey !== v) {
          F.familyKey = v; F.planBySupport = ''; F.stageId = ''; F.sizeText = '';
          if (F.errors.size) F.errors.size = PICK_SIZE;
        }
        break;
      case 'support': F.planBySupport = v; break;
      case 'size': F.sizeText = v; break;
      case 'stage': F.stageId = v; break;
      case 'sign': F.todaySign = v; break;
      case 'risk':
        // Never carry a % into $ or back: the box is emptied, and a message about the old number goes with it.
        if (F.riskType !== v) { F.riskType = v; F.riskValue = ''; delete F.errors.riskValue; }
        break;
      default: return;
    }
    dropFixedMessages(ctx);
    paintForm(ctx);
    return;
  }
  const rm = e.target.closest('[data-news-remove]');
  if (rm) {
    const at = Number(rm.dataset.newsRemove);
    F.news.splice(at, 1);
    // The removed row's message goes with it; the rows below move up one, and so do their messages.
    const moved = {};
    for (const k of Object.keys(F.errors)) {
      const m = /^news(\d+)$/.exec(k);
      if (!m) continue;
      const i = Number(m[1]);
      if (i !== at) moved[`news${i > at ? i - 1 : i}`] = F.errors[k];
      delete F.errors[k];
    }
    Object.assign(F.errors, moved);
    paintForm(ctx);
    return;
  }
  const act = e.target.closest('[data-act]');
  if (!act) return;
  if (act.dataset.act === 'news-add') {
    const ccys = newsCurrencies(ctx, ctx.data.firmById.get(F.firmId));
    F.news.push({ timeIST: '', currency: ccys[0] || 'USD' });
    paintForm(ctx);
    const last = formRoot.querySelector(`[data-news-time="${F.news.length - 1}"]`);
    if (last) last.focus();
  } else if (act.dataset.act === 'save') {
    await save(ctx);
  } else if (act.dataset.act === 'save-anyway') {
    await save(ctx, { anyway: true });
  } else if (act.dataset.act === 'save-back') {
    F.noChange = null;
    paintForm(ctx);
    const bal = formRoot.querySelector('#a-balance');
    if (bal) { bal.focus(); if (typeof bal.scrollIntoView === 'function') bal.scrollIntoView({ block: 'center' }); }
  } else if (act.dataset.act === 'delete') { F.confirmDelete = true; paintForm(ctx); }
  else if (act.dataset.act === 'delete-no') { F.confirmDelete = false; paintForm(ctx); }
  else if (act.dataset.act === 'delete-yes') {
    await ctx.store.delete('accounts', F.original.id);
    ctx.toast(`Deleted ${F.original.name || 'the account'}.`);
    F = null;
    ctx.go('#/accounts');
  }
}

// ---------- Save ----------
function readMoney(ctx, text) {
  let r;
  try { r = ctx.calc.readNum(text, { money: true }); } catch { r = { ok: false, message: "This isn't a number." }; }
  return r;
}

// anyway: the trader tapped "Save anyway" after being told nothing changed since a logged trade.
async function save(ctx, { anyway = false } = {}) {
  const s = shape(ctx);
  const e = {};
  const now = new Date();
  F.noChange = null;
  // Firm and plan
  if (!s.firm) e.firm = 'Pick the firm.';
  else if (!s.fam) e.plan = 'Pick the plan.';
  else {
    const m = boughtProblem(s, now);
    if (m) e.bought = m;
  }
  let size = null;
  if (s.plan) {
    if (s.sizes && s.sizes.length) {
      size = Number(F.sizeText);
      if (!F.sizeText || !s.sizes.includes(size)) { e.size = PICK_SIZE; size = null; }
    } else {
      const r = readMoney(ctx, F.sizeText);
      if (!r.ok) e.size = r.message;
      else if (r.empty || !(r.value > 0)) e.size = TYPE_SIZE;
      else size = r.value;
    }
    if (!s.stages.some((st) => st.id === F.stageId)) e.stage = 'Pick the stage.';
  }
  // Numbers
  const nums = {};
  const want = (key, { required = false, shown = true } = {}) => {
    if (!shown) { nums[key] = null; return; }
    const r = readMoney(ctx, F.t[key]);
    if (!r.ok) { e[key] = r.message; return; }
    if (r.empty) { if (required) e[key] = 'Type this number.'; nums[key] = null; return; }
    if (r.value < 0) { e[key] = "This can't be negative."; return; }
    nums[key] = r.value;
  };
  if (s.plan) {
    want('balance', { required: true });
    want('equity');
    want('resetBalance', { shown: !!s.dailyFrom });
    want('resetEquity', { shown: s.dailyFrom === 'higherOfBalanceEquityAtReset' });
    want('peakClosedBalance', { required: s.trailing, shown: s.trailing });
    want('bestDayProfit', { shown: s.consistency });
    want('otherOpenRisk');
    want('marginUsed', { shown: s.market === 'cfd' });
    if (s.trailing && isNum(nums.peakClosedBalance) && isNum(nums.balance) && nums.peakClosedBalance < nums.balance) {
      e.peakClosedBalance = 'The highest closed balance is never below the balance now.';
    }
    // Today
    const amt = readMoney(ctx, F.t.todayAmt);
    if (!amt.ok) e.todayAmt = amt.message;
    else if (!amt.empty && amt.value < 0) e.todayAmt = 'Type the amount without a minus, then pick Profit or Loss.';
    else if (amt.empty) nums.todayResult = null;
    else if (amt.value === 0) nums.todayResult = 0;
    else if (!F.todaySign) e.todayAmt = PICK_SIGN;
    else nums.todayResult = F.todaySign === 'loss' ? -amt.value : amt.value;
    const tt = F.t.tradesToday.trim();
    if (tt === '') nums.tradesToday = null;
    else if (!/^\d{1,3}$/.test(tt)) e.tradesToday = 'Type a whole number, like 0, 1 or 2.';
    else nums.tradesToday = Number(tt);
  }
  // Risk
  let riskValue = null, riskMax = null;
  if (s.plan) {
    if (!F.riskType) e.riskType = 'Pick how the risk is set.';
    else if (F.riskType !== 'personalPlan') {
      const r = readMoney(ctx, F.riskValue);
      if (!r.ok) e.riskValue = r.message;
      else if (r.empty || !(r.value > 0)) e.riskValue = 'Type the risk per trade.';
      else if (F.riskType !== 'usd' && r.value > 100) e.riskValue = 'A percentage can\'t be above 100.';
      else riskValue = r.value;
    }
    const m = readMoney(ctx, F.riskMax);
    if (!m.ok) e.riskMax = m.message;
    else if (m.empty || !(m.value > 0)) e.riskMax = 'Set the most you will risk on one trade.';
    else if (m.value > 100) e.riskMax = "A percentage can't be above 100.";
    else riskMax = m.value;
    if (F.riskType === 'pctOfSize' && isNum(riskValue) && isNum(riskMax) && riskValue > riskMax) e.riskValue = `This is above your max of ${fmtPct(riskMax)}.`;
    if (F.riskType === 'usd' && isNum(riskValue) && isNum(riskMax) && isNum(size) && riskValue > (size * riskMax) / 100) e.riskValue = `This is above your max of ${fmtPct(riskMax)} of the account size.`;
    const pp = F.plans.find((p) => p.id === F.personalPlanId) || null;
    const planProblem = planPickProblem(pp);
    if (planProblem) e.personalPlanId = planProblem;
    // The engine never assumes a blank count or result is 0: with a plan that counts trades or checks
    // today's result, a blank box gives NO TRADE. Ask for it here instead.
    if (pp) {
      const countsTrades = Number.isInteger(pp.maxTradesPerDay) || isNum(pp.noSecondTradeIfFirstLostMorePctOfSize);
      const usesResult = isNum(pp.noSecondTradeIfFirstLostMorePctOfSize) || isNum(pp.fundedStopForDayAtProfitPctOfSize);
      if (countsTrades && nums.tradesToday === null && !e.tradesToday) e.tradesToday = 'Your personal plan counts trades. Type 0 if none today.';
      if (usesResult && nums.todayResult === null && !e.todayAmt) e.todayAmt = "Your personal plan uses today's result. Type 0 if nothing has closed today.";
    }
  }
  // News
  const news = [];
  F.news.forEach((n, i) => {
    if (!n.timeIST && !n.currency) return;
    if (!isHHMM(n.timeIST)) e['news' + i] = 'Pick the time, like 6:00 PM.';
    else if (!/^[A-Z]{3}$/.test(n.currency || '')) e['news' + i] = 'Pick the currency.';
    else news.push({ timeIST: n.timeIST, currency: n.currency });
  });

  // A new trading day may have started while the form was open, or before it was opened and before the
  // 30-second roll ran: its today fields would be yesterday's. Compare the day the form was opened in,
  // the day stored with the account, and the firm's day now.
  const fdNow = s.firm ? ctx.firmDayFor(s.firm, now) : null;
  const stored = F.isNew ? null : await ctx.store.get('accounts', F.original.id);
  if (!F.isNew && !stored) e._form = 'This account was deleted on this device. Go back to the list.';
  const dayChanged = (F.formDayKey && fdNow && fdNow.dayKey !== F.formDayKey)
    || (stored && (stored.dayKey ?? null) !== F.storedDayKey)
    || (stored && stored.dayKey && fdNow && stored.dayKey !== fdNow.dayKey && stored.firmId === s.firm.id);
  if (dayChanged && !e._form) {
    await ctx.rollDays(now);
    const fresh = stored ? await ctx.store.get('accounts', stored.id) : null;
    // Values that belong to one trading day are cleared; everything else typed here is kept.
    F.t.resetBalance = ''; F.t.resetEquity = ''; F.t.todayAmt = ''; F.t.tradesToday = ''; F.todaySign = ''; F.news = [];
    F.formDayKey = fdNow ? fdNow.dayKey : null;
    F.storedDayKey = fresh ? fresh.dayKey ?? null : null;
    F.errors = { _form: `A new trading day started at ${fdNow ? fmtTimeIST(fdNow.lastResetUTC) : 'the reset'} IST while this was open. The reset values, today's result, trades and news times were cleared. Type them for the new day, then save.` };
    paintForm(ctx);
    window.scrollTo(0, 0);
    return;
  }

  F.errors = e;
  if (Object.keys(e).length) {
    paintForm(ctx);
    // Save never stops without saying why: if no message could be drawn next to a box, say it above Save.
    if (!F.shownErrors && !e._form) { e._form = 'Some boxes need fixing before this can be saved.'; paintForm(ctx); }
    const first = formRoot.querySelector('.field-msg.is-bad, [role="alert"]');
    if (first) first.scrollIntoView({ block: 'center' });
    return;
  }

  const base = stored || {};
  // A trade was logged after these numbers were saved (or its time can't be read), and the balance, equity
  // and other open trades are exactly as they were: the numbers most likely don't include that trade yet.
  // Ask before saving: saving stamps them as up to date, and the next trade would be sized on them.
  const before = toDate(base.updatedAt);
  const loggedAt = toDate(base.lastLoggedAt);
  const badLogged = loggedUnreadable(base);
  const loggedSince = badLogged || !!(loggedAt && (!before || loggedAt > before));
  if (!F.isNew && loggedSince && !anyway) {
    const was = openNumbers(base), typed = openNumbers(nums);
    if (was.every((x, i) => x === typed[i])) {
      F.noChange = { at: badLogged ? null : loggedAt };
      paintForm(ctx);
      const m = formRoot.querySelector('#nochange-msg');
      if (m) m.scrollIntoView({ block: 'center' });
      return;
    }
  }

  const acct = {
    ...base,
    id: F.id,
    name: F.name.trim() || `${s.fam.name} ${fmtSizeK(size)}`.trim(),
    firmId: s.firm.id,
    planId: s.plan.id,
    size,
    stageId: F.stageId,
    purchasedOn: s.fam.byDate ? F.purchasedOn : null,
    // Only for a purchase on the rule-change day: the plan the firm's support named (shape() uses it).
    planBySupport: s.supportPlan ? s.supportPlan.id : null,
    balance: nums.balance, equity: nums.equity, resetBalance: nums.resetBalance, resetEquity: nums.resetEquity,
    peakClosedBalance: nums.peakClosedBalance, payoutRequested: s.payoutLock ? F.payoutRequested : false,
    bestDayProfit: nums.bestDayProfit, todayResult: nums.todayResult, tradesToday: nums.tradesToday,
    otherOpenRisk: nums.otherOpenRisk, marginUsed: nums.marginUsed,
    riskMethod: { type: F.riskType, value: F.riskType === 'personalPlan' ? null : riskValue, maxPctOfSize: riskMax },
    personalPlanId: F.personalPlanId || null,
    newsToday: news,
    dayKey: fdNow ? fdNow.dayKey : base.dayKey ?? null,
  };
  // Saving the form when the numbers were out of date confirms them: the form asks the trader to check
  // every box before saving (and, after a logged trade, asks again above when nothing changed). Out of
  // date: no readable update time, typed before the firm's reset, a trade logged after they were typed
  // (Log trade stamps lastLoggedAt) or a logged time that can't be read, or an update time in the future
  // (a phone clock that was ahead). Without this, an account whose numbers didn't move could never clear
  // STALE_BALANCES.
  const wasStale = !before || !!(fdNow && before < fdNow.lastResetUTC) || before > now || loggedSince;
  const changed = F.isNew || wasStale || BALANCE_FIELDS.some((k) => (base[k] ?? null) !== (acct[k] ?? null)) || base.planId !== acct.planId || base.size !== acct.size;
  acct.updatedAt = changed ? now.toISOString() : base.updatedAt ?? null;
  // Every logged trade was saved before this save, so these numbers include it. A logged time later than
  // now can only come from a phone clock that was ahead, and one that can't be read (1e20 in an old
  // backup) proves nothing: left in place, the engine would keep blocking (STALE_BALANCES) even after the
  // numbers were updated, so the account could never be cleared.
  if (changed && ((loggedAt && loggedAt > now) || badLogged)) acct.lastLoggedAt = null;
  try {
    await ctx.store.put('accounts', acct);
    if (F.newsToAll && F.others.length) {
      const all = await ctx.store.getAll('accounts');
      await ctx.store.putMany('accounts', all.filter((a) => a.id !== acct.id).map((a) => ({ ...a, newsToday: news.map((n) => ({ ...n })) })));
    }
  } catch (err) {
    console.error(err);
    F.errors = { _form: "Couldn't save on this device. Check that the browser allows storage, then try again." };
    paintForm(ctx);
    return;
  }
  ctx.toast(changed ? `Saved ${acct.name}. Numbers stamped ${fmtTimeIST(now)} IST.` : `Saved ${acct.name}.`);
  const back = F.fromTrade ? '#/trade' : '#/accounts';
  F = null;
  ctx.go(back);
}

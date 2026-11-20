// Journal screen: trades logged from the Trade screen, newest first. Add the result and notes later.
// Export to CSV with India times. The journal stays on this device.

import { esc, fmtMoney, fmtPrice, fmtWhenIST, istDateISO, istTime24, toCSV, csvMoney, downloadFile, plural } from '../ui.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const OUTCOMES = [
  { id: 'win', label: 'Win' }, { id: 'loss', label: 'Loss' }, { id: 'breakeven', label: 'Breakeven' }, { id: 'skipped', label: 'Not taken' },
];
const outcomeLabel = (id) => (OUTCOMES.find((o) => o.id === id) || {}).label || '';
const J = { filter: 'all', openId: null, draft: null, errors: {}, confirmDel: false };
let screen = null;

export async function render(root, ctx) {
  screen = { root, ctx };
  await paint();
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onInput);
  return () => { screen = null; };
}

async function load() {
  const { ctx } = screen;
  const entries = (await ctx.store.getAll('journal')).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const accounts = await ctx.store.getAll('accounts');
  return { entries, accounts };
}

async function paint() {
  if (!screen) return;
  const { root } = screen;
  const { entries, accounts } = await load();
  screen.entries = entries;
  screen.accounts = accounts;
  if (!entries.length) {
    root.innerHTML = `<div class="title-row"><p class="lede">Nothing logged yet.</p></div>
      <section class="card first-run"><h2 class="card-title">Your trades land here</h2>
      <p>On the Trade screen, a GO result has a Log trade button. One tap adds the trade here. Add the result and notes later.</p>
      <a class="btn" href="#/trade">Go to Trade</a></section>`;
    return;
  }
  const names = new Map();
  for (const e of entries) if (e.accountId) names.set(e.accountId, e.accountName || 'Account');
  if (J.filter !== 'all' && !names.has(J.filter)) J.filter = 'all';
  const shown = J.filter === 'all' ? entries : entries.filter((e) => e.accountId === J.filter);
  const open = shown.filter((e) => !e.outcome).length;
  const lede = `${plural(shown.length, 'trade')} logged${open ? ` · ${open} without a result` : ''}.`;
  const filters = names.size > 1 ? `<div class="chips-row" role="radiogroup" aria-label="Account">
      <button type="button" class="chip" role="radio" aria-checked="${J.filter === 'all'}" data-filter="all">All</button>
      ${[...names.entries()].map(([id, n]) => `<button type="button" class="chip" role="radio" aria-checked="${J.filter === id}" data-filter="${esc(id)}">${esc(n)}</button>`).join('')}
    </div>` : '';
  root.innerHTML = `<div class="title-row"><p class="lede">${esc(lede)}</p>
      <button type="button" class="btn" data-act="csv">Export CSV</button></div>
    ${filters}
    <section class="card list-card"><ul class="rows">${shown.map((e) => rowHtml(e, accounts)).join('')}</ul></section>`;
  if (J.openId) {
    const first = root.querySelector('.jedit [data-pick], .jedit input, .jedit textarea');
    if (first && !root.contains(document.activeElement)) first.focus({ preventScroll: true });
  }
}

function priceLine(e) {
  const d = isNum(e.digits) ? e.digits : undefined;
  const bits = [];
  if (isNum(e.entry)) bits.push(`entry ${fmtPrice(e.entry, d)}`);
  if (isNum(e.stop)) bits.push(`stop ${fmtPrice(e.stop, d)}`);
  if (isNum(e.target)) bits.push(`target ${fmtPrice(e.target, d)}`);
  if (isNum(e.riskAtStop)) bits.push(`loss at stop ${fmtMoney(e.riskAtStop)}`);
  return bits.join(' · ');
}

function rowHtml(e, accounts) {
  const open = J.openId === e.id;
  const dir = e.direction === 'buy' || e.direction === 'sell' ? `<span class="dir dir-${e.direction}">${e.direction === 'buy' ? 'Buy' : 'Sell'}</span>` : '';
  const figure = isNum(e.pnl)
    ? `<span class="num">${fmtMoney(e.pnl, { sign: true })}</span><span class="row-sub">${esc(outcomeLabel(e.outcome))}</span>`
    : e.outcome ? `<span class="row-sub">${esc(outcomeLabel(e.outcome))}</span>` : '<span class="link-text">Add result</span>';
  return `<li class="jrow${open ? ' is-open' : ''}">
    <button type="button" class="row-link" data-open="${esc(e.id)}" aria-expanded="${open}">
      <span class="row-main">
        <span class="row-title">${dir}<span>${esc(e.symbol || '')}</span><span class="num">${esc(e.sizeText || String(e.size ?? ''))}</span><span class="muted">${esc(e.unit || '')}</span></span>
        <span class="row-sub">${esc(e.accountName || 'Account')} · ${esc(fmtWhenIST(e.createdAt))}</span>
        <span class="row-sub num">${esc(priceLine(e))}</span>
        ${e.notes && !open ? `<span class="row-sub row-notes">${esc(e.notes)}</span>` : ''}
      </span>
      <span class="row-figure">${figure}</span>
    </button>
    ${open ? editorHtml(e, accounts) : ''}
  </li>`;
}

function editorHtml(e, accounts) {
  const d = J.draft;
  const err = (k) => (J.errors[k] ? `<p class="field-msg is-bad">${esc(J.errors[k])}</p>` : '');
  const acct = accounts.find((a) => a.id === e.accountId) || null;
  const sameDay = acct && e.dayKey && acct.dayKey === e.dayKey;
  let addToday = '';
  if (e.addedToToday) addToday = `<p class="hint wide">This result was added to today's result on ${esc(e.accountName)}. Change it there if needed.</p>`;
  else if (sameDay) addToday = `<label class="check wide"><input type="checkbox" data-j="addToday" ${d.addToday ? 'checked' : ''}> Also add this result to today's result on ${esc(acct.name)}</label>`;
  return `<div class="jedit" aria-label="Result for this trade">
    <div class="field wide"><span class="label" id="lbl-out-${esc(e.id)}">Outcome</span>
      <div class="chips-wrap" role="radiogroup" aria-labelledby="lbl-out-${esc(e.id)}">${OUTCOMES.map((o) => `<button type="button" class="chip" role="radio" aria-checked="${d.outcome === o.id}" data-pick="outcome" data-value="${o.id}">${o.label}</button>`).join('')}</div>${err('outcome')}</div>
    <div class="field"><span class="label" id="lbl-pnl-${esc(e.id)}">Result in dollars</span>
      <div class="seg" role="radiogroup" aria-labelledby="lbl-pnl-${esc(e.id)}">
        <button type="button" class="seg-btn" role="radio" aria-checked="${d.sign === 'profit'}" data-pick="sign" data-value="profit">Profit</button>
        <button type="button" class="seg-btn" role="radio" aria-checked="${d.sign === 'loss'}" data-pick="sign" data-value="loss">Loss</button>
      </div>
      <input type="text" inputmode="decimal" autocomplete="off" data-j="amt" value="${esc(d.amt)}" aria-labelledby="lbl-pnl-${esc(e.id)}">
      <p class="hint">After commission, as MT5 or the firm shows it. Blank if not known yet.</p>${err('amt')}</div>
    <div class="field wide"><label for="j-notes">Notes</label>
      <textarea id="j-notes" data-j="notes" rows="3" maxlength="2000">${esc(d.notes)}</textarea>${err('notes')}</div>
    ${addToday}
    ${J.errors._form ? `<p class="msg msg-neg wide">${esc(J.errors._form)}</p>` : ''}
    <div class="row-actions wide"><button type="button" class="btn btn-primary" data-act="save">Save</button><button type="button" class="btn btn-quiet" data-act="cancel">Cancel</button>
      <span class="spacer"></span>
      ${J.confirmDel
        ? `<span class="confirm-inline">Delete this entry? This can't be undone. <button type="button" class="btn btn-small btn-danger" data-act="delete-yes">Delete</button> <button type="button" class="btn btn-small btn-quiet" data-act="delete-no">Keep</button></span>`
        : '<button type="button" class="btn btn-small btn-danger-quiet" data-act="delete">Delete entry…</button>'}
    </div>
  </div>`;
}

function draftOf(e) {
  return {
    outcome: e.outcome || '',
    sign: isNum(e.pnl) && e.pnl !== 0 ? (e.pnl > 0 ? 'profit' : 'loss') : '',
    amt: isNum(e.pnl) ? String(Math.abs(e.pnl)) : '',
    notes: e.notes || '',
    addToday: false,
  };
}

function onInput(ev) {
  const t = ev.target;
  if (!J.draft || !t.dataset.j) return;
  if (t.dataset.j === 'addToday') J.draft.addToday = t.checked;
  else J.draft[t.dataset.j] = t.value;
}

async function onClick(ev) {
  if (!screen) return;
  const { ctx } = screen;
  const f = ev.target.closest('[data-filter]');
  if (f) { J.filter = f.dataset.filter; J.openId = null; J.draft = null; await paint(); return; }
  const o = ev.target.closest('[data-open]');
  if (o) {
    const id = o.dataset.open;
    if (J.openId === id) { J.openId = null; J.draft = null; }
    else {
      const e = screen.entries.find((x) => x.id === id);
      J.openId = id; J.draft = e ? draftOf(e) : null; J.errors = {}; J.confirmDel = false;
    }
    await paint();
    return;
  }
  const pick = ev.target.closest('[data-pick]');
  if (pick && J.draft) {
    J.draft[pick.dataset.pick] = pick.dataset.value;
    await paint();
    return;
  }
  const act = ev.target.closest('[data-act]');
  if (!act) return;
  const a = act.dataset.act;
  if (a === 'csv') exportCsv(ctx);
  else if (a === 'cancel') { J.openId = null; J.draft = null; J.errors = {}; await paint(); }
  else if (a === 'delete') { J.confirmDel = true; await paint(); }
  else if (a === 'delete-no') { J.confirmDel = false; await paint(); }
  else if (a === 'delete-yes') {
    await ctx.store.delete('journal', J.openId);
    J.openId = null; J.draft = null; J.confirmDel = false;
    ctx.toast('Entry deleted.');
    await paint();
  } else if (a === 'save') await saveResult(ctx);
}

async function saveResult(ctx) {
  const e = screen.entries.find((x) => x.id === J.openId);
  if (!e || !J.draft) return;
  const d = J.draft;
  const errors = {};
  let pnl = null;
  if (!ctx.calc) errors._form = "The calculator isn't loaded, so the amount can't be checked.";
  else if (d.amt.trim()) {
    let r;
    try { r = ctx.calc.readNum(d.amt, { money: true }); } catch { r = { ok: false, message: "This isn't a number." }; }
    if (!r.ok) errors.amt = r.message;
    else if (r.value < 0) errors.amt = 'Type the amount without a minus, then pick Profit or Loss.';
    else if (r.value === 0) pnl = 0;
    else if (!d.sign) errors.amt = 'Pick Profit or Loss.';
    else pnl = d.sign === 'loss' ? -r.value : r.value;
  }
  if (d.outcome === 'win' && isNum(pnl) && pnl < 0) errors.amt = 'A win with a loss? Check Profit or Loss.';
  if (d.outcome === 'loss' && isNum(pnl) && pnl > 0) errors.amt = 'A loss with a profit? Check Profit or Loss.';
  if (d.notes.length > 2000) errors.notes = 'Notes can be up to 2,000 characters.';
  let acct = null;
  if (d.addToday && !e.addedToToday) {
    acct = await ctx.store.get('accounts', e.accountId);
    if (!isNum(pnl)) errors.amt = errors.amt || 'Type the result to add it to today.';
    else if (!acct || acct.dayKey !== e.dayKey) errors._form = 'This trade is not from the account\'s current trading day any more, so it can\'t be added to today.';
    else if (!isNum(acct.todayResult)) errors._form = `Type today's result on ${acct.name} in Accounts first, then add this one.`;
  }
  J.errors = errors;
  if (Object.keys(errors).length) { await paint(); return; }
  const now = new Date().toISOString();
  const next = { ...e, outcome: d.outcome || null, pnl, notes: d.notes.trim(), resultAt: now };
  try {
    if (d.addToday && !e.addedToToday && acct) {
      // The account's new result for today and the entry's "added" mark are saved together: both or neither.
      // Saved one after the other, a failed second save would leave the result added and the entry unmarked,
      // and saving again would add the same result a second time.
      next.addedToToday = true;
      await ctx.store.putTogether({ accounts: [{ ...acct, todayResult: Math.round((acct.todayResult + pnl) * 100) / 100 }], journal: [next] });
    } else {
      await ctx.store.put('journal', next);
    }
  } catch (err) {
    console.error(err);
    J.errors = { _form: "Nothing was saved. Couldn't save on this device. Try again." };
    await paint();
    return;
  }
  ctx.toast(next.addedToToday && !e.addedToToday ? `Saved, and added to today's result on ${acct.name}. Update its balance and equity in Accounts too.` : 'Saved.');
  J.openId = null; J.draft = null; J.errors = {};
  await paint();
}

function exportCsv(ctx) {
  const list = J.filter === 'all' ? screen.entries : screen.entries.filter((e) => e.accountId === J.filter);
  if (!list.length) { ctx.toast('Nothing to export.'); return; }
  const rows = [[
    'Date (IST)', 'Time (IST)', 'Account', 'Firm', 'Plan', 'Stage', 'Symbol', 'Direction', 'Size', 'Unit',
    'Entry', 'Stop', 'Target', 'Loss at stop (USD)', 'Risk budget (USD)', 'Capped by', 'Outcome', 'Result (USD)', 'Notes', 'Result added (IST)',
  ]];
  for (const e of [...list].reverse()) {
    const d = isNum(e.digits) ? e.digits : undefined;
    const price = (x) => (isNum(x) ? fmtPrice(x, d) : '');
    rows.push([
      istDateISO(e.createdAt), istTime24(e.createdAt), e.accountName || '', e.firmName || '', e.planName || '', e.stageName || '',
      e.symbol || '', e.direction || '', isNum(e.size) ? e.size : '', e.unit || '',
      price(e.entry), price(e.stop), price(e.target), csvMoney(e.riskAtStop), csvMoney(e.budget), e.capped || '',
      outcomeLabel(e.outcome), csvMoney(e.pnl), e.notes || '', e.resultAt ? `${istDateISO(e.resultAt)} ${istTime24(e.resultAt)}` : '',
    ]);
  }
  const name = `risk-desk-journal-${istDateISO(new Date())}.csv`;
  downloadFile(name, '﻿' + toCSV(rows), 'text/csv;charset=utf-8');
  ctx.toast(`Saved ${name}.`);
}

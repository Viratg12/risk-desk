// Backup screen: export everything to one JSON file; import it back with a preview and a confirm step
// in the page; import or paste a personal plan; the app's safety settings (stricter only); storage.

import { esc, fmtMoney, fmtPct, fmtWhenIST, fmtDateTimeIST, istDateISO, downloadFile, plural, hhmm12, toDate } from '../ui.js';
import { exportAll, validateBackup, validatePersonalPlan, unknownPlanClasses, classNameHelp, STORES, STORE_LABELS, checkSafety, DEFAULT_SETTINGS } from '../store.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const MAX_FILE = 5 * 1024 * 1024;
const CLASS_WORDS = { fx: 'forex', metal: 'metals', energy: 'energies', index: 'indices', crypto: 'crypto' };
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const B = { backup: null, backupName: '', backupErrors: [], plan: null, planErrors: [], planWarnings: [], planText: '', removing: null, settings: null, settingsErrors: [], storageNote: '' };
let screen = null;

export async function render(root, ctx) {
  forgetFiles();
  screen = { root, ctx };
  B.settings = null;
  B.settingsErrors = [];
  await paint();
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  // Leaving the screen: a file that was refused or was waiting for "Replace everything" is forgotten, so
  // an old message or an old preview isn't there on the way back.
  return () => { screen = null; forgetFiles(); };
}

// What a chosen backup or plan file left on the screen: its error messages, the preview waiting for a
// confirm, and a "Remove this plan?" question. Text pasted in the plan box is kept: the trader typed it.
function forgetFiles() {
  B.backup = null; B.backupName = ''; B.backupErrors = [];
  B.plan = null; B.planErrors = []; B.planWarnings = [];
  B.removing = null;
}

// The settings rows of a backup about to be restored, with "last backup" set to the time the backup file
// itself was made: after the restore this device holds exactly that backup. The file's own row is older
// (it names the backup before this one) or missing (the first backup ever). A time that can't be read, or
// one in the future (a clock that was ahead), is not used: the file's own row stays as it is.
export function settingsWithBackupTime(settings, exportedAt, now = new Date()) {
  const rows = Array.isArray(settings) ? settings : [];
  const at = toDate(exportedAt);
  if (!at || at.getTime() > now.getTime()) return rows;
  return [...rows.filter((r) => !(r && r.key === 'lastExportAt')), { key: 'lastExportAt', value: at.toISOString() }];
}

// Plain-language lines for a personal plan (shown in the preview and the list). A class the loaded symbol
// lists use is shown in words ("index" → indices); a name they don't use is shown exactly as typed and
// flagged, so two plans that read the same here also work the same (classIds: the loaded class ids).
export function describePlan(p, classIds = null) {
  const lines = [];
  const known = classIds ? new Set(classIds) : null;
  const name = (c) => (known && known.size && !known.has(c) ? `"${c}" (not a class Risk Desk uses, so this rule never applies)` : CLASS_WORDS[c] || c);
  const words = (list) => (Array.isArray(list) ? list.map(name).join(', ') : '');
  if (p.risk) {
    const r = p.risk;
    lines.push(`Risk per trade: ${fmtPct(r.evalPctOfSize)} of the account size in the evaluation, ${fmtPct(r.fundedPctOfSize)} when funded. Never more than the room above the max-loss floor divided by ${r.roomDivisorEval} (evaluation) or ${r.roomDivisorFunded} (funded)${r.wholeDollars ? ', rounded down to whole dollars' : ''}.`);
  } else {
    lines.push("No risk numbers: this plan can't set the risk. On an account that sets its own risk (% or $), only the rules below are checked.");
  }
  if (p.halfSizeClasses && p.halfSizeClasses.length) lines.push(`Half size on ${words(p.halfSizeClasses)}.`);
  if (isNum(p.maxTradesPerDay)) lines.push(`At most ${plural(p.maxTradesPerDay, 'trade')} a day.`);
  if (isNum(p.noSecondTradeIfFirstLostMorePctOfSize)) lines.push(`No second trade if the first one lost more than ${fmtPct(p.noSecondTradeIfFirstLostMorePctOfSize)} of the account size.`);
  if (isNum(p.fundedStopForDayAtProfitPctOfSize)) lines.push(`Funded: stop for the day once up ${fmtPct(p.fundedStopForDayAtProfitPctOfSize)} of the account size.`);
  if (p.blockIfOneMoreFullLossReachesDailyLimit) lines.push('No new trade if one more full loss would reach the daily loss floor.');
  for (const w of p.noNewTradesIST || []) lines.push(`No new trades from ${hhmm12(w.from)} to ${hhmm12(w.to)} IST.`);
  for (const w of p.onlyBetweenIST || []) lines.push(`${words(w.classes).replace(/^./, (c) => c.toUpperCase())} only from ${hhmm12(w.from)} to ${hhmm12(w.to)} IST.`);
  for (const d of p.noTradeDays || []) lines.push(`No ${words(d.classes)} trades on ${DAY_NAMES[d.weekdayIST]}s (India date).`);
  if (p.requireStopAndTarget) lines.push('Every trade needs a stop and a target.');
  return lines;
}

async function paint() {
  if (!screen) return;
  const { root, ctx } = screen;
  const plans = await ctx.store.getAll('personalPlans');
  const accounts = await ctx.store.getAll('accounts');
  const last = await ctx.store.get('settings', 'lastExportAt');
  const lastAt = last && toDate(last.value);
  const days = lastAt ? Math.floor((Date.now() - lastAt.getTime()) / 86400000) : null;
  const lede = lastAt ? `Last backup ${fmtWhenIST(lastAt)}.${days >= 7 ? ' Make a new one: browsers can clear site data.' : ''}` : 'No backup yet. Everything is on this device only.';
  const s = B.settings || { marginCapPct: String(ctx.settings.marginCapPct), futuresSlippageTicks: String(ctx.settings.futuresSlippageTicks), floorCushionUSD: String(ctx.settings.floorCushionUSD) };
  B.settings = s;
  root.innerHTML = `<div class="title-row"><p class="lede">${esc(lede)}</p></div>
    <section class="card" aria-labelledby="bk-out"><h2 class="card-title" id="bk-out">Download a backup</h2>
      <p>Accounts, the journal, your symbol confirmations, personal plans and settings, in one file. Keep it somewhere private: it holds your balances.</p>
      <button type="button" class="btn btn-primary" data-act="export">Download backup</button>
    </section>

    <section class="card" aria-labelledby="bk-in"><h2 class="card-title" id="bk-in">Bring a backup back</h2>
      ${B.backup ? backupPreviewHtml() : `<p>Pick a Risk Desk backup file. You'll see what's in it before anything changes.</p>
        <label class="btn file-btn"><input type="file" accept=".json,application/json" data-file="backup" class="offscreen">Choose a backup file</label>`}
      ${B.backupErrors.length ? `<ul class="msgs">${B.backupErrors.slice(0, 8).map((m) => `<li class="msg msg-neg">${esc(m)}</li>`).join('')}${B.backupErrors.length > 8 ? `<li class="msg msg-neg">…and ${B.backupErrors.length - 8} more.</li>` : ''}</ul>` : ''}
    </section>

    <section class="card" aria-labelledby="bk-plan"><h2 class="card-title" id="bk-plan">Personal plans</h2>
      ${plans.length ? `<ul class="rows-plain">${plans.map((p) => planRowHtml(p, accounts, ctx.classIds)).join('')}</ul>` : '<p class="muted">None yet.</p>'}
      ${B.plan ? planPreviewHtml(plans, ctx.classIds) : `<p>Import your plan file, or paste its text. Plans hold percentages and times only. Class names must be the ones Risk Desk uses: ${esc((ctx.classIds || []).join(', ') || 'none loaded')}.</p>
        <label class="btn file-btn"><input type="file" accept=".json,application/json" data-file="plan" class="offscreen">Choose a plan file</label>
        <div class="field wide"><label for="plan-text">Or paste the plan</label><textarea id="plan-text" data-plan-text rows="5" spellcheck="false">${esc(B.planText)}</textarea></div>
        <button type="button" class="btn" data-act="plan-check">Check this plan</button>`}
      ${B.planErrors.length ? `<ul class="msgs">${B.planErrors.map((m) => `<li class="msg msg-neg">${esc(m)}</li>`).join('')}</ul>` : ''}
    </section>

    <section class="card" aria-labelledby="bk-safe"><h2 class="card-title" id="bk-safe">Safety settings</h2>
      <p class="hint">They can only be made stricter: margin cap at most ${DEFAULT_SETTINGS.marginCapPct}%, futures slippage at least ${plural(DEFAULT_SETTINGS.futuresSlippageTicks, 'tick')}, cushion at least ${fmtMoney(DEFAULT_SETTINGS.floorCushionUSD)}.</p>
      <div class="fields">
        <div class="field"><label for="s-margin">Margin cap (% of equity)</label><input id="s-margin" data-s="marginCapPct" type="text" inputmode="decimal" value="${esc(s.marginCapPct)}"></div>
        <div class="field"><label for="s-slip">Futures slippage on the stop (ticks)</label><input id="s-slip" data-s="futuresSlippageTicks" type="text" inputmode="numeric" value="${esc(s.futuresSlippageTicks)}"></div>
        <div class="field"><label for="s-cush">Cushion above every floor ($)</label><input id="s-cush" data-s="floorCushionUSD" type="text" inputmode="decimal" value="${esc(s.floorCushionUSD)}"></div>
      </div>
      ${B.settingsErrors.length ? `<ul class="msgs">${B.settingsErrors.map((m) => `<li class="msg msg-neg">${esc(m)}</li>`).join('')}</ul>` : ''}
      <button type="button" class="btn" data-act="settings-save">Save settings</button>
    </section>

    <section class="card" aria-labelledby="bk-store"><h2 class="card-title" id="bk-store">Storage</h2>
      <p>${ctx.store.persistent ? 'Saved in this browser on this device. Nothing is sent anywhere.' : "This browser isn't saving anything (private window or blocked storage). Everything goes when the page closes."}</p>
      ${ctx.store.persistent && navigator.storage && navigator.storage.persist ? '<button type="button" class="btn btn-small" data-act="persist">Ask the browser to keep this data</button>' : ''}
      ${B.storageNote ? `<p class="hint">${esc(B.storageNote)}</p>` : ''}
      <p class="hint">On iPhone, add Risk Desk to the Home Screen so Safari doesn't clear it after a week without use.</p>
    </section>`;
}

function backupPreviewHtml() {
  const v = B.backup;
  const names = (v.data.accounts || []).map((a) => a && a.name).filter(Boolean);
  return `<p>From <b>${esc(B.backupName)}</b>${v.exportedAt ? `, made ${esc(fmtDateTimeIST(v.exportedAt))}` : ''}${v.appVersion ? ` by Risk Desk ${esc(v.appVersion)}` : ''}.</p>
    <dl class="kv">${STORES.map((n) => `<div><dt>${esc(STORE_LABELS[n])}</dt><dd class="num">${v.counts[n]}</dd></div>`).join('')}</dl>
    ${names.length ? `<p class="hint">Accounts: ${esc(names.join(', '))}</p>` : ''}
    ${v.warnings.length ? `<ul class="msgs">${v.warnings.map((m) => `<li class="msg msg-warn">${esc(m)}</li>`).join('')}</ul>` : ''}
    <p class="msg msg-warn">Everything on this device is replaced by this backup. Download a backup first if you want to keep what is here now.</p>
    <div class="row-actions"><button type="button" class="btn btn-danger" data-act="import-yes">Replace everything with this backup</button><button type="button" class="btn btn-quiet" data-act="import-no">Cancel</button></div>`;
}

function planRowHtml(p, accounts, classIds) {
  const users = accounts.filter((a) => a.personalPlanId === p.id);
  const removing = B.removing === p.id;
  // A plan saved before class names were checked: say so here, the Trade screen blocks its accounts.
  const bad = unknownPlanClasses(p, classIds);
  const badHtml = bad.length ? `<p class="msg msg-neg">This plan names ${bad.length === 1 ? 'a class' : 'classes'} Risk Desk doesn't use (${esc(bad.map((b) => b.name).join(', '))}), so its accounts show NO TRADE. ${esc(classNameHelp(bad[0].name, classIds))} Fix the plan file and import it again.</p>` : '';
  return `<li class="rule">
    <div class="rule-l"><span class="rule-label">${esc(p.name || p.id)} <span class="muted">version ${esc(p.version ?? 1)}</span></span>
      <span class="rule-note">${users.length ? `Used by ${esc(users.map((a) => a.name).join(', '))}` : 'Not used by any account'}${p.importedAt ? ` · imported ${esc(fmtWhenIST(p.importedAt))}` : ''}</span>
      ${badHtml}
      <details class="mini-fold"><summary>Its rules</summary><ul class="plain-list">${describePlan(p, classIds).map((l) => `<li>${esc(l)}</li>`).join('')}</ul></details></div>
    <div class="rule-r">${removing
      ? (users.length ? `<span class="rule-note">Change ${esc(users.map((a) => a.name).join(', '))} to another risk method first.</span><button type="button" class="btn btn-small btn-quiet" data-act="plan-remove-no">OK</button>`
        : `<span class="rule-note">Remove this plan?</span><button type="button" class="btn btn-small btn-danger" data-act="plan-remove-yes" data-id="${esc(p.id)}">Remove</button><button type="button" class="btn btn-small btn-quiet" data-act="plan-remove-no">Keep</button>`)
      : `<button type="button" class="btn btn-small btn-danger-quiet" data-act="plan-remove" data-id="${esc(p.id)}">Remove…</button>`}</div>
  </li>`;
}

function planPreviewHtml(plans, classIds) {
  const p = B.plan;
  const existing = plans.find((x) => x.id === p.id);
  return `<div class="preview">
    <p><b>${esc(p.name)}</b> <span class="muted">version ${esc(p.version)}</span></p>
    <ul class="plain-list">${describePlan(p, classIds).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    ${B.planWarnings.length ? `<ul class="msgs">${B.planWarnings.map((m) => `<li class="msg msg-warn">${esc(m)}</li>`).join('')}</ul>` : ''}
    ${existing ? `<p class="msg msg-warn">This replaces the saved plan "${esc(existing.name)}" (version ${esc(existing.version ?? 1)}). Accounts using it get the new rules.</p>` : ''}
    <div class="row-actions"><button type="button" class="btn btn-primary" data-act="plan-save">${existing ? 'Replace the plan' : 'Save this plan'}</button><button type="button" class="btn btn-quiet" data-act="plan-cancel">Cancel</button></div>
  </div>`;
}

// ---------- Events ----------
function onInput(e) {
  const t = e.target;
  if (t.hasAttribute('data-plan-text')) B.planText = t.value;
  if (t.dataset.s && B.settings) B.settings[t.dataset.s] = t.value;
}

async function onChange(e) {
  const t = e.target;
  if (!t.dataset.file || !t.files || !t.files[0]) return;
  const file = t.files[0];
  t.value = '';
  if (file.size > MAX_FILE) { setFileError(t.dataset.file, 'This file is too big to be a Risk Desk file.'); return; }
  let json;
  try { json = JSON.parse(await file.text()); } catch { setFileError(t.dataset.file, "This file isn't readable JSON."); return; }
  if (t.dataset.file === 'backup') {
    const v = validateBackup(json, { classIds: screen ? screen.ctx.classIds : [] });
    if (!v.ok) { B.backup = null; B.backupErrors = v.errors; }
    else { B.backup = v; B.backupName = file.name; B.backupErrors = []; }
  } else checkPlan(json);
  await paint();
}

function setFileError(kind, msg) {
  if (kind === 'backup') { B.backup = null; B.backupErrors = [msg]; } else { B.plan = null; B.planErrors = [msg]; }
  paint();
}

function checkPlan(json) {
  const v = validatePersonalPlan(json, { classIds: screen ? screen.ctx.classIds : [] });
  B.plan = v.ok ? v.plan : null;
  B.planErrors = v.errors;
  B.planWarnings = v.warnings;
}

async function onClick(e) {
  if (!screen) return;
  const { ctx } = screen;
  const act = e.target.closest('[data-act]');
  if (!act) return;
  switch (act.dataset.act) {
    case 'export': {
      const now = new Date();
      const dump = await exportAll(ctx.store, now);
      const name = `risk-desk-backup-${istDateISO(now)}.json`;
      downloadFile(name, JSON.stringify(dump, null, 2), 'application/json');
      await ctx.store.put('settings', { key: 'lastExportAt', value: now.toISOString() });
      ctx.toast(`Saved ${name}.`);
      break;
    }
    case 'import-no': B.backup = null; B.backupErrors = []; break;
    case 'import-yes': {
      const v = B.backup;
      if (!v) break;
      try {
        await ctx.store.replaceAll({ ...v.data, settings: settingsWithBackupTime(v.data.settings, v.exportedAt) });
      } catch (err) {
        console.error(err);
        B.backupErrors = ["Couldn't write the backup on this device. Nothing was changed."];
        break;
      }
      // The accounts and the journal were replaced: the Trade screen drops what it remembered about them.
      if (!ctx.session) ctx.session = {};
      ctx.session.restores = (Number.isInteger(ctx.session.restores) ? ctx.session.restores : 0) + 1;
      const safety = (v.data.settings || []).find((s) => s && s.key === 'safety');
      const c = checkSafety({ ...DEFAULT_SETTINGS, ...(safety && safety.value ? safety.value : {}) });
      ctx.settings = c.ok ? c.values : { ...DEFAULT_SETTINGS };
      B.settings = null;
      B.backup = null;
      await ctx.rollDays();
      ctx.toast(`Backup restored: ${plural(v.counts.accounts, 'account')}, ${plural(v.counts.journal, 'journal entry', 'journal entries')}.`);
      break;
    }
    case 'plan-check': {
      const text = B.planText.trim();
      if (!text) { B.planErrors = ['Paste the plan first.']; break; }
      let json;
      try { json = JSON.parse(text); } catch { B.plan = null; B.planErrors = ["This text isn't valid JSON. Paste the whole plan, from { to }."]; break; }
      checkPlan(json);
      break;
    }
    case 'plan-cancel': B.plan = null; B.planErrors = []; B.planWarnings = []; break;
    case 'plan-save': {
      if (!B.plan) break;
      const rec = { ...B.plan, importedAt: new Date().toISOString() };
      await ctx.store.put('personalPlans', rec);
      ctx.toast(`Saved ${rec.name}. Attach it to an account in Accounts.`);
      B.plan = null; B.planText = ''; B.planErrors = []; B.planWarnings = [];
      break;
    }
    case 'plan-remove': B.removing = act.dataset.id; break;
    case 'plan-remove-no': B.removing = null; break;
    case 'plan-remove-yes': {
      const users = (await ctx.store.getAll('accounts')).filter((a) => a.personalPlanId === act.dataset.id);
      if (!users.length) { await ctx.store.delete('personalPlans', act.dataset.id); ctx.toast('Plan removed.'); }
      B.removing = null;
      break;
    }
    case 'settings-save': {
      const read = (text, money) => { try { return ctx.calc ? ctx.calc.readNum(text, { money }) : { ok: false, message: "The calculator isn't loaded." }; } catch { return { ok: false, message: "This isn't a number." }; } };
      const vals = {}, errs = [];
      for (const [k, money] of [['marginCapPct', false], ['futuresSlippageTicks', false], ['floorCushionUSD', true]]) {
        const r = read(B.settings[k], money);
        if (!r.ok || r.empty) errs.push(`${k === 'marginCapPct' ? 'Margin cap' : k === 'futuresSlippageTicks' ? 'Slippage' : 'Cushion'}: ${r.ok ? 'type a number' : r.message}`);
        else vals[k] = r.value;
      }
      if (!errs.length) {
        const c = checkSafety(vals);
        if (!c.ok) errs.push(...c.errors);
        else {
          await ctx.store.put('settings', { key: 'safety', value: c.values });
          ctx.settings = { ...c.values };
          B.settings = null;
          ctx.toast('Settings saved.');
        }
      }
      B.settingsErrors = errs;
      break;
    }
    case 'persist': {
      try {
        const ok = await navigator.storage.persist();
        B.storageNote = ok ? 'The browser will keep this data unless you clear it yourself.' : "The browser didn't promise to keep it. Download backups regularly.";
      } catch { B.storageNote = "The browser didn't answer. Download backups regularly."; }
      break;
    }
    default: return;
  }
  await paint();
}

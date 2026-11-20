/*
 * Risk Desk calculation engine. Contract: DESIGN.md section 5.
 *
 * Pure ES module: no DOM, no storage, no network, no Date.now(). The time is always passed in.
 * Exports (names fixed by DESIGN.md): readNum, floorToStep, firmDay, istParts, floors, evaluateTrade,
 * resolveInstrument, checkFill, conversionNeed, sizeSpecGaps, plus toThirtySeconds (a Treasury price in
 * points and 32nds, for the screens), productBanned (does the firm's product list for the plan allow this
 * futures contract?) and largestFit (the largest size on a step that fits a limit; exported so its bound
 * can be tested). The screens do no trading math of their own.
 * All money is in the account currency (USD).
 *
 * No loop in this file can run on: every loop walks a fixed list or an input list once, or counts to a
 * small constant (largestFit). There is no while loop and no recursion.
 *
 * Rules and specs come from the data files, never from this file. The only constants below are
 * conventions (which USD pair converts a currency, the app's default settings) and typo detectors
 * (wide sanity ranges, the Treasury 32nds check). None of them sets a size or a limit.
 *
 * ---------------------------------------------------------------------------------------------
 * What evaluateTrade(input) expects (DESIGN.md section 5, plus the details the design leaves open):
 *
 *   input.account       account (DESIGN 4.4). Number fields may be numbers or typed text. A money field
 *                       above 1,000,000,000,000 is "too large to be right" (ACCOUNT_INVALID).
 *                       updatedAt: when a balance field was last saved. lastLoggedAt: when a trade was
 *                       last logged (Log trade). Both ISO text, a Date or ms; a number counts only when
 *                       new Date(n) is a valid date (|n| ≤ 8.64e15), otherwise the time is unreadable.
 *                       planBySupport: the plan id the firm's support said an account bought on a plan's
 *                       rule-change day follows (only read when purchasedOn is that very day).
 *   input.firm          firm file (DESIGN 4.2): market ("cfd" | "futures"), clock, breach, ...
 *   input.plan          the plan from the firm file (already picked by purchase date).
 *   input.stage         the stage { id, name, funded }; if missing it is found by account.stageId.
 *   input.instrument    one symbol from resolveInstrument (its class and the trader's values merged in):
 *                         { symbol, name, class: "fx", base, quote, pip, digits, newsCurrencies,
 *                           contract, profitCurrency, volumeStep, volumeMin, volumeMax,  (value wrappers)
 *                           leverage, commission, priceSanity,                            (value wrappers)
 *                           tickSize, tickValue, quoteUnit, micro, capWeight }            (futures)
 *                       Any of these is read from the instrument first, then from instrument.classInfo
 *                       (the class entry of the instrument file), if set there.
 *   input.personalPlan  personal plan (DESIGN 4.3) or null.
 *   input.settings      { marginCapPct: 80, futuresSlippageTicks: 1, floorCushionUSD: 0.01 }.
 *   input.trade         typed text: { entry, stop, target, riskOverride, buffer, conversionPrice,
 *                         conversionConfirmed, decimalsConfirmed, feesRoundTrip, previousPrice }
 *                         entry, stop, target, conversionPrice   above 1,000,000,000 is "too large to be
 *                                        right" (INPUT_INVALID).
 *                         riskOverride   US dollars for this one trade (must stay within the max).
 *                         buffer         pips for forex, price units for other CFDs (CFD only).
 *                         conversionConfirmed  optional: the conversion price the trader confirmed with
 *                                        a button. When it reads as exactly the typed conversion price,
 *                                        CONVERSION_RANGE and CONVERSION_SUSPECT don't block; a
 *                                        CONVERSION_CONFIRMED notice says so instead.
 *                         decimalsConfirmed  optional, Treasury futures only: set by the "These are
 *                                        decimal prices" button to the typed entry, stop and target text,
 *                                        each trimmed and joined with "|" ("110.25|110.00|"). It counts
 *                                        only while it equals that same join of the prices typed now.
 *                                        Then a price that could also be a 32nds quote (110.25 for
 *                                        110'25) doesn't block (PRICE_AMBIGUOUS); a
 *                                        PRICE_DECIMALS_CONFIRMED notice says so instead.
 *                         feesRoundTrip  dollars per contract, round trip (futures only).
 *                         previousPrice  optional: the last price typed for this symbol in this
 *                                        session. An entry more than 50% away from it blocks
 *                                        (PRICE_JUMP). A previous price that can't be read is ignored.
 *   input.nowUTC        a Date.
 *
 * Reason codes (NO TRADE; the first one is the headline): CLOCK, NOT_ALLOWED, INPUT_MISSING,
 *   INPUT_INVALID, STOP_EQUALS_ENTRY, TARGET_WRONG_SIDE, TARGET_REQUIRED, PRICE_CHECK, PRICE_JUMP,
 *   SPEC_UNCONFIRMED, PRICE_OFF_GRID, PRICE_AMBIGUOUS, ACCOUNT_INVALID, PURCHASE_DATE_UNCLEAR,
 *   STALE_BALANCES, RULE_UNCONFIRMED, BREACHED, PLAN_INVALID, NO_ROOM, TRADE_COUNT, FIRST_TRADE_LOSS,
 *   PROFIT_STOP, DAILY_LIMIT_NEXT_LOSS, TIME_WINDOW, NO_TRADE_DAY, CLASS_WINDOW, NEWS_WINDOW,
 *   RISK_NOT_SET, RISK_MAX_NOT_SET, RISK_ABOVE_MAX, CONVERSION_MISSING, CONVERSION_RANGE,
 *   CONVERSION_SUSPECT, TOO_SMALL, ENGINE_ERROR.
 *   NOT_ALLOWED (a futures product the firm's list doesn't allow on the plan) is always the only reason.
 * Notice codes (never block): CAPPED, LOSS_LIMITS_NOT_SET, VOLUME_MAX_UNCONFIRMED, OFF_GRID,
 *   PRICE_32NDS, PRICE_DECIMALS_CONFIRMED, CHECK_PRICE, STOP_FAR, STOP_CLOSE, CONVERSION_CONFIRMED,
 *   RULE_CONFLICT, MIN_HOLD, CONSISTENCY, NEWS_REMINDER, STOP_AND_TARGET, FIRM_CAP_OPEN,
 *   MIX_NOT_ALLOWED, FEES, BUFFER_IGNORED, TRY_MICRO, PLAN_BY_SUPPORT.
 * ---------------------------------------------------------------------------------------------
 */

// ---------------------------------------------------------------- conventions and defaults ----

const IST_ZONE = "Asia/Kolkata";

// The app's own settings (DESIGN 5; decisions Q9 and Q10). Used when a setting is missing or unusable.
const DEFAULT_SETTINGS = Object.freeze({ marginCapPct: 80, futuresSlippageTicks: 1, floorCushionUSD: 0.01 });

// The USD pair that converts each profit currency (DESIGN 5.3). XXXUSD pairs multiply, USDXXX pairs divide.
const CONV_PAIR = { EUR: "EURUSD", GBP: "GBPUSD", AUD: "AUDUSD", NZD: "NZDUSD", JPY: "USDJPY", CHF: "USDCHF", CAD: "USDCAD" };

// Sanity ranges for a typed conversion price (from the old CFD Lot Sizer, narrowed for EURUSD and USDCHF
// so that 1 ÷ the right price falls outside). A price outside its range is most likely a typo or a rate
// typed the other way round, which sizes the trade 1.5 to 1.7 times too big: it blocks (CONVERSION_RANGE)
// until the trader confirms that exact price (trade.conversionConfirmed).
const CONV_RANGE = { EURUSD: [0.95, 1.6], GBPUSD: [1.0, 2.0], AUDUSD: [0.4, 1.1], NZDUSD: [0.4, 1.0], USDJPY: [70, 250], USDCHF: [0.6, 1.05], USDCAD: [0.9, 1.7] };

// A conversion price within this many percent of the trade's own entry is most likely the traded
// symbol's price typed in the conversion box: it blocks (CONVERSION_SUSPECT) until the trader confirms
// that exact price (near USD parity a right price can sit this close, e.g. EURCHF 0.90 and USDCHF 0.88).
const CONV_SUSPECT_PCT = 3;

// An update time more than this after "now" can't prove the balances were typed after the reset
// (the phone's clock was ahead): it blocks (STALE_BALANCES).
const FUTURE_SLACK_MS = 5 * 60 * 1000;

// The largest time a Date can hold (ms either side of 1970). A saved number beyond it is unreadable.
const MAX_TIME_MS = 8.64e15;

// CFD classes whose prices get the "more than 50% from your last price" check (DESIGN 5.3).
const JUMP_CHECK_CLASSES = new Set(["metal", "energy", "index", "crypto"]);

// Treasury futures whose screens quote points and 32nds (110'16 = 110 + 16/32 = 110.5). A price off their
// tick grid is most likely typed in 32nds (110.16), so it blocks instead of being rounded (DESIGN 5.5).
// A symbol whose quote unit mentions 1/32 counts too.
const TREASURY_32NDS = new Set(["ZN", "ZB", "ZF", "ZT"]);
const TREASURY_HINT = "Type Treasury prices as decimals with at least 4 decimal places: 110'16 = 110.5.";
// A Treasury price typed with at least 4 decimal places and within this of a tick-grid price is that price
// rounded (ZT 104'26.25 = 104.8203125 typed as 104.82031): it is read as the grid price. Every price typed
// in 32nds by mistake, X.01 to X.31 (X.25 is on the grid), is further off on ZT, ZF, ZN and ZB (the closest,
// ZT's X.09, is 0.00015625 away), and so are 32nds with a fraction typed as extra decimals (110.0825 for
// 110'08.25). The platform form with a third digit (110.082 for 110'08.25) can come within 0.0001 of the ZT
// and ZF grids, which is why a price needs 4 decimal places to be snapped: with 3 or fewer it still blocks.
const TREASURY_SNAP = 0.0001;
const TREASURY_SNAP_DECIMALS = 4;
// A 32nds quote can carry a third digit for the fraction of a 32nd, as CME writes it: 110-125 is 110 and
// 12.5 thirty-seconds, 104-293 is 104 and 29.375. The digits 4 and 9 are never used. A typed price whose
// decimals read as such a quote (110.25, 110.125, 104.2930) and that is also a tick-grid decimal can be read
// two ways, so it blocks (PRICE_AMBIGUOUS) until the trader confirms decimals (trade.decimalsConfirmed).
const THIRD_DIGIT_OF_32ND = { 0: 0, 1: 0.125, 2: 0.25, 3: 0.375, 5: 0.5, 6: 0.625, 7: 0.75, 8: 0.875 };

// Typo limits, not rules (review G2): no account holds more than a trillion dollars and no market trades
// above a billion. A number beyond these is a slip of the keyboard, and it blocks before any size is worked out.
const MAX_ACCOUNT_MONEY = 1e12;
const MAX_PRICE = 1e9;
const TOO_LARGE = "is too large to be right. Check the number.";

// largestFit lowers its first guess by at most this many steps (float noise needs one).
const FIT_STEPS = 4;

const CLASS_WORD = { fx: "forex", metal: "metal", energy: "energy", index: "index", crypto: "crypto" };
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const COMMISSION_TYPES = ["perLotPerSide", "perLotRoundTrip", "perContractRoundTrip", "perContractPerSide", "pctNotionalPerSide", "none"];

// The trader's own MT5 values that resolveInstrument merges in (CFD), and what each is called.
const CONFIRMABLE = ["contract", "profitCurrency", "volumeStep", "volumeMin", "volumeMax"];
const SPEC_LABEL = { contract: "Contract size", profitCurrency: "Profit currency", volumeStep: "Volume step", volumeMin: "Minimum volume", volumeMax: "Maximum volume" };
// The values a size depends on (DESIGN 5.1 step 3) that the trader can confirm.
const SIZE_SPECS = { cfd: ["contract", "profitCurrency", "volumeStep", "volumeMin"], futures: ["tickSize", "tickValue"] };
const STATUS_WORD = { confirmed: "confirmed on the firm's site", "your-mt5": "from your MT5", "your-trades": "matched your trades", conflict: "firm pages disagree", plain: "data file" };

// Float tolerance for money and size comparisons: far below a cent and far below any volume step.
const EPS = 1e-9;

// ------------------------------------------------------------------------- number reading ----

/**
 * Strict number reader (DESIGN rule 5). A typo is never half-read.
 * Blank → { ok: true, empty: true, value: null }. Bad text → { ok: false, value: null, message }.
 * Prices take no commas. Money fields ({ money: true }) take commas only as thousands separators
 * (25,000.50) and an optional "$". A leading "-" (or "−") is kept: the caller decides whether a
 * negative number is allowed.
 */
export function readNum(text, { money = false } = {}) {
  const good = (v) => ({ ok: true, empty: false, value: v === 0 ? 0 : v, message: "" });
  const bad = (message) => ({ ok: false, empty: false, value: null, message });
  const blank = { ok: true, empty: true, value: null, message: "This box is empty." };
  if (text === null || text === undefined) return blank;
  if (typeof text === "number") return Number.isFinite(text) ? good(text) : bad("This isn't a number.");
  if (typeof text !== "string") return bad("This isn't a number.");
  const raw = text.trim();
  if (raw === "") return blank;
  if (/[()]/.test(raw)) return bad("Use a minus sign for a loss, like -1200, not brackets.");
  if (/[eE]/.test(raw)) return bad("Type the number in full, like 1000, not 1e3.");
  if (raw.includes("+")) return bad("Remove the + sign.");
  let s = raw;
  let neg = false;
  if (s[0] === "-" || s[0] === "−") { neg = true; s = s.slice(1); }
  if (s[0] === "$") {
    if (!money) return bad("Type the price without a $ sign.");
    s = s.slice(1);
  }
  if (s === "") return bad("Type a number.");
  if (s.includes(",")) {
    if (!money) return bad("Prices can't have commas. Use a dot for decimals, like 1.08500.");
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return bad("Use commas only between thousands, like 25,000.50.");
    s = s.replace(/,/g, "");
  }
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) {
    if ((s.match(/\./g) || []).length > 1) return bad("This has more than one dot. Use one dot, like 92.58.");
    return bad("This isn't a number. Use digits and one dot, like 92.58.");
  }
  const v = Number(s);
  if (!Number.isFinite(v)) return bad("This number is too large.");
  return good(neg ? -v : v);
}

/** Digits after the decimal point in a volume step (0.01 → 2, 1 → 0, 1e-7 → 7). */
function stepDecimals(step) {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  const m = /^\d+(?:\.(\d+))?(?:e-(\d+))?$/.exec(String(step));
  if (!m) return 0;
  return Math.min(20, (m[1] ? m[1].length : 0) + (m[2] ? Number(m[2]) : 0));
}
const roundToStep = (x, step) => Number(x.toFixed(stepDecimals(step)));

/**
 * Largest multiple of `step` that is ≤ x. The ratio x / step is rounded to 9 decimals before flooring,
 * so float noise (1.21 / 0.01 = 120.99999999999999) never drops a step. Returns 0 for x ≤ 0.
 */
export function floorToStep(x, step) {
  if (typeof x !== "number" || !Number.isFinite(x) || !(x > 0)) return 0;
  if (typeof step !== "number" || !Number.isFinite(step) || !(step > 0)) return 0;
  const n = Math.floor(Number((x / step).toFixed(9)));
  return n > 0 ? roundToStep(n * step, step) : 0;
}

/** Whole dollars, rounded down, with the same 9-decimal float tolerance. */
const floorWhole = (x) => Math.floor(Number(x.toFixed(9)));

/**
 * Largest size on the step whose cost (size × perUnit) stays within `limit`. 0 when nothing fits.
 * Bounded (review G2): the first guess is limit ÷ perUnit rounded down to the step. Float noise can leave
 * that guess one step too big, so it is lowered at most FIT_STEPS times. If it still doesn't fit, or a step
 * no longer lowers it (a size so large that one step is lost in the rounding), the answer is 0: no size is
 * safer than a wrong one. Numbers that aren't finite and above 0 give 0 as well.
 */
export function largestFit(limit, perUnit, step) {
  for (const x of [limit, perUnit, step]) if (typeof x !== "number" || !Number.isFinite(x) || !(x > 0)) return 0;
  let n = floorToStep(limit / perUnit, step);
  for (let i = 0; i < FIT_STEPS && n > 0 && n * perUnit > limit + EPS; i++) {
    const lower = roundToStep(n - step, step);
    if (!(lower < n)) return 0;
    n = lower;
  }
  return n > 0 && n * perUnit <= limit + EPS ? n : 0;
}

// ------------------------------------------------------------------------------ time ----

const formatterCache = new Map();
function zoneFormatter(zone) {
  let f = formatterCache.get(zone);
  if (!f) {
    // Throws a RangeError for an unknown zone name.
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", weekday: "short", year: "numeric", month: "numeric",
      day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatterCache.set(zone, f);
  }
  return f;
}

/** Calendar parts of an instant in an IANA zone, read with Intl.DateTimeFormat (no fixed offsets). */
function zoneParts(ms, zone) {
  const o = {};
  for (const p of zoneFormatter(zone).formatToParts(new Date(ms))) o[p.type] = p.value;
  const r = {
    year: Number(o.year), month: Number(o.month), day: Number(o.day), hour: Number(o.hour) % 24,
    minute: Number(o.minute), second: Number(o.second), weekday: WEEKDAYS.indexOf(o.weekday),
  };
  for (const k of ["year", "month", "day", "hour", "minute", "second"]) if (!Number.isInteger(r[k])) throw new Error("Unreadable time");
  if (r.weekday < 0) throw new Error("Unreadable weekday");
  return r;
}

/** Offset of `zone` from UTC at an instant, in ms (local wall time − UTC). */
function zoneOffset(ms, zone) {
  const p = zoneParts(ms, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** UTC instant of a wall-clock time in `zone`. Day overflow (day 0, day 32) rolls over as in Date.UTC. */
function zonedToUtc(year, month, day, hour, minute, zone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const off1 = zoneOffset(guess, zone);
  let utc = guess - off1;
  const off2 = zoneOffset(utc, zone);
  if (off2 !== off1) utc = guess - off2; // the guess sat on the other side of a daylight-saving change
  return utc;
}

/** "now" as ms: a valid Date, or a number new Date(n) can hold (|n| ≤ 8.64e15). null otherwise. */
function toMs(t) {
  if (t instanceof Date) { const v = t.getTime(); return Number.isFinite(v) && Math.abs(v) <= MAX_TIME_MS ? v : null; }
  if (typeof t === "number" && Number.isFinite(t) && Math.abs(t) <= MAX_TIME_MS) return t;
  return null;
}

/** "22:15" → minutes after midnight (1335), or null. */
function parseHHMM(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}

const pad2 = (n) => String(n).padStart(2, "0");

/** Minutes after midnight → "2:05 PM". */
function clock12(minutes) {
  const h = Math.floor(minutes / 60) % 24, m = minutes % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${pad2(m)} ${h < 12 ? "AM" : "PM"}`;
}

/** An instant in India time, e.g. "Thu 19 Nov, 3:30 AM IST". */
function fmtIST(ms) {
  const p = zoneParts(ms, IST_ZONE);
  return `${WEEKDAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]}, ${clock12(p.hour * 60 + p.minute)} IST`;
}

/** "America/New_York" → "New York". */
const zoneWord = (zone) => (zone === "UTC" || zone === "Etc/UTC" ? "UTC" : String(zone).split("/").pop().replace(/_/g, " "));

/** India time: { weekday (0 Sunday … 6 Saturday), hh, mm, minutes, text }, or null if it can't be read. */
export function istParts(nowUTC) {
  try {
    const ms = toMs(nowUTC);
    if (ms === null) return null;
    const p = zoneParts(ms, IST_ZONE);
    return { weekday: p.weekday, hh: p.hour, mm: p.minute, minutes: p.hour * 60 + p.minute, text: fmtIST(ms) };
  } catch {
    return null;
  }
}

/**
 * The firm's trading day around `nowUTC`. `clock` is { zone, dayStartsAt: "HH:MM" } or its value wrapper.
 * The reset is computed in the firm's own zone, so US daylight saving moves it automatically.
 * Returns { dayKey, lastResetUTC, nextResetUTC, lastResetIST, nextResetIST }, or null if it can't be
 * worked out. At the reset instant itself the new day has started.
 * dayKey is the firm-zone date that the trading day mostly covers: a day that starts at 17:00 New York
 * on the 18th is "…-19", and so is a day that starts at 22:00 UTC on the 18th.
 */
export function firmDay(clock, nowUTC) {
  try {
    const c = isWrapper(clock) ? clock.value : clock;
    if (!c || typeof c !== "object" || typeof c.zone !== "string" || !c.zone) return null;
    const ms = toMs(nowUTC);
    const start = parseHHMM(c.dayStartsAt);
    if (ms === null || start === null) return null;
    const p = zoneParts(ms, c.zone);
    const h = Math.floor(start / 60), mi = start % 60;
    const resets = [-2, -1, 0, 1, 2].map((k) => zonedToUtc(p.year, p.month, p.day + k, h, mi, c.zone));
    const past = resets.filter((t) => t <= ms), future = resets.filter((t) => t > ms);
    if (!past.length || !future.length) return null;
    const last = Math.max(...past), next = Math.min(...future);
    const mid = zoneParts(last + (next - last) / 2, c.zone);
    return {
      dayKey: `${mid.year}-${pad2(mid.month)}-${pad2(mid.day)}`,
      lastResetUTC: new Date(last), nextResetUTC: new Date(next),
      lastResetIST: fmtIST(last), nextResetIST: fmtIST(next),
    };
  } catch {
    return null;
  }
}

/** Is `minutes` inside [from, to)? A window may cross midnight (23:00 → 05:00). */
function inWindow(minutes, from, to) {
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

// ------------------------------------------------------------------- value wrappers ----

function isWrapper(x) {
  return !!x && typeof x === "object" && !Array.isArray(x) && "value" in x &&
    ("status" in x || "source" in x || "checked" in x || "note" in x);
}

/**
 * { value, status, note } for a value wrapper. A plain value has status "plain". A field that is
 * absent has status "missing"; a field set to null ("no such rule") has status "none".
 * A wrapper without a status counts as unconfirmed.
 */
function unwrap(x) {
  if (x === undefined) return { value: null, status: "missing", note: "" };
  if (x === null) return { value: null, status: "none", note: "" };
  if (isWrapper(x)) return { value: x.value ?? null, status: x.status || "unconfirmed", note: x.note || "" };
  return { value: x, status: "plain", note: "" };
}

/**
 * The status says the value can be relied on (confirmed, your-mt5, your-trades, conflict, plain).
 * "sanity" marks a typo-check band (priceSanity): it is read on its own and never counts as a rule or spec.
 */
const statusOk = (w) => !["unconfirmed", "missing", "none", "sanity"].includes(w.status);
/** A value the size may depend on: present and relied on. */
const usable = (w) => w.value !== null && w.value !== undefined && statusOk(w);

// ---------------------------------------------------------------------- formatting ----

const NF2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NF0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
function usd(x) {
  if (!Number.isFinite(x)) return "–";
  const r = Math.round(x * 100) / 100;
  return (r < 0 ? "−$" : "$") + NF2.format(Math.abs(r));
}
/** $25,000 for whole dollars, $25,000.50 otherwise. */
function usdShort(x) {
  if (!Number.isFinite(x)) return "–";
  return Number.isInteger(x) ? (x < 0 ? "−$" : "$") + NF0.format(Math.abs(x)) : usd(x);
}
const pct = (p) => `${Number(Number(p).toFixed(6))}%`;
const fixed = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : "–");
function priceText(p, digits) {
  if (!Number.isFinite(p)) return "–";
  if (Number.isInteger(digits) && digits >= 0 && digits <= 12) return p.toFixed(digits);
  return String(Number(p.toPrecision(12)));
}
const contractsText = (n) => `${n} contract${n === 1 ? "" : "s"}`;
const NF6 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
/** A plain quantity such as a contract size: 100000 → "100,000", 0.5 → "0.5". */
const plainNum = (x) => (typeof x === "number" && Number.isFinite(x) ? NF6.format(x) : String(x));
/** A plain number without separators, as prices are shown: 1000 → "1000", 0.95 → "0.95". */
const bareNum = (x) => String(Number(Number(x).toPrecision(12)));
/** A conversion rate: 0.8 → "0.80", 1.25 → "1.25", 1.2531328 → "1.2531", 0.0066533 → "0.006653". */
function rateText(x) {
  if (!Number.isFinite(x)) return "–";
  if (x >= 0.1) return x.toFixed(4).replace(/(\.\d\d\d*?)0+$/, "$1");
  return String(Number(x.toPrecision(4)));
}
/** "2026-11-10" → "10 Nov 2026". */
function isoDateText(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(iso);
}
/**
 * An instant as ms: ISO text, a Date or ms. NaN when it can't be read, including a number outside what a
 * Date can hold (|n| > 8.64e15, e.g. 1e20): formatting such a time would throw, so it is unreadable.
 */
function timeMs(t) {
  let ms = NaN;
  if (typeof t === "string") ms = t.trim() ? Date.parse(t) : NaN;
  else if (t instanceof Date) ms = t.getTime();
  else if (typeof t === "number") ms = t;
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_TIME_MS ? ms : NaN;
}
/** India time of an instant: "9:15 PM IST" on today's India date, else "Wed 18 Nov, 9:15 PM IST". */
function istWhen(ms, nowMs) {
  const p = zoneParts(ms, IST_ZONE);
  if (Number.isFinite(nowMs)) {
    const n = zoneParts(nowMs, IST_ZONE);
    if (n.year === p.year && n.month === p.month && n.day === p.day) return `${clock12(p.hour * 60 + p.minute)} IST`;
  }
  return fmtIST(ms);
}
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);

// ------------------------------------------------------------------------ account ----

const ACCOUNT_LABELS = {
  size: "Account size", balance: "Balance", equity: "Equity", resetBalance: "Balance at the last reset",
  resetEquity: "Equity at the last reset", peakClosedBalance: "Highest closed balance",
  otherOpenRisk: "Risk on other open trades", marginUsed: "Margin in use", todayResult: "Today's result",
  tradesToday: "Trades taken today",
};

/**
 * Reads account numbers strictly. Returns { n, problems }: each n[key] is a number, null (blank) or
 * undefined (unreadable). Only the fields in `keys` are read, so a box this plan doesn't use can't block.
 * A money field above a trillion dollars (either way, for today's result) is a typo, not an account: it is
 * unreadable too, so nothing is ever worked out from it (review G2).
 */
function readAccount(account, keys) {
  const n = {}, problems = [];
  for (const key of keys) {
    const label = ACCOUNT_LABELS[key];
    const whole = key === "tradesToday";
    const r = readNum(account ? account[key] : undefined, { money: !whole });
    if (!r.ok) { problems.push({ key, message: `${label}: ${r.message}` }); n[key] = undefined; continue; }
    if (r.empty) { n[key] = null; continue; }
    if (key !== "todayResult" && r.value < 0) { problems.push({ key, message: `${label} can't be negative.` }); n[key] = undefined; continue; }
    if (!whole && Math.abs(r.value) > MAX_ACCOUNT_MONEY) { problems.push({ key, message: `${label} ${TOO_LARGE}` }); n[key] = undefined; continue; }
    if (whole && !Number.isInteger(r.value)) { problems.push({ key, message: `${label} must be a whole number, like 0, 1 or 2.` }); n[key] = undefined; continue; }
    n[key] = r.value;
  }
  return { n, problems };
}

/** The plan's family in words: plan.family, or its name up to "(" or "," ("Daily (1-Step), bought …" → "Daily"). */
function planFamilyWord(plan) {
  if (typeof plan.family === "string" && plan.family.trim()) return plan.family.trim();
  const word = String(plan.name || "").split(/[(,]/)[0].trim();
  return word || "plan's";
}

/** The plan's name as the firm file has it, or its id when it has none. */
const planNameOf = (plan) => (typeof plan.name === "string" && plan.name.trim() ? plan.name.trim() : String(plan.id ?? "this plan"));

// ------------------------------------------------------------------------- floors ----

/**
 * Floors from numbers already read (DESIGN 5.2).
 * n: { size, balance, equity, resetBalance, resetEquity, peakClosedBalance, otherOpenRisk, payoutRequested }
 * Returns { floors, binding, room, breached, notSetUp, unconfirmed, missing }.
 * A futures program whose loss rules are not set up (DESIGN 4.2, decision Q1) lands in notSetUp;
 * the same gap on a CFD plan lands in unconfirmed (it blocks).
 */
function floorsFromNumbers(n, plan, firm) {
  const out = { floors: [], binding: null, room: null, breached: false, notSetUp: [], unconfirmed: [], missing: [] };
  const futures = firm && firm.market === "futures";
  const size = n.size;
  if (!(size > 0)) return out; // the account size problem is reported by the caller

  const ruleOf = (rule, label) => {
    const w = unwrap(rule);
    if (w.status === "none") return null;                    // null in the file: the plan has no such rule
    if (w.value === null && statusOk(w)) return null;        // confirmed "none"
    if (!usable(w)) { (futures ? out.notSetUp : out.unconfirmed).push(label); return null; }
    return w;
  };

  // Max loss: static, or trailing on the highest closed balance.
  const ml = ruleOf(plan.maxLoss, "max loss");
  if (ml) {
    const v = ml.value, p = Number(v.pctOfSize);
    const f = { key: "max", name: "Max loss", level: null, allowance: (size * p) / 100, how: "", status: ml.status };
    if (!(p > 0) || (v.type !== "static" && v.type !== "trailing")) out.unconfirmed.push("max loss");
    else if (v.type === "static") {
      f.level = size - f.allowance;
      f.how = `${usdShort(size)} − ${pct(p)} of ${usdShort(size)} (${usd(f.allowance)}). Never moves.`;
      out.floors.push(f);
    } else {
      if (!Number.isFinite(n.peakClosedBalance) || !Number.isFinite(n.balance)) {
        out.missing.push("peakClosedBalance");
        f.how = "Enter the highest closed balance. The trailing floor needs it.";
      } else {
        const top = Math.max(n.peakClosedBalance, n.balance, size);
        let level = top - f.allowance;
        let how = `Highest closed balance ${usd(top)} − ${pct(p)} of ${usdShort(size)} (${usd(f.allowance)})`;
        if (n.peakClosedBalance < n.balance) how += ". The highest closed balance can't be below the balance, so the balance is used";
        if (v.capAtStart === true && level > size) { level = size; how += `, capped at the starting balance ${usdShort(size)}`; }
        if (v.lockOnPayoutRequest === true && n.payoutRequested === true) { level = size; how = `Locked at the starting balance ${usdShort(size)} by your payout request`; }
        f.level = level;
        f.how = `${how}.`;
      }
      out.floors.push(f);
    }
  }

  // Daily loss: from the closed balance at the reset, or the higher of balance and equity at the reset.
  const dl = ruleOf(plan.dailyLoss, "daily loss");
  if (dl && dl.value.from !== null && dl.value.from !== undefined) {
    const v = dl.value, p = Number(v.pctOfSize);
    const f = { key: "daily", name: "Daily loss", level: null, allowance: (size * p) / 100, how: "", status: dl.status };
    const rb = n.resetBalance, re = n.resetEquity;
    if (!(p > 0) || (v.from !== "closedBalanceAtReset" && v.from !== "higherOfBalanceEquityAtReset")) out.unconfirmed.push("daily loss");
    else if (v.from === "closedBalanceAtReset") {
      if (!Number.isFinite(rb)) { out.missing.push("resetBalance"); f.how = "Enter the balance at the last reset."; }
      else { f.level = rb - f.allowance; f.how = `Balance at the last reset ${usd(rb)} − ${pct(p)} of ${usdShort(size)} (${usd(f.allowance)}).`; }
      out.floors.push(f);
    } else {
      if (!Number.isFinite(rb) || !Number.isFinite(re)) { out.missing.push("resetBalance", "resetEquity"); f.how = "Enter the balance and the equity at the last reset."; }
      else {
        const hi = Math.max(rb, re);
        f.level = hi - f.allowance;
        f.how = `Higher of balance ${usd(rb)} and equity ${usd(re)} at the last reset (${usd(hi)}) − ${pct(p)} of ${usdShort(size)} (${usd(f.allowance)}).`;
      }
      out.floors.push(f);
    }
  }

  // Binding floor = the highest. On a tie the max-loss floor (listed first) wins.
  const known = out.floors.filter((f) => Number.isFinite(f.level));
  if (known.length) {
    const top = known.reduce((a, b) => (b.level > a.level ? b : a));
    if (Number.isFinite(n.equity) && n.equity <= top.level + EPS) out.breached = true;
    if (known.length === out.floors.length && !out.unconfirmed.length) {
      out.binding = top;
      if (Number.isFinite(n.equity)) out.room = n.equity - top.level - (Number.isFinite(n.otherOpenRisk) ? n.otherOpenRisk : 0);
    }
  }
  return out;
}

const publicFloor = (f) => (f ? { key: f.key, name: f.name, level: f.level, allowance: f.allowance, how: f.how, status: f.status } : null);

/**
 * Floors for an account (DESIGN 5.2):
 * { floors: [{ key, name, level, allowance, how, status }], binding, room, breached }
 * plus notSetUp (loss rules a futures program doesn't have set up), unconfirmed, and problems (messages).
 * room = equity − binding floor − risk on other open trades. Breached when equity ≤ a floor.
 * A level that can't be worked out (a missing reset value) is null, and then binding and room are null.
 */
export function floors(account, plan, firm) {
  const { n, problems } = readAccount(account || {}, ["size", "balance", "equity", "resetBalance", "resetEquity", "peakClosedBalance", "otherOpenRisk"]);
  if (n.equity === null) n.equity = n.balance;
  if (n.otherOpenRisk === null) n.otherOpenRisk = 0;
  n.payoutRequested = !!(account && account.payoutRequested === true);
  const f = floorsFromNumbers(n, plan || {}, firm || {});
  const messages = problems.map((p) => p.message);
  if (!(n.size > 0)) messages.push("Enter the account size.");
  if (f.missing.includes("peakClosedBalance")) messages.push("Enter the highest closed balance. The trailing max loss needs it.");
  if (f.missing.includes("resetBalance")) messages.push("Enter the reset values the daily loss floor needs.");
  for (const u of f.unconfirmed) messages.push(`The ${u} rule isn't confirmed for this plan.`);
  return {
    floors: f.floors.map(publicFloor), binding: publicFloor(f.binding), room: f.room, breached: f.breached,
    notSetUp: f.notSetUp, unconfirmed: f.unconfirmed, problems: messages,
  };
}

// --------------------------------------------------------------------- instrument ----

function classIdOf(inst) {
  if (typeof inst.class === "string") return inst.class;
  if (inst.class && typeof inst.class === "object" && typeof inst.class.id === "string") return inst.class.id;
  if (typeof inst.classId === "string") return inst.classId;
  return "";
}
/** A field from the symbol, or else from its class entry (merged as classInfo, classSpec or class). */
function classField(inst, key) {
  if (inst[key] !== undefined) return inst[key];
  for (const c of [inst.classInfo, inst.classSpec, typeof inst.class === "object" ? inst.class : null]) {
    if (c && typeof c === "object" && c[key] !== undefined) return c[key];
  }
  return undefined;
}
function classLabel(inst, cls) {
  const c = inst.classInfo || inst.classSpec || (typeof inst.class === "object" ? inst.class : null);
  if (c && typeof c.label === "string") return c.label;
  if (typeof inst.classLabel === "string") return inst.classLabel;
  return CLASS_WORD[cls] || cls || "this class";
}

/** Commission per lot or contract, round trip, in USD. */
function commissionPerUnit(c, contract, entry, qEntry, exit, qExit) {
  switch (c.type) {
    case "perLotPerSide":
    case "perContractPerSide": return 2 * c.amount;
    case "perLotRoundTrip":
    case "perContractRoundTrip": return c.amount;
    case "pctNotionalPerSide": return (c.amount / 100) * contract * (entry * qEntry + exit * qExit);
    default: return 0; // "none"
  }
}
function commissionHow(c) {
  switch (c.type) {
    case "perLotPerSide":
    case "perContractPerSide": return `${usd(c.amount)} a side × 2`;
    case "perLotRoundTrip": return `${usd(c.amount)} a lot, round trip`;
    case "perContractRoundTrip": return `${usd(c.amount)} a contract, round trip`;
    case "pctNotionalPerSide": return `${pct(c.amount)} of the entry value + ${pct(c.amount)} of the exit value`;
    default: return "No commission";
  }
}
/** A fixed fee per lot or contract, round trip (per side × 2), or null when it isn't a fixed fee. */
function roundTripFee(c) {
  if (!isObj(c) || typeof c.type !== "string") return null;
  if (c.type === "none") return 0;
  const a = Number(c.amount);
  if (!(a >= 0) || !Number.isFinite(a)) return null;
  if (c.type === "perContractRoundTrip" || c.type === "perLotRoundTrip") return a;
  if (c.type === "perContractPerSide" || c.type === "perLotPerSide") return 2 * a;
  return null;
}

/** A Treasury future quoted in points and 32nds (DESIGN 5.5). */
function isTreasury32nds(inst, symbol) {
  if (TREASURY_32NDS.has(symbol)) return true;
  const q = unwrap(classField(inst, "quoteUnit")).value;
  return typeof q === "string" && /(^|[^\d])1\/32([^\d]|$)|32nds/i.test(q);
}

/**
 * A price in points and 32nds, as Treasury platforms show it: 110.25 → "110'08", 110 → "110'00",
 * 110.5 → "110'16", 104.8203125 → "104'26.25" (a fraction of a 32nd after a dot). Takes a number or typed
 * text (read strictly, as a price). "" when it can't be read or is below 0. Pure: for the screens too.
 */
export function toThirtySeconds(price) {
  const r = typeof price === "number" ? { ok: Number.isFinite(price), value: price } : readNum(price);
  if (!r.ok || r.value === null || !(r.value >= 0)) return "";
  const units = Math.round(r.value * 32000); // thousandths of a 32nd, so 1/8 of a 32nd is exact
  if (!Number.isSafeInteger(units)) return "";
  const points = Math.floor(units / 32000), rest = units - points * 32000;
  const whole = Math.floor(rest / 1000), frac = rest % 1000;
  return `${points}'${pad2(whole)}${frac ? `.${String(frac).padStart(3, "0").replace(/0+$/, "")}` : ""}`;
}

/** A typed value as text: trimmed text, a number as JavaScript writes it, "" for anything else. */
const typedText = (raw) => (typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "");

/** Decimal places in a typed price ("104.82031" → 5, "110" → 0); a number is counted as JavaScript writes it. */
function typedPlaces(raw) {
  const m = /^\d*\.(\d+)$/.exec(typedText(raw));
  return m ? m[1].length : 0;
}

/**
 * The digits of a typed price read as a 32nds quote (review G3), or null when they aren't one. The decimals
 * must be YY, or YYZ, followed only by zeros: YY the 32nds, 00 to 31, and Z the fraction of a 32nd as CME
 * writes it (THIRD_DIGIT_OF_32ND). "110.25" → 110'25 = 110.78125; "110.125" → 110-125 = 110'12.5 =
 * 110.390625; "104.2930" → 104-293 = 104'29.375 = 104.91796875; "110.5", "110.75", "104.82031" → null.
 * Returns { value, quote } with quote the digits as a platform writes them ("110'25", "104'293").
 */
function readAsThirtySeconds(raw) {
  const m = /^(\d*)\.(\d\d)(\d?)0*$/.exec(typedText(raw));
  if (!m) return null;
  const whole = Number(m[1] || 0), yy = Number(m[2]);
  const part = THIRD_DIGIT_OF_32ND[m[3] || "0"];
  if (yy > 31 || part === undefined || !Number.isSafeInteger(whole)) return null;
  return { value: whole + (yy + part) / 32, quote: `${whole}'${m[2]}${part ? m[3] : ""}` };
}

/** A price that is a whole number of 1/256 points, written in full: 104.91796875, 110.78125, 110. */
const exactDecimals = (x) => x.toFixed(8).replace(/\.?0+$/, "");

/** Base and quote currency of a forex symbol: from the data, or from a six-letter name (EURGBP). */
function fxSides(inst) {
  const symbol = String(inst.symbol || "");
  const six = /^[A-Z]{6}$/.test(symbol) && classIdOf(inst) === "fx";
  return { base: inst.base || (six ? symbol.slice(0, 3) : undefined), quote: inst.quote || (six ? symbol.slice(3) : undefined) };
}

/**
 * A forex symbol (base and quote known) whose profit currency isn't its quote currency: a EUR/GBP trade
 * makes its profit in GBP. Returns { quote, given } or null.
 */
function fxProfitMismatch(inst) {
  if (classIdOf(inst) !== "fx") return null;
  const { base, quote } = fxSides(inst);
  if (!base || !quote) return null;
  const pc = unwrap(classField(inst, "profitCurrency"));
  if (!usable(pc)) return null;
  const given = String(pc.value).trim().toUpperCase();
  return given === quote ? null : { quote, given };
}

/**
 * Do the plan's contract limits let a micro trade on this account size (DESIGN 5.5)? No limits on the
 * plan → yes. Limits unknown, no row for the size, a product limit of 0 or no micro allowance → no.
 */
function microAllowed(plan, size, micro) {
  const ccW = unwrap(plan.contractCaps);
  if (ccW.status === "none" || (ccW.value === null && statusOk(ccW))) return true;
  if (!usable(ccW) || !isObj(ccW.value)) return false;
  const row = isObj(ccW.value.bySize) ? ccW.value.bySize[String(size)] : null;
  if (!isObj(row)) return false;
  const caps = isObj(ccW.value.productCaps) && isObj(ccW.value.productCaps[micro]) ? ccW.value.productCaps[micro] : null;
  const pcap = caps ? caps[String(size)] : undefined;
  if (pcap !== undefined && !(Math.floor(Number(pcap)) >= 1)) return false; // null counts as 0, as in the cap itself
  const micros = Number(row.micros), minis = Number(row.minis);
  const capacity = Number.isFinite(micros) ? micros : Number.isFinite(minis) ? minis * 10 : 0;
  return capacity >= 1;
}

/** The account size as the plan's tables key it ("50000"), read strictly; null when it can't be read. */
function sizeKey(accountSize) {
  const r = readNum(accountSize, { money: true });
  return r.ok && !r.empty ? String(r.value) : null;
}

/**
 * Does the firm's product list keep this futures contract off the plan (decision Q17)? True when the plan's
 * contract limits can be relied on, they list the symbol under productCaps, and its limit for this account
 * size is a number of 0 or less. When the symbol's row has no entry for the size (or the size can't be read),
 * true only if every size the row lists is 0 or less. False for anything else, and for anything that can't
 * be read: evaluateTrade then goes on and blocks an unreadable limit where it sizes the trade.
 * accountSize may be a number or typed text ("50,000"). Pure: for the screens too.
 */
export function productBanned(plan, accountSize, symbol) {
  try {
    if (!isObj(plan) || typeof symbol !== "string" || !symbol) return false;
    const ccW = unwrap(plan.contractCaps);
    if (!usable(ccW) || !isObj(ccW.value)) return false;
    const lists = ccW.value.productCaps;
    if (!isObj(lists) || !Object.hasOwn(lists, symbol)) return false;
    const row = lists[symbol];
    if (!isObj(row)) return false;
    const zeroOrLess = (v) => typeof v === "number" && v <= 0; // NaN is not ≤ 0
    const key = sizeKey(accountSize);
    if (key !== null && Object.hasOwn(row, key)) return zeroOrLess(row[key]);
    const listed = Object.values(row);
    return listed.length > 0 && listed.every(zeroOrLess);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------- result ----

function blankResult(unit) {
  return {
    status: "NO_TRADE", size: 0, unit, sizeText: "", direction: null,
    reasons: [], notices: [], working: [],
    risk: { method: null, budget: null, perUnit: null, atStop: 0, commission: 0, priceMove: 0 },
    limits: { floors: [], binding: null, roomNow: null, roomAfterStop: null, dailyRoom: null, maxRoom: null },
    margin: { perUnit: null, needed: 0, capPct: null, available: null },
    reward: null,
    capped: null,
  };
}

/** GO only with no reasons and a size above 0. NO TRADE always has size 0. */
function finalize(R, step) {
  if (R.reasons.length === 0 && !(R.size > 0)) {
    R.reasons.push({ code: "ENGINE_ERROR", message: "No size could be worked out from these inputs. Check them and try again." });
  }
  if (R.reasons.length) {
    R.status = "NO_TRADE";
    R.size = 0;
    R.capped = null;
    R.notices = R.notices.filter((n) => n.code !== "CAPPED"); // a cut size is only news when it's GO
    R.risk.atStop = 0; R.risk.commission = 0; R.risk.priceMove = 0;
    R.margin.needed = 0;
    if (R.reward) R.reward.total = 0;
    if (R.limits.roomNow !== null) R.limits.roomAfterStop = R.limits.roomNow;
  } else {
    R.status = "GO";
  }
  R.sizeText = R.unit === "contracts" ? contractsText(R.size) : `${R.size.toFixed(stepDecimals(step || 0.01))} lots`;
  return R;
}

// ------------------------------------------------------------------- evaluateTrade ----

/**
 * Everything the Trade screen needs for one trade (DESIGN 5.1): the size, GO or NO TRADE with every
 * reason, the room left and the working. Never throws: an unexpected error gives NO TRADE.
 */
export function evaluateTrade(input) {
  let unit = "lots";
  try {
    const i = input && typeof input === "object" ? input : {};
    unit = i.firm && i.firm.market === "futures" ? "contracts" : "lots";
    return evaluate(i);
  } catch (err) {
    const R = blankResult(unit);
    R.reasons.push({ code: "ENGINE_ERROR", message: "The calculation hit an unexpected problem, so no size is given. Check the inputs and try again." });
    R.working.push({ label: "Error", detail: "The calculation stopped here", value: String((err && err.message) || err) });
    return finalize(R, 0.01);
  }
}

function evaluate(input) {
  const account = input.account || {};
  const firm = input.firm || {};
  const plan = input.plan || {};
  const pp = input.personalPlan || null;
  const trade = input.trade || {};
  const inst = input.instrument || {};
  const futures = firm.market === "futures";
  const R = blankResult(futures ? "contracts" : "lots");
  const symbol = String(inst.symbol || inst.name || "this symbol");
  const cls = classIdOf(inst);
  const sixLetters = /^[A-Z]{6}$/.test(symbol);
  const base = inst.base || (cls === "fx" && sixLetters ? symbol.slice(0, 3) : undefined);
  const quote = inst.quote || (cls === "fx" && sixLetters ? symbol.slice(3) : undefined);
  let stepForText = futures ? 1 : 0.01;

  const block = (code, message) => R.reasons.push({ code, message });
  const notice = (code, message) => { if (!R.notices.some((x) => x.code === code && x.message === message)) R.notices.push({ code, message }); };
  const step = (label, detail, value) => R.working.push({ label, detail, value });
  const has = (...codes) => R.reasons.some((r) => codes.includes(r.code));

  // Settings (DESIGN 5). The cushion keeps a loss strictly above the floor (touching it is a breach),
  // so it is never below 1 cent.
  const S = input.settings || {};
  const appMarginCap = Number.isFinite(S.marginCapPct) && S.marginCapPct > 0 && S.marginCapPct <= 100 ? S.marginCapPct : DEFAULT_SETTINGS.marginCapPct;
  const slipTicks = Number.isFinite(S.futuresSlippageTicks) && S.futuresSlippageTicks >= 0 ? S.futuresSlippageTicks : DEFAULT_SETTINGS.futuresSlippageTicks;
  const cushion = Number.isFinite(S.floorCushionUSD) && S.floorCushionUSD >= DEFAULT_SETTINGS.floorCushionUSD ? S.floorCushionUSD : DEFAULT_SETTINGS.floorCushionUSD;

  // ---- 1. Clock (fail closed) ----
  const ist = istParts(input.nowUTC);
  const clockW = unwrap(firm.clock);
  const fday = usable(clockW) ? firmDay(clockW.value, input.nowUTC) : null;
  if (!ist) block("CLOCK", "Can't read the time in India (IST), so the time rules can't be checked. No size until the clock works.");
  else if (!usable(clockW)) block("CLOCK", "The firm's daily reset time isn't set up, so today's trading day can't be worked out.");
  else if (!fday) block("CLOCK", "Can't work out the firm's trading day from its reset time. Check the firm's clock setting.");
  if (ist) step("Time now", "India time", ist.text);
  if (fday) {
    const zw = zoneWord(clockW.value.zone);
    step("Firm trading day", `Resets at ${clockW.value.dayStartsAt} ${zw === "UTC" ? "UTC" : `${zw} time`}`, `Started ${fday.lastResetIST}. Next reset ${fday.nextResetIST}.`);
  }

  // ---- Firm product list (decision Q17, review G1) ----
  // A futures product the firm doesn't allow on the plan (a product limit of 0) is decided here, before any
  // price, fee or account check: the answer is the same whatever is typed, blank or out of date, and it is
  // the only reason given, so the trader never thinks that fixing something else would help.
  if (futures && productBanned(plan, account.size, symbol)) {
    const named = typeof firm.name === "string" && firm.name.trim() ? firm.name.trim() : "";
    const sizeRead = readNum(account.size, { money: true });
    const planSize = sizeRead.ok && !sizeRead.empty && sizeRead.value > 0 ? sizeRead.value : null;
    const lists = unwrap(plan.contractCaps).value.productCaps[symbol];
    const forSize = planSize !== null && Object.hasOwn(lists, String(planSize));
    R.reasons = [{ code: "NOT_ALLOWED", message: `${named || "The firm"} doesn't allow ${symbol} on this plan (or limits it without publishing a number), so the size is 0. The firm's note is on the Rules screen.` }];
    // Its micro is suggested only when this plan's limits let the micro trade (never a micro that is banned too).
    const micro = unwrap(inst.micro).value;
    if (typeof micro === "string" && micro && planSize !== null && microAllowed(plan, planSize, micro)) {
      notice("TRY_MICRO", `Try ${micro}, the micro contract: ${named || "the firm"} allows it on this plan.`);
    }
    step("Firm product list", forSize ? `${symbol} limit 0 on the ${usdShort(planSize)} plan` : `${symbol} limit 0 at every account size on this plan`, "0 contracts");
    return finalize(R, 1);
  }

  // ---- 2. Trade inputs ----
  const treasury = futures && isTreasury32nds(inst, symbol);
  const readField = (raw, label, { required = false, money = false, positive = false, nonNegative = false, price = false, max = null } = {}) => {
    const r = readNum(raw, { money });
    if (!r.ok && price && treasury && typeof raw === "string" && raw.includes("'")) { block("INPUT_INVALID", `${label}: ${TREASURY_HINT}`); return undefined; }
    if (!r.ok) { block("INPUT_INVALID", `${label}: ${r.message}`); return undefined; }
    if (r.empty) { if (required) block("INPUT_MISSING", `Enter the ${label.toLowerCase()}.`); return null; }
    if (positive && !(r.value > 0)) { block("INPUT_INVALID", `${label} must be more than 0.`); return undefined; }
    if (nonNegative && r.value < 0) { block("INPUT_INVALID", `${label} can't be negative.`); return undefined; }
    // No market trades above a billion: a price beyond it is a typo, and nothing is worked out from it (review G2).
    if (max !== null && r.value > max) { block("INPUT_INVALID", `${label} ${TOO_LARGE}`); return undefined; }
    return r.value;
  };
  let entry = readField(trade.entry, "Entry price", { required: true, positive: true, price: true, max: MAX_PRICE });
  let stop = readField(trade.stop, "Stop price", { required: true, positive: true, price: true, max: MAX_PRICE });
  let target = readField(trade.target, "Target price", { positive: true, price: true, max: MAX_PRICE });
  const override = readField(trade.riskOverride, "Risk for this trade", { money: true, positive: true });
  const bufferIn = readField(trade.buffer, "Buffer", { nonNegative: true });
  const convPrice = readField(trade.conversionPrice, "Conversion price", { positive: true, max: MAX_PRICE });
  const feesIn = readField(trade.feesRoundTrip, "Fees", { money: true, nonNegative: true });
  const prevRead = readNum(trade.previousPrice); // optional: an unreadable previous price is ignored
  const prevPrice = prevRead.ok && prevRead.value > 0 ? prevRead.value : null;

  // Prices are shown with the symbol's digits, or else with as many decimals as the trader typed.
  const typedDecimals = (t) => (typeof t === "string" && /^\s*\d*\.(\d+)\s*$/.test(t) ? t.trim().split(".")[1].length : 0);
  const digits = Number.isInteger(inst.digits) ? inst.digits : Math.min(10, Math.max(typedDecimals(trade.entry), typedDecimals(trade.stop)));
  const pText = (p) => priceText(p, digits);
  /** A price as the trader typed it ("104.82031"), or as the app shows it when it came in as a number. */
  const asTyped = (raw, p) => (typeof raw === "string" && raw.trim() ? raw.trim() : pText(p));
  const pip = Number(inst.pip);

  // Treasuries quoted in 32nds (DESIGN 5.5, review E3): a price typed with at least 4 decimal places and
  // within 0.0001 of the tick grid is a grid price rounded (ZT 104.82031 for 104'26.25 = 104.8203125). It is
  // read as that grid price before anything else is worked out. Further off, or with fewer decimal places,
  // it stays as typed and blocks at step 3 (PRICE_OFF_GRID): it was most likely typed in 32nds.
  if (treasury) {
    const tsW = unwrap(classField(inst, "tickSize"));
    const ts = Number(tsW.value);
    if (usable(tsW) && ts > 0 && Number.isFinite(ts)) {
      const snapped = [];
      const snap = (p, raw, word) => {
        if (!Number.isFinite(p)) return p;
        const g = Math.round(p / ts) * ts;
        if (g === p || !(g > 0) || Math.abs(p - g) > TREASURY_SNAP + 1e-12 || typedPlaces(raw) < TREASURY_SNAP_DECIMALS) return p;
        snapped.push(`${word} ${asTyped(raw, p)} → ${bareNum(g)}`);
        return g;
      };
      entry = snap(entry, trade.entry, "entry");
      stop = snap(stop, trade.stop, "stop");
      target = snap(target, trade.target, "target");
      if (snapped.length) {
        step("Tick grid", `${symbol} prices typed to ${TREASURY_SNAP_DECIMALS} or more decimal places and within ${TREASURY_SNAP} of the ${bareNum(ts)} tick grid are read as the grid price`, snapped.join(", "));
      }
    }
  }
  let dir = null;
  const pricesOk = Number.isFinite(entry) && Number.isFinite(stop);
  const dist = pricesOk ? Math.abs(entry - stop) : NaN;
  if (pricesOk) {
    if (stop === entry) {
      block("STOP_EQUALS_ENTRY", "The stop is the same as the entry. Move the stop away from the entry.");
    } else {
      dir = stop < entry ? "buy" : "sell";
      R.direction = dir;
      step("Direction", `Stop ${pText(stop)} is ${dir === "buy" ? "below" : "above"} entry ${pText(entry)}`, dir === "buy" ? "Buy" : "Sell");
      const pips = !futures && cls === "fx" && pip > 0 ? ` (${(dist / pip).toFixed(1)} pips)` : "";
      step("Stop distance", `|${pText(entry)} − ${pText(stop)}|`, `${priceText(dist, digits)}${pips}`);
      if (Number.isFinite(target)) {
        if (dir === "buy" && target <= entry) block("TARGET_WRONG_SIDE", "This is a buy (stop below entry), so the target must be above the entry.");
        if (dir === "sell" && target >= entry) block("TARGET_WRONG_SIDE", "This is a sell (stop above entry), so the target must be below the entry.");
      }
    }
  }
  if (pp && pp.requireStopAndTarget === true && target === null) block("TARGET_REQUIRED", "Your plan puts a target in with every trade. Enter the target.");

  // Slipped decimal points (DESIGN 5.3, W15): the symbol's usual price range from the data (status
  // "sanity", a typo check only; no range in the data → no check), and an entry more than 50% away from
  // the last price typed for the symbol this session. Both block.
  const band = unwrap(classField(inst, "priceSanity"));
  if (band.value !== null && band.value !== undefined) {
    const b = band.value, lo = Number(isObj(b) ? b.min : NaN), hi = Number(isObj(b) ? b.max : NaN);
    if (!(lo > 0) || !(hi > lo) || !Number.isFinite(hi)) {
      block("SPEC_UNCONFIRMED", `The usual price range for ${symbol} isn't set up in a way the app can use, so a slipped decimal point can't be caught.`);
    } else {
      const out = [["entry", entry], ["stop", stop]].filter(([, p]) => Number.isFinite(p) && (p < lo || p > hi)).map(([w, p]) => `${w} ${pText(p)}`);
      if (out.length) {
        block("PRICE_CHECK", `The ${out.join(" and the ")} ${out.length > 1 ? "are" : "is"} outside the usual range for ${symbol} (${bareNum(lo)} to ${bareNum(hi)}). Check for a slipped decimal point. If the price is right, the app's range for ${symbol} needs updating.`);
      }
    }
  }
  if (Number.isFinite(entry) && prevPrice !== null && (futures || JUMP_CHECK_CLASSES.has(cls)) && Math.abs(entry - prevPrice) / prevPrice > 0.5) {
    block("PRICE_JUMP", `The entry ${pText(entry)} is more than 50% away from the last price you typed for ${symbol} (${pText(prevPrice)}). Check this price and the earlier one for a slipped decimal point.`);
  }

  // ---- 3. Spec: every value the size depends on must be confirmed ----
  const spec = {};
  const needSpec = (key, label, where) => {
    const w = unwrap(classField(inst, key));
    if (!usable(w)) { block("SPEC_UNCONFIRMED", `${label} for ${symbol} isn't confirmed. ${where}`); return null; }
    if (w.status === "conflict") notice("RULE_CONFLICT", `${label}: the firm's pages disagree. The stricter reading is used.${w.note ? " " + w.note : ""}`);
    return w.value;
  };
  const positiveSpec = (key, label, where) => {
    if (spec[key] === null) return;
    const v = Number(spec[key]);
    if (v > 0 && Number.isFinite(v)) spec[key] = v;
    else { block("SPEC_UNCONFIRMED", `${label} for ${symbol} isn't a usable number. ${where}`); spec[key] = null; }
  };
  const FROM_MT5 = "Copy it from the MT5 Specification window.";
  const EXCHANGE = "Check the exchange's contract page.";
  let fees = null, publishedFee = null;
  if (!futures) {
    spec.contract = needSpec("contract", "Contract size", FROM_MT5);
    spec.profitCurrency = needSpec("profitCurrency", "Profit currency", FROM_MT5);
    spec.volumeStep = needSpec("volumeStep", "Volume step", FROM_MT5);
    spec.volumeMin = needSpec("volumeMin", "Minimum volume", FROM_MT5);
    spec.leverage = needSpec("leverage", `Leverage (${classLabel(inst, cls)})`, "Check it on the firm's site or in MT5.");
    spec.commission = needSpec("commission", `Commission (${classLabel(inst, cls)})`, "Check the firm's commission page or your MT5 history.");
    positiveSpec("contract", "Contract size", FROM_MT5);
    positiveSpec("volumeStep", "Volume step", FROM_MT5);
    positiveSpec("volumeMin", "Minimum volume", FROM_MT5);
    positiveSpec("leverage", "Leverage", "Check it on the firm's site or in MT5.");
    if (spec.profitCurrency !== null && !/^[A-Z]{3}$/.test(String(spec.profitCurrency))) { block("SPEC_UNCONFIRMED", `Profit currency for ${symbol} isn't a currency code. ${FROM_MT5}`); spec.profitCurrency = null; }
    // A forex pair makes its profit in its quote currency (EUR/GBP in GBP). Any other profit currency is
    // a slip in the confirm sheet, and it would size the trade wrongly.
    const ccyMismatch = spec.profitCurrency !== null ? fxProfitMismatch(inst) : null;
    if (ccyMismatch) {
      block("SPEC_UNCONFIRMED", `Profit currency for ${symbol} isn't confirmed: it says ${ccyMismatch.given}, but ${symbol} is quoted in ${ccyMismatch.quote}, so its profit is in ${ccyMismatch.quote}. ${FROM_MT5}`);
      spec.profitCurrency = null;
    }
    if (spec.commission !== null) {
      const c = spec.commission;
      if (!c || !COMMISSION_TYPES.includes(c.type) || (c.type !== "none" && !(Number(c.amount) >= 0))) {
        block("SPEC_UNCONFIRMED", `Commission for ${symbol} isn't set up in a way the app can use.`);
        spec.commission = null;
      } else spec.commission = { type: c.type, amount: c.type === "none" ? 0 : Number(c.amount) };
    }
    if (cls === "fx" && Number.isFinite(bufferIn) && bufferIn > 0 && !(pip > 0)) block("SPEC_UNCONFIRMED", `Pip size for ${symbol} isn't set up, so a buffer in pips can't be used.`);
    if (spec.volumeStep) stepForText = spec.volumeStep;
    const vmax = unwrap(classField(inst, "volumeMax"));
    spec.volumeMax = usable(vmax) && Number(vmax.value) > 0 ? Number(vmax.value) : null;
    if (spec.volumeMax === null) notice("VOLUME_MAX_UNCONFIRMED", `Maximum volume for ${symbol} isn't confirmed. Check that MT5 accepts the size.`);
  } else {
    spec.tickSize = needSpec("tickSize", "Tick size", EXCHANGE);
    spec.tickValue = needSpec("tickValue", "Tick value", EXCHANGE);
    positiveSpec("tickSize", "Tick size", EXCHANGE);
    positiveSpec("tickValue", "Tick value", EXCHANGE);
    // Treasuries quoted in 32nds: a price still off the tick grid (after step 2 read a rounded decimal as its
    // grid price) was most likely typed in 32nds (110.16 for 110'16), so it blocks instead of being rounded.
    if (treasury && spec.tickSize) {
      const ts = spec.tickSize;
      const offGrid = (p) => Math.abs(p / ts - Math.round(p / ts)) >= 1e-6;
      const typed = [["entry", entry, trade.entry], ["stop", stop, trade.stop], ["target", target, trade.target]].filter(([, p]) => Number.isFinite(p));
      const off = typed.filter(([, p]) => offGrid(p)).map(([w, p]) => `${w} ${pText(p)}`);
      if (off.length) {
        block("PRICE_OFF_GRID", `${TREASURY_HINT} The ${off.join(" and the ")} ${off.length > 1 ? "aren't" : "isn't"} on ${symbol}'s tick grid (${bareNum(ts)}), so ${off.length > 1 ? "they look" : "it looks"} typed in 32nds.`);
      }
      // A price on the tick grid (as typed, or after step 2 read it as its grid price) whose digits are also a
      // 32nds quote can be read two ways (review G3): ZN 110.25 is the decimal 110.25 (110'08) or 110'25
      // (110.78125); ZT 104.2930 is the decimal 104.29296875 (104'09.375) or 104-293 (104'29.375 =
      // 104.91796875). The two are far apart, so it is never sized on a guess: it blocks until the trader
      // confirms decimals for exactly the prices typed now (trade.decimalsConfirmed).
      const twoWays = [];
      for (const [word, p, raw] of typed) {
        const quote = offGrid(p) ? null : readAsThirtySeconds(raw);
        if (!quote || Math.abs(quote.value - p) < 1e-9) continue; // X.00 reads the same both ways
        const shown = typedText(raw);
        if (twoWays.some((a) => a.shown === shown)) continue;
        const as32 = toThirtySeconds(quote.value);
        twoWays.push({ word, shown, decimalAs32: toThirtySeconds(p), as32, written: quote.quote === as32 ? "" : quote.quote, value: exactDecimals(quote.value) });
      }
      if (twoWays.length) {
        const confirmedKey = [trade.entry, trade.stop, trade.target].map(typedText).join("|");
        if (typeof trade.decimalsConfirmed === "string" && trade.decimalsConfirmed === confirmedKey) {
          notice("PRICE_DECIMALS_CONFIRMED", `You confirmed these are decimal prices: ${twoWays.map((a) => `${a.word} ${a.shown}`).join(", ")}.`);
        } else {
          const many = twoWays.length > 1;
          const readings = twoWays.map((a) => `${symbol} ${a.shown} can be read two ways: the decimal price ${a.shown} (${a.decimalAs32}), or ${a.as32} from a 32nds quote (${a.value} in decimals).`).join(" ");
          const shows = twoWays.map((a) => `${a.as32}${a.written ? ` (also written ${a.written})` : ""}`).join(" and ");
          block("PRICE_AMBIGUOUS", `${readings} If you mean the decimal price${many ? "s" : ""}, confirm ${many ? "them" : "it"}. If your platform shows ${shows}, type ${twoWays.map((a) => a.value).join(" and ")}.`);
        }
      }
    }
    // Every Treasury trade shows its prices back in 32nds (review E3): 110.25 is 110'08, so a trader who
    // meant 110'25 sees the slip. For the first price typed with exactly 2 decimals from 01 to 31, the notice
    // also gives the decimal to type if those digits were 32nds (110'25 = 110 + 25/32 = 110.78125).
    if (treasury) {
      const shown = [["entry", entry, trade.entry], ["stop", stop, trade.stop], ["target", target, trade.target]].filter(([, p]) => Number.isFinite(p));
      if (shown.length) {
        let hint = "";
        for (const [, , raw] of shown) {
          const m = /^(\d+)\.(\d\d)$/.exec(typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "");
          if (m && Number(m[2]) >= 1 && Number(m[2]) <= 31) {
            hint = ` If your platform shows ${Number(m[1])}'${m[2]}, type ${bareNum(Number(m[1]) + Number(m[2]) / 32)}.`;
            break;
          }
        }
        notice("PRICE_32NDS", `${symbol} prices in 32nds: ${shown.map(([w, p, raw]) => `${w} ${asTyped(raw, p)} = ${toThirtySeconds(p)}`).join(", ")}.${hint}`);
      }
    }
    // Fees: the firm's published round-trip fee (the plan's fee table, merged in by resolveInstrument), or
    // the typed fee if higher (never lower).
    const cw = unwrap(classField(inst, "commission"));
    let feeUnreadable = false;
    if (usable(cw)) {
      const rt = roundTripFee(cw.value);
      if (rt === null) {
        feeUnreadable = true;
        block("SPEC_UNCONFIRMED", `The firm's published fees for ${symbol} aren't set up in a way the app can use. Check the firm's fee page.`);
      } else {
        publishedFee = rt;
        if (cw.status === "conflict") notice("RULE_CONFLICT", `Fees for ${symbol}: the firm's pages disagree. The stricter reading is used.${cw.note ? " " + cw.note : ""}`);
      }
    }
    if (publishedFee !== null && Number.isFinite(feesIn)) {
      fees = Math.max(publishedFee, feesIn);
      if (feesIn < publishedFee) notice("FEES", `Fees typed (${usd(feesIn)}) are below the firm's published ${usd(publishedFee)} a contract, so ${usd(publishedFee)} is used.`);
    } else if (publishedFee !== null) fees = publishedFee;
    else if (Number.isFinite(feesIn)) fees = feesIn;
    else if (feesIn !== undefined && !feeUnreadable) block("SPEC_UNCONFIRMED", `Fees for ${symbol} aren't confirmed. Type your round-trip fee per contract.`);
  }

  // ---- 4. Account data ----
  const mlW = unwrap(plan.maxLoss), dlW = unwrap(plan.dailyLoss);
  const trailing = usable(mlW) && mlW.value.type === "trailing";
  const dailyFrom = usable(dlW) && dlW.value ? dlW.value.from : null;
  const stage = input.stage || (Array.isArray(plan.stages) ? plan.stages.find((s) => s && s.id === account.stageId) : null) || null;
  const funded = !!(stage && stage.funded === true);
  const keys = ["size", "balance", "equity", "otherOpenRisk", "marginUsed"];
  if (trailing) keys.push("peakClosedBalance");
  if (dailyFrom === "closedBalanceAtReset" || dailyFrom === "higherOfBalanceEquityAtReset") keys.push("resetBalance");
  if (dailyFrom === "higherOfBalanceEquityAtReset") keys.push("resetEquity");
  // A plan number that is absent or null switches its rule off; anything else must be a number ≥ 0.
  const planNum = (v) => (v === undefined || v === null ? null : typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : NaN);
  const maxT = pp ? planNum(pp.maxTradesPerDay) : null;
  const firstLoss = pp ? planNum(pp.noSecondTradeIfFirstLostMorePctOfSize) : null;
  const profitStop = pp ? planNum(pp.fundedStopForDayAtProfitPctOfSize) : null;
  const ppUsesCount = maxT !== null || firstLoss !== null;
  const ppUsesResult = firstLoss !== null || (funded && profitStop !== null);
  if (ppUsesCount) keys.push("tradesToday");
  if (ppUsesResult) keys.push("todayResult");
  const { n, problems } = readAccount(account, keys);
  for (const p of problems) block("ACCOUNT_INVALID", p.message);
  if (n.size === null) block("ACCOUNT_INVALID", "Enter the account size.");
  else if (n.size === 0) { block("ACCOUNT_INVALID", "Account size must be more than 0."); n.size = undefined; }
  if (n.balance === null) block("ACCOUNT_INVALID", "Enter the balance.");
  if (n.equity === null) n.equity = n.balance; // DESIGN 4.4: blank equity → equal to balance
  if (n.otherOpenRisk === null) n.otherOpenRisk = 0;
  if (n.marginUsed === null) n.marginUsed = 0;
  if (ppUsesCount && n.tradesToday === null) block("ACCOUNT_INVALID", "Enter the trades taken today (0 if none).");
  if (ppUsesResult && n.todayResult === null) block("ACCOUNT_INVALID", "Enter today's result so far (0 if none).");
  n.payoutRequested = account.payoutRequested === true;

  const sizes = unwrap(plan.sizes);
  if (Number.isFinite(n.size) && Array.isArray(sizes.value) && sizes.value.length && !sizes.value.includes(n.size)) {
    block("ACCOUNT_INVALID", `This plan is sold in ${sizes.value.map(usdShort).join(", ")} sizes. Check the account size.`);
  }
  if (Array.isArray(plan.stages) && plan.stages.length && !stage) block("ACCOUNT_INVALID", "Pick the account's stage (for example Phase 1 or Funded).");
  // Plans whose rules depend on the purchase date (Tradeify FX Daily). The firm gives the day the rules
  // changed but not the time or the time zone, so a purchase on that very day can't be placed: it blocks,
  // unless the trader recorded which plan the firm's support said the account follows (account.planBySupport,
  // review E5). That answer is only read for a purchase on the boundary day itself.
  const bought = unwrap(plan.purchased).value;
  if (isObj(bought) && (bought.before || bought.onOrAfter)) {
    const d = typeof account.purchasedOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(account.purchasedOn) ? account.purchasedOn : null;
    const said = typeof account.planBySupport === "string" && account.planBySupport.trim() ? account.planBySupport.trim() : null;
    if (!d) block("ACCOUNT_INVALID", "Enter the date this account was bought. This plan's rules depend on it.");
    else if (d === bought.before || d === bought.onOrAfter) {
      if (said === null) {
        block("PURCHASE_DATE_UNCLEAR", `${firm.name || "The firm"} didn't say what time on ${isoDateText(d)} the ${planFamilyWord(plan)} rules changed. Ask their support which rules your account follows.`);
      } else if (said === plan.id) {
        notice("PLAN_BY_SUPPORT", `Bought on ${isoDateText(d)}: you recorded that support said this account follows ${planNameOf(plan)}.`);
      } else {
        const named = Array.isArray(firm.plans) ? firm.plans.find((p) => isObj(p) && p.id === said) : null;
        block("ACCOUNT_INVALID", `You recorded that support said ${named ? planNameOf(named) : said}. Pick that plan.`);
      }
    }
    else if (bought.before && !(d < bought.before)) block("ACCOUNT_INVALID", `This plan is for accounts bought before ${bought.before}, but this one was bought on ${d}. Pick the other plan.`);
    else if (bought.onOrAfter && !(d >= bought.onOrAfter)) block("ACCOUNT_INVALID", `This plan is for accounts bought on or after ${bought.onOrAfter}, but this one was bought on ${d}. Pick the other plan.`);
  }

  // Stale balances: edited before the firm's last reset, saved "in the future" (the phone's clock was
  // ahead), older than the last logged trade, "today" fields from another day, reset values missing.
  const nowMs = toMs(input.nowUTC);
  const upd = timeMs(account.updatedAt);
  if (fday) {
    if (!Number.isFinite(upd)) block("STALE_BALANCES", `Update balance, equity and reset values: no update time is saved. Today's reset was at ${fday.lastResetIST}.`);
    else if (nowMs !== null && upd > nowMs + FUTURE_SLACK_MS) {
      block("STALE_BALANCES", `The saved time is in the future: check the phone's clock. Numbers saved for ${fmtIST(upd)} can't show they were typed after today's reset at ${fday.lastResetIST}. Then update balance, equity and reset values.`);
    }
    else if (upd < fday.lastResetUTC.getTime()) block("STALE_BALANCES", `Update balance, equity and reset values: last updated ${fmtIST(upd)}, before today's reset at ${fday.lastResetIST}.`);
    if (typeof account.dayKey === "string" && account.dayKey && account.dayKey !== fday.dayKey) {
      block("STALE_BALANCES", `Today's result and trade count are from an earlier trading day. Update them for the day that started ${fday.lastResetIST}.`);
    }
  }
  const loggedRaw = account.lastLoggedAt;
  if (loggedRaw !== undefined && loggedRaw !== null && loggedRaw !== "") {
    const logged = timeMs(loggedRaw);
    if (!Number.isFinite(logged)) block("STALE_BALANCES", "The time of your last logged trade can't be read. Update balance, equity and other open trades first.");
    else if (Number.isFinite(upd) && logged > upd) {
      if (nowMs !== null && logged > nowMs + FUTURE_SLACK_MS) {
        block("STALE_BALANCES", `Your last logged trade has a time in the future (${fmtIST(logged)}): check the phone's clock. Then update balance, equity and other open trades.`);
      } else {
        block("STALE_BALANCES", `You logged a trade at ${istWhen(logged, nowMs)}. Update balance, equity and other open trades first.`);
      }
    }
  }
  const resetMissing = (dailyFrom === "closedBalanceAtReset" && n.resetBalance === null) ||
    (dailyFrom === "higherOfBalanceEquityAtReset" && (n.resetBalance === null || n.resetEquity === null));
  if (resetMissing) {
    const what = dailyFrom === "higherOfBalanceEquityAtReset" ? "the balance and the equity" : "the balance";
    block("STALE_BALANCES", `Enter ${what} at the last reset${fday ? ` (${fday.lastResetIST})` : ""}. The daily loss floor is measured from it.`);
  }

  // ---- 5. Floors ----
  const F = floorsFromNumbers(n, plan, firm);
  R.limits.floors = F.floors.map(publicFloor);
  if (F.notSetUp.length) {
    // A plan with no contract limits either (the personal "No firm" account) is sized from the risk setting alone.
    const ccNone = unwrap(plan.contractCaps);
    notice("LOSS_LIMITS_NOT_SET", ccNone.status === "none" || (ccNone.value === null && statusOk(ccNone))
      ? "Loss limits aren't set up for this account, so they aren't checked. The size comes from your risk setting only."
      : "Loss limits aren't set up for this program, so they aren't checked. The size is checked against the firm's contract limits only.");
  }
  for (const u of F.unconfirmed) block("RULE_UNCONFIRMED", `The ${u} rule for this plan isn't confirmed, so no size can be given. Check the firm's rules page.`);
  if (F.missing.includes("peakClosedBalance")) block("ACCOUNT_INVALID", "Enter the highest closed balance. The trailing max loss needs it.");
  for (const f of F.floors) {
    if (f.status === "conflict") notice("RULE_CONFLICT", `${f.name}: the firm's pages disagree. The stricter reading is used.`);
    step(`${f.name} floor`, f.how, Number.isFinite(f.level) ? usd(f.level) : "–");
  }
  const maxFloor = F.floors.find((f) => f.key === "max" && Number.isFinite(f.level)) || null;
  const dailyFloor = F.floors.find((f) => f.key === "daily" && Number.isFinite(f.level)) || null;
  const other = Number.isFinite(n.otherOpenRisk) ? n.otherOpenRisk : 0;
  if (F.binding) {
    R.limits.binding = publicFloor(F.binding);
    R.limits.roomNow = F.room;
    if (maxFloor && Number.isFinite(n.equity)) R.limits.maxRoom = n.equity - maxFloor.level - other;
    if (dailyFloor && Number.isFinite(n.equity)) R.limits.dailyRoom = n.equity - dailyFloor.level - other;
    if (F.floors.length > 1) step("Binding floor", "The higher floor applies", `${F.binding.name} ${usd(F.binding.level)}`);
    if (F.room !== null) step("Room now", `Equity ${usd(n.equity)} − floor ${usd(F.binding.level)} − other open trades ${usd(other)}`, usd(F.room));
  }
  if (F.breached) {
    const top = F.floors.filter((f) => Number.isFinite(f.level)).reduce((a, b) => (b.level > a.level ? b : a));
    block("BREACHED", `Equity ${usd(n.equity)} is at or below the ${top.name.toLowerCase()} floor ${usd(top.level)}. No new trades.`);
  }

  // ---- Personal plan risk (DESIGN 5.4), worked out before the plan's blocks need it ----
  // A plan with no risk numbers at all (no "risk" entry) can't set or cap the risk. On an account that sets
  // its own risk (% or $) it only adds its other rules (review R8); as the account's risk method it blocks.
  let planRisk = null;
  const planWithoutRisk = !!pp && (pp.risk === undefined || pp.risk === null);
  const riskFromPlan = isObj(account.riskMethod) && account.riskMethod.type === "personalPlan";
  if (planWithoutRisk && !riskFromPlan) {
    step("Plan risk", "Your plan has no risk numbers, so the account's own risk setting is used. The plan's other rules still apply.", "–");
  } else if (pp) {
    const r = pp.risk || {};
    const pctOf = Number(funded ? r.fundedPctOfSize : r.evalPctOfSize);
    const div = Number(funded ? r.roomDivisorFunded : r.roomDivisorEval);
    if (!(pctOf > 0) || !(div > 0)) {
      block("PLAN_INVALID", "Your plan's risk numbers for this stage are missing. Check the plan in Backup.");
    } else if (!maxFloor) {
      if (!has("RULE_UNCONFIRMED", "ACCOUNT_INVALID")) block("PLAN_INVALID", "Your plan needs the firm's max-loss floor, which isn't set up for this account.");
    } else if (Number.isFinite(n.balance)) {
      const room = n.balance - maxFloor.level;
      const capPct = (n.size * pctOf) / 100;
      const capRoom = room / div;
      const whole = r.wholeDollars === true;
      let baseRisk = Math.min(capPct, capRoom);
      if (whole) baseRisk = floorWhole(baseRisk);
      baseRisk = Math.max(0, baseRisk);
      const half = Array.isArray(pp.halfSizeClasses) && pp.halfSizeClasses.includes(cls);
      const risk = half ? (whole ? floorWhole(baseRisk / 2) : baseRisk / 2) : baseRisk;
      planRisk = { room, risk };
      step("Plan room", `Balance ${usd(n.balance)} − max-loss floor ${usd(maxFloor.level)}`, usd(room));
      step("Plan risk", `Lower of ${pct(pctOf)} of ${usdShort(n.size)} (${usd(capPct)}) and room ÷ ${div} (${usd(capRoom)})${whole ? ", rounded down to whole dollars" : ""}`, usd(baseRisk));
      if (half) step(`Half size for ${CLASS_WORD[cls] || cls}`, `${usd(baseRisk)} ÷ 2${whole ? ", rounded down" : ""}`, usd(risk));
    }
  }

  // ---- Risk budget (step 8), worked out early because step 6 needs it; its reasons are added at step 8 ----
  const budgetReasons = [];
  const rm = account.riskMethod || {};
  const maxRead = readNum(rm.maxPctOfSize, { money: true });
  const maxPct = maxRead.ok && !maxRead.empty && maxRead.value > 0 ? maxRead.value : null;
  const maxUSD = maxPct !== null && Number.isFinite(n.size) ? (n.size * maxPct) / 100 : null;
  let budget = null, budgetHow = "";
  R.risk.method = rm.type || null;
  if (maxPct === null) budgetReasons.push(["RISK_MAX_NOT_SET", "Set a maximum risk per trade for this account first (Accounts, risk method)."]);
  if (rm.type === "personalPlan") {
    if (!pp) budgetReasons.push(["RISK_NOT_SET", "This account sizes risk with a personal plan, but none is attached. Import or attach it in Backup."]);
    else if (planRisk) { budget = planRisk.risk; budgetHow = "From your plan"; }
  } else if (rm.type === "pctOfSize" || rm.type === "pctOfBalance" || rm.type === "usd") {
    const v = readNum(rm.value, { money: true });
    if (!v.ok || v.empty || !(v.value > 0)) budgetReasons.push(["RISK_NOT_SET", "Enter the risk per trade for this account (Accounts, risk method)."]);
    else if (rm.type === "usd") { budget = v.value; budgetHow = "Fixed dollar risk"; }
    else if (rm.type === "pctOfSize" && Number.isFinite(n.size)) { budget = (n.size * v.value) / 100; budgetHow = `${pct(v.value)} of account size ${usdShort(n.size)}`; }
    else if (rm.type === "pctOfBalance" && Number.isFinite(n.balance)) { budget = (n.balance * v.value) / 100; budgetHow = `${pct(v.value)} of balance ${usd(n.balance)}`; }
  } else {
    budgetReasons.push(["RISK_NOT_SET", "Choose how this account sizes risk (Accounts, risk method)."]);
  }
  // A personal plan attached to the account also caps the risk when another method is chosen.
  const planCap = planRisk ? planRisk.risk : null;
  if (Number.isFinite(override)) {
    if (maxUSD !== null && override > maxUSD + EPS) budgetReasons.push(["RISK_ABOVE_MAX", `The risk you typed (${usd(override)}) is above this account's max of ${usd(maxUSD)} (${pct(maxPct)} of ${usdShort(n.size)}).`]);
    else if (planCap !== null && override > planCap + EPS) budgetReasons.push(["RISK_ABOVE_MAX", `The risk you typed (${usd(override)}) is above your plan's ${usd(planCap)} for this trade.`]);
    budget = override;
    budgetHow = "Typed for this trade";
  } else if (budget !== null) {
    if (maxUSD !== null && budget > maxUSD + EPS) budgetReasons.push(["RISK_ABOVE_MAX", `Risk ${usd(budget)} is above this account's max of ${usd(maxUSD)} (${pct(maxPct)} of ${usdShort(n.size)}). Lower the risk.`]);
    else if (planCap !== null && rm.type !== "personalPlan" && budget > planCap + EPS) budgetReasons.push(["RISK_ABOVE_MAX", `Risk ${usd(budget)} is above your plan's ${usd(planCap)} for this trade.`]);
  }
  R.risk.budget = budget;
  R.risk.max = maxUSD;
  R.risk.override = Number.isFinite(override) ? override : null;

  // ---- 6. Personal plan blocks, in the old Nano order ----
  if (pp) {
    if (planRisk && planRisk.room <= 0) block("NO_ROOM", `The balance ${usd(n.balance)} is at or below the max-loss floor ${usd(maxFloor.level)}. Your plan allows no new trade.`);
    if (Number.isNaN(maxT) || (maxT !== null && !Number.isInteger(maxT))) block("PLAN_INVALID", "Your plan's trades-per-day limit isn't a whole number. Check the plan in Backup.");
    else if (maxT !== null && Number.isFinite(n.tradesToday) && n.tradesToday >= maxT) {
      block("TRADE_COUNT", `You've taken ${n.tradesToday} trade${n.tradesToday === 1 ? "" : "s"} today. Your plan allows ${maxT}. Done for the day.`);
    }
    if (Number.isNaN(firstLoss)) block("PLAN_INVALID", "Your plan's first-trade loss limit isn't a number. Check the plan in Backup.");
    else if (firstLoss !== null && Number.isFinite(n.size) && n.tradesToday === 1 && Number.isFinite(n.todayResult)) {
      const lim = (n.size * firstLoss) / 100;
      if (n.todayResult < -lim) block("FIRST_TRADE_LOSS", `The first trade lost more than ${usd(lim)} (${pct(firstLoss)} of the account). No second trade today.`);
    }
    if (Number.isNaN(profitStop)) block("PLAN_INVALID", "Your plan's funded profit stop isn't a number. Check the plan in Backup.");
    else if (profitStop !== null && funded && Number.isFinite(n.size) && Number.isFinite(n.todayResult)) {
      const lim = (n.size * profitStop) / 100;
      if (n.todayResult >= lim) block("PROFIT_STOP", `Funded and up ${usd(n.todayResult)} today. Your plan stops at ${usd(lim)} (${pct(profitStop)} of the account). Done for the day.`);
    }
    if (pp.blockIfOneMoreFullLossReachesDailyLimit === true && dailyFloor && Number.isFinite(n.equity) && Number.isFinite(budget)) {
      // DESIGN 5.4: the same daily room as the card (limits.dailyRoom): equity − daily floor − other open risk
      const dayRoom = n.equity - dailyFloor.level - other;
      step("Daily room for the next-loss check", `Equity ${usd(n.equity)} − daily loss floor ${usd(dailyFloor.level)} − other open trades ${usd(other)}`, usd(dayRoom));
      if (dayRoom - budget <= EPS) {
        block("DAILY_LIMIT_NEXT_LOSS", `One more full loss (${usd(budget)}) would reach the daily loss floor. Only ${usd(dayRoom)} is left before it${other > 0 ? `, after the ${usd(other)} at risk on your other open trades` : ""}.`);
      }
    }
    if (ist) {
      const nowText = `It's ${clock12(ist.minutes)} IST now.`;
      for (const w of Array.isArray(pp.noNewTradesIST) ? pp.noNewTradesIST : []) {
        const a = parseHHMM(w && w.from), b = parseHHMM(w && w.to);
        if (a === null || b === null || a === b) { block("PLAN_INVALID", "Your plan has a no-trade time that isn't a usable HH:MM window. Check the plan in Backup."); continue; }
        if (inWindow(ist.minutes, a, b)) block("TIME_WINDOW", `No new trades from ${clock12(a)} to ${clock12(b)} IST. ${nowText}`);
      }
      for (const d of Array.isArray(pp.noTradeDays) ? pp.noTradeDays : []) {
        if (!d || !Number.isInteger(d.weekdayIST) || d.weekdayIST < 0 || d.weekdayIST > 6) { block("PLAN_INVALID", "Your plan has a no-trade day that isn't a weekday number (0 Sunday to 6 Saturday)."); continue; }
        if (Array.isArray(d.classes) && d.classes.includes(cls) && ist.weekday === d.weekdayIST) {
          block("NO_TRADE_DAY", `It's ${WEEKDAY_NAMES[ist.weekday]} in India. Your plan has no ${CLASS_WORD[cls] || cls} trades on ${WEEKDAY_NAMES[d.weekdayIST]}s.`);
        }
      }
      for (const w of Array.isArray(pp.onlyBetweenIST) ? pp.onlyBetweenIST : []) {
        const a = parseHHMM(w && w.from), b = parseHHMM(w && w.to);
        if (a === null || b === null || a === b) { block("PLAN_INVALID", "Your plan has a trading window that isn't a usable HH:MM window. Check the plan in Backup."); continue; }
        if (Array.isArray(w.classes) && w.classes.includes(cls) && !inWindow(ist.minutes, a, b)) {
          const word = CLASS_WORD[cls] || cls;
          block("CLASS_WINDOW", `${word[0].toUpperCase()}${word.slice(1)} trades only from ${clock12(a)} to ${clock12(b)} IST. ${nowText}`);
        }
      }
    }
  }

  // ---- 7. News: a typed news time inside the plan's window, on a currency of this symbol ----
  const newsW = unwrap(plan.news);
  if (newsW.value && typeof newsW.value === "object") {
    const nv = newsW.value;
    const applies = nv.appliesTo === "funded" ? funded : true;
    const before = Number(nv.minutesBefore), after = Number(nv.minutesAfter);
    const items = Array.isArray(account.newsToday) ? account.newsToday : [];
    // Unknown currencies for a non-FX symbol: every typed news time counts (safer).
    const ccys = Array.isArray(inst.newsCurrencies) && inst.newsCurrencies.length ? inst.newsCurrencies
      : cls === "fx" && base && quote ? [base, quote] : null;
    if (applies && newsW.status === "conflict") notice("RULE_CONFLICT", `News rule: the firm's pages disagree. The stricter reading is used.${newsW.note ? " " + newsW.note : ""}`);
    if (applies && Number.isFinite(before) && Number.isFinite(after)) {
      for (const it of items) {
        const t = parseHHMM(it && it.timeIST);
        if (t === null) { block("ACCOUNT_INVALID", `A news time for today isn't HH:MM (${String((it && it.timeIST) ?? "")}). Fix it in Accounts.`); continue; }
        const ccy = it && typeof it.currency === "string" ? it.currency.trim().toUpperCase() : "";
        if (ccys && ccy && !ccys.includes(ccy)) continue;
        if (!ist) continue;
        let diff = ist.minutes - t; // minutes since the news, across midnight
        if (diff > 720) diff -= 1440;
        if (diff < -720) diff += 1440;
        if (diff >= -before && diff <= after) {
          block("NEWS_WINDOW", `${ccy || "High-impact"} news at ${clock12(t)} IST. On a funded account there are no trades on ${symbol} from ${clock12((t - before + 1440) % 1440)} to ${clock12((t + after) % 1440)} IST.`);
        }
      }
      if (!items.length) notice("NEWS_REMINDER", `No news times typed for today. On this funded account there are no trades from ${before} minutes before to ${after} minutes after high-impact news on ${symbol}.`);
    }
  }

  // ---- 8. Risk budget ----
  for (const [code, message] of budgetReasons) block(code, message);
  if (budget !== null) step("Risk budget", budgetHow, usd(budget));
  if (maxUSD !== null) step("Max risk per trade", `${pct(maxPct)} of ${usdShort(n.size)}`, usd(maxUSD));

  // ---- 9. Size, then caps in order: room, margin, firm contract limits, volume max ----
  let size = null, perUnit = null, commPerUnit = null, movePerUnit = null, capFrom = null, minSize = null;
  let capCause = "risk";
  const roomAvail = F.notSetUp.length === 0 && R.limits.roomNow !== null ? R.limits.roomNow - cushion : null;
  // A Treasury price typed in 32nds is never rounded onto the grid and sized, and neither is one that can be
  // read two ways (DESIGN 5.5).
  const canSize = dir !== null && Number.isFinite(budget) && budget >= 0 && Number.isFinite(n.size) &&
    Number.isFinite(n.equity) && !has("SPEC_UNCONFIRMED", "PRICE_OFF_GRID", "PRICE_AMBIGUOUS");
  const capTo = (by, to, why) => {
    notice("CAPPED", `Size cut from ${unitText(size)} to ${unitText(to)} ${why}.`);
    size = to; capCause = by; R.capped = { by };
  };
  const unitText = (x) => (futures ? contractsText(x) : `${x.toFixed(stepDecimals(spec.volumeStep || 0.01))} lots`);

  if (dir) {
    const stopPct = dist / entry;
    if (stopPct > 0.10) notice("STOP_FAR", `The stop is ${(stopPct * 100).toFixed(1)}% away from the entry. Check both prices for a typo.`);
    if (stopPct < 0.0002) notice("STOP_CLOSE", `The stop is only ${(stopPct * 100).toFixed(3)}% away from the entry. The spread alone can hit a stop this close.`);
  }

  if (!futures) {
    // ---------------- CFD lots (DESIGN 5.3) ----------------
    if (Number.isFinite(feesIn) && feesIn > 0) notice("FEES", "The fees box is for futures. CFD commission comes from the firm's rules.");
    if (cls === "fx" && Number.isFinite(entry)) {
      const jpy = quote === "JPY";
      if (jpy && entry < 20) notice("CHECK_PRICE", `${symbol} is quoted around 100 to 250. Check the entry price.`);
      if (!jpy && entry > 20) notice("CHECK_PRICE", `${symbol} is quoted below 20. Check the entry price.`);
    }
    const buffer = Number.isFinite(bufferIn) ? bufferIn : 0;
    const bufferPrice = cls === "fx" ? (pip > 0 ? buffer * pip : 0) : buffer;
    let exit = null;
    if (dir) {
      exit = dir === "buy" ? stop - bufferPrice : stop + bufferPrice;
      if (!(exit > 0)) { block("INPUT_INVALID", "The buffer is larger than the stop price. Check the buffer."); exit = null; }
      else if (buffer > 0) step("Stop fill after the buffer", `${pText(stop)} ${dir === "buy" ? "−" : "+"} ${cls === "fx" ? `${buffer} pips × ${pip}` : buffer}`, pText(exit));
    }
    // toUSD(p): USD per 1 unit of the profit currency when the traded symbol is at price p.
    // The working shows the rate as "1 CHF = $0.80", so an inverted price stands out.
    let toUSD = null, convHow = "";
    if (spec.profitCurrency) {
      const pc = spec.profitCurrency;
      if (pc === "USD") { toUSD = () => 1; convHow = "1 (profit is in USD)"; }
      else if (cls === "fx" && base === "USD" && quote === pc) {
        toUSD = (p) => 1 / p; convHow = `1 ÷ the ${symbol} price`;
        if (exit !== null) step("Profit currency to USD", `1 ÷ the ${symbol} price at the stop fill, ${pText(exit)}`, `1 ${pc} = $${rateText(1 / exit)}`);
      }
      else {
        const pair = CONV_PAIR[pc];
        if (!pair) block("CONVERSION_MISSING", `No USD conversion is set up for ${pc}.`);
        else if (convPrice === null) block("CONVERSION_MISSING", `Type the ${pair} price now to convert ${pc} to USD.`);
        else if (Number.isFinite(convPrice)) {
          const inverse = pair.startsWith("USD");
          const rate = inverse ? 1 / convPrice : convPrice;
          toUSD = () => rate;
          convHow = inverse ? `1 ÷ ${pair} ${convPrice}` : `${pair} ${convPrice}`;
          step("Profit currency to USD", inverse ? `${pair} typed ${bareNum(convPrice)}: 1 ÷ ${bareNum(convPrice)}` : `${pair} typed ${bareNum(convPrice)}`, `1 ${pc} = $${rateText(rate)}`);
          // Two likely typos block (review E2): a price outside the pair's usual range (often typed the other
          // way round, which sizes 1.5 to 1.7 times too big), and the traded symbol's own price typed in the
          // conversion box (GBPJPY 205 typed as USDJPY). The trader can confirm the exact price with a button
          // (trade.conversionConfirmed): then a notice says so instead. A confirmation of another price
          // clears nothing.
          const confRead = readNum(trade.conversionConfirmed);
          const confirmed = confRead.ok && !confRead.empty && confRead.value === convPrice;
          const cp = bareNum(convPrice);
          const rg = CONV_RANGE[pair];
          if (rg && (convPrice < rg[0] || convPrice > rg[1])) {
            if (confirmed) notice("CONVERSION_CONFIRMED", `You confirmed ${pair} ${cp} is right, although it is outside its usual range (${rg[0]} to ${rg[1]}).`);
            else block("CONVERSION_RANGE", `${pair} at ${cp} looks wrong: it usually trades between ${rg[0]} and ${rg[1]}. Check for a slipped decimal point or a price typed the other way round. If ${cp} is right, confirm it.`);
          }
          if (Number.isFinite(entry) && Math.abs(convPrice - entry) / entry <= CONV_SUSPECT_PCT / 100 + EPS) {
            if (confirmed) notice("CONVERSION_CONFIRMED", `You confirmed ${pair} ${cp} is right, although it is within ${CONV_SUSPECT_PCT}% of this trade's entry (${pText(entry)}).`);
            else block("CONVERSION_SUSPECT", `The ${pair} price you typed (${cp}) is within ${CONV_SUSPECT_PCT}% of this trade's entry (${pText(entry)}). It looks like the ${symbol} price went into the ${pair} box. Type the ${pair} price. If ${cp} is the ${pair} price, confirm it.`);
          }
        }
      }
    }
    if (canSize && toUSD && exit !== null && spec.contract && spec.volumeStep && spec.volumeMin && spec.leverage && spec.commission) {
      const qEntry = toUSD(entry), qExit = toUSD(exit);
      const stepV = spec.volumeStep;
      movePerUnit = (dist + bufferPrice) * spec.contract * qExit;
      commPerUnit = commissionPerUnit(spec.commission, spec.contract, entry, qEntry, exit, qExit);
      perUnit = movePerUnit + commPerUnit;
      minSize = spec.volumeMin;
      const marginPerLot = (spec.contract * entry * qEntry) / spec.leverage;
      step("Price move per lot", `${priceText(dist + bufferPrice, digits)} × ${NF0.format(spec.contract)} × ${spec.profitCurrency === "USD" ? "1" : `USD rate at ${pText(exit)}: ${convHow} = ${fixed(qExit, 6)}`}`, usd(movePerUnit));
      step("Commission per lot", commissionHow(spec.commission), usd(commPerUnit));
      step("Loss per lot at the stop", `${usd(movePerUnit)} + ${usd(commPerUnit)}`, usd(perUnit));
      size = floorToStep(budget / perUnit, stepV);
      capFrom = size;
      step("Lots for the budget", `${usd(budget)} ÷ ${usd(perUnit)} = ${fixed(budget / perUnit, 4)}, rounded down to the ${stepV} step`, unitText(size));

      if (roomAvail !== null) {
        const byRoom = largestFit(roomAvail, perUnit, stepV);
        step("Room cap", `(${usd(R.limits.roomNow)} room − ${usd(cushion)} cushion) ÷ ${usd(perUnit)}, rounded down`, unitText(byRoom));
        if (byRoom < size) capTo("room", byRoom, `to stay above the ${R.limits.binding.name.toLowerCase()} floor`);
      }
      const planMarginCap = unwrap(plan.marginCapPct);
      const capPct = usable(planMarginCap) && Number(planMarginCap.value) > 0 ? Math.min(appMarginCap, Number(planMarginCap.value)) : appMarginCap;
      const availableMargin = (capPct / 100) * n.equity - (Number.isFinite(n.marginUsed) ? n.marginUsed : 0);
      R.margin = { perUnit: marginPerLot, needed: 0, capPct, available: availableMargin };
      const byMargin = largestFit(availableMargin, marginPerLot, stepV);
      step("Margin per lot", `${NF0.format(spec.contract)} × ${pText(entry)} × ${spec.profitCurrency === "USD" ? "1" : fixed(qEntry, 6)} ÷ ${spec.leverage} leverage`, usd(marginPerLot));
      step("Margin cap", `${pct(capPct)} of equity ${usd(n.equity)} − margin in use ${usd(n.marginUsed || 0)} = ${usd(availableMargin)}; ÷ ${usd(marginPerLot)}, rounded down`, unitText(byMargin));
      if (byMargin < size) capTo("margin", byMargin, `to keep margin within ${pct(capPct)} of equity`);
      if (spec.volumeMax !== null) {
        const byMax = floorToStep(spec.volumeMax, stepV);
        if (byMax < size) capTo("volumeMax", byMax, `the maximum volume for ${symbol}`);
      }
      if (Number.isFinite(target)) {
        const qT = toUSD(target);
        const net = Math.abs(target - entry) * spec.contract * qT - commissionPerUnit(spec.commission, spec.contract, entry, qEntry, target, qT);
        R.reward = { target, perUnit: net, total: 0, rrPrice: Math.abs(target - entry) / dist, rrAfterCosts: net / perUnit };
      }
    }
  } else {
    // ---------------- Futures contracts (DESIGN 5.5) ----------------
    if (Number.isFinite(bufferIn) && bufferIn > 0) notice("BUFFER_IGNORED", "The buffer box is for CFD. Futures use the slippage setting instead.");
    const ts = spec.tickSize, tv = spec.tickValue;
    if (canSize && ts && tv && fees !== null) {
      const toTicks = (d, round) => {
        const raw = d / ts, near = Math.round(raw);
        if (Math.abs(raw - near) < 1e-6) return { ticks: near, off: false };
        return { ticks: round === "up" ? Math.ceil(raw) : Math.floor(raw), off: true };
      };
      const onGrid = (p) => Math.abs(p / ts - Math.round(p / ts)) < 1e-6;
      const st = toTicks(dist, "up");
      const quoteUnit = unwrap(inst.quoteUnit).value;
      if (st.off || !onGrid(entry) || !onGrid(stop)) {
        notice("OFF_GRID", `A price isn't on the ${ts} tick grid of ${symbol}. The stop distance is rounded up to ${st.ticks} ticks.${typeof quoteUnit === "string" && quoteUnit ? ` ${symbol} prices are in ${quoteUnit}.` : ""}`);
      }
      movePerUnit = (st.ticks + slipTicks) * tv;
      commPerUnit = fees;
      perUnit = movePerUnit + fees;
      minSize = 1;
      step("Ticks at risk", `${priceText(dist, digits)} ÷ ${ts} tick${st.off ? ", rounded up" : ""}`, `${st.ticks} ticks`);
      step("Risk per contract", `(${st.ticks} ticks + ${slipTicks} slippage) × ${usd(tv)} + ${usd(fees)} fees`, usd(perUnit));
      size = floorToStep(budget / perUnit, 1);
      capFrom = size;
      step("Contracts for the budget", `${usd(budget)} ÷ ${usd(perUnit)} = ${fixed(budget / perUnit, 4)}, rounded down`, unitText(size));
      if (roomAvail !== null) {
        const byRoom = largestFit(roomAvail, perUnit, 1);
        step("Room cap", `(${usd(R.limits.roomNow)} room − ${usd(cushion)} cushion) ÷ ${usd(perUnit)}, rounded down`, unitText(byRoom));
        if (byRoom < size) capTo("room", byRoom, `to stay above the ${R.limits.binding.name.toLowerCase()} floor`);
      }
      // Firm contract limits for the plan size (never the balance), minis and micros at 10:1, product caps.
      const ccW = unwrap(plan.contractCaps);
      const noCaps = ccW.status === "none" || (ccW.value === null && statusOk(ccW));
      if (!noCaps) {
        const row = usable(ccW) && ccW.value.bySize ? ccW.value.bySize[String(n.size)] : null;
        const wW = unwrap(classField(inst, "capWeight"));
        if (!usable(ccW)) block("RULE_UNCONFIRMED", "The firm's contract limits for this plan aren't confirmed, so no size can be given.");
        else if (!row) block("RULE_UNCONFIRMED", `No contract limit is set up for a ${usdShort(n.size)} account on this plan.`);
        else if (!usable(wW) || !(Number(wW.value) > 0)) block("SPEC_UNCONFIRMED", `How ${symbol} counts toward the firm's contract limit isn't confirmed.`);
        else {
          if (wW.status === "conflict") notice("RULE_CONFLICT", `How ${symbol} counts toward the firm's contract limit: the firm's pages disagree. The stricter reading is used.${wW.note ? " " + wW.note : ""}`);
          const w = Number(wW.value), minis = Number(row.minis), micros = Number(row.micros);
          const useMicros = w < 1 && Number.isFinite(micros);
          const capacity = useMicros ? micros / 10 : minis; // in minis
          let cap = Number.isFinite(capacity) && capacity > 0 ? Math.floor(Number((capacity / w).toFixed(9))) : 0;
          let how = useMicros ? `${micros} micros at 10 to a mini${w !== 0.1 ? `; ${symbol} counts as ${w} of a mini` : ""}` : `${minis} minis${w !== 1 ? `; ${symbol} counts as ${w} of a mini` : ""}`;
          // The firm's own limit for this product, when its list has one. A limit of 0 or less never gets
          // here (the product isn't allowed: decided before the prices, NOT_ALLOWED). A listed limit that
          // can't be read for this account size is never skipped, which would allow a bigger size: it blocks.
          const lists = isObj(ccW.value.productCaps) && Object.hasOwn(ccW.value.productCaps, symbol) ? ccW.value.productCaps[symbol] : undefined;
          const pcap = isObj(lists) && Object.hasOwn(lists, String(n.size)) ? lists[String(n.size)] : undefined;
          if (lists !== undefined && !(typeof pcap === "number" && Number.isFinite(pcap))) {
            block("RULE_UNCONFIRMED", `The firm's own limit for ${symbol} on a ${usdShort(n.size)} account isn't set up in a way the app can use, so no size can be given.`);
          } else {
            if (lists !== undefined) {
              cap = Math.min(cap, Math.max(0, Math.floor(pcap)));
              how += `; ${symbol} limit ${pcap}`;
            }
            step("Firm contract limit", `${usdShort(n.size)} plan: ${how}`, unitText(cap));
            notice("FIRM_CAP_OPEN", "The firm's contract limit counts every open contract. This size assumes nothing else is open.");
            if (ccW.value.mixAllowed === false) notice("MIX_NOT_ALLOWED", "This plan doesn't allow minis and micros open at the same time.");
            if (cap < size) capTo("firmCap", cap, `the firm's limit for ${symbol}`);
          }
        }
      }
      if (Number.isFinite(target)) {
        const tt = toTicks(Math.abs(target - entry), "down");
        if (tt.off || !onGrid(target)) notice("OFF_GRID", `The target isn't on the ${ts} tick grid. The target distance is rounded down to ${tt.ticks} ticks.`);
        const net = tt.ticks * tv - fees;
        R.reward = { target, perUnit: net, total: 0, rrPrice: Math.abs(target - entry) / dist, rrAfterCosts: net / perUnit };
      }
    }
  }

  // ---- 10. Below the minimum volume (or 0 contracts) ----
  if (size !== null) {
    if (size < minSize - EPS) {
      if (!has("BREACHED", "NO_ROOM")) {
        const minText = `The smallest size, ${unitText(minSize)}, would risk ${usd(minSize * perUnit)}.`;
        let msg;
        if (capCause === "room") msg = `Only ${usd(R.limits.roomNow)} of room is left above the ${R.limits.binding.name.toLowerCase()} floor. ${minText}`;
        else if (capCause === "margin") msg = `Not enough margin: ${usd(R.margin.available)} is free under the ${pct(R.margin.capPct)} cap, and ${unitText(minSize)} needs ${usd(minSize * R.margin.perUnit)}.`;
        else if (capCause === "firmCap") msg = `The firm's contract limit for ${symbol} on this plan is 0.`;
        else if (capCause === "volumeMax") msg = `The maximum volume for ${symbol} is below the minimum. Check the MT5 Specification.`;
        else msg = futures ? `One contract risks ${usd(perUnit)}, more than the ${usd(budget)} budget.` : `Risk ${usd(budget)} is too small for this stop. ${minText}`;
        block("TOO_SMALL", msg);
        // The micro is suggested only when this plan's contract limits let it trade (not a limit of 0).
        // (A product the firm doesn't allow never gets here: it is decided before the prices, NOT_ALLOWED.)
        const micro = unwrap(inst.micro).value;
        if (futures && capCause === "risk" && typeof micro === "string" && micro && microAllowed(plan, n.size, micro)) {
          notice("TRY_MICRO", `Try ${micro}, the micro contract, for a smaller size.`);
        }
      }
      size = 0;
    }
    if (R.capped) R.capped = { from: capFrom, to: size, by: R.capped.by };
    R.size = size;
    R.risk.perUnit = perUnit;
    R.risk.commissionPerUnit = commPerUnit;
    R.risk.movePerUnit = movePerUnit;
    R.risk.atStop = size * perUnit;
    R.risk.commission = size * commPerUnit;
    R.risk.priceMove = size * movePerUnit;
    if (R.reward) R.reward.total = size * R.reward.perUnit;
    if (!futures) R.margin.needed = size * R.margin.perUnit;
    if (R.limits.roomNow !== null) R.limits.roomAfterStop = R.limits.roomNow - R.risk.atStop;
    step("Size", R.capped ? "The smallest of the budget size and the caps" : "From the risk budget", unitText(size));
    step("Loss at the stop", `${futures ? size : size.toFixed(stepDecimals(spec.volumeStep))} × ${usd(perUnit)}`, usd(R.risk.atStop));
    if (R.limits.roomNow !== null) step("Room after the stop", `${usd(R.limits.roomNow)} − ${usd(R.risk.atStop)}`, usd(R.limits.roomAfterStop));
    if (R.reward) step("Reward at the target", `${R.reward.rrPrice.toFixed(2)} R on price, ${R.reward.rrAfterCosts.toFixed(2)} R after costs`, usd(R.reward.total));
  }

  // ---- Reminders and info-only rules (never block) ----
  const hold = unwrap(plan.minHoldSeconds);
  if (Number(hold.value) > 0) {
    const s = Number(hold.value);
    notice("MIN_HOLD", `Hold each trade at least ${s % 60 === 0 ? `${s / 60} minute${s === 60 ? "" : "s"}` : `${s} seconds`} (firm rule).${statusOk(hold) ? "" : " Not confirmed."}`);
  }
  const cons = unwrap(plan.consistency);
  if (cons.value && Number(cons.value.pctBestDay) > 0) {
    const forPayout = cons.value.appliesTo === "payout";
    if (forPayout ? funded : !funded) {
      notice("CONSISTENCY", `Consistency rule ${forPayout ? "before a payout" : "in the evaluation"}: your best day must stay within ${pct(cons.value.pctBestDay)} of total profit. Info only: it doesn't change the size.${statusOk(cons) ? "" : " Not confirmed."}`);
    }
  }
  if (pp && pp.requireStopAndTarget === true) notice("STOP_AND_TARGET", "Stop and target go in with the entry.");

  return finalize(R, stepForText);
}

// ------------------------------------------------------------- symbols for the screens ----
//
// resolveInstrument builds the instrument that evaluateTrade sizes with; checkFill reads a real MT5 trade
// back into a contract size. The screens call these and only show what they return (DESIGN 5.6).

const TOO_SMALL_TO_SETTLE = "This trade is too small to settle it. Use a bigger move or volume.";
const showValue = (v) => (typeof v === "number" ? plainNum(v) : String(v));

/** Same value, with a float tolerance for numbers. */
function sameValue(a, b) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
  return a === b;
}

/**
 * The stricter of two volume values: the larger minimum, the smaller maximum, and the coarser step only
 * when it is a whole multiple of the finer one (then every size on it is valid on both). Otherwise null.
 */
function stricterVolume(field, dataVal, yours) {
  if (!Number.isFinite(dataVal) || !Number.isFinite(yours) || !(dataVal > 0) || !(yours > 0)) return null;
  if (field === "volumeMin") return Math.max(dataVal, yours);
  if (field === "volumeMax") return Math.min(dataVal, yours);
  const big = Math.max(dataVal, yours), small = Math.min(dataVal, yours);
  const ratio = big / small;
  return Math.abs(ratio - Math.round(ratio)) < 1e-9 ? big : null;
}

/** A date for a "checked" field: 'YYYY-MM-DD' as given, or the India date of a time. null when unreadable. */
function dayText(x) {
  if (typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x.trim())) return x.trim();
  const ms = timeMs(x);
  if (!Number.isFinite(ms)) return null;
  try {
    const p = zoneParts(ms, IST_ZONE);
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  } catch {
    return null;
  }
}

/** The trader's saved values: { field: { raw, when } }. Takes { specs: {...}, specsCheckedOn } or flat fields, each a value or { value, checked }. */
function typedValues(conf) {
  const out = {};
  const specs = isObj(conf.specs) ? conf.specs : conf;
  const common = dayText(conf.specsCheckedOn ?? conf.checkedOn ?? conf.typedOn ?? null);
  for (const f of CONFIRMABLE) {
    let raw = specs[f], when = common;
    if (isObj(raw) && "value" in raw) {
      when = dayText(raw.checked ?? raw.typedOn ?? raw.date ?? raw.on ?? raw.at ?? null) ?? common;
      raw = raw.value;
    }
    if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) continue;
    out[f] = { raw, when };
  }
  return out;
}

/** One saved value, read strictly: a 3-letter code for the profit currency, a number above 0 otherwise. */
function readTyped(field, raw) {
  if (field === "profitCurrency") {
    const s = typeof raw === "string" ? raw.trim().toUpperCase() : "";
    return /^[A-Z]{3}$/.test(s) ? { ok: true, value: s } : { ok: false, why: "isn't a three-letter currency code" };
  }
  const r = readNum(raw, { money: field === "contract" });
  if (!r.ok || r.empty) return { ok: false, why: "isn't a number" };
  if (!(r.value > 0)) return { ok: false, why: "isn't more than 0" };
  return { ok: true, value: r.value };
}

/** The plan's published futures fee for this symbol, merged into the commission (the higher fixed fee wins). */
function mergePlanFees(inst, planFees) {
  const w = unwrap(planFees);
  let c = w.value;
  if (typeof c === "number") c = { type: "perContractRoundTrip", amount: c };
  const fee = isWrapper(planFees) ? { ...clone(planFees), value: clone(c) } : clone(c);
  const old = unwrap(inst.commission);
  const oldFee = usable(old) ? roundTripFee(old.value) : null;
  if (!usable(w)) {
    // No source for the plan's fee: it can't replace a fee that has one. Alone, it leaves the typed fee in use.
    if (!usable(old)) inst.commission = fee;
    return;
  }
  const planFee = roundTripFee(c);
  if (planFee === null) {
    inst.commission = fee; // evaluateTrade blocks: the published fee can't be read
    inst.issues.push(`The plan's published fee for ${inst.symbol} isn't in a form Risk Desk can read.`);
    return;
  }
  if (oldFee !== null && oldFee > planFee) {
    inst.notes.push(`The symbol list's fee for ${inst.symbol} (${usd(oldFee)} round trip) is higher than the plan's (${usd(planFee)}), so the higher one is kept.`);
    return;
  }
  inst.commission = fee;
}

/** The trader's MT5 values merged into a CFD symbol (DESIGN 5.6). Returns the open disagreements. */
function mergeConfirmation(inst, conf) {
  const typed = typedValues(conf);
  const rt = isObj(conf.realTrade) ? conf.realTrade : null;
  inst.confirmation = { specsCheckedOn: dayText(conf.specsCheckedOn ?? conf.checkedOn ?? null), fields: Object.keys(typed), hasCheck: !!rt };
  const disagree = {};
  for (const f of CONFIRMABLE) {
    const t = typed[f];
    if (!t) continue;
    const label = SPEC_LABEL[f];
    const read = readTyped(f, t.raw);
    if (!read.ok) {
      inst[f] = { value: null, status: "unconfirmed", note: `Your saved ${label.toLowerCase()} (${String(t.raw)}) ${read.why}. Type it again from the MT5 Specification window.` };
      inst.issues.push(`${label}: your saved value ${String(t.raw)} can't be read.`);
      continue;
    }
    const tv = read.value;
    const yours = { value: tv, status: "your-mt5", source: "Your MT5 Specification window, typed in Risk Desk", checked: t.when };
    const dataW = inst[f];
    const d = unwrap(dataW);
    if (!usable(d)) { inst[f] = yours; continue; }
    const dv = typeof tv === "number" ? Number(d.value) : String(d.value).trim().toUpperCase();
    if (sameValue(dv, tv)) { if (d.status === "conflict") inst[f] = yours; continue; }
    if (f === "volumeStep" || f === "volumeMin" || f === "volumeMax") {
      const pick = stricterVolume(f, dv, tv);
      if (pick !== null) {
        const note = `Your MT5 shows ${plainNum(tv)} and the data file ${plainNum(dv)}. The stricter one is used.`;
        inst[f] = sameValue(pick, tv) || !isWrapper(dataW) ? { ...yours, value: pick, note } : { ...clone(dataW), value: pick, note };
        inst.notes.push(`${label} for ${inst.symbol}: ${note}`);
        continue;
      }
    }
    disagree[f] = { yours: tv, data: dv, status: d.status, wrapper: clone(dataW) };
    inst[f] = { value: null, status: "unconfirmed", note: `Your MT5 shows ${showValue(tv)}, but the data file (${STATUS_WORD[d.status] || d.status}) says ${showValue(dv)}. Check MT5 again, or settle it with a real-trade check.` };
    inst.issues.push(`${label}: your MT5 value ${showValue(tv)} and the data file's ${showValue(dv)} disagree.`);
  }
  if (rt) settleWithRealTrade(inst, rt, disagree);
}

/**
 * A saved real trade: a decisive match settles a contract-size or profit-currency disagreement (never by
 * replacing the firm's confirmed contract size with a smaller one, and never with a contract size smaller
 * than the one the trade points to); a clear mismatch blocks the contract size; a trade too small to tell
 * settles nothing.
 */
function settleWithRealTrade(inst, rt, disagree) {
  const open = !!(disagree.contract || disagree.profitCurrency);
  const cNow = unwrap(inst.contract), pNow = unwrap(inst.profitCurrency);
  const C = disagree.contract ? disagree.contract.yours : usable(cNow) && Number(cNow.value) > 0 ? Number(cNow.value) : null;
  const P = disagree.profitCurrency ? disagree.profitCurrency.yours : usable(pNow) ? String(pNow.value) : null;
  const candidate = { ...inst, contract: { value: C, status: "your-mt5" }, profitCurrency: { value: P, status: "your-mt5" } };
  const r = checkFill({ instrument: candidate, fill: rt, conversionPrice: rt.conversionPrice });
  const checkedOn = dayText(rt.checkedOn ?? rt.at ?? null);
  inst.check = { ...r, contractTested: C, profitCurrencyTested: P, checkedOn };
  if (r.ok && r.decisive) {
    const src = `Your real trade${checkedOn ? `, checked ${checkedOn}` : ""}: the profit MT5 showed matched`;
    // A match allows 1%, so the contract size used is never smaller than the one the trade points to (review
    // E4): the larger of the size tested and the implied size, rounded to 4 significant figures.
    const implied = Number(r.impliedContract.toPrecision(4));
    const useImplied = implied > C && !sameValue(implied, C);
    const use = useImplied ? implied : C;
    // The firm's confirmed contract size: the data file's, whether or not the trader typed another one.
    const firmW = disagree.contract ? (disagree.contract.status === "confirmed" ? disagree.contract.wrapper : null)
      : cNow.status === "confirmed" ? clone(inst.contract) : null;
    const firmC = firmW ? Number(unwrap(firmW).value) : null;
    if (firmC !== null && (use < firmC || sameValue(use, firmC))) {
      // The firm's confirmed contract size is never replaced by a smaller one, so a size never comes out bigger.
      inst.contract = firmW;
      if (!sameValue(use, firmC)) {
        inst.notes.push(`Your real trade matches a contract size of ${plainNum(use)}, but the firm's site says ${plainNum(firmC)}. Risk Desk never uses a smaller contract size than the firm's confirmed one, so ${plainNum(firmC)} stays in use and sizes come out smaller, never bigger.`);
      } else if (disagree.contract) {
        inst.notes.push(`Your real trade points to a contract size of ${plainNum(firmC)}, the firm's confirmed one, so ${plainNum(firmC)} stays in use, not the ${plainNum(C)} you typed.`);
      }
    } else if (disagree.contract || cNow.status !== "confirmed" || useImplied) {
      inst.contract = { value: use, status: "your-trades", source: src, checked: checkedOn };
      if (useImplied) {
        inst.notes.push(`Your real trade points to a contract size of about ${plainNum(implied)}, a little more than ${disagree.contract ? `the ${plainNum(C)} you typed` : plainNum(C)}. Risk Desk uses the larger one, ${plainNum(implied)}, so sizes come out smaller, never bigger.`);
      }
    }
    if (disagree.profitCurrency) inst.profitCurrency = { value: P, status: "your-trades", source: src, checked: checkedOn };
    inst.issues = inst.issues.filter((m) => !/^(Contract size|Profit currency):/.test(m));
  } else if (r.ok && r.match === false) {
    const implied = plainNum(Number(r.impliedContract.toPrecision(4)));
    const isData = disagree.contract && Math.abs(r.impliedContract / disagree.contract.data - 1) <= 0.01;
    inst.contract = { value: null, status: "unconfirmed", note: `Your real trade doesn't match a contract size of ${plainNum(C)} with profit in ${P}: MT5's numbers point to about ${implied}. Fix the contract size or clear the check.` };
    inst.issues.push(`The real-trade check doesn't match: MT5's numbers point to a contract size of about ${implied}, not ${plainNum(C)}.${isData ? " That is the data file's value: fix the contract size you typed." : ""}`);
  } else if (r.ok) {
    (open ? inst.issues : inst.notes).push(r.message);
  } else {
    (open ? inst.issues : inst.notes).push(`The saved real-trade check can't be used: ${r.errors[0]}`);
  }
}

/**
 * One symbol, resolved for evaluateTrade (DESIGN 5.6):
 *   symbol        the data file's symbol entry
 *   classInfo     the data file's class entry for symbol.class (leverage, commission, label)
 *   confirmation  the trader's saved MT5 values for this symbol, or null: { specs: { contract, profitCurrency,
 *                 volumeStep, volumeMin, volumeMax }, specsCheckedOn, realTrade: { lots, open, close, profit,
 *                 conversionPrice, checkedOn } }. Flat fields, and { value, checked } per field, work too.
 *   planFees      the plan's published futures fee for this symbol (a value wrapper whose value is a
 *                 commission { type, amount }, or a number = round trip per contract), or null.
 * Returns the symbol with symbol.class kept as the class id, the class fields merged in (the symbol's own
 * win), and: classId, classLabel, classInfo, confirmation, check (the real-trade check, or null),
 * issues (why the symbol is blocked, in plain words) and notes (what was merged; never blocking).
 * The rules, so that a disagreement never picks the looser value:
 *   - volume step, minimum and maximum: the stricter of yours and the data's (larger minimum, smaller
 *     maximum, the coarser step only when it is a whole multiple of the finer); else blocked
 *   - contract size or profit currency that disagree: blocked (status unconfirmed with a note) until a
 *     decisive real-trade check (checkFill) settles them
 *   - a decisive check uses the larger of the contract size tested and the one the trade points to
 *     (4 significant figures), with a note when it is the trade's: never smaller than the evidence
 *   - the firm's confirmed contract size is never replaced by a smaller one
 *   - futures: planFees becomes the commission, so evaluateTrade's max(published, typed) fee rule applies
 * null when there is no symbol.
 */
export function resolveInstrument({ symbol, classInfo = null, confirmation = null, planFees = null } = {}) {
  if (!isObj(symbol) || typeof symbol.symbol !== "string" || !symbol.symbol) return null;
  const inst = clone(symbol);
  const classId = typeof symbol.class === "string" ? symbol.class : isObj(symbol.class) && typeof symbol.class.id === "string" ? symbol.class.id : "";
  const ci = isObj(classInfo) ? clone(classInfo) : null;
  inst.class = classId;
  inst.classId = classId;
  inst.classInfo = ci;
  inst.classLabel = (ci && typeof ci.label === "string" && ci.label) || classId;
  if (ci) for (const [k, v] of Object.entries(ci)) if (k !== "label" && inst[k] === undefined) inst[k] = clone(v);
  inst.confirmation = null;
  inst.check = null;
  inst.issues = [];
  inst.notes = [];
  if (planFees !== undefined && planFees !== null) mergePlanFees(inst, planFees);
  const isFutures = inst.tickSize !== undefined || inst.tickValue !== undefined;
  if (isObj(confirmation) && !isFutures) mergeConfirmation(inst, confirmation);
  const ccy = isFutures ? null : fxProfitMismatch(inst);
  if (ccy) inst.issues.push(`Profit currency: ${inst.symbol} is quoted in ${ccy.quote}, so its profit is in ${ccy.quote}, not ${ccy.given}.`);
  return inst;
}

/**
 * A real MT5 trade read back into a contract size (DESIGN 5.6). MT5's profit (in USD) = volume × price move ×
 * contract size × USD per unit of the profit currency (at the close). The candidate is the instrument's
 * contract size and profit currency. fill: { lots, open, close, profit } (numbers or typed text; a loss may
 * be negative); conversionPrice: the USD pair's price when the trade closed, when the profit currency needs one.
 * Returns { ok, errors, impliedContract, expectedProfit, match, decisive, message } (plus impliedPerLot,
 * ratio, profitCurrency, contractTested, needsPair):
 *   decisive  true only when |profit| ≥ $1 and the implied contract size is within 1% of the candidate
 *   match     true when decisive; false when |profit| ≥ $1 and it is further off (a clear mismatch);
 *             null otherwise, with the message "This trade is too small to settle it. Use a bigger move or volume."
 */
export function checkFill({ instrument = null, fill = null, conversionPrice } = {}) {
  const fail = (errors, extra = {}) => ({ ok: false, errors, impliedContract: null, expectedProfit: null, match: null, decisive: false, message: errors[0], ...extra });
  try {
    const inst = isObj(instrument) ? instrument : {};
    const f = isObj(fill) ? fill : {};
    const v = {};
    for (const [k, label, money] of [["lots", "Volume", false], ["open", "Open price", false], ["close", "Close price", false], ["profit", "Profit", true]]) {
      const r = readNum(f[k], { money });
      if (!r.ok) return fail([`${label}: ${r.message}`]);
      v[k] = r.empty ? null : r.value;
    }
    if (["lots", "open", "close", "profit"].some((k) => v[k] === null)) return fail(["Fill in the volume, open price, close price and profit."]);
    if (!(v.lots > 0) || !(v.open > 0) || !(v.close > 0)) return fail(["Volume and prices must be more than 0."]);
    const move = Math.abs(v.close - v.open);
    if (move === 0) return fail(["The open and close prices are the same, so there's nothing to check."]);
    const profit = Math.abs(v.profit);
    if (profit === 0) return fail(["Profit is 0. Use a trade that has moved."]);
    const pcRaw = unwrap(classField(inst, "profitCurrency")).value;
    const P = typeof pcRaw === "string" ? pcRaw.trim().toUpperCase() : "";
    if (!/^[A-Z]{3}$/.test(P)) return fail(["Set the profit currency first."]);
    const { base, quote } = fxSides(inst);
    const need = conversionNeed(P, base, quote);
    let q;
    if (P === "USD") q = 1;
    else if (!need) q = 1 / v.close; // a USD-base pair (USDJPY): its profit converts at its own close price
    else if (!need.pair) return fail([`Risk Desk can't turn ${P} into USD.`]);
    else {
      const cr = readNum(conversionPrice ?? f.conversionPrice);
      if (!cr.ok || cr.empty || !(cr.value > 0)) return fail([`Type the ${need.pair} price at the time this trade closed.`], { needsPair: need.pair });
      q = need.invert ? 1 / cr.value : cr.value;
    }
    const impliedPerLot = profit / (v.lots * move);
    const impliedContract = impliedPerLot / q;
    const cRaw = unwrap(classField(inst, "contract")).value;
    const cRead = readNum(cRaw, { money: true });
    const C = cRead.ok && !cRead.empty && cRead.value > 0 ? cRead.value : null;
    const implied = plainNum(Number(impliedContract.toPrecision(4)));
    const out = { ok: true, errors: [], impliedContract, impliedPerLot, expectedProfit: null, match: null, decisive: false, message: "", ratio: null, profitCurrency: P, contractTested: C };
    const bigEnough = profit >= 1;
    if (C === null) {
      out.message = bigEnough ? `MT5's numbers point to a contract size of about ${implied}. Type the contract size from MT5's Specification window to compare.` : TOO_SMALL_TO_SETTLE;
      return out;
    }
    out.expectedProfit = v.lots * move * C * q;
    out.ratio = impliedContract / C;
    if (!bigEnough) out.message = TOO_SMALL_TO_SETTLE;
    else if (Math.abs(out.ratio - 1) <= 0.01 + 1e-12) {
      out.match = true;
      out.decisive = true;
      const same = sameValue(Number(impliedContract.toPrecision(4)), C);
      out.message = `Matches: MT5's profit points to a contract size of about ${implied}, ${same ? "the same as" : "within 1% of"} ${plainNum(C)}.`;
    } else {
      out.match = false;
      out.message = `Doesn't match: MT5's numbers point to a contract size of about ${implied}, not ${plainNum(C)}. Check the contract size in MT5's Specification window${need && need.pair ? ` and the ${need.pair} price you typed` : ""}.`;
    }
    return out;
  } catch (err) {
    return fail([`The check hit an unexpected problem: ${String((err && err.message) || err)}`]);
  }
}

/**
 * Which USD price the trader types to turn a profit currency into USD (DESIGN 5.3): null when none is needed
 * (USD, or a USD-base pair such as USDJPY, which converts at its own price); else { currency, pair, invert }
 * (invert: USD per unit = 1 ÷ the pair's price), with pair null when no conversion is set up.
 */
export function conversionNeed(profitCurrency, base, quote) {
  const raw = isWrapper(profitCurrency) ? profitCurrency.value : profitCurrency;
  const P = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!P || P === "USD") return null;
  if (base === "USD" && quote === P) return null;
  const pair = CONV_PAIR[P];
  return pair ? { currency: P, pair, invert: pair.startsWith("USD") } : { currency: P, pair: null, invert: false };
}

/**
 * The values a size depends on (DESIGN 5.1 step 3) that are unconfirmed, missing or unusable after
 * resolveInstrument: CFD contract, profitCurrency, volumeStep, volumeMin; futures tickSize, tickValue.
 * A forex profit currency that isn't the pair's quote currency counts as a gap. market: "cfd" or
 * "futures"; when left out it is inst.market, or futures when the symbol has a tick size.
 */
export function sizeSpecGaps(inst, market) {
  if (!isObj(inst)) return [];
  const m = market || inst.market || (inst.tickSize !== undefined || inst.tickValue !== undefined ? "futures" : "cfd");
  const fields = SIZE_SPECS[m] || [];
  const gaps = fields.filter((f) => {
    const w = unwrap(classField(inst, f));
    if (!usable(w)) return true;
    if (f === "profitCurrency") return !/^[A-Z]{3}$/.test(String(w.value));
    const x = Number(w.value);
    return !(x > 0) || !Number.isFinite(x);
  });
  if (m === "cfd" && !gaps.includes("profitCurrency") && fxProfitMismatch(inst)) gaps.push("profitCurrency");
  return gaps;
}

/* XAUUSD multi-timeframe SMC decision engine (v2).
   H1 = bias/context · M15 = liquidity + structure + setup · M5 = entry confirmation.
   Works in the browser (window.Engine) and in Node (require). Input: 1-minute candles built from XAUUSD spot ticks.
   Only closed candles are used for structure (no repainting); the forming candle is reported separately. */
(function (root, factory) { if (typeof module === "object" && module.exports) module.exports = factory(); else root.Engine = factory(); })(typeof self !== "undefined" ? self : this, function () {
"use strict";
const VERSION = "xau-smc-2";
const SEC = { M5: 300, M15: 900, H1: 3600 };
const COVER = { M5: 3, M15: 6, H1: 20 };      // min 1-minute candles that must exist inside a candle for it to count
const K = { M5: 0.9, M15: 1.0, H1: 1.2 };     // zigzag swing threshold in ATRs (major structure)
const KI = { M5: 0.45, M15: 0.5 };            // internal structure threshold (BOS/CHoCH used for setups/confirmation)
const NEED = { M5: 40, M15: 24, H1: 20 };
const DEFAULTS = {
  debug: false, minGrade: "A", minRR: 2,
  weights: { h1: 20, sweep: 20, m15: 15, disp: 10, fvgob: 10, pd: 5, m5: 15, rr: 5 },
  grades: { aplus: 90, a: 80, b: 70, c: 60 },
  sweep: { minPenATR: 0.03, minPenAbs: 0.1, rejectWick: 0.25, reclaim: 3, requireDispAfter: false, dispAfterMin: 40, lookback: { M5: 36, M15: 12 } },
  bos: { buf: 0.05, validDisp: 45 },
  disp: { strong: 70, ok: 45 },
  fvg: { minATR: 0.15 },
  aplus: { minBiasConf: 70, minDisp: 70, minZoneQ: 60, minM5: 70 },
  zoneQualityMin: 35,
  m5: { minScore: 60 },
  pd: { discountBelow: 45, premiumAbove: 55, blockBuyAbove: 60, blockSellBelow: 40 },
  sl: { bufATR5: 0.2, bufMin: 0.5, highVolMult: 1.5 },
  risk: { minAbs: 1.0, maxATR15: 2.2 },
  news: { beforeMin: 30, afterMin: 15, postMin: 90 },
  regime: { highVol: 1.8, lowVol: 0.6, rangingMinGrade: "A+" },
  staleSec: 900, minCoverage: 0.6
};
let CFG = JSON.parse(JSON.stringify(DEFAULTS));
function merge(t, s) { for (const k in s) { if (s[k] && typeof s[k] === "object" && !Array.isArray(s[k])) { t[k] = merge(t[k] || {}, s[k]); } else t[k] = s[k]; } return t; }
const r2 = x => Math.round(x * 100) / 100;
const f2 = x => (x == null ? "-" : r2(x).toFixed(2));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const marketClosed = ms => { const d = new Date(ms), w = d.getUTCDay(), h = d.getUTCHours(); return (w === 5 && h >= 22) || w === 6 || (w === 0 && h < 22); };
const GRADE_RANK = { "A+": 4, "A": 3, "B": 2, "C": 1, "D": 0 };

/* ---------- data quality ---------- */
function sanitize(m1) {
  const q = { rows: m1.length, invalid: 0, duplicates: 0, unsorted: 0, misaligned: 0, issues: [] };
  const rows = m1.slice(); for (let i = 1; i < rows.length; i++) if (rows[i][0] < rows[i - 1][0]) { q.unsorted++; }
  if (q.unsorted) rows.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of rows) {
    const [t, o, h, l, c] = r;
    if (![t, o, h, l, c].every(Number.isFinite) || o <= 0 || h < l || h < Math.max(o, c) - 1e-6 || l > Math.min(o, c) + 1e-6) { q.invalid++; continue; }
    if (t % 60 !== 0) q.misaligned++;
    const last = out[out.length - 1];
    if (last && last[0] === t) { q.duplicates++; last[2] = Math.max(last[2], h); last[3] = Math.min(last[3], l); last[4] = c; continue; }
    out.push(r);
  }
  if (q.invalid) q.issues.push(q.invalid + " invalid OHLC rows dropped");
  if (q.duplicates) q.issues.push(q.duplicates + " duplicate candles merged");
  if (q.unsorted) q.issues.push("timestamps were out of order (sorted)");
  if (q.misaligned) q.issues.push(q.misaligned + " candles not aligned to the minute");
  return { rows: out, q };
}
function dataQuality(rows, q, nowS) {
  const out = Object.assign({}, q), last = rows.length ? rows[rows.length - 1][0] : 0;
  out.lastT = last; out.staleSec = last ? nowS - last : null;
  const from = nowS - 86400; let open = 0, have = 0, gap = 0, maxGap = 0, prev = null;
  for (let t = Math.floor(from / 60) * 60; t < nowS; t += 60) if (!marketClosed(t * 1000)) open++;
  const set = new Set(); for (let i = rows.length - 1; i >= 0 && rows[i][0] >= from; i--) { set.add(rows[i][0]); have++; }
  for (let t = Math.floor(from / 60) * 60; t < nowS; t += 60) { if (marketClosed(t * 1000)) { prev = null; continue; } if (set.has(t)) { if (gap > maxGap) maxGap = gap; gap = 0; } else gap++; }
  if (gap > maxGap) maxGap = gap;
  out.coverage24h = open ? r2(Math.min(1, have / open)) : 1; out.maxGapMin = maxGap;
  if (out.coverage24h < CFG.minCoverage) out.issues.push("low data coverage last 24h (" + Math.round(out.coverage24h * 100) + "%)");
  if (maxGap > 30) out.issues.push("gap of " + maxGap + " min in the last 24h");
  return out;
}

/* ---------- candles ---------- */
function build(m1, sec, cover, nowS) {
  const b = new Map();
  for (const r of m1) {
    const k = Math.floor(r[0] / sec) * sec, x = b.get(k);
    if (!x) b.set(k, { o: r[1], h: r[2], l: r[3], c: r[4], n: 1 });
    else { if (r[2] > x.h) x.h = r[2]; if (r[3] < x.l) x.l = r[3]; x.c = r[4]; x.n++; }
  }
  const cur = Math.floor(nowS / sec) * sec, done = []; let forming = null;
  for (const k of [...b.keys()].sort((a, c) => a - c)) {
    const x = b.get(k);
    if (k < cur) { if (x.n >= cover) done.push([k, x.o, x.h, x.l, x.c]); }
    else if (k === cur) forming = [k, x.o, x.h, x.l, x.c];
  }
  return { done, forming };
}
function atrOf(cs, sec, n) {
  n = n || 14; const t = [];
  for (let i = 1; i < cs.length; i++) {
    const pc = cs[i][0] - cs[i - 1][0] === sec ? cs[i - 1][4] : cs[i][1];
    t.push(Math.max(cs[i][2] - cs[i][3], Math.abs(cs[i][2] - pc), Math.abs(cs[i][3] - pc)));
  }
  const s = t.slice(-n); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
}

/* ---------- structure ---------- */
function zigzag(cs, thr) {
  const sw = []; let dir = 0, hiI = 0, hiP = cs.length ? cs[0][2] : 0, loI = 0, loP = cs.length ? cs[0][3] : 0;
  for (let i = 1; i < cs.length; i++) {
    const h = cs[i][2], l = cs[i][3];
    if (dir === 0) {
      if (h > hiP) { hiP = h; hiI = i; } if (l < loP) { loP = l; loI = i; }
      if (hiP - loP >= thr) { if (loI < hiI) { sw.push({ i: loI, t: cs[loI][0], p: loP, type: "L", conf: i }); dir = 1; } else { sw.push({ i: hiI, t: cs[hiI][0], p: hiP, type: "H", conf: i }); dir = -1; } }
    } else if (dir === 1) {
      if (h > hiP) { hiP = h; hiI = i; }
      else if (hiP - l >= thr) { sw.push({ i: hiI, t: cs[hiI][0], p: hiP, type: "H", conf: i }); dir = -1; loP = l; loI = i; }
    } else {
      if (l < loP) { loP = l; loI = i; }
      else if (h - loP >= thr) { sw.push({ i: loI, t: cs[loI][0], p: loP, type: "L", conf: i }); dir = 1; hiP = h; hiI = i; }
    }
  }
  let pending = null;
  if (dir === 1) pending = { type: "H", i: hiI, t: cs[hiI][0], p: hiP }; else if (dir === -1) pending = { type: "L", i: loI, t: cs[loI][0], p: loP };
  let pH = null, pL = null;
  for (const s of sw) { if (s.type === "H") { s.lab = pH == null ? "" : (s.p > pH ? "HH" : "LH"); pH = s.p; } else { s.lab = pL == null ? "" : (s.p > pL ? "HL" : "LL"); pL = s.p; } }
  return { sw, pending };
}
function trendOf(sw) {
  const H = sw.filter(s => s.type === "H"), L = sw.filter(s => s.type === "L");
  if (H.length < 2 || L.length < 2) return "RANGE";
  const h1 = H[H.length - 1].p, h0 = H[H.length - 2].p, l1 = L[L.length - 1].p, l0 = L[L.length - 2].p;
  if (h1 > h0 && l1 > l0) return "UP"; if (h1 < h0 && l1 < l0) return "DOWN"; return "RANGE";
}
/* Displacement score 0-100: body/range, ATR multiple, consecutive directional candles, distance travelled, structure break */
function dispScore(cs, i, dir, a, broke) {
  const up = dir === "BULL"; let best = null;
  for (let j = Math.max(0, i - 2); j <= i; j++) {
    const c = cs[j], body = Math.abs(c[4] - c[1]), rng = Math.max(1e-9, c[2] - c[3]);
    if (!(up ? c[4] > c[1] : c[4] < c[1])) continue;
    const s = Math.min(1, body / rng / 0.8) * 30 + Math.min(1, body / (a * 1.5)) * 30;
    if (!best || s > best.s) best = { j, s, bodyR: body / rng, x: body / a, body };
  }
  if (!best) return { score: 0, label: "WEAK", ok: false, idx: -1, x: 0, body: 0, bodyRatio: 0, consecutive: 0, distance: 0 };
  let cons = 0; for (let j = i; j >= Math.max(0, i - 3); j--) { if (up ? cs[j][4] > cs[j][1] : cs[j][4] < cs[j][1]) cons++; else break; }
  const ref = i >= 3 ? cs[i - 3][1] : cs[0][1], dist = up ? cs[i][4] - ref : ref - cs[i][4];
  const score = Math.round(Math.min(100, best.s + Math.min(cons, 3) / 3 * 15 + clamp(dist / (a * 2.5), 0, 1) * 15 + (broke ? 10 : 0)));
  return { score, label: score >= CFG.disp.strong ? "STRONG" : score >= CFG.disp.ok ? "OK" : "WEAK", ok: score >= CFG.disp.ok, idx: best.j, x: r2(best.x), body: r2(best.body), bodyRatio: r2(best.bodyR), consecutive: cons, distance: r2(dist) };
}
/* BOS / CHoCH on closed candles only. valid = close beyond a meaningful swing with enough displacement; weak = beyond but weak displacement.
   Wick-only breaks (close back inside) are returned separately in `fb` as false breaks. */
function events(cs, zz, a, fb) {
  const sw = zz.sw, ev = [], broken = new Set(), buf = CFG.bos.buf * a;
  for (let i = 0; i < cs.length; i++) {
    const known = sw.filter(s => s.conf <= i); if (known.length < 2) continue;
    const tr = trendOf(known), c = cs[i][4], hi = cs[i][2], lo = cs[i][3];
    const lastH = [...known].reverse().find(s => s.type === "H" && !broken.has(s.i));
    const lastL = [...known].reverse().find(s => s.type === "L" && !broken.has(s.i));
    if (lastH && c > lastH.p + buf) {
      known.forEach(s => { if (s.type === "H" && s.p < c - buf) broken.add(s.i); });
      const d = dispScore(cs, i, "BULL", a, true);
      ev.push({ kind: tr === "DOWN" ? "CHoCH" : "BOS", dir: "BULL", level: r2(lastH.p), levelT: lastH.t, idx: i, t: cs[i][0], trendBefore: tr, disp: d, valid: d.score >= CFG.bos.validDisp, weak: d.score < CFG.bos.validDisp, confirmed: true });
    } else if (lastH && fb && hi > lastH.p + buf) fb.push({ dir: "BULL", level: r2(lastH.p), idx: i, t: cs[i][0], type: "WICK_ONLY" });
    if (lastL && c < lastL.p - buf) {
      known.forEach(s => { if (s.type === "L" && s.p > c + buf) broken.add(s.i); });
      const d = dispScore(cs, i, "BEAR", a, true);
      ev.push({ kind: tr === "UP" ? "CHoCH" : "BOS", dir: "BEAR", level: r2(lastL.p), levelT: lastL.t, idx: i, t: cs[i][0], trendBefore: tr, disp: d, valid: d.score >= CFG.bos.validDisp, weak: d.score < CFG.bos.validDisp, confirmed: true });
    } else if (lastL && fb && lo < lastL.p - buf) fb.push({ dir: "BEAR", level: r2(lastL.p), idx: i, t: cs[i][0], type: "WICK_ONLY" });
  }
  const tol = 0.25 * a;
  for (const e of ev) {
    e.retest = "PENDING";
    for (let k = e.idx + 1; k < cs.length; k++) {
      if (e.dir === "BULL") { if (cs[k][4] < e.level - tol) { e.retest = "FAILED"; break; } if (cs[k][3] <= e.level + tol) { e.retest = "DONE"; break; } }
      else { if (cs[k][4] > e.level + tol) { e.retest = "FAILED"; break; } if (cs[k][2] >= e.level - tol) { e.retest = "DONE"; break; } }
    }
  }
  return ev;
}
function fvgs(cs, a, tf, sec) {
  const out = [], min = CFG.fvg.minATR * a;
  for (let j = 1; j < cs.length - 1; j++) {
    let z = null;
    if (cs[j + 1][3] - cs[j - 1][2] >= min) z = { dir: "BULL", lo: cs[j - 1][2], hi: cs[j + 1][3] };
    else if (cs[j - 1][3] - cs[j + 1][2] >= min) z = { dir: "BEAR", lo: cs[j + 1][2], hi: cs[j - 1][3] };
    if (!z) continue;
    z.state = "unfilled";
    for (let k = j + 2; k < cs.length; k++) {
      if (z.dir === "BULL") { if (cs[k][3] <= z.lo) { z.state = "filled"; break; } if (cs[k][3] <= z.hi) z.state = "partial"; }
      else { if (cs[k][2] >= z.hi) { z.state = "filled"; break; } if (cs[k][2] >= z.lo) z.state = "partial"; }
    }
    const d = dispScore(cs, j, z.dir, a, false);
    Object.assign(z, { type: z.dir === "BULL" ? "BULLISH_FVG" : "BEARISH_FVG", tf, t: cs[j][0], idx: j, lo: r2(z.lo), hi: r2(z.hi), top: r2(z.hi), bottom: r2(z.lo), midpoint: r2((z.lo + z.hi) / 2), filled: z.state === "filled",
      ageCandles: cs.length - 1 - j, ageSec: (cs.length - 1 - j) * sec, dispScore: d.score, direction: z.dir === "BULL" ? "BULLISH" : "BEARISH" });
    out.push(z);
  }
  return out;
}
function orderBlocks(cs, evs, a, tf) {
  const out = [];
  for (const e of evs) {
    if (!e.valid) continue;
    const j = e.disp.idx; let ob = -1;
    for (let k = j; k >= Math.max(0, j - 6); k--) { if (e.dir === "BULL" ? cs[k][4] < cs[k][1] : cs[k][4] > cs[k][1]) { ob = k; break; } }
    if (ob < 0) continue;
    const z = { tf, type: e.dir === "BULL" ? "BULLISH_OB" : "BEARISH_OB", side: e.dir === "BULL" ? "DEMAND" : "SUPPLY", lo: r2(cs[ob][3]), hi: r2(cs[ob][2]), high: r2(cs[ob][2]), low: r2(cs[ob][3]), t: cs[ob][0], idx: ob, evKind: e.kind, evT: e.t, evDisp: e.disp.score, state: "fresh", mitigated: false, ageCandles: cs.length - 1 - ob };
    for (let k = ob + 1; k < cs.length; k++) {
      if (z.side === "DEMAND") { if (cs[k][4] < z.lo - 0.1 * a) { z.state = "mitigated"; z.mitigated = true; break; } if (k > j && cs[k][3] <= z.hi) z.state = "tested"; }
      else { if (cs[k][4] > z.hi + 0.1 * a) { z.state = "mitigated"; z.mitigated = true; break; } if (k > j && cs[k][2] >= z.lo) z.state = "tested"; }
    }
    out.push(z);
  }
  return out;
}
function tfAnalysis(m1, tf, nowS) {
  const sec = SEC[tf], b = build(m1, sec, COVER[tf], nowS), cs = b.done, a = atrOf(cs, sec);
  const zz = zigzag(cs, K[tf] * a), fb = [], ev = events(cs, zz, a, fb);
  const T = { tf, sec, cs, forming: b.forming, atr: a, zz, sw: zz.sw, pending: zz.pending, trend: trendOf(zz.sw), events: ev, falseBreaks: fb, fvg: fvgs(cs, a, tf, sec), obs: orderBlocks(cs, ev, a, tf), ready: cs.length >= NEED[tf], have: cs.length, need: NEED[tf] };
  if (KI[tf]) { const zi = zigzag(cs, KI[tf] * a), ifb = []; T.isw = zi.sw; T.ievents = events(cs, zi, a, ifb); T.ifalse = ifb; T.iobs = orderBlocks(cs, T.ievents, a, tf); T.itrend = trendOf(zi.sw); }
  return T;
}

/* ---------- liquidity ---------- */
const SESS = [{ name: "asia", ar: "آسيا", en: "Asian", tz: "Asia/Tokyo", s: 9, e: 18 }, { name: "london", ar: "لندن", en: "London", tz: "Europe/London", s: 8, e: 17 }, { name: "ny", ar: "نيويورك", en: "New York", tz: "America/New_York", s: 8, e: 17 }];
const fmtC = {};
function localHour(tz, t) { let f = fmtC[tz]; if (!f) f = fmtC[tz] = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "numeric", hour12: false }); const v = parseInt(f.format(new Date(t * 1000)), 10); return v === 24 ? 0 : v; }
function sessionRuns(c5) {
  const out = {};
  for (const S of SESS) {
    let run = null, last = null;
    for (const c of c5) {
      const h = localHour(S.tz, c[0]), inS = h >= S.s && h < S.e;
      if (inS) { if (!run) run = { from: c[0], hi: c[2], lo: c[3], last: c[0] }; else { run.hi = Math.max(run.hi, c[2]); run.lo = Math.min(run.lo, c[3]); run.last = c[0]; } }
      else if (run) { last = run; run = null; }
    }
    out[S.name] = { cur: run, prev: last, ar: S.ar, en: S.en };
  }
  return out;
}
function fractals(cs, n) {
  const H = [], L = [];
  for (let i = n; i < cs.length - n; i++) {
    let hh = true, ll = true;
    for (let j = 1; j <= n; j++) { if (!(cs[i][2] > cs[i - j][2] && cs[i][2] > cs[i + j][2])) hh = false; if (!(cs[i][3] < cs[i - j][3] && cs[i][3] < cs[i + j][3])) ll = false; }
    if (hh) H.push({ i, t: cs[i][0], p: cs[i][2] }); if (ll) L.push({ i, t: cs[i][0], p: cs[i][3] });
  }
  return { H, L };
}
const EXTERNAL = { PDH: 1, PDL: 1, CDH: 1, CDL: 1, MAJH: 1, MAJL: 1 };
function buildPools(m1, T5, T15, T1, nowS) {
  const pools = [], add = (kind, label, price, side, t, live) => pools.push({ key: kind + ":" + f2(price), kind, label, price: r2(price), side, t, live: !!live, swept: false, scope: (EXTERNAL[kind] || /^S[HL]_/.test(kind)) ? "external" : "internal", major: kind === "PDH" || kind === "PDL" || kind === "MAJH" || kind === "MAJL" });
  const day0 = Math.floor(nowS / 86400) * 86400, pd0 = day0 - 86400;
  const today = m1.filter(r => r[0] >= day0), prev = m1.filter(r => r[0] >= pd0 && r[0] < day0);
  const pdOk = prev.length >= 600;
  if (pdOk) { add("PDH", "Previous Day High", Math.max(...prev.map(r => r[2])), "BSL", pd0); add("PDL", "Previous Day Low", Math.min(...prev.map(r => r[3])), "SSL", pd0); }
  if (today.length >= 5) { add("CDH", "Current Day High", Math.max(...today.map(r => r[2])), "BSL", day0, true); add("CDL", "Current Day Low", Math.min(...today.map(r => r[3])), "SSL", day0, true); }
  const runs = sessionRuns(T5.cs.slice(-480)); const sess = {};
  for (const S of SESS) {
    const R = runs[S.name]; sess[S.name] = { ar: S.ar, en: S.en, cur: R.cur ? { hi: r2(R.cur.hi), lo: r2(R.cur.lo), from: R.cur.from } : null, prev: R.prev ? { hi: r2(R.prev.hi), lo: r2(R.prev.lo), from: R.prev.from } : null };
    if (R.cur) { add("SH_" + S.name, S.ar + " Session High (live)", R.cur.hi, "BSL", R.cur.from, true); add("SL_" + S.name, S.ar + " Session Low (live)", R.cur.lo, "SSL", R.cur.from, true); }
    if (R.prev) { add("SH_" + S.name, "Previous " + S.en + " Session High", R.prev.hi, "BSL", R.prev.from); add("SL_" + S.name, "Previous " + S.en + " Session Low", R.prev.lo, "SSL", R.prev.from); }
  }
  if (T15.cs.length >= 10) {
    const a = T15.atr, tol = Math.max(0.6, 0.12 * a), fr = fractals(T15.cs.slice(-120), 2);
    const clus = (arr, side, kind, label) => {
      const used = new Set();
      for (let x = 0; x < arr.length; x++) {
        if (used.has(x)) continue; const g = [arr[x]];
        for (let y = x + 1; y < arr.length; y++) if (!used.has(y) && Math.abs(arr[y].p - arr[x].p) <= tol) { g.push(arr[y]); used.add(y); }
        if (g.length >= 2) { const p = side === "BSL" ? Math.max(...g.map(q => q.p)) : Math.min(...g.map(q => q.p)); add(kind, label, p, side, Math.max(...g.map(q => q.t))); }
      }
    };
    clus(fr.H, "BSL", "EQH", "Equal Highs"); clus(fr.L, "SSL", "EQL", "Equal Lows");
    T15.sw.slice(-8).forEach(s => add("SW15" + s.type, "M15 Swing " + (s.type === "H" ? "High" : "Low"), s.p, s.type === "H" ? "BSL" : "SSL", s.t));
  }
  if (T1.sw.length) { const H = T1.sw.filter(s => s.type === "H").pop(), L = T1.sw.filter(s => s.type === "L").pop(); if (H) add("MAJH", "Major Swing High (H1)", H.p, "BSL", H.t); if (L) add("MAJL", "Major Swing Low (H1)", L.p, "SSL", L.t); }
  const seen = new Map(); for (const p of pools) { const k = p.side + ":" + Math.round(p.price * 2); const q = seen.get(k); if (!q || (q.live && !p.live)) seen.set(k, p); else if (q.kind !== p.kind) { q.label += " + " + p.label; if (p.scope === "external") q.scope = "external"; if (p.major) q.major = true; } }
  const list = [...seen.values()];
  for (const p of list) {
    if (p.live) continue; const cs = T5.cs;
    for (let i = 0; i < cs.length; i++) { if (cs[i][0] <= p.t) continue; if ((p.side === "BSL" && cs[i][2] > p.price + 0.1) || (p.side === "SSL" && cs[i][3] < p.price - 0.1)) { p.swept = true; p.sweptAt = cs[i][0]; break; } }
  }
  return { pools: list, sessions: sess, pdAvailable: pdOk };
}
/* Liquidity sweep: a wick penetrates an untouched pool by a minimum distance, price closes back inside within a few candles,
   with rejection (wick ratio). Displacement afterwards raises the quality. All thresholds are configurable (CFG.sweep). */
function findSweeps(pools, Ts) {
  const out = [], S = CFG.sweep;
  for (const T of Ts) {
    const cs = T.cs, from = Math.max(0, cs.length - S.lookback[T.tf]), minPen = Math.max(S.minPenAbs, S.minPenATR * T.atr);
    for (const p of pools) {
      if (p.live) continue;
      let first = -1;
      for (let i = 0; i < cs.length; i++) { if (cs[i][0] <= p.t) continue; if ((p.side === "BSL" && cs[i][2] > p.price + minPen) || (p.side === "SSL" && cs[i][3] < p.price - minPen)) { first = i; break; } }
      if (first < 0) continue;
      let rec = -1, ext = p.side === "BSL" ? -1e9 : 1e9, extK = first;
      for (let k = first; k <= Math.min(first + S.reclaim, cs.length - 1); k++) {
        if (p.side === "BSL" ? cs[k][2] > ext : cs[k][3] < ext) { ext = p.side === "BSL" ? cs[k][2] : cs[k][3]; extK = k; }
        if ((p.side === "BSL" && cs[k][4] < p.price) || (p.side === "SSL" && cs[k][4] > p.price)) { rec = k; break; }
      }
      if (rec < from || rec < 0) continue;
      const c = cs[extK], rng = Math.max(1e-9, c[2] - c[3]), wick = p.side === "BSL" ? (c[2] - Math.max(c[1], c[4])) : (Math.min(c[1], c[4]) - c[3]), wickRatio = clamp(wick / rng, 0, 1);
      const pen = Math.abs(ext - p.price), closeBack = Math.abs(p.price - cs[rec][4]);
      let dAfter = 0; for (let k = rec; k <= Math.min(rec + 4, cs.length - 1); k++) dAfter = Math.max(dAfter, dispScore(cs, k, p.side === "BSL" ? "BEAR" : "BULL", T.atr, false).score);
      const quality = Math.round(clamp(pen / (0.5 * T.atr), 0, 1) * 25 + clamp(wickRatio / 0.6, 0, 1) * 25 + clamp(closeBack / (0.4 * T.atr), 0, 1) * 20 + dAfter * 0.3);
      const confirmed = pen >= minPen && wickRatio >= S.rejectWick && (!S.requireDispAfter || dAfter >= S.dispAfterMin);
      out.push({ pool: p.key, label: p.label, side: p.side, price: p.price, tf: T.tf, t: cs[rec][0], pierceT: cs[first][0], idx: rec, extreme: ext, close: cs[rec][4], penetration: r2(pen), wickRatio: r2(wickRatio), dispAfter: dAfter, quality, confirmed, scope: p.scope });
    }
  }
  return out.sort((x, y) => y.t - x.t);
}

/* ---------- quality scoring for zones ---------- */
function enrichZones(T, ctx) {
  const { bias, pd, sweeps, price } = ctx, near = (t, w) => sweeps.some(s => s.confirmed && s.t <= t + 1 && t - s.t <= w);
  const w = 12 * T.sec;
  for (const g of T.fvg) {
    const bull = g.dir === "BULL"; let q = 20 + (g.dispScore >= CFG.disp.ok ? 25 : g.dispScore >= 25 ? 10 : 0);
    if (near(g.t, w)) q += 20;
    if (T.events.concat(T.ievents || []).some(e => e.dir === g.dir && e.valid && e.t >= g.t - T.sec && e.t <= g.t + 3 * T.sec)) q += 15;
    if ((bull && bias === "BULLISH") || (!bull && bias === "BEARISH")) q += 10;
    if (pd && ((bull && pd.pos < CFG.pd.discountBelow) || (!bull && pd.pos > CFG.pd.premiumAbove))) q += 10;
    g.quality = Math.min(100, q); g.distance = price == null ? null : r2(price >= g.lo && price <= g.hi ? 0 : Math.min(Math.abs(price - g.lo), Math.abs(price - g.hi)));
  }
  for (const z of (T.obs || []).concat(T.iobs || [])) {
    const bull = z.side === "DEMAND"; let q = 20 + (z.evDisp >= CFG.disp.ok ? 25 : 10) + 20;   // preceded displacement + caused BOS/CHoCH
    if (near(z.t, 12 * T.sec)) q += 15;
    if (z.state === "fresh") q += 10; else if (z.state === "tested") q += 4;
    if ((bull && bias === "BULLISH") || (!bull && bias === "BEARISH")) q += 10;
    z.quality = Math.min(100, q); z.freshness = z.state; z.distance = price == null ? null : r2(price >= z.lo && price <= z.hi ? 0 : Math.min(Math.abs(price - z.lo), Math.abs(price - z.hi)));
  }
}

/* ---------- bias / regime / session / news ---------- */
function h1Bias(T1, pools, price) {
  const why = [], tr = T1.trend, hh = T1.sw.filter(s => s.type === "H").slice(-2), ll = T1.sw.filter(s => s.type === "L").slice(-2);
  let bias = tr === "UP" ? "BULLISH" : tr === "DOWN" ? "BEARISH" : "NEUTRAL";
  const lastEv = T1.events[T1.events.length - 1];
  if (hh.length === 2 && ll.length === 2) why.push("H1 swings: highs " + f2(hh[0].p) + "→" + f2(hh[1].p) + " (" + (hh[1].lab || "-") + "), lows " + f2(ll[0].p) + "→" + f2(ll[1].p) + " (" + (ll[1].lab || "-") + ")");
  if (lastEv) why.push("Last H1 " + lastEv.kind + " " + (lastEv.dir === "BULL" ? "bullish" : "bearish") + " @ " + f2(lastEv.level) + " (" + lastEv.disp.label + " displacement)");
  if (lastEv && lastEv.kind === "CHoCH" && T1.cs.length - 1 - lastEv.idx <= 12 && ((lastEv.dir === "BULL" && bias !== "BULLISH") || (lastEv.dir === "BEAR" && bias !== "BEARISH"))) { bias = "NEUTRAL"; why.push("Recent H1 CHoCH against the old trend: reversal not yet confirmed by a BOS, so the bias is NEUTRAL."); }
  let conf = 0;
  if (bias !== "NEUTRAL") {
    const bull = bias === "BULLISH"; conf = 35;
    if (lastEv && lastEv.dir === (bull ? "BULL" : "BEAR")) { conf += lastEv.valid ? 15 : 5; if (T1.cs.length - 1 - lastEv.idx <= 24) conf += 5; if (lastEv.disp.score >= CFG.disp.strong) { conf += 10; why.push((bull ? "Bullish" : "Bearish") + " displacement on the last H1 break"); } }
    if (hh.length === 2 && ll.length === 2 && hh[1].p !== hh[0].p && ll[1].p !== ll[0].p) { conf += 15; why.push(bull ? "Higher highs and higher lows" : "Lower highs and lower lows"); }
    const swept = pools.filter(p => p.side === (bull ? "SSL" : "BSL") && p.swept && p.sweptAt && T1.cs.length && T1.cs[T1.cs.length - 1][0] - p.sweptAt <= 48 * 3600 && (p.scope === "external" || p.major));
    if (swept.length) { conf += 10; why.push((bull ? "Sell-side" : "Buy-side") + " liquidity swept (" + swept[0].label + ")"); }
    const pdh = pools.find(p => p.kind === "PDH"), pdl = pools.find(p => p.kind === "PDL");
    if (bull && pdl && price > pdl.price) conf += 5; if (!bull && pdh && price < pdh.price) conf += 5;
  }
  conf = Math.round(clamp(conf, 0, 100));
  return { bias, confidence: conf, trend: tr, why, lastEvent: lastEv ? { kind: lastEv.kind, dir: lastEv.dir, level: lastEv.level, t: lastEv.t, valid: lastEv.valid } : null };
}
function newsState(news, nowS) {
  const N = CFG.news;
  if (!news || !news.ok || !news.events) return { available: false, risk: "UNKNOWN", active: false, event: null, upcomingEvent: null, post: null, window: { active: false, event: null } };
  const hi = news.events.filter(e => e.impact === "High").sort((a, b) => a.t - b.t), md = news.events.filter(e => e.impact === "Medium");
  const before = hi.find(e => e.t - nowS > 0 && e.t - nowS <= N.beforeMin * 60), during = hi.find(e => nowS - e.t >= 0 && nowS - e.t <= N.afterMin * 60);
  const post = hi.slice().reverse().find(e => nowS - e.t > N.afterMin * 60 && nowS - e.t <= N.postMin * 60) || null;
  const medNear = md.find(e => Math.abs(e.t - nowS) <= 15 * 60), soon = hi.find(e => e.t - nowS > N.beforeMin * 60 && e.t - nowS <= 60 * 60);
  const act = before || during, nxt = hi.find(e => e.t - nowS > -N.afterMin * 60) || md.find(e => e.t - nowS > 0) || null;
  const up = nxt ? { title: nxt.title, t: nxt.t, impact: nxt.impact, minsTo: Math.round((nxt.t - nowS) / 60) } : null;
  const risk = act ? "HIGH" : (medNear || soon || post) ? "MEDIUM" : "LOW";
  return { available: true, risk, active: !!act, event: act || null, upcomingEvent: up, post, window: { active: !!act, event: act || null, minsTo: act ? Math.round((act.t - nowS) / 60) : null } };
}
function newsWindow(news, nowS) { return newsState(news, nowS).window; }
function newsInfo(e) {
  const t = (e.title || "").toLowerCase(); const inv = /unemployment|jobless|claims/.test(t);
  if (/fomc|powell|fed |federal funds|interest rate|rate decision|speaks|testifies/.test(t))
    return { effect: "Volatility spike; direction depends on tone. IF hawkish THEN gold tends to fall; IF dovish THEN gold tends to rise.", advice: "Avoid opening a scalp from 30 min before until 15 min after." };
  if (/cpi|ppi|pce|non-farm|nfp|employment|payroll|retail sales|gdp|ism|durable|consumer|sentiment|housing|trade balance/.test(t))
    return { effect: inv ? "IF actual is above forecast THEN USD weakens and gold tends to rise; IF below THEN gold tends to fall." : "IF actual is above forecast THEN USD and yields rise and gold tends to fall; IF below THEN gold tends to rise.", advice: e.impact === "High" ? "Avoid opening a scalp immediately before release; expect a volatility spike." : "Trade with caution around the release." };
  return { effect: "Effect on gold depends on the surprise versus forecast.", advice: e.impact === "High" ? "Avoid opening a scalp immediately before release." : "Trade with caution." };
}
function macroMod(side, macro) {
  const out = { pts: 0, notes: [], available: !!macro };
  if (!macro) return out;
  const buy = side === "BUY";
  [["dxy", "DXY"], ["yield", "Treasury yields"]].forEach(([k, name]) => {
    const e = macro[k]; if (!e || e === "flat") return;        // e = effect on gold: "up" supports gold, "down" pressures gold
    const agree = (buy && e === "up") || (!buy && e === "down");
    out.pts += agree ? 3 : -4; out.notes.push(name + (agree ? " confirms " : " opposes ") + side);
  });
  return out;
}
function regimeOf(T1, T15, newsSt) {
  const tr = []; for (let i = Math.max(1, T15.cs.length - 288); i < T15.cs.length; i++) { const c = T15.cs[i], pc = T15.cs[i - 1][4]; tr.push(Math.max(c[2] - c[3], Math.abs(c[2] - pc), Math.abs(c[3] - pc))); }
  const med = tr.length ? tr.slice().sort((a, b) => a - b)[Math.floor(tr.length / 2)] : 0, ratio = med > 0 ? T15.atr / (med * 1.25) : 1;
  let primary = "TRENDING"; const flags = [];
  if (newsSt.risk === "HIGH") { primary = "NEWS_MODE"; flags.push("NEWS_MODE"); }
  if (ratio >= CFG.regime.highVol) { if (primary === "TRENDING") primary = "HIGH_VOLATILITY"; flags.push("HIGH_VOLATILITY"); }
  else if (ratio <= CFG.regime.lowVol) { if (primary === "TRENDING") primary = "LOW_VOLATILITY"; flags.push("LOW_VOLATILITY"); }
  if (T1.trend === "RANGE" && T15.trend === "RANGE") { if (primary === "TRENDING") primary = "RANGING"; flags.push("RANGING"); } else flags.push("TRENDING");
  return { primary, flags, volRatio: r2(ratio) };
}
function sessionInfo(nowS, sess, closed) {
  if (closed) return { name: "Market closed", active: [], focus: [] };
  const act = SESS.filter(S => { const h = localHour(S.tz, nowS); return h >= S.s && h < S.e; }).map(S => S.name);
  const name = act.includes("london") && act.includes("ny") ? "London/NY Overlap" : act.includes("ny") ? "New York" : act.includes("london") ? "London" : act.includes("asia") ? "Asian" : "Off-session";
  const pick = n => { const s = sess[n]; return s && (s.cur || s.prev) ? { en: s.en, hi: (s.cur || s.prev).hi, lo: (s.cur || s.prev).lo } : null; };
  const focusSrc = name === "New York" || name === "London/NY Overlap" ? ["london", "asia"] : name === "London" ? ["asia"] : name === "Asian" ? ["ny"] : ["asia", "london"];
  const focus = focusSrc.map(pick).filter(Boolean).map(s => s.en + " High " + f2(s.hi) + " / Low " + f2(s.lo));
  return { name, active: act, focus };
}

function macroFromDrivers(dr) {
  if (!dr || !dr.length) return null;
  const pick = re => { const d = dr.find(x => re.test(x.n || "")); return d && /^(up|down|flat)$/.test(d.s) ? d.s : null; };
  const dxy = pick(/DXY|الدولار/i), yl = pick(/^عائد السندات|Treasury/i);
  return dxy || yl ? { dxy, yield: yl } : null;   // effect on gold: up = supportive, down = pressuring
}

/* ---------- scenarios ---------- */
function gradeOf(conf) { const G = CFG.grades; return conf >= G.aplus ? "A+" : conf >= G.a ? "A" : conf >= G.b ? "B" : conf >= G.c ? "C" : "D"; }
const f = (q) => 0.6 + 0.4 * clamp(q / 100, 0, 1);   // a satisfied component earns at least 60% of its weight; quality earns the rest
function evalSide(side, C) {
  const { T5, T15, T1, pools, sweeps, price, bias, biasConf, pd, newsSt, nowS, fresh, regime, macro, dq } = C;
  const W = CFG.weights, buy = side === "BUY", dirEv = buy ? "BULL" : "BEAR", a5 = T5.atr, a15 = T15.atr;
  const R = { side, items: [], breakdown: [], modifiers: [], reasons: [], ifThen: [], warnings: [] };
  const aligned = (buy && bias === "BULLISH") || (!buy && bias === "BEARISH");
  // 1) zone (supply for SELL / demand for BUY), H1 first, higher quality preferred
  const want = buy ? "DEMAND" : "SUPPLY"; let zone = null;
  const cands = [].concat(T1.obs, T15.obs).filter(z => z.side === want && z.state !== "mitigated");
  const mySweeps = sweeps.filter(s => s.confirmed && s.side === (buy ? "SSL" : "BSL") && nowS - s.t <= 3 * 3600);
  for (const z of cands) {
    const inside = price >= z.lo && price <= z.hi, dist = buy ? price - z.hi : z.lo - price;
    const sw = mySweeps.find(s => buy ? (s.extreme <= z.hi + 0.5 * a15 && s.extreme >= z.lo - 1.2 * a15) : (s.extreme >= z.lo - 0.5 * a15 && s.extreme <= z.hi + 1.2 * a15));
    let st = null; if (sw) st = "SWEPT"; else if (inside) st = "IN_ZONE"; else if (dist > 0 && dist <= 1.5 * a15) st = "APPROACH";
    if (!st) continue;
    const score = (st === "SWEPT" ? 0 : st === "IN_ZONE" ? 1 : 2) * 10 + (z.tf === "H1" ? 0 : 5) + Math.max(0, dist) / 100 - (z.quality || 0) / 100;
    if (!zone || score < zone.score) zone = Object.assign({}, z, { zst: st, score, sweep: sw || null });
  }
  const sweep = zone ? (zone.sweep || null) : null;
  R.zone = zone ? { tf: zone.tf, side: zone.side, lo: zone.lo, hi: zone.hi, state: zone.zst, t: zone.t, quality: zone.quality } : null; R.sweep = sweep;
  // 2) structure shifts after the sweep: M15 (setup) and M5 (confirmation)
  const sweepM15Open = sweep ? Math.floor(sweep.t / 900) * 900 : 0;
  const m15ev = sweep ? T15.ievents.find(e => e.dir === dirEv && e.t >= sweepM15Open) : null;
  const m5ev = sweep ? T5.ievents.find(e => e.dir === dirEv && e.t >= sweep.t) : null;
  const m15Valid = !!(m15ev && m15ev.valid), m5Valid = !!(m5ev && m5ev.valid);
  const fbAll = [].concat((T5.ifalse || []).map(x => Object.assign({ tf: "M5" }, x)), (T15.ifalse || []).map(x => Object.assign({ tf: "M15" }, x)));
  const falseBreak = sweep ? fbAll.filter(x => x.dir === dirEv && x.t >= sweep.t).slice(-1)[0] || null : null;
  const weakBreak = !!((m15ev && m15ev.weak) || (m5ev && m5ev.weak));
  const dispBest = Math.max(m15ev ? m15ev.disp.score : 0, m5ev ? m5ev.disp.score : 0, sweep ? sweep.dispAfter : 0);
  // 3) entry zone: best FVG/OB (by quality) created after the sweep, else the broken level band
  let ez = null, parts = [], ezQ = 0;
  const shiftEv = m15ev || m5ev;
  if (shiftEv) {
    const t0 = sweep.t - 2 * 900, cand = [];
    [T15, T5].forEach(T => { T.fvg.filter(g => g.dir === dirEv && g.state !== "filled" && g.t >= t0).forEach(g => cand.push({ kind: "FVG", lo: g.lo, hi: g.hi, q: g.quality || 0, tf: T.tf, mid: g.midpoint }));
      (T.tf === "M5" ? T5.iobs : T15.obs).filter(o => o.side === want && !o.mitigated && o.t >= t0 - 900).forEach(o => cand.push({ kind: "OB", lo: o.lo, hi: o.hi, q: o.quality || 0, tf: T.tf })); });
    cand.sort((x, y) => y.q - x.q);
    const best = cand[0];
    if (best && best.q >= CFG.zoneQualityMin) {
      ez = { lo: best.lo, hi: best.hi }; parts = [best.tf + " " + best.kind]; ezQ = best.q;
      const o2 = cand.find(c => c !== best && c.kind !== best.kind && Math.max(c.lo, best.lo) < Math.min(c.hi, best.hi));
      if (o2) { ez = { lo: Math.min(best.lo, o2.lo), hi: Math.max(best.hi, o2.hi) }; parts.push(o2.tf + " " + o2.kind); ezQ = Math.min(100, Math.max(best.q, o2.q) + 5); }
    } else { ez = { lo: shiftEv.level - 0.25 * a5, hi: shiftEv.level + 0.25 * a5 }; parts = ["Broken level " + f2(shiftEv.level)]; ezQ = 20; }
    const cap = 2 * a5, minW = 0.4 * a5;
    if (ez.hi - ez.lo > cap) { if (buy) ez.lo = ez.hi - cap; else ez.hi = ez.lo + cap; }
    if (ez.hi - ez.lo < minW) { const m = (ez.hi + ez.lo) / 2; ez.lo = m - minW / 2; ez.hi = m + minW / 2; }
    const mid = (ez.lo + ez.hi) / 2;
    ez = { lo: r2(ez.lo), hi: r2(ez.hi), mid: r2(mid), preferred: r2(mid), aggressive: r2(buy ? ez.hi : ez.lo), conservative: r2(buy ? ez.lo : ez.hi), parts, quality: ezQ };
  }
  // 4) retest + rejection on closed M5 candles (confirmed) after the structure shift; the forming candle is only informational
  const buf = Math.max(CFG.sl.bufMin, CFG.sl.bufATR5 * a5) * (regime.primary === "HIGH_VOLATILITY" ? CFG.sl.highVolMult : 1);
  const slLevel = sweep ? (buy ? Math.min(sweep.extreme, ez ? ez.lo : sweep.extreme) - buf : Math.max(sweep.extreme, ez ? ez.hi : sweep.extreme) + buf) : null;
  let touched = false, rej = null, invalid = null; const evT = shiftEv ? Math.max(m15ev ? m15ev.t + 600 : 0, m5ev ? m5ev.t : 0) : 0;
  if (ez && shiftEv) {
    const cs = T5.cs;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i]; if (c[0] <= evT) continue;
      if (slLevel != null && (buy ? c[4] < slLevel : c[4] > slLevel)) { invalid = c[0]; break; }
      const overlap = c[2] >= ez.lo - 0.1 * a5 && c[3] <= ez.hi + 0.1 * a5; if (overlap) touched = true;
      if (overlap && (buy ? (c[4] > c[1] && c[4] > ez.mid) : (c[4] < c[1] && c[4] < ez.mid)) && i >= cs.length - 3) rej = { idx: i, t: c[0], close: c[4] };
    }
    if (!invalid && slLevel != null) for (const c of T15.cs) { if (c[0] < sweepM15Open + 900) continue; if (buy ? c[4] < slLevel : c[4] > slLevel) { invalid = c[0]; break; } }
  }
  const formingNow = T5.forming && ez ? { touchingZone: T5.forming[2] >= ez.lo - 0.1 * a5 && T5.forming[3] <= ez.hi + 0.1 * a5, o: T5.forming[1], h: T5.forming[2], l: T5.forming[3], c: T5.forming[4] } : null;
  // 5) plan: entry, SL, liquidity targets (TP1 nearest internal, TP2 external, TP3 major HTF), RR
  let plan = null;
  if (ez && slLevel != null) {
    const entry = rej ? rej.close : ez.preferred, risk = Math.abs(entry - slLevel);
    if (risk > 0.2) {
      const dist = p => Math.abs(p.price - entry), ahead = p => buy ? p.side === "BSL" && p.price > entry + 0.5 * risk : p.side === "SSL" && p.price < entry - 0.5 * risk;
      const avail = pools.filter(p => !p.swept && ahead(p)).sort((x, y) => dist(x) - dist(y));
      const used = []; const take = p => { if (!p || used.some(u => Math.abs(u - p.price) < 0.5 * a5)) return null; used.push(p.price); return { price: p.price, src: p.label, scope: p.scope, kind: p.kind }; };
      const tp1 = take(avail.find(p => p.scope === "internal" && !p.live) || avail.find(p => !p.live) || avail[0]);
      const far = x => !tp1 || dist(x) > Math.abs(tp1.price - entry) + 0.3 * a5;
      const tp2 = take(avail.find(p => p.scope === "external" && far(p)) || avail.find(far));
      const far2 = x => !tp2 || dist(x) > Math.abs(tp2.price - entry) + 0.3 * a5;
      const tp3 = take(avail.find(p => p.major && far2(p)) || avail.filter(far2).slice(-1)[0]);
      const tps = [tp1, tp2, tp3].filter(Boolean); const real = tps.length;
      tps.sort((x, y) => dist(x) - dist(y));
      while (tps.length < 3) { const last = tps.length ? Math.abs(tps[tps.length - 1].price - entry) : 0, d = Math.max(last + risk, (tps.length + 1) * risk); tps.push({ price: entry + (buy ? 1 : -1) * d, src: r2(d / risk) + "R (no further liquidity)", synthetic: true }); }
      tps.forEach(t => { t.price = r2(t.price); t.rr = r2(Math.abs(t.price - entry) / risk); });
      const mainTp = (tps[1] && !tps[1].synthetic) ? tps[1] : (tps[0] && !tps[0].synthetic ? tps[0] : null);
      plan = { entry: r2(entry), entryIsRejectionClose: !!rej, sl: r2(slLevel), risk: r2(risk), tps, realTargets: real, rr: mainTp ? mainTp.rr : 0, rr1: tps[0].rr, rr2: tps[1].rr, rr3: tps[2].rr, noTarget: real === 0, slBuffer: r2(buf) };
    }
  }
  const rrOk = !!(plan && !plan.noTarget && plan.rr >= CFG.minRR && plan.risk <= CFG.risk.maxATR15 * a15 && plan.risk >= CFG.risk.minAbs);
  const pdPos = pd ? pd.pos : null;
  const pdOk = pdPos == null ? true : (buy ? pdPos <= CFG.pd.blockBuyAbove : pdPos >= CFG.pd.blockSellBelow);
  const pdPref = pdPos == null ? 0.4 : buy ? (pdPos < CFG.pd.discountBelow ? 1 : pdPos <= CFG.pd.premiumAbove ? 0.4 : 0) : (pdPos > CFG.pd.premiumAbove ? 1 : pdPos >= CFG.pd.discountBelow ? 0.4 : 0);
  const newsOk = !(newsSt.risk === "HIGH");
  const postNewsOk = !(newsSt.post && sweep && sweep.t <= newsSt.post.t);
  const regimeOk = regime.primary !== "NEWS_MODE";
  // 6) M5 confirmation score (sweep, BOS/CHoCH, displacement, FVG, rejection, retest)
  const m5sweep = sweeps.some(s => s.tf === "M5" && s.confirmed && s.side === (buy ? "SSL" : "BSL") && sweep && s.t >= sweep.t - 900 && nowS - s.t <= 3 * 3600);
  const m5fvg = !!(sweep && T5.fvg.some(g => g.dir === dirEv && g.state !== "filled" && g.t >= sweep.t - 300));
  const m5comp = [["M5 BOS/CHoCH", m5Valid ? 30 : 0, 30], ["Displacement", m5ev ? Math.round(20 * m5ev.disp.score / 100) : 0, 20], ["M5 sweep", m5sweep ? 15 : 0, 15], ["Rejection candle", rej ? 20 : 0, 20], ["Retest", touched ? 10 : 0, 10], ["M5 FVG", m5fvg ? 5 : 0, 5]];
  const m5conf = m5comp.reduce((s, c) => s + c[1], 0), m5ok = !!(m5Valid && rej && touched && m5conf >= CFG.m5.minScore);
  // 7) score (configurable weights, quality-aware) + transparent modifiers
  const rrFactor = rrOk ? clamp(0.5 + 0.5 * (plan.rr - CFG.minRR) / 1.5, 0.5, 1) : 0;
  const comp = [
    ["h1", "HTF Bias", W.h1, aligned ? 0.5 + 0.5 * biasConf / 100 : 0, "H1 " + bias + " · confidence " + biasConf + "%"],
    ["sweep", "Liquidity Sweep", W.sweep, sweep ? f(sweep.quality) : 0, sweep ? sweep.label + " " + f2(sweep.price) + " (" + sweep.tf + ") · quality " + sweep.quality : "no confirmed sweep of " + (buy ? "sell-side" : "buy-side") + " liquidity near the zone"],
    ["m15", "M15 Structure", W.m15, m15Valid ? f(m15ev.disp.score) : (aligned && (buy ? T15.trend === "UP" : T15.trend === "DOWN") ? 0.3 : 0), m15ev ? "M15 " + m15ev.kind + " " + m15ev.dir + " @ " + f2(m15ev.level) + (m15ev.valid ? " (valid)" : " (weak)") : "no M15 BOS/CHoCH after the sweep · M15 trend " + T15.trend],
    ["disp", "Displacement", W.disp, dispBest / 100, "best displacement score " + dispBest],
    ["fvgob", "FVG / OB", W.fvgob, ez ? ezQ / 100 : 0, ez ? ez.parts.join(" + ") + " · quality " + ezQ : "none yet"],
    ["pd", "Premium/Discount", W.pd, pdPref, pd ? pd.zone + " (" + pd.pos + "%)" : "unavailable"],
    ["m5", "M5 Confirmation", W.m5, m5conf / 100, "score " + m5conf + "/100 · " + m5comp.filter(c => c[1] > 0).map(c => c[0]).join(", ")],
    ["rr", "Risk/Reward", W.rr, rrFactor, plan ? (plan.noTarget ? "no liquidity target" : "RR 1:" + plan.rr + " · risk " + plan.risk + "$") : "no plan yet"]
  ];
  comp.forEach(([key, label, w, fac, detail]) => { const pts = Math.round(w * fac * 10) / 10; R.breakdown.push({ key, label, weight: w, factor: r2(fac), pts, detail }); R.items.push({ key, label, pts, max: w, ok: fac > 0, detail }); });
  const entryScore = Math.round(R.breakdown.reduce((s, b) => s + b.pts, 0));
  let mods = 0;
  const mm = macroMod(side, macro); if (mm.available && mm.pts) { R.modifiers.push({ label: "DXY / yields: " + mm.notes.join("; "), pts: mm.pts }); mods += mm.pts; }
  if (regime.primary === "HIGH_VOLATILITY") { R.modifiers.push({ label: "High volatility (SL widened ×" + CFG.sl.highVolMult + ")", pts: -3 }); mods -= 3; }
  if (regime.primary === "LOW_VOLATILITY") { R.modifiers.push({ label: "Low volatility (weak follow-through)", pts: -2 }); mods -= 2; }
  if (newsSt.risk === "MEDIUM") { R.modifiers.push({ label: "Medium news risk", pts: -5 }); mods -= 5; }
  if (!newsSt.available) { R.modifiers.push({ label: "NEWS DATA UNAVAILABLE (cannot verify)", pts: -3 }); mods -= 3; }
  if (dq && dq.coverage24h < 0.85) { R.modifiers.push({ label: "Data coverage " + Math.round(dq.coverage24h * 100) + "% (last 24h)", pts: -3 }); mods -= 3; }
  const confidence = Math.round(clamp(entryScore + mods, 0, 100));
  // 8) grade, A+ rules, mandatory confirmations
  const mand = { h1: aligned, zone: !!zone, sweep: !!sweep, m15shift: m15Valid, disp: dispBest >= CFG.disp.ok, m5confirm: m5ok, retest: !!(touched && rej), rr: rrOk, pd: pdOk, news: newsOk && postNewsOk, regime: regimeOk, fresh: fresh, notInvalid: !invalid };
  const aplusRules = { htfAligned: aligned && biasConf >= CFG.aplus.minBiasConf, liquidityTarget: !!(plan && plan.realTargets >= 2), sweep: !!sweep && sweep.quality >= 50, m15bos: m15Valid, strongDisp: dispBest >= CFG.aplus.minDisp, zoneQuality: ezQ >= CFG.aplus.minZoneQ, m5: m5conf >= CFG.aplus.minM5 && m5ok, rr: rrOk, news: newsSt.risk === "LOW" || newsSt.risk === "UNKNOWN" };
  const allAplus = Object.values(aplusRules).every(Boolean);
  let grade = gradeOf(confidence); if (grade === "A+" && !allAplus) grade = "A";
  const minG = regime.primary === "RANGING" ? CFG.regime.rangingMinGrade : CFG.minGrade;
  const gradeOk = GRADE_RANK[grade] >= GRADE_RANK[minG];
  const allMand = Object.values(mand).every(Boolean);
  let stage = 0; if (aligned) { stage = 1; if (zone) { stage = 2; if (sweep) { stage = 3; if (m15Valid && m5Valid) { stage = 4; if (allMand && gradeOk) stage = 5; } } } }
  let status = "WAIT", missed = false;
  if (!aligned) status = "DISABLED";
  else if (invalid) status = "INVALIDATED";
  else if (sweep && !m15Valid && !m5Valid && falseBreak) status = "NO_TRADE";
  else if (stage >= 4 && plan && !rrOk && mand.retest) status = "NO_TRADE";
  else if (allMand && gradeOk) { const moved = plan ? (buy ? price - plan.entry : plan.entry - price) : 0; if (plan && moved > 0.5 * plan.risk) { status = "WAIT"; missed = true; } else status = "VALID_ENTRY"; }
  // 9) IF/THEN text
  const lvl5 = (() => { const c = (T5.isw || []).filter(s => s.type === (buy ? "H" : "L") && (buy ? s.p > price : s.p < price)).sort((x, y) => buy ? x.p - y.p : y.p - x.p)[0]; return c ? c.p : null; })();
  let waitFor = ""; const need = [];
  if (!aligned) waitFor = "IF H1 prints a " + (buy ? "bullish" : "bearish") + " BOS/CHoCH THEN the " + side + " scenario is enabled. Until then counter-trend " + side + " is disabled.";
  else if (invalid) waitFor = "Scenario invalidated: price closed beyond " + f2(slLevel) + ". Looking for a new setup.";
  else if (!zone) waitFor = "IF price reaches an unmitigated " + (buy ? "demand" : "supply") + " zone THEN start watching for a liquidity sweep.";
  else if (!sweep) { const near = pools.filter(p => !p.swept && !p.live && p.side === (buy ? "SSL" : "BSL") && p.price >= zone.lo - 0.5 * a15 && p.price <= zone.hi + 0.5 * a15)[0]; waitFor = "IF price sweeps " + (near ? f2(near.price) + " (" + near.label + ")" : "liquidity " + (buy ? "below " + f2(zone.lo) : "above " + f2(zone.hi))) + " (penetration, rejection wick, close back inside) THEN look for displacement and an M15 " + (buy ? "bullish" : "bearish") + " BOS/CHoCH."; }
  else if (falseBreak && !m15Valid && !m5Valid) waitFor = "False breakout: price only wicked beyond " + f2(falseBreak.level) + " and closed back (" + falseBreak.tf + "). No valid BOS. Standing aside.";
  else if (!m15Valid) waitFor = "IF an M15 candle closes " + (buy ? "above" : "below") + " the internal " + (buy ? "high" : "low") + " with displacement (" + (buy ? "bullish" : "bearish") + " BOS/CHoCH) THEN the setup is confirmed." + (m15ev && m15ev.weak ? " (An M15 break exists but displacement is weak.)" : "");
  else if (!m5Valid) waitFor = "IF M5 shows " + (buy ? "bullish" : "bearish") + " displacement and closes " + (buy ? "above " : "below ") + (lvl5 ? f2(lvl5) : "the last internal swing") + " (" + (buy ? "bullish" : "bearish") + " BOS) THEN wait for the retest.";
  else if (!(touched && rej)) waitFor = missed ? "Entry zone passed. Wait for a new retest." : "IF price retests " + f2(ez.lo) + "–" + f2(ez.hi) + " (" + ez.parts.join(" + ") + ") and an M5 candle closes " + (buy ? "above " : "below ") + f2(ez.mid) + " THEN " + side + " becomes valid.";
  else if (!rrOk) waitFor = plan && plan.noTarget ? "No clear liquidity target beyond entry. Skip this setup." : "RR is " + (plan ? "1:" + plan.rr : "unknown") + " (minimum 1:" + CFG.minRR + ") or the stop is too wide/narrow. Skip this setup.";
  else if (!newsOk) waitFor = "HIGH NEWS RISK: " + (newsSt.event ? newsSt.event.title : "release") + ". NO NEW TRADE until it passes.";
  else if (!postNewsOk) waitFor = "Post-news: wait for a liquidity sweep AFTER " + newsSt.post.title + ", then structure confirmation, then M5.";
  else if (!regimeOk) waitFor = "NEWS MODE: wait.";
  else if (!pdOk) waitFor = (buy ? "BUY in premium" : "SELL in discount") + " is filtered out. Wait for a better location.";
  else if (!gradeOk) waitFor = "No " + minG + " setup: this one grades " + grade + " (confidence " + confidence + "%). Quality filter keeps B/C setups out.";
  if (status === "VALID_ENTRY") waitFor = "";
  if (plan) R.ifThen.push("IF price closes an M15 candle " + (buy ? "below " : "above ") + f2(plan.sl) + " THEN the " + side + " scenario is invalid.");
  const setupId = sweep && zone ? [side, zone.tf, Math.round(zone.lo), Math.round(zone.hi), sweep.t].join("-") : null;
  Object.assign(R, { aligned, zoneObj: zone, evObj: shiftEv && { kind: shiftEv.kind, dir: shiftEv.dir, level: shiftEv.level, tf: m15ev ? "M15" : "M5", t: shiftEv.t, retest: shiftEv.retest, disp: shiftEv.disp, valid: shiftEv.valid },
    m15ev: m15ev && { kind: m15ev.kind, dir: m15ev.dir, level: m15ev.level, t: m15ev.t, valid: m15ev.valid, disp: m15ev.disp }, m5ev: m5ev && { kind: m5ev.kind, dir: m5ev.dir, level: m5ev.level, t: m5ev.t, valid: m5ev.valid, disp: m5ev.disp },
    entryZone: ez, rej, touched, plan, entryScore, score: confidence, confidence, grade, gradeOk, aplusRules, allAplus, mand, stage, status, missed, waitFor, invalidation: plan ? plan.sl : slLevel, invalidT: invalid,
    invalidationText: slLevel == null ? null : (buy ? "M15 closes below " : "M15 closes above ") + f2(slLevel), livePriceInZone: !!(price != null && ez && price >= ez.lo - 0.1 * a5 && price <= ez.hi + 0.1 * a5), newsWarn: !newsSt.available,
    m5conf, m5comp, dispBest, falseBreak, weakBreak, forming: formingNow, setupId, macroNotes: mm.notes, minGrade: minG });
  return R;
}

/* ---------- decision object / explanation / debug ---------- */
function buildDecision(out, prim) {
  const sc = prim, ok = out.status === "VALID_ENTRY" && sc;
  const dec = ok ? sc.side : out.status === "NO_TRADE" ? "NO_TRADE" : "WAIT";
  const bias = { h1: out.h1 ? out.h1.bias : "UNKNOWN", m15: out.m15 ? out.m15.bias : "UNKNOWN", m5: out.m5 ? out.m5.bias : "UNKNOWN" };
  const plan = sc && sc.plan, ez = sc && sc.entryZone;
  const show = !!(sc && plan && ez && sc.stage >= 4);
  return {
    decision: dec, actionable: !!ok, grade: sc ? sc.grade : null, confidence: sc ? sc.confidence : 0, entryScore: sc ? sc.entryScore : 0, setupId: ok ? sc.setupId : (sc && sc.setupId) || null,
    bias, biasConfidence: out.h1 ? out.h1.biasConfidence : 0, conflict: out.conflict || null, state: out.stageName, dataState: { confirmed: true, forming: sc && sc.forming ? sc.forming : null },
    setup: { liquiditySweep: !!(sc && sc.sweep), bos: !!(sc && sc.m15ev && sc.m15ev.valid), displacement: !!(sc && sc.dispBest >= CFG.disp.ok), fvg: !!(ez && /FVG/.test(ez.parts.join(" "))), orderBlock: !!(ez && /OB/.test(ez.parts.join(" "))), retest: !!(sc && sc.touched), m5Confirmation: !!(sc && sc.mand && sc.mand.m5confirm) },
    entry: show ? { zoneLow: ez.lo, zoneHigh: ez.hi, preferred: ez.preferred, aggressive: ez.aggressive, conservative: ez.conservative, actual: plan.entryIsRejectionClose ? plan.entry : null, preview: !ok } : null,
    risk: show ? { stopLoss: plan.sl, tp1: plan.tps[0].price, tp2: plan.tps[1].price, tp3: plan.tps[2].price, rr1: plan.rr1, rr2: plan.rr2, rr3: plan.rr3, targets: plan.tps.map(t => ({ price: t.price, rr: t.rr, src: t.src, scope: t.scope || null, synthetic: !!t.synthetic })), mainRR: plan.rr, minRR: CFG.minRR } : null,
    liquidity: { target: show ? plan.tps[1].price : null, swept: sc && sc.sweep ? sc.sweep.price : null, nearestBuySide: out.nearest ? out.nearest.bsl : null, nearestSellSide: out.nearest ? out.nearest.ssl : null, internal: out.nearest ? out.nearest.internal : null, external: out.nearest ? out.nearest.external : null, sweepsDetected: (out.sweeps || []).filter(x => x.confirmed).slice(0, 3).map(x => ({ label: x.label, price: x.price, tf: x.tf, t: x.t, quality: x.quality })) },
    news: { risk: out.news ? out.news.risk : "UNKNOWN", upcomingEvent: out.news ? out.news.upcomingEvent : null, available: out.news ? out.news.available : false },
    invalidation: sc && sc.invalidation != null ? sc.invalidation : null, invalidationText: sc ? sc.invalidationText : null,
    reasons: out.reasonsList || [], warnings: out.warnings || [], breakdown: sc ? sc.breakdown : [], modifiers: sc ? sc.modifiers : [], aplusRules: sc ? sc.aplusRules : null,
    regime: out.regime, session: out.session, scenarios: out.scenarioPair || null
  };
}
function explain(d, out) {
  const L = [];
  if (!d) return "";
  if (d.actionable) {
    const b = d.decision === "BUY";
    L.push((b ? "🟢 BUY" : "🔴 SELL") + " — " + d.grade + " SETUP", "Confidence: " + d.confidence + "%", "Why:");
    (d.reasonsDetailed || d.reasons).forEach(r => L.push("• " + r));
    L.push("Entry: " + f2(d.entry.zoneLow) + "–" + f2(d.entry.zoneHigh), "Aggressive: " + f2(d.entry.aggressive) + " · Preferred: " + f2(d.entry.preferred) + " · Conservative: " + f2(d.entry.conservative),
      "SL: " + f2(d.risk.stopLoss), "TP1: " + f2(d.risk.tp1) + " (1:" + d.risk.rr1 + ")", "TP2: " + f2(d.risk.tp2) + " (1:" + d.risk.rr2 + ")", "TP3: " + f2(d.risk.tp3) + " (1:" + d.risk.rr3 + ")",
      "RR: 1:" + d.risk.mainRR, "Invalidation: " + d.invalidationText, "Action: " + d.decision + " ONLY IF the M5 confirmation remains valid. Decision support, not a prediction.");
  } else {
    L.push((d.decision === "NO_TRADE" ? "⛔ NO TRADE" : "🟡 WAIT") + (d.grade && d.grade !== "D" ? " — best candidate grades " + d.grade + " (" + d.confidence + "%)" : " — No A+ setup"));
    if (d.conflict) L.push("CONFLICT: H1 " + d.conflict.h1 + " / M15 " + d.conflict.m15 + " / M5 " + d.conflict.m5, d.conflict.reason);
    if (d.reasons.length) { L.push("Reason:"); d.reasons.forEach(r => L.push("• " + r)); }
    if (out && out.waitFor) L.push("What to wait for: " + out.waitFor);
    if (d.scenarios && d.scenarios.primary) L.push("PRIMARY: " + d.scenarios.primary.text);
    if (d.scenarios && d.scenarios.alternative) L.push("ALTERNATIVE: " + d.scenarios.alternative.text);
    L.push("CURRENT: " + d.decision.replace("_", " "));
  }
  return L.join("\n");
}
function debugLines(out) {
  const L = [], pad = (s, n) => s + " " + ".".repeat(Math.max(2, n - s.length)) + " ", P = x => x ? "PASS" : "FAIL";
  const prim = out.primary ? out.scenarios[out.primary] : null;
  L.push(pad("Data fresh", 22) + P(out.fresh), pad("Data quality", 22) + P(!out.dataQuality || out.dataQuality.issues.length === 0) + (out.dataQuality && out.dataQuality.issues.length ? " (" + out.dataQuality.issues.join("; ") + ")" : ""));
  L.push(pad("H1 Bias", 22) + P(out.h1.bias !== "NEUTRAL") + " " + out.h1.bias + " " + out.h1.biasConfidence + "%");
  if (prim) {
    const m = prim.mand; const rows = [["Zone (M15/H1)", m.zone], ["Liquidity Sweep", m.sweep], ["M15 BOS/CHoCH", m.m15shift], ["Displacement", m.disp], ["M5 Confirmation", m.m5confirm], ["Retest + rejection", m.retest], ["RR ≥ 1:" + CFG.minRR, m.rr], ["Premium/Discount filter", m.pd], ["News risk", m.news], ["Regime", m.regime], ["Not invalidated", m.notInvalid]];
    rows.forEach(([k, v]) => L.push(pad(k, 22) + P(v)));
    L.push(pad("Grade ≥ " + prim.minGrade, 22) + P(prim.gradeOk) + " " + prim.grade + " (" + prim.confidence + "%)");
    prim.breakdown.forEach(b => L.push("   score " + pad(b.label, 20) + b.pts + "/" + b.weight + " — " + b.detail));
    prim.modifiers.forEach(x => L.push("   modifier " + x.label + ": " + x.pts));
  } else L.push("No aligned scenario (H1 " + out.h1.bias + ")");
  L.push("FINAL: " + out.decision.decision);
  return L;
}

/* ---------- main ---------- */
function analyze(opts) {
  CFG = merge(JSON.parse(JSON.stringify(DEFAULTS)), opts.config || {}); if (opts.debug != null) CFG.debug = !!opts.debug;
  const nowS = opts.nowS || Math.floor(Date.now() / 1000), sn = sanitize(opts.m1 || []), m1 = sn.rows.filter(r => r[0] <= nowS);   // no look-ahead: nothing after 'now' is visible
  const out = { engine: VERSION, now: nowS, status: "NO_DATA", signal: null, reasons: [], marketClosed: marketClosed(nowS * 1000), config: { minRR: CFG.minRR, minGrade: CFG.minGrade, weights: CFG.weights } };
  if (!m1.length) { out.reasons.push("NO CANDLE DATA"); out.decision = buildDecision(out, null); return out; }
  const last = m1[m1.length - 1], price = opts.price != null ? opts.price : last[4];
  out.price = price; out.lastT = last[0]; out.dataAge = nowS - last[0]; out.dataQuality = dataQuality(m1, sn.q, nowS);
  const T5 = tfAnalysis(m1, "M5", nowS), T15 = tfAnalysis(m1, "M15", nowS), T1 = tfAnalysis(m1, "H1", nowS);
  out.progress = { H1: [T1.have, T1.need], M15: [T15.have, T15.need], M5: [T5.have, T5.need] };
  out.atr = { H1: r2(T1.atr), M15: r2(T15.atr), M5: r2(T5.atr) };
  out.fresh = !(!out.marketClosed && out.dataAge > CFG.staleSec);
  const newsSt = newsState(opts.news || null, nowS); out.news = newsSt;
  if (!out.fresh) { out.status = "DATA_STALE"; out.reasons.push("DATA STALE — ANALYSIS PAUSED (last candle " + Math.round(out.dataAge / 60) + " min ago)"); }
  if (!T1.ready || !T15.ready || !T5.ready) { if (out.status !== "DATA_STALE") out.status = "NO_DATA"; out.reasons.push("Collecting candles: H1 " + T1.have + "/" + T1.need + " · M15 " + T15.have + "/" + T15.need + " · M5 " + T5.have + "/" + T5.need);
    out.decision = buildDecision(out, null); return out; }
  const P = buildPools(m1, T5, T15, T1, nowS); out.pdAvailable = P.pdAvailable; out.sessions = P.sessions;
  const hb = h1Bias(T1, P.pools, price), bias = hb.bias;
  const brief = T => ({ tf: T.tf, trend: T.trend, atr: r2(T.atr), have: T.have, swings: T.sw.slice(-6).map(s => ({ type: s.type, lab: s.lab, p: r2(s.p), t: s.t })), pending: T.pending ? { type: T.pending.type, p: r2(T.pending.p), t: T.pending.t } : null,
    events: (T.ievents || T.events).slice(-5).map(e => ({ kind: e.kind, dir: e.dir, level: e.level, t: e.t, retest: e.retest, valid: e.valid, confirmed: true, disp: e.disp.label, dispScore: e.disp.score })),
    falseBreaks: (T.ifalse || T.falseBreaks || []).slice(-3), forming: T.forming ? { t: T.forming[0], o: T.forming[1], h: T.forming[2], l: T.forming[3], c: T.forming[4], confirmed: false } : null });
  out.h1 = Object.assign(brief(T1), { bias, biasConfidence: hb.confidence, why: hb.why, lastEvent: hb.lastEvent }); out.m15 = brief(T15); out.m5 = brief(T5);
  // M15 / M5 bias (for conflict detection)
  const lastIn = T => { const e = (T.ievents || T.events).slice(-1)[0]; return e && T.cs.length - 1 - e.idx <= 12 ? (e.dir === "BULL" ? "BULLISH" : "BEARISH") : null; };
  out.m15.bias = lastIn(T15) || (T15.trend === "UP" ? "BULLISH" : T15.trend === "DOWN" ? "BEARISH" : "NEUTRAL");
  out.m5.bias = lastIn(T5) || (T5.itrend === "UP" ? "BULLISH" : T5.itrend === "DOWN" ? "BEARISH" : "NEUTRAL");
  out.regimeInfo = regimeOf(T1, T15, newsSt); out.regime = out.regimeInfo.primary === "TRENDING" ? (bias === "BULLISH" ? "Bullish" : bias === "BEARISH" ? "Bearish" : "Range") : out.regimeInfo.primary;
  out.session = sessionInfo(nowS, P.sessions, out.marketClosed);
  const sweeps = findSweeps(P.pools, [T5, T15]); out.sweeps = sweeps.slice(0, 6);
  let pd = null;
  { const H = [T1.sw.filter(s => s.type === "H").pop(), T1.pending && T1.pending.type === "H" ? T1.pending : null].filter(Boolean).map(s => s.p), L = [T1.sw.filter(s => s.type === "L").pop(), T1.pending && T1.pending.type === "L" ? T1.pending : null].filter(Boolean).map(s => s.p);
    if (H.length && L.length) { const hi = Math.max(...H), lo = Math.min(...L); if (hi > lo) { const pos = (price - lo) / (hi - lo) * 100; pd = { hi: r2(hi), lo: r2(lo), mid: r2((hi + lo) / 2), pos: Math.round(pos * 10) / 10, zone: pos > CFG.pd.premiumAbove ? "PREMIUM" : pos < CFG.pd.discountBelow ? "DISCOUNT" : "EQUILIBRIUM", range: { low: r2(lo), high: r2(hi), equilibrium: r2((hi + lo) / 2) } }; } } }
  out.pd = pd;
  const ctxQ = { bias, pd, sweeps, price }; [T1, T15, T5].forEach(T => enrichZones(T, ctxQ));
  const zl = T => (T.obs || []).filter(o => !o.mitigated).slice(-3).map(o => ({ tf: o.tf, side: o.side, type: o.type, lo: o.lo, hi: o.hi, high: o.hi, low: o.lo, state: o.state, freshness: o.freshness, quality: o.quality, distance: o.distance, t: o.t, mitigated: o.mitigated }));
  const fl = T => T.fvg.filter(g => !g.filled).slice(-4).map(g => ({ tf: g.tf, type: g.type, dir: g.dir, lo: g.lo, hi: g.hi, top: g.top, bottom: g.bottom, midpoint: g.midpoint, state: g.state, filled: g.filled, ageCandles: g.ageCandles, quality: g.quality, distance: g.distance, direction: g.direction, t: g.t }));
  [[out.h1, T1], [out.m15, T15], [out.m5, T5]].forEach(([o, T]) => { o.zones = zl(T); o.fvg = fl(T); });
  out.m5.zones = (T5.iobs || []).filter(o => !o.mitigated).slice(-3).map(o => ({ tf: o.tf, side: o.side, type: o.type, lo: o.lo, hi: o.hi, state: o.state, quality: o.quality, distance: o.distance, t: o.t }));
  out.pools = P.pools.map(p => ({ key: p.key, kind: p.kind, label: p.label, price: p.price, side: p.side, t: p.t, live: p.live, swept: p.swept, scope: p.scope, major: p.major })).sort((x, y) => y.price - x.price);
  const near = (side, pred) => { const c = P.pools.filter(p => p.side === side && !p.swept && (side === "BSL" ? p.price > price : p.price < price) && pred(p)).sort((x, y) => Math.abs(x.price - price) - Math.abs(y.price - price))[0]; return c ? { price: c.price, label: c.label, scope: c.scope, dist: r2(c.price - price) } : null; };
  out.nearest = { bsl: near("BSL", () => true), ssl: near("SSL", () => true), internal: { bsl: near("BSL", p => p.scope === "internal"), ssl: near("SSL", p => p.scope === "internal") }, external: { bsl: near("BSL", p => p.scope === "external"), ssl: near("SSL", p => p.scope === "external") } };
  const C = { T5, T15, T1, pools: P.pools, sweeps, price, bias, biasConf: hb.confidence, pd, newsSt, nowS, fresh: out.fresh, regime: out.regimeInfo, macro: opts.macro || null, dq: out.dataQuality };
  out.scenarios = { BUY: evalSide("BUY", C), SELL: evalSide("SELL", C) };
  // conflict: H1 vs M15 vs M5
  const nb = x => x !== "NEUTRAL" && x !== "UNKNOWN";
  const h = out.h1.bias, m = out.m15.bias, q = out.m5.bias;
  out.conflict = null;
  if (nb(h) && nb(m) && h !== m) out.conflict = { h1: h, m15: m, m5: q, action: "WAIT", reason: "M15 has not confirmed the H1 " + h.toLowerCase() + " continuation." };
  else if (nb(h) && nb(m) && nb(q) && q !== h) out.conflict = { h1: h, m15: m, m5: q, action: "WAIT", reason: "M5 disagrees with H1/M15 (no confirmation in the H1 direction)." };
  // primary / alternative scenarios
  const al = ["BUY", "SELL"].filter(s => out.scenarios[s].aligned).map(s => out.scenarios[s]);
  const prim = al.sort((x, y) => y.stage - x.stage || y.confidence - x.confidence)[0] || null; out.primary = prim ? prim.side : null;
  const rs = [], nt = rs;
  if (out.marketClosed) nt.push("Market closed");
  if (bias === "NEUTRAL") nt.push(T15.trend !== "RANGE" ? "H1 neutral while M15 trends " + T15.trend + " (conflicting structure)" : "H1 structure unclear (neutral) · no clear liquidity target");
  if (out.conflict && prim && prim.stage < 4) nt.push("CONFLICT: " + out.conflict.reason);
  if (newsSt.risk === "HIGH") nt.push("HIGH NEWS RISK: " + (newsSt.event ? newsSt.event.title + (newsSt.window.minsTo != null ? (newsSt.window.minsTo >= 0 ? " in " + newsSt.window.minsTo + " min" : " released " + (-newsSt.window.minsTo) + " min ago") : "") : "") + " → NO NEW TRADE");
  else if (newsSt.post) nt.push("Post-news window (" + newsSt.post.title + "): wait for sweep → structure → M5 setup");
  if (!newsSt.available) nt.push("NEWS DATA UNAVAILABLE");
  if (out.regimeInfo.primary === "RANGING") nt.push("Ranging regime: only A+ setups are accepted");
  if (prim && prim.status === "INVALIDATED") nt.push("Scenario invalidated");
  if (prim && prim.falseBreak && prim.status === "NO_TRADE") nt.push("False breakout: wick-only break, no valid BOS");
  if (prim && prim.stage < 2) nt.push("No A+ setup: price is not at a valid " + (prim.side === "BUY" ? "demand" : "supply") + " zone and there is no clear liquidity event yet");
  if (prim && prim.stage >= 2 && !prim.sweep) nt.push("No liquidity sweep yet");
  if (prim && prim.stage >= 3 && !prim.mand.m15shift) nt.push("M15 BOS/CHoCH not confirmed");
  if (prim && prim.plan && !(prim.plan.rr >= CFG.minRR) && prim.stage >= 4) nt.push(prim.plan.noTarget ? "No clear liquidity target" : "Poor RR (1:" + prim.plan.rr + " < 1:" + CFG.minRR + ")");
  if (prim && prim.stage >= 4 && !prim.mand.m5confirm && prim.stage < 5) nt.push("No M5 confirmation");
  if (prim && prim.stage >= 4 && prim.mand.m5confirm && !prim.gradeOk) nt.push("Quality filter: grade " + prim.grade + " < " + prim.minGrade);
  if (pd && pd.zone === "EQUILIBRIUM" && (!prim || prim.stage < 2)) nt.push("Price in the middle of the range (" + pd.pos + "%) · do not trade");
  out.dataQuality.issues.forEach(i => nt.push("Data: " + i));
  out.warnings = [];   // stay visible even when a signal is valid
  if (!newsSt.available) out.warnings.push("NEWS DATA UNAVAILABLE: news risk could not be verified");
  if (newsSt.risk === "MEDIUM") out.warnings.push("Medium news risk nearby");
  out.dataQuality.issues.forEach(i => out.warnings.push("Data: " + i));
  if (!opts.macro) out.warnings.push("DXY / yields data unavailable: no macro confirmation applied");
  out.reasonsList = rs.slice(); out.reasons = rs;
  if (out.status === "DATA_STALE") { out.reasons = ["DATA STALE — ANALYSIS PAUSED"].concat(out.reasons); }
  else if (prim && prim.status === "VALID_ENTRY" && !out.marketClosed) { out.status = "VALID_ENTRY"; out.signal = prim.side; out.reasons = []; }
  else if (prim && prim.status === "NO_TRADE" && !out.marketClosed) out.status = "NO_TRADE";
  else if (prim && prim.status === "INVALIDATED") out.status = "NO_TRADE";
  else out.status = "WAIT";
  out.waitFor = prim ? prim.waitFor : (bias === "NEUTRAL" ? "IF H1 prints a BOS with displacement THEN a directional scenario is enabled." : "");
  out.stageName = ["NEUTRAL", "BIAS DETECTED", "ZONE APPROACHED", "LIQUIDITY EVENT", "M5 CONFIRMATION", "ENTRY VALID"][prim ? prim.stage : 0];
  // two-scenario view: primary + alternative (only shown when meaningful)
  let pr = null, alt = null;
  if (prim) { pr = { side: prim.side, text: prim.waitFor || (prim.side + " is valid now.") }; if (prim.plan && prim.invalidation != null) { const o = prim.side === "BUY" ? "SELL" : "BUY"; alt = { side: o, text: "IF price " + (prim.side === "BUY" ? "breaks below " : "breaks above ") + f2(prim.invalidation) + " and retests it THEN " + o + " becomes the scenario to watch." }; } }
  else if (pd) { pr = { side: "BUY", text: "IF price sweeps sell-side liquidity near " + f2(pd.lo) + " and M5 prints a bullish BOS THEN BUY." }; alt = { side: "SELL", text: "IF price sweeps buy-side liquidity near " + f2(pd.hi) + " and M5 prints a bearish BOS THEN SELL." }; }
  out.scenarioPair = (pr || alt) ? { primary: pr, alternative: alt } : null;
  out.decision = buildDecision(out, prim);
  // human-readable reasons for an actionable setup
  if (out.decision.actionable) { const sc = prim; out.decision.reasonsDetailed = [].concat(`H1 ${bias.toLowerCase()} structure (confidence ${hb.confidence}%)`, sc.sweep ? `${sc.sweep.tf} swept ${sc.sweep.side === "SSL" ? "sell-side" : "buy-side"} liquidity (${sc.sweep.label} ${f2(sc.sweep.price)})` : [], sc.m15ev ? `M15 ${sc.m15ev.kind} confirmed @ ${f2(sc.m15ev.level)} with ${sc.m15ev.disp.label.toLowerCase()} displacement` : [], sc.entryZone ? `Entry zone built on ${sc.entryZone.parts.join(" + ")}` : [], pd ? `Price in ${pd.zone.toLowerCase()} (${pd.pos}%)` : [], sc.m5ev ? `M5 ${sc.m5ev.kind} ${sc.m5ev.dir === "BULL" ? "bullish" : "bearish"} confirmed with retest and rejection` : [], newsSt.risk === "LOW" ? "No high-impact news nearby" : newsSt.available ? "News risk: " + newsSt.risk : "NEWS DATA UNAVAILABLE", sc.macroNotes && sc.macroNotes.length ? sc.macroNotes : []); }
  out.explanation = explain(out.decision, out);
  if (CFG.debug) out.debug = debugLines(out);
  return out;
}
function candlesFor(m1, tf, nowS) { const b = build(m1, SEC[tf], COVER[tf], nowS); return b.forming ? b.done.concat([b.forming]) : b.done; }
return { analyze, macroFromDrivers, explain, dataQuality, sanitize, newsWindow, newsState, newsInfo, build, candlesFor, tfAnalysis, zigzag, trendOf, atrOf, dispScore, SEC, NEED, DEFAULTS, VERSION, marketClosed, GRADE: gradeOf };
});

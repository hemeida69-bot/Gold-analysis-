/* XAUUSD multi-timeframe SMC engine. H1 = context, M15 = setup/zone, M5 = confirmation.
   Works in the browser (window.Engine) and in Node (require). Input: 1-minute candles built from XAUUSD spot ticks. */
(function (root, factory) { if (typeof module === "object" && module.exports) module.exports = factory(); else root.Engine = factory(); })(typeof self !== "undefined" ? self : this, function () {
"use strict";
const SEC = { M5: 300, M15: 900, H1: 3600 };
const COVER = { M5: 3, M15: 6, H1: 20 };      // min 1-minute candles that must exist inside a candle for it to count
const K = { M5: 0.9, M15: 1.0, H1: 1.2 };     // zigzag swing threshold in ATRs
const NEED = { M5: 40, M15: 24, H1: 20 };
const r2 = x => Math.round(x * 100) / 100;
const f2 = x => (x == null ? "-" : r2(x).toFixed(2));
const marketClosed = ms => { const d = new Date(ms), w = d.getUTCDay(), h = d.getUTCHours(); return (w === 5 && h >= 22) || w === 6 || (w === 0 && h < 22); };

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
function isDisp(c, a, dir) {
  const body = Math.abs(c[4] - c[1]), rng = c[2] - c[3];
  return (dir === "BULL" ? c[4] > c[1] : c[4] < c[1]) && body >= 1.0 * a && body >= 0.6 * rng;
}
function dispNear(cs, i, dir, a) {
  let best = -1, bb = 0;
  for (let j = Math.max(0, i - 2); j <= i; j++) if (isDisp(cs[j], a, dir)) { const b = Math.abs(cs[j][4] - cs[j][1]); if (b > bb) { bb = b; best = j; } }
  if (best >= 0) return { ok: true, idx: best, body: r2(bb), x: r2(bb / a) };
  if (i >= 2) {
    const up = dir === "BULL"; const net = up ? cs[i][4] - cs[i - 2][1] : cs[i - 2][1] - cs[i][4];
    const mono = [i - 2, i - 1, i].every(j => (up ? cs[j][4] > cs[j][1] : cs[j][4] < cs[j][1]));
    if (mono && net >= 1.8 * a) return { ok: true, idx: i, body: r2(net), x: r2(net / a) };
  }
  return { ok: false, idx: -1, body: 0, x: 0 };
}
function events(cs, zz, a) {
  const sw = zz.sw, ev = [], broken = new Set(), buf = 0.05 * a;
  for (let i = 0; i < cs.length; i++) {
    const known = sw.filter(s => s.conf <= i); if (known.length < 2) continue;
    const tr = trendOf(known), c = cs[i][4];
    const lastH = [...known].reverse().find(s => s.type === "H" && !broken.has(s.i));
    const lastL = [...known].reverse().find(s => s.type === "L" && !broken.has(s.i));
    if (lastH && c > lastH.p + buf) {
      known.forEach(s => { if (s.type === "H" && s.p < c - buf) broken.add(s.i); });
      ev.push({ kind: tr === "DOWN" ? "CHoCH" : "BOS", dir: "BULL", level: r2(lastH.p), levelT: lastH.t, idx: i, t: cs[i][0], trendBefore: tr, disp: dispNear(cs, i, "BULL", a) });
    }
    if (lastL && c < lastL.p - buf) {
      known.forEach(s => { if (s.type === "L" && s.p > c + buf) broken.add(s.i); });
      ev.push({ kind: tr === "UP" ? "CHoCH" : "BOS", dir: "BEAR", level: r2(lastL.p), levelT: lastL.t, idx: i, t: cs[i][0], trendBefore: tr, disp: dispNear(cs, i, "BEAR", a) });
    }
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
function fvgs(cs, a) {
  const out = [], min = 0.15 * a;
  for (let j = 1; j < cs.length - 1; j++) {
    let z = null;
    if (cs[j + 1][3] - cs[j - 1][2] >= min) z = { dir: "BULL", lo: cs[j - 1][2], hi: cs[j + 1][3] };
    else if (cs[j - 1][3] - cs[j + 1][2] >= min) z = { dir: "BEAR", lo: cs[j + 1][2], hi: cs[j - 1][3] };
    if (!z) continue;
    z.t = cs[j][0]; z.idx = j; z.state = "open";
    for (let k = j + 2; k < cs.length; k++) {
      if (z.dir === "BULL") { if (cs[k][3] <= z.lo) { z.state = "filled"; break; } if (cs[k][3] <= z.hi) z.state = "tested"; }
      else { if (cs[k][2] >= z.hi) { z.state = "filled"; break; } if (cs[k][2] >= z.lo) z.state = "tested"; }
    }
    z.lo = r2(z.lo); z.hi = r2(z.hi); out.push(z);
  }
  return out;
}
function orderBlocks(cs, evs, a, tf) {
  const out = [];
  for (const e of evs) {
    if (!e.disp.ok) continue;
    const j = e.disp.idx; let ob = -1;
    for (let k = j; k >= Math.max(0, j - 6); k--) { if (e.dir === "BULL" ? cs[k][4] < cs[k][1] : cs[k][4] > cs[k][1]) { ob = k; break; } }
    if (ob < 0) continue;
    const z = { tf, side: e.dir === "BULL" ? "DEMAND" : "SUPPLY", lo: r2(cs[ob][3]), hi: r2(cs[ob][2]), t: cs[ob][0], idx: ob, evKind: e.kind, evT: e.t, state: "fresh" };
    for (let k = ob + 1; k < cs.length; k++) {
      if (z.side === "DEMAND") { if (cs[k][4] < z.lo - 0.1 * a) { z.state = "mitigated"; break; } if (k > j && cs[k][3] <= z.hi) z.state = "tested"; }
      else { if (cs[k][4] > z.hi + 0.1 * a) { z.state = "mitigated"; break; } if (k > j && cs[k][2] >= z.lo) z.state = "tested"; }
    }
    out.push(z);
  }
  return out;
}
function tfAnalysis(m1, tf, nowS) {
  const sec = SEC[tf], b = build(m1, sec, COVER[tf], nowS), cs = b.done, a = atrOf(cs, sec);
  const zz = zigzag(cs, K[tf] * a), ev = events(cs, zz, a);
  const T = { tf, sec, cs, forming: b.forming, atr: a, zz, sw: zz.sw, pending: zz.pending, trend: trendOf(zz.sw), events: ev, fvg: fvgs(cs, a), obs: orderBlocks(cs, ev, a, tf), ready: cs.length >= NEED[tf], have: cs.length, need: NEED[tf] };
  if (tf === "M5") { const zi = zigzag(cs, 0.45 * a); T.isw = zi.sw; T.ievents = events(cs, zi, a); T.iobs = orderBlocks(cs, T.ievents, a, tf); }   // internal structure used for M5 BOS/CHoCH
  return T;
}

/* ---------- liquidity ---------- */
const SESS = [{ name: "asia", ar: "آسيا", tz: "Asia/Tokyo", s: 9, e: 18 }, { name: "london", ar: "لندن", tz: "Europe/London", s: 8, e: 17 }, { name: "ny", ar: "نيويورك", tz: "America/New_York", s: 8, e: 17 }];
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
    out[S.name] = { cur: run, prev: last, ar: S.ar };
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
function buildPools(m1, T5, T15, T1, nowS) {
  const pools = [], add = (kind, label, price, side, t, live) => pools.push({ key: kind + ":" + f2(price), kind, label, price: r2(price), side, t, live: !!live, swept: false });
  const day0 = Math.floor(nowS / 86400) * 86400, pd0 = day0 - 86400;
  const today = m1.filter(r => r[0] >= day0), prev = m1.filter(r => r[0] >= pd0 && r[0] < day0);
  let pdOk = prev.length >= 600;
  if (pdOk) { add("PDH", "Previous Day High", Math.max(...prev.map(r => r[2])), "BSL", pd0); add("PDL", "Previous Day Low", Math.min(...prev.map(r => r[3])), "SSL", pd0); }
  if (today.length >= 5) { add("CDH", "Current Day High", Math.max(...today.map(r => r[2])), "BSL", day0, true); add("CDL", "Current Day Low", Math.min(...today.map(r => r[3])), "SSL", day0, true); }
  const runs = sessionRuns(T5.cs.slice(-480)); const sess = {};
  for (const S of SESS) {
    const R = runs[S.name]; sess[S.name] = { ar: S.ar, cur: R.cur ? { hi: r2(R.cur.hi), lo: r2(R.cur.lo), from: R.cur.from } : null, prev: R.prev ? { hi: r2(R.prev.hi), lo: r2(R.prev.lo), from: R.prev.from } : null };
    if (R.cur) { add("SH_" + S.name, S.ar + " Session High (live)", R.cur.hi, "BSL", R.cur.from, true); add("SL_" + S.name, S.ar + " Session Low (live)", R.cur.lo, "SSL", R.cur.from, true); }
    if (R.prev) { add("SH_" + S.name, S.ar + " Session High", R.prev.hi, "BSL", R.prev.from); add("SL_" + S.name, S.ar + " Session Low", R.prev.lo, "SSL", R.prev.from); }
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
  const seen = new Map(); for (const p of pools) { const k = p.side + ":" + Math.round(p.price * 2); const q = seen.get(k); if (!q || (q.live && !p.live)) seen.set(k, p); else if (q.kind !== p.kind) q.label += " + " + p.label; }
  const list = [...seen.values()];
  for (const p of list) {
    if (p.live) continue; const cs = T5.cs;
    for (let i = 0; i < cs.length; i++) { if (cs[i][0] <= p.t) continue; if ((p.side === "BSL" && cs[i][2] > p.price + 0.1) || (p.side === "SSL" && cs[i][3] < p.price - 0.1)) { p.swept = true; p.sweptAt = cs[i][0]; break; } }
  }
  return { pools: list, sessions: sess, pdAvailable: pdOk };
}
function findSweeps(pools, Ts, nowS) {
  // a sweep = a wick pierces an untouched pool and within 3 candles a candle closes back inside; extreme = furthest point of the raid
  const out = [];
  for (const T of Ts) {
    const cs = T.cs, from = Math.max(0, cs.length - (T.tf === "M5" ? 36 : 12)), buf = Math.max(0.1, 0.03 * T.atr);
    for (const p of pools) {
      if (p.live) continue;
      let first = -1;
      for (let i = 0; i < cs.length; i++) { if (cs[i][0] <= p.t) continue; if ((p.side === "BSL" && cs[i][2] > p.price + buf) || (p.side === "SSL" && cs[i][3] < p.price - buf)) { first = i; break; } }
      if (first < 0) continue;
      let rec = -1, ext = p.side === "BSL" ? -1e9 : 1e9;
      for (let k = first; k <= Math.min(first + 3, cs.length - 1); k++) {
        ext = p.side === "BSL" ? Math.max(ext, cs[k][2]) : Math.min(ext, cs[k][3]);
        if ((p.side === "BSL" && cs[k][4] < p.price) || (p.side === "SSL" && cs[k][4] > p.price)) { rec = k; break; }
      }
      if (rec < from || rec < 0) continue;
      out.push({ pool: p.key, label: p.label, side: p.side, price: p.price, tf: T.tf, t: cs[rec][0], pierceT: cs[first][0], idx: rec, extreme: ext, close: cs[rec][4] });
    }
  }
  return out.sort((x, y) => y.t - x.t);
}

/* ---------- scenarios ---------- */
const GRADE = s => (s >= 90 ? "A+" : s >= 80 ? "A" : s >= 70 ? "B" : s >= 60 ? "WAIT" : "NO TRADE");
function evalSide(side, C) {
  const { T5, T15, T1, pools, sweeps, price, bias, pd, news, nowS, fresh } = C;
  const buy = side === "BUY", dirEv = buy ? "BULL" : "BEAR", a5 = T5.atr, a15 = T15.atr;
  const R = { side, items: [], reasons: [], ifThen: [], warnings: [] };
  const aligned = (buy && bias === "BULLISH") || (!buy && bias === "BEARISH");
  const item = (key, label, pts, ok, detail) => { R.items.push({ key, label, pts: ok ? pts : 0, max: pts, ok: !!ok, detail: detail || "" }); return !!ok; };
  // zone (supply for SELL / demand for BUY), H1 first
  const want = buy ? "DEMAND" : "SUPPLY"; let zone = null;
  const cands = [].concat(T1.obs, T15.obs).filter(z => z.side === want && z.state !== "mitigated");
  const mySweeps = sweeps.filter(s => s.side === (buy ? "SSL" : "BSL") && nowS - s.t <= 3 * 3600);
  for (const z of cands) {
    const inside = price >= z.lo && price <= z.hi, dist = buy ? price - z.hi : z.lo - price;
    const sw = mySweeps.find(s => buy ? (s.extreme <= z.hi + 0.5 * a15 && s.extreme >= z.lo - 1.2 * a15) : (s.extreme >= z.lo - 0.5 * a15 && s.extreme <= z.hi + 1.2 * a15));
    let st = null; if (sw) st = "SWEPT"; else if (inside) st = "IN_ZONE"; else if (dist > 0 && dist <= 1.5 * a15) st = "APPROACH";
    if (!st) continue;
    const score = (st === "SWEPT" ? 0 : st === "IN_ZONE" ? 1 : 2) * 10 + (z.tf === "H1" ? 0 : 5) + Math.max(0, dist) / 100;
    if (!zone || score < zone.score) zone = Object.assign({}, z, { zst: st, score, sweep: sw || null });
  }
  const sweep = zone ? (zone.sweep || null) : null;
  R.zone = zone ? { tf: zone.tf, side: zone.side, lo: zone.lo, hi: zone.hi, state: zone.zst, t: zone.t } : null;
  R.sweep = sweep;
  // structure alignment
  const m15Ev = T15.events.slice(-1)[0];
  const m15al = (buy ? T15.trend === "UP" : T15.trend === "DOWN") || (m15Ev && m15Ev.dir === dirEv && T15.cs.length - 1 - m15Ev.idx <= 8);
  // confirmation events after the sweep
  let ev = null, evTf = null;
  if (sweep) {
    ev = T5.ievents.find(e => e.dir === dirEv && e.t >= sweep.t); evTf = "M5";
    if (!ev) { ev = T15.events.find(e => e.dir === dirEv && e.t >= sweep.t); evTf = ev ? "M15" : null; }
  }
  const dispOk = !!(ev && ev.disp.ok);
  // entry zone
  let ez = null, parts = [];
  if (ev) {
    const T = evTf === "M5" ? T5 : T15, win0 = sweep.t - 2 * T.sec, win1 = ev.t + T.sec;
    const fv = T.fvg.filter(g => g.dir === dirEv && g.state !== "filled" && g.t >= win0 && g.t <= win1).sort((x, y) => (y.hi - y.lo) - (x.hi - x.lo))[0];
    const ob = (evTf === "M5" ? T5.iobs : T15.obs).find(o => o.evT === ev.t && o.state !== "mitigated");
    const band = { lo: ev.level - 0.25 * a5, hi: ev.level + 0.25 * a5 };
    if (fv && ob && Math.max(fv.lo, ob.lo) < Math.min(fv.hi, ob.hi)) { ez = { lo: Math.min(fv.lo, ob.lo), hi: Math.max(fv.hi, ob.hi) }; parts = ["FVG", "Order Block"]; }
    else if (fv) { ez = { lo: fv.lo, hi: fv.hi }; parts = ["FVG"]; }
    else if (ob) { ez = { lo: ob.lo, hi: ob.hi }; parts = ["Order Block"]; }
    else { ez = band; parts = ["Broken level " + f2(ev.level)]; }
    const cap = 2 * a5, minW = 0.4 * a5;
    if (ez.hi - ez.lo > cap) { if (buy) ez.lo = ez.hi - cap; else ez.hi = ez.lo + cap; }
    if (ez.hi - ez.lo < minW) { const m = (ez.hi + ez.lo) / 2; ez.lo = m - minW / 2; ez.hi = m + minW / 2; }
    ez = { lo: r2(ez.lo), hi: r2(ez.hi), mid: r2((ez.lo + ez.hi) / 2), parts };
  }
  // retest + rejection (M5 candles after the break)
  let touched = false, rej = null, invalid = null;
  const buf = Math.max(0.3, 0.2 * a5);
  const slLevel = sweep ? (buy ? Math.min(sweep.extreme, ez ? ez.lo : sweep.extreme) - buf : Math.max(sweep.extreme, ez ? ez.hi : sweep.extreme) + buf) : null;
  if (ez && ev) {
    const cs = T5.cs;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i]; if (c[0] <= ev.t && evTf === "M5") continue; if (c[0] < ev.t) continue;
      if (slLevel != null && (buy ? c[4] < slLevel : c[4] > slLevel)) { invalid = c[0]; break; }
      const overlap = c[2] >= ez.lo - 0.1 * a5 && c[3] <= ez.hi + 0.1 * a5;
      if (overlap) touched = true;
      if (overlap && (buy ? (c[4] > c[1] && c[4] > ez.mid) : (c[4] < c[1] && c[4] < ez.mid)) && i >= cs.length - 3) rej = { idx: i, t: c[0], close: c[4] };
    }
  }
  const live = price != null && ez && price >= ez.lo - 0.1 * a5 && price <= ez.hi + 0.1 * a5;
  // plan numbers
  let plan = null;
  if (ez && slLevel != null) {
    const entry = rej ? rej.close : ez.mid, risk = Math.abs(entry - slLevel);
    if (risk > 0.2) {
      const beyond = pools.filter(p => !p.swept && !p.live && (buy ? p.side === "BSL" && p.price > entry + 0.5 * risk : p.side === "SSL" && p.price < entry - 0.5 * risk))
        .sort((x, y) => buy ? x.price - y.price : y.price - x.price);
      const tps = [], used = [];
      for (const p of beyond) { if (used.some(u => Math.abs(u - p.price) < 0.5 * a5)) continue; used.push(p.price); tps.push({ price: p.price, src: p.label }); if (tps.length === 3) break; }
      const live2 = pools.filter(p => p.live && !p.swept && (buy ? p.side === "BSL" && p.price > entry + 0.5 * risk : p.side === "SSL" && p.price < entry - 0.5 * risk)).sort((x, y) => buy ? x.price - y.price : y.price - x.price);
      for (const p of live2) { if (tps.length >= 3) break; if (!used.some(u => Math.abs(u - p.price) < 0.5 * a5)) { tps.push({ price: p.price, src: p.label }); used.push(p.price); } }
      let m = 1; while (tps.length < 3) { const pr = entry + (buy ? 1 : -1) * (m + 1) * risk; if (!used.some(u => Math.abs(u - pr) < 0.5 * a5)) { tps.push({ price: pr, src: (m + 1) + "R (no further liquidity)", synthetic: true }); used.push(pr); } m++; if (m > 8) break; }
      tps.sort((x, y) => buy ? x.price - y.price : y.price - x.price);
      tps.forEach(t => { t.price = r2(t.price); t.rr = r2(Math.abs(t.price - entry) / risk); });
      plan = { entry: r2(entry), entryIsRejectionClose: !!rej, sl: r2(slLevel), risk: r2(risk), tps, rr: tps[1].rr, rr1: tps[0].rr, rr3: tps[2].rr };
    }
  }
  const rrOk = !!(plan && plan.rr >= 2 && plan.risk <= 2.2 * a15 && plan.risk >= 1.0);
  const pdPos = pd ? pd.pos : null;
  const pdOk = pdPos == null ? true : (buy ? pdPos <= 60 : pdPos >= 40);
  const newsOk = !(news && news.window && news.window.active);
  // checklist with the spec's weights
  item("h1", "H1 Bias aligned", 15, aligned, "H1 = " + bias);
  item("m15", "M15 Structure aligned", 15, aligned && m15al, "M15 trend " + T15.trend + (m15Ev ? " · last " + m15Ev.kind + " " + m15Ev.dir : ""));
  item("sweep", "Liquidity Sweep", 15, !!sweep, sweep ? sweep.label + " " + f2(sweep.price) + " (" + sweep.tf + ")" : "no sweep of " + (buy ? "sell-side" : "buy-side") + " liquidity near the zone");
  item("zone", "M15/H1 Zone", 10, !!zone, zone ? zone.tf + " " + zone.side + " " + f2(zone.lo) + "-" + f2(zone.hi) + " · " + zone.zst : "no unmitigated " + want.toLowerCase() + " nearby");
  item("disp", "Displacement", 10, dispOk, ev ? (ev.disp.ok ? "body " + ev.disp.x + "×ATR" : "weak move") : "none after sweep");
  item("bos", "BOS / CHoCH", 15, !!ev, ev ? evTf + " " + ev.kind + " " + ev.dir + " @ " + f2(ev.level) : "none after sweep");
  item("retest", "M5 Retest + rejection", 10, !!(touched && rej), rej ? "rejection candle closed " + f2(rej.close) : touched ? "retested, awaiting rejection close" : live ? "price inside entry zone now" : "no retest yet");
  item("rr", "Risk/Reward ≥ 1:2", 10, rrOk, plan ? "RR 1:" + plan.rr + " · risk " + plan.risk + "$" : "no plan yet");
  const score = R.items.reduce((s, i) => s + i.pts, 0);
  const mand = { h1: aligned, zone: !!zone, sweep: !!sweep, disp: dispOk, bos: !!ev, retest: !!(touched && rej), rr: rrOk, pd: pdOk, news: newsOk, fresh: fresh, notInvalid: !invalid };
  let stage = 0; if (aligned) { stage = 1; if (zone) { stage = 2; if (sweep) { stage = 3; if (dispOk && ev) { stage = 4; if (mand.retest && rrOk) stage = 5; } } } }
  const allMand = Object.values(mand).every(Boolean);
  let status = "NO_TRADE", missed = false;
  if (!aligned) status = "DISABLED";
  else if (invalid) status = "INVALIDATED";
  else if (allMand && score >= 70) {
    const moved = plan ? (buy ? price - plan.entry : plan.entry - price) : 0;
    if (plan && moved > 0.5 * plan.risk) { status = "WAIT"; missed = true; } else status = "VALID_ENTRY";
  } else if (zone || sweep) status = "WAIT";
  // wait-for text (IF / THEN)
  const lvl5 = (() => { const c = (T5.isw || []).filter(s => s.type === (buy ? "H" : "L") && (buy ? s.p > price : s.p < price)).sort((x, y) => buy ? x.p - y.p : y.p - x.p)[0]; return c ? c.p : null; })();
  let waitFor = "";
  if (!aligned) waitFor = "IF H1 prints a " + (buy ? "bullish" : "bearish") + " BOS/CHoCH THEN the " + side + " scenario is enabled. Until then counter-trend " + side + " is disabled.";
  else if (invalid) waitFor = "Scenario invalidated: M5 closed beyond " + f2(slLevel) + ". Looking for a new setup.";
  else if (!zone) waitFor = "IF price reaches an unmitigated " + (buy ? "demand" : "supply") + " zone THEN start watching for a liquidity sweep.";
  else if (!sweep) { const near = pools.filter(p => !p.swept && !p.live && p.side === (buy ? "SSL" : "BSL") && p.price >= zone.lo - 0.5 * a15 && p.price <= zone.hi + 0.5 * a15)[0]; waitFor = "IF price sweeps " + (near ? f2(near.price) + " (" + near.label + ")" : "liquidity " + (buy ? "below " + f2(zone.lo) : "above " + f2(zone.hi))) + " and an M5 candle closes back " + (buy ? "above" : "below") + " it THEN look for displacement."; }
  else if (!ev || !dispOk) waitFor = "IF M5 shows " + (buy ? "bullish" : "bearish") + " displacement and closes " + (buy ? "above " : "below ") + (lvl5 ? f2(lvl5) : "the last internal swing") + " (" + (buy ? "bullish" : "bearish") + " BOS) THEN wait for the retest.";
  else if (!(touched && rej)) waitFor = missed ? "Entry zone passed. Wait for a new retest." : "IF price retests " + f2(ez.lo) + "–" + f2(ez.hi) + " (" + ez.parts.join(" + ") + ") and an M5 candle closes " + (buy ? "above " : "below ") + f2(ez.mid) + " THEN " + side + " becomes valid.";
  else if (!rrOk) waitFor = "RR is " + (plan ? "1:" + plan.rr : "unknown") + " (< 1:2) or the stop is too wide/narrow. Skip this setup.";
  else if (!newsOk) waitFor = "High-impact news window. Wait until " + (news.window.event ? news.window.event.title : "the release") + " passes.";
  else if (!pdOk) waitFor = (buy ? "BUY in premium" : "SELL in discount") + " is filtered out. Wait for a better location.";
  if (status === "VALID_ENTRY") waitFor = "";
  R.ifThen = [];
  if (plan) { R.ifThen.push("IF price " + (buy ? "closes an M15 candle below " : "closes an M15 candle above ") + f2(plan.sl) + " THEN the " + side + " scenario is invalid."); }
  Object.assign(R, { aligned, zoneObj: zone, evObj: ev && { kind: ev.kind, dir: ev.dir, level: ev.level, tf: evTf, t: ev.t, retest: ev.retest, disp: ev.disp }, entryZone: ez, rej, touched, plan, score, grade: GRADE(score), mand, stage, status, missed, waitFor, invalidation: plan ? plan.sl : slLevel, invalidT: invalid, invalidationText: slLevel == null ? null : (buy ? "M15 closes below " : "M15 closes above ") + f2(slLevel), livePriceInZone: !!live, newsWarn: !(news && news.ok) });
  return R;
}

/* ---------- news ---------- */
function newsWindow(news, nowS) {
  if (!news || !news.ok || !news.events) return { active: false, event: null };
  const ev = news.events.filter(e => e.impact === "High" && nowS - e.t <= 900 && e.t - nowS <= 1800).sort((a, b) => a.t - b.t)[0];
  return ev ? { active: true, event: ev, minsTo: Math.round((ev.t - nowS) / 60) } : { active: false, event: null };
}
function newsInfo(e) {
  const t = (e.title || "").toLowerCase();
  const inv = /unemployment|jobless|claims/.test(t);
  if (/fomc|powell|fed |federal funds|interest rate|rate decision|speaks|testifies/.test(t))
    return { effect: "Volatility spike; direction depends on tone. IF hawkish THEN gold tends to fall; IF dovish THEN gold tends to rise.", advice: "Avoid opening a scalp from 30 min before until 15 min after." };
  if (/cpi|ppi|pce|non-farm|nfp|employment|payroll|retail sales|gdp|ism|durable|consumer|sentiment|housing|trade balance/.test(t))
    return { effect: inv ? "IF actual is above forecast THEN USD weakens and gold tends to rise; IF below THEN gold tends to fall." : "IF actual is above forecast THEN USD and yields rise and gold tends to fall; IF below THEN gold tends to rise.", advice: e.impact === "High" ? "Avoid opening a scalp immediately before release; expect a volatility spike." : "Trade with caution around the release." };
  return { effect: "Effect on gold depends on the surprise versus forecast.", advice: e.impact === "High" ? "Avoid opening a scalp immediately before release." : "Trade with caution." };
}

/* ---------- main ---------- */
function analyze(opts) {
  const m1 = opts.m1 || [], nowS = opts.nowS || Math.floor(Date.now() / 1000);
  const news = opts.news ? Object.assign({}, opts.news, { window: newsWindow(opts.news, nowS) }) : null;
  const out = { engine: "xau-smc-1", now: nowS, status: "NO_DATA", signal: null, reasons: [], marketClosed: marketClosed(nowS * 1000) };
  if (!m1.length) { out.reasons.push("NO CANDLE DATA"); return out; }
  const last = m1[m1.length - 1], price = opts.price != null ? opts.price : last[4];
  out.price = price; out.lastT = last[0]; out.dataAge = nowS - last[0];
  const T5 = tfAnalysis(m1, "M5", nowS), T15 = tfAnalysis(m1, "M15", nowS), T1 = tfAnalysis(m1, "H1", nowS);
  out.progress = { H1: [T1.have, T1.need], M15: [T15.have, T15.need], M5: [T5.have, T5.need] };
  out.atr = { H1: r2(T1.atr), M15: r2(T15.atr), M5: r2(T5.atr) };
  const brief = T => ({ tf: T.tf, trend: T.trend, atr: r2(T.atr), have: T.have, swings: T.sw.slice(-6).map(s => ({ type: s.type, lab: s.lab, p: r2(s.p), t: s.t })), pending: T.pending ? { type: T.pending.type, p: r2(T.pending.p), t: T.pending.t } : null, events: (T.ievents || T.events).slice(-5).map(e => ({ kind: e.kind, dir: e.dir, level: e.level, t: e.t, retest: e.retest, disp: e.disp.ok ? "STRONG" : "WEAK" })), fvg: T.fvg.filter(g => g.state !== "filled").slice(-4), zones: T.obs.filter(o => o.state !== "mitigated").slice(-3) });
  out.h1 = brief(T1); out.m15 = brief(T15); out.m5 = brief(T5);
  out.fresh = !(!out.marketClosed && out.dataAge > 900);
  if (!T1.ready || !T15.ready || !T5.ready) { out.status = "NO_DATA"; out.reasons.push("Collecting candles: H1 " + T1.have + "/" + T1.need + " · M15 " + T15.have + "/" + T15.need + " · M5 " + T5.have + "/" + T5.need); return out; }
  // bias
  const why = [], lastEv = T1.events[T1.events.length - 1];
  let bias = T1.trend === "UP" ? "BULLISH" : T1.trend === "DOWN" ? "BEARISH" : "NEUTRAL";
  const hh = T1.sw.filter(s => s.type === "H").slice(-2), ll = T1.sw.filter(s => s.type === "L").slice(-2);
  if (hh.length === 2 && ll.length === 2) why.push("H1 swings: highs " + f2(hh[0].p) + "→" + f2(hh[1].p) + " (" + (hh[1].lab || "-") + "), lows " + f2(ll[0].p) + "→" + f2(ll[1].p) + " (" + (ll[1].lab || "-") + ")");
  if (lastEv) why.push("Last H1 " + lastEv.kind + " " + (lastEv.dir === "BULL" ? "bullish" : "bearish") + " @ " + f2(lastEv.level));
  if (lastEv && lastEv.kind === "CHoCH" && T1.cs.length - 1 - lastEv.idx <= 12 && ((lastEv.dir === "BULL" && bias !== "BULLISH") || (lastEv.dir === "BEAR" && bias !== "BEARISH"))) { bias = "NEUTRAL"; why.push("Recent H1 CHoCH against the old trend: reversal not yet confirmed by a BOS, so the bias is NEUTRAL."); }
  out.h1.bias = bias; out.h1.why = why;
  // pools, sweeps, premium/discount
  const P = buildPools(m1, T5, T15, T1, nowS); out.pools = P.pools.map(p => ({ key: p.key, kind: p.kind, label: p.label, price: p.price, side: p.side, t: p.t, live: p.live, swept: p.swept })).sort((x, y) => y.price - x.price);
  out.sessions = P.sessions; out.pdAvailable = P.pdAvailable;
  const sweeps = findSweeps(P.pools, [T5, T15], nowS); out.sweeps = sweeps.slice(0, 5);
  let pd = null;
  { const H = [T1.sw.filter(s => s.type === "H").pop(), T1.pending && T1.pending.type === "H" ? T1.pending : null].filter(Boolean).map(s => s.p), L = [T1.sw.filter(s => s.type === "L").pop(), T1.pending && T1.pending.type === "L" ? T1.pending : null].filter(Boolean).map(s => s.p);
    if (H.length && L.length) { const hi = Math.max(...H), lo = Math.min(...L); if (hi > lo) { const pos = (price - lo) / (hi - lo) * 100; pd = { hi: r2(hi), lo: r2(lo), mid: r2((hi + lo) / 2), pos: Math.round(pos * 10) / 10, zone: pos > 55 ? "PREMIUM" : pos < 45 ? "DISCOUNT" : "EQUILIBRIUM" }; } } }
  out.pd = pd;
  const C = { T5, T15, T1, pools: P.pools, sweeps, price, bias, pd, news, nowS, fresh: out.fresh };
  out.scenarios = { BUY: evalSide("BUY", C), SELL: evalSide("SELL", C) };
  // regime + sessions label
  out.regime = bias === "BULLISH" ? "Bullish" : bias === "BEARISH" ? "Bearish" : "Range";
  // primary scenario and final status
  const al = ["BUY", "SELL"].filter(s => out.scenarios[s].aligned).map(s => out.scenarios[s]);
  const prim = al.sort((x, y) => y.stage - x.stage || y.score - x.score)[0] || null; out.primary = prim ? prim.side : null;
  const nt = out.reasons;
  if (out.marketClosed) nt.push("Market closed");
  if (!out.fresh) nt.push("DATA STALE: last candle " + Math.round(out.dataAge / 60) + " min ago");
  if (bias === "NEUTRAL") nt.push(T15.trend !== "RANGE" ? "Conflicting H1/M15 structure: H1 neutral while M15 trends " + T15.trend : "H1 structure unclear (neutral)");
  if (news && news.window && news.window.active) nt.push("High-impact news approaching: " + (news.window.event ? news.window.event.title : ""));
  if (prim && prim.status === "INVALIDATED") nt.push("Scenario invalidated");
  if (prim && !prim.sweep && prim.stage >= 2) nt.push("No liquidity event yet");
  if (prim && prim.plan && !(prim.plan.rr >= 2)) nt.push("Poor RR (1:" + prim.plan.rr + ")");
  if (pd && pd.zone === "EQUILIBRIUM" && prim && prim.stage < 2) nt.push("Price in the middle of the range (" + pd.pos + "%)");
  if (prim && prim.stage >= 2 && !prim.mand.retest && prim.stage < 5) nt.push("No M5 confirmation");
  if (prim && prim.status === "VALID_ENTRY" && out.fresh && !out.marketClosed) { out.status = "VALID_ENTRY"; out.signal = prim.side; out.reasons = []; }
  else if (prim && (prim.status === "WAIT") && prim.stage >= 2 && out.fresh && !out.marketClosed) { out.status = "WAIT"; out.reasons = []; }
  else out.status = "NO_TRADE";
  out.waitFor = prim ? prim.waitFor : "";
  out.stageName = ["NEUTRAL", "BIAS DETECTED", "ZONE APPROACHED", "LIQUIDITY EVENT", "M5 CONFIRMATION", "ENTRY VALID"][prim ? prim.stage : 0];
  return out;
}
function candlesFor(m1, tf, nowS) { const b = build(m1, SEC[tf], tf === "M1" ? 1 : COVER[tf], nowS); return b.forming ? b.done.concat([b.forming]) : b.done; }
return { analyze, newsWindow, newsInfo, build, candlesFor, tfAnalysis, zigzag, trendOf, atrOf, SEC, NEED, marketClosed, GRADE };
});

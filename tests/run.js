/* Engine + agent tests. Run: node tests/run.js  (exit code 1 on failure). All data is synthetic test fixtures. */
const E = require("../engine.js"), S = require("./scenarios.js"), R = require("../run_engine.js");
let pass = 0, fail = 0; const fails = [];
function t(name, fn) { try { fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; fails.push(name); console.log("  ✗", name, "\n     ", e.message); } }
const eq = (a, b, m) => { if (a !== b) throw new Error((m || "") + " expected " + JSON.stringify(b) + " got " + JSON.stringify(a)); };
const ok = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };
const has = (arr, re, m) => ok(arr.some(x => re.test(x)), (m || "missing") + ": " + re + " in " + JSON.stringify(arr));
const run = (m1, minute, extra) => E.analyze(S.at(m1, minute, extra));

console.log("Decision scenarios");
t("SELL A+ : sweep → bearish displacement → M15 BOS → FVG/OB → retest → M5 confirmation", () => {
  const a = run(S.sellA(), 1771), d = a.decision;
  eq(d.decision, "SELL"); eq(d.grade, "A+"); ok(d.confidence >= 90, "confidence " + d.confidence);
  eq(d.bias.h1, "BEARISH"); eq(d.bias.m15, "BEARISH"); eq(d.bias.m5, "BEARISH");
  ok(d.setup.liquiditySweep && d.setup.bos && d.setup.displacement && d.setup.retest && d.setup.m5Confirmation, "setup flags " + JSON.stringify(d.setup));
  ok(d.entry.zoneLow < d.entry.zoneHigh, "zone"); ok(d.entry.aggressive === d.entry.zoneLow && d.entry.conservative === d.entry.zoneHigh, "sell entries: aggressive at the low edge");
  ok(d.risk.stopLoss > d.entry.zoneHigh, "SL above the zone"); ok(d.risk.tp1 > d.risk.tp2 && d.risk.tp2 > d.risk.tp3 && d.risk.tp1 < d.entry.zoneLow, "targets descend below entry");
  ok(d.risk.mainRR >= 2, "RR " + d.risk.mainRR); ok(d.invalidation === d.risk.stopLoss, "invalidation");
  ok(/SELL — A\+ SETUP/.test(a.explanation), "explanation text");
});
t("BUY A+ : mirror of the SELL scenario", () => {
  const d = run(S.buyA(), 1771).decision;
  eq(d.decision, "BUY"); eq(d.grade, "A+"); ok(d.risk.stopLoss < d.entry.zoneLow, "SL below the zone");
  ok(d.entry.aggressive === d.entry.zoneHigh && d.entry.conservative === d.entry.zoneLow, "buy entries: aggressive at the top edge");
  ok(d.risk.tp1 > d.entry.zoneHigh && d.risk.tp1 < d.risk.tp2 && d.risk.tp2 < d.risk.tp3, "targets ascend above entry");
});
t("FALSE BREAKOUT : wick-only break, close back → NO TRADE", () => {
  const a = run(S.falseBreakout(), 1745); eq(a.decision.decision, "NO_TRADE"); has(a.reasons, /False breakout/);
});
t("NO LIQUIDITY : price away from any zone → WAIT", () => {
  const a = run(S.noLiquidity(), 1670); eq(a.decision.decision, "WAIT"); eq(a.decision.entry, null, "no entry shown"); has(a.reasons, /No A\+ setup/);
});
t("NEWS : high-impact release in 18 minutes → WAIT / HIGH NEWS RISK", () => {
  const m1 = S.sellA(), now = S.T0 + 1771 * 60 + 30;
  const a = run(m1, 1771, { news: { ok: true, fetched: now, events: [{ t: now + 18 * 60, title: "CPI m/m", impact: "High" }] } });
  eq(a.decision.decision, "WAIT"); eq(a.news.risk, "HIGH"); has(a.reasons, /HIGH NEWS RISK.*CPI.*NO NEW TRADE/); eq(a.regimeInfo.primary, "NEWS_MODE");
  eq(a.decision.news.upcomingEvent.minsTo, 18);
});
t("NEWS (after release) : a sweep that happened BEFORE the release does not count → WAIT", () => {
  const now = S.T0 + 1771 * 60 + 30, news = { ok: true, fetched: now, events: [{ t: now - 20 * 60, title: "Core PCE", impact: "High" }] };   // release at 1751, sweep at 1715
  const a = run(S.sellA(), 1771, { news }); eq(a.decision.decision, "WAIT"); eq(a.news.risk, "MEDIUM"); has(a.reasons, /Post-news window \(Core PCE\)/); has([a.waitFor], /Post-news: wait for a liquidity sweep AFTER Core PCE/);
});
t("NEWS (after release) : the sweep came AFTER the release → setup allowed, with a medium-risk penalty", () => {
  const now = S.T0 + 1771 * 60 + 30, base = run(S.sellA(), 1771).decision.confidence, news = { ok: true, fetched: now, events: [{ t: now - 65 * 60, title: "Core PCE", impact: "High" }] };   // release at 1706, sweep at 1715
  const a = run(S.sellA(), 1771, { news }); eq(a.decision.decision, "SELL"); ok(a.decision.confidence < base, "penalty " + a.decision.confidence + " < " + base);
});
t("CONFLICT : H1 bullish / M15 bearish → WAIT", () => {
  const a = run(S.conflict(), 1715), c = a.decision.conflict; eq(a.decision.decision, "WAIT");
  ok(c && c.h1 === "BULLISH" && c.m15 === "BEARISH" && c.action === "WAIT", "conflict " + JSON.stringify(c)); has([c.reason], /has not confirmed the H1 bullish continuation/);
});
t("LOW RR : minimum RR not met → NO TRADE", () => {
  const a = run(S.sellA(), 1771, { config: { minRR: 4 } }); eq(a.decision.decision, "NO_TRADE"); has(a.reasons, /Poor RR/);
});
t("QUALITY FILTER : B/C setups never become signals", () => {
  const a = run(S.sellA(), 1771, { config: { grades: { aplus: 99, a: 99, b: 70 } } }); eq(a.decision.decision, "WAIT"); has(a.reasons, /Quality filter/);
});
t("MINIMUM GRADE can be raised to A+ in config", () => {
  eq(run(S.sellA(), 1771, { config: { minGrade: "A+" } }).decision.decision, "SELL");
  eq(run(S.sellA(), 1771, { config: { minGrade: "A+", grades: { aplus: 99, a: 80 } } }).decision.decision, "WAIT");
});
t("DATA STALE : analysis paused, no signal", () => {
  const m1 = S.sellA(), a = E.analyze({ m1, nowS: m1[m1.length - 1][0] + 40 * 60, news: { ok: true, events: [] } });
  eq(a.status, "DATA_STALE"); eq(a.decision.decision, "WAIT"); eq(a.decision.entry, null); has(a.reasons, /DATA STALE — ANALYSIS PAUSED/);
});
t("NEWS DATA UNAVAILABLE is reported, never invented", () => {
  const w = E.analyze(Object.assign(S.at(S.noLiquidity(), 1670), { news: null })); eq(w.news.available, false); has(w.reasons, /NEWS DATA UNAVAILABLE/);
  const v = E.analyze(Object.assign(S.at(S.sellA(), 1771), { news: null })); eq(v.decision.decision, "SELL"); has(v.decision.warnings, /NEWS DATA UNAVAILABLE/, "warning stays visible with a valid signal"); has(v.decision.reasonsDetailed || v.decision.reasons, /NEWS DATA UNAVAILABLE/);
});
t("DXY / yields act as a modifier only (cannot create a signal)", () => {
  const good = run(S.sellA(), 1771, { macro: { dxy: "down", yield: "down" } }), bad = run(S.sellA(), 1771, { macro: { dxy: "up", yield: "up" } });
  ok(good.scenarios.SELL.confidence > bad.scenarios.SELL.confidence, "agreeing macro scores higher: " + good.scenarios.SELL.confidence + " vs " + bad.scenarios.SELL.confidence); ok(bad.scenarios.SELL.modifiers.some(m => /DXY/.test(m.label)), "modifier is listed");
  const flat = run(S.noLiquidity(), 1670, { macro: { dxy: "down", yield: "down" } }); eq(flat.decision.decision, "WAIT");
  ok(E.macroFromDrivers([{ n: "الدولار (مؤشر DXY)", s: "down" }, { n: "عائد السندات 10 سنين", s: "flat" }]).dxy === "down", "macro mapping");
});

console.log("No repainting / confirmed vs forming");
t("analysis at time T is identical with or without future candles", () => {
  const m1 = S.sellA(); let n = 0;
  for (let m = 1700; m <= 1775; m += 5) {
    const cut = m1.filter(r => r[0] < S.T0 + m * 60), last = cut[cut.length - 1][4];
    const a = E.analyze({ m1: cut, nowS: S.T0 + m * 60 + 20, news: { ok: true, events: [] } }), b = E.analyze({ m1, nowS: S.T0 + m * 60 + 20, price: last, news: { ok: true, events: [] } });
    const key = x => JSON.stringify([x.decision.decision, x.stageName, x.primary && x.scenarios[x.primary].confidence, x.primary && x.scenarios[x.primary].plan && x.scenarios[x.primary].plan.entry, x.h1.bias, x.m15.events.length, x.m5.events.length]);
    eq(key(b), key(a), "minute " + m); n++;
  }
  ok(n > 10);
});
t("an M15 BOS is not confirmed until its candle closes", () => {
  const m1 = S.sellA(), bear = a => a.m15.events.filter(e => e.dir === "BEAR" && e.t >= S.T0 + 1710 * 60 && e.valid);
  eq(bear(E.analyze({ m1: m1.filter(r => r[0] < S.T0 + 1724 * 60 + 50), nowS: S.T0 + 1724 * 60 + 55, news: { ok: true, events: [] } })).length, 0, "forming candle");
  ok(bear(E.analyze({ m1: m1.filter(r => r[0] < S.T0 + 1741 * 60), nowS: S.T0 + 1741 * 60 + 5, news: { ok: true, events: [] } })).length > 0, "after the M15 candle (1725-1740) closed");
});
t("the forming candle is reported separately as unconfirmed", () => {
  const a = run(S.sellA(), 1771), f = a.m5.forming; ok(f && f.confirmed === false, "forming flag"); ok(a.m5.events.every(e => e.confirmed === true), "events confirmed");
});

console.log("Data quality, config, debug");
t("duplicate, unsorted and invalid candles are cleaned", () => {
  const m1 = S.sellA(), dirty = m1.concat([m1[100].slice(), [m1[200][0], 0, 0, 0, 0, 1], [m1[300][0] + 5, 4100, 4090, 4110, 4100, 1]]).reverse();
  const a = E.analyze({ m1: dirty.filter(r => r[0] < S.T0 + 1771 * 60), nowS: S.T0 + 1771 * 60 + 30, news: { ok: true, events: [] } });
  ok(a.dataQuality.duplicates >= 1 && a.dataQuality.invalid >= 1 && a.dataQuality.unsorted >= 1, JSON.stringify(a.dataQuality)); eq(a.decision.decision, "SELL");
});
t("missing candles are detected", () => {
  const m1 = S.sellA().filter(r => !(r[0] >= S.T0 + 900 * 60 && r[0] < S.T0 + 960 * 60)), a = run(m1, 1771); ok(a.dataQuality.maxGapMin >= 60, "gap " + a.dataQuality.maxGapMin); has(a.dataQuality.issues, /gap of/);
});
t("DEBUG_ENGINE prints pass/fail for every condition", () => {
  const a = E.analyze(Object.assign(S.at(S.noLiquidity(), 1670), { debug: true })); ok(a.debug && a.debug.some(l => /^H1 Bias \.+ /.test(l)) && a.debug[a.debug.length - 1] === "FINAL: WAIT", JSON.stringify(a.debug));
  eq(run(S.sellA(), 1771).debug, undefined, "debug off by default");
});
t("configurable weights change the score but not the mandatory rules", () => {
  const a = run(S.sellA(), 1771, { config: { weights: { h1: 5, sweep: 5, m15: 5, disp: 5, fvgob: 5, pd: 5, m5: 5, rr: 5 } } }); ok(a.scenarios.SELL.entryScore <= 40, "score " + a.scenarios.SELL.entryScore); eq(a.decision.decision, "WAIT");
});
t("signal setupId is stable for the same setup (cooldown / dedupe key)", () => {
  const a = run(S.sellA(), 1771).decision.setupId, b = run(S.sellA(), 1775).decision.setupId; ok(a && a === b, a + " vs " + b);
});

console.log("Agent state machine (journal, TP/SL, cooldown)");
function lifecycle(tail, label) {
  const wp = null; const m1 = S.custom(tail); const st = { stage: "NEUTRAL", scenario: null, trade: null, cooldownUntil: 0, seen: {} }, journal = [], ev = [];
  for (let min = 1500; min <= m1.length - 1; min += 5) { const now = S.T0 + min * 60 + 20, rows = m1.filter(r => r[0] < now - 20), an = E.analyze({ m1: rows, nowS: now, news: { ok: true, events: [] } }); R.step(st, an, rows, now, journal, { ok: true, events: [] }).forEach(e => ev.push(e.type)); }
  return { st, journal, ev };
}
t("WIN : ENTRY_VALID → TP1 → TP2 → TP3, journal closed with positive R", () => {
  const r = lifecycle([[1790, 4160], [1805, 4150], [1820, 4144], [1840, 4134]]); const j = r.journal[0];
  ok(r.ev.includes("ENTRY_VALID") && r.ev.includes("TP1_HIT") && r.ev.includes("TP2_HIT"), r.ev.join(",")); ok(j && j.status === "CLOSED" && j.r > 0, JSON.stringify(j && { s: j.status, r: j.r })); eq(r.journal.length, 1, "one trade only");
});
t("LOSS : stop loss hit, journal R = -1, no second signal for the same setup", () => {
  const r = lifecycle([[1780, 4180], [1790, 4187], [1800, 4188], [1830, 4180], [1860, 4176], [1890, 4172.4]]); const j = r.journal[0];
  ok(j && j.status === "CLOSED" && j.result === "SL" && j.r === -1, JSON.stringify(j && { s: j.status, res: j.result, r: j.r })); ok(r.ev.includes("SL_HIT")); eq(r.journal.length, 1, "no repeated signal");
});
t("COOLDOWN / DEDUPE : the same setup is never opened twice, even after the trade closed", () => {
  const m1 = S.sellA(), now = S.T0 + 1771 * 60 + 30, an = E.analyze({ m1, nowS: now, news: { ok: true, events: [] } });
  const st = { stage: "NEUTRAL", scenario: null, trade: null, cooldownUntil: 0, seen: {} }, journal = [];
  const first = R.step(st, an, m1.filter(r => r[0] <= now), now, journal, { ok: true, events: [] }).map(e => e.type); ok(first.includes("ENTRY_VALID"), first.join(","));
  st.trade.status = "CLOSED"; st.trade.result = "SL"; st.trade.r = -1; st.stage = "COMPLETED"; st.scenario = null; st.cooldownUntil = 0;     // trade over, cooldown elapsed
  const again = R.step(st, an, m1.filter(r => r[0] <= now), now + 3600, journal, { ok: true, events: [] }).map(e => e.type);
  ok(!again.includes("ENTRY_VALID"), "duplicate signal: " + again.join(",")); eq(journal.length, 1, "journal"); ok(st.suppressed && st.suppressed.setupId === an.decision.setupId, "suppressed marker");
  ok(st.lastSignal && st.lastSignal.setupId === an.decision.setupId, "lastSignal stored");
});
t("COOLDOWN : after a closed trade no new scenario for 45 minutes", () => {
  const m1 = S.sellA(), now = S.T0 + 1771 * 60 + 30, an = E.analyze({ m1, nowS: now, news: { ok: true, events: [] } }), j = [];
  const st = { stage: "NEUTRAL", scenario: null, trade: null, cooldownUntil: 0, seen: {} };
  R.step(st, an, m1.filter(r => r[0] <= now), now, j, { ok: true, events: [] });
  const rows = m1.filter(r => r[0] <= now).concat([[now + 60, 4190, 4192, 4189, 4191, 6]]);   // price squeezes through the stop
  R.step(st, an, rows, now + 120, j, { ok: true, events: [] }); eq(st.trade.status, "CLOSED"); ok(st.cooldownUntil >= st.lastSignal.t + 45 * 60, "cooldown " + (st.cooldownUntil - st.lastSignal.t));
});
console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) { console.log("FAILED: " + fails.join(" | ")); process.exit(1); }

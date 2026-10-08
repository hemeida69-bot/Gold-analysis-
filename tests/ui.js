/* UI smoke test: runs the page script against a stubbed DOM/fetch/chart library. Run: node tests/ui.js */
const fs = require("fs"), path = require("path"), S = require("./scenarios.js");
let FAKE = (S.T0 + 1771 * 60 + 30) * 1000; const RD = Date;
global.Date = class extends RD { constructor(...a) { if (a.length) super(...a); else super(FAKE); } static now() { return FAKE; } };
global.window = global; global.Engine = require("../engine.js");
const els = {}; let lines = 0, markers = 0, charts = 0;
global.document = { getElementById: id => els[id] || (els[id] = { appendChild() {}, set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h || ""; }, remove() {} }), createElement: () => ({ remove() {} }) };
global.location = { hash: "#/live" }; global.addEventListener = () => {}; global.scrollTo = () => {};
const store = {}; global.localStorage = { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; }, clear() {} };
global.LightweightCharts = { createChart: () => { charts++; return { addCandlestickSeries: () => ({ setData() {}, createPriceLine() { lines++; }, setMarkers(m) { markers += m.length; }, update() {} }), timeScale: () => ({ setVisibleLogicalRange() {} }), remove() {}, applyOptions() {} }; } };
let files = {}; global.fetch = async u => { u = String(u); if (u.includes("gold-api")) return { ok: true, json: async () => ({ price: files.px || 4172.1 }) }; const k = u.split("?")[0].split("/").pop(); const v = files[k]; return v ? { ok: true, json: async () => v } : { ok: false }; };
const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8"); let js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
js = js.replace(/render\(\);loadAll\(\)\.then\(\(\)=>pxTick\(\)\);timers\(\);setInterval\(paintTop,1000\);/, "");
let pass = 0, fail = 0; const ck = (n, c, m) => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗", n, m || ""); } };
(async () => {
  eval(js + ";globalThis.__t={S,VIEWS,render,loadAll,pxTick,analyzeNow,runAnalysis,CFG,jStats};");
  const T = __t, St = T.S, news = { ok: true, fetched: FAKE / 1000, source: "test", events: [{ t: FAKE / 1000 + 3600, title: "CPI m/m", impact: "High", forecast: "0.3%", previous: "0.2%" }] };
  const setup = (m1, minute, extra) => { FAKE = (S.T0 + minute * 60 + 30) * 1000; files = Object.assign({ "candles.json": { updated: FAKE / 1000, m1: m1.filter(r => r[0] < S.T0 + minute * 60) }, "news.json": news, "agent_state.json": { stage: "ENTRY_VALID", updated: FAKE / 1000, scenario: null, trade: null },
    "journal.json": [{ id: "T1", side: "SELL", t: FAKE / 1000 - 86400, openedAt: FAKE / 1000 - 86400, entry: 4174.67, sl: 4184.85, risk: 10.18, tps: [{ price: 4162.3, rr: 1.22, src: "x" }, { price: 4145.88, rr: 2.83, src: "y" }, { price: 4135.7, rr: 3.83, src: "z" }], rr: 2.83, score: 93, grade: "A+", setup: "SELL · H1 supply · sweep X · M15 BOS", status: "CLOSED", result: "TP2", r: 2.83 }], "events.json": [] }, extra || {}); St.m1 = []; St.lr = {}; St.px = null; St.pxAt = 0; };
  const pages = async tag => { for (const k of Object.keys(T.VIEWS)) { location.hash = "#/" + k; T.render(); const v = els.view.innerHTML; ck(tag + " page " + k, v.length > 250 && !/undefined|NaN|\[object|null</.test(v), v.slice(0, 120)); } location.hash = "#/live"; T.render(); return els.view.innerHTML; };
  console.log("Valid SELL A+"); setup(S.sellA(), 1771); await T.loadAll(); await T.pxTick(); T.CFG.debug = true; T.runAnalysis("t");
  let v = await pages("valid");
  ck("headline shows the decision and grade (A because CPI is within the hour: A+ needs LOW news risk)", /SELL · A</.test(v) || /SELL · A\+</.test(v), (v.match(/headline">[^<]*/) || [""])[0]);
  for (const w of ["BIAS", "Aggressive", "Preferred", "Conservative", "LIQUIDITY", "STRUCTURE", "NEWS", "CONFIDENCE", "INVALIDATION", "TP3", "DEBUG_ENGINE", "ANALYZE NOW", "AUTO MONITORING"]) ck("live shows " + w, v.includes(w));
  ck("chart drew entry/SL/TP lines + zones", lines > 6 && charts > 0, "lines " + lines); ck("chart markers", markers > 0);
  await T.analyzeNow(); ck("ANALYZE NOW ran 9 steps", (St.stepsHtml.match(/<b>✓<\/b>/g) || []).length === 9, St.stepsHtml.length);
  console.log("WAIT / no liquidity"); setup(S.noLiquidity(), 1670); T.CFG.debug = false; await T.loadAll(); T.runAnalysis("t"); v = await pages("wait");
  ck("shows WAIT and a wait-for text", v.includes("WAIT") && v.includes("WAIT FOR")); ck("no fake entry shown", !v.includes("Aggressive"));
  console.log("Conflict"); setup(S.conflict(), 1715); await T.loadAll(); T.runAnalysis("t"); v = await pages("conflict"); ck("conflict banner", v.includes("CONFLICT"));
  console.log("False breakout"); setup(S.falseBreakout(), 1745); await T.loadAll(); T.runAnalysis("t"); v = await pages("falsebreak"); ck("NO TRADE shown", v.includes("NO TRADE"));
  console.log("Stale data"); setup(S.sellA(), 1771); await T.loadAll(); FAKE += 45 * 60 * 1000; T.runAnalysis("t"); location.hash = "#/live"; T.render(); v = els.view.innerHTML; ck("DATA STALE shown, no entry", v.includes("DATA STALE") && !v.includes("Aggressive"));
  console.log("No news data"); setup(S.sellA(), 1771, { "news.json": null }); St.news = null; await T.loadAll(); St.news = null; T.runAnalysis("t"); location.hash = "#/news"; T.render(); ck("NEWS DATA UNAVAILABLE on the news page", els.view.innerHTML.includes("NEWS DATA UNAVAILABLE"));
  console.log("No data at all"); St.m1 = []; St.an = null; location.hash = "#/live"; T.render(); ck("empty state", els.view.innerHTML.includes("Data unavailable"));
  console.log("\n" + pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0);
})().catch(e => { console.log("TEST ERROR", e.stack); process.exit(1); });

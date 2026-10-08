/* Server-side agent: runs the engine on the collected candles, keeps the signal state machine, journal, alerts and news. */
const fs = require("fs");
const E = require("./engine.js");
const rd = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return d; } };
const wr = (p, o) => fs.writeFileSync(p, JSON.stringify(o));
const f2 = x => (x == null ? "-" : (Math.round(x * 100) / 100).toFixed(2));
const SCEN_TTL = 6 * 3600, TRADE_TTL = 8 * 3600, SIGNAL_COOLDOWN = 45 * 60;   // after a signal: no new signal for 45 min unless a materially different setup (new setupId) appears after it

async function fetchNews(old, now) {
  if (old && old.ok && now - old.fetched < 3300) return old;
  try {
    const r = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", { headers: { "User-Agent": "Mozilla/5.0 gold-analysis/1.0" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const events = j.filter(e => e.country === "USD" && (e.impact === "High" || e.impact === "Medium")).map(e => ({ t: Math.floor(Date.parse(e.date) / 1000), title: e.title, impact: e.impact, forecast: e.forecast || null, previous: e.previous || null })).filter(e => e.t > 0).sort((a, b) => a.t - b.t);
    return { ok: true, fetched: now, source: "faireconomy.media (ForexFactory weekly calendar)", events };
  } catch (e) {
    console.log("news fetch failed:", e.message);
    return old && old.events ? Object.assign({}, old, { ok: now - old.fetched < 6 * 3600, stale: true }) : { ok: false, fetched: now, events: [] };
  }
}

function updateTrade(tr, m1, now, emit) {
  const sell = tr.side === "SELL", [t1, t2, t3] = tr.tps;
  const hitP = (c, p) => sell ? c[3] <= p : c[2] >= p;
  const close = (res, t) => { tr.status = "CLOSED"; tr.result = res; tr.closedT = t; tr.maxTp = tr.maxTp || 0; tr.r = res === "SL" ? -1 : (tr.maxTp ? tr.tps[tr.maxTp - 1].rr : 0); };
  tr.hit = tr.hit || {};
  for (const c of m1) {
    if (c[0] < tr.t || tr.status === "CLOSED") continue;
    if (!tr.hit.tp1 || c[0] <= tr.hit.tp1) {
      if (sell ? c[2] >= tr.sl : c[3] <= tr.sl) { close("SL", c[0]); emit("SL_HIT", tr, "Stop loss hit at " + f2(tr.sl), tr.id + ":SL"); break; }
    } else if (sell ? c[2] >= tr.entry : c[3] <= tr.entry) { close("TP" + tr.maxTp + " then breakeven", c[0]); emit("BREAKEVEN_EXIT", tr, "Price returned to entry after TP" + tr.maxTp + " (breakeven stop)", tr.id + ":BE"); break; }
    [[1, t1], [2, t2], [3, t3]].forEach(([n, tp]) => { if (!tr.hit["tp" + n] && (n === 1 || tr.hit["tp" + (n - 1)]) && hitP(c, tp.price)) { tr.hit["tp" + n] = c[0]; tr.maxTp = n; emit("TP" + n + "_HIT", tr, "TP" + n + " hit at " + f2(tp.price) + " (" + tp.rr + "R)", tr.id + ":TP" + n); } });
    if (tr.hit.tp3) { close("TP3", c[0]); break; }
  }
  if (tr.status === "OPEN" && now - tr.t > TRADE_TTL) { close(tr.maxTp ? "TP" + tr.maxTp + " (expired)" : "EXPIRED", now); emit("TRADE_EXPIRED", tr, "Trade expired after 8h", tr.id + ":EXP"); }
}

function step(st, an, m1, now, journal, news) {
  const events = [];
  st.seen = st.seen || {};
  const emit = (type, o, msg, key) => { if (st.seen[key]) return; st.seen[key] = now; events.push({ id: key, t: now, type, side: o.side || null, msg, price: an.price || null }); };
  if (st.trade && st.trade.status === "OPEN") {
    updateTrade(st.trade, m1, now, emit);
    const j = journal.find(x => x.id === st.trade.id); if (j) Object.assign(j, st.trade);
    if (st.trade.status === "CLOSED") { st.stage = "COMPLETED"; st.cooldownUntil = Math.max(now + 900, (st.lastSignal ? st.lastSignal.t : now) + SIGNAL_COOLDOWN); st.scenario = null; }
  } else {
    if ((st.stage === "COMPLETED" || st.stage === "INVALIDATED") && now >= (st.cooldownUntil || 0)) st.stage = "NEUTRAL";
    const sc = st.scenario;
    if (sc) {
      const cur = an.scenarios && an.scenarios[sc.side]; let inval = null;
      if (!cur) inval = "analysis unavailable";
      else if (!cur.aligned) inval = "H1 bias changed (" + (an.h1 ? an.h1.bias : "?") + ")";
      else if (cur.status === "INVALIDATED") inval = "M5 closed beyond " + f2(cur.invalidation);
      else if (now > sc.expiresT) inval = "scenario expired without entry (6h)";
      else if (!cur.zoneObj && cur.stage < 3 && sc.stage < 3) inval = "zone mitigated or price left the zone";
      if (inval) { emit("SCENARIO_INVALIDATED", sc, sc.side + " scenario invalidated: " + inval, sc.id + ":INV"); st.scenario = null; st.stage = "INVALIDATED"; st.cooldownUntil = now + 600; }
      else {
        if (cur.stage > sc.stage) {
          const names = { 2: ["ZONE_APPROACHING", "Price approaching the " + (cur.zoneObj ? cur.zoneObj.tf + " " + cur.zoneObj.side.toLowerCase() : "zone")], 3: ["LIQUIDITY_SWEEP", "Liquidity sweep: " + (cur.sweep ? cur.sweep.label + " " + f2(cur.sweep.price) : "")], 4: ["CONFIRMATION_DETECTED", "M5 confirmation: " + (cur.evObj ? cur.evObj.kind + " " + cur.evObj.dir + " @ " + f2(cur.evObj.level) : "") + " with displacement"] };
          if (names[cur.stage]) emit(names[cur.stage][0], sc, sc.side + ": " + names[cur.stage][1], sc.id + ":S" + cur.stage);
          sc.stage = cur.stage;
        }
        if (cur.status === "VALID_ENTRY" && an.status === "VALID_ENTRY") tryOpen(st, an, cur, now, journal, emit);
      }
    } else if (now >= (st.cooldownUntil || 0) && an.status !== "NO_DATA" && an.fresh && !an.marketClosed) {
      const p = an.primary && an.scenarios[an.primary];
      if (p && p.stage >= 2) {
        st.scenario = { id: p.side + "-" + now, side: p.side, createdT: now, expiresT: now + SCEN_TTL, stage: p.stage, zone: p.zone || (p.zoneObj && { lo: p.zoneObj.lo, hi: p.zoneObj.hi, tf: p.zoneObj.tf }) };
        const names = { 2: ["ZONE_APPROACHING", "Price approaching the " + (p.zoneObj ? p.zoneObj.tf + " " + p.zoneObj.side.toLowerCase() : "zone")], 3: ["LIQUIDITY_SWEEP", "Liquidity sweep: " + (p.sweep ? p.sweep.label : "")], 4: ["CONFIRMATION_DETECTED", "M5 confirmation detected"], 5: ["ENTRY_VALID", ""] };
        if (p.stage < 5) emit(names[p.stage][0], st.scenario, p.side + ": " + names[p.stage][1], st.scenario.id + ":S" + p.stage);
        if (p.status === "VALID_ENTRY" && an.status === "VALID_ENTRY") tryOpen(st, an, p, now, journal, emit);
      }
    }
  }
  // news alert 15 min before a high-impact release
  if (news && news.ok) for (const e of news.events) if (e.impact === "High" && e.t - now <= 900 && e.t - now > -60) emit("HIGH_IMPACT_NEWS", {}, "High-impact news in " + Math.max(0, Math.round((e.t - now) / 60)) + " min: " + e.title + ". Avoid opening a scalp.", "news:" + e.t + ":" + e.title);
  st.stage = st.trade && st.trade.status === "OPEN" ? "TRADE_ACTIVE" : st.stage === "COMPLETED" || st.stage === "INVALIDATED" ? st.stage : st.scenario ? ["", "BIAS_DETECTED", "ZONE_APPROACHED", "LIQUIDITY_EVENT", "M5_CONFIRMATION", "ENTRY_VALID"][st.scenario.stage] : (an.primary ? "BIAS_DETECTED" : "NEUTRAL");
  return events;
}
function duplicateSetup(st, journal, sc, now) {   // the same setup (same side/zone/sweep) must never be reported twice
  if (!sc.setupId) return false;
  if (st.lastSignal && st.lastSignal.setupId === sc.setupId) return true;
  return journal.some(j => j.setupId === sc.setupId && now - (j.openedAt || j.t) < 86400);
}
function tryOpen(st, an, sc, now, journal, emit) {
  if (duplicateSetup(st, journal, sc, now)) { st.suppressed = { setupId: sc.setupId, t: now }; return false; }
  openTrade(st, an, sc, now, journal, emit); return true;
}
function openTrade(st, an, sc, now, journal, emit) {
  if (st.trade && st.trade.status === "OPEN") return;
  const P = sc.plan, id = "T" + now;
  const tr = { id, side: sc.side, t: sc.rej ? sc.rej.t + 300 : now, openedAt: now, entry: P.entry, sl: P.sl, risk: P.risk, tps: P.tps.map(t => ({ price: t.price, rr: t.rr, src: t.src })), rr: P.rr, score: sc.score, grade: sc.grade,
    setup: sc.side + " · " + (sc.zoneObj ? sc.zoneObj.tf + " " + sc.zoneObj.side.toLowerCase() : "") + " · sweep " + (sc.sweep ? sc.sweep.label : "") + " · " + (sc.evObj ? sc.evObj.tf + " " + sc.evObj.kind : ""),
    entryZone: sc.entryZone, entries: sc.entryZone ? { aggressive: sc.entryZone.aggressive, preferred: sc.entryZone.preferred, conservative: sc.entryZone.conservative } : null, setupId: sc.setupId, confidence: sc.confidence, entryScore: sc.entryScore,
    breakdown: (sc.breakdown || []).map(b => ({ label: b.label, pts: b.pts, weight: b.weight })), modifiers: sc.modifiers || [], explanation: an.explanation || null, news: an.news ? an.news.risk : null, regime: an.regimeInfo ? an.regimeInfo.primary : null,
    checklist: sc.items.filter(i => i.ok).map(i => i.label), status: "OPEN", result: null, r: null, hit: {}, maxTp: 0 };
  st.trade = tr; st.lastSignal = { setupId: sc.setupId, t: now, side: sc.side }; st.scenario.stage = 5; journal.push(Object.assign({}, tr)); if (journal.length > 300) journal.splice(0, journal.length - 300);
  emit("ENTRY_VALID", tr, sc.side + " VALID ENTRY (" + sc.grade + ", " + sc.score + "%): entry " + f2(P.entry) + " · SL " + f2(P.sl) + " · TP1 " + f2(P.tps[0].price) + " · TP2 " + f2(P.tps[1].price) + " · TP3 " + f2(P.tps[2].price) + " · RR 1:" + P.rr, tr.id + ":ENTRY");
}
const PRIO = { ENTRY_VALID: 5, SL_HIT: 4, TP1_HIT: 4, TP2_HIT: 4, TP3_HIT: 4, SCENARIO_INVALIDATED: 3, HIGH_IMPACT_NEWS: 4, CONFIRMATION_DETECTED: 3, LIQUIDITY_SWEEP: 3, ZONE_APPROACHING: 2, BREAKEVEN_EXIT: 3, TRADE_EXPIRED: 2 };
async function notify() {
  const topic = process.env.NTFY_TOPIC; if (!topic) return;
  const allow = (process.env.ALERTS || "").split(",").map(s => s.trim()).filter(Boolean);
  for (const e of rd("new_events.json", [])) {
    if (allow.length && !allow.includes(e.type)) continue;
    try { await fetch("https://ntfy.sh/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic, title: "XAUUSD " + e.type.replace(/_/g, " "), message: e.msg + (e.type === "ENTRY_VALID" ? "\nIF/THEN idea from a mechanical engine; confirm on your chart." : ""), priority: PRIO[e.type] || 3, tags: [e.type === "ENTRY_VALID" ? "rotating_light" : "bell"] }) }); }
    catch (err) { console.log("ntfy failed", err.message); }
  }
}
async function main() {
  const now = Math.floor(Date.now() / 1000);
  const m1 = (rd("candles.json", { m1: [] })).m1;
  const news = await fetchNews(rd("news.json", null), now); wr("news.json", news);
  const macro = E.macroFromDrivers((rd("data.json", {}) || {}).drivers);
  const an = E.analyze({ m1, nowS: now, news, macro });
  const st = rd("agent_state.json", { stage: "NEUTRAL", scenario: null, trade: null, cooldownUntil: 0, seen: {} });
  const journal = rd("journal.json", []);
  const events = step(st, an, m1, now, journal, news);
  const old = rd("events.json", []); const all = old.concat(events).slice(-150);
  st.updated = now;
  st.summary = { status: an.status, decision: an.decision && an.decision.decision, grade: an.decision && an.decision.grade, confidence: an.decision && an.decision.confidence, signal: an.signal, stage: st.stage, price: an.price, bias: an.h1 && an.h1.bias, primary: an.primary, waitFor: an.waitFor, reasons: an.reasons, progress: an.progress, fresh: an.fresh };
  const keys = Object.keys(st.seen); if (keys.length > 400) keys.sort((a, b) => st.seen[a] - st.seen[b]).slice(0, keys.length - 400).forEach(k => delete st.seen[k]);
  wr("agent_state.json", st); wr("journal.json", journal); wr("events.json", all); wr("new_events.json", events);
  console.log("agent:", an.status, an.signal || "", "stage", st.stage, "events", events.map(e => e.type).join(",") || "-");
}
module.exports = { step, updateTrade, openTrade, tryOpen, duplicateSetup };
if (require.main === module) { (process.argv[2] === "notify" ? notify() : main()).catch(e => { console.error(e); process.exit(1); }); }

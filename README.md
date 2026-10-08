# XAUUSD AI Trading Agent

Static site on GitHub Pages + an agent that runs on GitHub Actions. Everything is free; no paid API.

**Rule of the whole project:** H1 = direction/context · M15 = setup/zone · M5 = confirmation. No M5 confirmation = no entry. Unclear = NO TRADE.

## How it works
- `collect.py` samples XAUUSD spot (gold-api.com) every 10 s and builds 1-minute candles (`candles.json`, 7 days). Two overlapping runners keep the collection continuous.
- `engine.js` (runs in the browser **and** in Node) builds M5/M15/H1 candles and detects structure (HH/HL/LH/LL, BOS, CHoCH, displacement), liquidity pools (PDH/PDL, session/day H/L, equal highs/lows, swings), sweeps, FVG, order blocks (supply/demand), premium/discount, then scores the BUY and SELL scenarios (0-100) with mandatory confirmations.
- `run_engine.js` runs every ~5 minutes on the runner: signal state machine (neutral → bias → zone → liquidity event → M5 confirmation → entry valid → trade active → TP/SL → completed/invalidated), trade tracking, journal, alerts (ntfy), news.
- `index.html` is the terminal UI: live price, chart (TradingView Lightweight Charts), analysis, scenarios, liquidity, news, journal, settings, **ANALYZE NOW** and **AUTO MONITORING**.

## Data files
`candles.json` · `agent_state.json` · `journal.json` · `events.json` · `news.json` (agent) and `data.json` · `live.json` · `xau.json` (macro dashboard, `update.py`).

## Setup
1. Settings → Pages → Source: GitHub Actions.
2. Optional secret `NTFY_TOPIC` for phone notifications (ntfy app). Optional repository variable `ALERTS` (comma list, e.g. `ENTRY_VALID,SL_HIT,TP1_HIT`) to limit alert types.
3. Workflows: `Agent collector` (every 15 min, runs ~25 min, flushes every 5 min), `Update gold analysis` (macro, hourly), `Deploy site`.

## Honest limits
- Candles are built from 10-second spot samples, so they differ slightly from broker candles; there is no free historical XAUUSD candle feed, so history starts when the collector starts.
- The agent needs H1 20 / M15 24 / M5 40 candles before it analyses; until then it says `COLLECTING DATA`.
- Previous-day levels need one full collected day. News comes from the free ForexFactory weekly JSON (USD, high/medium impact only).
- GitHub schedules can be delayed; the UI shows `DATA STALE` / `DATA DISCONNECTED` instead of guessing.
- Journal results assume exit at the highest target hit before price returns to entry (breakeven after TP1); SL and TP in the same minute count as a loss.
- Signals are mechanical IF/THEN ideas, not predictions or financial advice.

## Adding a data provider
Implement a function returning the XAUUSD price (or `None`) in `collect.py`, register it in `PROVIDERS`, set `PROVIDER`. Only `gold-api` is implemented and tested.

## Decision engine v2 (engine.js)
**Flow:** H1 bias (+confidence) → M15 liquidity/structure/setup → M5 confirmation → risk + news/macro check → confidence score → `BUY` / `SELL` / `WAIT` / `NO_TRADE`. The default is WAIT; the engine never forces a trade.

**Score (configurable, `DEFAULTS.weights`)**: HTF bias 20 · liquidity sweep 20 · M15 structure 15 · displacement 10 · FVG/OB 10 · premium/discount 5 · M5 confirmation 15 · risk/reward 5. Each component earns 60–100% of its weight depending on quality (sweep quality, displacement score, zone quality, bias confidence). **Confidence** = score + transparent modifiers (DXY/yields ±, volatility, medium news, data coverage). Grades: A+ ≥ 90 · A ≥ 80 · B ≥ 70 · C ≥ 60. Only A+/A can become a signal (in a ranging regime only A+); B/C are WAIT.

**Mandatory confirmations (score alone never allows entry):** H1 aligned · zone · confirmed sweep · valid M15 BOS/CHoCH after the sweep · displacement · M5 BOS/CHoCH + retest + rejection candle · RR ≥ 1:2 (configurable) · premium/discount not opposite · no HIGH news risk (and a post-news sweep) · fresh data · not invalidated.
**A+ also needs:** bias confidence ≥ 70, ≥ 2 real liquidity targets, sweep quality ≥ 50, strong displacement (≥ 70), zone quality ≥ 60, M5 confirmation ≥ 70, LOW news risk.

**Entry / SL / TP:** zone = best FVG/OB (by quality score) created after the sweep, else the broken level; aggressive / preferred (midpoint) / conservative entries; entry price = close of the confirmed rejection candle. SL = beyond the sweep extreme and the zone + buffer (max of 0.5$ and 0.2×ATR M5, ×1.5 in high volatility). TP1 = nearest internal liquidity, TP2 = external liquidity (PDH/PDL, session/day extremes), TP3 = major HTF liquidity; RR is measured to TP2 (TP1 if only one real target). Synthetic R-multiple targets are only filler and are flagged.

**News:** FOMC/CPI/NFP… from the free ForexFactory weekly calendar (USD, high/medium). HIGH risk from 30 min before to 15 min after a high-impact release → NO NEW TRADE; for 90 min after, a liquidity sweep that happened *after* the release is required. No data → `NEWS DATA UNAVAILABLE` (never invented). DXY / yields (from `data.json`) only add or subtract a few confidence points.

**No repainting:** structure uses closed candles only; the forming candle is reported as `confirmed: false`. `analyze()` ignores any candle after `nowS`.
**Cooldown / dedupe:** each setup has a `setupId`; the agent never reports the same setup twice and waits 45 min after a signal.
**Debug:** `analyze({debug:true})` or Settings → DEBUG_ENGINE prints PASS/FAIL for every condition.

## Tests
`node tests/run.js` (engine + agent state machine: BUY/SELL A+, false breakout, no liquidity, news, conflict, low RR, stale data, no-repaint, cooldown) and `node tests/ui.js` (page smoke test with a stubbed browser). They run in CI (`Tests` workflow). Fixtures are synthetic and clearly separated from live data.

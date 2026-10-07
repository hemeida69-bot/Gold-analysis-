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

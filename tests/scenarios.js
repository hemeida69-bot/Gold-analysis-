/* Synthetic XAUUSD scenarios used by the engine tests. Every path is a list of [minute, price] waypoints turned into
   1-minute candles with deterministic noise. They are test fixtures, never shown as live data. */
const { gen } = require("./gen.js");
const T0 = Date.UTC(2026, 9, 6, 0, 0, 0) / 1000;           // Tue 00:00 UTC (market open)
const mirror = wp => wp.map(([m, p]) => [m, 8400 - p]);    // BUY scenarios are exact mirrors of the SELL ones

// H1 bearish structure, then a rally into an H1/M15 supply zone with M15-scale pullbacks (internal lows at ~4166 and ~4172.5)
const BASE = [[0, 4210], [200, 4190], [330, 4203], [600, 4174], [760, 4192], [1050, 4158], [1230, 4181], [1245, 4172], [1260, 4180], [1275, 4166], [1500, 4146]];
const RALLY = [[1560, 4158], [1580, 4155.5], [1610, 4163], [1640, 4160], [1662, 4171], [1674, 4166], [1690, 4176], [1696, 4179], [1703, 4172.5], [1709, 4180.8], [1711, 4180]];
const PREFIX = BASE.concat(RALLY);
// sweep of the buy-side liquidity (the 4181 swing high), then displacement that closes below the M15 internal low
const SWEEP = [[1714, 4183.5], [1717, 4180], [1722, 4170], [1728, 4162.5], [1735, 4164], [1745, 4163], [1752, 4166]];
// retest of the imbalance and a rejection candle
const RETEST = [[1758, 4171], [1763, 4177], [1766, 4178.4], [1769, 4175.2], [1775, 4172.4]];
const NOW_VALID = 1771, NOW_AFTER = 1775;

function make(wp, seed) { return gen(T0, wp, 0.25, seed || 11); }
function at(m1, minute, extra) { return Object.assign({ m1: m1.filter(r => r[0] < T0 + minute * 60), nowS: T0 + minute * 60 + 30, news: { ok: true, fetched: T0, events: [] } }, extra || {}); }

const S = {
  T0, NOW_VALID,
  sellA: () => make(PREFIX.concat(SWEEP, RETEST)),
  buyA: () => make(mirror(PREFIX.concat(SWEEP, RETEST))),
  // sweep, then only a WICK below the internal low (close back above) and no displacement
  falseBreakout: () => make(PREFIX.concat([[1714, 4183.5], [1718, 4180.5], [1724, 4177.5], [1730, 4176], [1733, 4171.6], [1736, 4177.4], [1742, 4178.5], [1750, 4179], [1760, 4179.5]])),
  // bearish H1, price still far below the supply zone: no zone, no sweep
  // SELL A+ path continued with a custom tail (used by the agent lifecycle tests)
  custom: tail => make(PREFIX.concat(SWEEP, RETEST, tail)),
  noLiquidity: () => make(BASE.concat([[1560, 4157], [1600, 4160], [1640, 4158.5], [1670, 4160]])),
  // bullish H1 (mirror prefix) then a sharp bearish M15 break while H1 is still bullish
  conflict: () => make(mirror(PREFIX), 5)
};
module.exports = S;
S.at = at;

#!/usr/bin/env python3
"""Daily gold analysis: Alpha Vantage data -> Claude (with web search) -> data.json"""
import json, os, urllib.parse, urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

AV_KEY = os.environ["ALPHAVANTAGE_API_KEY"]
CLAUDE_KEY = os.environ["ANTHROPIC_API_KEY"]
MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-5-5")
DIR_AR = {"up": "صاعد", "down": "هابط", "flat": "محايد"}


def http(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())


def av(**p):
    p["apikey"] = AV_KEY
    d = http("https://www.alphavantage.co/query?" + urllib.parse.urlencode(p))
    if "data" not in d:
        raise SystemExit("Alpha Vantage error: " + str(d)[:300])
    return d["data"]


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def market():
    gold = [(r["date"], num(r["price"])) for r in av(function="GOLD_SILVER_HISTORY", symbol="XAU", interval="daily")[:40]]
    gold = [g for g in gold if g[1] is not None]
    y10 = [(r["date"], num(r["value"])) for r in av(function="TREASURY_YIELD", interval="daily", maturity="10year")[:10]]
    y10 = [y for y in y10 if y[1] is not None]
    ff = [(r["date"], num(r["value"])) for r in av(function="FEDERAL_FUNDS_RATE", interval="monthly")[:3]]
    cpi = [num(r["value"]) for r in av(function="CPI", interval="monthly")[:13]]
    last = gold[0][1]
    m = {
        "gold_last_close": {"date": gold[0][0], "price": round(last, 2)},
        "gold_prev_close": {"date": gold[1][0], "price": round(gold[1][1], 2)},
        "gold_change_5d_pct": round((last / gold[5][1] - 1) * 100, 2),
        "gold_change_30d_pct": round((last / gold[-1][1] - 1) * 100, 2),
        "gold_high_30d": round(max(g[1] for g in gold[:30]), 2),
        "gold_low_30d": round(min(g[1] for g in gold[:30]), 2),
        "us10y": y10[:3],
        "fed_funds_effective_monthly": ff,
        "cpi_yoy_pct": round((cpi[0] / cpi[12] - 1) * 100, 2) if len(cpi) > 12 and all(cpi) else None,
    }
    return m, gold


SCHEMA = """{
 "bias": {"dir": "up|down|flat", "label": "عنوان قصير بالعربي", "conf": 0-100, "summary": "2-3 جمل"},
 "base_range": [low, high],
 "drivers": [{"n": "اسم العامل", "s": "up|down|flat", "why": "جملة أو اتنين"}],
 "scen": [{"n": "الأساسي: ...", "p": int, "trig": "...", "inv": "...", "txt": "..."},
          {"n": "الصاعد: ..."}, {"n": "الهابط: ..."}],
 "levels": [{"v": number, "t": "وصف", "c": "u|d|now"}],
 "cal": [{"t": "اليوم والوقت", "n": "اسم البيان", "f": "المتوقع", "hi": "لو أعلى من المتوقع", "lo": "لو أقل من المتوقع"}]
}"""


def analyze(m):
    system = (
        "You are a disciplined gold (XAUUSD) macro analyst. Write all text values in Egyptian Arabic, professional tone. "
        "Use ONLY the market data given plus facts you verify with web search. Never invent numbers, releases, forecasts or dates; "
        "if something cannot be verified, omit it. Probabilities are estimates and must sum to 100. "
        "Output ONLY one JSON object, no markdown."
    )
    user = (
        "Market data (Alpha Vantage):\n" + json.dumps(m, ensure_ascii=False) +
        "\n\nFirst use web search (max 4 searches) to find: today's main gold headlines, the US dollar index trend, "
        "central-bank gold buying news, and the key US data releases scheduled in the next 7 days with consensus forecasts. "
        "Then return JSON in exactly this schema:\n" + SCHEMA +
        "\n\nRules: drivers must include real yields/10y, Fed, dollar, inflation, geopolitics, central banks (mark flat and say unavailable if not verified). "
        "Levels: 5 entries (bull target, bull trigger, now = latest close, bear trigger, bear target), derived from the data. "
        "cal may be an empty list if nothing verified. scen order: base, bull, bear."
    )
    body = {
        "model": MODEL, "max_tokens": 6000, "system": system,
        "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 4}],
        "messages": [{"role": "user", "content": user}],
    }
    r = http("https://api.anthropic.com/v1/messages", json.dumps(body).encode(),
             {"content-type": "application/json", "x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01"})
    text = "".join(b.get("text", "") for b in r["content"] if b.get("type") == "text")
    a, b = text.find("{"), text.rfind("}")
    if a < 0 or b < 0:
        raise SystemExit("No JSON in Claude response: " + text[:300])
    out = json.loads(text[a:b + 1])
    ps = [max(0, int(s.get("p", 0))) for s in out["scen"]]
    tot = sum(ps) or 1
    ps = [round(p * 100 / tot) for p in ps]
    ps[0] += 100 - sum(ps)
    for s, p in zip(out["scen"], ps):
        s["p"] = p
    return out


def evaluate(hist, gold):
    closes = dict(gold)
    for p in hist["preds"]:
        if p.get("done"):
            continue
        nxt = sorted(d for d in closes if d > p["date"])
        if not nxt:
            continue
        c = closes[nxt[0]]
        if p["dir"] == "up":
            ok = c > p["ref_close"]
        elif p["dir"] == "down":
            ok = c < p["ref_close"]
        else:
            ok = p["base_low"] <= c <= p["base_high"]
        hist["results"].insert(0, {"d": nxt[0], "f": DIR_AR[p["dir"]], "a": f"{c:,.0f}", "ok": bool(ok)})
        p["done"] = True


def main():
    m, gold = market()
    hist = json.load(open("history.json", encoding="utf-8"))
    evaluate(hist, gold)
    out = analyze(m)
    last = m["gold_last_close"]
    hist["preds"] = [p for p in hist["preds"] if p.get("done") or p["date"] != last["date"]]
    low, high = out["base_range"]
    hist["preds"].append({"date": last["date"], "dir": out["bias"]["dir"], "base_low": low,
                          "base_high": high, "ref_close": last["price"]})
    hist["preds"] = hist["preds"][-60:]
    hist["results"] = hist["results"][:60]
    res = hist["results"][:30]
    now = datetime.now(ZoneInfo("Africa/Cairo"))
    data = {
        "updated": now.strftime("%d/%m/%Y %H:%M") + " بتوقيت القاهرة، آخر إغلاق " + last["date"],
        "note": "تحليل آلي بيتحدث كل يوم عمل. السعر والعوائد والفائدة من Alpha Vantage، والتحليل من Claude. "
                "المستويات والنسب تقدير وليست توصية.",
        "bias": out["bias"], "drivers": out["drivers"], "scen": out["scen"],
        "levels": out["levels"], "cal": out.get("cal", []),
        "acc": {"hit": sum(r["ok"] for r in res), "total": len(res), "rows": res[:8]},
    }
    json.dump(data, open("data.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    json.dump(hist, open("history.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("OK", last, out["bias"]["label"])


if __name__ == "__main__":
    main()

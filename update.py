#!/usr/bin/env python3
"""Daily gold analysis. Data: open sources, no API keys (Yahoo, US Treasury, NY Fed, BLS).
Analysis: Claude with web search if ANTHROPIC_API_KEY is set, else a rule-based engine."""
import csv, io, json, os, urllib.parse, urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

DIR_AR = {"up": "صاعد", "down": "هابط", "flat": "محايد"}
UA = {"User-Agent": "Mozilla/5.0 gold-analysis/1.0"}


def http(url, data=None, headers=None):
    h = dict(UA)
    h.update(headers or {})
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h), timeout=int(os.environ.get("HTTP_TIMEOUT", "30") if not data else 150)) as r:
        return r.read().decode()


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def yahoo(sym, rng="3mo"):
    d = json.loads(http(f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}?range={rng}&interval=1d"))["chart"]["result"][0]
    ts, cl = d["timestamp"], d["indicators"]["quote"][0]["close"]
    out = sorted(((datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d"), c) for t, c in zip(ts, cl) if c), reverse=True)
    if not out:
        raise RuntimeError("Yahoo empty: " + sym)
    return out


def treasury(kind, col):
    """US Treasury open data CSV (no key). kind: yield_curve | real_yield_curve. Returns newest first."""
    out = []
    for yr in (datetime.now().year, datetime.now().year - 1):
        url = (f"https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{yr}/all"
               f"?type=daily_treasury_{kind}&field_tdr_date_value={yr}&page&_format=csv")
        rows = list(csv.reader(io.StringIO(http(url))))
        idx = next(i for i, h in enumerate(rows[0]) if h.strip().lower() == col)
        for r in rows[1:]:
            v = num(r[idx]) if len(r) > idx else None
            if v is not None:
                m, d, y = r[0].split("/")
                out.append((f"{y}-{m}-{d}", v))
        if len(out) >= 10:
            break
    out.sort(reverse=True)
    if not out:
        raise RuntimeError("Treasury empty: " + kind)
    return out[:10]


def effr():
    """NY Fed effective fed funds rate (open API). Returns [(latest), (~1 month earlier)]."""
    d = json.loads(http("https://markets.newyorkfed.org/api/rates/unsecured/effr/last/30.json"))["refRates"]
    d = sorted(d, key=lambda x: x["effectiveDate"], reverse=True)
    return [(d[0]["effectiveDate"], float(d[0]["percentRate"])), (d[-1]["effectiveDate"], float(d[-1]["percentRate"]))]


def cpi_yoy():
    """BLS public API v1 (no key): headline CPI-U YoY %."""
    yr = datetime.now().year
    body = json.dumps({"seriesid": ["CUUR0000SA0"], "startyear": str(yr - 2), "endyear": str(yr)}).encode()
    d = json.loads(http("https://api.bls.gov/publicAPI/v1/timeseries/data/", body, {"Content-Type": "application/json"}))
    data = d["Results"]["series"][0]["data"]
    idx = {(x["year"], x["period"]): float(x["value"]) for x in data if x["period"].startswith("M") and x["period"] != "M13"}
    y, p = max(idx)
    return round(pct(idx[(y, p)], idx[(str(int(y) - 1), p)]), 2)


def safe(label, fn, default):
    try:
        v = fn()
        print("ok:", label, "->", (v[0] if isinstance(v, list) and v else v))
        return v
    except Exception as e:
        print("FAILED:", label, repr(e)[:200])
        return default


def get_gold():
    for sym, label in (("XAUUSD=X", "Yahoo (XAUUSD spot)"), ("GC=F", "Yahoo (GC=F futures)")):
        try:
            g = yahoo(sym)
            if len(g) >= 25 and g[0][1] > 1000:
                return g[:40], label
        except Exception as e:
            print("gold source failed:", sym, repr(e)[:120])
    raise SystemExit("No gold data available")


def pct(a, b):
    return (a / b - 1) * 100


def r5(x):
    return int(round(x / 5.0) * 5)


def build(gold, y10, real10, ff, cpi, usd):
    last = gold[0][1]
    ch5 = pct(last, gold[5][1])
    ch30 = pct(last, gold[min(len(gold) - 1, 29)][1])
    w30 = [g[1] for g in gold[:30]]
    hi30, lo30 = max(w30), min(w30)
    pos = (last - lo30) / (hi30 - lo30) if hi30 > lo30 else 0.5
    w5 = [g[1] for g in gold[:5]]
    hi5, lo5 = max(w5), min(w5)
    adr = sum(abs(gold[i][1] - gold[i + 1][1]) for i in range(20)) / 20

    score, drivers = 0.0, []

    # price momentum + position
    s = 1 if ch5 > 1.5 else -1 if ch5 < -1.5 else 0
    s += 0.5 if pos > 0.66 else -0.5 if pos < 0.33 else 0
    score += s
    drivers.append({"n": "الأداء السعري", "s": "up" if s > 0 else "down" if s < 0 else "flat",
                    "why": f"الدهب {ch5:+.1f}% في آخر 5 جلسات و{ch30:+.1f}% في آخر 30 يوم، والسعر في {pos*100:.0f}% من نطاق الشهر ({lo30:,.0f} إلى {hi30:,.0f})."})

    # 10y yield
    if y10:
        d10 = y10[0][1] - y10[min(5, len(y10) - 1)][1]
        s = -1 if d10 > 0.10 else 1 if d10 < -0.10 else 0
        score += s
        drivers.append({"n": "عائد السندات 10 سنين", "s": "up" if s > 0 else "down" if s < 0 else "flat",
                        "why": f"العائد {y10[0][1]:.2f}% وبيتحرك {d10:+.2f} نقطة في آخر 5 قراءات. العائد الأعلى بيزود تكلفة حيازة الدهب."})
    # real yield (TIPS 10y)
    if real10:
        r = real10[0][1]
        s = -0.5 if r > 2.0 else 0.5 if r < 1.0 else 0
        score += s
        drivers.append({"n": "العائد الحقيقي (TIPS 10 سنين)", "s": "up" if s > 0 else "down" if s < 0 else "flat",
                        "why": f"العائد الحقيقي {r:.2f}% ({real10[0][0]})" + (f"، والتضخم السنوي {cpi:.1f}%" if cpi else "") + ". كل ما ارتفع كل ما زادت تكلفة حيازة الدهب."})
    # Fed
    if len(ff) >= 2:
        df = ff[0][1] - ff[1][1]
        s = -0.5 if df > 0.05 else 0.5 if df < -0.05 else 0
        score += s
        txt = "ارتفع" if df > 0.05 else "انخفض" if df < -0.05 else "ثابت تقريباً"
        drivers.append({"n": "الفيدرالي", "s": "up" if s > 0 else "down" if s < 0 else "flat",
                        "why": f"متوسط الفائدة الفعلية {ff[0][1]:.2f}% ({ff[0][0][:7]}) و{txt} عن الشهر السابق ({ff[1][1]:.2f}%)."})
    # dollar (Fed broad trade-weighted index)
    if len(usd) >= 6:
        du = pct(usd[0][1], usd[5][1])
        s = -1 if du > 0.5 else 1 if du < -0.5 else 0
        score += s
        drivers.append({"n": "الدولار (مؤشر DXY)", "s": "up" if s > 0 else "down" if s < 0 else "flat",
                        "why": f"المؤشر {usd[0][1]:.1f} ويتحرك {du:+.1f}% في آخر 5 قراءات. قوة الدولار ضاغطة على الدهب."})
    drivers.append({"n": "الجيوسياسة والبنوك المركزية والأخبار", "s": "flat",
                    "why": "غير مغطاة في وضع القواعد. بتتغطى لما تحليل Claude يكون مفعّل."})

    if score >= 1.5:
        d, label = "up", "صاعد"
    elif score <= -1.5:
        d, label = "down", "هابط"
    elif score > 0.5:
        d, label = "flat", "محايد مائل للصعود"
    elif score < -0.5:
        d, label = "flat", "محايد مائل للهبوط"
    else:
        d, label = "flat", "محايد"
    conf = int(min(80, 40 + abs(score) * 10))

    pb = int(max(10, min(50, 25 + 7 * score)))
    pr = int(max(10, min(50, 25 - 7 * score)))
    pbase = 100 - pb - pr
    lo, hi = r5(lo5), r5(hi5)
    bull_t, bear_t = r5(hi5 + 1.5 * adr), r5(lo5 - 1.5 * adr)

    up_n = [x["n"] for x in drivers if x["s"] == "up"]
    dn_n = [x["n"] for x in drivers if x["s"] == "down"]
    summary = (f"آخر إغلاق {last:,.0f}. محصلة العوامل المحسوبة {score:+.1f}. "
               + ("الداعم: " + "، ".join(up_n) + ". " if up_n else "")
               + ("الضاغط: " + "، ".join(dn_n) + ". " if dn_n else "")
               + "الحسم بيتحدد بإغلاق يومي خارج نطاق آخر 5 جلسات.")
    return {
        "bias": {"dir": d, "label": label, "conf": conf, "summary": summary},
        "base_range": [lo, hi],
        "drivers": drivers,
        "scen": [
            {"n": "الأساسي: تذبذب داخل نطاق آخر 5 جلسات", "p": pbase, "trig": f"بين {lo:,} و {hi:,}",
             "inv": "إغلاق يومي خارج النطاق", "txt": "السعر يفضل داخل نطاق الجلسات الأخيرة لحد ما يظهر محرك جديد."},
            {"n": "الصاعد: كسر أعلى النطاق", "p": pb, "trig": f"إغلاق يومي فوق {hi:,}",
             "inv": f"رجوع تحت {r5(hi5 - 0.5 * adr):,}", "txt": f"استمرار الزخم يفتح الطريق نحو {bull_t:,}."},
            {"n": "الهابط: كسر أدنى النطاق", "p": pr, "trig": f"إغلاق يومي تحت {lo:,}",
             "inv": f"رجوع فوق {r5(lo5 + 0.5 * adr):,}", "txt": f"استمرار الضغط يفتح الطريق نحو {bear_t:,}."},
        ],
        "levels": [{"v": bull_t, "t": "هدف صاعد", "c": "u"}, {"v": hi, "t": "تفعيل الصاعد", "c": "u"},
                   {"v": round(last), "t": "آخر إغلاق", "c": "now"},
                   {"v": lo, "t": "تفعيل الهابط", "c": "d"}, {"v": bear_t, "t": "هدف هابط", "c": "d"}],
        "ref": round(last, 2), "score": round(score, 2),
    }


SCHEMA = """{
 "bias": {"dir": "up|down|flat", "label": "عنوان قصير بالعربي", "conf": 0-100, "summary": "2-3 جمل"},
 "base_range": [low, high],
 "drivers": [{"n": "اسم العامل", "s": "up|down|flat", "why": "جملة أو اتنين"}],
 "scen": [{"n": "الأساسي: ...", "p": int, "trig": "...", "inv": "...", "txt": "..."}, {"n": "الصاعد: ..."}, {"n": "الهابط: ..."}],
 "levels": [{"v": number, "t": "وصف", "c": "u|d|now"}],
 "cal": [{"t": "اليوم والوقت", "n": "اسم البيان", "f": "المتوقع", "hi": "لو أعلى من المتوقع", "lo": "لو أقل من المتوقع"}]
}"""


def analyze_claude(m, rule):
    system = ("You are a disciplined gold (XAUUSD) macro analyst. Write all text values in Egyptian Arabic, professional tone. "
              "Use ONLY the market data given plus facts you verify with web search. Never invent numbers, releases, forecasts or dates; "
              "omit what you cannot verify. Probabilities are estimates and must sum to 100. Output ONLY one JSON object, no markdown.")
    user = ("Market data:\n" + json.dumps(m, ensure_ascii=False) + "\n\nRule-based baseline (for reference, you may disagree with reasons):\n"
            + json.dumps({"bias": rule["bias"], "base_range": rule["base_range"]}, ensure_ascii=False)
            + "\n\nUse web search (max 4) for: today's main gold headlines, central-bank buying news, geopolitical drivers, and the key US data "
              "releases in the next 7 days with consensus forecasts. Return JSON in exactly this schema:\n" + SCHEMA
            + "\n\nRules: drivers must cover real yields, Fed, dollar, inflation, geopolitics, central banks (flat + say unavailable if unverified). "
              "Levels: 5 entries (bull target, bull trigger, now = latest close, bear trigger, bear target). cal may be empty. scen order: base, bull, bear.")
    body = {"model": os.environ.get("CLAUDE_MODEL", "claude-sonnet-5-5"), "max_tokens": 6000, "system": system,
            "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 4}],
            "messages": [{"role": "user", "content": user}]}
    r = json.loads(http("https://api.anthropic.com/v1/messages", json.dumps(body).encode(),
                        {"content-type": "application/json", "x-api-key": os.environ["ANTHROPIC_API_KEY"],
                         "anthropic-version": "2023-06-01"}))
    text = "".join(b.get("text", "") for b in r["content"] if b.get("type") == "text")
    out = json.loads(text[text.find("{"):text.rfind("}") + 1])
    ps = [max(0, int(x.get("p", 0))) for x in out["scen"]]
    tot = sum(ps) or 1
    ps = [round(p * 100 / tot) for p in ps]
    ps[0] += 100 - sum(ps)
    for x, p in zip(out["scen"], ps):
        x["p"] = p
    for k in ("bias", "base_range", "drivers", "levels"):
        out[k]
    out["ref"] = rule["ref"]
    return out


def evaluate(hist, gold):
    closes = dict(gold)
    for p in hist["preds"]:
        if p.get("done"):
            continue
        nxt = sorted(x for x in closes if x > p["date"])
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
    gold, src = get_gold()
    print("gold:", src, gold[0])
    y10 = safe("US10Y", lambda: treasury("yield_curve", "10 yr"), [])
    real10 = safe("TIPS10Y", lambda: treasury("real_yield_curve", "10 yr"), [])
    ff = safe("EFFR", effr, [])
    cpi = safe("CPI_YOY", cpi_yoy, None)
    usd = safe("DXY", lambda: yahoo("DX-Y.NYB"), [])
    rule = build(gold, y10, real10, ff, cpi, usd)

    out, mode = rule, "قواعد ثابتة"
    if os.environ.get("ANTHROPIC_API_KEY"):
        m = {"gold_last_close": {"date": gold[0][0], "price": round(gold[0][1], 2)}, "gold_prev_close": round(gold[1][1], 2),
             "gold_5d_pct": round(pct(gold[0][1], gold[5][1]), 2), "gold_30d_pct": round(pct(gold[0][1], gold[29][1]), 2),
             "gold_5d_high": max(g[1] for g in gold[:5]), "gold_5d_low": min(g[1] for g in gold[:5]),
             "us10y": y10[:3], "real10y_tips": real10[:3], "fed_funds_monthly": ff, "cpi_yoy_pct": round(cpi, 2) if cpi else None,
             "usd_broad_index": usd[:3], "usd_5d_pct": round(pct(usd[0][1], usd[5][1]), 2) if len(usd) > 5 else None}
        try:
            out, mode = analyze_claude(m, rule), "Claude مع بحث ويب"
        except Exception as e:
            print("Claude failed, using rule-based:", repr(e)[:300])

    hist = json.load(open("history.json", encoding="utf-8"))
    evaluate(hist, gold)
    date = gold[0][0]
    hist["preds"] = [p for p in hist["preds"] if p.get("done") or p["date"] != date]
    lo, hi = out["base_range"]
    hist["preds"].append({"date": date, "dir": out["bias"]["dir"], "base_low": lo, "base_high": hi, "ref_close": rule["ref"]})
    hist["preds"] = hist["preds"][-60:]
    hist["results"] = hist["results"][:60]
    res = hist["results"][:30]
    now = datetime.now(ZoneInfo("Africa/Cairo"))
    data = {
        "updated": now.strftime("%d/%m/%Y %H:%M") + " بتوقيت القاهرة، آخر إغلاق " + date,
        "note": f"تحليل آلي بيتحدث كل يوم عمل ({mode}). البيانات من مصادر مفتوحة: {src} وخزانة أمريكا وبنك نيويورك الفيدرالي وBLS. المستويات والنسب تقدير وليست توصية.",
        "bias": out["bias"], "drivers": out["drivers"], "scen": out["scen"], "levels": out["levels"], "cal": out.get("cal", []),
        "acc": {"hit": sum(r["ok"] for r in res), "total": len(res), "rows": res[:8]},
    }
    json.dump(data, open("data.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    json.dump(hist, open("history.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("OK", date, mode, out["bias"]["label"])


if __name__ == "__main__":
    main()

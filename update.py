#!/usr/bin/env python3
"""Daily gold analysis on XAUUSD spot. Open sources only, no keys required:
gold-api.com (spot, sampled hourly into spot.json), US Treasury, NY Fed, BLS, Yahoo (DXY).
Analysis: Claude with web search if ANTHROPIC_API_KEY is set, else a rule-based engine."""
import csv, io, json, os, urllib.parse, urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

DIR_AR = {"up": "صاعد", "down": "هابط", "flat": "محايد"}
UA = {"User-Agent": "Mozilla/5.0 gold-analysis/1.0"}
SEED = {"daily": [["2026-10-01", 4152.44], ["2026-09-30", 4185.44]], "ticks": []}


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


def pct(a, b):
    return (a / b - 1) * 100


def r5(x):
    return int(round(x / 5.0) * 5)


def safe(label, fn, default):
    try:
        v = fn()
        print("ok:", label, "->", (v[0] if isinstance(v, list) and v else v))
        return v
    except Exception as e:
        print("FAILED:", label, repr(e)[:200])
        return default


def yahoo(sym, rng="3mo"):
    d = json.loads(http(f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}?range={rng}&interval=1d"))["chart"]["result"][0]
    out = sorted(((datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d"), c) for t, c in zip(d["timestamp"], d["indicators"]["quote"][0]["close"]) if c), reverse=True)
    if not out:
        raise RuntimeError("Yahoo empty: " + sym)
    return out


def treasury(kind, col):
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
    d = json.loads(http("https://markets.newyorkfed.org/api/rates/unsecured/effr/last/30.json"))["refRates"]
    d = sorted(d, key=lambda x: x["effectiveDate"], reverse=True)
    return [(d[0]["effectiveDate"], float(d[0]["percentRate"])), (d[-1]["effectiveDate"], float(d[-1]["percentRate"]))]


def cpi_yoy():
    yr = datetime.now().year
    body = json.dumps({"seriesid": ["CUUR0000SA0"], "startyear": str(yr - 2), "endyear": str(yr)}).encode()
    data = json.loads(http("https://api.bls.gov/publicAPI/v1/timeseries/data/", body, {"Content-Type": "application/json"}))["Results"]["series"][0]["data"]
    idx = {(x["year"], x["period"]): float(x["value"]) for x in data if x["period"].startswith("M") and x["period"] != "M13" and num(x["value"]) is not None}
    y, p = max(idx)
    return round(pct(idx[(y, p)], idx[(str(int(y) - 1), p)]), 2)


# ---------- XAUUSD spot: sampled hourly, history kept in spot.json ----------
def get_spot():
    """Returns (price, label, updated_epoch) from open spot sources, or (None, None, None)."""
    try:
        d = json.loads(http("https://api.gold-api.com/price/XAU"))
        p = float(d["price"])
        if 1000 < p < 20000:
            ep = int(datetime.fromisoformat(d["updatedAt"].replace("Z", "+00:00")).timestamp())
            return p, "gold-api.com", ep
    except Exception as e:
        print("gold-api failed:", repr(e)[:120])
    try:
        p = float(json.loads(http("https://data-asg.goldprice.org/dbXRates/USD"))["items"][0]["xauPrice"])
        if 1000 < p < 20000:
            return p, "goldprice.org", int(datetime.now(timezone.utc).timestamp())
    except Exception as e:
        print("goldprice failed:", repr(e)[:120])
    return None, None, None


def load_spot():
    try:
        return json.load(open("spot.json", encoding="utf-8"))
    except Exception:
        return json.loads(json.dumps(SEED))


def live_main():
    sp, label, upd = get_spot()
    if sp is None:
        raise SystemExit("XAUUSD spot unavailable")
    now = datetime.now(timezone.utc)
    ep = int(now.timestamp())
    st = load_spot()
    ticks = st["ticks"]
    if not ticks or ep - ticks[-1][0] > 1500:
        ticks.append([ep, round(sp, 2)])
    else:
        ticks[-1] = [ep, round(sp, 2)]
    st["ticks"] = ticks[-200:]
    today = now.strftime("%Y-%m-%d")
    if now.weekday() <= 4:  # Mon-Fri: the last sample of the day is the day's close
        daily = {d: p for d, p in st["daily"]}
        daily[today] = round(sp, 2)
        st["daily"] = [[d, daily[d]] for d in sorted(daily, reverse=True)][:90]
    json.dump(st, open("spot.json", "w", encoding="utf-8"))

    prev = next((p for t, p in reversed(st["ticks"][:-1]) if ep - t >= 3000), sp)
    ago = next((p for t, p in reversed(st["ticks"]) if t <= ep - 86400), None)
    if ago is None:
        ago = next((p for d, p in st["daily"] if d < today), sp)
    w24 = [p for t, p in st["ticks"] if t > ep - 86400] or [sp]
    if len(st["ticks"]) >= 12:
        bars, kind = [p for _, p in st["ticks"][-48:]], "hourly"
    else:
        bars, kind = [p for _, p in reversed(st["daily"][:30])] + [round(sp, 2)], "daily"
    cairo = ZoneInfo("Africa/Cairo")
    out = {
        "price": round(sp, 2), "t": datetime.fromtimestamp(upd, cairo).strftime("%d/%m %H:%M"),
        "stale_min": int((ep - upd) / 60),
        "chg1h_pct": round(pct(sp, prev), 2), "chg24h_pct": round(pct(sp, ago), 2),
        "hi24": round(max(w24 + [sp]), 2), "lo24": round(min(w24 + [sp]), 2),
        "bars": [round(b, 1) for b in bars], "bars_kind": kind,
        "src": f"XAUUSD فوري ({label})", "updated": now.astimezone(cairo).strftime("%d/%m/%Y %H:%M"),
    }
    json.dump(out, open("live.json", "w", encoding="utf-8"), ensure_ascii=False)
    print("LIVE OK", out["price"], out["t"], "ticks", len(st["ticks"]), "days", len(st["daily"]))
    return out["price"], st


def completed_closes(st):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return [(d, p) for d, p in st["daily"] if d < today]


def build(gold, price, ticks, y10, real10, ff, cpi, usd):
    n = len(gold)
    score, drivers = 0.0, []
    if n >= 6:
        last = gold[0][1]
        ch5 = pct(last, gold[5][1])
        ch30 = pct(last, gold[min(n - 1, 29)][1])
        w30 = [g[1] for g in gold[:30]]
        hi30, lo30 = max(w30), min(w30)
        pos = (last - lo30) / (hi30 - lo30) if hi30 > lo30 else 0.5
        w5 = [g[1] for g in gold[:5]]
        hi5, lo5 = max(w5), min(w5)
        k = min(20, n - 1)
        adr = sum(abs(gold[i][1] - gold[i + 1][1]) for i in range(k)) / k
        s = 1 if ch5 > 1.5 else -1 if ch5 < -1.5 else 0
        s += 0.5 if pos > 0.66 else -0.5 if pos < 0.33 else 0
        score += s
        drivers.append({"n": "الأداء السعري", "s": "up" if s > 0 else "down" if s < 0 else "flat",
                        "why": f"XAUUSD {ch5:+.1f}% في آخر 5 إغلاقات و{ch30:+.1f}% في المتاح من الشهر، والسعر في {pos*100:.0f}% من نطاق ({lo30:,.0f} إلى {hi30:,.0f})."})
    else:
        pr = [p for _, p in ticks] + [price] + [g[1] for g in gold]
        hi5, lo5 = max(pr), min(pr)
        if hi5 - lo5 < price * 0.006:
            hi5, lo5 = price * 1.003, price * 0.997
        adr = price * 0.008
        drivers.append({"n": "الأداء السعري", "s": "flat",
                        "why": f"تاريخ XAUUSD الفوري لسه بيتجمع ({n} إغلاق). الحكم السعري الكامل يبدأ بعد 6 أيام تداول، والمستويات الحالية مبنية على الأسعار المسجلة."})
    if y10:
        d10 = y10[0][1] - y10[min(5, len(y10) - 1)][1]
        s = -1 if d10 > 0.10 else 1 if d10 < -0.10 else 0
        score += s
        drivers.append({"n": "عائد السندات 10 سنين", "s": "up" if s > 0 else "down" if s < 0 else "flat",
                        "why": f"العائد {y10[0][1]:.2f}% وبيتحرك {d10:+.2f} نقطة في آخر 5 قراءات. العائد الأعلى بيزود تكلفة حيازة الدهب."})
    if real10:
        r = real10[0][1]
        s = -0.5 if r > 2.0 else 0.5 if r < 1.0 else 0
        score += s
        drivers.append({"n": "العائد الحقيقي (TIPS 10 سنين)", "s": "up" if s > 0 else "down" if s < 0 else "flat",
                        "why": f"العائد الحقيقي {r:.2f}% ({real10[0][0]})" + (f"، والتضخم السنوي {cpi:.1f}%" if cpi else "") + ". كل ما ارتفع كل ما زادت تكلفة حيازة الدهب."})
    if len(ff) >= 2:
        df = ff[0][1] - ff[1][1]
        s = -0.5 if df > 0.05 else 0.5 if df < -0.05 else 0
        score += s
        txt = "ارتفعت" if df > 0.05 else "انخفضت" if df < -0.05 else "ثابتة تقريباً"
        drivers.append({"n": "الفيدرالي", "s": "up" if s > 0 else "down" if s < 0 else "flat",
                        "why": f"الفائدة الفعلية {ff[0][1]:.2f}% ({ff[0][0]}) و{txt} عن {ff[1][0]} ({ff[1][1]:.2f}%)."})
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
    conf = int(min(70, 40 + abs(score) * 8))
    pb = int(max(10, min(50, 25 + 7 * score)))
    pr_ = int(max(10, min(50, 25 - 7 * score)))
    pbase = 100 - pb - pr_
    lo, hi = r5(lo5), r5(hi5)
    bull_t, bear_t = r5(hi5 + 1.5 * adr), r5(lo5 - 1.5 * adr)
    up_n = [x["n"] for x in drivers if x["s"] == "up"]
    dn_n = [x["n"] for x in drivers if x["s"] == "down"]
    summary = (f"XAUUSD الفوري عند {price:,.0f}. محصلة العوامل المحسوبة {score:+.1f}. "
               + ("الداعم: " + "، ".join(up_n) + ". " if up_n else "")
               + ("الضاغط: " + "، ".join(dn_n) + ". " if dn_n else "")
               + "الحسم بيتحدد بإغلاق يومي خارج نطاق آخر 5 جلسات.")
    return {
        "bias": {"dir": d, "label": label, "conf": conf, "summary": summary},
        "base_range": [lo, hi], "drivers": drivers,
        "scen": [
            {"n": "الأساسي: تذبذب داخل النطاق", "p": pbase, "trig": f"بين {lo:,} و {hi:,}",
             "inv": "إغلاق يومي خارج النطاق", "txt": "السعر يفضل داخل نطاق الجلسات الأخيرة لحد ما يظهر محرك جديد."},
            {"n": "الصاعد: كسر أعلى النطاق", "p": pb, "trig": f"إغلاق يومي فوق {hi:,}",
             "inv": f"رجوع تحت {r5(hi5 - 0.5 * adr):,}", "txt": f"استمرار الزخم يفتح الطريق نحو {bull_t:,}."},
            {"n": "الهابط: كسر أدنى النطاق", "p": pr_, "trig": f"إغلاق يومي تحت {lo:,}",
             "inv": f"رجوع فوق {r5(lo5 + 0.5 * adr):,}", "txt": f"استمرار الضغط يفتح الطريق نحو {bear_t:,}."},
        ],
        "levels": [{"v": bull_t, "t": "هدف صاعد", "c": "u"}, {"v": hi, "t": "تفعيل الصاعد", "c": "u"},
                   {"v": round(price), "t": "XAUUSD الآن", "c": "now"},
                   {"v": lo, "t": "تفعيل الهابط", "c": "d"}, {"v": bear_t, "t": "هدف هابط", "c": "d"}],
        "ref": round(gold[0][1], 2) if gold else round(price, 2), "score": round(score, 2),
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
    price, st = live_main()
    if os.environ.get("MODE") == "live":
        return
    gold = completed_closes(st)
    if not gold:
        raise SystemExit("No completed XAUUSD closes yet")
    y10 = safe("US10Y", lambda: treasury("yield_curve", "10 yr"), [])
    real10 = safe("TIPS10Y", lambda: treasury("real_yield_curve", "10 yr"), [])
    ff = safe("EFFR", effr, [])
    cpi = safe("CPI_YOY", cpi_yoy, None)
    usd = safe("DXY", lambda: yahoo("DX-Y.NYB"), [])
    rule = build(gold, price, st["ticks"], y10, real10, ff, cpi, usd)

    out, mode = rule, "قواعد ثابتة"
    if os.environ.get("ANTHROPIC_API_KEY"):
        m = {"xauusd_spot_now": round(price, 2), "recent_daily_closes_newest_first": gold[:10],
             "ticks_last_24": st["ticks"][-24:], "us10y": y10[:3], "real10y_tips": real10[:3], "fed_funds": ff,
             "cpi_yoy_pct": cpi, "dxy": usd[:3]}
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
        "updated": now.strftime("%d/%m/%Y %H:%M") + " بتوقيت القاهرة، آخر إغلاق مسجل " + date,
        "note": f"تحليل آلي على XAUUSD الفوري ({mode}). السعر من gold-api.com، وتاريخ الإغلاقات بيتجمع ذاتياً ({len(gold)} يوم حالياً). العوائد من خزانة أمريكا، الفائدة من بنك نيويورك الفيدرالي، التضخم من BLS، الدولار من Yahoo. المستويات والنسب تقدير وليست توصية.",
        "bias": out["bias"], "drivers": out["drivers"], "scen": out["scen"], "levels": out["levels"], "cal": out.get("cal", []),
        "acc": {"hit": sum(r["ok"] for r in res), "total": len(res), "rows": res[:8]},
    }
    json.dump(data, open("data.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    json.dump(hist, open("history.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("OK", date, mode, out["bias"]["label"])


if __name__ == "__main__":
    main()

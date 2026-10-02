#!/usr/bin/env python3
"""Daily gold analysis, rule-based (no LLM, no paid API). Needs only a free Alpha Vantage key."""
import csv, io, json, os, time, urllib.parse, urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

DIR_AR = {"up": "صاعد", "down": "هابط", "flat": "محايد"}


def http(url):
    req = urllib.request.Request(url, headers={"User-Agent": "gold-analysis/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode()


def av_raw(**p):
    p["apikey"] = os.environ["ALPHAVANTAGE_API_KEY"]
    d = json.loads(http("https://www.alphavantage.co/query?" + urllib.parse.urlencode(p)))
    time.sleep(13)  # free tier: 5 calls/minute
    return d


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def series(d, vk):
    out = [(r["date"], num(r[vk])) for r in d.get("data", [])]
    return [o for o in out if o[1] is not None]


def get_gold():
    try:
        g = series(av_raw(function="GOLD_SILVER_HISTORY", symbol="XAU", interval="daily"), "price")
        if len(g) >= 25:
            return g[:40], "Alpha Vantage"
    except Exception as e:
        print("AV gold failed:", e)
    rows = list(csv.DictReader(io.StringIO(http("https://stooq.com/q/d/l/?s=xauusd&i=d"))))
    g = [(r["Date"], num(r["Close"])) for r in rows if num(r.get("Close"))]
    g.sort(reverse=True)
    if len(g) < 25:
        raise SystemExit("No gold data available")
    return g[:40], "Stooq"


def get_eurusd():
    d = av_raw(function="FX_DAILY", from_symbol="EUR", to_symbol="USD")
    ts = d.get("Time Series FX (Daily)", {})
    out = sorted(((k, num(v["4. close"])) for k, v in ts.items()), reverse=True)
    return out[:10]


def pct(a, b):
    return (a / b - 1) * 100


def r5(x):
    return int(round(x / 5.0) * 5)


def build(gold, y10, ff, cpi, eur):
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
    # real yield proxy
    if y10 and cpi:
        real = y10[0][1] - cpi
        s = -0.5 if real > 2.0 else 0.5 if real < 1.0 else 0
        score += s
        drivers.append({"n": "العائد الحقيقي (تقريبي)", "s": "up" if s > 0 else "down" if s < 0 else "flat",
                        "why": f"عائد 10 سنين {y10[0][1]:.2f}% ناقص التضخم السنوي {cpi:.1f}% = حوالي {real:.1f}%. تقدير مبسّط مش عائد TIPS الفعلي."})
    # Fed
    if len(ff) >= 2:
        df = ff[0][1] - ff[1][1]
        s = -0.5 if df > 0.05 else 0.5 if df < -0.05 else 0
        score += s
        txt = "ارتفع" if df > 0.05 else "انخفض" if df < -0.05 else "ثابت تقريباً"
        drivers.append({"n": "الفيدرالي", "s": "up" if s > 0 else "down" if s < 0 else "flat",
                        "why": f"متوسط الفائدة الفعلية {ff[0][1]:.2f}% ({ff[0][0][:7]}) و{txt} عن الشهر السابق ({ff[1][1]:.2f}%)."})
    # dollar proxy via EUR/USD
    if len(eur) >= 6:
        de = pct(eur[0][1], eur[5][1])
        s = 1 if de > 0.5 else -1 if de < -0.5 else 0
        score += s
        drivers.append({"n": "الدولار (عبر EUR/USD)", "s": "up" if s > 0 else "down" if s < 0 else "flat",
                        "why": f"اليورو {de:+.1f}% مقابل الدولار في 5 جلسات. ضعف الدولار عادةً داعم للدهب. ده مقياس بديل مش مؤشر DXY."})
    drivers.append({"n": "الجيوسياسة والبنوك المركزية والأخبار", "s": "flat",
                    "why": "غير مغطاة آلياً في هذه النسخة. التحليل هنا مبني على الأسعار والعوائد والفائدة فقط."})

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
    y10 = series(av_raw(function="TREASURY_YIELD", interval="daily", maturity="10year"), "value")[:10]
    ff = series(av_raw(function="FEDERAL_FUNDS_RATE", interval="monthly"), "value")[:3]
    cp = [v for _, v in series(av_raw(function="CPI", interval="monthly"), "value")[:13]]
    cpi = pct(cp[0], cp[12]) if len(cp) > 12 else None
    try:
        eur = get_eurusd()
    except Exception as e:
        print("EURUSD failed:", e)
        eur = []
    out = build(gold, y10, ff, cpi, eur)

    hist = json.load(open("history.json", encoding="utf-8"))
    evaluate(hist, gold)
    date = gold[0][0]
    hist["preds"] = [p for p in hist["preds"] if p.get("done") or p["date"] != date]
    lo, hi = out["base_range"]
    hist["preds"].append({"date": date, "dir": out["bias"]["dir"], "base_low": lo, "base_high": hi, "ref_close": out["ref"]})
    hist["preds"] = hist["preds"][-60:]
    hist["results"] = hist["results"][:60]
    res = hist["results"][:30]
    now = datetime.now(ZoneInfo("Africa/Cairo"))
    data = {
        "updated": now.strftime("%d/%m/%Y %H:%M") + " بتوقيت القاهرة، آخر إغلاق " + date,
        "note": f"تحليل آلي بقواعد ثابتة بيتحدث كل يوم عمل من بيانات ({src} وAlpha Vantage). مش بيشمل الأخبار ولا التقويم الاقتصادي. المستويات والنسب تقدير وليست توصية.",
        "bias": out["bias"], "drivers": out["drivers"], "scen": out["scen"], "levels": out["levels"], "cal": [],
        "acc": {"hit": sum(r["ok"] for r in res), "total": len(res), "rows": res[:8]},
    }
    json.dump(data, open("data.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    json.dump(hist, open("history.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("OK", date, out["bias"]["label"], out["score"])


if __name__ == "__main__":
    main()

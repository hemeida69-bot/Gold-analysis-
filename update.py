#!/usr/bin/env python3
"""Daily gold analysis on XAUUSD spot. Open sources only, no keys required:
gold-api.com (spot, sampled hourly into spot.json), US Treasury, NY Fed, BLS, Yahoo (DXY).
Analysis: Claude with web search if ANTHROPIC_API_KEY is set, else a rule-based engine."""
import csv, io, json, os, urllib.parse, urllib.request
import xau
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

DIR_AR = {"up": "صاعد", "down": "هابط", "flat": "محايد"}
UA = {"User-Agent": "Mozilla/5.0 gold-analysis/1.0"}
SEED = {"ticks": [[1790983708, 4141.8]]}
CAIRO = ZoneInfo("Africa/Cairo")


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


def is_closed(nowu):
    wd, hr = nowu.weekday(), nowu.hour
    return (wd == 4 and hr >= 22) or wd == 5 or (wd == 6 and hr < 22)  # spot gold: Fri 22:00 UTC to Sun 22:00 UTC


def run_xau(price, st):
    nowu = datetime.now(timezone.utc)
    ep = int(nowu.timestamp())
    try:
        macro = json.load(open("data.json", encoding="utf-8"))["bias"]["dir"]
    except Exception:
        macro = None
    try:
        out = xau.compute(st["ticks"], price, ep, is_closed(nowu), macro)
        print("XAU OK", out["decision"]["status"], "closes", out["n_closes"], "levels", len(out["liquidity"]["levels"]))
    except Exception as e:
        print("XAU FAILED:", repr(e)[:300])
        try:
            out = json.load(open("xau.json", encoding="utf-8"))
        except Exception:
            out = {}
        out["error"] = repr(e)[:200]
    json.dump(out, open("xau.json", "w", encoding="utf-8"), ensure_ascii=False)


def load_spot():
    try:
        return json.load(open("spot.json", encoding="utf-8"))
    except Exception:
        return json.loads(json.dumps(SEED))


def live_main():
    sp, label, upd = get_spot()
    if sp is None:
        raise SystemExit("XAUUSD spot unavailable")
    nowu = datetime.now(timezone.utc)
    ep = int(nowu.timestamp())
    closed = is_closed(nowu)
    st = load_spot()
    ticks = st["ticks"]
    if not closed:  # market open: record an hourly close sample
        if not ticks or ep - ticks[-1][0] > 3300:
            ticks.append([ep, round(sp, 2)])
        else:
            ticks[-1] = [ep, round(sp, 2)]
    st["ticks"] = ticks[-400:]
    json.dump(st, open("spot.json", "w", encoding="utf-8"))
    ts = st["ticks"]
    prev = next((p for t, p in reversed(ts) if ep - t >= 3000), sp)
    ago = next((p for t, p in reversed(ts) if t <= ep - 86400), None)
    w24 = [p for t, p in ts if t > ep - 86400] + [sp]
    base24 = ago if ago else ts[0][1]
    rows = ts[-24:][::-1]
    hours = []
    for i, (t, p) in enumerate(rows):
        before = rows[i + 1][1] if i + 1 < len(rows) else None
        hours.append([datetime.fromtimestamp(t, CAIRO).strftime("%d/%m %H:%M"), p, round(p - before, 2) if before is not None else None])
    out = {
        "price": round(sp, 2), "t": datetime.fromtimestamp(upd, CAIRO).strftime("%d/%m %H:%M"),
        "stale_min": int((ep - upd) / 60), "closed": closed,
        "chg1h_pct": round(pct(sp, prev), 2), "chg24h_pct": round(pct(sp, base24), 2), "full24": bool(ago),
        "hi24": round(max(w24), 2), "lo24": round(min(w24), 2),
        "hours": hours, "bars": [p for _, p in ts[-48:]], "n": len(ts),
        "src": f"XAUUSD فوري ({label})", "updated": datetime.now(CAIRO).strftime("%d/%m/%Y %H:%M"),
    }
    json.dump(out, open("live.json", "w", encoding="utf-8"), ensure_ascii=False)
    print("LIVE OK", out["price"], out["t"], "hourly closes", len(ts), "stale_min", out["stale_min"])
    return out["price"], st


def build(bars, price, y10, real10, ff, cpi, usd):
    """bars = hourly XAUUSD closes, newest first."""
    n = len(bars)
    score, drivers = 0.0, []
    if n >= 7:
        ch6 = pct(bars[0], bars[6])
        k24 = min(24, n - 1)
        ch24 = pct(bars[0], bars[k24])
        w = bars[:min(n, 72)]
        hi72, lo72 = max(w), min(w)
        pos = (bars[0] - lo72) / (hi72 - lo72) if hi72 > lo72 else 0.5
        w24 = bars[:min(n, 24)]
        hi, lo = max(w24), min(w24)
        k = min(24, n - 1)
        adr = sum(abs(bars[i] - bars[i + 1]) for i in range(k)) / k
        s = 1 if ch24 > 0.8 else -1 if ch24 < -0.8 else 0
        s += 0.5 if pos > 0.66 else -0.5 if pos < 0.33 else 0
        score += s
        drivers.append({"n": "الأداء السعري (إغلاقات الساعة)", "s": "up" if s > 0 else "down" if s < 0 else "flat",
                        "why": f"XAUUSD {ch24:+.2f}% في آخر {k24} ساعة و{ch6:+.2f}% في آخر 6 ساعات، والسعر في {pos*100:.0f}% من نطاق آخر {len(w)} ساعة ({lo72:,.0f} إلى {hi72:,.0f})."})
    else:
        pr = bars + [price]
        hi, lo = max(pr), min(pr)
        adr = price * 0.0008
        drivers.append({"n": "الأداء السعري (إغلاقات الساعة)", "s": "flat",
                        "why": f"إغلاقات الساعة لسه بتتجمع ({n} حالياً). الحكم السعري يبدأ بعد 7 ساعات تداول، والنطاق الحالي تقديري."})
    if hi - lo < price * 0.003:
        hi, lo = max(hi, price * 1.0015), min(lo, price * 0.9985)
    step = max(6 * adr, price * 0.003)
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
    rr = lambda x: int(round(x))
    H, L_ = rr(hi), rr(lo)
    bull_t, bear_t = rr(hi + step), rr(lo - step)
    up_n = [x["n"] for x in drivers if x["s"] == "up"]
    dn_n = [x["n"] for x in drivers if x["s"] == "down"]
    summary = (f"XAUUSD الفوري عند {price:,.0f}. محصلة العوامل المحسوبة {score:+.1f}. "
               + ("الداعم: " + "، ".join(up_n) + ". " if up_n else "")
               + ("الضاغط: " + "، ".join(dn_n) + ". " if dn_n else "")
               + "الحسم بيتحدد بإغلاق ساعة خارج نطاق آخر 24 ساعة.")
    return {
        "bias": {"dir": d, "label": label, "conf": conf, "summary": summary},
        "base_range": [L_, H], "drivers": drivers,
        "scen": [
            {"n": "الأساسي: تذبذب داخل النطاق", "p": pbase, "trig": f"بين {L_:,} و {H:,}",
             "inv": "إغلاق ساعة خارج النطاق", "txt": "السعر يفضل داخل نطاق آخر 24 ساعة لحد ما يظهر محرك جديد."},
            {"n": "الصاعد: كسر أعلى النطاق", "p": pb, "trig": f"إغلاق ساعة فوق {H:,}",
             "inv": f"رجوع تحت {rr(hi - 0.5 * step):,}", "txt": f"استمرار الزخم يفتح الطريق نحو {bull_t:,} خلال الـ24 ساعة الجاية."},
            {"n": "الهابط: كسر أدنى النطاق", "p": pr_, "trig": f"إغلاق ساعة تحت {L_:,}",
             "inv": f"رجوع فوق {rr(lo + 0.5 * step):,}", "txt": f"استمرار الضغط يفتح الطريق نحو {bear_t:,} خلال الـ24 ساعة الجاية."},
        ],
        "levels": [{"v": bull_t, "t": "هدف صاعد", "c": "u"}, {"v": H, "t": "تفعيل الصاعد", "c": "u"},
                   {"v": rr(price), "t": "XAUUSD الآن", "c": "now"},
                   {"v": L_, "t": "تفعيل الهابط", "c": "d"}, {"v": bear_t, "t": "هدف هابط", "c": "d"}],
        "ref": round(price, 2), "score": round(score, 2),
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


def evaluate(hist, ticks):
    """A prediction made at time T is judged by the first hourly close at or after T+24h."""
    for p in hist["preds"]:
        if p.get("done"):
            continue
        nxt = next(((t, c) for t, c in ticks if t >= p["ep"] + 86400), None)
        if not nxt:
            continue
        t, c = nxt
        if p["dir"] == "up":
            ok = c > p["ref_close"]
        elif p["dir"] == "down":
            ok = c < p["ref_close"]
        else:
            ok = p["base_low"] <= c <= p["base_high"]
        hist["results"].insert(0, {"d": datetime.fromtimestamp(t, CAIRO).strftime("%d/%m %H:%M"), "f": DIR_AR[p["dir"]], "a": f"{c:,.0f}", "ok": bool(ok)})
        p["done"] = True


def _main():
    price, st = live_main()
    run_xau(price, st)
    has_claude = bool(os.environ.get("ANTHROPIC_API_KEY"))
    live_only = os.environ.get("MODE") == "live"
    if live_only and has_claude:
        return  # keep the last Claude analysis; only the live price refreshes hourly
    ticks = st["ticks"]
    bars = [p for _, p in reversed(ticks)]
    now_utc = datetime.now(timezone.utc)
    today = now_utc.strftime("%Y-%m-%d")
    y10 = safe("US10Y", lambda: treasury("yield_curve", "10 yr"), [])
    real10 = safe("TIPS10Y", lambda: treasury("real_yield_curve", "10 yr"), [])
    ff = safe("EFFR", effr, [])
    usd = safe("DXY", lambda: yahoo("DX-Y.NYB"), [])
    try:
        mc = json.load(open("macro.json", encoding="utf-8"))
    except Exception:
        mc = {}
    if mc.get("date") != today or mc.get("cpi") is None:  # BLS free tier: 25 calls/day, so once a day
        c = safe("CPI_YOY", cpi_yoy, None)
        if c is not None:
            mc = {"date": today, "cpi": c}
            json.dump(mc, open("macro.json", "w"))
    cpi = mc.get("cpi")
    rule = build(bars, price, y10, real10, ff, cpi, usd)

    out, mode = rule, "قواعد ثابتة"
    if has_claude and not live_only:
        m = {"xauusd_spot_now": round(price, 2), "hourly_closes_newest_first": bars[:48], "us10y": y10[:3],
             "real10y_tips": real10[:3], "fed_funds": ff, "cpi_yoy_pct": cpi, "dxy": usd[:3]}
        try:
            out, mode = analyze_claude(m, rule), "Claude مع بحث ويب"
        except Exception as e:
            print("Claude failed, using rule-based:", repr(e)[:300])

    hist = json.load(open("history.json", encoding="utf-8"))
    evaluate(hist, ticks)
    lo, hi = out["base_range"]
    if len(bars) >= 7 and not any(p.get("day") == today for p in hist["preds"]):
        hist["preds"].append({"day": today, "ep": int(now_utc.timestamp()), "dir": out["bias"]["dir"],
                              "base_low": lo, "base_high": hi, "ref_close": rule["ref"]})
    hist["preds"] = hist["preds"][-60:]
    hist["results"] = hist["results"][:60]
    res = hist["results"][:30]
    data = {
        "updated": datetime.now(CAIRO).strftime("%d/%m/%Y %H:%M") + " بتوقيت القاهرة، آخر إغلاق ساعة مسجل",
        "note": f"تحليل آلي على XAUUSD الفوري مبني على إغلاقات الساعة ({mode}). السعر من gold-api.com والتاريخ بيتجمع ذاتياً كل ساعة ({len(ticks)} إغلاق حالياً). العوائد من خزانة أمريكا، الفائدة من بنك نيويورك الفيدرالي، التضخم من BLS، الدولار من Yahoo. المستويات والنسب تقدير وليست توصية.",
        "bias": out["bias"], "drivers": out["drivers"], "scen": out["scen"], "levels": out["levels"], "cal": out.get("cal", []),
        "acc": {"hit": sum(r["ok"] for r in res), "total": len(res), "rows": res[:8]},
    }
    json.dump(data, open("data.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    json.dump(hist, open("history.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("OK", mode, out["bias"]["label"], "closes", len(bars))


AR_DIR = {"up": "صاعد", "down": "هابط", "flat": "محايد", None: "-"}
SITE = "https://hemeida69-bot.github.io/Gold-analysis-/"


def notify(force):
    """Push via ntfy.sh to the phone/iPad. Sends on meaningful changes, plus a summary when forced (daily run)."""
    topic = os.environ.get("NTFY_TOPIC", "").strip()
    try:
        x = json.load(open("xau.json", encoding="utf-8"))
        d = json.load(open("data.json", encoding="utf-8"))
    except Exception as e:
        print("notify: data missing", repr(e)[:100])
        return
    lv = x.get("liquidity", {}).get("levels", [])
    cur = {"status": x["decision"]["status"], "macro": d["bias"]["dir"],
           "swept": sorted(f'{l["label"]}@{l["price"]}' for l in lv if l.get("swept"))}
    try:
        old = json.load(open("notify.json", encoding="utf-8"))
    except Exception:
        old = None
    events = []
    if old is not None:
        if cur["status"] != old.get("status"):
            events.append(f'حالة التداول: {old.get("status")} ← {cur["status"]}')
        if cur["macro"] != old.get("macro"):
            events.append(f'الاتجاه الكلي: {AR_DIR.get(old.get("macro"))} ← {AR_DIR.get(cur["macro"])}')
        for k in set(cur["swept"]) - set(old.get("swept", [])):
            events.append("اتسحبت سيولة: " + k.replace("@", " عند "))
    json.dump(cur, open("notify.json", "w", encoding="utf-8"), ensure_ascii=False)
    if not topic or not (events or force):
        print("notify: nothing to send" if topic else "notify: NTFY_TOPIC not set")
        return
    nb, ns = x["liquidity"].get("nearest_bsl"), x["liquidity"].get("nearest_ssl")
    lines = list(events) or ["تحديث دوري"]
    lines.append(f'{x["decision"]["headline"]} · {x["decision"]["sub"]}')
    lines.append(f'الاتجاه الكلي: {d["bias"]["label"]} ({d["bias"]["conf"]}%)')
    if nb:
        lines.append(f'أقرب سيولة شراء: {nb["label"]} {nb["price"]:,.2f}')
    if ns:
        lines.append(f'أقرب سيولة بيع: {ns["label"]} {ns["price"]:,.2f}')
    good = cur["status"] == "WAIT" and old is not None and old.get("status") != "WAIT"
    body = {"topic": topic, "title": f'XAUUSD {x["price"]:,.2f}', "message": "\n".join(lines),
            "priority": 4 if good else 3, "tags": ["chart_with_upwards_trend" if good else "bell"], "click": SITE}
    http("https://ntfy.sh/", json.dumps(body).encode(), {"Content-Type": "application/json"})
    print("notify: sent", len(events), "events")


def main():
    _main()
    try:
        notify(os.environ.get("MODE", "full") == "full" or os.environ.get("NOTIFY_ALL") == "true")
    except Exception as e:
        print("notify failed:", repr(e)[:200])


if __name__ == "__main__":
    main()

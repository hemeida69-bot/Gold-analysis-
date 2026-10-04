#!/usr/bin/env python3
"""XAUUSD-only structure from the hourly spot closes recorded in spot.json (no futures, no external candles).
Levels use closes, not true wicks, so they are approximations of the real highs/lows. Stated on the page."""
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

CAIRO = ZoneInfo("Africa/Cairo")
CFG = {"MIN_CLOSES": 12, "SESSIONS": {"asia": (0, 7), "london": (7, 16), "ny": (12, 21)}}  # UTC hours
SES_AR = {"asia": "آسيا", "london": "لندن", "ny": "نيويورك"}


def atr(c, n=14):
    if len(c) < 3:
        return 0.0
    tr = [max(x["h"] - x["l"], abs(x["h"] - p["c"]), abs(x["l"] - p["c"])) for p, x in zip(c[-n - 1:-1], c[-n:])]
    return sum(tr) / len(tr)


def swings(c, k):
    hi, lo = [], []
    for i in range(k, len(c) - k):
        w = c[i - k:i + k + 1]
        if c[i]["h"] >= max(x["h"] for x in w):
            hi.append((i, c[i]["h"]))
        if c[i]["l"] <= min(x["l"] for x in w):
            lo.append((i, c[i]["l"]))
    return hi, lo


def trend(c, k):
    hi, lo = swings(c, k)
    if len(hi) < 2 or len(lo) < 2:
        return "flat"
    hh, hl = hi[-1][1] > hi[-2][1], lo[-1][1] > lo[-2][1]
    return "up" if hh and hl else "down" if (not hh and not hl) else "flat"


def swept(level, side, t_after, c):
    return any(x["t"] > t_after and ((side == "buy" and x["h"] > level) or (side == "sell" and x["l"] < level)) for x in c)


def build_sessions(c15, now_ep, closed, price):
    day = datetime.fromtimestamp(c15[-1]["t"], timezone.utc).date()
    base = int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp())
    res = {}
    for name, (s, e) in CFG["SESSIONS"].items():
        st, en = base + s * 3600, base + e * 3600
        cs = [x for x in c15 if st <= x["t"] < en]
        hi = max(x["h"] for x in cs) if cs else None
        lo = min(x["l"] for x in cs) if cs else None
        if closed:
            status = "CLOSED"
        elif now_ep < st:
            status = "UPCOMING"
        elif now_ep < en:
            status = "OPEN"
        else:
            status = "CLOSED"
        res[name] = {"name": name, "ar": SES_AR[name], "status": status, "start": st, "end": en, "high": hi, "low": lo, "cs": cs}
    out = []
    for name, r in res.items():
        ev = []
        if r["high"] is not None and r["status"] == "CLOSED":
            after = [x for x in c15 if x["t"] >= r["end"]]
            if any(x["h"] > r["high"] for x in after):
                ev.append(f'{r["ar"]}: القمة اتسحبت ✓')
            if any(x["l"] < r["low"] for x in after):
                ev.append(f'{r["ar"]}: القاع اتسحب ✓')
        if name == "ny" and r["cs"] and res["london"]["high"] is not None:
            lh, ll = res["london"]["high"], res["london"]["low"]
            if any(x["h"] > lh for x in r["cs"]):
                ev.append("نيويورك سحبت قمة لندن ✓")
            if any(x["l"] < ll for x in r["cs"]):
                ev.append("نيويورك سحبت قاع لندن ✓")
        pos = None
        if r["high"] is not None:
            rng = r["high"] - r["low"]
            pos = "فوق المدى" if price > r["high"] else "تحت المدى" if price < r["low"] else f"داخل المدى ({(price - r['low']) / rng * 100 if rng else 50:.0f}%)"
        sc = datetime.fromtimestamp(r["start"], CAIRO)
        out.append({"name": name, "ar": r["ar"], "status": r["status"], "high": r["high"], "low": r["low"],
                    "range": (r["high"] - r["low"]) if r["high"] is not None else None, "position": pos, "events": ev,
                    "start_cairo": sc.strftime("%H:%M"), "end_cairo": datetime.fromtimestamp(r["end"], CAIRO).strftime("%H:%M"),
                    "start_h": sc.hour + sc.minute / 60, "len_h": (r["end"] - r["start"]) / 3600, "has_data": r["high"] is not None,
                    "high_t": r["end"], "_hi": r["high"], "_lo": r["low"]})
    return out


def build_liquidity(c15, h1, sess, price, a15):
    lv = []

    def add(p, side, label, kind, t):
        if any(abs(x["price"] - p) < 0.4 and x["side"] == side for x in lv):
            return
        lv.append({"price": round(p, 2), "side": side, "label": label, "kind": kind, "t": t, "swept": swept(p, side, t, c15)})

    days = sorted({datetime.fromtimestamp(x["t"], timezone.utc).date() for x in c15})
    if len(days) >= 2:
        prev = [x for x in c15 if datetime.fromtimestamp(x["t"], timezone.utc).date() == days[-2]]
        add(max(x["h"] for x in prev), "buy", "PDH", "Previous Day High", prev[-1]["t"])
        add(min(x["l"] for x in prev), "sell", "PDL", "Previous Day Low", prev[-1]["t"])
    for s in sess:
        if s["_hi"] is not None:
            t = s["high_t"] if s["status"] == "CLOSED" else 10 ** 12
            add(s["_hi"], "buy", f'{s["ar"]} High', "Session High", t)
            add(s["_lo"], "sell", f'{s["ar"]} Low', "Session Low", t)
    sub = c15[-200:]
    hi, lo = swings(sub, 2)
    tol = max(1.5, 0.35 * a15)
    for arr, side, lab, kind in ((hi, "buy", "EQH", "Equal Highs"), (lo, "sell", "EQL", "Equal Lows")):
        for i in range(len(arr)):
            for j in range(i + 1, len(arr)):
                if arr[j][0] - arr[i][0] >= 4 and abs(arr[j][1] - arr[i][1]) <= tol:
                    add(max(arr[i][1], arr[j][1]) if side == "buy" else min(arr[i][1], arr[j][1]), side, lab, kind, sub[arr[j][0]]["t"])
    hh, hl = swings(h1, 2)
    for i, p in hh[-4:]:
        add(p, "buy", "Swing High", "Recent Swing High", h1[i]["t"])
    for i, p in hl[-4:]:
        add(p, "sell", "Swing Low", "Recent Swing Low", h1[i]["t"])
    for x in lv:
        x["dist"] = round(x["price"] - price, 2)
    lv.sort(key=lambda x: abs(x["dist"]))
    return lv




def compute(ticks, spot, now_ep, closed, macro_dir):
    cs = [{"t": t, "o": p, "h": p, "l": p, "c": p} for t, p in ticks]
    n = len(cs)
    a = atr(cs) if n > 3 else 0.0
    sess = build_sessions(cs, now_ep, closed, spot) if n else []
    levels = build_liquidity(cs, cs, sess, spot, a) if n else []
    trd = trend(cs, 2) if n >= CFG["MIN_CLOSES"] else "flat"
    open_buy = sorted([lv for lv in levels if lv["side"] == "buy" and not lv["swept"] and lv["price"] > spot], key=lambda x: x["price"])
    open_sell = sorted([lv for lv in levels if lv["side"] == "sell" and not lv["swept"] and lv["price"] < spot], key=lambda x: -x["price"])
    bsl, ssl = (open_buy[0] if open_buy else None), (open_sell[0] if open_sell else None)
    reasons = []
    if closed:
        reasons.append({"code": "closed", "text": "السوق مقفول. المستويات من آخر جلسة وبتتحدث مع افتتاح السوق."})
    if n < CFG["MIN_CLOSES"]:
        reasons.append({"code": "no_data", "text": f"إغلاقات الساعة لسه بتتجمع ({n} من {CFG['MIN_CLOSES']} على الأقل). مفيش هيكل يتحكم عليه."})
    else:
        if trd == "flat":
            reasons.append({"code": "unclear", "text": "هيكل السوق على إغلاقات الساعة غير واضح (مفيش قمم وقيعان متتابعة)."})
        if macro_dir in ("up", "down") and trd in ("up", "down") and macro_dir != trd:
            reasons.append({"code": "conflict", "text": "تعارض بين الاتجاه الكلي (عوامل الماكرو) والهيكل الساعي."})
        if not bsl or not ssl:
            reasons.append({"code": "no_target", "text": "لا يوجد مستوى سيولة غير مسحوب في أحد الاتجاهين."})
        elif 0.3 < (spot - ssl["price"]) / (bsl["price"] - ssl["price"]) < 0.7:
            reasons.append({"code": "between_pools", "text": f"السعر في منتصف المسافة بين تجمعات السيولة ({ssl['price']:,.0f} و {bsl['price']:,.0f})."})
    if bsl and ssl:
        z_lo, z_hi = ssl["price"] + 0.3 * (bsl["price"] - ssl["price"]), ssl["price"] + 0.7 * (bsl["price"] - ssl["price"])
        inval = f"إغلاق ساعة فوق {bsl['price']:,.0f} أو تحت {ssl['price']:,.0f} بيغيّر الصورة."
    else:
        z_lo, z_hi = spot - a, spot + a
        inval = "كسر أقرب مستوى سيولة بيغيّر الصورة."
    need, codes = [], {r["code"] for r in reasons}
    if "closed" in codes:
        need.append("انتظار افتتاح السوق (الأحد 22:00 UTC).")
    if "no_data" in codes:
        need.append("تجميع إغلاقات ساعة كافية (تلقائي مع ساعات التداول).")
    if codes & {"unclear", "conflict"}:
        need.append("اتفاق الهيكل الساعي مع الاتجاه الكلي بقمم وقيعان واضحة.")
    if codes & {"between_pools", "no_target"}:
        need.append("اقتراب السعر من مستوى سيولة واضح أو ظهور مستوى جديد.")
    if reasons:
        status, head, sub = "NO TRADE", "NO TRADE", reasons[0]["text"]
    else:
        tgt = bsl if trd == "up" else ssl
        status, head = "WAIT", "WAIT — لا تدخل بدون تأكيدك"
        sub = f"الهيكل الساعي {'صاعد' if trd == 'up' else 'هابط'}. أقرب هدف سيولة {tgt['label']} عند {tgt['price']:,.2f}. التأكيد والدخول بتعمله انت على الشارت."
        need = ["تأكيدك اليدوي على شارتك قبل أي دخول."]
    nb = {"price": bsl["price"], "label": bsl["label"], "dist": bsl["dist"]} if bsl else None
    ns = {"price": ssl["price"], "label": ssl["label"], "dist": ssl["dist"]} if ssl else None
    for s_ in sess:
        for k in ("_hi", "_lo", "high_t"):
            s_.pop(k, None)
    return {"ts": now_ep, "updated": datetime.fromtimestamp(now_ep, CAIRO).strftime("%d/%m %H:%M"), "closed": closed, "price": round(spot, 2),
            "n_closes": n, "trend": trd, "macro": macro_dir,
            "decision": {"status": status, "headline": head, "sub": sub},
            "no_trade": {"active": status == "NO TRADE", "reasons": reasons, "zone": {"lo": round(z_lo, 2), "hi": round(z_hi, 2)}, "need": need, "invalidates": inval},
            "liquidity": {"levels": [lv for lv in levels if abs(lv["dist"]) <= 80][:30], "nearest_bsl": nb, "nearest_ssl": ns},
            "sessions": sess}

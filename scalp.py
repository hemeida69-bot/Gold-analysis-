"""XAUUSD M15 scalp engine. Candles are built from self-collected spot ticks (see collect.py). Signals are mechanical ideas, not advice."""
import json, math, os, time, urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

CAIRO = ZoneInfo("Africa/Cairo")
NEED, COVER, LOOK = 16, 8, 64
EXPIRE, COOL, FRESH = 3 * 3600, 45 * 60, 45 * 60
SETUP_AR = {"SWEEP": "سحب سيولة + استرجاع", "BREAK": "كسر بزخم"}


def load(p, d):
    try:
        return json.load(open(p))
    except Exception:
        return d


def closed(n):
    w, h = n.weekday(), n.hour
    return (w == 4 and h >= 22) or w == 5 or (w == 6 and h < 22)


def build_m15(m1, now):
    b = {}
    for t, o, h, l, c, n in m1:
        k = t // 900 * 900
        x = b.get(k)
        if x is None:
            b[k] = [o, h, l, c, 1]
        else:
            x[1] = max(x[1], h); x[2] = min(x[2], l); x[3] = c; x[4] += 1
    cur = now // 900 * 900
    done = [[k, v[0], v[1], v[2], v[3]] for k, v in sorted(b.items()) if k < cur and v[4] >= COVER]
    return done


def atr(cs, n=14):
    trs = []
    for i in range(1, len(cs)):
        pc = cs[i - 1][4] if cs[i][0] - cs[i - 1][0] == 900 else cs[i][1]
        trs.append(max(cs[i][2] - cs[i][3], abs(cs[i][2] - pc), abs(cs[i][3] - pc)))
    t = trs[-n:]
    return sum(t) / len(t) if t else 0.0


def swings(cs):
    sh, sl = [], []
    for i in range(2, len(cs) - 2):
        if cs[i][2] > max(cs[i - 2][2], cs[i - 1][2], cs[i + 1][2], cs[i + 2][2]):
            sh.append((i, cs[i][2]))
        if cs[i][3] < min(cs[i - 2][3], cs[i - 1][3], cs[i + 1][3], cs[i + 2][3]):
            sl.append((i, cs[i][3]))
    return sh, sl


def trend(sh, sl):
    if len(sh) >= 2 and len(sl) >= 2:
        if sh[-1][1] > sh[-2][1] and sl[-1][1] > sl[-2][1]:
            return "UP"
        if sh[-1][1] < sh[-2][1] and sl[-1][1] < sl[-2][1]:
            return "DOWN"
    return "RANGE"


def detect(cs, idx, a):
    t, o, h, l, cl = cs[idx]
    rng = h - l
    if rng <= 0 or a <= 0:
        return None
    pre = cs[max(0, idx - LOOK):idx]
    sh, sl = swings(pre)
    tr = trend(sh, sl)
    buf = max(0.10, 0.03 * a)
    body = abs(cl - o)
    lw, uw = min(o, cl) - l, h - max(o, cl)
    un_low = lambda i, L: all(pre[j][3] >= L for j in range(i + 1, len(pre)))
    un_high = lambda i, H: all(pre[j][2] <= H for j in range(i + 1, len(pre)))
    found = None
    for i, L in reversed(sl):
        if un_low(i, L) and l < L - buf and cl > L and lw >= 0.3 * rng and rng >= 0.4 * a:
            found = ("SWEEP", "BUY", cl, l - 0.15 * a, L); break
    if not found:
        for i, H in reversed(sh):
            if un_high(i, H) and h > H + buf and cl < H and uw >= 0.3 * rng and rng >= 0.4 * a:
                found = ("SWEEP", "SELL", cl, h + 0.15 * a, H); break
    if not found and sh:
        i, H = sh[-1]
        if un_high(i, H) and cl > H + buf and body >= 0.6 * rng and body >= 0.8 * a:
            prev_low = pre[-1][3] if pre else l
            found = ("BREAK", "BUY", cl, min(l, prev_low) - 0.1 * a, H)
    if not found and sl:
        i, L = sl[-1]
        if un_low(i, L) and cl < L - buf and body >= 0.6 * rng and body >= 0.8 * a:
            prev_high = pre[-1][2] if pre else h
            found = ("BREAK", "SELL", cl, max(h, prev_high) + 0.1 * a, L)
    if not found:
        return None
    setup, side, entry, slp, lvl = found
    risk = abs(entry - slp)
    if risk < 1.0 or risk < 0.5 * a or risk > 2.2 * a:
        return None
    k = 1 if side == "BUY" else -1
    grade = "A" if (side == "BUY" and tr == "UP") or (side == "SELL" and tr == "DOWN") else "B"
    return {"id": f"{t}-{side}-{setup}", "t": t + 900, "setup": setup, "side": side, "grade": grade, "trend": tr,
            "entry": round(entry, 2), "sl": round(slp, 2), "tp1": round(entry + k * risk, 2), "tp2": round(entry + 2 * k * risk, 2),
            "risk": round(risk, 2), "level": round(lvl, 2), "status": "OPEN", "r": None, "closed_t": None}


def evaluate(sig, m1, now):
    if sig["status"] != "OPEN":
        return
    buy = sig["side"] == "BUY"
    for t, o, h, l, c, n in m1:
        if t < sig["t"]:
            continue
        sl_hit = l <= sig["sl"] if buy else h >= sig["sl"]
        tp_hit = h >= sig["tp1"] if buy else l <= sig["tp1"]
        if sl_hit:  # conservative: if both in the same minute, count the loss
            sig.update(status="SL", r=-1, closed_t=t); return
        if tp_hit:
            sig.update(status="TP", r=1, closed_t=t); return
    if now - sig["t"] > EXPIRE:
        sig.update(status="EXPIRED", r=0, closed_t=now)


def stats(sigs):
    w = sum(1 for s in sigs if s["status"] == "TP")
    l = sum(1 for s in sigs if s["status"] == "SL")
    ex = sum(1 for s in sigs if s["status"] == "EXPIRED")
    return {"n": len(sigs), "wins": w, "losses": l, "expired": ex, "net_r": w - l,
            "winrate": round(w / (w + l) * 100) if (w + l) else None}


def run(m1, sigs, now):
    nowu = datetime.fromtimestamp(now, timezone.utc)
    cs = build_m15(m1, now)
    for s in sigs:
        evaluate(s, m1, now)
    a = atr(cs)
    price = m1[-1][4] if m1 else None
    last_t = m1[-1][0] if m1 else None
    new = []
    if len(cs) >= NEED and not closed(nowu):
        for idx in range(max(0, len(cs) - 2), len(cs)):
            if now - (cs[idx][0] + 900) > FRESH:
                continue
            s = detect(cs, idx, a)
            if not s or any(x["id"] == s["id"] for x in sigs):
                continue
            if any(x["side"] == s["side"] and (x["status"] == "OPEN" or s["t"] - x["t"] < COOL) for x in sigs):
                continue
            sigs.append(s); new.append(s)
    sigs[:] = sigs[-200:]
    sh, sl = swings(cs[-LOOK:]) if len(cs) >= 5 else ([], [])
    view = cs[-LOOK:]
    up = [H for i, H in sh if price and H > price and all(view[j][2] <= H for j in range(i + 1, len(view)))]
    dn = [L for i, L in sl if price and L < price and all(view[j][3] >= L for j in range(i + 1, len(view)))]
    nh = min(up) if up else None
    nl = max(dn) if dn else None
    opens = [s for s in sigs if s["status"] == "OPEN"]
    if closed(nowu):
        status, reason = "CLOSED", "السوق مقفول. التجميع بيرجع تلقائياً مع فتح السوق."
    elif len(cs) < NEED:
        hrs = math.ceil((NEED - len(cs)) * 15 / 60)
        status, reason = "WARMUP", f"بجمع شموع M15 من السعر الفوري: {len(cs)}/{NEED}. أول إشارات بعد حوالي {hrs} ساعة تجميع."
    elif last_t and now - last_t > 1800:
        status, reason = "STALE", "التجميع واقف أو ناقص من أكتر من نص ساعة (تأخير جدولة GitHub). الإشارات متوقفة لحد ما يرجع."
    elif opens:
        status, reason = "SIGNAL", "في صفقة مفتوحة تحت المتابعة."
    else:
        parts = []
        if nl: parts.append(f"شراء لو السعر سحب تحت {nl:.2f} ورجع قفل فوقه")
        if nh: parts.append(f"بيع لو سحب فوق {nh:.2f} ورجع قفل تحته")
        status = "WAIT"
        reason = "مفيش سيتاب مكتمل دلوقتي. مستنّي: " + (" · ".join(parts) if parts else "تكوّن قمم/قيعان واضحة") + " · أو شمعة كسر بجسم قوي."
    out = {"updated": now, "status": status, "reason": reason, "price": price, "atr": round(a, 2), "n_candles": len(cs), "need": NEED,
           "trend": trend(*swings(cs[-LOOK:])) if len(cs) >= 5 else "RANGE",
           "watch": {"buy_below": nl, "sell_above": nh},
           "m15": cs[-16:], "active": opens, "recent": sigs[-12:][::-1], "stats": stats(sigs)}
    return out, new


def ntfy(s):
    topic = os.environ.get("NTFY_TOPIC")
    if not topic:
        return
    k = "شراء" if s["side"] == "BUY" else "بيع"
    msg = f"{SETUP_AR[s['setup']]} · درجة {s['grade']}\nدخول {s['entry']} | SL {s['sl']}\nTP1 {s['tp1']} | TP2 {s['tp2']} | مخاطرة {s['risk']}$\nفكرة آلية: أكّد على شارتك قبل الدخول."
    body = json.dumps({"topic": topic, "title": f"سكالب XAUUSD {k}", "message": msg, "priority": 4, "tags": ["zap"]}).encode()
    try:
        urllib.request.urlopen(urllib.request.Request("https://ntfy.sh/", data=body, headers={"Content-Type": "application/json"}), timeout=15)
    except Exception as e:
        print("ntfy failed", e)


def main():
    now = int(time.time())
    m1 = load("candles.json", {"m1": []})["m1"]
    sigs = load("signals.json", [])
    out, new = run(m1, sigs, now)
    json.dump(out, open("scalp.json", "w"), ensure_ascii=False, separators=(",", ":"))
    json.dump(sigs, open("signals.json", "w"), ensure_ascii=False, separators=(",", ":"))
    for s in new:
        ntfy(s)
    print("scalp", out["status"], "candles", out["n_candles"], "new", len(new), out["stats"])


if __name__ == "__main__":
    main()

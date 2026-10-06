"""XAUUSD scalp engine (M5 entries, M15 bias). Candles are built from self-collected spot ticks (see collect.py).
Signals are mechanical ideas, not advice."""
import json, math, os, sys, time, urllib.request
from datetime import datetime, timezone

TF = {
    "M15": {"sec": 900, "cover": 7, "exp": 10800, "need": 16, "look": 64, "minrisk": 1.5},
    "M5": {"sec": 300, "cover": 3, "exp": 5400, "need": 30, "look": 96, "minrisk": 1.2},
}
COOL, FRESH = 30 * 60, 30 * 60
SETUP_AR = {"SWEEP": "سحب سيولة + استرجاع", "BREAK": "كسر بزخم", "PULLBACK": "ارتداد من تصحيح"}


def load(p, d):
    try:
        return json.load(open(p))
    except Exception:
        return d


def closed(n):
    w, h = n.weekday(), n.hour
    return (w == 4 and h >= 22) or w == 5 or (w == 6 and h < 22)


def build(m1, now, sec, cover):
    b = {}
    for t, o, h, l, c, n in m1:
        k = t // sec * sec
        x = b.get(k)
        if x is None:
            b[k] = [o, h, l, c, 1]
        else:
            x[1] = max(x[1], h); x[2] = min(x[2], l); x[3] = c; x[4] += 1
    cur = now // sec * sec
    return [[k, v[0], v[1], v[2], v[3]] for k, v in sorted(b.items()) if k < cur and v[4] >= cover]


def atr(cs, sec, n=14):
    trs = []
    for i in range(1, len(cs)):
        pc = cs[i - 1][4] if cs[i][0] - cs[i - 1][0] == sec else cs[i][1]
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


def detect(cs, idx, a, tfn, cfg, bias):
    t, o, h, l, cl = cs[idx]
    rng = h - l
    if rng <= 0 or a <= 0:
        return None
    pre = cs[max(0, idx - cfg["look"]):idx]
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
            found = ("SWEEP", "BUY", cl, l - 0.15 * a, L, [f"سحب قاع {L:.2f} ورجوع قفل فوقه", f"ذيل سفلي {lw / rng * 100:.0f}% من الشمعة"]); break
    if not found:
        for i, H in reversed(sh):
            if un_high(i, H) and h > H + buf and cl < H and uw >= 0.3 * rng and rng >= 0.4 * a:
                found = ("SWEEP", "SELL", cl, h + 0.15 * a, H, [f"سحب قمة {H:.2f} ورجوع قفل تحتها", f"ذيل علوي {uw / rng * 100:.0f}% من الشمعة"]); break
    if not found and sh and sl:
        ih, H = sh[-1]; il, L = sl[-1]; leg = H - L
        if il < ih and leg >= 1.5 * a and tr in ("UP", "RANGE") and cl < H:   # up-leg, pullback buy
            after = pre[ih + 1:] + [cs[idx]]
            zone_hi = H - 0.5 * leg
            if min(x[3] for x in after) >= max(L - 0.1 * a, H - 0.8 * leg) and l <= zone_hi + 0.1 * a and cl > o and lw >= 0.25 * rng and cl > (h + l) / 2:
                found = ("PULLBACK", "BUY", cl, l - 0.15 * a, L, [f"رجوع {(H - l) / leg * 100:.0f}% من موجة صاعدة {leg:.1f}$ ({L:.2f}→{H:.2f})", "شمعة رفض صاعدة"])
        if not found and ih < il and leg >= 1.5 * a and tr in ("DOWN", "RANGE") and cl > L:   # down-leg, pullback sell
            after = pre[il + 1:] + [cs[idx]]
            zone_lo = L + 0.5 * leg
            if max(x[2] for x in after) <= min(H + 0.1 * a, L + 0.8 * leg) and h >= zone_lo - 0.1 * a and cl < o and uw >= 0.25 * rng and cl < (h + l) / 2:
                found = ("PULLBACK", "SELL", cl, h + 0.15 * a, H, [f"رجوع {(h - L) / leg * 100:.0f}% من موجة هابطة {leg:.1f}$ ({H:.2f}→{L:.2f})", "شمعة رفض هابطة"])
    if not found and sh:
        i, H = sh[-1]
        if un_high(i, H) and cl > H + buf and body >= 0.6 * rng and body >= 0.8 * a:
            prev_low = pre[-1][3] if pre else l
            found = ("BREAK", "BUY", cl, min(l, prev_low) - 0.1 * a, H, [f"كسر قمة {H:.2f} بجسم {body / a:.1f}×ATR"])
    if not found and sl:
        i, L = sl[-1]
        if un_low(i, L) and cl < L - buf and body >= 0.6 * rng and body >= 0.8 * a:
            prev_high = pre[-1][2] if pre else h
            found = ("BREAK", "SELL", cl, max(h, prev_high) + 0.1 * a, L, [f"كسر قاع {L:.2f} بجسم {body / a:.1f}×ATR"])
    if not found:
        return None
    setup, side, entry, slp, lvl, why = found
    risk = abs(entry - slp)
    if risk < max(cfg["minrisk"], 0.5 * a) or risk > 2.2 * a:
        return None
    k = 1 if side == "BUY" else -1
    aligned = (side == "BUY" and bias == "UP") or (side == "SELL" and bias == "DOWN")
    why.append(f"مع اتجاه M15 ({bias})" if aligned else f"اتجاه M15 {bias}: مش مع الاتجاه، درجة أقل")
    return {"id": f"{tfn}-{t}-{side}-{setup}", "tf": tfn, "t": t + cfg["sec"], "setup": setup, "side": side,
            "grade": "A" if aligned else "B", "trend": bias, "why": why, "exp": cfg["exp"],
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
    if now - sig["t"] > sig.get("exp", 10800):
        sig.update(status="EXPIRED", r=0, closed_t=now)


def stats(sigs):
    def one(ss):
        w = sum(1 for s in ss if s["status"] == "TP"); l = sum(1 for s in ss if s["status"] == "SL")
        return {"n": len(ss), "wins": w, "losses": l, "expired": sum(1 for s in ss if s["status"] == "EXPIRED"),
                "net_r": w - l, "winrate": round(w / (w + l) * 100) if (w + l) else None}
    out = one(sigs)
    out["by_tf"] = {k: one([s for s in sigs if s.get("tf", "M15") == k]) for k in TF}
    return out


def plan_of(cs15):
    if len(cs15) < 8:
        return None
    sh, sl = swings(cs15[-TF["M15"]["look"]:])
    if not sh or not sl:
        return None
    ih, H = sh[-1]; il, L = sl[-1]; leg = H - L
    if leg < 1.5 * atr(cs15, 900):
        return None
    if il < ih:
        return {"dir": "UP", "leg": [round(L, 2), round(H, 2)], "zone": [round(H - 0.618 * leg, 2), round(H - 0.5 * leg, 2)]}
    return {"dir": "DOWN", "leg": [round(H, 2), round(L, 2)], "zone": [round(L + 0.5 * leg, 2), round(L + 0.618 * leg, 2)]}


def run(m1, sigs, now):
    nowu = datetime.fromtimestamp(now, timezone.utc)
    c15 = build(m1, now, 900, TF["M15"]["cover"])
    sh15, sl15 = swings(c15[-TF["M15"]["look"]:]) if len(c15) >= 5 else ([], [])
    bias = trend(sh15, sl15)
    for s in sigs:
        evaluate(s, m1, now)
    price = m1[-1][4] if m1 else None
    last_t = m1[-1][0] if m1 else None
    new = []
    if not closed(nowu):
        for tfn, cfg in TF.items():
            cs = c15 if tfn == "M15" else build(m1, now, cfg["sec"], cfg["cover"])
            if len(cs) < cfg["need"]:
                continue
            a = atr(cs, cfg["sec"])
            for idx in range(max(0, len(cs) - 2), len(cs)):
                if now - (cs[idx][0] + cfg["sec"]) > FRESH:
                    continue
                s = detect(cs, idx, a, tfn, cfg, bias)
                if not s or any(x["id"] == s["id"] for x in sigs):
                    continue
                if any(x["side"] == s["side"] and (x["status"] == "OPEN" or s["t"] - x["t"] < COOL) for x in sigs):
                    continue
                sigs.append(s); new.append(s)
    sigs[:] = sigs[-300:]
    view = c15[-TF["M15"]["look"]:]
    up = [H for i, H in sh15 if price and H > price and all(view[j][2] <= H for j in range(i + 1, len(view)))]
    dn = [L for i, L in sl15 if price and L < price and all(view[j][3] >= L for j in range(i + 1, len(view)))]
    nh, nl = (min(up) if up else None), (max(dn) if dn else None)
    plan = plan_of(c15)
    opens = [s for s in sigs if s["status"] == "OPEN"]
    if closed(nowu):
        status, reason = "CLOSED", "السوق مقفول. التجميع بيرجع تلقائياً مع فتح السوق."
    elif len(c15) < TF["M15"]["need"]:
        hrs = math.ceil((TF["M15"]["need"] - len(c15)) * 15 / 60)
        status, reason = "WARMUP", f"بجمع شموع M15: {len(c15)}/{TF['M15']['need']}. أول إشارات بعد حوالي {hrs} ساعة تجميع."
    elif last_t and now - last_t > 1800:
        status, reason = "STALE", "التجميع واقف أو ناقص من أكتر من نص ساعة (تأخير جدولة GitHub). الإشارات متوقفة لحد ما يرجع."
    elif opens:
        status, reason = "SIGNAL", "في صفقة مفتوحة تحت المتابعة."
    else:
        parts = []
        if plan:
            d = "صاعدة" if plan["dir"] == "UP" else "هابطة"
            parts.append(f"موجة {d} ({plan['leg'][0]:.2f}→{plan['leg'][1]:.2f}): ارتداد لو رجع لمنطقة {plan['zone'][0]:.2f}-{plan['zone'][1]:.2f} وطلعت شمعة رفض")
        if nl: parts.append(f"شراء لو سحب تحت {nl:.2f} ورجع قفل فوقه")
        if nh: parts.append(f"بيع لو سحب فوق {nh:.2f} ورجع قفل تحتها")
        status = "WAIT"
        reason = "مفيش سيتاب مكتمل دلوقتي. مستنّي: " + (" · ".join(parts) if parts else "تكوّن موجة وقمم/قيعان واضحة") + "."
    a15 = atr(c15, 900)
    a5 = atr(build(m1, now, 300, TF["M5"]["cover"]), 300)
    out = {"updated": now, "status": status, "reason": reason, "price": price, "atr": round(a15, 2), "atr5": round(a5, 2),
           "n_candles": len(c15), "need": TF["M15"]["need"], "trend": bias, "plan": plan,
           "watch": {"buy_below": nl, "sell_above": nh}, "m15": c15[-16:], "active": opens,
           "recent": sigs[-12:][::-1], "stats": stats(sigs)}
    return out, new


def ntfy(s):
    topic = os.environ.get("NTFY_TOPIC")
    if not topic:
        return
    k = "شراء" if s["side"] == "BUY" else "بيع"
    msg = (f"{s.get('tf', 'M15')} · {SETUP_AR[s['setup']]} · درجة {s['grade']}\nدخول {s['entry']} | SL {s['sl']}\n"
           f"TP1 {s['tp1']} | TP2 {s['tp2']} | مخاطرة {s['risk']}$\n" + " · ".join(s.get("why", [])) + "\nفكرة آلية: أكّد على شارتك قبل الدخول.")
    body = json.dumps({"topic": topic, "title": f"سكالب XAUUSD {k}", "message": msg, "priority": 4, "tags": ["zap"]}).encode()
    try:
        urllib.request.urlopen(urllib.request.Request("https://ntfy.sh/", data=body, headers={"Content-Type": "application/json"}), timeout=15)
    except Exception as e:
        print("ntfy failed", e)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "notify":   # run only after a successful push
        for s in load("new_signals.json", []):
            ntfy(s)
        return
    now = int(time.time())
    m1 = load("candles.json", {"m1": []})["m1"]
    sigs = load("signals.json", [])
    out, new = run(m1, sigs, now)
    json.dump(out, open("scalp.json", "w"), ensure_ascii=False, separators=(",", ":"))
    json.dump(sigs, open("signals.json", "w"), ensure_ascii=False, separators=(",", ":"))
    json.dump(new, open("new_signals.json", "w"), ensure_ascii=False)
    print("scalp", out["status"], "M15", out["n_candles"], "new", len(new), out["stats"]["n"])


if __name__ == "__main__":
    main()

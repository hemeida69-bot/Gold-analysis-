"""Collect XAUUSD spot ticks (every STEP seconds) into 1-minute candles (candles.json).
Every 5 minutes (just after an M5 candle closes) the collector flushes: merge -> scalp engine -> commit/push -> deploy."""
import json, os, subprocess, sys, time, urllib.request
from datetime import datetime, timezone

UA = {"User-Agent": "Mozilla/5.0 gold-analysis/1.0"}
DUR = int(os.environ.get("COLLECT_SEC", "1500"))
STEP = int(os.environ.get("STEP", "10"))
FLUSH = os.environ.get("FLUSH", "1") != "0"
KEEP = 3 * 24 * 60
TMP = "ticks_tmp.json"


def closed(n):
    w, h = n.weekday(), n.hour  # Mon=0 .. Sun=6
    return (w == 4 and h >= 22) or w == 5 or (w == 6 and h < 22)


def spot():
    try:
        req = urllib.request.Request("https://api.gold-api.com/price/XAU", headers=UA)
        with urllib.request.urlopen(req, timeout=10) as r:
            p = float(json.loads(r.read())["price"])
        return p if p > 1000 else None
    except Exception:
        return None


def merge():
    """Merge this run's ticks (TMP) into the latest candles.json."""
    try:
        m1 = {int(k): v for k, v in json.load(open(TMP)).items()}
    except Exception:
        return
    try:
        old = json.load(open("candles.json"))["m1"]
    except Exception:
        old = []
    d = {r[0]: r[1:] for r in old}
    for k, v in m1.items():
        e = d.get(k)
        if e is None:
            d[k] = [round(x, 2) for x in v[:4]] + [v[4]]
        else:
            d[k] = [e[0], round(max(e[1], v[1]), 2), round(min(e[2], v[2]), 2), round(v[3] if v[4] >= e[4] else e[3], 2), max(e[4], v[4])]
    rows = [[k] + d[k] for k in sorted(d)][-KEEP:]
    json.dump({"updated": int(time.time()), "m1": rows}, open("candles.json", "w"), separators=(",", ":"))
    print("merged minutes", len(m1), "total", len(rows))


def flush(m1):
    json.dump(m1, open(TMP, "w"))
    if not FLUSH:
        return
    try:
        subprocess.run(["bash", "flush.sh"], timeout=120)
    except Exception as e:
        print("flush failed", e)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "merge":
        merge(); return
    m1 = {}
    t_end = time.time() + DUR
    nxt = (time.time() // 300 + 1) * 300 + 25   # 25s after the next M5 boundary
    miss = 0
    while True:
        now = time.time()
        if closed(datetime.fromtimestamp(now, timezone.utc)):
            print("market closed, stopping")
            break
        p = spot()
        if p is None:
            miss += 1
        else:
            k = int(now // 60 * 60)
            c = m1.get(k)
            if c is None:
                m1[k] = [p, p, p, p, 1]
            else:
                c[1] = max(c[1], p); c[2] = min(c[2], p); c[3] = p; c[4] += 1
        if m1 and time.time() >= nxt:
            flush(m1)
            nxt = (time.time() // 300 + 1) * 300 + 25
        if time.time() + STEP >= t_end:
            break
        time.sleep(STEP)
    if m1:
        flush(m1)
    print("done. minutes", len(m1), "missed polls", miss)


if __name__ == "__main__":
    main()

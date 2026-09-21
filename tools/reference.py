#!/usr/bin/env python3
"""Эталонный пересчёт склада — вторая независимая реализация той же логики.

Нужен, чтобы сверять цифры приложения не на глаз, а против отдельного кода.
Если приложение и этот файл расходятся — кто-то из двоих врёт, и это находка.

  python3 tools/reference.py [файл-данных]
"""
import json, sys, datetime as dt

SALE, HORIZON, AMBER, TARGET = 1.50, 14, 21, 28
FREE = ("water", "snack")

def iso(s): return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
def days(a, b): return (iso(b) - iso(a)).total_seconds() / 86400

def compute(d, now=None):
    now = now or dt.datetime.now(dt.timezone.utc).isoformat()
    P = d["products"]
    counts = sorted(({"id": k, **v} for k, v in d["counts"].items()), key=lambda x: x["date"])
    purch  = sorted(({"id": k, **v} for k, v in d["purchases"].items()), key=lambda x: x["date"])
    rets   = [{"id": k, **v} for k, v in d.get("returns", {}).items()]

    def bought(fr, to):
        o = {}
        for x in purch:
            if (fr is None or x["date"] > fr) and (to is None or x["date"] <= to):
                for k, v in (x.get("items") or {}).items(): o[k] = o.get(k, 0) + v
        return o

    recs = []
    for a, b in zip(counts, counts[1:]):
        bt = bought(a["date"], b["date"])
        cons, meas = {}, {}
        sale_u = free_u = cost_s = cost_f = dep = 0
        for pid, p in P.items():
            A, B = (a.get("stock") or {}).get(pid), (b.get("stock") or {}).get(pid)
            dep += bt.get(pid, 0) * (p.get("dep") or 0)
            if A is None or B is None: continue
            v = A + bt.get(pid, 0) - B
            cons[pid] = v
            meas[pid] = bt.get(pid, 0) > 0 or v > 0
            if p["cat"] == "sale":
                sale_u += v
                if p.get("cost") is not None: cost_s += v * p["cost"]
            if p["cat"] in FREE:
                free_u += v
                if p.get("cost") is not None: cost_f += v * p["cost"]
        backed = sum(r.get("amount", 0) for r in rets
                     if r.get("toTill") and a["date"] < r["date"] <= b["date"])
        exp = sale_u * SALE
        got = (b.get("cash") or 0) + (b.get("card") or 0) - backed
        recs.append(dict(id=b["id"], frm=a, to=b, days=days(a["date"], b["date"]), cons=cons, meas=meas,
                         bought=bt, saleUnits=sale_u, freeUnits=free_u, backed=backed,
                         buys=len([x for x in purch if a["date"] < x["date"] <= b["date"]]),
                         expected=exp, got=got, short=got - exp, costSale=cost_s, costWater=cost_f,
                         depSpent=dep, net=got - cost_s - cost_f, ideal=exp - cost_s - cost_f,
                         payRate=(got / exp if exp > 0 else None),
                         breakEven=((cost_s + cost_f) / exp if exp > 0 else None)))

    last = counts[-1] if counts else None
    since = bought(last["date"], None) if last else bought(None, None)
    dSince = max(0.0, days(last["date"], now)) if last else 0.0

    items = {}
    for pid, p in P.items():
        base = (last.get("stock") or {}).get(pid) if last else None
        tot = dd = 0
        for r in recs:
            if pid not in r["cons"]: continue
            if r["meas"][pid] and r["days"] >= 1: tot += r["cons"][pid]; dd += r["days"]
        rate = max(0.0, tot / dd) if dd > 0 else None
        exact = (base or 0) + since.get(pid, 0)
        est = max(0.0, exact - rate * dSince) if rate else exact
        left = est / rate if rate else None
        restock = p["cat"] != "shared" and not p.get("phaseout")
        st = "none"
        if restock:
            st = "green"
            if round(est) <= 0: st = "red"
            elif left is not None:
                if left < HORIZON: st = "red"
                elif left < AMBER: st = "amber"
            elif p.get("min") is not None:
                if est <= p["min"]: st = "red"
                elif est <= p["min"] * 1.5: st = "amber"
        need = 0
        if restock:
            if rate: need = max(0.0, rate * TARGET - est)
            elif st != "green" and p.get("min"): need = p["min"] * 2 - est
            import math
            need = math.ceil(need / p["pack"]) * p["pack"] if need > 0 and p.get("pack") else math.ceil(need)
        items[pid] = dict(est=est, rate=rate, daysLeft=left, st=st, need=need, restock=restock,
                          bought=since.get(pid, 0), base=base)

    start = counts[0]["date"] if counts else None
    paid = 0.0
    for pid, p in P.items():
        dep = p.get("dep") or 0
        if not dep: continue
        for r in recs: paid += max(0, r["cons"].get(pid, 0)) * dep
        if items[pid]["rate"]: paid += items[pid]["rate"] * dSince * dep
    # короткие периоды не идут в средний расход — как в приложении
    back = sum(r.get("amount", 0) for r in rets if not start or r["date"] > start)
    tare = dict(units=sum(r.get("units", 0) for r in rets), amount=sum(r.get("amount", 0) for r in rets),
                waiting=paid - back, paid=paid, back=back,
                last=max((r["date"] for r in rets), default=None))
    return dict(recs=recs, items=items, tare=tare, dSince=dSince, last=last)

if __name__ == "__main__":
    d = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "hub-bar-data.json"))
    M = compute(d)
    r = M["recs"][-1]
    print(f"период {r['frm']['date'][:10]} → {r['to']['date'][:10]} · {r['days']:.2f} дн · закупок {r['buys']}")
    for k in ("saleUnits","freeUnits","expected","got","backed","short","costSale","costWater","net","ideal","depSpent"):
        print(f"  {k:12} {r[k]:>10.2f}")
    print(f"  {'payRate':12} {r['payRate']*100:>9.1f}%   breakEven {r['breakEven']*100:.1f}%")
    t = M["tare"]
    print(f"тара: сдано {t['units']} шт / {t['amount']:.2f} € · ждёт {t['waiting']:.2f} € · залог за выпитое {t['paid']:.2f} €")
    print(f"dSince {M['dSince']:.3f} дн")

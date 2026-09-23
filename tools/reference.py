#!/usr/bin/env python3
"""Эталонный пересчёт склада — вторая независимая реализация той же логики.

Нужен, чтобы сверять цифры приложения не на глаз, а против отдельного кода.
Если приложение и этот файл расходятся — кто-то из двоих врёт, и это находка.

  python3 tools/reference.py [файл-данных]
"""
import json, math, sys, datetime as dt

SALE, HORIZON, AMBER, TARGET = 1.50, 14, 21, 28
DEPOSIT = 0.15
GOAL_RATE, GOAL_PERIODS = 0.66, 2
FREE = ("water", "snack")

def iso(s): return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
def days(a, b): return (iso(b) - iso(a)).total_seconds() / 86400
def jsround(x): return math.floor(x + 0.5)   # JS округляет половину вверх, python round() — к чётному

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
        # подсчёт, сохранённый приложением, несёт свои деньги — период не пересчитываем
        fz = b.get("frozen") if isinstance(b.get("frozen"), dict) else None
        if fz:
            if fz.get("costSale")  is not None: cost_s = fz["costSale"]
            if fz.get("costWater") is not None: cost_f = fz["costWater"]
            if fz.get("depSpent")  is not None: dep    = fz["depSpent"]
        price = fz["price"] if fz and fz.get("price") is not None else SALE
        exp = sale_u * price
        got = (b.get("cash") or 0) + (b.get("card") or 0) - backed
        recs.append(dict(id=b["id"], frm=a, to=b, frozen=bool(fz), price=price, days=days(a["date"], b["date"]), cons=cons, meas=meas,
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
        periods = []
        for r in recs:
            if pid not in r["cons"]: continue
            m = r["meas"][pid]
            periods.append(dict(frm=r["frm"]["date"], to=r["to"]["date"], days=r["days"], cons=r["cons"][pid],
                                bought=r["bought"].get(pid, 0), measured=m,
                                perWeek=max(0.0, r["cons"][pid] / r["days"] * 7) if m and r["days"] >= 1 else None))
            # период короче суток — не измерение, в средний расход не идёт
            if m and r["days"] >= 1: tot += r["cons"][pid]; dd += r["days"]
        rate = max(0.0, tot / dd) if dd > 0 else None
        exact = (base or 0) + since.get(pid, 0)
        est = max(0.0, exact - rate * dSince) if rate else exact
        # срок — от факта: прогноз не должен красить приложение между подсчётами
        left = exact / rate if rate else None
        restock = p["cat"] != "shared" and not p.get("phaseout")
        mn = p.get("min")
        st = "none"
        if restock:
            st = "green"
            if jsround(exact) <= 0: st = "red"                    # минимум — жёсткий пол
            elif mn is not None and exact < mn: st = "red"      # ровно на минимуме — ещё не тревога
            elif left is not None and left < HORIZON: st = "red"
            elif mn is not None and exact <= mn * 1.5: st = "amber"
            elif left is not None and left < AMBER: st = "amber"
        need = 0
        # без повода не предлагаем: нехватка в треть штуки округлялась до упаковки
        if restock and st != "green":
            by_rate = rate * TARGET - exact if rate else 0
            by_min  = mn * 2 - exact if mn is not None else 0
            need = max(0.0, by_rate, by_min)
            need = math.ceil(need / p["pack"]) * p["pack"] if need > 0 and p.get("pack") else math.ceil(need)
        items[pid] = dict(est=est, exact=exact, estimated=bool(rate) and dSince >= 1, periods=periods, rate=rate, daysLeft=left, st=st, need=need, restock=restock,
                          bought=since.get(pid, 0), base=base)

    # Залог в пустой таре считаем ОТ ПОСЛЕДНЕЙ СДАЧИ и целыми штуками
    last_ret = max((r["date"] for r in rets), default=None)
    frm = last_ret if (last_ret and (not last or last_ret > last["date"])) else (last["date"] if last else None)
    d_grow = max(0.0, days(frm, now)) if frm else 0.0
    units_w = 0.0
    for pid, p in P.items():
        if not (p.get("dep") or 0): continue
        for r in recs:
            c = max(0, r["cons"].get(pid, 0))
            if not c: continue
            if not last_ret: units_w += c; continue
            if r["to"]["date"] <= last_ret: continue
            share = 1.0 if r["frm"]["date"] >= last_ret else max(0.0, min(1.0, days(last_ret, r["to"]["date"]) / (r["days"] or 1)))
            units_w += c * share
        if items[pid]["rate"]: units_w += items[pid]["rate"] * d_grow
    units_waiting = max(0, jsround(units_w))
    tare = dict(units=sum(r.get("units", 0) for r in rets), amount=sum(r.get("amount", 0) for r in rets),
                unitsWaiting=units_waiting, waiting=units_waiting * DEPOSIT,
                back=sum(r.get("amount", 0) for r in rets), last=last_ret)
    # «карма» — считается от последней амнистии, старый долг не тащим
    amnesty_at = max((c["date"] for c in counts if c.get("amnesty")), default=None)
    scored = [r for r in recs if r["frm"]["date"] >= amnesty_at] if amnesty_at else recs
    a_exp = sum(r["expected"] for r in scored); a_got = sum(r["got"] for r in scored)
    allm = dict(expected=a_exp, got=a_got, units=sum(r["saleUnits"] for r in scored),
                cost=sum(r["costSale"] + r["costWater"] for r in scored),
                short=a_got - a_exp, since=amnesty_at, periods=len(scored))
    allm["net"] = a_got - allm["cost"]
    allm["payRate"] = a_got / a_exp if a_exp > 0 else None
    streak = 0
    for r in reversed(scored):
        if r["payRate"] is not None and r["payRate"] >= GOAL_RATE: streak += 1
        else: break
    allm["streak"] = streak
    allm["goalReached"] = streak >= GOAL_PERIODS

    return dict(recs=recs, items=items, tare=tare, dSince=dSince, last=last, all=allm)

if __name__ == "__main__":
    d = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "hub-bar-data.json"))
    M = compute(d)
    r = M["recs"][-1]
    print(f"период {r['frm']['date'][:10]} → {r['to']['date'][:10]} · {r['days']:.2f} дн · закупок {r['buys']}")
    for k in ("saleUnits","freeUnits","expected","got","backed","short","costSale","costWater","net","ideal","depSpent"):
        print(f"  {k:12} {r[k]:>10.2f}")
    print(f"  {'payRate':12} {r['payRate']*100:>9.1f}%   breakEven {r['breakEven']*100:.1f}%")
    t = M["tare"]
    print(f"тара: сдано {t['units']} шт / {t['amount']:.2f} € · после последней сдачи накопилось {t['unitsWaiting']} шт / {t['waiting']:.2f} €")
    print(f"dSince {M['dSince']:.3f} дн")

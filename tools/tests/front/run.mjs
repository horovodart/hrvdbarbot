#!/usr/bin/env node
/* Автотесты логики фронтенда склада бара.
   app.js исполняется по-настоящему (node:vm + заглушки браузера), результаты
   model() сверяются с ожиданиями. Запуск: node tools/tests/front/run.mjs */
import { compute, loadHub } from "./harness.mjs";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");

let pass = 0, fail = 0;
const bugs = [];
const AMBER_DAYS = 21;
function ok(name, cond, detail){
  if(cond){ pass++; console.log("ОК      " + name) }
  else { fail++; console.log("ПРОВАЛ  " + name + (detail ? "\n        " + detail : "")) }
}
function eq(name, actual, expected, eps = 1e-9){
  const good = typeof expected === "number" && typeof actual === "number"
    ? Math.abs(actual - expected) <= eps
    : JSON.stringify(actual) === JSON.stringify(expected);
  ok(name, good, good ? "" : `ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`);
}
const D = s => s;   // читаемость дат

/* ══════════════ 1. Заморозка периода ══════════════ */
console.log("\n— 1. model(): заморозка периода —");
const frozenData = (cost) => ({
  products: [{id:"p1", cat:"sale",  cost, dep:0, pack:1},
             {id:"w1", cat:"water", cost: cost/2, dep:0, pack:1}],
  counts: [
    {id:"c1", date:D("2026-01-01T00:00:00.000Z"), stock:{p1:100, w1:50}},
    {id:"c2", date:D("2026-02-01T00:00:00.000Z"), stock:{p1:60,  w1:40}, cash:60},
    {id:"c3", date:D("2026-03-01T00:00:00.000Z"), stock:{p1:20,  w1:30}, cash:60,
     frozen:{costSale:999, costWater:111, depSpent:7, price:2}}
  ]
});
{
  const a = compute(frozenData(1)).M.recs;      // cost=1
  const b = compute(frozenData(5)).M.recs;      // cost=5, всё остальное то же
  eq("1.1 замороженный costSale берётся из frozen", a[1].costSale, 999);
  eq("1.2 замороженный costWater берётся из frozen", a[1].costWater, 111);
  eq("1.3 замороженный depSpent берётся из frozen", a[1].depSpent, 7);
  eq("1.4 флаг frozen выставлен у нужного периода", [a[0].frozen, a[1].frozen], [false, true]);
  eq("1.5 правка cost НЕ меняет замороженный период", [b[1].costSale, b[1].costWater], [999, 111]);
  eq("1.6 правка cost меняет незамороженный период", [a[0].costSale, b[0].costSale], [40, 200]);
  eq("1.7 expected считается по frozen.price, а не по текущей цене", a[1].expected, 80);
  eq("1.8 rec.price = frozen.price", a[1].price, 2);
  eq("1.9 у незамороженного периода price = SALE_PRICE", a[0].price, 1.5);
  eq("1.10 незамороженный expected по текущей цене", a[0].expected, 60);
}
{
  // частичная заморозка: задан только costSale
  const d = frozenData(1);
  d.counts[2].frozen = {costSale:500};
  const r = compute(d).M.recs[1];
  eq("1.11 частичная заморозка: costSale из frozen", r.costSale, 500);
  eq("1.12 частичная заморозка: costWater пересчитан", r.costWater, 5);
  eq("1.13 частичная заморозка: price падает на SALE_PRICE", r.price, 1.5);
  eq("1.14 частичная заморозка: expected по SALE_PRICE", r.expected, 60);
}
{
  const d = frozenData(1);
  d.counts[2].frozen = "не-объект";
  const r = compute(d).M.recs[1];
  eq("1.15 frozen не-объект игнорируется (без падения)", [r.frozen, r.costSale], [false, 40]);
}
{
  // нули в frozen — валидные значения, а не «поля нет»
  const d = frozenData(1);
  d.counts[2].frozen = {costSale:0, costWater:0, depSpent:0, price:0};
  const r = compute(d).M.recs[1];
  eq("1.16 frozen с нулями применяется (0 != отсутствие)",
     [r.costSale, r.costWater, r.depSpent, r.price], [0, 0, 0, 0]);
  eq("1.17 frozen.price=0 → expected=0, payRate=null", [r.expected, r.payRate], [0, null]);
}

/* ══════════════ 2. Короткие периоды не идут в средний расход ══════════════ */
console.log("\n— 2. model(): периоды короче суток —");
const shortBase = {
  products: [{id:"p1", cat:"sale", cost:1, pack:1, min:6}],
  counts: [
    {id:"c1", date:"2026-01-01T00:00:00.000Z", stock:{p1:100}},
    {id:"c2", date:"2026-01-31T00:00:00.000Z", stock:{p1:70}, cash:0}
  ],
  purchases: []
};
{
  const plain = compute(structuredClone(shortBase), {now:"2026-01-31T00:05:00.000Z"});
  eq("2.1 базовый средний расход 1 шт/день", plain.M.items.p1.rate, 1);

  const d = structuredClone(shortBase);
  d.counts.push({id:"c3", date:"2026-01-31T00:05:00.000Z", stock:{p1:70}, cash:0});
  d.purchases.push({id:"pu1", date:"2026-01-31T00:02:00.000Z", items:{p1:50}});
  const s = compute(d, {now:"2026-01-31T00:05:00.000Z"});
  const r = s.M.recs[1];
  eq("2.2 короткий период посчитан как период (5 минут)", Math.round(r.days*1440), 5);
  eq("2.3 расход короткого периода зафиксирован", r.cons.p1, 50);
  eq("2.4 короткий период НЕ взвинчивает rate", s.M.items.p1.rate, 1);
  ok("2.5 rate не улетел в сотни шт/день", s.M.items.p1.rate < 2,
     `rate = ${s.M.items.p1.rate}`);
  eq("2.6 buys короткого периода", r.buys, 1);

  const d2 = structuredClone(shortBase);
  d2.counts.push({id:"c3", date:"2026-02-02T00:00:00.000Z", stock:{p1:70}, cash:0});
  d2.purchases.push({id:"pu1", date:"2026-02-01T00:00:00.000Z", items:{p1:50}});
  const s2 = compute(d2, {now:"2026-02-02T00:00:00.000Z"});
  eq("2.7 период ровно 2 суток В расход идёт (80/32)", s2.M.items.p1.rate, 80/32);
}
{
  // ровно сутки — граница r.days >= 1, должна считаться
  const d = structuredClone(shortBase);
  d.counts.push({id:"c3", date:"2026-02-01T00:00:00.000Z", stock:{p1:60}, cash:0});
  const s = compute(d, {now:"2026-02-01T00:00:00.000Z"});
  eq("2.8 период ровно в сутки учитывается", s.M.items.p1.rate, 40/31);
}
{
  // тот же короткий период в истории товара (it.periods[].perWeek идёт в график)
  const d = structuredClone(shortBase);
  d.counts.push({id:"c3", date:"2026-01-31T00:05:00.000Z", stock:{p1:70}, cash:0});
  d.purchases.push({id:"pu1", date:"2026-01-31T00:02:00.000Z", items:{p1:50}});
  const per = compute(d, {now:"2026-01-31T00:05:00.000Z"}).M.items.p1.periods;
  eq("2.9 в истории два периода", per.length, 2);
  eq("2.10 нормальный период: perWeek = 7 шт/нед", per[0].perWeek, 7);
  ok("2.11 короткий период НЕ попадает в график истории (perWeek)",
     per[1].perWeek == null || per[1].perWeek < 100,
     `perWeek короткого периода = ${per[1].perWeek} (в 5-минутном периоде расход 50 шт)`);
}

/* ══════════════ 3. backed — возврат залога в кассу ══════════════ */
console.log("\n— 3. model(): backed —");
const backedData = () => ({
  products: [{id:"p1", cat:"sale", cost:1}],
  counts: [
    {id:"c1", date:"2026-01-01T00:00:00.000Z", stock:{p1:100}},
    {id:"c2", date:"2026-02-01T00:00:00.000Z", stock:{p1:60}, cash:100, card:20}
  ],
  returns: [
    {id:"r1", date:"2026-01-15T00:00:00.000Z", toTill:true,  amount:5,  units:10},
    {id:"r2", date:"2026-01-16T00:00:00.000Z", toTill:false, amount:7,  units:10},
    {id:"r3", date:"2026-02-15T00:00:00.000Z", toTill:true,  amount:11, units:10},
    {id:"r4", date:"2025-12-15T00:00:00.000Z", toTill:true,  amount:13, units:10},
    {id:"r5", date:"2026-01-01T00:00:00.000Z", toTill:true,  amount:17, units:10},
    {id:"r6", date:"2026-02-01T00:00:00.000Z", toTill:true,  amount:19, units:10}
  ]
});
{
  const r = compute(backedData(), {now:"2026-02-01T00:00:00.000Z"}).M.recs[0];
  eq("3.1 backed = 5 (внутри, toTill) + 19 (на границе b)", r.backed, 24);
  eq("3.2 got = cash+card−backed", r.got, 96);

  const noTill = backedData(); noTill.returns = noTill.returns.filter(x => x.id !== "r2");
  eq("3.3 toTill:false вообще не влияет на backed",
     compute(noTill, {now:"2026-02-01T00:00:00.000Z"}).M.recs[0].backed, 24);

  const only = backedData();
  only.returns = [{id:"x", date:"2026-01-10T00:00:00.000Z", toTill:false, amount:50, units:1}];
  eq("3.4 возврат с toTill:false не вычитается из got",
     compute(only, {now:"2026-02-01T00:00:00.000Z"}).M.recs[0].got, 120);

  const out = backedData();
  out.returns = [{id:"x", date:"2026-03-10T00:00:00.000Z", toTill:true, amount:50, units:1}];
  eq("3.5 возврат вне периода не вычитается из got",
     compute(out, {now:"2026-03-11T00:00:00.000Z"}).M.recs[0].got, 120);

  const atA = backedData();
  atA.returns = [{id:"x", date:"2026-01-01T00:00:00.000Z", toTill:true, amount:50, units:1}];
  eq("3.6 возврат ровно в дату начала периода не считается",
     compute(atA, {now:"2026-02-01T00:00:00.000Z"}).M.recs[0].backed, 0);
}

/* ══════════════ 4. buys — число закупок в периоде ══════════════ */
console.log("\n— 4. model(): buys —");
{
  const d = {
    products: [{id:"p1", cat:"sale", cost:1}],
    counts: [
      {id:"c1", date:"2026-01-01T00:00:00.000Z", stock:{p1:100}},
      {id:"c2", date:"2026-02-01T00:00:00.000Z", stock:{p1:60}, cash:0}
    ],
    purchases: [
      {id:"b0", date:"2025-12-20T00:00:00.000Z", items:{}},
      {id:"b1", date:"2026-01-01T00:00:00.000Z", items:{}},
      {id:"b2", date:"2026-01-10T00:00:00.000Z", items:{}},
      {id:"b3", date:"2026-01-20T00:00:00.000Z", items:{}},
      {id:"b4", date:"2026-02-01T00:00:00.000Z", items:{}},
      {id:"b5", date:"2026-02-10T00:00:00.000Z", items:{}}
    ]
  };
  eq("4.1 buys = 3 (внутри + граница b, без границы a и внешних)",
     compute(d, {now:"2026-02-11T00:00:00.000Z"}).M.recs[0].buys, 3);
  const none = structuredClone(d); none.purchases = [];
  eq("4.2 buys = 0 без закупок", compute(none, {now:"2026-02-11T00:00:00.000Z"}).M.recs[0].buys, 0);
}

/* ══════════════ 5. Накопительный счёт M.all ══════════════ */
console.log("\n— 5. M.all: амнистия, суммы, streak —");
const allData = (cash, amnestyOn) => {
  const c = [
    {id:"c0", date:"2026-01-01T00:00:00.000Z", stock:{p1:1000}},
    {id:"c1", date:"2026-02-01T00:00:00.000Z", stock:{p1:900}, cash:cash[0]},
    {id:"c2", date:"2026-03-01T00:00:00.000Z", stock:{p1:800}, cash:cash[1]},
    {id:"c3", date:"2026-04-01T00:00:00.000Z", stock:{p1:700}, cash:cash[2]}
  ];
  if(amnestyOn) c.find(x => x.id === amnestyOn).amnesty = true;
  return {products:[{id:"p1", cat:"sale", cost:0.5}], counts:c};
};
const allOf = (cash, am) => compute(allData(cash, am), {now:"2026-04-01T00:00:00.000Z"}).M.all;
{
  const a = allOf([50, 120, 120]);
  eq("5.1 без амнистии складываются все периоды: expected", a.expected, 450);
  eq("5.2 без амнистии: got", a.got, 290);
  eq("5.3 без амнистии: cost", a.cost, 150);
  eq("5.4 без амнистии: units", a.units, 300);
  eq("5.5 без амнистии: periods", a.periods, 3);
  eq("5.6 без амнистии: since = null", a.since, null);
  eq("5.7 short = got − expected", a.short, -160);
  eq("5.8 net = got − cost", a.net, 140);
  eq("5.9 payRate = got/expected", a.payRate, 290/450);
}
{
  const a = allOf([50, 120, 120], "c2");
  eq("5.10 амнистия на c2: только периоды, начинающиеся с c2", a.periods, 1);
  eq("5.11 амнистия: expected только последнего периода", a.expected, 150);
  eq("5.12 амнистия: got только последнего периода", a.got, 120);
  eq("5.13 амнистия: since = дата амнистии", a.since, "2026-03-01T00:00:00.000Z");
  const b = allOf([50, 120, 120], "c0");
  eq("5.14 амнистия на первом подсчёте не режет ничего", [b.periods, b.expected], [3, 450]);
}
{
  eq("5.15 streak 0: все периоды ниже планки", allOf([50,50,50]).streak, 0);
  eq("5.16 streak 1: хорош только последний", allOf([50,50,120]).streak, 1);
  eq("5.17 streak 2: хороши два последних", allOf([50,120,120]).streak, 2);
  eq("5.18 streak 0: хороший в середине, последний плохой", allOf([50,120,50]).streak, 0);
  eq("5.19 streak 3: хороши все", allOf([120,120,120]).streak, 3);
  eq("5.20 goalReached при streak 1 = false", allOf([50,50,120]).goalReached, false);
  eq("5.21 goalReached при streak 2 = true", allOf([50,120,120]).goalReached, true);
  eq("5.22 goalReached при streak 0 = false", allOf([50,120,50]).goalReached, false);
  // ровно планка 0.66: expected 150 → got 99
  eq("5.23 payRate ровно 0.66 засчитывается в streak", allOf([50,99,99]).streak, 2);
  eq("5.24 payRate чуть ниже планки не засчитывается", allOf([50,120,98.9]).streak, 0);
}
{
  // период без продаж (expected 0 → payRate null) обрывает streak
  const d = allData([120,120,120]);
  d.counts.push({id:"c4", date:"2026-05-01T00:00:00.000Z", stock:{p1:700}, cash:0});
  const a = compute(d, {now:"2026-05-01T00:00:00.000Z"}).M.all;
  eq("5.25 период без продаж (payRate null) обрывает streak", a.streak, 0);
  eq("5.26 при этом periods считает и его", a.periods, 4);
}
{
  const a = allOf([50,120,120], "c3");
  eq("5.27 амнистия на последнем подсчёте обнуляет счёт", [a.periods, a.expected, a.got, a.streak], [0,0,0,0]);
  eq("5.28 payRate при нулевом expected = null", a.payRate, null);
}

/* ══════════════ 6. Тара M.tare ══════════════ */
console.log("\n— 6. M.tare —");
const tareData = () => ({
  products: [
    {id:"pd",   cat:"sale", cost:1, dep:0.15},
    {id:"pn",   cat:"sale", cost:1},
    {id:"pz",   cat:"sale", cost:1, dep:0},
    {id:"pneg", cat:"sale", cost:1, dep:0.15}
  ],
  counts: [
    {id:"c1", date:"2026-01-01T00:00:00.000Z", stock:{pd:100, pn:100, pz:100, pneg:10}},
    {id:"c2", date:"2026-02-01T00:00:00.000Z", stock:{pd:90,  pn:50,  pz:50,  pneg:30}, cash:0}
  ],
  returns: [
    {id:"rb", date:"2025-12-01T00:00:00.000Z", amount:3,  units:20,  toTill:false},
    {id:"r1", date:"2026-01-15T00:00:00.000Z", amount:20, units:100, toTill:false},
    {id:"r2", date:"2026-02-15T00:00:00.000Z", amount:5,  units:30,  toTill:true}
  ]
});
{
  const t = compute(tareData(), {now:"2026-02-01T00:00:00.000Z"}).M.tare;
  eq("6.1 units — сумма ВСЕХ возвратов", t.units, 150);
  eq("6.2 amount — сумма ВСЕХ возвратов", t.amount, 28);
  eq("6.3 back — сумма всех сдач", t.back, 28);
  // Правило Миши: тара считается ОТ ПОСЛЕДНЕЙ СДАЧИ. Последняя сдача 15.02 —
  // позже обоих подсчётов, значит накопиться ещё ничего не успело.
  eq("6.4 после последней сдачи накопилось ноль штук", t.unitsWaiting, 0);
  eq("6.5 сумма = штуки × залог", t.waiting, 0);
  ok("6.6 сумма кратна залогу", Math.abs(t.waiting / 0.15 - Math.round(t.waiting / 0.15)) < 1e-9,
     `waiting = ${t.waiting}`);
  eq("6.7 tare.last — самая поздняя дата возврата", t.last, "2026-02-15T00:00:00.000Z");
}
{
  const d = tareData(); d.returns = [];
  const t = compute(d, {now:"2026-02-01T00:00:00.000Z"}).M.tare;
  eq("6.8 без сдач: units/amount/back = 0", [t.units, t.amount, t.back], [0,0,0]);
  // сдач не было — копится всё выпитое: pd 10 шт + pneg 0 (расход отрицательный)
  eq("6.9 без сдач: копятся все выпитые залоговые штуки", t.unitsWaiting, 10);
  eq("6.9a без сдач: сумма = 10 × 0,15", t.waiting, 1.5);
  eq("6.10 без сдач: last = null", t.last, null);
}
{
  // после сдачи копится по среднему расходу — но целыми штуками
  const d = tareData();
  d.returns = [{id:"r1", date:"2026-02-01T00:00:00.000Z", amount:5, units:30, toTill:true}];
  const t = compute(d, {now:"2026-02-11T00:00:00.000Z"}).M.tare;
  eq("6.11 после сдачи копится по среднему расходу", t.unitsWaiting, Math.round((10/31)*10));
  ok("6.11a и это по-прежнему кратно залогу",
     Math.abs(t.waiting - t.unitsWaiting*0.15) < 1e-9, `waiting=${t.waiting}`);
}
{
  // сдал — обнулилось: сдача ровно «сейчас» не оставляет хвоста
  const d = tareData();
  d.returns = [{id:"r1", date:"2026-02-01T00:00:00.000Z", amount:5, units:30, toTill:true}];
  const t = compute(d, {now:"2026-02-01T00:00:00.000Z"}).M.tare;
  eq("6.12 сдал сегодня — ждёт ноль", t.unitsWaiting, 0);
  eq("6.12a и ноль евро, а не хвост", t.waiting, 0);
}
{
  // отрицательный расход (пересчёт вверх) не уходит в минус
  const d = tareData();
  d.products = d.products.filter(p => p.id === "pneg");
  d.returns = [];
  const t = compute(d, {now:"2026-02-01T00:00:00.000Z"}).M.tare;
  eq("6.13 отрицательный расход не уходит в минус", t.unitsWaiting, 0);
}

/* ══════════════ 7. Статусы и заказ ══════════════ */
console.log("\n— 7. items: restock / st / need —");
{
  const P = (id, cat, a, b, extra = {}) => ({id, cat, cost:1, pack:6, ...extra, _a:a, _b:b});
  const defs = [
    P("pRed",     "sale",  20, 10),
    P("pAmber",   "sale",  27, 17),
    P("pGreen",   "sale",  35, 25),
    P("pZero",    "sale",  10,  0),
    P("pNoPack",  "sale",  20, 10, {pack:undefined}),
    P("pShared",  "shared",20, 10),
    P("pPhase",   "sale",  20, 10, {phaseout:true}),
    P("pD14",     "sale",  24, 14),
    P("pD21",     "sale",  31, 21),
    P("pMin10",   "sale",  10, 10, {min:10, pack:undefined}),
    P("pMin8",    "sale",  10, 10, {min:8,  pack:undefined}),
    P("pMin5",    "sale",  10, 10, {min:5,  pack:undefined}),
    P("pMin12",   "sale",  10, 10, {min:12, pack:undefined})   // строго ниже минимума
  ];
  const stock = (k) => Object.fromEntries(defs.map(d => [d.id, d[k]]));
  const d = {
    products: defs.map(({_a,_b,...p}) => p),
    counts: [
      {id:"c1", date:"2026-01-01T00:00:00.000Z", stock:stock("_a")},
      {id:"c2", date:"2026-01-11T00:00:00.000Z", stock:stock("_b"), cash:0}
    ]
  };
  const it = compute(d, {now:"2026-01-11T00:00:00.000Z"}).M.items;

  eq("7.1 shared: restock=false", it.pShared.restock, false);
  eq("7.2 shared: st='none'", it.pShared.st, "none");
  eq("7.3 shared: need=0", it.pShared.need, 0);
  eq("7.4 phaseout: restock=false", it.pPhase.restock, false);
  eq("7.5 phaseout: st='none'", it.pPhase.st, "none");
  eq("7.6 phaseout: need=0", it.pPhase.need, 0);

  eq("7.7 est=0 → red", [it.pZero.est, it.pZero.st], [0, "red"]);
  eq("7.8 daysLeft 10 (<14) → red", [it.pRed.daysLeft, it.pRed.st], [10, "red"]);
  eq("7.9 daysLeft 17 (<21) → amber", [it.pAmber.daysLeft, it.pAmber.st], [17, "amber"]);
  eq("7.10 daysLeft 25 → green", [it.pGreen.daysLeft, it.pGreen.st], [25, "green"]);
  eq("7.11 daysLeft ровно 14 → amber (граница не строгая)", it.pD14.st, "amber");
  eq("7.12 daysLeft ровно 21 → green (граница не строгая)", it.pD21.st, "green");

  // «держаться на 12 штуках» — значит 12 нормально, 11 уже нет. Размытого пояса
  // «до полутора минимумов» больше нет: он держал в закупке то, чего хватает.
  eq("7.13 ровно на минимуме — спокойно", [it.pMin10.rate, it.pMin10.st], [null, "green"]);
  eq("7.13a строго ниже минимума — красный", it.pMin12.st, "red");
  eq("7.14 выше минимума — спокойно", it.pMin8.st, "green");
  eq("7.15 сильно выше минимума — спокойно", it.pMin5.st, "green");

  eq("7.16 need округляется вверх до pack (11 → 12 при pack 6)", it.pAmber.need, 12);
  eq("7.17 need кратен pack (18 при pack 6)", it.pRed.need, 18);
  // Правило Миши: не предлагать то, чего хватает. Раньше нехватка в треть штуки
  // округлялась вверх до целой упаковки, и в закупке висело то, чего хватает на месяц.
  eq("7.18 зелёному закупка не предлагается", it.pGreen.need, 0);
  eq("7.19 need для est=0: 28 → 30 при pack 6", it.pZero.need, 30);
  eq("7.20 без pack need округляется вверх до целого", it.pNoPack.need, 18);
  eq("7.21 на минимуме закупка не нужна", it.pMin10.need, 0);
  eq("7.21a ниже минимума — добираем до двух минимумов", it.pMin12.need, 14);   // 24 − 10
  eq("7.22 выше минимума закупка не нужна", it.pMin8.need, 0);
  eq("7.23 rate=null + green: need = 0", it.pMin5.need, 0);
  eq("7.24 rate считается верно (1 шт/день)", it.pRed.rate, 1);
  eq("7.25 estimated=false при dSince=0", it.pRed.estimated, false);
}
{
  // один подсчёт: данных о расходе нет, работает ветка min
  const d = {
    products: [{id:"p1", cat:"sale", cost:1, min:6, pack:6}],
    counts: [{id:"c1", date:"2026-01-01T00:00:00.000Z", stock:{p1:4}}]
  };
  const it = compute(d, {now:"2026-01-02T00:00:00.000Z"}).M.items.p1;
  eq("7.26 единственный подсчёт: rate=null, daysLeft=null", [it.rate, it.daysLeft], [null, null]);
  eq("7.27 единственный подсчёт: est=exact (без списания)", [it.est, it.exact], [4, 4]);
  eq("7.28 единственный подсчёт: est<=min → red", it.st, "red");
  eq("7.29 единственный подсчёт: need = min*2−est → кратно pack", it.need, 12);
}
{
  // товар, которого нет в подсчёте вовсе
  const d = {
    products: [{id:"p1", cat:"sale", cost:1, min:6, pack:6}, {id:"ghost", cat:"sale", cost:1, pack:6}],
    counts: [{id:"c1", date:"2026-01-01T00:00:00.000Z", stock:{p1:4}}]
  };
  const it = compute(d, {now:"2026-01-02T00:00:00.000Z"}).M.items.ghost;
  eq("7.30 товар без остатка: base=undefined, est=0", [it.base, it.est], [undefined, 0]);
  eq("7.31 товар без остатка: st=red", it.st, "red");
}
{
  // статусы одинаково работают для sale / water / snack
  const mk = cat => ({
    products: [{id:"p1", cat, cost:1, pack:6}],
    counts: [{id:"c1", date:"2026-01-01T00:00:00.000Z", stock:{p1:20}},
             {id:"c2", date:"2026-01-11T00:00:00.000Z", stock:{p1:10}, cash:0}]
  });
  for(const [i, cat] of ["sale","water","snack"].entries()){
    const it = compute(mk(cat), {now:"2026-01-11T00:00:00.000Z"}).M.items.p1;
    eq(`7.${32+i} cat="${cat}": restock=true, st=red, need=18`,
       [it.restock, it.st, it.need], [true, "red", 18]);
  }
  const sh = compute(mk("shared"), {now:"2026-01-11T00:00:00.000Z"}).M.items.p1;
  eq("7.35 cat=\"shared\" при том же раскладе: none/0/false", [sh.restock, sh.st, sh.need], [false, "none", 0]);
}

/* ══════════════ 8. eur() и dec() ══════════════ */
console.log("\n— 8. eur() / dec() —");
{
  const { fn } = loadHub();
  eq("8.1 eur(-0.001) без минус-нуля", fn.eur(-0.001), "0,00 €");
  eq("8.2 eur(0)", fn.eur(0), "0,00 €");
  eq("8.3 eur(-0.004) без минус-нуля", fn.eur(-0.004), "0,00 €");
  eq("8.4 eur(-0.0049) без минус-нуля", fn.eur(-0.0049), "0,00 €");
  ok("8.5 eur(-0.005) не даёт «−0,00 €»", !/^−0,00/.test(fn.eur(-0.005)), `получено ${fn.eur(-0.005)}`);
  eq("8.6 eur(-1.5) с типографским минусом", fn.eur(-1.5), "−1,50 €");
  eq("8.7 eur(1.5)", fn.eur(1.5), "1,50 €");
  eq("8.8 eur(null)", fn.eur(null), "0,00 €");
  eq("8.9 eur(undefined)", fn.eur(undefined), "0,00 €");
  eq("8.10 eur(NaN)", fn.eur(NaN), "0,00 €");
  eq("8.11 eur('12,5') строкой с запятой", fn.eur("12,5"), "0,00 €");
  eq("8.12 eur(-1234.567)", fn.eur(-1234.567), "−1234,57 €");

  eq("8.13 dec(null) = «—»", fn.dec(null), "—");
  eq("8.14 dec(undefined) = «—»", fn.dec(undefined), "—");
  eq("8.15 dec(Infinity) = «—»", fn.dec(Infinity), "—");
  eq("8.16 dec(-Infinity) = «—»", fn.dec(-Infinity), "—");
  eq("8.17 dec(NaN) = «—»", fn.dec(NaN), "—");
  eq("8.18 dec(2.5)", fn.dec(2.5), "2,5");
  eq("8.19 dec(0)", fn.dec(0), "0,0");
  eq("8.20 dec(-1.25) — минус типографский, как в eur()", fn.dec(-1.25), "\u22121,3");
  ok("8.21 dec(-0.04) не даёт минус-ноль", !/^[-\u2212]0,0$/.test(fn.dec(-0.04)), `получено ${fn.dec(-0.04)}`);
}

/* ══════════════ 9. Сверка с эталоном tools/reference.py на боевых данных ══════════════ */
console.log("\n— 9. сверка с tools/reference.py (hub-bar-data.json) —");
{
  const NOW = "2026-09-21T12:00:00.000Z";
  const raw = JSON.parse(readFileSync(path.join(ROOT, "hub-bar-data.json"), "utf8"));
  const ent = o => Object.entries(o || {}).map(([id, v]) => ({id, ...v}));
  const js = compute({products:ent(raw.products), counts:ent(raw.counts),
                      purchases:ent(raw.purchases), returns:ent(raw.returns)}, {now:NOW}).M;
  let py = null;
  try{
    py = JSON.parse(execFileSync("python3", [path.join(HERE, "ref_dump.py"), NOW], {cwd:ROOT}).toString());
  }catch(e){ ok("9.0 эталон tools/reference.py запустился", false, String(e.message).slice(0,200)) }
  if(py){
    ok("9.0 эталон tools/reference.py запустился", true);
    eq("9.1 число периодов совпадает", js.recs.length, py.recs.length);
    const F = ["days","saleUnits","freeUnits","expected","got","backed","buys","short",
               "costSale","costWater","depSpent","net","ideal","payRate","breakEven"];
    let bad = [];
    js.recs.forEach((r, i) => {
      const q = py.recs[i]; if(!q) return;
      for(const f of F){
        const a = r[f], b = q[f];
        if(a == null && b == null) continue;
        if(!(typeof a === "number" && typeof b === "number" && Math.abs(a-b) < 1e-6)) bad.push(`recs[${i}].${f}: js=${a} py=${b}`);
      }
    });
    ok("9.2 все поля периодов сходятся с эталоном", bad.length === 0, bad.join("\n        "));

    let ib = [];
    for(const id of Object.keys(py.items)){
      const a = js.items[id], b = py.items[id];
      if(!a){ ib.push(`items.${id} отсутствует в js`); continue }
      for(const f of ["est","rate","daysLeft","need","bought"]){
        const x = a[f], y = b[f];
        if(x == null && y == null) continue;
        if(!(typeof x === "number" && typeof y === "number" && Math.abs(x-y) < 1e-6)) ib.push(`items.${id}.${f}: js=${x} py=${y}`);
      }
      if(a.st !== b.st) ib.push(`items.${id}.st: js=${a.st} py=${b.st}`);
      if(a.restock !== b.restock) ib.push(`items.${id}.restock: js=${a.restock} py=${b.restock}`);
    }
    ok("9.3 все позиции (est/rate/daysLeft/st/need/restock) сходятся с эталоном",
       ib.length === 0, ib.slice(0,12).join("\n        "));

    let tb = [];
    for(const f of ["units","amount","back","paid","waiting"]){
      if(Math.abs(js.tare[f] - py.tare[f]) > 1e-6) tb.push(`tare.${f}: js=${js.tare[f]} py=${py.tare[f]}`);
    }
    ok("9.4 тара сходится с эталоном", tb.length === 0, tb.join("\n        "));
    eq("9.5 dSince сходится с эталоном", js.dSince, py.dSince, 1e-6);
  }
}

/* ------------------------------------------------------------------ */
console.log("\n— 12. история цен: где и почём брали —");
{
  // Цена зависит от магазина: в Metro одно, в Lidl другое. Правило «считаем по
  // последней» это выдерживает, но скачок должен объясняться — откуда цифра.
  const data = {
    products: [{id:"h", cat:"sale", cost:0.65, pack:24}],
    counts: [{id:"c1", date:"2026-01-01T00:00:00.000Z", stock:{h:10}}],
    purchases: [
      {id:"b1", date:"2026-01-05T00:00:00.000Z", source:"Metro",     items:{h:24}, prices:{list:{h:0.47}}},
      {id:"b3", date:"2026-03-01T00:00:00.000Z", source:"Metro",     items:{h:24}, prices:{list:{h:0.65}}},
      {id:"b2", date:"2026-02-01T00:00:00.000Z", source:"Kaufland",  items:{h:24}, prices:{list:{h:0.59}}},
      {id:"b4", date:"2026-04-01T00:00:00.000Z", items:{h:24}},                    // без цен
      {id:"b5", date:"2026-05-01T00:00:00.000Z", items:{h:24}, prices:{list:{h:0}}} // мусорная цена
    ]
  };
  const it = compute(data, {now:"2026-06-01T00:00:00.000Z"}).M.items.h;
  eq("12.1 в историю попали только закупки с ценой", it.prices.length, 3);
  eq("12.2 история отсортирована по дате", it.prices.map(x => x.price), [0.47, 0.59, 0.65]);
  eq("12.3 магазин сохранён", it.prices.map(x => x.source), ["Metro", "Kaufland", "Metro"]);
  eq("12.4 последняя цена — самая свежая, а не самая большая", it.prices[it.prices.length-1].price, 0.65);
  ok("12.5 нулевая цена не попала в историю", !it.prices.some(x => !x.price));
}
{
  const data = {
    products: [{id:"h", cat:"sale", cost:1, pack:6}],
    counts: [{id:"c1", date:"2026-01-01T00:00:00.000Z", stock:{h:10}}],
    purchases: [{id:"b1", date:"2026-01-05T00:00:00.000Z", items:{h:6}}]
  };
  const it = compute(data, {now:"2026-02-01T00:00:00.000Z"}).M.items.h;
  eq("12.6 без цен в закупках история пустая, но не падает", it.prices.length, 0);
}

console.log("\n— 11. минимум — жёсткий пол —");
{
  // Правило Миши про воду: держаться на 12 штуках минимум, 24 в идеале.
  // Раньше минимум работал только когда расход не измерен: вода расходилась
  // медленно, «хватит на 57 дней» → зелёный → закупку не предлагали вовсе.
  // пьют мало (и запаса «надолго»), но штук на полке мало
  const water = (min, base) => ({
    products: [{id:"w", cat:"water", cost:1, pack:6, min}],
    counts: [
      {id:"c1", date:"2025-01-01T00:00:00.000Z", stock:{w:20}},
      {id:"c2", date:"2026-02-01T00:00:00.000Z", stock:{w:base}, cash:0}
    ],
    purchases: []
  });
  const low = compute(water(12, 6),  {now:"2026-02-01T00:00:00.000Z"}).M.items.w;
  eq("11.1 расход измерен и запаса надолго…", low.daysLeft > AMBER_DAYS, true);
  eq("11.2 …но ниже минимума — всё равно красный", low.st, "red");
  ok("11.3 и закупка предлагается", low.need > 0, `need = ${low.need}`);
  eq("11.4 добираем до двух минимумов, кратно упаковке", low.need, 18);   // 24 − 6 = 18

  const mid = compute(water(12, 12), {now:"2026-02-01T00:00:00.000Z"}).M.items.w;
  eq("11.5 ровно на минимуме — спокойно, закупку не навязываем", [mid.st, mid.need], ["green", 0]);

  const hi = compute(water(4, 19), {now:"2026-02-01T00:00:00.000Z"}).M.items.w;
  eq("11.6 выше min×1.5 — зелёный", hi.st, "green");
  eq("11.7 зелёному ничего не предлагаем", hi.need, 0);
}

console.log("\n— 10. показываемый остаток не убывает сам —");
{
  // Правило Миши: приложение не занижает остаток между подсчётами. Число на
  // карточке — факт (прошлый подсчёт плюс закупки), прогноз живёт отдельно.
  const data = {
    products: [{id:"p1", cat:"sale", cost:1, pack:1, min:6}],
    counts: [
      {id:"c1", date:"2026-01-01T00:00:00.000Z", stock:{p1:100}},
      {id:"c2", date:"2026-02-01T00:00:00.000Z", stock:{p1:40}, cash:0}
    ],
    purchases: [{id:"b1", date:"2026-02-05T00:00:00.000Z", items:{p1:12}}]
  };
  const day1  = compute(data, {now:"2026-02-06T00:00:00.000Z"}).M.items.p1;
  const day20 = compute(data, {now:"2026-02-25T00:00:00.000Z"}).M.items.p1;

  eq("10.1 факт = прошлый подсчёт + закупки", day1.exact, 52);
  eq("10.2 через 19 дней факт тот же", day20.exact, day1.exact);
  ok("10.3 прогноз при этом убывает — он и должен",
     day20.est < day1.est, `est: ${day1.est} → ${day20.est}`);
  ok("10.4 прогноз не выдаётся за факт: est ≠ exact, когда время прошло",
     day20.est !== day20.exact, "иначе прогноз молча подменит остаток");
  ok("10.5 прогноз помечен флагом estimated", day20.estimated === true);

  // и то, чем заполняется подсчёт, — тоже факт
  const src = readFileSync(new URL("../../../app.js", import.meta.url), "utf8");
  ok("10.6 поля подсчёта заполняются exact, а не est",
     /S\.count\[p\.id\] = Math\.round\(M\.items\[p\.id\]\.exact\)/.test(src),
     "догадка не должна превращаться в записанный подсчёт");
  ok("10.7 крупное число на карточке берётся из exact",
     /function stockLine\(it\)\{[\s\S]{0,400}?Math\.round\(it\.exact\)/.test(src),
     "в stockLine остался est");
  ok("10.8 «Закончилось» ставится по факту",
     /Math\.round\(it\.exact\)<=0\?"Закончилось"/.test(src),
     "флаг не должен опираться на прогноз");
}

console.log(`\nпрошло ${pass} из ${pass + fail}`);
process.exit(fail ? 1 : 0);

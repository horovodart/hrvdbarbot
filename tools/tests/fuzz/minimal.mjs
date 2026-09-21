/* Регрессии: минимальные воспроизведения расхождений, которые уже починены.
   Приложение и эталон обязаны сойтись — иначе выход с кодом 1.
   node tools/tests/fuzz/minimal.mjs                                            */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { boot, freezeTime, unfreezeTime, norm } from "./harness.mjs";

const HERE = path.resolve(new URL(".", import.meta.url).pathname);
const D = "2026-03-01T10:00:00.000Z";

const CASES = [
  { name: "A · округление 0,5 — JS округляет вверх, python round() к чётному",
    now: D,
    data: {
      products: { p: {name:"Товар", cat:"sale", cost:1, dep:0, pack:null, min:null, phaseout:false} },
      counts:   { c0: {date:D, cash:0, card:0, stock:{p:0.5}} },
      purchases:{}, returns:{}
    },
    look: M => ({ est:M.items.p.est, rate:M.items.p.rate, st:M.items.p.st }) },

  { name: "B · заморозка: деньги периода берутся из подсчёта, а не пересчитываются",
    now: "2026-03-11T10:00:00.000Z",
    data: {
      products: { p: {name:"Товар", cat:"sale", cost:1, dep:0, pack:null, min:null, phaseout:false} },
      counts:   { c0: {date:D, cash:0, card:0, stock:{p:10}},
                  c1: {date:"2026-03-11T10:00:00.000Z", cash:6, card:0, stock:{p:6},
                       frozen:{costSale:99, costWater:0, depSpent:0, price:1.0}} },
      purchases:{}, returns:{}
    },
    look: M => ({ expected:M.recs[0].expected, costSale:M.recs[0].costSale,
                  net:M.recs[0].net, payRate:M.recs[0].payRate }) },
];

const inp = path.join(HERE,".min.in.jsonl"), outp = path.join(HERE,".min.out.jsonl");
fs.writeFileSync(inp, CASES.map(c => JSON.stringify({data:c.data, now:c.now})).join("\n")+"\n");
execFileSync("python3",[path.join(HERE,"ref_batch.py"),inp,outp]);
const refs = fs.readFileSync(outp,"utf8").trim().split("\n").map(l=>JSON.parse(l));
const hub = boot();

let bad = 0;
CASES.forEach((c,i) => {
  freezeTime(c.now);
  Object.assign(hub.S, norm(c.data));
  const M = hub.model();
  unfreezeTime();
  const R = refs[i].M;
  const a = JSON.stringify(c.look(M)), b = JSON.stringify(c.look(R));
  if(a === b){ console.log("ОК      " + c.name); return }
  bad++;
  console.log("ПРОВАЛ  " + c.name);
  console.log("  вход:      ", JSON.stringify(c.data));
  console.log("  приложение:", a);
  console.log("  эталон:    ", b);
});
fs.unlinkSync(inp); fs.unlinkSync(outp);
console.log(`\nрегрессии: прошло ${CASES.length-bad} из ${CASES.length}`);
if(bad) process.exit(1);

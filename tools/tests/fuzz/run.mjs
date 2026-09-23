/* Фаззинг: сотни случайных складов, расчёт приложения (app.js в Node) против tools/reference.py.
   Запуск:  node tools/tests/fuzz/run.mjs [N] [seed0]
   Расхождения ложатся в tools/tests/fuzz/cases/NNN.json                              */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { boot, freezeTime, unfreezeTime, norm } from "./harness.mjs";
import { gen } from "./gen.mjs";

const HERE = path.resolve(new URL(".", import.meta.url).pathname);
const CASES = path.join(HERE, "cases");
const N     = parseInt(process.argv[2] || "300");
const SEED0 = parseInt(process.argv[3] || "1");
const TOL   = 1e-6;

const REC  = ["saleUnits","freeUnits","expected","got","backed","short","frozen","price",
              "costSale","costWater","depSpent","net","ideal","payRate","breakEven"];
const ITEM = ["est","exact","estimated","rate","daysLeft","st","need","restock"];
const TARE = ["units","amount","back","unitsWaiting","waiting"];
const ALL  = ["expected","got","cost","units","short","net","payRate","since","periods","streak","goalReached"];
const PER  = ["days","cons","bought","measured","perWeek"];

const near = (a,b) => {
  if(a === null || a === undefined) a = null;
  if(b === null || b === undefined) b = null;
  if(a === null || b === null) return a === b;
  if(typeof a === "string" || typeof b === "string") return String(a) === String(b);
  if(typeof a === "boolean" || typeof b === "boolean") return !!a === !!b;
  if(!isFinite(a) || !isFinite(b)) return String(a) === String(b);
  return Math.abs(a-b) <= TOL * Math.max(1, Math.abs(a), Math.abs(b));
};

function diff(app, ref){
  const out = [];
  if(app.recs.length !== ref.recs.length)
    out.push({where:"recs.length", field:"length", app:app.recs.length, ref:ref.recs.length});
  const n = Math.min(app.recs.length, ref.recs.length);
  for(let i=0;i<n;i++) for(const k of REC)
    if(!near(app.recs[i][k], ref.recs[i][k]))
      out.push({where:`recs[${i}]`, field:k, app:app.recs[i][k] ?? null, ref:ref.recs[i][k] ?? null});
  const keys = new Set([...Object.keys(app.items), ...Object.keys(ref.items)]);
  for(const id of keys){
    const A = app.items[id], B = ref.items[id];
    if(!A || !B){ out.push({where:`items.${id}`, field:"exists", app:!!A, ref:!!B}); continue }
    for(const k of ITEM) if(!near(A[k], B[k]))
      out.push({where:`items.${id}`, field:k, app:A[k] ?? null, ref:B[k] ?? null});
    const pa = A.periods || [], pb = B.periods || [];
    if(pa.length !== pb.length)
      out.push({where:`items.${id}.periods`, field:"length", app:pa.length, ref:pb.length});
    for(let j=0;j<Math.min(pa.length,pb.length);j++) for(const k of PER)
      if(!near(pa[j][k], pb[j][k]))
        out.push({where:`items.${id}.periods[${j}]`, field:k, app:pa[j][k] ?? null, ref:pb[j][k] ?? null});
  }
  for(const k of ALL) if(!near(app.all?.[k], ref.all?.[k]))
    out.push({where:"all", field:k, app:app.all?.[k] ?? null, ref:ref.all?.[k] ?? null});
  for(const k of TARE) if(!near(app.tare[k], ref.tare[k]))
    out.push({where:"tare", field:k, app:app.tare[k] ?? null, ref:ref.tare[k] ?? null});
  if(!near(app.dSince, ref.dSince))
    out.push({where:"root", field:"dSince", app:app.dSince, ref:ref.dSince});
  return out;
}

/* какой класс расхождения — по набору полей и тегам случая */
function classify(ds, tags){
  const f = new Set(ds.map(d => d.field));
  // раньше здесь был класс frozen-ignored-by-reference: эталон не знал про заморозку сумм.
  // Теперь знает, и такое расхождение — настоящая находка, а не известное расхождение.
  if(f.has("length")) return "recs-count";
  const only = [...f].sort().join(",");
  return only;
}

// ---------------------------------------------------------------- прогон
console.log(`фаззинг: ${N} случаев, seed ${SEED0}..${SEED0+N-1}, допуск ${TOL}`);
fs.mkdirSync(CASES, {recursive:true});
for(const f of fs.readdirSync(CASES)) if(/^\d+\.json$/.test(f)) fs.unlinkSync(path.join(CASES,f));

// 1) сгенерировать всё и посчитать эталоном одним заходом
const cases = [];
for(let i=0;i<N;i++) cases.push(gen(SEED0+i));
const inp = path.join(HERE, ".in.jsonl"), outp = path.join(HERE, ".out.jsonl");
fs.writeFileSync(inp, cases.map(c => JSON.stringify({data:c.data, now:c.now})).join("\n")+"\n");
process.stdout.write("эталон считает… ");
execFileSync("python3", [path.join(HERE,"ref_batch.py"), inp, outp], {stdio:["ignore","inherit","inherit"]});
const refs = fs.readFileSync(outp,"utf8").trim().split("\n").map(l => JSON.parse(l));
console.log("готово");

// 2) приложение
const hub = boot();
const stats = {ok:0, bad:0, appErr:0, refErr:0};
const classes = new Map();
let saved = 0;

for(let i=0;i<N;i++){
  const c = cases[i], ref = refs[i];
  if(i % 25 === 0) process.stdout.write(`\r  ${i}/${N}  расхождений ${stats.bad}   `);

  freezeTime(c.now);
  let app = null, appErr = null;
  try{
    const S = hub.S;
    Object.assign(S, norm(c.data));
    const M = hub.model();
    app = {
      recs: M.recs.map(r => Object.fromEntries(REC.map(k => [k, r[k]]))),
      items: Object.fromEntries(Object.entries(M.items).map(([id,it]) => [id,
        Object.assign(Object.fromEntries(ITEM.map(k => [k, it[k]])),
          {periods: (it.periods||[]).map(x => Object.fromEntries(PER.map(k => [k, x[k]])))})])),
      tare: Object.fromEntries(TARE.map(k => [k, M.tare[k]])),
      all: Object.fromEntries(ALL.map(k => [k, M.all[k]])),
      dSince: M.dSince
    };
  }catch(e){ appErr = String(e && e.message || e) }
  unfreezeTime();

  if(appErr || !ref.ok){
    if(appErr) stats.appErr++;
    if(!ref.ok) stats.refErr++;
    const ds = [{where:"exception", field:"throw", app:appErr, ref:ref.ok ? null : ref.error}];
    record(i, c, ds, appErr ? "app-throws" : "reference-throws");
    continue;
  }
  const ds = diff(app, ref.M);
  if(ds.length === 0){ stats.ok++; continue }
  stats.bad++;
  record(i, c, ds, classify(ds, c.tags));
}
process.stdout.write(`\r  ${N}/${N}  расхождений ${stats.bad}          \n`);

function record(i, c, ds, cls){
  if(!classes.has(cls)) classes.set(cls, []);
  const bucket = classes.get(cls);
  const size = JSON.stringify(c.data).length;
  bucket.push({seed: SEED0+i, tags:c.tags, ds, size});
  const file = path.join(CASES, String(SEED0+i).padStart(4,"0")+".json");
  fs.writeFileSync(file, JSON.stringify({seed:SEED0+i, tags:c.tags, now:c.now, class:cls,
                                          diffs:ds.slice(0,40), data:c.data}, null, 1));
  saved++;
}

// ---------------------------------------------------------------- сводка
console.log("\n=== СВОДКА ===");
console.log(`случаев: ${N} · совпало: ${stats.ok} · разошлось: ${stats.bad + stats.appErr + stats.refErr}`);
console.log(`исключений: приложение ${stats.appErr}, эталон ${stats.refErr}`);
console.log(`файлы с входными данными: ${CASES} (${saved} шт)`);
console.log("\n=== КЛАССЫ РАСХОЖДЕНИЙ ===");
const sortedCls = [...classes.entries()].sort((a,b) => b[1].length - a[1].length);
for(const [cls, list] of sortedCls){
  const min = list.slice().sort((a,b) => a.size - b.size)[0];
  console.log(`\n▸ ${cls}  — ${list.length} случ.  теги минимального: [${min.tags.join(", ") || "—"}]`);
  console.log(`  минимальный пример: cases/${String(min.seed).padStart(4,"0")}.json (seed ${min.seed})`);
  for(const d of min.ds.slice(0,6))
    console.log(`    ${d.where}.${d.field}:  приложение = ${fmt(d.app)}   эталон = ${fmt(d.ref)}`);
  if(min.ds.length > 6) console.log(`    … ещё ${min.ds.length-6} полей`);
}
function fmt(v){ return typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(6)) : JSON.stringify(v) }
fs.unlinkSync(inp); fs.unlinkSync(outp);

#!/usr/bin/env node
/* Дымовой тест против живого сервера. Ничего не пишет.

   Запускается после каждого деплоя (deploy.sh) и руками:
     node tools/smoke.mjs

   Проверяет, что на живых данных:
   1. сервер жив и отдаёт склад целиком;
   2. приложение и эталон (tools/reference.py) считают одно и то же —
      те же периоды, остатки, закупку и тару;
   3. фото чека ходит обратно: берём последний сохранённый чек и читаем его;
   4. план напоминаний строится (без отправки), и прогноз тары на сервере
      совпадает с тем, что показывает приложение.

   Нужен токен бота в .env.local (BOT_TOKEN=…): им подписываем запрос так же,
   как это делает Telegram. Без токена тест честно говорит «пропущено».
   Apps Script изредка отвечает HTML-заглушкой вместо данных — поэтому повторы. */
import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { compute } from "./tests/front/harness.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const env = {};
const envFile = path.join(ROOT, ".env.local");
if (existsSync(envFile))
  for (const l of readFileSync(envFile, "utf8").split("\n")) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2];
  }
const TOKEN = process.env.BOT_TOKEN || env.BOT_TOKEN;
const USER_ID = Number(process.env.SMOKE_USER_ID || env.SMOKE_USER_ID || 1285269855);
const API = readFileSync(path.join(ROOT, "config.js"), "utf8").match(/API:\s*"([^"]+)"/)?.[1];

let fail = 0;
const ok  = (t, extra = "") => console.log(`  ✓ ${t}${extra ? " — " + extra : ""}`);
const bad = (t, extra = "") => { fail++; console.log(`  ✗ ${t}${extra ? " — " + extra : ""}`) };

if (!TOKEN || !API) { console.log("Дымовой тест пропущен: нет BOT_TOKEN в .env.local или адреса API в config.js"); process.exit(0) }

function initData(){
  const user = JSON.stringify({ id: USER_ID, first_name: "дымовой тест" });
  const f = { auth_date: String(Math.floor(Date.now() / 1000)), chat_instance: "-1", chat_type: "private", query_id: "SMOKE", user };
  const dcs = Object.keys(f).sort().map(k => k + "=" + f[k]).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(TOKEN).digest();
  const hash = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
  return Object.keys(f).map(k => k + "=" + encodeURIComponent(f[k])).join("&") + "&hash=" + hash;
}

// только чтение: пишущие действия сюда не пускаем даже случайно
const READ_ONLY = new Set(["list", "getReceipt", "remindPlan", "tareNow"]);
async function call(action, payload = {}, check = () => true){
  if (!READ_ONLY.has(action)) throw new Error("дымовой тест не пишет: " + action);
  let last;
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(API, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action, payload, initData: initData() }) });
      const t = await r.text();
      const j = JSON.parse(t);
      if (!j.ok) throw Object.assign(new Error(j.error), { final: true });
      if (check(j.data)) return j.data;
      last = new Error("неполный ответ");
    } catch (e) { if (e.final) throw e; last = e }
    await new Promise(r => setTimeout(r, 1200 * (i + 1)));
  }
  throw last;
}

console.log("Дымовой тест на живом сервере:");

// 1. склад целиком
let raw;
try {
  raw = await call("list", { fresh: true }, d => d?.products && d.counts && d.purchases && d.returns);
  const n = k => Object.keys(raw[k]).length;
  n("products") >= 10 ? ok("склад отдаётся целиком", `товаров ${n("products")}, подсчётов ${n("counts")}, закупок ${n("purchases")}, сдач ${n("returns")}`)
                      : bad("склад подозрительно маленький", `товаров ${n("products")}`);
} catch (e) { bad("склад не отдался", e.message); console.log(`\nДымовой тест: провалов ${fail}`); process.exit(1) }

// 2. приложение и эталон на живых данных. Удалённое в расчёты не идёт — как в приложении.
try {
  const alive = o => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => !v.deleted));
  const data = { products: raw.products, counts: alive(raw.counts), purchases: alive(raw.purchases), returns: alive(raw.returns) };
  const now = new Date().toISOString();
  const arr = o => Object.entries(o).map(([id, v]) => ({ id, ...v }));
  const { M } = compute({ products: arr(data.products), counts: arr(data.counts), purchases: arr(data.purchases), returns: arr(data.returns) }, { now });

  const dir = mkdtempSync(path.join(tmpdir(), "smoke-"));
  const inp = path.join(dir, "d.json");
  writeFileSync(inp, JSON.stringify(data));
  const py = `import json,sys; sys.path.insert(0,${JSON.stringify(path.join(ROOT, "tools"))}); import reference as R
M=R.compute(json.load(open(${JSON.stringify(inp)})), ${JSON.stringify(now)})
print(json.dumps({"recs":[{k:r[k] for k in ("saleUnits","expected","got","net")} for r in M["recs"]],
 "items":{k:{f:v[f] for f in ("exact","st","need")} for k,v in M["items"].items()},
 "tare":{k:M["tare"][k] for k in ("unitsWaiting","waiting")}}, default=str))`;
  const ref = JSON.parse(execFileSync("python3", ["-c", py], { encoding: "utf8" }));

  const near = (a, b) => (a == null && b == null) || (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-6 : String(a) === String(b));
  const diffs = [];
  M.recs.forEach((r, i) => ["saleUnits", "expected", "got", "net"].forEach(k => { if (!near(r[k], ref.recs[i]?.[k])) diffs.push(`период ${i}: ${k} ${r[k]} ≠ ${ref.recs[i]?.[k]}`) }));
  for (const id of Object.keys(ref.items)) ["exact", "st", "need"].forEach(k => { if (!near(M.items[id]?.[k], ref.items[id][k])) diffs.push(`${id}.${k} ${M.items[id]?.[k]} ≠ ${ref.items[id][k]}`) });
  ["unitsWaiting", "waiting"].forEach(k => { if (!near(M.tare[k], ref.tare[k])) diffs.push(`тара.${k} ${M.tare[k]} ≠ ${ref.tare[k]}`) });
  // прогноз тары для напоминаний считает сервер — у него своя копия формулы
  const srv = await call("tareNow", {}, d => d && typeof d.units === "number");
  if (Math.abs(srv.units - M.tare.unitsWaiting) > 1)
    diffs.push(`прогноз тары: сервер ${srv.units} шт, приложение ${M.tare.unitsWaiting} шт`);
  diffs.length ? bad("приложение и эталон разошлись на живых данных", diffs.slice(0, 5).join("; "))
               : ok("приложение и эталон сошлись на живых данных", `${M.recs.length} период(а), ${Object.keys(ref.items).length} позиций, тара ${M.tare.unitsWaiting} шт`);
} catch (e) { bad("сверка с эталоном не прошла", e.message) }

// 3. фото чека — читаем последний сохранённый, ничего не записывая
try {
  const withReceipt = Object.entries(raw.purchases).filter(([, p]) => p.receipt).sort((a, b) => (a[1].date < b[1].date ? 1 : -1));
  if (!withReceipt.length) ok("фото чека — пропущено", "ни у одной закупки пока нет чека");
  else {
    const f = await call("getReceipt", { id: withReceipt[0][0] }, d => d?.data);
    /^image\//.test(f.mime) && f.data.length > 100
      ? ok("фото чека читается", `${f.mime}, ${Math.round(f.data.length * 0.75 / 1024)} КБ`)
      : bad("фото чека вернулось не картинкой", f.mime);
  }
} catch (e) { bad("фото чека не читается", e.message) }

// 4. план напоминаний строится
try {
  const plan = await call("remindPlan", {}, Array.isArray);
  ok("план напоминаний строится", plan.length ? plan.map(p => `${p.kind} → ${p.to} чел.`).join(", ") : "сегодня напоминать нечего");
} catch (e) { bad("план напоминаний не строится", e.message) }

console.log(fail ? `\nДымовой тест: провалов ${fail}` : "\nДымовой тест пройден.");
process.exit(fail ? 1 : 0);

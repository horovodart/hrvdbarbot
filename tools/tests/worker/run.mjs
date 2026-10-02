#!/usr/bin/env node
/* Сервер на Cloudflare (worker/src/index.js) в Node: настоящая SQLite (node:sqlite — тот же
   движок, что у D1), KV в памяти, поддельные Telegram и модель. Ни одного настоящего
   сообщения тесты не отправляют.
   Отдельный блок сверяет новый сервер со старым: одни и те же действия на Apps Script
   (в его песочнице) и на воркере должны дать один и тот же склад.
   Запуск: node tools/tests/worker/run.mjs */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import path from "node:path";
import worker, { _resetSeedMemo, localHour, tareForecast } from "../../../worker/src/index.js";
import { SEED_VERSION, SEED } from "../../../worker/src/seed.js";
import { newApp } from "../server/gas-mock.mjs";
import { compute } from "../front/harness.mjs";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("ОК      " + name) }
  else { fail++; console.log("ПРОВАЛ  " + name + (detail ? "\n        " + detail : "")) }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `ожидалось ${JSON.stringify(b)}, получено ${JSON.stringify(a)}`);
async function test(name, fn) {
  console.log("\n— " + name + " —");
  try { await fn() } catch (e) { fail++; console.log("ПРОВАЛ  " + name + ": исключение\n        " + (e.stack || e)) }
}

/* ---------- песочница ---------- */
const TOKEN = "777:TEST-bar-token";
const ORIGIN = "https://hrvd-bar.example.workers.dev";
const MISHA = { id: 1285269855, first_name: "Миша" };      // админ из команды (сид)
const KATYA = { id: 587696431, first_name: "Катя" };
const STRANGER = { id: 42, first_name: "Чужой" };

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(path.join(ROOT, "worker/schema.sql"), "utf8"));
  const stats = { queries: 0, batches: 0 };
  const statement = (sql, args = []) => ({
    sql, args,
    bind: (...values) => statement(sql, values),
    all: async () => { stats.queries++; return { results: db.prepare(sql).all(...args) } },
    first: async () => { stats.queries++; return db.prepare(sql).get(...args) || null },
    run: async () => { stats.queries++; const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: r.changes } } },
    _exec: () => /^\s*SELECT/i.test(sql) ? { results: db.prepare(sql).all(...args) } : (db.prepare(sql).run(...args), { results: [] }),
  });
  // пачка в D1 — одна транзакция: упала одна команда — не записалось ничего
  const batch = async (list) => {
    stats.batches++; stats.queries += list.length;
    db.exec("BEGIN");
    try { const out = list.map((s) => s._exec()); db.exec("COMMIT"); return out }
    catch (e) { db.exec("ROLLBACK"); throw e }
  };
  return { raw: db, stats, prepare: (sql) => statement(sql), batch };
}
function kv() {
  const store = new Map();
  return {
    store,
    put: async (key, value, opts = {}) => { store.set(key, { value, metadata: opts.metadata || null }) },
    getWithMetadata: async (key) => store.get(key) || { value: null, metadata: null },
  };
}
function sign(user, { authDate = Math.floor(Date.now() / 1000), token = TOKEN } = {}) {
  const f = { auth_date: String(authDate), query_id: "AAE-test", user: JSON.stringify(user) };
  const check = Object.keys(f).sort().map((k) => `${k}=${f[k]}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const hash = crypto.createHmac("sha256", secret).update(check).digest("hex");
  return Object.keys(f).map((k) => k + "=" + encodeURIComponent(f[k])).join("&") + "&hash=" + hash;
}
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]);
const dataUrl = (buf, mime = "image/jpeg") => `data:${mime};base64,${buf.toString("base64")}`;

/** Мир: env, что отвечают Telegram и модель, и как позвать сервер. */
function world({ props = {}, model = null } = {}) {
  _resetSeedMemo();
  const env = { DB: d1(), RECEIPTS: kv(), BOT_TOKEN: TOKEN, PUBLIC_URL: ORIGIN, VERSION: "test", ANTHROPIC_KEY: "test-key" };
  for (const [k, v] of Object.entries(props)) env.DB.raw.prepare("INSERT INTO props (key, value) VALUES (?1, ?2)").run(k, String(v));
  const sent = [], files = new Map();
  let seq = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const t = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
    if (t) {
      if (t[1] !== TOKEN) throw new Error("чужой токен");
      const params = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(init.body);
      sent.push({ method: t[2], params });
      if (t[2] === "sendDocument") {
        const id = "tgfile-" + (++seq);
        const doc = params.document;
        files.set(id, { bytes: Buffer.from(await doc.arrayBuffer()), name: doc.name, type: doc.type });
        return Response.json({ ok: true, result: { document: { file_id: id } } });
      }
      if (t[2] === "getFile") {
        const f = files.get(params.file_id);
        return Response.json(f ? { ok: true, result: { file_path: "documents/" + params.file_id + ".jpg" } } : { ok: false, description: "file not found" });
      }
      if (t[2] === "getChatMenuButton") return Response.json({ ok: true, result: { type: "web_app", text: "Бар", web_app: { url: "https://example.test/?v=abc" } } });
      if (t[2] === "sendMessage" && params.chat_id === "заблокировал") return Response.json({ ok: false, description: "Forbidden: bot was blocked by the user" });
      return Response.json({ ok: true, result: { message_id: sent.length } });
    }
    const dl = /^https:\/\/api\.telegram\.org\/file\/bot[^/]+\/documents\/(.+)\.jpg$/.exec(url);
    if (dl) {
      sent.push({ method: "download", params: { id: dl[1] } });
      const f = files.get(dl[1]);
      return f ? new Response(f.bytes, { status: 200 }) : new Response("нет", { status: 404 });
    }
    if (url === "https://api.anthropic.com/v1/messages") {
      sent.push({ method: "anthropic", params: JSON.parse(init.body), headers: init.headers });
      const answer = typeof model === "function" ? model(JSON.parse(init.body)) : model;
      if (!answer) return new Response("нет модели", { status: 500 });
      return Response.json({ content: [{ type: "text", text: typeof answer === "string" ? answer : JSON.stringify(answer) }], usage: { input_tokens: 1 }, stop_reason: "end_turn" });
    }
    return new Response("not found", { status: 404 });
  };
  const ctx = { waitUntil: () => {} };
  const call = async (action, payload = {}, user = MISHA, initData) => {
    const body = JSON.stringify({ action, payload, initData: initData ?? (user ? sign(user) : "") });
    const r = await worker.fetch(new Request(ORIGIN + "/", { method: "POST", body }), env, ctx);
    if (r.headers.get("access-control-allow-origin") !== "*") throw new Error("нет CORS");
    return r.json();
  };
  const must = async (...args) => { const r = await call(...args); if (!r.ok) throw new Error(args[0] + ": " + r.error); return r.data };
  const get = (p) => worker.fetch(new Request(ORIGIN + p), env, ctx);
  const cron = (when) => new Promise((resolve) => worker.scheduled({ scheduledTime: new Date(when).getTime() }, env, { waitUntil: resolve }));
  const of = (m) => sent.filter((x) => x.method === m);
  return { env, sent, files, call, must, get, cron, of };
}
const byTotal = (list, total) => Object.entries(list.purchases).find(([, x]) => x.total === total);

/* ═════════════ 1. вход ═════════════ */
await test("1. вход: подпись Telegram и список команды", async () => {
  const w = world();
  const bad = await w.call("list", {}, null, "user=%7B%22id%22%3A1%7D&auth_date=9999999999&hash=" + "a".repeat(64));
  eq("1.1 чужая подпись — 401", [bad.ok, bad.status], [false, 401]);
  const none = await w.call("list", {}, null, "");
  ok("1.2 без initData — просит открыть через Telegram", !none.ok && /через Telegram/.test(none.error));
  const old = await w.call("list", {}, MISHA, sign(MISHA, { authDate: Math.floor(Date.now() / 1000) - 25 * 3600 }));
  ok("1.3 сессия старше суток — отказ", !old.ok && /устарела/.test(old.error));
  const wrongBot = await w.call("list", {}, MISHA, sign(MISHA, { token: "999:другой-бот" }));
  ok("1.4 подпись другого бота — отказ", !wrongBot.ok && wrongBot.status === 401);
  const stranger = await w.call("list", {}, STRANGER);
  ok("1.5 не из команды — отказ с его id", !stranger.ok && stranger.status === 403 && /id 42/.test(stranger.error));
  const katya = await w.call("list", {}, KATYA);
  ok("1.6 человек из команды входит", katya.ok, katya.error);
  const w2 = world({ props: { ADMIN_IDS: "42" } });
  ok("1.7 аварийный доступ ADMIN_IDS пускает", (await w2.call("list", {}, STRANGER)).ok);
  const opt = await worker.fetch(new Request(ORIGIN + "/", { method: "OPTIONS" }), w.env, {});
  eq("1.8 CORS-предзапрос отвечает 204", opt.status, 204);
  const nb = world(); delete nb.env.BOT_TOKEN;
  ok("1.9 без ключа бота — понятная ошибка", /BOT_TOKEN/.test((await nb.call("list", {}, MISHA, "x=1")).error));
});

/* ═════════════ 2. первый запуск и справочник ═════════════ */
await test("2. первый запуск: справочник, команда и история из кода", async () => {
  const w = world();
  const d = await w.must("list");
  eq("2.1 все товары справочника", Object.keys(d.products).length, Object.keys(SEED.products).length);
  eq("2.2 опорные подсчёты из кода", Object.keys(d.counts).sort(), Object.keys(SEED.counts).sort());
  ok("2.3 закупки из кода", Object.keys(SEED.purchases).every((id) => d.purchases[id]));
  const team = w.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM team").get().n;
  ok("2.4 команда заведена", team >= 5, "в команде " + team);
  eq("2.5 версия справочника запомнена", w.env.DB.raw.prepare("SELECT value FROM props WHERE key='SEED_VERSION'").get().value, String(SEED_VERSION));
  const p = d.products.aro05;
  eq("2.6 поля товара как в таблице: пустое число — null, пустой текст — ''", [p.shelf ?? null, typeof p.note, p.aliases && typeof p.aliases], [p.shelf ?? null, "string", "object"]);
  const c = Object.values(d.counts)[0];
  ok("2.7 у подсчёта есть все колонки таблицы", ["deleted", "deletedBy", "edited", "editedBy", "frozen", "amnesty"].every((k) => k in c));
  const q = w.env.DB.stats.queries;
  await w.must("list");
  ok("2.8 второе чтение справочник не трогает", w.env.DB.stats.queries - q <= 6, `запросов ${w.env.DB.stats.queries - q}`);
});

await test("2a. новая версия справочника не откатывает решения команды", async () => {
  const w = world();
  await w.must("list");
  await w.must("updateProduct", { id: "aro05", patch: { cost: 0.99, phaseout: true, name: "Самодельное имя" } });
  await w.must("update", { col: "returns", id: "r-2026-09-19", patch: { toTill: false } });
  const mine = await w.must("addPurchase", { total: 5, items: { aro05: 1 } });
  w.env.DB.raw.prepare("UPDATE props SET value='1' WHERE key='SEED_VERSION'").run();
  _resetSeedMemo();
  const d = await w.must("list");
  eq("2a.1 цена из чека осталась", d.products.aro05.cost, 0.99);
  eq("2a.2 «распродаём» осталось", d.products.aro05.phaseout, true);
  eq("2a.3 название вернулось из справочника", d.products.aro05.name, SEED.products.aro05.name);
  eq("2a.4 исправленная сдача тары не откатилась", d.returns["r-2026-09-19"].toTill, false);
  ok("2a.5 закупки команды на месте", !!byTotal(d, 5));
  eq("2a.6 версия обновилась", w.env.DB.raw.prepare("SELECT value FROM props WHERE key='SEED_VERSION'").get().value, String(SEED_VERSION));
});

/* ═════════════ 3. закупка ═════════════ */
await test("3. закупка: цены с чека, словарь, защита от дубля", async () => {
  const w = world();
  const before = (await w.must("list")).products.aro05.cost;
  const d = await w.must("addPurchase", { date: "2026-09-23T10:00:00.000Z", total: 12.5, items: { aro05: 12, hell250: 24 }, source: "METRO",
    prices: { aro05: before + 0.1, hell250: SEED.products.hell250.cost, нетакого: 5, cola033: -1 },
    learn: [{ id: "aro05", name: "ARO VODA 0,5L", shop: "METRO", article: "123" }, { id: "aro05", name: "ARO VODA 0,5L", shop: "METRO" }, { id: "нетакого", name: "x" }] }, KATYA);
  const [id, p] = byTotal(d, 12.5);
  ok("3.1 id закупки как раньше: p-…", /^p-[a-z0-9]+-[a-z0-9]{4}$/.test(id), id);
  eq("3.2 кто и когда", [p.by, p.date, p.source], ["Катя", "2026-09-23T10:00:00.000Z", "METRO"]);
  eq("3.3 цена обновилась", d.products.aro05.cost, before + 0.1);
  eq("3.4 что было → что стало", p.prices.moved.aro05, { was: before, now: before + 0.1 });
  ok("3.5 неизменная цена в «поменялось» не попала", !("hell250" in p.prices.moved) && p.prices.list.hell250 === SEED.products.hell250.cost);
  ok("3.6 мусорные цены отброшены", !("нетакого" in p.prices.list) && !("cola033" in p.prices.list));
  eq("3.7 словарь: одно написание один раз", d.products.aro05.aliases, [{ shop: "METRO", name: "ARO VODA 0,5L", article: "123" }]);
  const d2 = await w.must("addPurchase", { total: 13, items: {} });
  ok("3.8 дата по умолчанию — сейчас, автор — кто открыл", Math.abs(Date.parse(byTotal(d2, 13)[1].date) - Date.now()) < 5000 && byTotal(d2, 13)[1].by === "Миша");
  // повтор запроса с тем же номером — не дубль, и даже если два пришли одновременно
  await w.must("addPurchase", { rid: "r1", total: 77, items: { aro05: 1 } });
  await w.must("addPurchase", { rid: "r1", total: 77, items: { aro05: 1 } });
  await Promise.all([w.call("addPurchase", { rid: "r2", total: 78, items: {} }), w.call("addPurchase", { rid: "r2", total: 78, items: {} })]);
  const all = await w.must("list");
  eq("3.9 повтор с тем же номером — одна закупка", Object.values(all.purchases).filter((x) => x.total === 77).length, 1);
  eq("3.10 два одновременных повтора — одна закупка", Object.values(all.purchases).filter((x) => x.total === 78).length, 1);
  let longList = [];
  for (let i = 0; i < 15; i++) longList.push({ id: "cola033", name: "COLA " + i, shop: "S" });
  const d3 = await w.must("addPurchase", { total: 14, items: {}, learn: longList });
  eq("3.11 словарь помнит последние 12 написаний", d3.products.cola033.aliases.length, 12);
});

/* ═════════════ 4. фото чека ═════════════ */
await test("4. фото чека: документом в Telegram, копия в KV", async () => {
  const w = world();
  const up = await w.must("uploadReceipt", { photo: dataUrl(JPG), date: "2026-09-23" });
  ok("4.1 вернулся номер файла", /^tgfile-/.test(up.receipt));
  const doc = w.of("sendDocument")[0];
  ok("4.2 ушло документом (не фото — чтобы не пережало)", !!doc && w.of("sendPhoto").length === 0);
  eq("4.3 в переписку первого админа, с подписью", [doc.params.chat_id, doc.params.caption], ["1285269855", "чек 2026-09-23"]);
  eq("4.4 имя файла с расширением", doc.params.document.name, "чек.jpg");
  ok("4.5 байты те же", w.files.get(up.receipt).bytes.equals(JPG));
  const d = await w.must("addPurchase", { total: 50, items: { aro05: 1 }, receipt: up.receipt });
  const id = byTotal(d, 50)[0];
  const r = await w.must("getReceipt", { id });
  eq("4.6 только что загруженный чек — из KV, без Telegram", [w.of("getFile").length, r.mime], [0, "image/jpeg"]);
  ok("4.7 фото вернулось то же", Buffer.from(r.data, "base64").equals(JPG));
  // чек из старых времён: в KV его нет — берём из Telegram и кладём в KV
  w.env.RECEIPTS.store.clear();
  const r2 = await w.must("getReceipt", { id });
  const r3 = await w.must("getReceipt", { id });
  eq("4.8 старый чек: из Telegram один раз, дальше из KV", [w.of("getFile").length, w.of("download").length], [1, 1]);
  ok("4.9 и он тот же", Buffer.from(r2.data, "base64").equals(JPG) && r3.data === r2.data && r2.mime === "image/jpeg");
  const noPhoto = await w.must("addPurchase", { total: 51, items: {} });
  ok("4.10 закупка без фото — понятная ошибка", /нет фото/.test((await w.call("getReceipt", { id: byTotal(noPhoto, 51)[0] })).error));
  ok("4.11 нет такой закупки — понятная ошибка", /не найдена/.test((await w.call("getReceipt", { id: "p-нет" })).error));
  ok("4.12 мусор вместо фото — отказ", /непонятном/.test((await w.call("uploadReceipt", { photo: "просто строка" })).error));
  ok("4.13 не картинка — отказ", /картинкой/.test((await w.call("uploadReceipt", { photo: "data:application/pdf;base64,JVBERg==" })).error));
  ok("4.14 больше 8 МБ — отказ", /большое/.test((await w.call("uploadReceipt", { photo: dataUrl(Buffer.alloc(8 * 1024 * 1024 + 10, 1)) })).error));
  // старое приложение шлёт фото прямо в закупку
  const legacy = await w.must("addPurchase", { total: 52, items: {}, photo: dataUrl(JPG) });
  ok("4.15 фото прямо в закупке тоже сохраняется", /^tgfile-/.test(byTotal(legacy, 52)[1].receipt));
  const w2 = world({ props: { RECEIPTS_CHAT: "-100777" } });
  await w2.must("uploadReceipt", { photo: dataUrl(JPG) });
  eq("4.16 RECEIPTS_CHAT важнее админов", w2.of("sendDocument")[0].params.chat_id, "-100777");
});

/* ═════════════ 5. подсчёт, тара, товары ═════════════ */
await test("5. подсчёт, сдача тары, товары", async () => {
  const w = world();
  const d = await w.must("addCount", { date: "2026-10-01T10:00:00.000Z", cash: 1.95, card: 21, stock: { aro05: 5 }, frozen: { price: 1.5, saleUnits: 3 }, amnesty: true }, KATYA);
  const c = Object.values(d.counts).find((x) => x.cash === 1.95);
  eq("5.1 подсчёт записан целиком", [c.by, c.card, c.stock, c.frozen.saleUnits, c.amnesty, c.initial], ["Катя", 21, { aro05: 5 }, 3, true, ""]);
  const d2 = await w.must("addReturn", { amount: 15.15, units: 101, toTill: false, note: "в сейф" });
  const r = Object.values(d2.returns).find((x) => x.amount === 15.15);
  eq("5.2 сдача тары записана", [r.units, r.toTill, r.note, r.by], [101, false, "в сейф", "Миша"]);
  const d3 = await w.must("addReturn", {});
  ok("5.3 пустая сдача — нули, а не пустоты", Object.values(d3.returns).some((x) => x.amount === 0 && x.units === 0 && x.toTill === false));
  const d4 = await w.must("addProduct", { id: "newbeer", data: { name: "Новое пиво", cat: "sale", cost: "0,99", hidden: false, мусор: 1 } });
  eq("5.4 новый товар: цена с запятой стала числом, лишнее отброшено", [d4.products.newbeer.cost, "мусор" in d4.products.newbeer], [0.99, false]);
  ok("5.5 второй товар с тем же id — отказ", /уже есть/.test((await w.call("addProduct", { id: "newbeer", data: {} })).error));
  ok("5.6 товар без id — отказ", /Нет id/.test((await w.call("addProduct", { data: {} })).error));
  const d5 = await w.must("updateProduct", { id: "newbeer", patch: { min: 12, hidden: true } });
  eq("5.7 правка товара", [d5.products.newbeer.min, d5.products.newbeer.hidden, d5.products.newbeer.name], [12, true, "Новое пиво"]);
  ok("5.8 правка несуществующего товара — отказ", /Не нашёл/.test((await w.call("updateProduct", { id: "нет", patch: { min: 1 } })).error));
  const d6 = await w.must("delete", { col: "products", id: "newbeer" });
  ok("5.9 товар удаляется насовсем", !d6.products.newbeer);
});

await test("6. удаление, возврат, правка", async () => {
  const w = world();
  const id = byTotal(await w.must("addPurchase", { total: 101, items: { aro05: 6 } }), 101)[0];
  const d = await w.must("delete", { col: "purchases", id }, KATYA);
  ok("6.1 удаление мягкое: строка осталась, видно кто", d.purchases[id] && !!d.purchases[id].deleted && d.purchases[id].deletedBy === "Катя");
  const d2 = await w.must("restore", { col: "purchases", id });
  eq("6.2 вернули — пометки сняты", [d2.purchases[id].deleted, d2.purchases[id].deletedBy], ["", ""]);
  ok("6.3 удалить несуществующее — отказ", /Не нашёл/.test((await w.call("delete", { col: "counts", id: "c-нет" })).error));
  ok("6.4 удалить из чужого листа — отказ", /Нельзя удалять/.test((await w.call("delete", { col: "team", id: "1" })).error));
  ok("6.5 вернуть товар нельзя — он удаляется насовсем", /Нельзя вернуть/.test((await w.call("restore", { col: "products", id: "aro05" })).error));
  const d3 = await w.must("update", { col: "purchases", id, patch: { total: 99.5, source: "Kaufland", items: { aro05: 12 }, receipt: "подмена", prices: { x: 1 }, date: "2000-01-01" } }, KATYA);
  const p = d3.purchases[id];
  eq("6.6 правятся только разрешённые поля", [p.total, p.source, p.items, p.receipt, p.date.slice(0, 4)], [99.5, "Kaufland", { aro05: 12 }, "", p.date.slice(0, 4) === "2000" ? "bad" : p.date.slice(0, 4)]);
  eq("6.7 видно, кто правил", p.editedBy, "Катя");
  const cid = Object.keys((await w.must("addCount", { cash: 50, stock: { aro05: 5 } })).counts).find((k) => k.startsWith("c-") && !SEED.counts[k]);
  ok("6.8 остатки в подсчёте не правятся", /Нечего править/.test((await w.call("update", { col: "counts", id: cid, patch: { stock: { aro05: 500 } } })).error));
  const d4 = await w.must("update", { col: "counts", id: cid, patch: { amnesty: true, cash: 55, stock: { aro05: 500 } } });
  eq("6.9 амнистия и касса правятся, остаток — нет", [d4.counts[cid].amnesty, d4.counts[cid].cash, d4.counts[cid].stock.aro05], [true, 55, 5]);
  const rid = Object.keys(d4.returns)[0];
  const d5 = await w.must("update", { col: "returns", id: rid, patch: { toTill: false, amount: "15,30" } });
  eq("6.10 сдача тары правится", [d5.returns[rid].toTill, d5.returns[rid].amount], [false, 15.3]);
  ok("6.11 править товары через update нельзя", /Нельзя править/.test((await w.call("update", { col: "products", id: "aro05", patch: { cost: 1 } })).error));
  // две правки одной записи одновременно — обе доезжают
  await Promise.all([w.call("update", { col: "purchases", id, patch: { total: 1 } }), w.call("update", { col: "purchases", id, patch: { source: "Tesco" } })]);
  const p2 = (await w.must("list")).purchases[id];
  eq("6.12 одновременные правки не затирают друг друга", [p2.total, p2.source], [1, "Tesco"]);
});

await test("7. порядок полок", async () => {
  const w = world();
  const d = await w.must("reorder", { ids: ["hell250", "aro05"] });
  eq("7.1 порядок записан", [d.products.hell250.shelf, d.products.aro05.shelf], [1, 2]);
  ok("7.2 кого нет в списке — порядок снят", Object.entries(d.products).filter(([k]) => !["hell250", "aro05"].includes(k)).every(([, p]) => p.shelf === null));
  ok("7.3 пустой порядок — отказ", /Пустой/.test((await w.call("reorder", { ids: [] })).error));
  ok("7.4 неизвестное действие — отказ", /Неизвестное действие: взлом/.test((await w.call("взлом", {})).error));
});

/* ═════════════ 8. разбор чека ═════════════ */
await test("8. разбор чека моделью", async () => {
  const answer = { shop: "METRO", date: "2026-09-23", total: 60, lines: [
    { name: "HELL 250ml PLZ", qty: 24, sum: 15.6, deposit: 10.8, match: "hell250" },
    { name: "HELL PLZ 24x", qty: 24, sum: 3.6, match: null },
    { name: "ARO 0,5", qty: 12, sum: 2.88, deposit: null, match: "нетакого" },
    { name: "", qty: 1, sum: 1 },
  ] };
  const w = world({ model: answer });
  await w.must("addPurchase", { total: 1, items: {}, learn: [{ id: "aro05", name: "ARO VODA", shop: "METRO" }] });
  const r = await w.must("parseReceipt", { photo: dataUrl(JPG) });
  eq("8.1 залог выкинут, пустая строка тоже", r.lines.map((l) => l.name), ["HELL 250ml PLZ", "ARO 0,5"]);
  eq("8.2 количество исправлено по залогу", [r.lines[0].qty, r.lines[0].unit], [72, 0.217]);
  eq("8.3 чужой id сброшен", r.lines[1].match, null);
  eq("8.4 сверка с итогом", [r.check.sum, r.check.total, r.check.fits, r.skipped], [18.48, 60, false, 1]);
  const req = w.of("anthropic")[0];
  eq("8.5 модель и ключ как раньше, рассуждение выключено", [req.params.model, req.headers["x-api-key"], req.params.thinking.type], ["claude-sonnet-5", "test-key", "disabled"]);
  ok("8.6 справочник с написаниями из прошлых чеков", /aro05 — [^\n]+\n    в чеках: METRO: ARO VODA/.test(req.params.messages[0].content[1].text));
  const w2 = world({ model: "Вот JSON: " + JSON.stringify(answer) + " надеюсь, помог" });
  ok("8.7 пара фраз вокруг JSON не мешает", (await w2.must("parseReceipt", { photo: dataUrl(JPG) })).lines.length === 2);
  ok("8.8 ответ не по схеме — понятная ошибка", /не по схеме/.test((await world({ model: "нет" }).call("parseReceipt", { photo: dataUrl(JPG) })).error));
  ok("8.9 «это не чек» доходит до человека", /не чек/.test((await world({ model: { error: "это не чек" } }).call("parseReceipt", { photo: dataUrl(JPG) })).error));
  const nokey = world({ model: answer }); delete nokey.env.ANTHROPIC_KEY;
  ok("8.10 без ключа модели — понятная ошибка", /ключ модели/.test((await nokey.call("parseReceipt", { photo: dataUrl(JPG) })).error));
  ok("8.11 сломанная модель — код ответа в ошибке", /Модель ответила 500/.test((await world({ model: null }).call("parseReceipt", { photo: dataUrl(JPG) })).error));
  ok("8.12 разбор ничего не записывает", Object.keys((await w.must("list")).purchases).length === Object.keys(SEED.purchases).length + 1);
});

/* ═════════════ 9. напоминания ═════════════ */
const quiet = (n) => ({ products: { b: { dep: 0.15 } }, counts: {}, purchases: {}, returns: {}, ...n });
await test("9. напоминания и прогноз тары", async () => {
  // прогноз тары — та же формула, что в приложении
  const w = world();
  const list = await w.must("list");
  const arr = (o) => Object.entries(o).map(([id, v]) => ({ id, ...v }));
  const now = new Date("2026-10-05T12:00:00.000Z");
  const { M } = compute({ products: arr(list.products), counts: arr(list.counts), purchases: arr(list.purchases), returns: arr(list.returns) }, { now: now.toISOString() });
  eq("9.1 прогноз тары совпадает с приложением", tareForecast(list, now).units, M.tare.unitsWaiting);
  const t = await w.must("tareNow");
  ok("9.2 tareNow отвечает", typeof t.units === "number" && typeof t.eur === "number");

  const w2 = world({ props: { REMIND_COUNT_TO: "587696431", REMIND_TARE_TO: "1285269855" } });
  await w2.must("list");
  const plan = await w2.must("remindPlan");
  ok("9.3 план напоминаний строится без отправки", Array.isArray(plan) && w2.of("sendMessage").length === 0);
  // подсчёт давно не делали: 10:07 по Братиславе (08:07 UTC летом)
  const last = Object.values((await w2.must("list")).counts).map((c) => c.date).sort().pop();
  const due = new Date(Date.parse(last) + 15 * 864e5);
  due.setUTCHours(8, 7, 0, 0);
  eq("9.4 10 утра по Братиславе", localHour(due), 10);
  await w2.cron(due);
  eq("9.5 выключено до переезда — ничего не шлёт", w2.of("sendMessage").length, 0);
  w2.env.DB.raw.prepare("INSERT INTO props (key, value) VALUES ('REMINDERS_ON', 'yes')").run();
  const off = new Date(due); off.setUTCHours(13);
  await w2.cron(off);
  eq("9.6 не в 10 утра — молчит", w2.of("sendMessage").length, 0);
  await w2.cron(due);
  const msgs = w2.of("sendMessage");
  ok("9.7 про подсчёт — Кате, с кнопкой «Открыть бар»", msgs.some((m) => m.params.chat_id === "587696431" && /Пора считать/.test(m.params.text) && m.params.reply_markup.inline_keyboard[0][0].web_app.url === "https://example.test/?v=abc"),
    JSON.stringify(msgs.map((m) => [m.params.chat_id, m.params.text])));
  ok("9.8 никому лишнему", msgs.every((m) => ["587696431", "1285269855"].includes(m.params.chat_id)));
  const n = msgs.length;
  await w2.cron(due);
  eq("9.9 то же напоминание второй раз не шлёт", w2.of("sendMessage").length, n);
  const later = new Date(Date.parse(last) + 22 * 864e5); later.setUTCHours(8, 7, 0, 0);
  await w2.cron(later);
  ok("9.10 через 21 день — второе, построже", w2.of("sendMessage").slice(n).some((m) => /не делали уже/.test(m.params.text)));
  // бот был выключен на 14-й день (как при переезде): на 22-й — строгое, а назавтра мягкое не догоняет
  const w4 = world({ props: { REMINDERS_ON: "yes", REMIND_COUNT_TO: "587696431" } });
  await w4.must("list");
  const d22 = new Date(Date.parse(last) + 22 * 864e5); d22.setUTCHours(8, 7, 0, 0);
  const d23 = new Date(d22.getTime() + 864e5);
  await w4.cron(d22); await w4.cron(d23);
  const texts = w4.of("sendMessage").filter((m) => m.params.chat_id === "587696431" && /считать|не делали/.test(m.params.text)).map((m) => m.params.text);
  ok("9.10a пропущенный 14-й день: одно строгое напоминание и всё", texts.length === 1 && /не делали уже/.test(texts[0]), JSON.stringify(texts));
  ok("9.10b «21 день», а не «21 дней»", /уже 21 день —/.test(texts[0] || ""), texts[0]);
  const w3 = world({ props: { REMINDERS_ON: "yes", REMIND_CHAT: "заблокировал" } });
  await w3.must("list");
  await w3.cron(due);
  ok("9.11 заблокировал бота — сервер не падает", w3.of("sendMessage").length >= 1);
  // уборка старых номеров запросов
  w.env.DB.raw.prepare("INSERT INTO rids (rid, at) VALUES ('old', '2020-01-01T00:00:00.000Z'), ('new', ?1)").run(new Date().toISOString());
  await w.cron(new Date());
  eq("9.12 старые номера запросов убраны, свежие — нет", w.env.DB.raw.prepare("SELECT rid FROM rids ORDER BY rid").all().map((r) => r.rid), ["new"]);
  ok("9.13 прогноз по пустому складу — ноль", tareForecast(quiet({}), now).units === 0);
});

/* ═════════════ 10. выгрузка и проверка живости ═════════════ */
await test("10. выгрузка для переезда и GET /", async () => {
  const w = world({ props: { ADMIN_IDS: "1285269855", REMIND_TARE_TO: "1285269855", SOME_API_KEY: "секрет" } });
  const e = await w.must("export");
  ok("10.1 выгрузка: всё и команда", e.products && e.counts && e.purchases && e.returns && e.team.length >= 5);
  ok("10.2 секреты не выгружаются", !JSON.stringify(e.props).includes("секрет") && e.props.REMIND_TARE_TO === "1285269855");
  w.env.DB.raw.prepare("UPDATE team SET role='member' WHERE tg_id='587696431'").run();
  ok("10.3 не админу выгрузка закрыта", /Только для админов/.test((await w.call("export", {}, KATYA)).error));
  const h = await (await w.get("/")).json();
  ok("10.4 GET / живой, со счётчиками", h.ok && h.data.alive && h.data.status.products === Object.keys(SEED.products).length && h.data.version === "test");
  ok("10.5 GET / без имён и id", !/Миша|Катя|1285269855|587696431/.test(JSON.stringify(h)));
  eq("10.6 чужой адрес — 404", (await w.get("/secret")).status, 404);
});

/* ═════════════ 11. сверка со старым сервером ═════════════ */
await test("11. новый сервер отдаёт то же, что старый (Apps Script)", async () => {
  const U = { id: "1285269855", name: "Миша" };
  const gas = newApp({ props: { BOT_TOKEN: TOKEN } });
  gas.api.setup(); gas.api.syncProducts();
  const w = world();
  await w.must("list");
  const steps = [
    ["addPurchase", { date: "2026-09-23T10:00:00.000Z", total: 189.63, items: { hell250: 72, aro05: 48 }, source: "METRO", by: "Michael",
      prices: { hell250: 0.66, aro05: 0.24 }, learn: [{ id: "hell250", name: "HELL 250ml PLZ", shop: "METRO", article: "1" }] }],
    ["addCount", { date: "2026-09-29T15:01:09.605Z", cash: 1.95, card: 21, by: "Катя", stock: { hell250: 64, aro05: 79 }, frozen: { price: 1.5, saleUnits: 24 } }],
    ["addReturn", { date: "2026-09-22T21:36:28.119Z", amount: 15.15, units: 101, toTill: true, by: "Миша" }],
    ["addReturn", { date: "2026-09-30T10:00:00.000Z", amount: 3, units: 20 }],
    ["reorder", { ids: ["aro05", "hell250", "kozel05"] }],
    ["updateProduct", { id: "kozel05", patch: { min: 24, hidden: true } }],
  ];
  const WHO = { id: "1285269855", name: "Миша" };
  let g, v;
  for (const [a, p] of steps) { g = gas.api.handle(a, JSON.parse(JSON.stringify(p)), WHO); v = await w.must(a, p) }
  // записи, созданные сейчас, у двух серверов с разными id — сопоставляем по дате
  const norm = (list) => {
    const out = {};
    for (const c of ["products", "counts", "purchases", "returns"]) {
      out[c] = Object.entries(list[c]).map(([id, x]) => {
        const y = { ...x };
        const k = SEED[c] && SEED[c][id] || c === "products" || /^r-(start|2026)/.test(id) ? id : "new:" + x.date;
        return [k, y];
      }).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    }
    return out;
  };
  const G = norm(gas.api.listAll()), V = norm(v);
  for (const c of ["products", "counts", "purchases", "returns"]) {
    const diffs = [];
    const gm = new Map(G[c]), vm = new Map(V[c]);
    for (const k of new Set([...gm.keys(), ...vm.keys()])) {
      const a = gm.get(k), b = vm.get(k);
      if (!a || !b) { diffs.push(k + (a ? " только в старом" : " только в новом")); continue }
      for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) diffs.push(`${k}.${f}: старый ${JSON.stringify(a[f])} ≠ новый ${JSON.stringify(b[f])}`);
      }
    }
    ok(`11.${c} совпадает (${gm.size} записей)`, !diffs.length, diffs.slice(0, 6).join("\n        "));
  }
  // и правка/удаление/возврат по тем же id
  const pid = G.purchases.find(([k]) => k.startsWith("new:"))[0];
  const gid = Object.entries(gas.api.listAll().purchases).find(([, x]) => "new:" + x.date === pid)[0];
  const vid = Object.entries(v.purchases).find(([, x]) => "new:" + x.date === pid)[0];
  gas.api.handle("update", { col: "purchases", id: gid, patch: { total: 190, source: "Tesco" } }, WHO);
  gas.api.handle("delete", { col: "purchases", id: gid }, WHO);
  await w.must("update", { col: "purchases", id: vid, patch: { total: 190, source: "Tesco" } });
  const vv = await w.must("delete", { col: "purchases", id: vid });
  const a = gas.api.listAll().purchases[gid], b = vv.purchases[vid];
  const strip = (x) => ({ ...x, deleted: !!x.deleted, edited: !!x.edited });
  eq("11.5 правка и удаление дают ту же запись", strip(b), strip(a));
});

/* ═════════════ 12. скорость ═════════════ */
await test("12. скорость", async () => {
  const w = world();
  await w.must("list");
  // склад на год вперёд: 60 подсчётов, 120 закупок, 40 сдач
  for (let i = 0; i < 60; i++) await w.must("addCount", { date: new Date(Date.UTC(2026, 9, 1) + i * 6 * 864e5).toISOString(), cash: 10, card: 20, stock: Object.fromEntries(Object.keys(SEED.products).map((k, j) => [k, (i * 7 + j) % 50])) });
  for (let i = 0; i < 120; i++) await w.must("addPurchase", { total: i + 0.5, items: { aro05: 12, hell250: 24 }, prices: { aro05: 0.24 } });
  for (let i = 0; i < 40; i++) await w.must("addReturn", { amount: 3, units: 20 });
  const time = async (fn, n = 20) => { const t = performance.now(); for (let i = 0; i < n; i++) await fn(); return (performance.now() - t) / n };
  const q = w.env.DB.stats.batches;
  const tList = await time(() => w.must("list"));
  const perList = (w.env.DB.stats.batches - q) / 20;
  const tWrite = await time(() => w.must("addReturn", { amount: 1, units: 1 }));
  const tReceipt = await (async () => {
    const up = await w.must("uploadReceipt", { photo: dataUrl(Buffer.concat([JPG, Buffer.alloc(400 * 1024, 3)])) });
    const id = byTotal(await w.must("addPurchase", { total: 9999, items: {}, receipt: up.receipt }), 9999)[0];
    return time(() => w.must("getReceipt", { id }), 10);
  })();
  console.log(`        list ${tList.toFixed(1)} мс · запись ${tWrite.toFixed(1)} мс · чек 400 КБ ${tReceipt.toFixed(1)} мс (без сети)`);
  ok("12.1 весь склад за год читается одной пачкой запросов", perList <= 1.01, `пачек на чтение ${perList}`);
  ok("12.2 чтение склада — меньше 50 мс вычислений", tList < 50, tList.toFixed(1) + " мс");
  ok("12.3 запись — меньше 50 мс вычислений", tWrite < 50, tWrite.toFixed(1) + " мс");
  ok("12.4 чек из KV — меньше 20 мс", tReceipt < 20, tReceipt.toFixed(1) + " мс");
});

console.log(`\nпрошло ${pass} из ${pass + fail}`);
process.exit(fail ? 1 : 0);

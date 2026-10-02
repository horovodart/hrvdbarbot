/**
 * HOROVOD HUB · бар — сервер на Cloudflare Workers. Заменил Google Apps Script, который
 * «просыпался» по 10–20 секунд. Протокол тот же, поэтому приложению поменяли только адрес:
 *   POST /  { action, payload, initData } → { ok: true, data } | { ok: false, error, status }
 *   GET  /  проверка живости: версия и счётчики, без имён и id
 * Каждый час (cron): напоминания бота (в 10 утра по Братиславе) и уборка.
 *
 * Данные — D1 (env.DB): products, counts, purchases, returns — по записи JSON с теми же полями,
 * что были колонками таблицы; team — кто может открыть приложение; props — настройки и память
 * напоминаний; rids — защита от дубля. Фото чеков хранятся в Telegram (как и раньше, чтобы
 * старые чеки открывались), а копия лежит в KV (env.RECEIPTS) — оттуда они открываются сразу.
 * Секреты: BOT_TOKEN, ANTHROPIC_KEY (разбор чека). Переменные: PUBLIC_URL, VERSION.
 */
import { SEED_VERSION, SEED_RETIRE, TEAM_SEED, RETURNS_SEED, SEED } from './seed.js';

/* ---------------- поля записей: ровно как колонки таблицы ---------------- */

export const COLS = {
  products: ['id','name','vol','cat','shape','color','cap','cost','dep','pack','min','order','note','hidden','phaseout','aliases','shelf'],
  counts:   ['id','date','by','cash','card','initial','note','source','stock','frozen','amnesty','deleted','deletedBy','edited','editedBy'],
  purchases:['id','date','by','total','source','items','receipt','prices','deleted','deletedBy','edited','editedBy'],
  returns:  ['id','date','by','amount','units','toTill','note','deleted','deletedBy','edited','editedBy'],
};
const COLLS = ['products', 'counts', 'purchases', 'returns'];
const JSON_FIELDS = { stock: 1, items: 1, frozen: 1, prices: 1, aliases: 1 };
const NUM_FIELDS = { cost: 1, dep: 1, pack: 1, min: 1, order: 1, shelf: 1, cash: 1, card: 1, total: 1, amount: 1, units: 1 };
const BOOL_FIELDS = { hidden: 1, initial: 1, phaseout: 1, toTill: 1, amnesty: 1 };

/* Правка записей: только эти поля. Остатки в подсчёте не правятся — деньги периода
   по ним заморожены. Чек и цены из чека тоже не трогаем: это факт, а не ввод. */
const EDITABLE = {
  purchases: { total: 1, source: 1, by: 1, items: 1 },
  counts: { cash: 1, card: 1, by: 1, note: 1, amnesty: 1 },
  returns: { amount: 1, units: 1, toTill: 1, note: 1 },
};
const SOFT_DELETE = { purchases: 1, counts: 1, returns: 1 };
const WRITES = ['addPurchase', 'addCount', 'addReturn', 'addProduct', 'updateProduct', 'delete', 'reorder', 'restore', 'update'];

/* Значение поля так, как его вернула бы таблица: пусто → null у чисел и '' у остальных,
   JSON-поля — объект. Так приложение получает те же данные, что и от старого сервера. */
function cellValue(h, v) {
  if (JSON_FIELDS[h]) return v == null || v === '' ? {} : JSON.parse(JSON.stringify(v));
  if (v === null || v === undefined || v === '') return NUM_FIELDS[h] ? null : '';
  if (NUM_FIELDS[h]) {
    const n = Number(String(v).replace(',', '.'));
    return typeof v !== 'boolean' && Number.isFinite(n) ? n : null;
  }
  if (BOOL_FIELDS[h]) return v === true || v === 'TRUE' || v === 'да';
  if (h === 'date') return String(v);
  return v;
}
const emptyValue = (h) => (JSON_FIELDS[h] ? (h === 'frozen' ? null : {}) : NUM_FIELDS[h] ? null : '');

/** Новая запись: только известные поля, каждое — как его отдала бы таблица. */
function record(name, obj) {
  const out = {};
  for (const h of COLS[name]) if (h !== 'id') out[h] = cellValue(h, obj[h]);
  return out;
}
/** Запись на выход: недостающие поля — пустыми, как пустая ячейка. */
function shape(name, data) {
  const out = { ...data };
  for (const h of COLS[name]) if (h !== 'id' && !(h in out)) out[h] = emptyValue(h);
  return out;
}

/* ---------------- вход ---------------- */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export class BarError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const fail = (message, status = 400) => {
  throw new BarError(message, status);
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method === 'GET' && url.pathname === '/') return respond(() => health(app(env)));
    if (request.method === 'POST' && url.pathname === '/') {
      return respond(async () => {
        let body;
        try {
          body = JSON.parse(await request.text());
        } catch {
          fail('Битый запрос');
        }
        const a = app(env);
        const user = await auth(a, body.initData);
        return handle(a, String(body.action || ''), body.payload || {}, user);
      });
    }
    return new Response('Not found', { status: 404, headers: CORS });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(hourly(app(env), event && event.scheduledTime ? new Date(event.scheduledTime) : new Date()));
  },
};

/** Один запрос (или один запуск по таймеру): настройки читаем один раз и держим здесь. */
function app(env) {
  return { env, props: null, list: null };
}

async function respond(fn) {
  let out;
  try {
    out = { ok: true, data: await fn() };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err), status: (err && err.status) || 400 };
    if (!(err instanceof BarError)) console.error(err && err.stack ? err.stack : err);
  }
  return new Response(JSON.stringify(out), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });
}

/* ---------------- настройки (таблица props) ---------------- */

async function loadProps(a, fresh) {
  if (a.props && !fresh) return a.props;
  const { results } = await a.env.DB.prepare('SELECT key, value FROM props').all();
  a.props = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return a.props;
}
const prop = (a, key) => (a.props && a.props[key] != null ? String(a.props[key]) : '');
async function setProp(a, key, value) {
  await a.env.DB.prepare('INSERT INTO props (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, String(value))
    .run();
  if (a.props) a.props[key] = String(value);
}
const idList = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);

/* ---------------- доступ ---------------- */

async function hmac(key, message) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, typeof message === 'string' ? new TextEncoder().encode(message) : message));
}
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

async function readTeam(a) {
  const { results } = await a.env.DB.prepare('SELECT tg_id, name, role FROM team ORDER BY rowid').all();
  return results;
}

/** Подпись Telegram и белый список: ADMIN_IDS или лист команды. */
async function auth(a, initData) {
  const token = a.env.BOT_TOKEN;
  if (!token) fail('BOT_TOKEN не задан на сервере', 503);
  if (!initData) fail('Открой приложение через Telegram', 401);
  const fields = {};
  let hash = '';
  for (const part of String(initData).split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = decodeURIComponent(part.slice(0, eq));
    const value = decodeURIComponent(part.slice(eq + 1));
    if (key === 'hash') hash = value;
    else fields[key] = value;
  }
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = await hmac(new TextEncoder().encode('WebAppData'), token);
  if (hex(await hmac(secret, check)) !== String(hash).toLowerCase()) fail('Подпись Telegram не сошлась', 401);
  const authAt = Number(fields.auth_date) * 1000;
  if (!Number.isFinite(authAt) || authAt < Date.now() - 24 * 3600 * 1000 || authAt > Date.now() + 5 * 60 * 1000)
    fail('Сессия устарела, перезапусти приложение', 401);

  let user = {};
  try {
    user = JSON.parse(fields.user || '{}');
  } catch {
    // пустой пользователь — ниже откажем
  }
  const id = String(user.id || '');
  // у человека без фамилии имя не должно стать пробелом
  const name = [user.first_name, user.last_name].map((x) => (x == null ? '' : String(x).trim())).filter(Boolean).join(' ')
    || String(user.username || '').trim() || id;
  await ensureSeed(a);   // на пустой базе сначала заводим команду из кода — иначе не пустит никого
  const rights = await access(a, id);
  if (!rights.allowed) fail('Тебя нет в списке команды (id ' + id + ')', 403);
  return { id, name, isAdmin: rights.admin };
}

async function access(a, id) {
  if (!id) return { allowed: false, admin: false };
  // аварийный доступ из настроек работает всегда
  if (idList(prop(a, 'ADMIN_IDS')).includes(id)) return { allowed: true, admin: true };
  const team = await readTeam(a);
  const me = team.find((r) => String(r.tg_id).trim() === id);
  // Команда пуста и аварийного списка нет — не пускаем никого: иначе админом стал бы первый встречный
  if (!me) return { allowed: false, admin: false };
  return { allowed: true, admin: String(me.role || '').toLowerCase() === 'admin' };
}

/* ---------------- склад ---------------- */

async function listAll(a) {
  if (a.list) return a.list;
  await ensureSeed(a);
  const res = await a.env.DB.batch(COLLS.map((c) => a.env.DB.prepare(`SELECT id, data FROM ${c} ORDER BY rowid`)));
  const out = {};
  COLLS.forEach((c, i) => {
    const o = {};
    for (const r of res[i].results) {
      try {
        o[r.id] = shape(c, JSON.parse(r.data));
      } catch {
        // битая строка не должна ронять весь склад
      }
    }
    out[c] = o;
  });
  return (a.list = out);
}
const asRows = (o) => Object.entries(o || {}).map(([id, v]) => ({ id, ...v }));

const uid = (pfx) => pfx + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);

const insertStmt = (a, name, id, obj) =>
  a.env.DB.prepare(`INSERT INTO ${name} (id, data) VALUES (?1, ?2)`).bind(String(id), JSON.stringify(record(name, obj)));

/* Правка полей одной записи — одним запросом прямо в базе (json_set): две правки
   одновременно не затирают друг друга, как бывало бы при «прочитал — переписал». */
function patchStmt(a, name, id, obj) {
  const keys = Object.keys(obj).filter((h) => h !== 'id' && COLS[name].includes(h));
  if (!keys.length) return null;
  const paths = keys.map((h, i) => `'$."${h}"', json(?${i + 2})`).join(', ');
  return a.env.DB.prepare(`UPDATE ${name} SET data = json_set(data, ${paths}) WHERE id = ?1`)
    .bind(String(id), ...keys.map((h) => JSON.stringify(cellValue(h, obj[h]))));
}
async function exists(a, name, id) {
  return !!(await a.env.DB.prepare(`SELECT 1 AS x FROM ${name} WHERE id = ?1`).bind(String(id)).first());
}

/* ---------------- действия ---------------- */

async function handle(a, action, p, user) {
  const who = user ? user.name : null;
  // чтения — без записи и без защиты от дубля
  if (action === 'list') return listAll(a);
  if (action === 'getReceipt') return getReceipt(a, p.id);
  if (action === 'parseReceipt') return parseReceipt(a, p.photo);
  if (action === 'uploadReceipt') return { receipt: await saveReceipt(a, p.photo, 'чек ' + String(p.date || '').slice(0, 10)) };
  if (action === 'remindPlan') {
    const plan = await remindPlan(a, new Date());
    const out = [];
    for (const m of plan) out.push({ kind: m.kind, text: m.text, to: (await remindTo(a, m.kind)).length });
    return out;
  }
  if (action === 'tareNow') return tareForecast(await listAll(a), new Date());
  if (action === 'export') {
    if (!user.isAdmin) fail('Только для админов', 403);
    return exportAll(a);
  }
  if (!WRITES.includes(action)) fail('Неизвестное действие: ' + action);

  // Номер запроса: приложение повторяет запрос, если ответ потерялся. Второй раз с тем же
  // номером ничего не пишем. Номер пишется в той же пачке, что и запись, — атомарно.
  const rid = p.rid ? String(p.rid).slice(0, 64) : null;
  if (rid && (await a.env.DB.prepare('SELECT 1 AS x FROM rids WHERE rid = ?1').bind(rid).first())) return listAll(a);

  // старое приложение шлёт фото прямо в закупку — грузим до записи
  if (action === 'addPurchase' && p.photo && !p.receipt) {
    p.receipt = await saveReceipt(a, p.photo, 'чек ' + String(p.date || '').slice(0, 10));
    delete p.photo;
  }

  const now = new Date().toISOString();
  const stmts = [];
  if (action === 'addPurchase') {
    const receipt = p.receipt ? String(p.receipt).slice(0, 200) : '';
    const prices = {};
    const moved = {};
    const upd = {};
    let prod = {};
    if ((p.prices && typeof p.prices === 'object') || (p.learn && p.learn.length)) prod = (await listAll(a)).products;
    // Цены с чека обновляют цену закупки, а в карточке видно, что и с чего на что поменялось.
    if (p.prices && typeof p.prices === 'object') {
      for (const k of Object.keys(p.prices)) {
        const np = Number(p.prices[k]);
        if (!Number.isFinite(np) || np <= 0 || !prod[k]) continue;
        const was = prod[k].cost == null ? null : Number(prod[k].cost);
        prices[k] = np;
        if (was == null || Math.abs(was - np) >= 0.005) {
          moved[k] = { was, now: np };
          (upd[k] = upd[k] || {}).cost = np;
        }
      }
    }
    // Словарь: что человек подтвердил, то и запоминаем за товаром.
    if (p.learn && p.learn.length) {
      const grouped = {};
      for (const x of p.learn) {
        if (!x || !x.id || !x.name || !prod[x.id]) continue;
        (grouped[x.id] = grouped[x.id] || []).push(x);
      }
      for (const id of Object.keys(grouped)) {
        let list = prod[id].aliases;
        if (!Array.isArray(list)) list = [];
        list = list.slice();
        for (const x of grouped[id]) {
          const name = String(x.name).slice(0, 80);
          const shop = x.shop ? String(x.shop).slice(0, 40) : '';
          const art = x.article ? String(x.article).slice(0, 40) : '';
          if (!list.some((o) => o.name === name && o.shop === shop)) list.push({ shop, name, article: art });
        }
        (upd[id] = upd[id] || {}).aliases = list.slice(-12);
      }
    }
    for (const id of Object.keys(upd)) stmts.push(patchStmt(a, 'products', id, upd[id]));
    stmts.push(insertStmt(a, 'purchases', uid('p'), {
      date: p.date || now, by: p.by || who, total: p.total, source: p.source || null, items: p.items || {},
      receipt, prices: { list: prices, moved },
    }));
  } else if (action === 'addCount') {
    stmts.push(insertStmt(a, 'counts', uid('c'), {
      date: p.date || now, by: p.by || who, cash: p.cash, card: p.card, initial: '', note: p.note || null,
      source: p.source || null, stock: p.stock || {}, frozen: p.frozen || null, amnesty: !!p.amnesty,
    }));
  } else if (action === 'addReturn') {
    stmts.push(insertStmt(a, 'returns', uid('r'), {
      date: p.date || now, by: p.by || who, amount: p.amount || 0, units: p.units || 0, toTill: !!p.toTill, note: p.note || null,
    }));
  } else if (action === 'addProduct') {
    if (!p.id) fail('Нет id товара');
    if (await exists(a, 'products', p.id)) fail('Товар ' + p.id + ' уже есть');
    stmts.push(insertStmt(a, 'products', p.id, p.data || {}));
  } else if (action === 'updateProduct') {
    if (!(await exists(a, 'products', p.id))) fail('Не нашёл ' + p.id);
    const s = patchStmt(a, 'products', p.id, p.patch || {});
    if (s) stmts.push(s);
  } else if (action === 'delete') {
    if (!COLLS.includes(p.col)) fail('Нельзя удалять из ' + p.col);
    if (!(await exists(a, p.col, p.id))) fail('Не нашёл ' + p.id);
    // удаляются мягко: строка остаётся, с пометкой кто и когда — её можно вернуть
    if (SOFT_DELETE[p.col]) stmts.push(patchStmt(a, p.col, p.id, { deleted: now, deletedBy: who || '' }));
    else stmts.push(a.env.DB.prepare(`DELETE FROM ${p.col} WHERE id = ?1`).bind(String(p.id)));
  } else if (action === 'reorder') {
    // Порядок обхода полок при подсчёте; кого нет в списке — порядок снимаем.
    if (!p.ids || !p.ids.length) fail('Пустой порядок');
    const pos = {};
    p.ids.forEach((x, i) => {
      pos[String(x)] = i + 1;
    });
    stmts.push(a.env.DB.prepare(`UPDATE products SET data = json_set(data, '$.shelf', json_extract(?1, '$."' || id || '"'))`)
      .bind(JSON.stringify(pos)));
  } else if (action === 'restore') {
    if (!SOFT_DELETE[p.col]) fail('Нельзя вернуть из ' + p.col);
    if (!(await exists(a, p.col, p.id))) fail('Не нашёл ' + p.id);
    stmts.push(patchStmt(a, p.col, p.id, { deleted: '', deletedBy: '' }));
  } else if (action === 'update') {
    const allow = EDITABLE[p.col];
    if (!allow) fail('Нельзя править ' + p.col);
    if (!(await exists(a, p.col, p.id))) fail('Не нашёл ' + p.id);
    const clean = {};
    for (const k of Object.keys(p.patch || {})) if (allow[k]) clean[k] = p.patch[k];
    if (!Object.keys(clean).length) fail('Нечего править');
    clean.edited = now;
    clean.editedBy = who || '';
    stmts.push(patchStmt(a, p.col, p.id, clean));
  }

  if (rid) stmts.unshift(a.env.DB.prepare('INSERT INTO rids (rid, at) VALUES (?1, ?2)').bind(rid, now));
  try {
    await a.env.DB.batch(stmts.filter(Boolean));
  } catch (err) {
    // тот же запрос прошёл одновременно с этим — второй раз не пишем
    if (rid && /UNIQUE|constraint/i.test(String(err && err.message))) return listAll(a);
    throw err;
  }
  a.list = null;
  return listAll(a);
}

/** Выгрузка всего как есть — для переезда и сверки. Только админам. */
async function exportAll(a) {
  const list = await listAll(a);
  const team = await readTeam(a);
  const props = {};
  for (const k of Object.keys(a.props || {})) if (!/TOKEN|KEY|SECRET/i.test(k)) props[k] = a.props[k];
  return { ...list, team, props };
}

/* ---------------- справочник из кода ---------------- */

/* Справочник товаров живёт в коде (worker/src/seed.js, собирается из apps-script/Seed.gs)
   и приезжает с новой версией сервера. Цену закупки и «распродаём» синк не трогает: цена
   приходит из чеков, а «распродаём» — решение команды. Подсчёты, закупки и сдачи тары —
   данные команды: из кода только досыпаем недостающие записи и никогда не переписываем
   (иначе новая версия откатила бы исправления, сделанные в приложении). */
let seededVersion = null;   // эта копия сервера уже сверилась — не спрашиваем базу на каждый запрос

async function ensureSeed(a) {
  if (seededVersion === String(SEED_VERSION)) return;
  await loadProps(a);
  if (prop(a, 'SEED_VERSION') === String(SEED_VERSION)) {
    seededVersion = String(SEED_VERSION);
    return;
  }
  const have = {};
  const res = await a.env.DB.batch(COLLS.map((c) => a.env.DB.prepare(`SELECT id, data FROM ${c}`)));
  COLLS.forEach((c, i) => {
    have[c] = {};
    for (const r of res[i].results) have[c][r.id] = JSON.parse(r.data);
  });
  const team = await readTeam(a);
  const stmts = [];
  for (const [id, o] of Object.entries(SEED.products || {})) {
    if (!have.products[id]) stmts.push(insertStmt(a, 'products', id, o));
    else {
      const upd = { ...o };
      delete upd.cost;
      delete upd.phaseout;
      const s = patchStmt(a, 'products', id, upd);
      if (s) stmts.push(s);
    }
  }
  for (const name of ['counts', 'purchases']) {
    for (const [id, o] of Object.entries(SEED[name] || {})) if (!have[name][id]) stmts.push(insertStmt(a, name, id, o));
  }
  for (const r of RETURNS_SEED || []) if (!have.returns[r.id]) stmts.push(insertStmt(a, 'returns', r.id, r));
  for (const [name, list] of Object.entries(SEED_RETIRE || {})) {
    if (!COLLS.includes(name)) continue;
    for (const id of list) if (have[name][id]) stmts.push(a.env.DB.prepare(`DELETE FROM ${name} WHERE id = ?1`).bind(id));
  }
  const known = new Set(team.map((r) => String(r.tg_id).trim()));
  for (const m of TEAM_SEED || []) {
    if (!known.has(String(m.id)))
      stmts.push(a.env.DB.prepare('INSERT INTO team (tg_id, name, role) VALUES (?1, ?2, ?3)').bind(String(m.id), m.name || '', m.role || 'admin'));
  }
  stmts.push(a.env.DB.prepare("INSERT INTO props (key, value) VALUES ('SEED_VERSION', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(String(SEED_VERSION)));
  await a.env.DB.batch(stmts);
  a.props.SEED_VERSION = String(SEED_VERSION);
  seededVersion = String(SEED_VERSION);
}
export function _resetSeedMemo() {
  seededVersion = null;
}

/* ---------------- Telegram ---------------- */

async function tgRaw(a, method, payload) {
  const files = Object.keys(payload).some((k) => payload[k] instanceof Blob);
  let init;
  if (files) {
    const form = new FormData();
    for (const [k, v] of Object.entries(payload)) {
      if (v == null) continue;
      if (v instanceof Blob) form.append(k, v, v.name || 'file');
      else form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    init = { method: 'POST', body: form };
  } else {
    init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${a.env.BOT_TOKEN}/${method}`, { ...init, signal: AbortSignal.timeout(30000) });
    try {
      return await r.json();
    } catch {
      return { ok: false, error_code: r.status };
    }
  } catch (err) {
    return { ok: false, description: err.message };
  }
}
async function tg(a, method, payload) {
  const j = await tgRaw(a, method, payload);
  if (!j.ok) fail('Telegram: ' + (j.description || j.error_code || '?'), 502);
  return j.result;
}

/* ---------------- фото чеков ----------------
   Храним в Telegram документом (не фотографией: sendPhoto пережимает, и мелкий шрифт
   чека становится нечитаемым) — в переписке админа с ботом копится архив чеков, а старые
   чеки открываются по тем же номерам файлов. Копия base64 лежит в KV: файл не меняется
   никогда, и тянуть его из Telegram на каждый просмотр — это секунды. */
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;

async function receiptsChat(a) {
  const c = prop(a, 'RECEIPTS_CHAT');
  if (c) return c.trim();
  const admins = idList(prop(a, 'ADMIN_IDS'));
  if (admins.length) return admins[0];
  const team = (await readTeam(a)).filter((r) => String(r.role || '').toLowerCase() === 'admin' && String(r.tg_id || '').trim());
  if (team.length) return String(team[0].tg_id).trim();
  fail('Некуда сохранить чек: в листе team нет ни одного админа');
}

function b64ToBytes(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function saveReceipt(a, photo, caption) {
  if (!photo) return '';
  const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(String(photo));
  if (!m) fail('Фото чека в непонятном виде');
  const mime = m[1];
  if (mime.indexOf('image/') !== 0) fail('Чек должен быть картинкой');
  let bytes;
  try {
    bytes = b64ToBytes(m[2]);
  } catch {
    fail('Фото чека в непонятном виде');
  }
  if (bytes.length > MAX_RECEIPT_BYTES) fail('Фото чека слишком большое');
  const ext = mime.split('/')[1].replace('jpeg', 'jpg');
  const name = 'чек.' + ext;
  const file = new File([bytes], name, { type: mime });
  const res = await tg(a, 'sendDocument', { chat_id: await receiptsChat(a), caption: String(caption || '').slice(0, 900), document: file });
  if (!res || !res.document || !res.document.file_id) fail('Telegram не вернул файл', 502);
  // что только что загрузили, то первым и откроют — кладём в KV сразу
  await a.env.RECEIPTS.put('rc:' + res.document.file_id, m[2], { metadata: { mime, name } });
  return res.document.file_id;
}

async function getReceipt(a, id) {
  const list = await listAll(a);
  const buy = list.purchases[id];
  if (!buy) fail('Закупка не найдена', 404);
  const fileId = buy.receipt;
  if (!fileId) fail('У этой закупки нет фото чека', 404);
  const hit = await a.env.RECEIPTS.getWithMetadata('rc:' + fileId, 'text');
  if (hit && hit.value) return { mime: (hit.metadata && hit.metadata.mime) || 'image/jpeg', data: hit.value, name: (hit.metadata && hit.metadata.name) || '' };
  const f = await tg(a, 'getFile', { file_id: String(fileId) });
  const r = await fetch(`https://api.telegram.org/file/bot${a.env.BOT_TOKEN}/${f.file_path}`, { signal: AbortSignal.timeout(30000) });
  if (r.status !== 200) fail('Не вышло забрать фото чека', 502);
  const bytes = new Uint8Array(await r.arrayBuffer());
  // Telegram отдаёт файл без типа — определяем по расширению
  const name = String(f.file_path || 'чек').split('/').pop();
  const ext = (name.split('.').pop() || '').toLowerCase();
  const byExt = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' };
  let mime = byExt[ext] || r.headers.get('content-type') || '';
  if (mime.indexOf('image/') !== 0) mime = 'image/jpeg';
  const data = bytesToB64(bytes);
  await a.env.RECEIPTS.put('rc:' + fileId, data, { metadata: { mime, name } });
  return { mime, data, name };
}

/* ---------------- разбор чека ----------------
   Модели отдаём фото и справочник и просим строго JSON. Ничего не пишем: записывает
   addPurchase, после того как человек подтвердил разбор. Модель ошибается. */
export const MODEL = 'claude-sonnet-5';
const DEPOSIT_UNIT = 0.15;

export function receiptPrompt(catalogue) {
  return [
    'Разбери чек из магазина для складского учёта бара.',
    'Ответ — СТРОГО JSON, без пояснений и без markdown:',
    '{"shop":"магазин","date":"YYYY-MM-DD","total":итог чека,',
    ' "lines":[{"name":"как напечатано","article":"номер товара или null",',
    '  "qty":штук всего,"sum":итог этой строки С НДС,',
    '  "deposit":итог залоговой строки этого товара с НДС или null,',
    '  "match":"id из справочника или null","why":"почему так сопоставил"}]}',
    '',
    'Цену за штуку НЕ считай — её посчитаем мы. Дай qty, sum и deposit.',
    '',
    '── ЗАЛОГ. Самое важное.',
    'Строки залога за тару — это НЕ товар, их в lines быть не должно вообще.',
    'Узнаются так: цена ровно 0,15 за штуку; в названии PLZ 6x / 12x / 24x, PETZ,',
    'obal, záloha; номер короткий (6 цифр) и часто помечен плюсом слева.',
    'Название залоговой строки может повторять чужую марку (HEINEKEN PLZ 6x рядом',
    'с Zlatý Bažant) — это всё равно залог, а не пиво Heineken. Просто пропусти.',
    '',
    '── КОЛИЧЕСТВО И ЦЕНА.',
    'В чеке бывает две цены: без НДС и с НДС. Нам нужна ТОЛЬКО с НДС —',
    'обычно это последняя денежная колонка строки (CELKOM S DPH).',
    'Количество бывает как «штук в упаковке» × «сколько упаковок». Перемножь.',
    'Пример строки Metro: «HELL 250ml PLZ | 0,530 | 24 | 12,72 | 3 | 38,16 | 46,95»',
    'читается так: 0,530 — за штуку без НДС; 24 — штук в упаковке; 12,72 — упаковка',
    'без НДС; 3 — упаковок; 38,16 — всего без НДС; 46,95 — всего С НДС.',
    'Значит qty = 24 × 3 = 72, unit = 46,95 / 72 = 0,652.',
    'sum — последняя денежная колонка строки (с НДС), не путай с колонкой без НДС.',
    'КОЛОНКА «СКОЛЬКО УПАКОВОК» — главный источник ошибок: обычно 1, но бывает 3.',
    'Проверяй её отдельно для каждой строки.',
    '',
    '── ЗАЛОГ КАК ПОДСКАЗКА. У каждой залоговой строки есть свой товар выше.',
    'В поле deposit положи ИТОГ этой залоговой строки. По нему мы сами проверим',
    'количество: залог 2,70 при 0,15 за штуку — значит товара 18 штук.',
    'Если у товара залога нет (снеки, чай) — deposit: null.',
    '',
    '── СКИДКИ. Строки вида «KUP VIAC, PLAT MENEJ» с отрицательной суммой относятся',
    'к позиции выше: вычти их из её итога с НДС перед делением.',
    '',
    '── СОПОСТАВЛЕНИЕ. match — только id из справочника, и только если уверен.',
    'Разные вкусы одного товара — один id, если в справочнике он один.',
    'Не уверен — ставь null, это нормально, человек поправит.',
    '',
    '── ПРОВЕРЬ СЕБЯ перед ответом:',
    '1. Ни одной строки с unit ровно 0,15 в lines быть не должно — это залоги.',
    '2. Сумма (qty × unit) по всем строкам плюс все залоги должна примерно сойтись',
    '   с итогом чека. Не сходится — ищи, где взял не ту колонку, и пересчитай.',
    '3. Если чек нечитаем или это не чек — верни {"error":"почему"}.',
    '',
    'Справочник (id — название — объём):',
    catalogue,
  ].join('\n');
}

async function parseReceipt(a, photo) {
  const key = a.env.ANTHROPIC_KEY;
  if (!key) fail('Не задан ключ модели — разбор чека выключен', 503);
  const m = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(String(photo || ''));
  if (!m) fail('Фото чека в непонятном виде');

  const all = asRows((await listAll(a)).products);
  const cat = all
    .filter((p) => !p.hidden)
    .map((p) => {
      let line = p.id + ' — ' + p.name + (p.vol ? ' — ' + p.vol : '');
      // как товар писали в прошлых чеках — по этому его узнать надёжнее
      const al = p.aliases;
      if (Array.isArray(al) && al.length)
        line += '\n    в чеках: ' + al.slice(-8).map((x) => (x.shop ? x.shop + ': ' : '') + x.name + (x.article ? ' [' + x.article + ']' : '')).join(' | ');
      return line;
    })
    .join('\n');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      // рассуждение здесь только вредит: модель тратила на него весь запас
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
        { type: 'text', text: receiptPrompt(cat) },
      ] }],
    }),
    signal: AbortSignal.timeout(120000),
  });
  const raw = await r.text();
  if (r.status !== 200) fail('Модель ответила ' + r.status + ': ' + raw.slice(0, 200), 502);
  const out = JSON.parse(raw);
  let text = (out.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('').trim();
  if (!text) fail('Модель не вернула ответ (stop_reason: ' + (out.stop_reason || '?') + ')', 502);
  // модель любит написать пару фраз перед JSON — берём то, что между скобками
  const i = text.indexOf('{');
  const j = text.lastIndexOf('}');
  if (i >= 0 && j > i) text = text.slice(i, j + 1);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    fail('Модель ответила не по схеме. Текст: [' + text.slice(0, 200) + ']', 502);
  }
  if (data.error) fail(String(data.error));
  if (!data.lines || !data.lines.length) fail('Модель не нашла в чеке ни одной позиции');
  return cleanParsed(data, all, out.usage || null);
}

/** Чистка ответа модели: чужие id, залоги и мусорные числа до интерфейса не доходят. */
export function cleanParsed(data, products, usage) {
  const known = {};
  for (const p of products) known[p.id] = true;
  // залог модель иногда всё равно приносит как товар: ровно 0,15 за штуку и «… PLZ 24x»
  const DEPOSIT_NAME = /(PLZ|PETZ)\s*\d+\s*x|z[aá]loha|obal/i;
  const isDeposit = (l) => {
    const q = Number(l.qty);
    const sm = Number(l.sum);
    let u = Number(l.unit);
    if (!Number.isFinite(u) && Number.isFinite(sm) && q > 0) u = sm / q;
    return Number.isFinite(u) && Math.abs(u - DEPOSIT_UNIT) < 0.005 && DEPOSIT_NAME.test(String(l.name || ''));
  };
  data.skipped = (data.lines || []).filter(isDeposit).length;
  data.lines = (data.lines || []).filter((l) => l && l.name && !isDeposit(l)).map((l) => {
    let qty = Math.round(Number(l.qty) || 0);
    const sum = Number(l.sum);
    const dep = Number(l.deposit);
    let note = l.why ? String(l.why).slice(0, 120) : '';
    // количество по залогу — самая надёжная цифра в чеке
    if (Number.isFinite(dep) && dep > 0) {
      const byDep = Math.round(dep / DEPOSIT_UNIT);
      if (byDep > 0 && byDep !== qty) {
        note = 'количество исправлено по залогу: ' + qty + ' → ' + byDep;
        qty = byDep;
      }
    }
    const unit = Number.isFinite(sum) && sum > 0 && qty > 0 ? Math.round((sum / qty) * 1000) / 1000 : null;
    return {
      name: String(l.name).slice(0, 80),
      article: l.article ? String(l.article).slice(0, 40) : null,
      qty: qty > 0 ? qty : 0,
      sum: Number.isFinite(sum) && sum > 0 ? Math.round(sum * 100) / 100 : null,
      unit,
      match: l.match && known[l.match] ? l.match : null,
      why: note,
    };
  });
  // сверка: сумма позиций плюс залоги должна сойтись с итогом чека
  let sum = 0;
  for (const l of data.lines) {
    if (l.sum) sum += l.sum;
    else if (l.qty && l.unit) sum += l.qty * l.unit;
  }
  const total = Number(data.total);
  data.check = {
    sum: Math.round(sum * 100) / 100,
    total: Number.isFinite(total) ? total : null,
    // залог в итог чека входит, в наши цены — нет, поэтому точного равенства не ждём
    fits: Number.isFinite(total) ? total - sum >= -0.5 && total - sum <= total * 0.45 : null,
  };
  data.usage = usage;
  return data;
}

/* ---------------- напоминания ----------------
   Подсчёт — по сроку от прошлого подсчёта. Тара — по ПРОГНОЗУ (в тексте «примерно»):
   на подсчёте человек и так видит, сколько пустой тары. Прогноз считается ровно как
   в приложении (M.tare.unitsWaiting); дымовой тест сверяет их. Кому — REMIND_COUNT_TO /
   REMIND_TARE_TO, иначе REMIND_CHAT, иначе вся команда. Каждое — раз на своё состояние. */
const REMIND = { countDays: 14, countAgain: 21, tareEur: 10 };
const TIME_ZONE = 'Europe/Bratislava';

const notDeleted = (list) => list.filter((r) => !r.deleted);
const daysWord = (n) => {
  const m = Math.abs(n) % 100;
  const k = m % 10;
  return m > 10 && m < 20 ? 'дней' : k === 1 ? 'день' : k > 1 && k < 5 ? 'дня' : 'дней';
};
const lastBy = (list) => list.slice().sort((x, y) => (x.date < y.date ? -1 : 1)).pop() || null;

export function tareForecast(list, now) {
  now = now || new Date();
  const counts = notDeleted(asRows(list.counts)).sort((x, y) => (x.date < y.date ? -1 : 1));
  const buys = notDeleted(asRows(list.purchases));
  const rets = notDeleted(asRows(list.returns));
  const prods = asRows(list.products);
  const lastRet = (lastBy(rets) || {}).date || null;
  const last = counts.length ? counts[counts.length - 1] : null;
  const from = lastRet && (!last || lastRet > last.date) ? lastRet : last ? last.date : null;
  const dGrow = from ? Math.max(0, (now - new Date(from)) / 864e5) : 0;
  const boughtIn = (id, x, y) => {
    let n = 0;
    for (const b of buys) if (b.date > x && b.date <= y) n += Number((b.items || {})[id]) || 0;
    return n;
  };
  let units = 0;
  for (const p of prods) {
    if (!(Number(p.dep) > 0)) continue;
    let tot = 0;
    let dd = 0;
    for (let i = 1; i < counts.length; i++) {
      const x = counts[i - 1];
      const y = counts[i];
      const A = (x.stock || {})[p.id];
      const B = (y.stock || {})[p.id];
      if (A == null || B == null) continue;
      const bt = boughtIn(p.id, x.date, y.date);
      const c = Number(A) + bt - Number(B);
      const days = (new Date(y.date) - new Date(x.date)) / 864e5;
      if ((bt > 0 || c > 0) && days >= 1) {
        tot += c;
        dd += days;
      }
      const cc = Math.max(0, c);
      if (!cc) continue;
      if (!lastRet) {
        units += cc;
        continue;
      }
      if (y.date <= lastRet) continue;
      const share = x.date >= lastRet ? 1 : Math.max(0, Math.min(1, (new Date(y.date) - new Date(lastRet)) / 864e5 / (days || 1)));
      units += cc * share;
    }
    const rate = dd > 0 ? Math.max(0, tot / dd) : 0;
    if (rate) units += rate * dGrow;
  }
  const n = Math.max(0, Math.round(units));
  return { units: n, eur: Math.round(n * DEPOSIT_UNIT * 100) / 100, lastRet };
}

/** Что сейчас стоит отправить — без отправки, чтобы можно было посмотреть заранее. */
async function remindPlan(a, now) {
  const list = await listAll(a);
  await loadProps(a);
  const plan = [];
  const last = lastBy(notDeleted(asRows(list.counts)));
  if (last) {
    const d = Math.floor((now - new Date(last.date)) / 864e5);
    const dd = last.date.slice(8, 10) + '.' + last.date.slice(5, 7);
    if (d >= REMIND.countAgain && prop(a, 'REMIND_COUNT2') !== last.id)
      plan.push({ kind: 'count2', key: 'REMIND_COUNT2', val: last.id,
        text: 'Подсчёт не делали уже ' + d + ' ' + daysWord(d) + ' — с ' + dd + '. Без него недобор и закупка считаются вслепую.' });
    // после 21 дня только строгое: иначе назавтра пришло бы ещё и мягкое «пора считать»
    else if (d >= REMIND.countDays && d < REMIND.countAgain && prop(a, 'REMIND_COUNT') !== last.id)
      plan.push({ kind: 'count', key: 'REMIND_COUNT', val: last.id,
        text: 'Пора считать склад: прошлый подсчёт был ' + dd + ', прошло ' + d + ' ' + daysWord(d) + '.' });
  }
  // тара: один раз на каждую сдачу — сдали, и счёт пошёл заново
  const t = tareForecast(list, now);
  const tkey = t.lastRet || '-';
  if (t.eur >= REMIND.tareEur && prop(a, 'REMIND_TARE') !== tkey)
    plan.push({ kind: 'tare', key: 'REMIND_TARE', val: tkey,
      text: 'Тары, по прогнозу, накопилось примерно на ' + t.eur.toFixed(2).replace('.', ',') + ' € — около ' + t.units +
        ' бутылок и банок с последней сдачи. Самое время отвезти.' });
  return plan;
}

async function remindTo(a, kind) {
  const own = prop(a, kind === 'tare' ? 'REMIND_TARE_TO' : 'REMIND_COUNT_TO');
  if (own) return idList(own);
  const c = prop(a, 'REMIND_CHAT');
  if (c) return [c.trim()];
  return (await readTeam(a)).map((r) => String(r.tg_id || '').trim()).filter(Boolean);
}

/** Час по Братиславе: напоминания уходят в 10 утра, как раньше из Apps Script. */
export function localHour(now) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', hourCycle: 'h23' }).format(now));
}

export async function remindTick(a, now) {
  await loadProps(a, true);
  // Включаются одним переключателем при переезде: до него шлёт старый сервер,
  // и двух одинаковых напоминаний быть не должно.
  if (prop(a, 'REMINDERS_ON') !== 'yes') return { sent: 0, off: true };
  const plan = await remindPlan(a, now);
  if (!plan.length) return { sent: 0 };
  let url = null;
  const menu = await tgRaw(a, 'getChatMenuButton', {});
  if (menu.ok && menu.result && menu.result.web_app) url = menu.result.web_app.url;   // свежий адрес, с версией
  let sent = 0;
  for (const m of plan) {
    for (const chat of await remindTo(a, m.kind)) {
      const r = await tgRaw(a, 'sendMessage', {
        chat_id: chat,
        text: m.text,
        reply_markup: url ? { inline_keyboard: [[{ text: 'Открыть бар', web_app: { url } }]] } : undefined,
      });
      if (r.ok) sent++;   // кто не нажимал «Старт» или заблокировал бота — пропускаем
    }
    await setProp(a, m.key, m.val);   // запомнили: это состояние уже напоминали
  }
  return { sent, kinds: plan.map((m) => m.kind) };
}

async function hourly(a, now) {
  try {
    await loadProps(a, true);
    if (localHour(now) === Number(prop(a, 'REMIND_HOUR') || 10)) await remindTick(a, now);
  } catch (err) {
    console.error('remindTick', err && err.stack ? err.stack : err);
  }
  try {
    // защита от дубля нужна минуты, а не вечно
    const weekAgo = new Date(now.getTime() - 7 * 864e5).toISOString();
    await a.env.DB.prepare('DELETE FROM rids WHERE at < ?1').bind(weekAgo).run();
  } catch (err) {
    console.error('rids', err && err.stack ? err.stack : err);
  }
}

/* ---------------- проверка живости ---------------- */

async function health(a) {
  const list = await listAll(a);
  await loadProps(a);
  const n = (o) => Object.keys(o).length;
  const team = await readTeam(a);
  return {
    alive: true,
    synced: false,
    version: a.env.VERSION || 'dev',
    ts: new Date().toISOString(),
    status: {
      products: n(list.products),
      counts: n(list.counts),
      purchases: n(list.purchases),
      returns: n(list.returns),
      team: team.length,
      seed: prop(a, 'SEED_VERSION') || null,
      reminders: prop(a, 'REMINDERS_ON') === 'yes',
      bot: Boolean(a.env.BOT_TOKEN),
      recognize: Boolean(a.env.ANTHROPIC_KEY),
    },
  };
}

/**
 * Автотесты серверных функций склада бара (apps-script/Code.gs + Seed.gs).
 * Запуск: node tools/tests/server/run.mjs
 */
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { newApp } from './gas-mock.mjs';

/* Версия сида читается из Seed.gs, а не зашивается числом: иначе каждый её
   подъём красит тесты, хотя ломаться нечему. */
const SEEDV = String(newApp({}).api.SEED_VERSION);

/* ---------------- мини-фреймворк ---------------- */

let passed = 0, failed = 0;
const failures = [];
const notes = [];
const metrics = {};
let group = '';

function G(name) { group = name; console.log('\n── ' + name); }
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ОК      ' + name);
  } catch (e) {
    failed++;
    failures.push({ group, name, err: e });
    console.log('  ПРОВАЛ  ' + name);
    const msg = String(e && e.message || e).split('\n').slice(0, 8).join('\n');
    console.log('          ' + msg.replace(/\n/g, '\n          '));
  }
}
function note(s) { notes.push(s); }
function throws(fn, re, msg) {
  let got = null;
  try { fn() } catch (e) { got = e }
  assert.ok(got, (msg || '') + ' — ожидалось исключение, его не было');
  if (re) assert.match(String(got.message || got), re, (msg || '') + ' — текст ошибки');
  return got;
}

/* ---------------- утилиты по листам ---------------- */

const head = (dump) => dump[0].slice();
const body = (dump) => dump.slice(1).filter(r => r.some(v => v !== '' && v !== null && v !== undefined));
function objs(dump, key) {
  const h = head(dump);
  const k = key || (h.indexOf('id') >= 0 ? 'id' : 'tg_id');
  const out = {};
  body(dump).forEach(r => {
    const o = {};
    h.forEach((c, i) => { if (c) o[c] = r[i]; });
    out[String(o[k])] = o;
  });
  return out;
}
function rowsWithId(dump, id) {
  const h = head(dump), c = h.indexOf('id');
  return dump.slice(1).filter(r => String(r[c]) === String(id));
}
/** строка листа по фактической шапке */
function mkRow(h, vals) { return h.map(c => (c in vals ? vals[c] : '')); }

/** книга «как после настоящего setup + первый синк» */
function bootedBook() {
  const { env, api } = newApp({ props: {} });
  api.setup();
  api.syncProducts();
  const sheets = {};
  Object.keys(env.book.sheets).forEach(n => { sheets[n] = env.book.sheets[n].dump(); });
  return sheets;
}

/* ---------------- Telegram initData ---------------- */

function initData(token, fields, opts = {}) {
  const keys = Object.keys(fields);
  const dcs = keys.map(k => k + '=' + fields[k]).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  let hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (opts.corrupt) hash = hash.slice(0, -1) + (hash.slice(-1) === 'a' ? 'b' : 'a');
  const qs = keys.map(k => k + '=' + encodeURIComponent(fields[k]));
  if (!opts.noHash) qs.push('hash=' + hash);
  return qs.join('&');
}
const USER = { id: 1285269855, first_name: 'Миша', username: 'misha' };
function tgFields(extra = {}) {
  return Object.assign({
    auth_date: String(Math.floor(Date.now() / 1000)),
    chat_instance: '-1234567890',
    chat_type: 'private',
    query_id: 'AAE',
    user: JSON.stringify(USER)
  }, extra);
}

/* =================================================================== */
/* 1. syncProducts                                                      */
/* =================================================================== */

G('1. syncProducts()');

test('совпал SEED_VERSION — ни одного обращения к листу', () => {
  const sheets = bootedBook();
  const { env, api } = newApp({ sheets, props: { SEED_VERSION: SEEDV } });
  assert.ok(/^\d+$/.test(SEEDV) && +SEEDV > 0, 'версия сида в Seed.gs — целое число, а не ' + SEEDV);
  env.stats.reset();
  api.syncProducts();
  assert.equal(env.stats.total, 0,
    'ожидалось 0 обращений, было ' + env.stats.total + ': ' + env.stats.log.slice(0, 10).join(', '));
});

test('новая версия — дубли по id схлопываются в одну строку', () => {
  const h = ['id', 'name', 'vol', 'cat', 'shape', 'color', 'cap', 'cost', 'dep', 'pack', 'min', 'order', 'note', 'hidden', 'phaseout'];
  const products = [h,
    mkRow(h, { id: 'aro05', name: 'первый дубль', cost: 9 }),
    mkRow(h, { id: 'aro05', name: 'второй дубль', cost: 8 }),
    mkRow(h, { id: 'aro05', name: 'третий дубль', cost: 7 }),
    mkRow(h, { id: 'my_own', name: 'товар из приложения', cost: 3 })
  ];
  const { env, api } = newApp({ sheets: { products }, props: { SEED_VERSION: '1' } });
  api.syncProducts();
  const d = env.dump('products');
  assert.equal(rowsWithId(d, 'aro05').length, 1, 'строк с id aro05 после синка');
  const o = objs(d);
  assert.equal(o.aro05.name, api.SEED.products.aro05.name, 'имя перезаписано из SEED');
  // имя и категорию сид поправляет, а цену — нет: она приходит из чеков
  assert.equal(o.aro05.cost, 9, 'цена из листа сохранена, а не откачена к сидовой');
  assert.ok(o.my_own, 'чужой товар, заведённый в приложении, не удалён');
  assert.equal(o.my_own.name, 'товар из приложения');
  assert.equal(Object.keys(o).length, Object.keys(api.SEED.products).length + 1,
    'всего строк = SEED + один свой');
});

test('хвост подчищается: лишние строки очищены', () => {
  const h = ['id', 'name', 'vol', 'cat', 'shape', 'color', 'cap', 'cost', 'dep', 'pack', 'min', 'order', 'note', 'hidden', 'phaseout'];
  const ids = Object.keys(newApp({}).api.SEED.products);
  const products = [h];
  ids.forEach(id => products.push(mkRow(h, { id, name: 'дубль A ' + id })));
  ids.forEach(id => products.push(mkRow(h, { id, name: 'дубль B ' + id })));
  const before = products.length - 1;
  const { env, api } = newApp({ sheets: { products }, props: { SEED_VERSION: '1' } });
  api.syncProducts();
  const d = env.dump('products');
  assert.equal(before, ids.length * 2, 'подготовка: в листе было вдвое больше строк');
  assert.equal(body(d).length, ids.length, 'осталось ровно ' + ids.length + ' непустых строк');
  const tail = d.slice(1 + ids.length);
  tail.forEach((r, i) => assert.ok(r.every(v => v === '' || v === undefined),
    'строка ' + (i + 2 + ids.length) + ' должна быть пустой, а там: ' + JSON.stringify(r)));
  assert.equal(env.sheet('products').getLastRow(), ids.length + 1, 'getLastRow после подчистки хвоста');
});

test('цена из чека не откатывается синком, у новой строки берётся из SEED', () => {
  // Сид знает только стартовую цену. Если синк её перезапишет, подъём версии
  // молча откатит всё, что принесли чеки, — и недобор посчитается по старым деньгам.
  const h = ['id','name','vol','cat','shape','color','cap','cost','dep','pack','min','order','note','hidden','phaseout'];
  const SEED = newApp({}).api.SEED.products;
  const seeded = SEED.aro05.cost;
  // берём новый товар, у которого в сиде цена есть — иначе проверять нечего
  const fresh = Object.keys(SEED).find(k => k !== 'aro05' && typeof SEED[k].cost === 'number');
  const products = [h, mkRow(h, { id: 'aro05', name: 'x', cost: 9.99 })];
  const { env, api } = newApp({ sheets: { products }, props: { SEED_VERSION: '1' } });
  api.syncProducts();
  const o = objs(env.dump('products'));
  assert.equal(o.aro05.cost, 9.99, 'цена, принесённая чеком, осталась');
  assert.equal(o[fresh].cost, SEED[fresh].cost, 'у новой строки цена из SEED (' + fresh + ')');
  assert.notEqual(9.99, seeded, 'подготовка: в SEED цена другая, иначе тест ничего не проверяет');
});

test('phaseout существующей строки не перезаписывается, у новой ставится из SEED', () => {
  const h = ['id', 'name', 'vol', 'cat', 'shape', 'color', 'cap', 'cost', 'dep', 'pack', 'min', 'order', 'note', 'hidden', 'phaseout'];
  const app0 = newApp({}).api;
  assert.equal(app0.SEED.products.aro05.phaseout, false, 'подготовка: в SEED aro05 не распродаётся');
  assert.equal(app0.SEED.products.chivas12.phaseout, true, 'подготовка: в SEED chivas12 распродаётся');
  const products = [h,
    // команда включила «распродаём» в приложении, в SEED — false
    mkRow(h, { id: 'aro05', name: 'x', phaseout: true }),
    // команда выключила «распродаём», в SEED — true
    mkRow(h, { id: 'chivas12', name: 'y', phaseout: false })
    // dimple (в SEED phaseout=true) в листе нет — приедет новой строкой
  ];
  const { env, api } = newApp({ sheets: { products }, props: { SEED_VERSION: '1' } });
  api.syncProducts();
  const o = objs(env.dump('products'));
  assert.equal(o.aro05.phaseout, true, 'включённый в приложении phaseout синк не сбросил');
  assert.equal(o.chivas12.phaseout, false, 'выключенный в приложении phaseout синк не поднял');
  assert.equal(o.dimple.phaseout, true, 'у новой строки phaseout взят из SEED');
  assert.equal(o.aro05.vol, api.SEED.products.aro05.vol, 'остальные поля всё же обновились');
});

test('чужой порядок колонок и посторонняя колонка', () => {
  const h = ['phaseout', 'hidden', 'note', 'comment', 'order', 'min', 'pack', 'dep', 'cost', 'cap', 'color', 'shape', 'cat', 'vol', 'name', 'id'];
  const products = [h,
    mkRow(h, { id: 'aro05', name: 'старое имя', cost: 99, comment: 'мой коммент', phaseout: true })
  ];
  const { env, api } = newApp({ sheets: { products }, props: { SEED_VERSION: '1' } });
  api.syncProducts();
  const d = env.dump('products');
  assert.deepEqual(head(d).slice(0, h.length), h, 'прежние колонки на месте и в том же порядке');
  assert.ok(head(d).indexOf('aliases') >= h.length, 'недостающая колонка дописана в конец, а не воткнута в середину');
  const o = objs(d);
  assert.equal(o.aro05.name, api.SEED.products.aro05.name, 'name лёг в свою колонку');
  assert.equal(o.aro05.cost, 99, 'cost остался тем, что в листе: его приносят чеки, а не сид');
  assert.equal(o.aro05.vol, api.SEED.products.aro05.vol, 'vol лёг в свою колонку');
  assert.equal(o.aro05.comment, 'мой коммент', 'посторонняя колонка не затёрта');
  assert.equal(o.aro05.phaseout, true, 'phaseout сохранён');
  assert.equal(o.dimple.name, api.SEED.products.dimple.name, 'новые строки тоже разложены по шапке');
  assert.equal(o.dimple.comment, '', 'у новой строки посторонняя колонка пустая');
});

test('недостающая колонка дописывается в шапку и заполняется', () => {
  // лист со старой схемой: колонки phaseout ещё нет
  const h = ['id', 'name', 'vol', 'cat', 'shape', 'color', 'cap', 'cost', 'dep', 'pack', 'min', 'order', 'note', 'hidden'];
  const products = [h, mkRow(h, { id: 'aro05', name: 'старое', cost: 1 })];
  const { env, api } = newApp({ sheets: { products }, props: { SEED_VERSION: '1' } });
  api.syncProducts();
  const d = env.dump('products');
  assert.ok(head(d).indexOf('phaseout') >= 0, 'колонка phaseout дописана в шапку');
  const o = objs(d);
  assert.equal(o.aro05.name, api.SEED.products.aro05.name, 'данные не съехали');
  assert.equal(o.dimple.phaseout, true, 'новая колонка заполнена у новых строк');
  assert.equal(Object.keys(o).length, Object.keys(api.SEED.products).length);
});

test('производительность: обращений к листу на один синк — единицы', () => {
  const sheets = bootedBook();
  const { env, api } = newApp({ sheets, props: { SEED_VERSION: '12' } });
  env.stats.reset();
  api.syncProducts();
  const prod = env.stats.dataOpsOf('products');
  const all = env.stats.dataOps;
  metrics.syncProductsSheetOps = prod;
  metrics.syncTotalOps = all;
  metrics.syncBySheet = {};
  Object.keys(env.stats.bySheet).forEach(n => { metrics.syncBySheet[n] = env.stats.dataOpsOf(n); });
  const s = env.stats;
  metrics.syncKinds = { getValues: s.getValues, setValues: s.setValues, setValue: s.setValue,
                        appendRow: s.appendRow, clearContent: s.clearContent, deleteRow: s.deleteRow };
  note('syncProducts: обращений к листу products = ' + prod +
       ', по всему синку = ' + all +
       ' (' + Object.keys(metrics.syncBySheet).map(n => n + ':' + metrics.syncBySheet[n]).join(', ') + ')');
  note('  по видам: ' + Object.keys(metrics.syncKinds).map(k => k + ':' + metrics.syncKinds[k]).join(', '));
  assert.ok(prod <= 10, 'на 51 товар по листу products должно быть <=10 обращений, а их ' + prod);
  assert.ok(all < 100, 'весь синк должен укладываться в десятки обращений, а их ' + all);
});

/* =================================================================== */
/* 2. syncSeeded / seedReturns                                          */
/* =================================================================== */

G('2. syncSeeded(name) и seedReturns()');

test('syncSeeded: существующую строку патчит, новую вставляет', () => {
  const h = ['id', 'date', 'by', 'cash', 'card', 'initial', 'note', 'source', 'stock', 'frozen', 'amnesty'];
  const counts = [h,
    mkRow(h, { id: 'c-2026-07-22', by: 'кто-то', note: 'старая заметка', cash: 777, stock: '{}' }),
    mkRow(h, { id: 'c-1712345678-zz', by: 'Маша', note: 'подсчёт из приложения', cash: 10, stock: '{"aro05":3}' })
  ];
  const { env, api } = newApp({ sheets: { counts }, props: {} });
  api.syncSeeded('counts');
  const o = objs(env.dump('counts'));
  const seed = api.SEED.counts['c-2026-07-22'];
  assert.equal(o['c-2026-07-22'].note, seed.note, 'опорный подсчёт обновлён из SEED');
  assert.equal(o['c-2026-07-22'].by, seed.by, 'поле by обновлено');
  assert.ok(o['c-2026-09-20'], 'второй опорный подсчёт вставлен новой строкой');
  assert.equal(rowsWithId(env.dump('counts'), 'c-2026-07-22').length, 1, 'не задвоился');
  assert.ok(o['c-1712345678-zz'], 'строка из приложения на месте');
  assert.equal(o['c-1712345678-zz'].note, 'подсчёт из приложения', 'строка из приложения не тронута');
  assert.equal(o['c-1712345678-zz'].cash, 10);
});

test('syncSeeded: повторный вызов ничего не задваивает', () => {
  const { env, api } = newApp({ sheets: {}, props: {} });
  api.syncSeeded('purchases');
  api.syncSeeded('purchases');
  const d = env.dump('purchases');
  assert.equal(body(d).length, Object.keys(api.SEED.purchases).length, 'строк ровно как в SEED');
});

test('seedReturns: патчит существующую, вставляет новую, чужие не трогает', () => {
  const h = ['id', 'date', 'by', 'amount', 'units', 'toTill', 'note'];
  const returns = [h,
    mkRow(h, { id: 'r-start-2026-05-20', by: 'X', amount: 1, units: 1, note: 'старое' }),
    mkRow(h, { id: 'r-app-1', by: 'Даша', amount: 5, units: 33, note: 'сдача из приложения' })
  ];
  const { env, api } = newApp({ sheets: { returns }, props: {} });
  api.seedReturns();
  const o = objs(env.dump('returns'));
  const seed = api.RETURNS_SEED.find(r => r.id === 'r-start-2026-05-20');
  assert.equal(o['r-start-2026-05-20'].amount, seed.amount, 'сумма обновлена из RETURNS_SEED');
  assert.equal(o['r-start-2026-05-20'].units, seed.units, 'штуки обновлены');
  assert.equal(o['r-start-2026-05-20'].note, seed.note, 'заметка обновлена');
  assert.ok(o['r-2026-09-19'], 'вторая сдача вставлена');
  assert.equal(o['r-app-1'].amount, 5, 'сдача из приложения не тронута');
  assert.equal(o['r-app-1'].note, 'сдача из приложения');
  api.seedReturns();
  assert.equal(body(env.dump('returns')).length, 3, 'повторный вызов не задваивает');
});

/* =================================================================== */
/* 3. retireSeeded                                                      */
/* =================================================================== */

G('3. retireSeeded()');

test('удаляет только id из SEED_RETIRE и только из указанного листа', () => {
  const app0 = newApp({}).api;
  const retire = app0.SEED_RETIRE.returns;
  assert.ok(retire.length >= 2, 'подготовка: в SEED_RETIRE.returns есть записи');
  const hr = ['id', 'date', 'by', 'amount', 'units', 'toTill', 'note'];
  const hc = ['id', 'date', 'by', 'cash', 'card', 'initial', 'note', 'source', 'stock', 'frozen', 'amnesty'];
  const returns = [hr,
    mkRow(hr, { id: retire[0], amount: 17.6, note: 'отменённая' }),
    mkRow(hr, { id: 'r-keep', amount: 1, note: 'живая' }),
    mkRow(hr, { id: retire[1], amount: 2, note: 'вторая отменённая' })
  ];
  const counts = [hc,
    // тот же id, но в другом листе — трогать нельзя
    mkRow(hc, { id: retire[0], note: 'подсчёт с тем же id', cash: 5 })
  ];
  const { env, api } = newApp({ sheets: { returns, counts }, props: {} });
  api.retireSeeded();
  const or = objs(env.dump('returns'));
  assert.ok(!or[retire[0]], retire[0] + ' удалён из returns');
  assert.ok(!or[retire[1]], retire[1] + ' удалён из returns');
  assert.ok(or['r-keep'], 'r-keep на месте');
  assert.equal(Object.keys(or).length, 1, 'в returns осталась одна строка');
  const oc = objs(env.dump('counts'));
  assert.ok(oc[retire[0]], 'строка с тем же id в counts не тронута');
  assert.equal(oc[retire[0]].note, 'подсчёт с тем же id');
});

test('отсутствующий id не роняет', () => {
  const hr = ['id', 'date', 'by', 'amount', 'units', 'toTill', 'note'];
  const returns = [hr, mkRow(hr, { id: 'r-keep', amount: 1 })];
  const { env, api } = newApp({ sheets: { returns }, props: {} });
  api.retireSeeded();
  assert.equal(body(env.dump('returns')).length, 1, 'единственная строка на месте');
  const { env: e2, api: a2 } = newApp({ sheets: {}, props: {} });
  a2.retireSeeded();   // вообще пустая книга
  assert.ok(true);
});

/* =================================================================== */
/* 4. syncTeam                                                          */
/* =================================================================== */

G('4. syncTeam()');

test('досыпает недостающих, не дублирует существующих', () => {
  const h = ['tg_id', 'name', 'role'];
  const team = [h, mkRow(h, { tg_id: '1285269855', name: 'Миша вручную', role: 'admin' })];
  const { env, api } = newApp({ sheets: { team }, props: {} });
  api.syncTeam();
  const d = env.dump('team');
  assert.equal(body(d).length, api.TEAM_SEED.length, 'строк = размеру TEAM_SEED');
  const o = objs(d, 'tg_id');
  assert.equal(o['1285269855'].name, 'Миша вручную', 'существующую строку не переписали');
  api.TEAM_SEED.forEach(m => assert.ok(o[String(m.id)], 'в листе есть ' + m.id));
  api.syncTeam();
  assert.equal(body(env.dump('team')).length, api.TEAM_SEED.length, 'повторный вызов не дублирует');
});

test('пишет по фактической шапке (колонки переставлены)', () => {
  const h = ['role', 'name', 'tg_id'];
  const team = [h];
  const { env, api } = newApp({ sheets: { team }, props: {} });
  api.syncTeam();
  const d = env.dump('team');
  assert.deepEqual(head(d), h, 'шапка не тронута');
  const o = objs(d, 'tg_id');
  api.TEAM_SEED.forEach(m => {
    assert.ok(o[String(m.id)], 'есть строка ' + m.id);
    assert.equal(o[String(m.id)].name, m.name, 'имя в своей колонке у ' + m.id);
    assert.equal(o[String(m.id)].role, m.role || 'admin', 'роль в своей колонке у ' + m.id);
  });
  // tg_id физически в третьей колонке
  body(d).forEach(r => assert.match(String(r[2]), /^\d+$/, 'tg_id лежит в колонке tg_id, а не в первой: ' + JSON.stringify(r)));
});

test('пишет ниже уже существующих строк, ничего не затирая', () => {
  const h = ['tg_id', 'name', 'role'];
  const team = [h,
    mkRow(h, { tg_id: '999000', name: 'Чужой человек', role: 'bar' }),
    mkRow(h, { tg_id: '888000', name: 'Второй чужой', role: 'bar' })
  ];
  const { env, api } = newApp({ sheets: { team }, props: {} });
  api.syncTeam();
  const o = objs(env.dump('team'), 'tg_id');
  assert.equal(o['999000'].name, 'Чужой человек');
  assert.equal(o['888000'].name, 'Второй чужой');
  assert.equal(body(env.dump('team')).length, api.TEAM_SEED.length + 2);
});

/* =================================================================== */
/* 5. setup                                                             */
/* =================================================================== */

G('5. setup()');

test('НЕ стирает counts и purchases', () => {
  const hc = ['id', 'date', 'by', 'cash', 'card', 'initial', 'note', 'source', 'stock', 'frozen', 'amnesty'];
  const hp = ['id', 'date', 'by', 'total', 'source', 'items'];
  const hr = ['id', 'date', 'by', 'amount', 'units', 'toTill', 'note'];
  const counts = [hc,
    mkRow(hc, { id: 'c-app-1', by: 'Рита', cash: 123.45, card: 10, note: 'живой подсчёт', stock: '{"aro05":7}' }),
    mkRow(hc, { id: 'c-app-2', by: 'Женя', cash: 5, note: 'второй живой', stock: '{}' })
  ];
  const purchases = [hp,
    mkRow(hp, { id: 'p-app-1', by: 'Света', total: 88.8, source: 'Kaufland', items: '{"cola033":24}' })
  ];
  const returns = [hr, mkRow(hr, { id: 'r-app-1', by: 'Даша', amount: 4.5, units: 30 })];
  const { env, api } = newApp({ sheets: { products: [], counts, purchases, returns }, props: {} });
  api.setup();

  const oc = objs(env.dump('counts'));
  assert.ok(oc['c-app-1'], 'подсчёт c-app-1 на месте');
  assert.equal(oc['c-app-1'].cash, 123.45, 'сумма наличных цела');
  assert.equal(oc['c-app-1'].note, 'живой подсчёт', 'заметка цела');
  assert.equal(oc['c-app-1'].stock, '{"aro05":7}', 'остатки целы');
  assert.ok(oc['c-app-2'], 'подсчёт c-app-2 на месте');
  const op = objs(env.dump('purchases'));
  assert.ok(op['p-app-1'], 'закупка p-app-1 на месте');
  assert.equal(op['p-app-1'].total, 88.8, 'сумма закупки цела');
  assert.equal(op['p-app-1'].items, '{"cola033":24}', 'позиции закупки целы');
  const or = objs(env.dump('returns'));
  assert.ok(or['r-app-1'], 'сдача тары из приложения на месте');
  // и опорные данные тоже доехали
  Object.keys(api.SEED.counts).forEach(id => assert.ok(oc[id], 'опорный подсчёт ' + id + ' добавлен'));
  Object.keys(api.SEED.purchases).forEach(id => assert.ok(op[id], 'опорная закупка ' + id + ' добавлена'));
});

test('справочник products перезаливается целиком', () => {
  const h = ['id', 'name', 'vol', 'cat', 'shape', 'color', 'cap', 'cost', 'dep', 'pack', 'min', 'order', 'note', 'hidden', 'phaseout'];
  const products = [h, mkRow(h, { id: 'мусор', name: 'удалить меня' })];
  const { env, api } = newApp({ sheets: { products }, props: {} });
  api.setup();
  const o = objs(env.dump('products'));
  assert.ok(!o['мусор'], 'старая строка справочника удалена');
  assert.equal(Object.keys(o).length, Object.keys(api.SEED.products).length, 'ровно 51 товар');
});

test('на пустой книге создаёт все листы с шапками', () => {
  const { env, api } = newApp({ sheets: {}, props: {} });
  api.setup();
  ['products', 'counts', 'purchases', 'returns', 'team'].forEach(n => {
    assert.ok(env.sheet(n), 'лист ' + n + ' создан');
    assert.deepEqual(head(env.dump(n)), api.COLS[n], 'шапка листа ' + n);
  });
  assert.equal(body(env.dump('team')).length, 0, 'team остаётся пустым после setup');
});

/* =================================================================== */
/* 6. auth / allowed                                                    */
/* =================================================================== */

G('6. auth() и allowed()');

const TOKEN = '123456:AAHfake-token-for-tests';

function authEnv(extraProps, sheets) {
  return newApp({
    props: Object.assign({ BOT_TOKEN: TOKEN }, extraProps || {}),
    sheets: sheets || {}
  });
}

test('валидная подпись принимается', () => {
  const { api } = authEnv({ ADMIN_IDS: String(USER.id) });
  const u = api.auth(initData(TOKEN, tgFields()));
  assert.equal(u.id, String(USER.id), 'id пользователя');
  assert.ok(u.name, 'имя не пустое');
});

test('имя собирается без лишнего пробела (нет фамилии)', () => {
  const { api } = authEnv({ ADMIN_IDS: String(USER.id) });
  const u = api.auth(initData(TOKEN, tgFields()));
  assert.equal(u.name, 'Миша',
    'у пользователя без last_name имя получилось ' + JSON.stringify(u.name));
});

test('имя и фамилия склеиваются через пробел', () => {
  const who = { id: 1285269855, first_name: 'Миша', last_name: 'Петров' };
  const { api } = authEnv({ ADMIN_IDS: String(who.id) });
  const u = api.auth(initData(TOKEN, tgFields({ user: JSON.stringify(who) })));
  assert.equal(u.name, 'Миша Петров');
});

test('если имени нет — берётся username', () => {
  const who = { id: 1285269855, username: 'misha' };
  const { api } = authEnv({ ADMIN_IDS: String(who.id) });
  const u = api.auth(initData(TOKEN, tgFields({ user: JSON.stringify(who) })));
  assert.equal(u.name, 'misha',
    'ожидался username, получено ' + JSON.stringify(u.name));
});

test('если нет ни имени, ни username — берётся id', () => {
  const who = { id: 1285269855 };
  const { api } = authEnv({ ADMIN_IDS: String(who.id) });
  const u = api.auth(initData(TOKEN, tgFields({ user: JSON.stringify(who) })));
  assert.equal(u.name, String(who.id),
    'ожидался id строкой, получено ' + JSON.stringify(u.name));
});

test('битая подпись отвергается', () => {
  const { api } = authEnv({ ADMIN_IDS: String(USER.id) });
  throws(() => api.auth(initData(TOKEN, tgFields(), { corrupt: true })), /Подпись/, 'испорченный hash');
});

test('подпись чужим токеном отвергается', () => {
  const { api } = authEnv({ ADMIN_IDS: String(USER.id) });
  throws(() => api.auth(initData('999:OTHER', tgFields())), /Подпись/, 'чужой токен');
});

test('подменённое поле при старом hash отвергается', () => {
  const { api } = authEnv({ ADMIN_IDS: '1' });
  const good = initData(TOKEN, tgFields());
  const bad = good.replace(encodeURIComponent(JSON.stringify(USER)),
    encodeURIComponent(JSON.stringify({ id: 1, first_name: 'Взломщик' })));
  throws(() => api.auth(bad), /Подпись/, 'подменили user');
});

test('hash вовсе отсутствует — отвергается', () => {
  const { api } = authEnv({ ADMIN_IDS: String(USER.id) });
  throws(() => api.auth(initData(TOKEN, tgFields(), { noHash: true })), /Подпись/);
});

test('auth_date отсутствует — отвергается', () => {
  const { api } = authEnv({ ADMIN_IDS: String(USER.id) });
  const f = tgFields(); delete f.auth_date;
  throws(() => api.auth(initData(TOKEN, f)), /Сессия устарела/);
});

test('auth_date не число — отвергается', () => {
  const { api } = authEnv({ ADMIN_IDS: String(USER.id) });
  throws(() => api.auth(initData(TOKEN, tgFields({ auth_date: 'вчера' }))), /Сессия устарела/);
});

test('auth_date в далёком будущем — отвергается', () => {
  const { api } = authEnv({ ADMIN_IDS: String(USER.id) });
  const future = String(Math.floor(Date.now() / 1000) + 3600);
  throws(() => api.auth(initData(TOKEN, tgFields({ auth_date: future }))), /Сессия устарела/);
});

test('auth_date старше суток — отвергается', () => {
  const { api } = authEnv({ ADMIN_IDS: String(USER.id) });
  const old = String(Math.floor(Date.now() / 1000) - 25 * 3600);
  throws(() => api.auth(initData(TOKEN, tgFields({ auth_date: old }))), /Сессия устарела/);
});

test('auth_date часовой давности принимается', () => {
  const { api } = authEnv({ ADMIN_IDS: String(USER.id) });
  const hourAgo = String(Math.floor(Date.now() / 1000) - 3600);
  const u = api.auth(initData(TOKEN, tgFields({ auth_date: hourAgo })));
  assert.equal(u.id, String(USER.id));
});

test('без BOT_TOKEN и без initData — внятные ошибки', () => {
  const { api } = newApp({ props: {} });
  throws(() => api.auth(initData(TOKEN, tgFields())), /BOT_TOKEN/);
  const { api: a2 } = authEnv({});
  throws(() => a2.auth(''), /через Telegram/);
});

test('allowed: ADMIN_IDS проходит даже при непустом team', () => {
  const h = ['tg_id', 'name', 'role'];
  const team = [h, mkRow(h, { tg_id: '111', name: 'Кто-то', role: 'bar' })];
  const { api } = authEnv({ ADMIN_IDS: ' 777 , 888 ' }, { team });
  assert.equal(api.allowed('777', {}), true, 'первый id из ADMIN_IDS');
  assert.equal(api.allowed('888', {}), true, 'второй id из ADMIN_IDS (пробелы обрезаны)');
  assert.equal(api.allowed('111', {}), true, 'человек из листа team');
  assert.equal(api.allowed('222', {}), false, 'посторонний не проходит');
});

test('allowed: id не из списка не проходит', () => {
  const h = ['tg_id', 'name', 'role'];
  const team = [h, mkRow(h, { tg_id: '111', name: 'Кто-то' })];
  const { api } = authEnv({ ADMIN_IDS: '777' }, { team });
  assert.equal(api.allowed('333', {}), false);
  assert.equal(api.allowed('', {}), false, 'пустой id');
  assert.equal(api.allowed(null, {}), false, 'null');
});

test('allowed: пустой team и пустой ADMIN_IDS — не проходит НИКТО (бутстрапа нет)', () => {
  const h = ['tg_id', 'name', 'role'];
  const { api, env } = authEnv({ ADMIN_IDS: '' }, { team: [h] });
  assert.equal(api.allowed('1285269855', {}), false, 'даже свой не проходит');
  assert.equal(api.allowed('555', {}), false);
  assert.equal(body(env.dump('team')).length, 0, 'в team никого не дописали');
  const { api: a2, env: e2 } = authEnv({}, {});
  assert.equal(a2.allowed('555', {}), false, 'ADMIN_IDS вообще не задан, листа team нет');
  assert.equal(body(e2.dump('team')).length, 0, 'лист team создан пустым и остался пустым');
});

test('auth: валидная подпись, но человека нет в команде — отказ', () => {
  const h = ['tg_id', 'name', 'role'];
  const { api } = authEnv({ ADMIN_IDS: '' }, { team: [h, mkRow(h, { tg_id: '111' })] });
  throws(() => api.auth(initData(TOKEN, tgFields())), /нет в списке команды/);
});

/* =================================================================== */
/* 7. cell / safeText                                                   */
/* =================================================================== */

G('7. cell() и safeText()');

test('safeText экранирует =, +, -, @', () => {
  const { api } = newApp({});
  assert.equal(api.safeText('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(api.safeText('+7 999'), "'+7 999");
  assert.equal(api.safeText('-5 штук'), "'-5 штук");
  assert.equal(api.safeText('@durov'), "'@durov");
});

test('safeText не трогает обычный текст', () => {
  const { api } = newApp({});
  ['Миша', 'Вода Aro', 'a=b', 'Metro 22.07: 0,20 €', '', '0,5 л · негаз.'].forEach(s => {
    assert.equal(api.safeText(s), s, 'не тронут: ' + JSON.stringify(s));
  });
});

test('cell: числа остаются числами', () => {
  const { api } = newApp({});
  const c = api.cell('products', 'cost', 0.24);
  assert.equal(typeof c, 'number', 'тип значения');
  assert.equal(c, 0.24);
  const neg = api.cell('counts', 'cash', -12.5);
  assert.equal(typeof neg, 'number', 'отрицательное число не превратилось в строку');
  assert.equal(neg, -12.5);
  assert.equal(api.cell('products', 'hidden', false), false, 'булево осталось булевым');
  assert.equal(api.cell('products', 'phaseout', true), true);
});

test('cell: опасный текст экранируется, null/undefined → пустая строка', () => {
  const { api } = newApp({});
  assert.equal(api.cell('products', 'name', '=1+1'), "'=1+1");
  assert.equal(api.cell('counts', 'by', '@misha'), "'@misha");
  assert.equal(api.cell('products', 'note', 'Вода Aro'), 'Вода Aro');
  assert.equal(api.cell('products', 'min', null), '');
  assert.equal(api.cell('products', 'min', undefined), '');
});

test('cell: JSON-поля сериализуются, пустое → {}', () => {
  const { api } = newApp({});
  assert.equal(api.cell('counts', 'stock', { aro05: 3 }), '{"aro05":3}');
  assert.equal(api.cell('counts', 'stock', null), '{}');
  assert.equal(api.cell('counts', 'frozen', undefined), '{}');
  assert.equal(api.cell('purchases', 'items', { a: 1 }), '{"a":1}');
});

test('insert: имя-формула попадает в лист экранированным', () => {
  const { env, api } = newApp({ sheets: {}, props: {} });
  api.insert('counts', { id: 'c1', by: '=HYPERLINK("http://evil","клик")', cash: -5, stock: { a: 1 } });
  const o = objs(env.dump('counts'));
  assert.equal(String(o.c1.by).charAt(0), "'", 'формула в поле by обезврежена');
  assert.equal(o.c1.cash, -5, 'число записано числом');
  assert.equal(typeof o.c1.cash, 'number');
});

/* =================================================================== */
/* 8. rows()                                                            */
/* =================================================================== */

G('8. rows()');

const HC = ['id', 'date', 'by', 'cash', 'card', 'initial', 'note', 'source', 'stock', 'frozen', 'amnesty'];

function countsBook(rowsArr) {
  return newApp({ sheets: { counts: [HC].concat(rowsArr.map(v => mkRow(HC, v))) }, props: {} });
}

test('числовые поля приходят числами, в т.ч. «0,24» и «0.24»', () => {
  const { api } = countsBook([
    { id: 'c1', cash: '0,24', card: '0.24' },
    { id: 'c2', cash: 12.5, card: '1 000' },
    { id: 'c3', cash: '-3,5', card: 'не число' }
  ]);
  const r = api.rows('counts');
  assert.equal(r[0].cash, 0.24, 'строка «0,24» → 0.24');
  assert.equal(typeof r[0].cash, 'number', 'тип числовой');
  assert.equal(r[0].card, 0.24, 'строка «0.24» → 0.24');
  assert.equal(r[1].cash, 12.5, 'число осталось числом');
  assert.equal(r[2].cash, -3.5, 'отрицательное с запятой');
  assert.equal(r[2].card, null, 'нечисловой мусор → null');
});

test('пустая числовая ячейка → null, а не 0', () => {
  const { api } = countsBook([{ id: 'c1', cash: '', card: 0 }]);
  const r = api.rows('counts');
  assert.equal(r[0].cash, null, 'пустая ячейка cash');
  assert.notEqual(r[0].cash, 0, 'именно null, не 0');
  assert.equal(r[0].card, 0, 'настоящий ноль сохранился');
});

test('булевы: true / «TRUE» / «да» → true, пустая → false-подобное', () => {
  const { api } = countsBook([
    { id: 'c1', initial: true, amnesty: 'TRUE' },
    { id: 'c2', initial: 'да', amnesty: '' },
    { id: 'c3', initial: false, amnesty: 'нет' }
  ]);
  const r = api.rows('counts');
  assert.equal(r[0].initial, true, 'булево true');
  assert.equal(r[0].amnesty, true, 'строка TRUE');
  assert.equal(r[1].initial, true, 'строка «да»');
  assert.ok(!r[1].amnesty, 'пустая ячейка — false-подобное');
  assert.equal(r[2].initial, false, 'булево false');
  assert.equal(r[2].amnesty, false, 'произвольный текст → false');
});

test('JSON-поля: валидный разбирается, битый не роняет, пустые по умолчанию', () => {
  const { api } = countsBook([
    { id: 'c1', stock: '{"aro05":3,"cola033":12}', frozen: '{"aro05":1}' },
    { id: 'c2', stock: '', frozen: '' },
    { id: 'c3', stock: '{битый', frozen: 'тоже мусор' }
  ]);
  const r = api.rows('counts');
  assert.deepEqual(r[0].stock, { aro05: 3, cola033: 12 }, 'валидный stock');
  assert.deepEqual(r[0].frozen, { aro05: 1 }, 'валидный frozen');
  assert.deepEqual(r[1].stock, {}, 'пустой stock → {}');
  assert.equal(r[1].frozen, null, 'пустой frozen → null');
  assert.equal(r[2].stock, null, 'битый JSON → null, без исключения');
  assert.equal(r[2].frozen, null, 'битый frozen → null');
});

test('date: Date → ISO-строка, текст остаётся текстом', () => {
  const d = new Date('2026-07-22T13:21:00.000Z');
  const { api } = countsBook([
    { id: 'c1', date: d },
    { id: 'c2', date: '2026-09-20T10:00:00.000Z' }
  ]);
  const r = api.rows('counts');
  assert.equal(r[0].date, d.toISOString(), 'Date сериализован в ISO');
  assert.equal(typeof r[0].date, 'string');
  assert.equal(r[1].date, '2026-09-20T10:00:00.000Z', 'строка не тронута');
});

test('строки без id отбрасываются, пустой лист → []', () => {
  const { api } = countsBook([{ id: 'c1', cash: 1 }, { id: '', cash: 2 }, { id: 'c3', cash: 3 }]);
  const r = api.rows('counts');
  assert.equal(r.length, 2, 'безымянная строка выброшена');
  const { api: a2 } = newApp({ sheets: {}, props: {} });
  assert.deepEqual(a2.rows('counts'), [], 'пустой лист');
});

/* =================================================================== */
/* 9. handle                                                            */
/* =================================================================== */

G('9. handle()');

function readyApp(props) {
  const sheets = bootedBook();
  return newApp({ sheets, props: Object.assign({ SEED_VERSION: SEEDV, BOT_TOKEN: TOKEN, ADMIN_IDS: String(USER.id) }, props || {}) });
}

test('list не берёт замок, когда синкать нечего', () => {
  // Замок на чтении ставил читающих в очередь за пишущими: двое открывших
  // приложение одновременно ждали до 30 секунд каждый.
  const { env, api } = readyApp();
  const out = api.handle('list', {}, { id: '1', name: 'Миша' });
  assert.equal(env.lockCalls.waitLock, 0, 'замок не брался');
  assert.equal(env.lockCalls.held, 0, 'замок не остался висеть');
  assert.ok(out.products && out.counts && out.purchases && out.returns, 'вернулись все четыре раздела');
  assert.equal(Object.keys(out.products).length, 51, '51 товар');
});

test('list берёт и отпускает замок, когда сид разъехался', () => {
  const { env, api } = newApp({ sheets: bootedBook(), props: { SEED_VERSION: '1', BOT_TOKEN: TOKEN } });
  const before = env.lockCalls.releaseLock;
  const out = api.handle('list', {}, { id: '1', name: 'Миша' });
  assert.equal(env.lockCalls.waitLock, 1, 'замок взят: чтение будет писать');
  assert.equal(env.lockCalls.releaseLock, before + 1, 'замок отпущен');
  assert.equal(env.lockCalls.held, 0, 'замок не остался висеть');
  assert.equal(String(env.props.SEED_VERSION), SEEDV, 'версия сида обновилась');
  assert.equal(Object.keys(out.products).length, 51, '51 товар');
});

test('list не трогает лист team, когда синкать нечего', () => {
  // syncTeam выполнялся на каждое чтение — лишние записи в лист на ровном месте
  const { env, api } = readyApp();
  env.stats.reset();
  api.handle('list', {}, { id: '1', name: 'Миша' });
  const team = env.stats.log.filter(x => String(x).indexOf('team') >= 0);
  assert.equal(team.length, 0, 'обращений к team быть не должно, а было: ' + team.join(', '));
});

test('повторное чтение берётся из кэша и не открывает таблицу', () => {
  const { env, api } = readyApp();
  api.handle('list', {}, { id: '1', name: 'Миша' });      // первый раз — из листа
  env.stats.reset();
  const out = api.handle('list', {}, { id: '1', name: 'Миша' });
  assert.equal(env.stats.total, 0, 'второе чтение не должно трогать листы, а было: ' + env.stats.log.slice(0,6).join(', '));
  assert.equal(Object.keys(out.products).length, 51, 'из кэша вернулся весь склад');
  assert.equal(Object.keys(out.counts).length, 2, 'подсчёты тоже на месте');
});

test('кэш не подменяет типы: из него приходит то же, что из листа', () => {
  const { env, api } = readyApp();
  const fromSheet = api.handle('list', {}, { id: '1', name: 'Миша' });
  const fromCache = api.handle('list', {}, { id: '1', name: 'Миша' });
  assert.deepEqual(fromCache, fromSheet, 'кэш обязан отдавать ровно то же, иначе цифры разъедутся');
});

test('запись сбрасывает кэш — следующее чтение видит новое', () => {
  const { api } = readyApp();
  api.handle('list', {}, { id: '1', name: 'Миша' });      // прогрели кэш
  api.handle('updateProduct', { id: 'aro05', patch: { cost: 42 } }, { id: '1', name: 'Миша' });
  const after = api.handle('list', {}, { id: '1', name: 'Миша' });
  assert.equal(after.products.aro05.cost, 42, 'после правки чтение обязано показать новую цену');
});

test('добавленный подсчёт виден сразу, а не через полторы минуты', () => {
  const { api } = readyApp();
  api.handle('list', {}, { id: '1', name: 'Миша' });
  const before = Object.keys(api.handle('list', {}, { id: '1', name: 'Миша' }).counts).length;
  api.handle('addCount', { date: '2026-10-01T10:00:00.000Z', cash: 10, card: 0, stock: { aro05: 5 } },
             { id: '1', name: 'Миша' });
  const after = api.handle('list', {}, { id: '1', name: 'Миша' }).counts;
  assert.equal(Object.keys(after).length, before + 1, 'новый подсчёт должен быть в ближайшем же чтении');
});

test('fresh:true обходит кэш и перечитывает лист', () => {
  const { env, api } = readyApp();
  api.handle('list', {}, { id: '1', name: 'Миша' });
  env.stats.reset();
  api.handle('list', { fresh: true }, { id: '1', name: 'Миша' });
  assert.ok(env.stats.total > 0, 'кнопка «обновить» обязана идти в таблицу, а не в кэш');
});

G('13. словарь названий из чеков');

test('подтверждённое написание запоминается за товаром', () => {
  const { api } = readyApp();
  const out = api.handle('addPurchase', { total: 90, items:{aro05:6}, source:'Metro',
    learn: [{id:'aro05', name:'ARO VODA 500ml PETZ NESYTENA', article:'8586000056916', shop:'Metro'}]
  }, { id:'1', name:'Миша' });
  const a = out.products.aro05.aliases;
  assert.ok(a && a.length, 'словарь не пустой');
  assert.equal(a[a.length-1].name, 'ARO VODA 500ml PETZ NESYTENA');
  assert.equal(a[a.length-1].shop, 'Metro');
  assert.equal(a[a.length-1].article, '8586000056916');
});

test('одно и то же написание не копится дублями', () => {
  const { api } = readyApp();
  const learn = [{id:'aro05', name:'ARO VODA 500ml', shop:'Metro'}];
  api.handle('addPurchase', { total: 91, items:{aro05:1}, learn }, { id:'1', name:'Миша' });
  const out = api.handle('addPurchase', { total: 92, items:{aro05:1}, learn }, { id:'1', name:'Миша' });
  assert.equal(out.products.aro05.aliases.length, 1, 'запись одна, а не две');
});

test('разные магазины копятся отдельно', () => {
  const { api } = readyApp();
  api.handle('addPurchase', { total: 93, items:{aro05:1},
    learn: [{id:'aro05', name:'ARO VODA', shop:'Metro'}] }, { id:'1', name:'Миша' });
  const out = api.handle('addPurchase', { total: 94, items:{aro05:1},
    learn: [{id:'aro05', name:'Voda Aro 0.5', shop:'Kaufland'}] }, { id:'1', name:'Миша' });
  const shops = out.products.aro05.aliases.map(x => x.shop).sort();
  assert.deepEqual(shops, ['Kaufland', 'Metro']);
});

test('словарь не растёт бесконечно', () => {
  const { api } = readyApp();
  for (let i = 0; i < 20; i++)
    api.handle('addPurchase', { total: 95 + i, items:{aro05:1},
      learn: [{id:'aro05', name:'вариант ' + i, shop:'Magazin' + i}] }, { id:'1', name:'Миша' });
  const out = api.handle('list', {}, { id:'1', name:'Миша' });
  assert.ok(out.products.aro05.aliases.length <= 12,
    'помним последние написания, а не все подряд: ' + out.products.aro05.aliases.length);
});

test('мусор в словарь не попадает', () => {
  const { api } = readyApp();
  const out = api.handle('addPurchase', { total: 96, items:{aro05:1}, learn: [
    {id:'нетакого', name:'что-то'},        // неизвестный товар
    {id:'aro05'},                           // без названия
    null
  ]}, { id:'1', name:'Миша' });
  const a = out.products.aro05.aliases;
  assert.ok(!a || !a.length, 'ничего не записалось');
});

G('12. повтор запроса не заводит дубль');

test('повтор с тем же номером не пишет вторую закупку', () => {
  // Приложение повторяет запрос, когда ответ пришёл битым, — а скрипт мог уже
  // всё записать. Без защиты в таблице появлялась вторая такая же закупка.
  const { api } = readyApp();
  const before = Object.keys(api.handle('list', {}, { id:'1', name:'Миша' }).purchases).length;
  const pay = { rid: 'один-и-тот-же', date:'2026-10-05T10:00:00.000Z', total: 33, items:{aro05:6} };
  api.handle('addPurchase', pay, { id:'1', name:'Миша' });
  const out = api.handle('addPurchase', pay, { id:'1', name:'Миша' });
  assert.equal(Object.keys(out.purchases).length, before + 1, 'закупка ровно одна');
  assert.equal(Object.values(out.purchases).filter(x => x.total === 33).length, 1, 'дубля нет');
});

test('разные номера — разные записи, даже если всё остальное совпало', () => {
  const { api } = readyApp();
  const base = { date:'2026-10-05T10:00:00.000Z', total: 34, items:{aro05:6} };
  api.handle('addPurchase', Object.assign({ rid:'первый' }, base), { id:'1', name:'Миша' });
  const out = api.handle('addPurchase', Object.assign({ rid:'второй' }, base), { id:'1', name:'Миша' });
  assert.equal(Object.values(out.purchases).filter(x => x.total === 34).length, 2,
    'две одинаковые закупки подряд — это нормально, если человек так и сделал');
});

test('без номера работает как раньше', () => {
  const { api } = readyApp();
  api.handle('addPurchase', { total: 35, items:{aro05:1} }, { id:'1', name:'Миша' });
  const out = api.handle('addPurchase', { total: 35, items:{aro05:1} }, { id:'1', name:'Миша' });
  assert.equal(Object.values(out.purchases).filter(x => x.total === 35).length, 2);
});

test('повтор подсчёта тоже не двоится', () => {
  const { api } = readyApp();
  const before = Object.keys(api.handle('list', {}, { id:'1', name:'Миша' }).counts).length;
  const pay = { rid:'подсчёт-1', date:'2026-10-06T10:00:00.000Z', cash: 50, card: 0, stock:{aro05:5} };
  api.handle('addCount', pay, { id:'1', name:'Миша' });
  const out = api.handle('addCount', pay, { id:'1', name:'Миша' });
  assert.equal(Object.keys(out.counts).length, before + 1, 'подсчёт ровно один');
});

test('повтор сдачи тары тоже не двоится', () => {
  const { api } = readyApp();
  const before = Object.keys(api.handle('list', {}, { id:'1', name:'Миша' }).returns).length;
  const pay = { rid:'тара-1', date:'2026-10-06T10:00:00.000Z', amount: 12.15, units: 81, toTill:true };
  api.handle('addReturn', pay, { id:'1', name:'Миша' });
  const out = api.handle('addReturn', pay, { id:'1', name:'Миша' });
  assert.equal(Object.keys(out.returns).length, before + 1, 'сдача ровно одна');
});

test('повтор возвращает актуальный склад, а не пустоту', () => {
  const { api } = readyApp();
  const pay = { rid:'ещё-один', total: 36, items:{aro05:2} };
  api.handle('addPurchase', pay, { id:'1', name:'Миша' });
  const out = api.handle('addPurchase', pay, { id:'1', name:'Миша' });
  assert.equal(Object.keys(out.products).length, 51, 'на повторе тоже отдан весь склад');
  assert.ok(out.counts && out.purchases && out.returns, 'и все разделы');
});

G('11. чек закупки');

const PNG1 = 'data:image/jpeg;base64,' + Buffer.from('фото чека, как будто').toString('base64');

test('закупка с фото: фото ушло в Telegram, в строке — только file_id', () => {
  const { env, api } = readyApp();
  const out = api.handle('addPurchase', { date:'2026-10-01T10:00:00.000Z', total: 50,
    items:{aro05:6}, photo: PNG1 }, { id:'1', name:'Миша' });
  const buy = Object.values(out.purchases).find(x => x.total === 50);
  assert.ok(buy, 'закупка записалась');
  assert.ok(buy.receipt, 'file_id записан в строку');
  assert.ok(!/base64/.test(String(buy.receipt)), 'в таблицу не должно попасть само фото');
  assert.equal(env.drive.sent.length, 1, 'отправлено ровно одно фото');
});

test('лист без новых колонок: они досоздаются, а не теряются молча', () => {
  // Старый лист закупок не знает про receipt и prices. insert пишет по шапке,
  // поэтому без ensureCols значения просто исчезали — молча, без ошибки.
  const sheets = bootedBook();
  const head = sheets.purchases[0];
  sheets.purchases = sheets.purchases.map(r => r.slice(0, head.indexOf('receipt') >= 0 ? head.indexOf('receipt') : r.length));
  const { env, api } = newApp({ sheets, props: { SEED_VERSION: SEEDV, BOT_TOKEN: TOKEN, ADMIN_IDS: String(USER.id) } });
  const out = api.handle('addPurchase', { total: 80, items:{aro05:1}, photo: PNG1,
    prices:{ aro05: 9.99 } }, { id:'1', name:'Миша' });
  const buy = Object.values(out.purchases).find(x => x.total === 80);
  assert.ok(buy.receipt, 'file_id сохранился, а не пропал');
  assert.equal(buy.prices.list.aro05, 9.99, 'цены тоже на месте');
  assert.ok(env.dump('purchases')[0].indexOf('receipt') >= 0, 'колонка появилась в шапке');
});

test('чек уходит документом, а не фотографией', () => {
  // sendPhoto пережимает картинку — мелкий шрифт на чеке из Metro превращается
  // в кашу, а он и есть весь смысл затеи. Документы Telegram хранит как есть.
  const { env, api } = readyApp();
  api.handle('addPurchase', { total: 60, items:{aro05:1}, photo: PNG1 }, { id:'1', name:'Миша' });
  assert.equal(env.drive.sent[0].kind, 'document', 'отправлено документом');
});

test('чеки уходят в заданный чат, а по умолчанию — первому админу', () => {
  const a = readyApp();
  a.api.handle('addPurchase', { total: 70, items:{aro05:1}, photo: PNG1 }, { id:'1', name:'Миша' });
  assert.equal(a.env.drive.sent[0].chat, String(USER.id), 'по умолчанию — первый из ADMIN_IDS');

  const b = newApp({ sheets: bootedBook(),
    props: { SEED_VERSION: SEEDV, BOT_TOKEN: TOKEN, ADMIN_IDS: String(USER.id), RECEIPTS_CHAT: '-100500' } });
  b.api.handle('addPurchase', { total: 71, items:{aro05:1}, photo: PNG1 }, { id:'1', name:'Миша' });
  assert.equal(b.env.drive.sent[0].chat, '-100500', 'RECEIPTS_CHAT перебивает умолчание');
});

test('без свойств адрес берётся из листа команды', () => {
  const app = newApp({ sheets: bootedBook(), props: { SEED_VERSION: SEEDV, BOT_TOKEN: TOKEN } });
  const admin = app.api.rows('team').filter(r => String(r.role).toLowerCase() === 'admin')[0];
  assert.ok(admin, 'подготовка: в листе команды есть админ');
  app.api.handle('addPurchase', { total: 72, items:{aro05:1}, photo: PNG1 }, { id:'1', name:'Миша' });
  assert.equal(app.env.drive.sent[0].chat, String(admin.tg_id), 'ушло первому админу из листа');
});

test('совсем некуда сохранить — понятная ошибка, а не «undefined»', () => {
  const sheets = bootedBook();
  sheets.team = [sheets.team[0]];                      // одна шапка, ни одного человека
  const app = newApp({ sheets, props: { SEED_VERSION: SEEDV, BOT_TOKEN: TOKEN } });
  throws(() => app.api.handle('addPurchase', { total: 1, items:{aro05:1}, photo: PNG1 },
    { id:'1', name:'Миша' }), /Некуда сохранить/i);
});

test('чек отдаётся обратно тем же, чем положили', () => {
  const { api } = readyApp();
  const out = api.handle('addPurchase', { total: 51, items:{aro05:1}, photo: PNG1 }, { id:'1', name:'Миша' });
  const id = Object.values(out.purchases).find(x => x.total === 51).id
          || Object.entries(out.purchases).find(([,x]) => x.total === 51)[0];
  const got = api.handle('getReceipt', { id }, { id:'1', name:'Миша' });
  // Telegram отдаёт файл без типа: браузер по такому картинку не покажет
  assert.ok(/^image\//.test(got.mime), 'тип должен быть картинкой, а не ' + got.mime);
  assert.equal(got.mime, 'image/jpeg', 'по расширению .jpg');
  assert.equal('data:' + got.mime + ';base64,' + got.data, PNG1, 'байты вернулись те же');
  assert.ok(!/base64/.test(JSON.stringify(api.handle('list', {}, { id:'1', name:'Миша' }).purchases)),
    'в общий список фото не попадает — оно тяжёлое');
});

test('закупка без фото работает как раньше', () => {
  const { env, api } = readyApp();
  const out = api.handle('addPurchase', { total: 52, items:{aro05:1} }, { id:'1', name:'Миша' });
  assert.ok(Object.values(out.purchases).some(x => x.total === 52), 'записалась');
  assert.equal(env.drive.files.size, 0, 'на Диск ничего не клали');
});

test('не картинку и мусор вместо фото не принимаем', () => {
  const { api } = readyApp();
  throws(() => api.handle('addPurchase', { total: 1, items:{aro05:1}, photo: 'просто строка' },
    { id:'1', name:'Миша' }), /непонятн/i, 'мусор');
  throws(() => api.handle('addPurchase', { total: 1, items:{aro05:1},
    photo: 'data:application/pdf;base64,' + Buffer.from('pdf').toString('base64') },
    { id:'1', name:'Миша' }), /картинк/i, 'не картинка');
});

test('цены с чека обновляют справочник и запоминают, что было', () => {
  const { api } = readyApp();
  const before = api.handle('list', {}, { id:'1', name:'Миша' }).products.aro05.cost;
  const out = api.handle('addPurchase', { total: 9, items:{aro05:6}, prices:{ aro05: before + 0.10 } },
    { id:'1', name:'Миша' });
  assert.equal(out.products.aro05.cost, before + 0.10, 'цена закупки обновилась');
  const buy = Object.values(out.purchases).find(x => x.total === 9);
  assert.equal(buy.prices.moved.aro05.was, before, 'запомнили прежнюю цену');
  assert.equal(buy.prices.moved.aro05.now, before + 0.10, 'и новую');
});

test('цена не изменилась — в «поменялось» пусто', () => {
  const { api } = readyApp();
  const before = api.handle('list', {}, { id:'1', name:'Миша' }).products.aro05.cost;
  const out = api.handle('addPurchase', { total: 9, items:{aro05:6}, prices:{ aro05: before } },
    { id:'1', name:'Миша' });
  const buy = Object.values(out.purchases).find(x => x.total === 9);
  assert.deepEqual(buy.prices.moved, {}, 'нечего показывать — цена та же');
  assert.equal(buy.prices.list.aro05, before, 'но саму цену с чека сохранили');
});

test('цена на несуществующий товар и мусорная цена игнорируются', () => {
  const { api } = readyApp();
  const out = api.handle('addPurchase', { total: 9, items:{aro05:1},
    prices:{ нетакого: 5, aro05: -3 } }, { id:'1', name:'Миша' });
  const buy = Object.values(out.purchases).find(x => x.total === 9);
  assert.deepEqual(buy.prices.list, {}, 'ничего из этого в цены не попало');
  assert.deepEqual(buy.prices.moved, {}, 'и ничего не переписали');
});

test('getReceipt у закупки без фото — понятная ошибка, замок отпущен', () => {
  const { env, api } = readyApp();
  const out = api.handle('addPurchase', { total: 53, items:{aro05:1} }, { id:'1', name:'Миша' });
  const id = Object.entries(out.purchases).find(([,x]) => x.total === 53)[0];
  throws(() => api.handle('getReceipt', { id }, { id:'1', name:'Миша' }), /нет фото/i);
  assert.equal(env.lockCalls.held, 0, 'замок не остался висеть');
});

test('производительность: обращений к листу на один list', () => {
  const { env, api } = readyApp();
  env.stats.reset();
  api.handle('list', {}, { id: '1', name: 'Миша' });
  metrics.listOps = env.stats.dataOps;
  metrics.listBySheet = {};
  Object.keys(env.stats.bySheet).forEach(n => { metrics.listBySheet[n] = env.stats.dataOpsOf(n); });
  note('handle(«list»): обращений к листам = ' + metrics.listOps +
       ' (' + Object.keys(metrics.listBySheet).map(n => n + ':' + metrics.listBySheet[n]).join(', ') + ')');
  assert.ok(metrics.listOps < 30, 'на один list должно быть меньше 30 обращений, а их ' + metrics.listOps);
});

test('неизвестное действие даёт ошибку и отпускает замок', () => {
  const { env, api } = readyApp();
  throws(() => api.handle('взломать', {}, { id: '1', name: 'Миша' }), /Неизвестное действие/);
  assert.equal(env.lockCalls.releaseLock, 1, 'замок отпущен после ошибки');
  assert.equal(env.lockCalls.held, 0);
});

test('delete запрещён для листа не из белого списка', () => {
  const { env, api } = readyApp();
  throws(() => api.handle('delete', { col: 'team', id: '1285269855' }, { id: '1', name: 'Миша' }),
    /Нельзя удалять из team/);
  assert.equal(env.lockCalls.held, 0, 'замок отпущен');
  assert.equal(body(env.dump('team')).length, 9, 'команда цела');
  throws(() => api.handle('delete', { col: '__proto__', id: 'x' }, null), /Нельзя удалять/);
  throws(() => api.handle('delete', { col: undefined, id: 'x' }, null), /Нельзя удалять/);
});

test('delete работает для разрешённого листа', () => {
  const { env, api } = readyApp();
  api.handle('addReturn', { amount: 3, units: 20, by: 'Маша' }, { id: '1', name: 'Маша' });
  const ids = Object.keys(api.listAll().returns);
  const fresh = ids.find(i => i.indexOf('r-') === 0 && i.length > 12 && !/^r-(start|20)/.test(i));
  assert.ok(fresh, 'сдача создана, id: ' + ids.join(','));
  api.handle('delete', { col: 'returns', id: fresh }, { id: '1', name: 'Маша' });
  assert.ok(!api.listAll().returns[fresh], 'строка удалена');
  assert.equal(env.lockCalls.held, 0);
});

test('addCount пишет подсчёт и возвращает свежий склад', () => {
  const { env, api } = readyApp();
  const out = api.handle('addCount', { cash: 10.5, card: 2, stock: { aro05: 5 }, note: '=опасно' },
    { id: '1', name: 'Миша' });
  const added = Object.keys(out.counts).filter(id => !api.SEED.counts[id]);
  assert.equal(added.length, 1, 'ровно один новый подсчёт');
  const c = out.counts[added[0]];
  assert.equal(c.cash, 10.5, 'наличные');
  assert.deepEqual(c.stock, { aro05: 5 }, 'остатки');
  assert.equal(c.by, 'Миша', 'автор подставлен из user');
  assert.equal(String(c.note).charAt(0), "'", 'заметка-формула обезврежена');
  assert.equal(env.lockCalls.held, 0, 'замок отпущен');
});

test('updateProduct несуществующего id даёт ошибку и отпускает замок', () => {
  const { env, api } = readyApp();
  throws(() => api.handle('updateProduct', { id: 'нет-такого', patch: { cost: 1 } }, null), /Не нашёл/);
  assert.equal(env.lockCalls.held, 0);
});

/* =================================================================== */
/* 10. doGet                                                            */
/* =================================================================== */

G('10. doGet()');

function parseOut(out) { return JSON.parse(out.getContent()); }

test('при совпадении SEED_VERSION не трогает листы и отвечает alive:true, synced:false', () => {
  const sheets = bootedBook();
  const { env, api } = newApp({ sheets, props: { SEED_VERSION: SEEDV, BOT_TOKEN: TOKEN } });
  env.stats.reset();
  const out = api.doGet({ parameter: {} });
  assert.equal(env.stats.total, 0, 'обращений к листам: ' + env.stats.total + ' — ' + env.stats.log.slice(0, 8).join(','));
  const j = parseOut(out);
  assert.equal(j.ok, true);
  assert.equal(j.data.alive, true, 'alive');
  assert.equal(j.data.synced, false, 'synced');
  assert.ok(j.data.ts, 'есть метка времени');
});

test('данных склада не отдаёт ни при каких параметрах', () => {
  const sheets = bootedBook();
  const { env, api } = newApp({ sheets, props: { SEED_VERSION: SEEDV, BOT_TOKEN: TOKEN } });
  [{}, { parameter: { action: 'list' } }, { parameter: { action: 'list', col: 'products' } },
   { parameter: { initData: 'что угодно' } }, undefined].forEach(e => {
    const j = parseOut(api.doGet(e));
    const s = JSON.stringify(j);
    assert.deepEqual(Object.keys(j.data).sort(), ['alive', 'synced', 'ts'], 'только служебные поля: ' + s);
    assert.ok(s.indexOf('aro05') < 0, 'в ответе нет id товаров');
    assert.ok(s.indexOf('products') < 0, 'в ответе нет раздела products');
  });
});

test('при новой версии синкает и говорит synced:true', () => {
  const sheets = bootedBook();
  const { env, api } = newApp({ sheets, props: { SEED_VERSION: '11', BOT_TOKEN: TOKEN } });
  const j = parseOut(api.doGet({}));
  assert.equal(j.data.synced, true, 'синк прошёл');
  assert.equal(env.props.SEED_VERSION, SEEDV, 'версия записана в свойства');
  assert.equal(env.lockCalls.held, 0, 'замок отпущен');
});

test('если замок занят — тихо уходит без синка', () => {
  const sheets = bootedBook();
  const { env, api } = newApp({ sheets, props: { SEED_VERSION: '11' }, lock: { tryLock: false } });
  const j = parseOut(api.doGet({}));
  assert.equal(j.ok, true, 'ответ всё равно успешный');
  assert.equal(j.data.synced, false, 'синк не запускался');
  assert.equal(env.props.SEED_VERSION, '11', 'версия не переписана');
});

test('ответ — валидный JSON в ASCII с mime application/json', () => {
  const { env, api } = newApp({ props: { SEED_VERSION: SEEDV }, sheets: bootedBook() });
  const out = api.doGet({});
  assert.equal(out._mime, 'application/json', 'mime');
  assert.ok(!/[-￿]/.test(out.getContent()), 'всё не-ASCII ушло как \\uXXXX');
  const { api: a2 } = newApp({ props: {} });
  const err = JSON.parse(a2.doPost({ postData: { contents: 'не json' } }).getContent());
  assert.equal(err.ok, false, 'битый POST → ok:false');
  assert.match(err.error, /Битый запрос/, 'внятный текст ошибки: ' + err.error);
});

/* =================================================================== */

console.log('\n' + '='.repeat(64));
if (notes.length) {
  console.log('ЗАМЕРЫ');
  notes.forEach(n => console.log('  · ' + n));
  console.log('='.repeat(64));
}
console.log('ИТОГО: ' + (passed + failed) + ' тестов, ОК ' + passed + ', ПРОВАЛ ' + failed);
if (failed) {
  console.log('\nПровалы:');
  failures.forEach(f => console.log('  [' + f.group + '] ' + f.name + '\n      ' +
    String(f.err && f.err.message || f.err).split('\n')[0]));
}
process.exit(failed ? 1 : 0);

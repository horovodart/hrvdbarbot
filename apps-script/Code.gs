/**
 * HOROVOD HUB · бар — API склада поверх Google Таблицы.
 *
 * Свойства скрипта (Project Settings → Script Properties):
 *   BOT_TOKEN  — токен бота от BotFather. Никогда не попадает во фронтенд и в git.
 *   ADMIN_IDS  — telegram id через запятую (необязательно). Если и лист «team», и это
 *                свойство пусты, админом становится первый, кто открыл приложение.
 *   SHEET_ID   — id таблицы (если скрипт не привязан к ней напрямую).
 *
 * Листы: products, counts, purchases, team.
 * Поля stock и items хранятся как JSON в одной ячейке.
 */

var COLS = {
  products: ['id','name','vol','cat','shape','color','cap','cost','dep','pack','min','order','note','hidden','phaseout'],
  counts:   ['id','date','by','cash','card','initial','note','source','stock'],
  purchases:['id','date','by','total','source','items'],
  returns:  ['id','date','by','amount','units','toTill','note'],
  team:     ['tg_id','name','role']
};
var JSON_FIELDS = {stock:1, items:1};
var NUM_FIELDS  = {cost:1, dep:1, pack:1, min:1, order:1, cash:1, card:1, total:1, amount:1, units:1};
var BOOL_FIELDS = {hidden:1, initial:1, phaseout:1, toTill:1};

/* ---------------- вход ---------------- */

// GET — проверка живости. Данных не отдаёт: склад доступен только на POST с подписью
// Telegram. Заодно прогоняет синхронизацию справочника, чтобы правки доезжали
// сразу после деплоя, а не ждали, пока кто-нибудь откроет приложение.
function doGet(e)  {
  return respond(function(){
    var synced = false;
    try {
      var lock = LockService.getScriptLock();
      if (lock.tryLock(30000)) {
        try { if (sheet('products').getLastRow() > 1) { syncProducts(); syncTeam(); synced = true } }
        finally { lock.releaseLock() }
      }
    } catch (err) { /* синк не критичен для проверки живости */ }
    return {alive:true, synced:synced, ts:new Date().toISOString()};
  });
}
function doPost(e) {
  return respond(function(){
    var body = {};
    try { body = JSON.parse(e.postData.contents || '{}') } catch (err) { throw new Error('Битый запрос') }
    var user = auth(body.initData);
    return handle(body.action, body.payload || {}, user);
  });
}
function respond(fn){
  var out;
  try { out = {ok:true, data: fn()} }
  catch (err) { out = {ok:false, error: String(err && err.message || err)} }
  // всё не-ASCII уходит как \uXXXX: ответ не зависит от того, какую кодировку решит применить клиент
  var json = JSON.stringify(out).replace(/[\u0080-\uFFFF]/g, function(c){
    return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
  });
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- доступ ---------------- */

function auth(initData){
  var token = prop('BOT_TOKEN');
  if (!token) throw new Error('BOT_TOKEN не задан в свойствах скрипта');
  if (!initData) throw new Error('Открой приложение через Telegram');

  var parts = String(initData).split('&'), hash = '', pairs = [];
  for (var i = 0; i < parts.length; i++){
    var eq = parts[i].indexOf('='), k = decodeURIComponent(parts[i].slice(0, eq));
    var v = decodeURIComponent(parts[i].slice(eq + 1));
    if (k === 'hash') hash = v; else pairs.push(k + '=' + v);
  }
  pairs.sort();
  var secret = Utilities.computeHmacSha256Signature(Utilities.newBlob(token).getBytes(),
                                                    Utilities.newBlob('WebAppData').getBytes());
  var sig = Utilities.computeHmacSha256Signature(Utilities.newBlob(pairs.join('\n')).getBytes(), secret);
  var hex = sig.map(function(b){ return ('0' + (b & 0xFF).toString(16)).slice(-2) }).join('');
  if (hex !== hash) throw new Error('Подпись Telegram не сошлась');

  var data = {};
  pairs.forEach(function(p){ var i = p.indexOf('='); data[p.slice(0,i)] = p.slice(i+1) });
  if (Number(data.auth_date) * 1000 < Date.now() - 24*3600*1000) throw new Error('Сессия устарела, перезапусти приложение');

  var user = JSON.parse(data.user || '{}');
  var id = String(user.id || '');
  var name = [user.first_name, user.last_name].filter(String).join(' ') || user.username || id;
  if (!allowed(id, {name:name})) throw new Error('Тебя нет в списке команды (id ' + id + ')');
  return {id:id, name:name};
}

function allowed(id, user){
  if (!id) return false;
  var team = rows('team').map(function(r){ return String(r.tg_id).trim() }).filter(String);
  if (team.length) return team.indexOf(id) >= 0;

  var admins = String(prop('ADMIN_IDS') || '').split(',').map(function(s){ return s.trim() }).filter(String);
  if (admins.length) return admins.indexOf(id) >= 0;

  // Бутстрап: список команды пуст — первый, кто вошёл через Telegram, становится админом.
  // Дальше пускает только тех, кто есть в листе «team».
  sheet('team').appendRow([id, (user && user.name) || 'первый вход', 'admin']);
  return true;
}

/* ---------------- действия ---------------- */

function handle(action, p, user){
  // list тоже под замком: иначе два одновременных запроса запускают синк дважды
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  if (action === 'list'){
    try { return listAll() } finally { lock.releaseLock() }
  }
  try {
    var who = user ? user.name : null;
    if (action === 'addPurchase'){
      insert('purchases', {id: uid('p'), date: p.date || new Date().toISOString(), by: p.by || who,
                           total: p.total, source: p.source || null, items: p.items || {}});
    } else if (action === 'addCount'){
      insert('counts', {id: uid('c'), date: p.date || new Date().toISOString(), by: p.by || who,
                        cash: p.cash, card: p.card, initial:'', note: p.note || null, source: p.source || null,
                        stock: p.stock || {}});
    } else if (action === 'addReturn'){
      insert('returns', {id: uid('r'), date: p.date || new Date().toISOString(), by: p.by || who,
                         amount: p.amount || 0, units: p.units || 0, toTill: !!p.toTill,
                         note: p.note || null});
    } else if (action === 'addProduct'){
      if (!p.id) throw new Error('Нет id товара');
      var d = p.data || {}; d.id = p.id; insert('products', d);
    } else if (action === 'updateProduct'){
      patch('products', p.id, p.patch || {});
    } else if (action === 'delete'){
      if (['products','counts','purchases','returns'].indexOf(p.col) < 0) throw new Error('Нельзя удалять из ' + p.col);
      remove(p.col, p.id);
    } else throw new Error('Неизвестное действие: ' + action);
    return listAll();
  } finally { lock.releaseLock() }
}

function listAll(){
  if (sheet('products').getLastRow() < 2) setup();   // первый запуск — заливаем стартовые данные сами
  else { try { syncProducts(); syncTeam() } catch (e) { /* склад важнее синка справочника */ } }
  var out = {};
  ['products','counts','purchases','returns'].forEach(function(name){
    var o = {};
    rows(name).forEach(function(r){ var id = r.id; delete r.id; if (id) o[id] = r });
    out[name] = o;
  });
  return out;
}

/* ---------------- таблица ---------------- */

function prop(k){ return PropertiesService.getScriptProperties().getProperty(k) }
function uid(pfx){ return pfx + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,6) }

var SHEET_ID_DEFAULT = '1EAp62lw_p1MLIDL_vFgPVupboA7DosjZ3afDUblJ6LQ';   // таблица «HOROVOD HUB · бар»
function book(){
  var id = prop('SHEET_ID') || SHEET_ID_DEFAULT;
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}
function sheet(name){
  var ss = book(), sh = ss.getSheetByName(name);
  if (!sh){ sh = ss.insertSheet(name); sh.appendRow(COLS[name]); sh.setFrozenRows(1) }
  if (sh.getLastRow() === 0){ sh.appendRow(COLS[name]); sh.setFrozenRows(1) }
  return sh;
}
function rows(name){
  var sh = sheet(name), last = sh.getLastRow();
  if (last < 2) return [];
  var head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  return sh.getRange(2,1,last-1,sh.getLastColumn()).getValues().map(function(r){
    var o = {};
    head.forEach(function(h,i){
      if (!h) return;
      var v = r[i];
      if (JSON_FIELDS[h])      { try { o[h] = v ? JSON.parse(v) : {} } catch(e){ o[h] = {} } }
      else if (v === '')         o[h] = (NUM_FIELDS[h] ? null : '');
      else if (BOOL_FIELDS[h])   o[h] = (v === true || v === 'TRUE' || v === 'да');
      else if (h === 'date')      o[h] = (v instanceof Date) ? v.toISOString() : String(v);
      else                        o[h] = v;
    });
    return o;
  }).filter(function(o){ return String(o.id || o.tg_id || '') !== '' });
}
function cell(name, key, val){
  if (JSON_FIELDS[key]) return JSON.stringify(val || {});
  if (val === null || val === undefined) return '';
  return val;
}
function insert(name, obj){
  var sh = sheet(name), head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  sh.appendRow(head.map(function(h){ return cell(name, h, obj[h]) }));
}
function findRow(name, id){
  var sh = sheet(name), last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2,1,last-1,1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return -1;
}
function patch(name, id, obj){
  var sh = sheet(name), r = findRow(name, id);
  if (r < 0) throw new Error('Не нашёл ' + id);
  var head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  head.forEach(function(h,i){
    if (h in obj) sh.getRange(r, i+1).setValue(cell(name, h, obj[h]));
  });
}
function remove(name, id){
  var r = findRow(name, id);
  if (r < 0) throw new Error('Не нашёл ' + id);
  sheet(name).deleteRow(r);
}

/* ---------------- первичная заливка ---------------- */
/** Запусти один раз вручную: создаст листы и зальёт данные из Seed.gs. */
function setup(){
  var d = SEED;
  try { book().rename('HOROVOD HUB \u00b7 \u0431\u0430\u0440') } catch (e) {}
  ['products','counts','purchases','returns','team'].forEach(function(n){ sheet(n) });
  ['products','counts','purchases'].forEach(function(name){
    var sh = sheet(name);
    if (sh.getLastRow() > 1) sh.getRange(2,1,sh.getLastRow()-1,sh.getLastColumn()).clearContent();
    Object.keys(d[name] || {}).forEach(function(id){
      var o = d[name][id]; o.id = id; insert(name, o);
    });
  });
  sheet('team'); // остаётся пустым: первый, кто откроет приложение, впишется сюда админом
  try { SpreadsheetApp.getActive().toast('Готово: ' + Object.keys(d.products).length + ' товаров') } catch (e) {}
}

/**
 * Справочник товаров (цены, тара, флаги) живёт в коде и приезжает с новой версией скрипта.
 * Подсчёты и закупки при этом не трогаются — это данные, а не настройки.
 * Цены, поправленные в приложении, синк перезапишет: справочник в коде главнее.
 * Флаг «распродаём» синк не трогает — это решение команды, а не настройка.
 */
function syncProducts(){
  var props = PropertiesService.getScriptProperties();
  if (String(props.getProperty('SEED_VERSION')) === String(SEED_VERSION)) return;
  ensureCols('products');

  // Лист переписывается целиком за одно чтение и одну запись: по ячейке выходило
  // больше семисот обращений, запрос не укладывался в лимит и успевал записать
  // половину дважды. Заодно схлопываем дубли по id, если они уже завелись.
  var sh = sheet('products'), w = sh.getLastColumn(), last = sh.getLastRow();
  var head = sh.getRange(1,1,1,w).getValues()[0];
  var raw  = last > 1 ? sh.getRange(2,1,last-1,w).getValues() : [];
  var col  = head.indexOf('id');

  var grid = [], idx = {};
  raw.forEach(function(r){
    var id = String(r[col] || '').trim();
    if (!id || idx[id] != null) return;          // пустые и повторы отбрасываем
    idx[id] = grid.length; grid.push(r);
  });

  Object.keys(SEED.products || {}).forEach(function(id){
    var o = SEED.products[id], at = idx[id];
    var row = at == null ? head.map(function(){ return '' }) : grid[at];
    head.forEach(function(h,i){
      if (h === 'id') { row[i] = id; return }
      // «распродаём» — решение команды, принятое в приложении: синком не сбрасываем
      if (h === 'phaseout' && at != null) return;
      if (h in o) row[i] = cell('products', h, o[h]);
    });
    if (at == null){ idx[id] = grid.length; grid.push(row) }
  });

  if (grid.length) sh.getRange(2,1,grid.length,w).setValues(grid);
  if (last - 1 > grid.length) sh.getRange(grid.length+2, 1, last-1-grid.length, w).clearContent();

  ensureCols('returns');
  syncTeam();
  seedReturns();
  syncSeeded('counts');        // опорные подсчёты правим вместе со справочником:
  syncSeeded('purchases');     // без этого у новых товаров нет остатка и они прячутся
  props.setProperty('SEED_VERSION', String(SEED_VERSION));
}



/** Историю сдачи тары до запуска приложения заносим один раз, из кода. */
function seedReturns(){
  if (typeof RETURNS_SEED === 'undefined') return;
  var have = {};
  rows('returns').forEach(function(r){ have[r.id] = true });
  RETURNS_SEED.forEach(function(r){
    if (have[r.id]) patch('returns', r.id, r); else insert('returns', r);
  });
}

/**
 * Обновляет строки, которые заведены из кода: опорный подсчёт, чеки из истории.
 * Ищет строго по id, поэтому подсчёты и закупки, созданные в приложении,
 * не трогает — у них id с меткой времени.
 */
function syncSeeded(name){
  var src = SEED[name] || {};
  var have = {};
  rows(name).forEach(function(r){ have[r.id] = true });
  Object.keys(src).forEach(function(id){
    var o = {}, k;
    for (k in src[id]) o[k] = src[id][k];
    o.id = id;
    if (have[id]) patch(name, id, o); else insert(name, o);
  });
}

/** Добавляет в лист «team» тех, кого ещё нет. Никого не удаляет. */
function syncTeam(){
  if (typeof TEAM_SEED === 'undefined') return;
  var have = {};
  rows('team').forEach(function(r){ have[String(r.tg_id).trim()] = true });
  var add = TEAM_SEED.filter(function(m){ return !have[String(m.id)] })
                     .map(function(m){ return [String(m.id), m.name, m.role || 'admin'] });
  if (!add.length) return;
  var sh = sheet('team');
  sh.getRange(sh.getLastRow()+1, 1, add.length, 3).setValues(add);   // одной пачкой
}

/** Дописывает в шапку листа колонки, которых там ещё нет. Данные не сдвигает. */
function ensureCols(name){
  var sh = sheet(name), last = sh.getLastColumn();
  var head = sh.getRange(1, 1, 1, last).getValues()[0];
  var add = COLS[name].filter(function(c){ return head.indexOf(c) < 0 });
  if (add.length) sh.getRange(1, last + 1, 1, add.length).setValues([add]);
}

/** Проверка без Telegram: выполни в редакторе и посмотри лог. */
function selfTest(){ Logger.log(JSON.stringify(listAll()).slice(0, 800)) }

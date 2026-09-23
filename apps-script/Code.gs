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
  counts:   ['id','date','by','cash','card','initial','note','source','stock','frozen','amnesty'],
  purchases:['id','date','by','total','source','items','receipt','prices'],
  returns:  ['id','date','by','amount','units','toTill','note'],
  team:     ['tg_id','name','role']
};
var JSON_FIELDS = {stock:1, items:1, frozen:1, prices:1};
var NUM_FIELDS  = {cost:1, dep:1, pack:1, min:1, order:1, cash:1, card:1, total:1, amount:1, units:1};
var BOOL_FIELDS = {hidden:1, initial:1, phaseout:1, toTill:1, amnesty:1};

/* ---------------- вход ---------------- */

// GET — проверка живости. Данных не отдаёт: склад доступен только на POST с подписью
// Telegram. Заодно прогоняет синхронизацию справочника, чтобы правки доезжали
// сразу после деплоя, а не ждали, пока кто-нибудь откроет приложение.
function doGet(e)  {
  return respond(function(){
    // Адрес публичный, поэтому синк тут должен быть дешёвым и безобидным:
    //  — при совпадении SEED_VERSION он выходит сразу, ничего не читая и не записывая;
    //  — замок берём на пару секунд и, если занят, молча уходим, чтобы не мешать команде;
    //  — пишутся только строки, заведённые из кода, так что подсунуть ничего нельзя.
    var synced = false;
    if (String(PropertiesService.getScriptProperties().getProperty('SEED_VERSION')) !== String(SEED_VERSION)) {
      try {
        var lock = LockService.getScriptLock();
        if (lock.tryLock(2000)) {
          try { if (sheet('products').getLastRow() > 1) { syncProducts(); syncTeam(); synced = true } }
          finally { lock.releaseLock() }
        }
      } catch (err) { /* синк не критичен для проверки живости */ }
    }
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
  var authAt = Number(data.auth_date) * 1000;
  if (!isFinite(authAt) || authAt < Date.now() - 24*3600*1000 || authAt > Date.now() + 5*60*1000)
    throw new Error('Сессия устарела, перезапусти приложение');

  var user = JSON.parse(data.user || '{}');
  var id = String(user.id || '');
  // filter(String) пропускал undefined («undefined» — правдивая строка), а join делал из него
  // пустоту: у человека без фамилии имя становилось " ", и запасные варианты не срабатывали
  var name = [user.first_name, user.last_name]
    .map(function(x){ return x == null ? '' : String(x).trim() })
    .filter(function(x){ return x })
    .join(' ') || String(user.username || '').trim() || id;
  if (!allowed(id, {name:name})) throw new Error('Тебя нет в списке команды (id ' + id + ')');
  return {id:id, name:name};
}

function allowed(id, user){
  if (!id) return false;
  // Аварийный доступ из свойств скрипта работает всегда, а не только на пустом листе
  var admins = String(prop('ADMIN_IDS') || '').split(',').map(function(s){ return s.trim() }).filter(String);
  if (admins.indexOf(id) >= 0) return true;

  var team = rows('team').map(function(r){ return String(r.tg_id).trim() }).filter(String);
  if (team.length) return team.indexOf(id) >= 0;

  // Лист пуст и аварийного списка нет — не пускаем никого: иначе админом
  // станет первый случайный человек, открывший бота

  return false;
}

/* ---------------- действия ---------------- */

function handle(action, p, user){
  var lock = LockService.getScriptLock();
  if (action === 'list'){
    // Замок нужен, только если чтение может что-то записать: первый запуск или
    // разъехавшийся сид. Иначе двое открывших приложение одновременно вставали в
    // очередь по 30 секунд — со стороны это выглядело как «грузится вечно».
    var fresh = !!(p && p.fresh);
    if (!needSeed()) {
      // попадание в кэш отвечает, вообще не открывая таблицу — проверяем его первым
      if (!fresh) { var hit = cacheGet(); if (hit) return hit }
      if (sheet('products').getLastRow() > 1) return listCached(true);
    }
    lock.waitLock(30000);
    try { dropListCache(); return listCached(true) } finally { lock.releaseLock() }
  }
  lock.waitLock(30000);
  try {
    var who = user ? user.name : null;
    if (action === 'addPurchase'){
      var pid = uid('p');
      var receipt = p.photo ? saveReceipt(p.photo, 'чек ' + (p.date || '').slice(0,10) + ' ' + pid) : '';
      // Цены с чека — главный смысл загрузки: по ним обновляется цена закупки,
      // а в карточке видно, что и с чего на что поменялось.
      var prices = {}, moved = {};
      if (p.prices && typeof p.prices === 'object') {
        var prod = {};
        rows('products').forEach(function(r){ prod[r.id] = r });
        Object.keys(p.prices).forEach(function(k){
          var np = Number(p.prices[k]);
          if (!isFinite(np) || np <= 0 || !prod[k]) return;
          var was = prod[k].cost == null ? null : Number(prod[k].cost);
          prices[k] = np;
          if (was == null || Math.abs(was - np) >= 0.005) {
            moved[k] = {was: was, now: np};
            patch('products', k, {cost: np});
          }
        });
      }
      insert('purchases', {id: pid, date: p.date || new Date().toISOString(), by: p.by || who,
                           total: p.total, source: p.source || null, items: p.items || {},
                           receipt: receipt, prices: {list: prices, moved: moved}});
    } else if (action === 'addCount'){
      ensureCols('counts');
      insert('counts', {id: uid('c'), date: p.date || new Date().toISOString(), by: p.by || who,
                        cash: p.cash, card: p.card, initial:'', note: p.note || null, source: p.source || null,
                        stock: p.stock || {}, frozen: p.frozen || null, amnesty: !!p.amnesty});
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
    } else if (action === 'getReceipt'){
      var buy = rows('purchases').filter(function(r){ return r.id === p.id })[0];
      if (!buy) throw new Error('Закупка не найдена');
      return readReceipt(buy.receipt);
    } else throw new Error('Неизвестное действие: ' + action);
    dropListCache();
    return listCached(true);
  } finally { lock.releaseLock() }
}

/* Склад в кэше скрипта.

   Apps Script выполняет обращения к одному скрипту по очереди, и каждое чтение
   складывается из восьми походов в таблицу — под одновременной нагрузкой это
   давало до сорока секунд ожидания. Ответ у всех одинаковый, поэтому держим
   его готовым: попадание в кэш отвечает, вообще не открывая таблицу.
   Любая запись кэш сбрасывает, так что несвежих цифр команда не увидит. */
var LIST_KEY = 'list-v1', LIST_TTL = 90, LIST_MAX = 90000;

function cacheGet(){
  try { var hit = CacheService.getScriptCache().get(LIST_KEY); return hit ? JSON.parse(hit) : null }
  catch (e) { return null }   // битый кэш — просто читаем лист
}

function listCached(fresh){
  if (!fresh) { var hit = cacheGet(); if (hit) return hit }
  var cache = CacheService.getScriptCache();
  var data = listAll();
  // в кэш влезает 100 КБ; если склад перерос — просто живём без него
  try { var s = JSON.stringify(data); if (s.length < LIST_MAX) cache.put(LIST_KEY, s, LIST_TTL) } catch (e) {}
  return data;
}

function dropListCache(){ try { CacheService.getScriptCache().remove(LIST_KEY) } catch (e) {} }

/* Фото чека храним в Telegram, а не на Диске.

   Диск через Apps Script требует доступа ко ВСЕМУ Диску владельца: узкого права
   «только свои файлы» скрипту не выдают, потому что разрешения он получает по тем
   службам, которые видит в коде, а мы ходили по сети. Ради двух чеков в месяц
   открывать всю почту-документы-фотографии — плохая сделка.

   Telegram хранит фотографии сам, бесплатно и бессрочно. Токен бота у нас уже есть,
   право ходить в сеть — тоже. В строку закупки пишем file_id, само фото приложение
   тянет по запросу. Куда складывать — свойство RECEIPTS_CHAT, по умолчанию первый
   админ из ADMIN_IDS: у него в переписке с ботом заодно копится архив чеков. */

function receiptsChat(){
  var c = prop('RECEIPTS_CHAT');
  if (c) return String(c).trim();
  var admins = String(prop('ADMIN_IDS') || '').split(',').map(function(x){ return x.trim() }).filter(String);
  if (!admins.length) throw new Error('Некуда сохранить чек: задай RECEIPTS_CHAT или ADMIN_IDS');
  return admins[0];
}

function tg(method, payload, isMultipart){
  var token = prop('BOT_TOKEN');
  if (!token) throw new Error('Нет токена бота');
  var opts = {muteHttpExceptions: true};
  if (isMultipart) { opts.method = 'post'; opts.payload = payload }
  else { opts.method = 'post'; opts.contentType = 'application/json'; opts.payload = JSON.stringify(payload) }
  var r = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, opts);
  var j = JSON.parse(r.getContentText());
  if (!j.ok) throw new Error('Telegram: ' + (j.description || r.getResponseCode()));
  return j.result;
}

// photo — строка вида data:image/jpeg;base64,…
function saveReceipt(photo, caption){
  if (!photo) return '';
  var m = String(photo).match(/^data:([\w\/+.-]+);base64,(.+)$/);
  if (!m) throw new Error('Фото чека в непонятном виде');
  var mime = m[1];
  if (mime.indexOf('image/') !== 0) throw new Error('Чек должен быть картинкой');
  var bytes = Utilities.base64Decode(m[2]);
  if (bytes.length > 8 * 1024 * 1024) throw new Error('Фото чека слишком большое');

  var ext = mime.split('/')[1].replace('jpeg', 'jpg');
  var res = tg('sendPhoto', {
    chat_id: receiptsChat(),
    caption: String(caption || '').slice(0, 900),
    photo: Utilities.newBlob(bytes, mime, 'чек.' + ext)
  }, true);
  // берём самый крупный из присланных размеров
  var sizes = res.photo || [];
  if (!sizes.length) throw new Error('Telegram не вернул фото');
  return sizes[sizes.length - 1].file_id;
}

function readReceipt(id){
  if (!id) throw new Error('У этой закупки нет фото чека');
  var f = tg('getFile', {file_id: String(id)});
  var url = 'https://api.telegram.org/file/bot' + prop('BOT_TOKEN') + '/' + f.file_path;
  var r = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
  if (r.getResponseCode() !== 200) throw new Error('Не вышло забрать фото чека');
  var blob = r.getBlob();
  return {mime: blob.getContentType() || 'image/jpeg', data: Utilities.base64Encode(blob.getBytes()),
          name: String(f.file_path || 'чек').split('/').pop()};
}

function listAll(){
  if (sheet('products').getLastRow() < 2) setup();   // первый запуск — заливаем стартовые данные сами
  // syncTeam раньше выполнялся на каждое чтение: это лишние записи в лист на
  // ровном месте. Справочник трогаем только когда сид действительно разъехался.
  else if (needSeed()) { try { syncProducts(); syncTeam() } catch (e) { /* склад важнее синка справочника */ } }
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
      if (JSON_FIELDS[h])      { try { o[h] = v ? JSON.parse(v) : (h === 'frozen' ? null : {}) } catch(e){ o[h] = null } }
      else if (v === '')         o[h] = (NUM_FIELDS[h] ? null : '');
      else if (NUM_FIELDS[h])    { var n = Number(String(v).replace(',', '.')); o[h] = isFinite(n) ? n : null }
      else if (BOOL_FIELDS[h])   o[h] = (v === true || v === 'TRUE' || v === 'да');
      else if (h === 'date')      o[h] = (v instanceof Date) ? v.toISOString() : String(v);
      else                        o[h] = v;
    });
    return o;
  }).filter(function(o){ return String(o.id || o.tg_id || '') !== '' });
}
function cell(name, key, val){
  if (JSON_FIELDS[key]) return safeText(JSON.stringify(val || {}));
  if (val === null || val === undefined) return '';
  return typeof val === 'string' ? safeText(val) : val;
}

/** Таблица считает формулой всё, что начинается с = + - @. Имя из Telegram — не формула. */
function safeText(v){
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}
function insert(name, obj){
  var sh = sheet(name), head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  sh.appendRow(head.map(function(h){ return cell(name, h, obj[h]) }));
}
function findRow(name, id){
  var sh = sheet(name), last = sh.getLastRow();
  if (last < 2) return -1;
  var head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  var col = head.indexOf('id') + 1;                 // id не обязан быть первой колонкой
  if (col < 1) return -1;
  var ids = sh.getRange(2,col,last-1,1).getValues();
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
  // Справочник можно перезаливать: он весь из кода. Подсчёты, закупки и сдачи тары —
  // живые данные команды, их только досыпаем по id и никогда не чистим.
  var sh = sheet('products');
  if (sh.getLastRow() > 1) sh.getRange(2,1,sh.getLastRow()-1,sh.getLastColumn()).clearContent();
  Object.keys(d.products || {}).forEach(function(id){
    var o = d.products[id]; o.id = id; insert('products', o);
  });
  syncSeeded('counts');
  syncSeeded('purchases');
  sheet('team'); // остаётся пустым: первый, кто откроет приложение, впишется сюда админом
  try { SpreadsheetApp.getActive().toast('Готово: ' + Object.keys(d.products).length + ' товаров') } catch (e) {}
}

/**
 * Справочник товаров (цены, тара, флаги) живёт в коде и приезжает с новой версией скрипта.
 * Подсчёты и закупки при этом не трогаются — это данные, а не настройки.
 * Цены, поправленные в приложении, синк перезапишет: справочник в коде главнее.
 * Флаг «распродаём» синк не трогает — это решение команды, а не настройка.
 */
// Сид разъехался с таблицей? Только тогда имеет смысл что-то писать.
function needSeed(){
  return String(PropertiesService.getScriptProperties().getProperty('SEED_VERSION')) !== String(SEED_VERSION);
}

function syncProducts(){
  var props = PropertiesService.getScriptProperties();
  if (!needSeed()) return;
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
  retireSeeded();              // и убираем то, что из кода уже удалили
  props.setProperty('SEED_VERSION', String(SEED_VERSION));
}



/**
 * Убирает строки, заведённые из кода и с тех пор отменённые.
 * Синк обновляет по id и ничего не удаляет, поэтому переименованная или
 * пересмотренная запись иначе остаётся в листе и задваивает итоги.
 */
function retireSeeded(){
  if (typeof SEED_RETIRE === 'undefined') return;
  Object.keys(SEED_RETIRE).forEach(function(name){
    SEED_RETIRE[name].forEach(function(id){
      if (findRow(name, id) > 0) remove(name, id);
    });
  });
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
  var sh = sheet('team'), w = sh.getLastColumn();
  var head = sh.getRange(1,1,1,w).getValues()[0];
  var grid = add.map(function(m){
    return head.map(function(h){ return h === 'tg_id' ? m[0] : h === 'name' ? m[1] : h === 'role' ? m[2] : '' });
  });
  sh.getRange(sh.getLastRow()+1, 1, grid.length, w).setValues(grid);   // одной пачкой
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

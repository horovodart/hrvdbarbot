/**
 * Мок Google Apps Script + загрузчик apps-script/Code.gs и apps-script/Seed.gs.
 *
 * Код грузится через new Function(...) — тот же realm, что и тесты, поэтому
 * `v instanceof Date` внутри rows() работает честно, а между тестами состояние
 * полностью свежее.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const CODE = fs.readFileSync(path.join(ROOT, 'apps-script/Code.gs'), 'utf8');
const SEED_SRC = fs.readFileSync(path.join(ROOT, 'apps-script/Seed.gs'), 'utf8');

/* ---------- счётчик обращений к листам ---------- */

function makeStats() {
  const s = {
    total: 0,
    getValues: 0, setValues: 0, setValue: 0, appendRow: 0,
    clearContent: 0, deleteRow: 0,
    getLastRow: 0, getLastColumn: 0, getSheetByName: 0, insertSheet: 0,
    setFrozenRows: 0, getRange: 0,
    bySheet: {},
    log: []
  };
  s.bump = function (kind, sheetName) {
    s[kind]++;
    s.total++;
    const b = s.bySheet[sheetName] || (s.bySheet[sheetName] = { total: 0 });
    b[kind] = (b[kind] || 0) + 1;
    b.total++;
    s.log.push(sheetName + '.' + kind);
  };
  // «обращения к данным» — чтения и записи ячеек, без метаданных
  Object.defineProperty(s, 'dataOps', {
    get() { return s.getValues + s.setValues + s.setValue + s.appendRow + s.clearContent + s.deleteRow; }
  });
  s.dataOpsOf = function (name) {
    const b = s.bySheet[name];
    if (!b) return 0;
    return (b.getValues || 0) + (b.setValues || 0) + (b.setValue || 0) +
           (b.appendRow || 0) + (b.clearContent || 0) + (b.deleteRow || 0);
  };
  s.reset = function () {
    ['total', 'getValues', 'setValues', 'setValue', 'appendRow', 'clearContent',
     'deleteRow', 'getLastRow', 'getLastColumn', 'getSheetByName', 'insertSheet',
     'setFrozenRows', 'getRange'].forEach(k => { s[k] = 0; });
    s.bySheet = {};
    s.log = [];
  };
  return s;
}

/* ---------- лист ---------- */

class FakeSheet {
  constructor(name, grid, stats) {
    this.name = name;
    this.stats = stats;
    this.d = (grid || []).map(r => r.slice());
    this.frozen = 0;
  }
  getName() { return this.name; }
  _ensure(rows, cols) {
    while (this.d.length < rows) this.d.push([]);
    const width = Math.max(cols, this.d.reduce((m, r) => Math.max(m, r.length), 0));
    for (const r of this.d) while (r.length < width) r.push('');
  }
  _isEmpty(v) { return v === '' || v === null || v === undefined; }
  getLastRow() {
    this.stats.bump('getLastRow', this.name);
    for (let i = this.d.length - 1; i >= 0; i--) {
      if (this.d[i].some(v => !this._isEmpty(v))) return i + 1;
    }
    return 0;
  }
  getLastColumn() {
    this.stats.bump('getLastColumn', this.name);
    let last = 0;
    for (const r of this.d) {
      for (let c = r.length - 1; c >= 0; c--) {
        if (!this._isEmpty(r[c])) { if (c + 1 > last) last = c + 1; break; }
      }
    }
    return last;
  }
  setFrozenRows(n) { this.stats.bump('setFrozenRows', this.name); this.frozen = n; return this; }
  appendRow(arr) {
    this.stats.bump('appendRow', this.name);
    const at = this._lastRowSilent();
    this._ensure(at + 1, arr.length);
    for (let c = 0; c < arr.length; c++) this.d[at][c] = arr[c];
    return this;
  }
  _lastRowSilent() {
    for (let i = this.d.length - 1; i >= 0; i--) {
      if (this.d[i].some(v => !this._isEmpty(v))) return i + 1;
    }
    return 0;
  }
  deleteRow(r) {
    this.stats.bump('deleteRow', this.name);
    if (r < 1) throw new Error('deleteRow: строка ' + r);
    this.d.splice(r - 1, 1);
    return this;
  }
  getRange(r, c, nr, nc) {
    this.stats.bump('getRange', this.name);
    if (!(r >= 1) || !(c >= 1)) throw new Error('getRange: некорректные координаты ' + r + ',' + c);
    const rows = nr === undefined ? 1 : nr;
    const cols = nc === undefined ? 1 : nc;
    if (rows < 1 || cols < 1) throw new Error('getRange: размер ' + rows + 'x' + cols);
    const sh = this;
    return {
      getValues() {
        sh.stats.bump('getValues', sh.name);
        const out = [];
        for (let i = 0; i < rows; i++) {
          const src = sh.d[r - 1 + i] || [];
          const row = [];
          for (let j = 0; j < cols; j++) {
            const v = src[c - 1 + j];
            row.push(v === undefined || v === null ? '' : v);
          }
          out.push(row);
        }
        return out;                       // копия, как в настоящем GAS
      },
      setValues(vals) {
        sh.stats.bump('setValues', sh.name);
        if (!Array.isArray(vals) || vals.length !== rows)
          throw new Error('setValues: строк ' + (vals && vals.length) + ', диапазон ' + rows);
        for (const row of vals) {
          if (!Array.isArray(row) || row.length !== cols)
            throw new Error('setValues: колонок ' + (row && row.length) + ', диапазон ' + cols);
        }
        sh._ensure(r - 1 + rows, c - 1 + cols);
        for (let i = 0; i < rows; i++)
          for (let j = 0; j < cols; j++) sh.d[r - 1 + i][c - 1 + j] = vals[i][j];
        return this;
      },
      setValue(v) {
        sh.stats.bump('setValue', sh.name);
        sh._ensure(r - 1 + rows, c - 1 + cols);
        for (let i = 0; i < rows; i++)
          for (let j = 0; j < cols; j++) sh.d[r - 1 + i][c - 1 + j] = v;
        return this;
      },
      clearContent() {
        sh.stats.bump('clearContent', sh.name);
        sh._ensure(r - 1 + rows, c - 1 + cols);
        for (let i = 0; i < rows; i++)
          for (let j = 0; j < cols; j++) sh.d[r - 1 + i][c - 1 + j] = '';
        return this;
      },
      setFontWeight() { return this; },
      setNumberFormat() { return this; }
    };
  }
  /** удобство для тестов: снимок без счётчиков */
  dump() { return this.d.map(r => r.slice()); }
}

/* ---------- книга ---------- */

class FakeBook {
  constructor(sheets, stats) {
    this.stats = stats;
    this.sheets = {};
    this.order = [];
    this.toasts = [];
    this.title = 'книга';
    Object.keys(sheets || {}).forEach(n => {
      this.sheets[n] = new FakeSheet(n, sheets[n], stats);
      this.order.push(n);
    });
  }
  getSheetByName(n) {
    this.stats.bump('getSheetByName', n);
    return this.sheets[n] || null;
  }
  insertSheet(n) {
    this.stats.bump('insertSheet', n);
    if (this.sheets[n]) throw new Error('лист ' + n + ' уже есть');
    this.sheets[n] = new FakeSheet(n, [], this.stats);
    this.order.push(n);
    return this.sheets[n];
  }
  getSheets() { return this.order.map(n => this.sheets[n]); }
  rename(t) { this.title = t; return this; }
  getName() { return this.title; }
  toast(msg) { this.toasts.push(msg); }
}

/* ---------- окружение ---------- */

function bytes(x) {
  if (typeof x === 'string') return Buffer.from(x, 'utf8');
  if (Buffer.isBuffer(x)) return x;
  if (Array.isArray(x)) return Buffer.from(x.map(b => b & 0xFF));
  throw new Error('не байты: ' + typeof x);
}
function signed(buf) {
  const out = [];
  for (const b of buf) out.push(b > 127 ? b - 256 : b);   // GAS отдаёт знаковые байты
  return out;
}

/**
 * @param {{sheets?:object, props?:object, lock?:{tryLock?:boolean}}} opts
 */
export function makeEnv(opts = {}) {
  const stats = makeStats();
  const book = new FakeBook(opts.sheets || {}, stats);
  const props = Object.assign({}, opts.props || {});
  const lockCalls = { waitLock: 0, tryLock: 0, releaseLock: 0, held: 0 };

  const SpreadsheetApp = {
    openById(id) { SpreadsheetApp.lastId = id; return book; },
    getActiveSpreadsheet() { return book; },
    getActive() { return book; },
    MimeType: { JSON: 'application/json' }
  };
  const PropertiesService = {
    getScriptProperties() {
      return {
        getProperty(k) { return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null; },
        setProperty(k, v) { props[k] = String(v); return this; },
        deleteProperty(k) { delete props[k]; return this; },
        getProperties() { return Object.assign({}, props); }
      };
    },
    getUserProperties() { return PropertiesService.getScriptProperties(); }
  };
  const lockObj = {
    waitLock(ms) { lockCalls.waitLock++; lockCalls.held++; return true; },
    tryLock(ms) {
      lockCalls.tryLock++;
      const ok = opts.lock && opts.lock.tryLock === false ? false : true;
      if (ok) lockCalls.held++;
      return ok;
    },
    releaseLock() { lockCalls.releaseLock++; lockCalls.held--; },
    hasLock() { return lockCalls.held > 0; }
  };
  const LockService = { getScriptLock: () => lockObj, getDocumentLock: () => lockObj };

  /* CacheService: хранилище в памяти + счётчики, чтобы тесты видели попадания */
  const cacheStore = new Map();
  const cacheCalls = { get: 0, put: 0, remove: 0, hits: 0 };
  const cacheObj = {
    get(k) { cacheCalls.get++; const v = cacheStore.has(k) ? cacheStore.get(k) : null; if (v != null) cacheCalls.hits++; return v },
    put(k, v, ttl) { cacheCalls.put++; cacheStore.set(k, String(v)); return null },
    remove(k) { cacheCalls.remove++; cacheStore.delete(k); return null }
  };
  const CacheService = { getScriptCache: () => cacheObj, getUserCache: () => cacheObj, getDocumentCache: () => cacheObj };

  /* DriveApp: папки и файлы в памяти */
  const drive = { folders: new Map(), files: new Map(), seq: 0 };
  const mkFile = (blob, name) => {
    const id = 'file-' + (++drive.seq);
    const f = { id, name, blob,
      getId: () => id, getName: () => name, getBlob: () => blob };
    drive.files.set(id, f);
    return f;
  };
  const mkFolder = (name) => {
    const fold = { name, getName: () => name,
      createFile: (blob) => mkFile(blob, blob.getName ? blob.getName() : name) };
    drive.folders.set(name, fold);
    return fold;
  };
  const DriveApp = {
    getFoldersByName(n) {
      const has = drive.folders.has(n);
      let used = false;
      return { hasNext: () => has && !used, next: () => { used = true; return drive.folders.get(n) } };
    },
    createFolder: (n) => mkFolder(n),
    getFileById(id) {
      const f = drive.files.get(String(id));
      if (!f) throw new Error('Файл не найден: ' + id);
      return f;
    }
  };

  const Utilities = {
    newBlob(s, mime, name) {
      const raw = (s && s.__bytes) ? s.__bytes : bytes(s);
      return {
        __bytes: raw,
        getBytes: () => signed(raw),
        getDataAsString: () => String(s),
        getContentType: () => mime || 'application/octet-stream',
        getName: () => name || 'blob'
      };
    },
    base64Encode(b) {
      const arr = (b && b.__bytes) ? b.__bytes : (Array.isArray(b) ? b.map(x => x & 0xff) : bytes(b));
      return Buffer.from(Uint8Array.from(arr)).toString('base64');
    },
    base64Decode(str) {
      const buf = Buffer.from(String(str), 'base64');
      const out = Array.from(buf).map(x => (x > 127 ? x - 256 : x));   // Apps Script отдаёт знаковые байты
      out.__bytes = Array.from(buf);
      return out;
    },
    computeHmacSha256Signature(value, key) {
      return signed(crypto.createHmac('sha256', bytes(key)).update(bytes(value)).digest());
    },
    computeDigest() { throw new Error('не замокано'); },
    sleep() {}
  };

  const outputs = [];
  const ContentService = {
    MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
    createTextOutput(s) {
      const o = {
        _content: String(s), _mime: null,
        setMimeType(m) { o._mime = m; return o; },
        getContent() { return o._content; }
      };
      outputs.push(o);
      return o;
    }
  };
  const logs = [];
  const Logger = { log: (m) => logs.push(String(m)) };

  return {
    stats, book, props, lockCalls, cacheCalls, cacheStore, drive, outputs, logs,
    globals: { SpreadsheetApp, PropertiesService, LockService, CacheService, DriveApp, Utilities, ContentService, Logger },
    sheet: (n) => book.sheets[n],
    dump: (n) => (book.sheets[n] ? book.sheets[n].dump() : null)
  };
}

/* ---------- загрузка Code.gs + Seed.gs ---------- */

// только объявления верхнего уровня — с нулевым отступом
const NAME_RE = /^(?:function\s+([A-Za-z_$][\w$]*)|var\s+([A-Za-z_$][\w$]*)\s*=)/gm;
function topLevelNames(src) {
  const names = new Set();
  let m;
  NAME_RE.lastIndex = 0;
  while ((m = NAME_RE.exec(src))) names.add(m[1] || m[2]);
  return names;
}
const NAMES = [...new Set([...topLevelNames(SEED_SRC), ...topLevelNames(CODE)])];

const GLOBAL_NAMES = ['SpreadsheetApp', 'PropertiesService', 'LockService', 'CacheService', 'DriveApp', 'Utilities', 'ContentService', 'Logger'];

/**
 * Загружает серверный код на переданном окружении и возвращает все его
 * функции и переменные верхнего уровня.
 */
export function load(env) {
  const body = SEED_SRC + '\n;\n' + CODE + '\n;\nreturn {' + NAMES.map(n => n + ':' + n).join(',') + '};';
  let factory;
  try {
    factory = new Function(...GLOBAL_NAMES, body);
  } catch (e) {
    throw new Error('Код не парсится: ' + e.message);
  }
  return factory(...GLOBAL_NAMES.map(n => env.globals[n]));
}

export function newApp(opts = {}) {
  const env = makeEnv(opts);
  const api = load(env);
  return { env, api };
}

export { CODE, SEED_SRC, NAMES };

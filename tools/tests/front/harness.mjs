/* Песочница для app.js: грузим настоящий файл в node:vm с минимальными заглушками
   браузера. Код app.js на диске не меняется — правка происходит только в памяти
   (добавляется экспорт внутренних мелких функций в window.__fn). */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/* Универсальная заглушка DOM-узла: возвращает саму себя на любое обращение,
   вызывается как функция, молча глотает присваивания. */
function node(){
  const cache = Object.create(null);
  const t = function(){};
  return new Proxy(t, {
    get(_, k){
      if(k === "then") return undefined;                  // не притворяться промисом
      if(k === Symbol.toPrimitive) return () => "";
      if(k === Symbol.iterator) return function*(){};
      if(k === "length") return 0;
      if(!(k in cache)) cache[k] = node();
      return cache[k];
    },
    set(){ return true },
    has(){ return true },
    apply(){ return node() }
  });
}

export function loadHub({ now = "2026-09-21T12:00:00.000Z", config = {} } = {}){
  const src = readFileSync(path.join(ROOT, "app.js"), "utf8");

  // Внутренние однострочники (eur/dec/…) наружу не экспортируются — докидываем
  // экспорт строкой, чтобы тестировать ровно те же функции, что живут в замыкании.
  // Цепляемся за начало строки, а не за неё целиком: набор отлаживаемых функций
  // в app.js меняется, и харнесс не должен падать от каждого добавления.
  const HOOK = `window.__hub = {S, model`;
  if(!src.includes(HOOK)) throw new Error("не нашёл строку экспорта __hub в app.js — харнесс устарел");
  const line = src.slice(src.indexOf(HOOK)).split("\n")[0];
  const patched = src.replace(line, line + `\nwindow.__fn = {eur, dec, days, plural, num, isFree, esc};`);

  const FIXED = new Date(now).getTime();
  class FakeDate extends Date {
    constructor(...a){ if(a.length === 0) super(FIXED); else super(...a) }
    static now(){ return FIXED }
  }

  const sandbox = {
    console, Date: FakeDate, Math, JSON, parseFloat, parseInt, isFinite, isNaN,
    setTimeout, clearTimeout, Promise, fetch: () => new Promise(()=>{}),
    location: { search: "?debug=1", href: "http://local/?debug=1" },
    localStorage: (() => { const m = new Map(); return {
      getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k,v) => m.set(k, String(v)),
      removeItem: k => m.delete(k), clear: () => m.clear() } })(),
    document: Object.assign(node(), { querySelector: () => node(), addEventListener: () => {},
                                      createElement: () => node(), body: node() }),
    addEventListener: () => {},
    // API.list() навсегда «висит»: стартовый IIFE не доберётся до render(),
    // модель дергаем руками.
    API: { list: () => new Promise(()=>{}), live: () => false }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  // настоящий config.js, а не его копия — потом точечно перекрываем
  vm.runInContext(readFileSync(path.join(ROOT, "config.js"), "utf8"), ctx, { filename: "config.js" });
  Object.assign(sandbox.window.HUB_CONFIG, config);
  const HUB_CONFIG = sandbox.window.HUB_CONFIG;
  vm.runInContext(patched, ctx, { filename: "app.js" });

  if(!sandbox.__hub) throw new Error("app.js не выставил window.__hub");
  return { hub: sandbox.__hub, fn: sandbox.__fn, C: HUB_CONFIG, sandbox };
}

/* Удобная обёртка: положить данные и посчитать. */
export function compute(data, opts = {}){
  const { hub, fn, C } = loadHub(opts);
  hub.S.products  = data.products  || [];
  hub.S.counts    = data.counts    || [];
  hub.S.purchases = data.purchases || [];
  hub.S.returns   = data.returns   || [];
  return { M: hub.model(), fn, C, S: hub.S };
}

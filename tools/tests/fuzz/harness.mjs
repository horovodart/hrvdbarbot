/* Минимальные заглушки браузера, чтобы выполнить app.js в Node и получить window.__hub.
   Ничего в app.js не меняем — только окружение вокруг. */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../../..");

function stubEl(){
  const el = {
    dataset:{}, style:{}, value:"", textContent:"", innerHTML:"", checked:false,
    classList:{ add(){}, remove(){}, toggle(){}, contains(){ return false } },
    addEventListener(){}, removeEventListener(){}, appendChild(){}, remove(){},
    querySelector(){ return stubEl() }, querySelectorAll(){ return [] },
    closest(){ return null }, focus(){}, blur(){}, scrollIntoView(){},
    getBoundingClientRect(){ return {top:0,left:0,width:0,height:0} }
  };
  return el;
}

export function boot(){
  globalThis.window = globalThis;
  globalThis.document = {
    querySelector(){ return stubEl() },
    querySelectorAll(){ return [] },
    createElement(){ return stubEl() },
    addEventListener(){},
    body: stubEl(),
    documentElement: stubEl()
  };
  globalThis.location = { search: "?debug=1", href: "http://localhost/?debug=1" };
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.scrollY = 0;
  globalThis.localStorage = {
    _m:new Map(),
    getItem(k){ return this._m.has(k) ? this._m.get(k) : null },
    setItem(k,v){ this._m.set(k,String(v)) },
    removeItem(k){ this._m.delete(k) }
  };
  globalThis.fetch = () => new Promise(()=>{});          // никуда не ходим
  globalThis.Telegram = undefined;

  // config.js — настоящий, из проекта
  vm.runInThisContext(fs.readFileSync(path.join(ROOT,"config.js"),"utf8"), {filename:"config.js"});
  // API не нужен: list() повисает, стартовый IIFE просто не доходит до render()
  globalThis.window.API = { live:()=>false, list:()=>new Promise(()=>{}) };

  vm.runInThisContext(fs.readFileSync(path.join(ROOT,"app.js"),"utf8"), {filename:"app.js"});

  if(!globalThis.window.__hub) throw new Error("window.__hub не появился — проверь заглушки");
  return globalThis.window.__hub;
}

/* Замораживаем время: new Date() без аргументов = фиксированный момент,
   разбор строк работает как обычно. */
const RealDate = Date;
export function freezeTime(iso){
  const ms = RealDate.parse(iso);
  class FrozenDate extends RealDate {
    constructor(...a){ if(a.length === 0) super(ms); else super(...a) }
    static now(){ return ms }
  }
  globalThis.Date = FrozenDate;
  return ms;
}
export function unfreezeTime(){ globalThis.Date = RealDate }

/* Ровно то же преобразование, что делает api.js norm(): словарь → массив с id. */
export function norm(d){
  const m = o => Object.entries(o || {}).map(([id,v]) => ({id, ...v}));
  return { products:m(d.products), counts:m(d.counts), purchases:m(d.purchases), returns:m(d.returns) };
}

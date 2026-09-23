/* Слой данных. Продакшн — Google Apps Script, демо — локальный JSON + localStorage.
   Каждый запрос несёт Telegram.WebApp.initData, проверка подписи и белый список — на стороне скрипта. */
window.API = (function(){
  const C = window.HUB_CONFIG;
  const TG = window.Telegram?.WebApp;
  const LS = "hub-bar-demo-v1";
  const live = () => !!C.API;

  // Демо-состояние живёт в браузере и переживает деплой. Если приложение боевое —
  // стираем его сразу: иначе старый локальный склад однажды всплывёт вместо настоящего.
  if (live()) { try { localStorage.removeItem(LS) } catch(e){} }

  const readLocal = () => { try { return JSON.parse(localStorage.getItem(LS)) || null } catch(e){ return null } };
  const writeLocal = d => { try { localStorage.setItem(LS, JSON.stringify(d)) } catch(e){} };

  // Apps Script отвечает через перенаправление, и изредка оттуда прилетает пустое
  // тело или HTML-заглушка Google вместо JSON. Один такой сбой не должен выглядеть
  // как поломка склада, поэтому пробуем ещё пару раз.
  const wait = ms => new Promise(r => setTimeout(r, ms));

  const flaky = (e, ms) => { const x = new Error(e); x.retry = true; x.wait = ms; return x };

  async function once(action, payload){
    const r = await fetch(C.API, {
      method:"POST",
      headers:{"Content-Type":"text/plain;charset=utf-8"}, // simple request — без preflight
      body: JSON.stringify({ action, payload, initData: TG?.initData || "" })
    });
    // Ответ прилетает через перенаправление Google, и сама эта ссылка иногда
    // отдаёт 404 или 5xx, хотя скрипт отработал. Такой код — повод повторить,
    // а не показывать команде «склад не загрузился».
    if(!r.ok) throw flaky("HTTP " + r.status);
    const t = await r.text();
    let j;
    try { j = JSON.parse(t) }
    catch(e){ throw flaky("сервер ответил не по делу") }
    if(!j.ok) throw new Error(j.error || "Ошибка сервера");   // ошибка по делу — повторять нечего
    return j.data;
  }

  async function post(action, payload){
    if(!live()) return demo(action, payload);
    let last;
    for(let i = 0; i < 4; i++){
      try { return await once(action, payload) }
      catch(e){
        if(!e.retry && !(e instanceof TypeError)) throw e;   // «тебя нет в списке» не повторяем
        last = e;
        if(i < 3) await wait(800 * (i + 1));
      }
    }
    throw new Error("Сервер не отвечает (" + (last && last.message || "?") + "). Попробуй ещё раз.");
  }

  /* ---- демо-режим: то же API, но поверх локального файла ---- */
  let cache = null;
  async function base(){
    if(cache) return cache;
    const local = readLocal();
    if(local){ cache = local; return cache; }
    const r = await fetch(C.SEED, {cache:"no-store"});
    cache = await r.json();
    return cache;
  }
  const uid = p => p + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  async function demo(action, p){
    const d = await base();
    if(action === "list") return d;
    if(action === "addPurchase")  d.purchases[uid("p")] = p;
    if(action === "addReturn")    (d.returns ||= {})[uid("r")] = p;
    if(action === "addCount")     d.counts[uid("c")] = p;
    if(action === "addProduct")   d.products[p.id] = p.data;
    if(action === "updateProduct")Object.assign(d.products[p.id] ||= {}, p.patch);
    if(action === "delete")       delete d[p.col]?.[p.id];
    writeLocal(d);
    return d;
  }

  const norm = d => ({
    products:  Object.entries(d.products  || {}).map(([id,v]) => ({id, ...v})),
    counts:    Object.entries(d.counts    || {}).map(([id,v]) => ({id, ...v})),
    purchases: Object.entries(d.purchases || {}).map(([id,v]) => ({id, ...v})),
    returns:   Object.entries(d.returns   || {}).map(([id,v]) => ({id, ...v})),
    live: live()
  });

  return {
    live,
    // fresh — кнопка «обновить»: минуя кэш скрипта, прямо из таблицы
    async list(fresh){ return norm(await post("list", fresh ? {fresh:true} : {})) },
    async addPurchase(x){ return norm(await post("addPurchase", x)) },
    // фото чека тянем только когда карточку открыли: оно тяжёлое, в общий список не кладём
    async receipt(id){ return post("getReceipt", {id}) },
    async addReturn(x){ return norm(await post("addReturn", x)) },
    async addCount(x){ return norm(await post("addCount", x)) },
    async addProduct(id, data){ return norm(await post("addProduct", {id, data})) },
    async updateProduct(id, patch){ return norm(await post("updateProduct", {id, patch})) },
    async del(col, id){ return norm(await post("delete", {col, id})) },
    resetDemo(){ localStorage.removeItem(LS); cache = null; }
  };
})();

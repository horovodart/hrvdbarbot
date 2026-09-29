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

  // Запрос не должен висеть вечно: раньше запись закупки шла шесть минут, и кнопка
  // так и оставалась бледной. По таймауту — повтор с тем же номером запроса,
  // а сервер по номеру не заведёт дубль. Фото грузится дольше — ему больше времени.
  const LIMIT = {uploadReceipt: 150000, parseReceipt: 90000, getReceipt: 25000};   // чек из кэша — секунды; завис — переспросить
  const SHAPE = {
    list: d => !!(d && d.products),
    getReceipt: d => !!(d && typeof d.data === "string" && d.data.length > 0 && /^image\//.test(d.mime || "")),
    uploadReceipt: d => !!(d && d.receipt)
  };
  async function once(action, payload){
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const tm = ctl ? setTimeout(() => ctl.abort(), LIMIT[action] || 60000) : null;
    let r;
    try {
      r = await fetch(C.API, {
        method:"POST", signal: ctl?.signal,
        headers:{"Content-Type":"text/plain;charset=utf-8"}, // simple request — без preflight
        body: JSON.stringify({ action, payload, initData: TG?.initData || "" })
      });
    } catch(e){
      if(e && e.name === "AbortError") throw flaky("сервер долго не отвечает");
      throw e;
    } finally { if(tm) clearTimeout(tm) }
    // Ответ прилетает через перенаправление Google, и сама эта ссылка иногда
    // отдаёт 404 или 5xx, хотя скрипт отработал. Такой код — повод повторить,
    // а не показывать команде «склад не загрузился».
    if(!r.ok) throw flaky("HTTP " + r.status);
    const t = await r.text();
    let j;
    try { j = JSON.parse(t) }
    catch(e){ throw flaky("сервер ответил не по делу") }
    if(!j.ok) throw new Error(j.error || "Ошибка сервера");   // ошибка по делу — повторять нечего
    // Перенаправление Google изредка приносит ответ на другой запрос — например,
    // служебное «живой» вместо фото чека. Отдать его дальше нельзя: битая картинка
    // легла бы в телефон навсегда. Такой ответ — тоже повод повторить.
    const d = j.data;
    if(d && d.alive === true && d.ts) throw flaky("ответ не на тот запрос");
    if(SHAPE[action] && !SHAPE[action](d)) throw flaky("ответ не на тот запрос");
    return d;
  }

  // Номер попытки сохранить. Генерируем ОДИН раз на действие человека, а не на
  // каждый повтор: иначе защита от дубля на сервере потеряет смысл.
  const WRITES = ["addPurchase","addCount","addReturn","addProduct","updateProduct","delete","restore","update","reorder","uploadReceipt"];
  const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  async function post(action, payload){
    if(!live()) return demo(action, payload);
    if(WRITES.includes(action)) payload = Object.assign({rid: rid()}, payload || {});
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
    if(action === "delete"){
      const r = d[p.col]?.[p.id];
      if(r && p.col !== "products"){ r.deleted = new Date().toISOString(); r.deletedBy = "демо" }
      else delete d[p.col]?.[p.id];
    }
    if(action === "reorder"){
      const pos = {}; (p.ids||[]).forEach((x,i) => pos[x] = i + 1);
      for(const [id, v] of Object.entries(d.products)) v.shelf = pos[id] ?? null;
    }
    if(action === "restore"){ const r = d[p.col]?.[p.id]; if(r){ r.deleted = ""; r.deletedBy = "" } }
    if(action === "update"){ const r = d[p.col]?.[p.id]; if(r) Object.assign(r, p.patch, {edited:new Date().toISOString()}) }
    writeLocal(d);
    return d;
  }

  // Удалённое не стирается, а помечается. В расчёты оно попадать не должно,
  // поэтому раскладываем сразу: живое — в работу, помеченное — в корзину.
  const split = o => {
    const on = [], off = [];
    for(const [id, v] of Object.entries(o || {})) (v && v.deleted ? off : on).push({id, ...v});
    return [on, off];
  };
  const norm = d => {
    const [counts, cT] = split(d.counts), [purchases, pT] = split(d.purchases), [returns, rT] = split(d.returns);
    return {
      products: Object.entries(d.products || {}).map(([id,v]) => ({id, ...v})),
      counts, purchases, returns,
      trash: {counts: cT, purchases: pT, returns: rT},
      live: live()
    };
  };

  return {
    live,
    // fresh — кнопка «обновить»: минуя кэш скрипта, прямо из таблицы
    async list(fresh){ return norm(await post("list", fresh ? {fresh:true} : {})) },
    async addPurchase(x){ return norm(await post("addPurchase", x)) },
    // фото чека тянем только когда карточку открыли: оно тяжёлое, в общий список не кладём
    async receipt(id){ return post("getReceipt", {id}) },
    async parse(photo){ return post("parseReceipt", {photo}) },
    // фото грузим отдельно и заранее: сама запись закупки после этого — секунды
    async uploadReceipt(photo, date){ return post("uploadReceipt", {photo, date}) },
    async addReturn(x){ return norm(await post("addReturn", x)) },
    async addCount(x){ return norm(await post("addCount", x)) },
    async addProduct(id, data){ return norm(await post("addProduct", {id, data})) },
    async updateProduct(id, patch){ return norm(await post("updateProduct", {id, patch})) },
    async del(col, id){ return norm(await post("delete", {col, id})) },
    async restore(col, id){ return norm(await post("restore", {col, id})) },
    async reorder(ids){ return norm(await post("reorder", {ids})) },
    async update(col, id, patch){ return norm(await post("update", {col, id, patch})) },
    resetDemo(){ localStorage.removeItem(LS); cache = null; }
  };
})();

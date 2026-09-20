/* Слой данных. Продакшн — Google Apps Script, демо — локальный JSON + localStorage.
   Каждый запрос несёт Telegram.WebApp.initData, проверка подписи и белый список — на стороне скрипта. */
window.API = (function(){
  const C = window.HUB_CONFIG;
  const TG = window.Telegram?.WebApp;
  const LS = "hub-bar-demo-v1";
  const live = () => !!C.API;

  const readLocal = () => { try { return JSON.parse(localStorage.getItem(LS)) || null } catch(e){ return null } };
  const writeLocal = d => { try { localStorage.setItem(LS, JSON.stringify(d)) } catch(e){} };

  async function post(action, payload){
    if(!live()) return demo(action, payload);
    const r = await fetch(C.API, {
      method:"POST",
      headers:{"Content-Type":"text/plain;charset=utf-8"}, // simple request — без preflight
      body: JSON.stringify({ action, payload, initData: TG?.initData || "" })
    });
    if(!r.ok) throw new Error("HTTP "+r.status);
    const j = await r.json();
    if(!j.ok) throw new Error(j.error || "Ошибка сервера");
    return j.data;
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
    live: live()
  });

  return {
    live,
    async list(){ return norm(await post("list")) },
    async addPurchase(x){ return norm(await post("addPurchase", x)) },
    async addCount(x){ return norm(await post("addCount", x)) },
    async addProduct(id, data){ return norm(await post("addProduct", {id, data})) },
    async updateProduct(id, patch){ return norm(await post("updateProduct", {id, patch})) },
    async del(col, id){ return norm(await post("delete", {col, id})) },
    resetDemo(){ localStorage.removeItem(LS); cache = null; }
  };
})();

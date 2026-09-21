/* HOROVOD HUB · бар — витрина склада. Логика расчётов перенесена из прототипа без изменений. */
(function(){
const C = window.HUB_CONFIG, TG = window.Telegram?.WebApp;
const SALE = C.SALE_PRICE, HORIZON = C.HORIZON, AMBER = C.AMBER, TARGET = C.TARGET;
const CAT = {sale:"По 1,50 €", water:"Вода · бесплатно", snack:"Снеки · бесплатно", shared:"Общие · не продаются"};
const CATS = ["sale","water","snack","shared"];
const isFree = c => c === "water" || c === "snack";   // купили и раздали — деньги не вернутся
const S = {products:[], counts:[], purchases:[], returns:[], open:{}, tab:"menu", filter:"all", buy:{}, count:null, f:{}, M:null, loaded:false};

const $  = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const eur = n => (n<0?"−":"") + Math.abs(n).toFixed(2).replace(".",",") + " €";
const dec = n => n.toFixed(1).replace(".",",");
const ddmm = iso => { const d = new Date(iso); return String(d.getDate()).padStart(2,"0")+"."+String(d.getMonth()+1).padStart(2,"0") };
const days = (a,b) => (new Date(b) - new Date(a)) / 864e5;
const plural = (n,a,b,c) => { n = Math.abs(n)%100; const m = n%10; if(n>10&&n<20) return c; if(m>1&&m<5) return b; if(m==1) return a; return c };
const num = v => parseFloat(String(v ?? "").replace(",",".")) || 0;
const haptic = t => { try{ TG?.HapticFeedback?.impactOccurred(t||"light") }catch(e){} };

/* ---------- картинка товара: фото, если есть, иначе рисованная тара ---------- */
function art(p){
  const c = p.color || "#8A90A0", k = p.shape || "can";
  if(k==="can")     return `<svg class="fb" viewBox="0 0 40 64"><rect x="6" y="6" width="28" height="54" rx="6" fill="${c}"/><rect x="9" y="3" width="22" height="6" rx="3" fill="#B9BEC8"/><rect x="6" y="24" width="28" height="16" fill="#fff" opacity=".85"/><rect x="12" y="29" width="16" height="6" rx="2" fill="${c}"/></svg>`;
  if(k==="bottle")  return `<svg class="fb" viewBox="0 0 30 72"><rect x="11" y="2" width="8" height="5" rx="1.5" fill="#C9A43A"/><path d="M11 7h8v12c0 4 7 7 7 13v34a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V32c0-6 7-9 7-13z" fill="${c}"/><rect x="4" y="40" width="22" height="16" fill="#fff" opacity=".85"/><rect x="8" y="45" width="14" height="6" rx="2" fill="${c}"/></svg>`;
  if(k==="pet")     return `<svg class="fb" viewBox="0 0 34 80"><rect x="12" y="2" width="10" height="6" rx="2" fill="${p.cap||"#E43"}"/><path d="M12 8h10v6c0 3 8 6 8 13v47a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V27c0-7 8-10 8-13z" fill="${c}" opacity=".92"/><rect x="4" y="36" width="26" height="18" fill="#fff" opacity=".8"/><rect x="8" y="42" width="18" height="6" rx="2" fill="${c}"/></svg>`;
  if(k==="water")   return `<svg class="fb" viewBox="0 0 34 80"><rect x="12" y="2" width="10" height="6" rx="2" fill="#2B6CB0"/><path d="M12 8h10v6c0 3 8 6 8 13v47a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V27c0-7 8-10 8-13z" fill="${c}" opacity=".45"/><rect x="4" y="38" width="26" height="14" fill="${c}"/><path d="M4 60h26M4 66h26" stroke="#fff" stroke-width="1.5" opacity=".6"/></svg>`;
  if(k==="capsule") return `<svg class="fb" viewBox="0 0 64 64"><ellipse cx="32" cy="46" rx="24" ry="8" fill="${c}" opacity=".5"/><path d="M10 44 L18 18 H46 L54 44 Z" fill="${c}"/><ellipse cx="32" cy="18" rx="14" ry="4" fill="#D9B98C"/><ellipse cx="32" cy="44" rx="22" ry="6" fill="${c}"/></svg>`;
  return `<svg class="fb" viewBox="0 0 40 64"><rect x="6" y="10" width="28" height="48" rx="4" fill="${c}"/><path d="M6 18 L20 4 L34 18" fill="${c}"/><rect x="6" y="28" width="28" height="12" fill="#fff" opacity=".6"/></svg>`;
}
const pic = p => `<img src="img/${esc(p.id)}.webp" alt="" loading="lazy" decoding="async" onerror="this.parentNode.classList.add('noimg');this.remove()">${art(p)}`;

/* ---------- расчёты ---------- */
function model(){
  const counts = [...S.counts].sort((a,b)=> a.date<b.date?-1:1);
  const purch  = [...S.purchases].sort((a,b)=> a.date<b.date?-1:1);
  const sumP = (from,to) => { const o={}; for(const x of purch){ if((from==null||x.date>from)&&(to==null||x.date<=to)) for(const [k,v] of Object.entries(x.items||{})) o[k]=(o[k]||0)+(+v||0) } return o };

  const recs = [];
  for(let i=1;i<counts.length;i++){
    const a = counts[i-1], b = counts[i], bought = sumP(a.date,b.date);
    const cons = {}, meas = {}; let saleUnits = 0, freeUnits = 0;
    for(const p of S.products){
      const A = a.stock?.[p.id], B = b.stock?.[p.id];
      if(A==null || B==null) continue;
      const v = (+A) + (bought[p.id]||0) - (+B);
      cons[p.id] = v;
      // «измерено» только если позиция реально двигалась: иначе это не ноль расхода, а отсутствие данных
      meas[p.id] = (bought[p.id]||0) > 0 || v > 0;
      if(p.cat==="sale") saleUnits += v;
      if(isFree(p.cat)) freeUnits += v;
    }
    let costSale = 0, costWater = 0, depSpent = 0;
    for(const p of S.products){
      const v = cons[p.id];
      if(v != null && p.cost != null){
        if(p.cat === "sale") costSale  += v*p.cost;
        if(isFree(p.cat)) costWater += v*p.cost;
      }
      depSpent += (bought[p.id]||0) * (+p.dep || 0);
    }
    // возврат залога, легший в кассу, — это не донаты за напитки
    const backed = S.returns.filter(r => r.toTill && r.date > a.date && r.date <= b.date)
                            .reduce((s,r) => s + (+r.amount||0), 0);
    const buys = purch.filter(x => x.date > a.date && x.date <= b.date).length;
    const expected = saleUnits*SALE, got = (+b.cash||0) + (+b.card||0) - backed;
    recs.push({id:b.id, from:a, to:b, days:days(a.date,b.date), cons, meas, bought, saleUnits, freeUnits, backed, buys,
      expected, got, short: got-expected, costSale, costWater, depSpent,
      net: got - costSale - costWater,          // реальный итог: пришло минус всё, что купили
      ideal: expected - costSale - costWater,   // если бы платили все
      payRate:   expected > 0 ? got/expected : null,
      breakEven: expected > 0 ? (costSale+costWater)/expected : null});
  }

  const last = counts[counts.length-1];
  const since = last ? sumP(last.date,null) : sumP(null,null);
  const dSince = last ? Math.max(0, days(last.date, new Date().toISOString())) : 0;

  const items = {};
  for(const p of S.products){
    const base = last?.stock?.[p.id];
    // средний расход за все измеренные периоды, взвешенный по дням
    let tot = 0, dd = 0, periods = [];
    for(const r of recs){
      if(r.cons[p.id] == null) continue;
      const measured = r.meas[p.id];
      periods.push({from:r.from.date, to:r.to.date, days:r.days, cons:r.cons[p.id], bought:r.bought[p.id]||0, measured,
                    perWeek: measured && r.days>0 ? Math.max(0,r.cons[p.id]/r.days*7) : null});
      if(measured){ tot += r.cons[p.id]; dd += r.days }
    }
    const rate = dd>0 ? Math.max(0, tot/dd) : null;      // шт в день; null = данных ещё нет
    const exact = (base ?? 0) + (since[p.id]||0);
    let est = exact;
    if(rate) est = Math.max(0, exact - rate*dSince);
    const estimated = !!rate && dSince >= 1;
    const daysLeft = rate ? est/rate : null;

    // «общие» попадают к нам случайно, «распродаём» специально не докупаем:
    // и те и другие не тревожат красным и не просятся в закупку
    const restock = p.cat !== "shared" && !p.phaseout;
    let st = "none";
    if(restock){
      st = "green";
      if(Math.round(est) <= 0) st = "red";
      else if(daysLeft != null){ if(daysLeft < HORIZON) st = "red"; else if(daysLeft < AMBER) st = "amber" }
      else if(p.min != null){ if(est <= p.min) st = "red"; else if(est <= p.min*1.5) st = "amber" }
    }

    let need = 0;
    if(restock){
      if(rate) need = Math.max(0, rate*TARGET - est);
      else if(st !== "green" && p.min) need = p.min*2 - est;
      if(need>0 && p.pack) need = Math.ceil(need/p.pack)*p.pack; else need = Math.ceil(need);
    }

    items[p.id] = {est, exact, estimated, rate, daysLeft, st, need, restock, periods, bought:since[p.id]||0, base};
  }
  // сдача тары: сколько всего сдали и сколько залога ещё лежит в пустой таре
  const tare = S.returns.reduce((o,r) => ({units:o.units+(+r.units||0), amount:o.amount+(+r.amount||0)}),
                                {units:0, amount:0});
  tare.last = S.returns.map(r => r.date).sort().pop() || null;

  // Залог в пустой таре = уплачено за всё выпитое с начала учёта минус то, что уже сдали.
  // Так цифра сама себя правит: сдал — она упала ровно на сумму из автомата.
  const start = counts[0]?.date || null;
  let paid = 0;
  for(const p of S.products){
    const dep = +p.dep || 0; if(!dep) continue;
    for(const r of recs) paid += Math.max(0, r.cons[p.id] || 0) * dep;
    const it = items[p.id];
    if(it?.rate) paid += it.rate * dSince * dep;          // с последнего подсчёта — по среднему расходу
  }
  const back = S.returns.filter(r => !start || r.date > start).reduce((s,r) => s + (+r.amount||0), 0);
  tare.waiting = Math.max(0, paid - back);
  tare.paid = paid;

  return {counts, purch, recs, last, lastRec:recs[recs.length-1], items, dSince, tare};
}

/* ---------- меню ---------- */
const sorted = () => [...S.products].filter(p=>!p.hidden).sort((a,b)=>(a.order??99)-(b.order??99));
const flag = (it,p) => p.phaseout   ? `<span class="flag grey">Распродаём</span>`
                     : it.st==="red"   ? `<span class="flag red">${Math.round(it.est)<=0?"Закончилось":"Докупить"}</span>`
                     : it.st==="amber" ? `<span class="flag amber">Скоро</span>` : "";

function stockLine(it){
  const n = Math.round(it.est);
  if(n <= 0) return `<div class="stk red"><b class="num">0</b><span>нет</span></div>`;
  const t = it.daysLeft != null
    ? (it.daysLeft > 60 ? "надолго" : "на "+Math.floor(it.daysLeft)+" дн.")
    : plural(n,"штука","штуки","штук");
  return `<div class="stk ${it.st!=="green"?it.st:""}"><b class="num">${it.estimated?"≈":""}${n}</b><span>${t}</span></div>`;
}
const tagFor = p => p.cat==="sale" ? `<span class="tag num">${eur(SALE)}</span>`
                  : isFree(p.cat) ? `<span class="tag free">бесплатно</span>`
                  : `<span class="tag">общее</span>`;

function money(r){
  const pct = r.payRate != null ? Math.round(r.payRate*100) : null;
  const be  = r.breakEven != null && isFinite(r.breakEven) ? Math.round(r.breakEven*100) : null;
  return `<dl class="recon num">
      <dt>Выпито платных</dt><dd>${r.saleUnits} шт</dd>
      <dt>Должно быть (× ${eur(SALE)})</dt><dd>${eur(r.expected)}</dd>
      <dt>Пришло за напитки</dt><dd>${eur(r.got)}</dd>
      ${r.backed ? `<dt>вычтен возврат залога</dt><dd>−${eur(r.backed)}</dd>` : ""}
      <dt class="tot">Недобор</dt><dd class="tot ${r.short>=0?"pos":"neg"}">${r.short>0?"+":""}${eur(r.short)}${pct!=null?" · оплачено "+pct+"%":""}</dd>
    </dl>
    <dl class="recon num" style="margin-top:12px">
      <dt>Закупка выпитого</dt><dd>−${eur(r.costSale)}</dd>
      <dt>Бесплатное · ${r.freeUnits} шт · отбивки нет</dt><dd>−${eur(r.costWater)}</dd>
      <dt class="tot">Итог периода</dt><dd class="tot ${r.net>=0?"pos":"neg"}">${r.net>0?"+":""}${eur(r.net)}</dd>
    </dl>
    <p class="note" style="margin:10px 0 0">Если бы платили все — ${r.ideal>0?"+":""}${eur(r.ideal)}. ${be!=null?`В ноль выходим при ${be}% оплаты.`:""}${r.depSpent?" Залога за тару ушло "+eur(r.depSpent)+" — вернётся при сдаче.":""}</p>
    ${r.buys != null ? `<p class="note" style="margin:6px 0 0">За период отмечено закупок: ${r.buys}. Если какая-то не отмечена, выпито посчитается меньше, а недобор выйдет больше настоящего.</p>` : ""}`;
}

function renderMenu(M){
  const all = sorted();
  const cnt = f => all.filter(p => M.items[p.id].st === f).length;
  $("#chips").innerHTML =
    `<button class="chip" data-f="all" aria-pressed="${S.filter==="all"}">Всё<span class="n num">${all.length}</span></button>`+
    `<button class="chip" data-f="red" aria-pressed="${S.filter==="red"}"><span class="dot" style="background:var(--red)"></span>Докупить<span class="n num">${cnt("red")}</span></button>`+
    `<button class="chip" data-f="amber" aria-pressed="${S.filter==="amber"}"><span class="dot" style="background:var(--amber)"></span>Скоро<span class="n num">${cnt("amber")}</span></button>`;

  let html = "";
  const r = M.lastRec;
  if(r) html += `<button class="panel pad banner" id="moneyCard" style="margin-top:14px">
    <div class="h"><b>Период ${ddmm(r.from.date)} – ${ddmm(r.to.date)}</b><span class="pill ${r.net>=0?"green":"red"} num">${r.net>0?"+":""}${eur(r.net)}</span></div>
    <div class="note">Недобор ${eur(r.short)} · вода ${eur(r.costWater)}${r.payRate!=null?" · оплачено "+Math.round(r.payRate*100)+"%":""}</div></button>`;

  for(const cat of CATS){
    let ps = all.filter(p => p.cat===cat);
    if(S.filter !== "all") ps = ps.filter(p => M.items[p.id].st === S.filter);
    ps = ps.filter(p => M.items[p.id].restock || Math.round(M.items[p.id].est) > 0);
    if(!ps.length) continue;
    const fold = cat === "shared";                       // общие свёрнуты, пока не откроешь
    const open = !fold || S.open[cat];
    html += fold
      ? `<button class="sec fold" data-sec="${cat}" aria-expanded="${open}">${CAT[cat]}<em>${ps.length} ${plural(ps.length,"позиция","позиции","позиций")}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></em></button>`
      : `<h2 class="sec">${CAT[cat]}<em>${ps.length} ${plural(ps.length,"позиция","позиции","позиций")}</em></h2>`;
    if(!open) continue;
    html += `<div class="grid">`;
    for(const p of ps){
      const it = M.items[p.id], out = Math.round(it.est) <= 0;
      html += `<button class="card ${out?"out":""}" data-p="${esc(p.id)}">
        <div class="thumb">${pic(p)}${flag(it,p)}${out && it.restock?`<span class="stamp"><span>Нет на складе</span></span>`:""}</div>
        <div class="cb"><div class="nm">${esc(p.name)}</div><div class="vol">${esc(p.vol||"")}</div>
        <div class="foot">${stockLine(it)}${tagFor(p)}</div></div></button>`;
    }
    html += `</div>`;
  }
  if(!html.includes("card")) html += `<div class="empty">В этом фильтре пусто — всё в порядке.</div>`;
  html += `<p class="note" style="margin:20px 0 0">«≈» — расчётный остаток: последний подсчёт + закупки − средний расход с тех пор. Точным он становится в день подсчёта. Красное — запаса меньше чем на ${HORIZON} дней.</p>`;
  return html;
}

/* ---------- закупка ---------- */
const stepper = (id,val,k) => `<div class="step"><button type="button" data-d="-1" data-id="${esc(id)}" aria-label="минус">−</button><input id="${k}-${esc(id)}" inputmode="numeric" data-id="${esc(id)}" data-k="${k}" value="${val}" class="num"><button type="button" class="plus" data-d="1" data-id="${esc(id)}" aria-label="плюс">+</button></div>`;

function renderBuy(M){
  const all = sorted(), needs = all.filter(p => M.items[p.id].need > 0);
  let h = `<h2 class="sec">Что купить<em>на ${TARGET} дней вперёд</em></h2><div class="panel">`;
  if(!needs.length) h += `<div class="note" style="padding:12px 0">Пока ничего не требуется. Список появится, когда запаса станет меньше чем на ${HORIZON} дней.</div>`;
  else {
    for(const p of needs){ const it = M.items[p.id];
      h += `<div class="row"><div class="mini">${pic(p)}</div><div class="info"><div class="nm">${esc(p.name)}</div>
        <div class="sub2 num">${Math.round(it.est)} шт${p.pack?" · уп. "+p.pack:""}${p.cost?" · ~"+eur(it.need*(p.cost+(+p.dep||0))):""}</div></div>
        <span class="pill ${it.st==="green"?"ink":it.st} num">+${it.need}</span></div>`;
    }
    const goods = needs.reduce((s,p)=> s + (p.cost ? M.items[p.id].need*p.cost : 0), 0);
    const deps  = needs.reduce((s,p)=> s + M.items[p.id].need*(+p.dep||0), 0);
    h += `<div class="row"><div class="info"><div class="nm">Взять с собой</div><div class="sub2">товар ${eur(goods)} с НДС + залог ${eur(deps)}</div></div><b class="num">${eur(goods+deps)}</b></div></div>
      <button class="btn ghost" id="fillNeed" style="margin-top:10px">Перенести в закупку</button>`;
  }
  if(!needs.length) h += `</div>`;

  h += `<h2 class="sec">Отметить закупку<em>плюсами — что купил</em></h2><div class="panel">`;
  // позиции на сбыт не докупаем — в списке закупки им делать нечего
  for(const cat of CATS) for(const p of all.filter(x => x.cat===cat && !x.phaseout)){
    h += `<div class="row"><div class="mini">${pic(p)}</div><div class="info"><div class="nm">${esc(p.name)}</div>
      <div class="sub2">${esc(p.vol||"")}${p.pack?" · упак. "+p.pack:""}</div></div>${stepper(p.id, S.buy[p.id]||0, "b")}</div>`;
  }
  h += `</div>
  <button class="btn ghost" id="tareBtn" style="margin-top:12px">Сдал тару · ждёт сдачи ~${eur(M.tare.waiting)}</button>
  <div class="fields" style="margin-top:12px">
    <div class="field"><label for="buySum">Сумма чека, €</label><input id="buySum" value="${esc(S.f.buySum||"")}" inputmode="decimal" placeholder="например 97,48"></div>
    <div class="field"><label for="buyWho">Кто купил</label><input id="buyWho" value="${esc(S.f.buyWho||"")}" placeholder="имя"></div></div>
  <details class="panel pad" style="margin-top:16px"><summary style="cursor:pointer;font-weight:600">+ Новый напиток</summary><div class="stack" style="margin-top:14px">
    <div class="fields"><div class="field"><label for="npName">Название</label><input id="npName" placeholder="Birell 0,0%"></div><div class="field"><label for="npVol">Объём</label><input id="npVol" placeholder="0,5 л, стекло"></div></div>
    <div class="fields"><div class="field"><label for="npCat">Категория</label><select id="npCat"><option value="sale">По 1,50 €</option><option value="water">Вода</option><option value="snack">Снеки</option><option value="shared">Общие, не продаются</option></select></div>
    <div class="field"><label for="npShape">Тара</label><select id="npShape"><option value="bottle">Стекло</option><option value="can">Банка</option><option value="pet">ПЭТ</option><option value="water">Вода</option><option value="capsule">Капсула</option></select></div></div>
    <div class="fields"><div class="field"><label for="npCost">Закупка за шт, €</label><input id="npCost" inputmode="decimal"></div><div class="field"><label for="npPack">Упаковка, шт</label><input id="npPack" inputmode="numeric" value="6"></div>
    <div class="field"><label for="npColor">Цвет</label><input id="npColor" type="color" value="#2F8F5B" style="padding:4px;height:46px"></div></div>
    <button class="btn ghost" id="npAdd">Добавить в меню</button></div></details>`;
  return h;
}

/* ---------- подсчёт ---------- */
function renderCount(M){
  const all = sorted();
  if(!S.count){ S.count = {}; for(const p of all) if(M.items[p.id].restock || Math.round(M.items[p.id].est) > 0) S.count[p.id] = Math.round(M.items[p.id].est) }
  let h = `<h2 class="sec">Подсчёт раз в 2 недели<em>${M.last ? "прошлый "+ddmm(M.last.date)+" · "+Math.floor(M.dSince)+" дн. назад" : ""}</em></h2>
    <p class="note" style="margin:0 0 12px">Посчитай холодильник и полки вместе. Поля заполнены расчётом — поправь на то, что видишь.</p><div class="panel">`;
  // кончившееся на сбыте не переспрашиваем: понадобится — заведут заново
  const countable = p => M.items[p.id].restock || Math.round(M.items[p.id].est) > 0;
  for(const cat of CATS) for(const p of all.filter(x => x.cat===cat && countable(x))){
    const it = M.items[p.id];
    h += `<div class="row"><div class="mini">${pic(p)}</div><div class="info"><div class="nm">${esc(p.name)}</div>
      <div class="sub2 num">было ${it.base ?? "—"}${it.bought?" + куплено "+it.bought:""}</div></div>${stepper(p.id, S.count[p.id] ?? 0, "c")}</div>`;
  }
  h += `</div><h2 class="sec">Деньги за период</h2><div class="fields">
    <div class="field"><label for="cCash">Касса (наличные), €</label><input id="cCash" value="${esc(S.f.cCash||"")}" inputmode="decimal" placeholder="0"></div>
    <div class="field"><label for="cCard">На карту «napoj HUB», €</label><input id="cCard" value="${esc(S.f.cCard||"")}" inputmode="decimal" placeholder="0"></div></div>
    <div class="panel pad" style="margin-top:12px" id="preview"></div>
    <div class="field" style="margin-top:12px"><label for="cWho">Кто считал</label><input id="cWho" value="${esc(S.f.cWho||"")}" placeholder="имя"></div>
    <p class="note" style="margin-top:10px">После сохранения кассу опустоши — следующий период считается с нуля.</p>`;
  return h;
}
function previewCount(M){
  const el = $("#preview"); if(!el || !M) return;
  if(!M.last){ el.innerHTML = `<div class="note">Это первый подсчёт — он станет точкой отсчёта.</div>`; return }
  let units = 0, free = 0, costSale = 0, costWater = 0, depSpent = 0;
  for(const p of sorted()){
    const base = M.last.stock?.[p.id]; if(base == null) continue;
    const c = base + M.items[p.id].bought - (S.count[p.id]||0);
    if(p.cat === "sale"){ units += c; if(p.cost != null) costSale  += c*p.cost }
    if(isFree(p.cat)){ free  += c; if(p.cost != null) costWater += c*p.cost }
    depSpent += M.items[p.id].bought * (+p.dep || 0);
  }
  const exp = units*SALE, got = num($("#cCash")?.value) + num($("#cCard")?.value);
  el.innerHTML = money({saleUnits:units, freeUnits:free, expected:exp, got, short:got-exp,
    costSale, costWater, depSpent, net:got-costSale-costWater, ideal:exp-costSale-costWater,
    payRate: exp>0?got/exp:null, breakEven: exp>0?(costSale+costWater)/exp:null});
}

/* ---------- история ---------- */
function renderHist(M){
  const name = id => S.products.find(p=>p.id===id)?.name || id;
  let ev = [...M.recs.map(r=>({t:"rec",date:r.to.date,r})), ...M.purch.map(p=>({t:"buy",date:p.date,p}))];
  if(M.counts[0]) ev.push({t:"first",date:M.counts[0].date,c:M.counts[0]});
  ev.sort((a,b)=> a.date<b.date?1:-1);
  if(!ev.length) return `<div class="empty">Пока пусто.</div>`;
  let h = `<h2 class="sec">История</h2><div class="hist">`;
  for(const e of ev){
    if(e.t === "rec"){ const r = e.r;
      const top = Object.entries(r.cons).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>`${esc(name(k))} ${v}`).join(" · ");
      h += `<div class="panel pad"><div class="h"><b>Подсчёт ${ddmm(r.to.date)}</b><span class="pill ${r.net>=0?"green":"red"} num">${r.net>0?"+":""}${eur(r.net)}</span></div>
        <p class="note" style="margin:0 0 10px">${ddmm(r.from.date)}–${ddmm(r.to.date)} · ${Math.round(r.days)} дн.</p>
        ${money(r)}<p class="note" style="margin:10px 0 0">${top}</p>
        <div style="text-align:right;margin-top:6px">${r.to.by?`<span class="note">считал(а): ${esc(r.to.by)}</span>`:""} <button class="del" data-del="counts/${esc(r.to.id)}">удалить</button></div></div>`;
    } else if(e.t === "buy"){ const p = e.p;
      const list = Object.entries(p.items||{}).filter(([,v])=>v>0).map(([k,v])=>`${esc(name(k))} +${v}`).join(" · ");
      h += `<div class="panel pad"><div class="h"><b>Закупка ${ddmm(p.date)}</b>${p.total?`<span class="num">${eur(+p.total)}</span>`:""}</div>
        <p class="note" style="margin:0">${list}</p>${p.source?`<p class="note" style="margin:6px 0 0">${esc(p.source)}</p>`:""}
        <div style="text-align:right;margin-top:6px">${p.by?`<span class="note">${esc(p.by)}</span>`:""} <button class="del" data-del="purchases/${esc(p.id)}">удалить</button></div></div>`;
    } else {
      h += `<div class="panel pad"><div class="h"><b>Опорный подсчёт ${ddmm(e.c.date)}</b></div>
        <p class="note" style="margin:0">${esc(e.c.note || "Точка отсчёта.")}</p>${e.c.source?`<p class="note" style="margin:6px 0 0">${esc(e.c.source)}</p>`:""}</div>`;
    }
  }
  return h + `</div>`;
}

/* ---------- карточка товара ---------- */
function sheet(p){
  const it = S.M.items[p.id];
  const dep  = +p.dep || 0;
  const marg = p.cat==="sale" && p.cost != null ? SALE - p.cost : null;
  const buyLine = p.cost == null ? "цена закупки не заполнена"
    : `закупка ${eur(p.cost)} с НДС` + (dep ? ` · в магазине ${eur(p.cost+dep)} с залогом` : "") + (marg != null ? ` · маржа +${eur(marg)}` : "");
  const n = Math.round(it.est);
  const kv = (l,v,cls) => `<div><small>${l}</small><b class="${cls||""}">${v}</b></div>`;

  const measured = it.periods.filter(x => x.measured);
  const maxW = Math.max(1, ...measured.map(x => x.perWeek||0));
  let use = "";
  if(measured.length){
    use = measured.map(x => `<div class="per"><span class="lbl num">${ddmm(x.from)}–${ddmm(x.to)}</span>
      <span class="bar"><i style="width:${Math.max(4,(x.perWeek/maxW)*100)}%"></i></span>
      <span class="val num">${dec(x.perWeek)}<span> /нед</span></span></div>`).join("");
    const totC = measured.reduce((s,x)=>s+x.cons,0), totD = measured.reduce((s,x)=>s+x.days,0);
    use += `<div class="per"><span class="lbl">всего</span><span class="bar" style="background:none"></span>
      <span class="val num">${totC} шт<span> / ${Math.round(totD)} дн.</span></span></div>`;
  } else {
    use = `<p class="note" style="margin:0">Расход ещё не измерен: с опорного подсчёта эту позицию не покупали и остаток не менялся. Цифра появится после следующего подсчёта.</p>`;
  }

  const bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.innerHTML = `<div class="sheet" role="dialog" aria-label="${esc(p.name)}">
    <div class="grab"><i></i></div>
    <div class="hero">${pic(p)}</div>
    <div class="body">
      <h3>${esc(p.name)}</h3>
      <div class="meta">${esc(p.vol||"")} · ${CAT[p.cat]}</div>
      <div class="priceline">
        <b class="num">${p.cat==="sale" ? eur(SALE) : p.cat==="free" ? "бесплатно" : "не продаётся"}</b>
        <span class="buy num">${buyLine}</span>
      </div>
      <div class="kv num">
        ${kv("Остаток", (it.estimated?"≈ ":"")+n+" шт", it.st!=="green"?it.st:"")}
        ${kv("Хватит на", it.daysLeft!=null ? (it.daysLeft>60?"больше 60 дн.":Math.floor(it.daysLeft)+" "+plural(Math.floor(it.daysLeft),"день","дня","дней")) : "нет данных", it.daysLeft==null?"dim":(it.st!=="green"?it.st:""))}
        ${kv("Средний расход", it.rate ? dec(it.rate*7)+" в нед." : "нет данных", it.rate?"":"dim")}
        ${kv("Купить на "+TARGET+" дн.", it.need ? "+"+it.need+" шт" : "не нужно", it.need?"":"dim")}
      </div>
      <div class="blk"><h4>Среднее использование</h4>${use}</div>
      ${p.note ? `<div class="blk"><h4>Закупка</h4><p class="note" style="margin:0">${esc(p.note)}</p></div>` : ""}
      <div class="blk"><h4>Поправить</h4>
        <div class="fields"><div class="field"><label for="edCost">Закупка за шт, € с НДС</label><input id="edCost" inputmode="decimal" value="${p.cost ?? ""}"></div>
        <div class="field"><label for="edDep">Залог за тару, €</label><input id="edDep" inputmode="decimal" value="${p.dep ?? ""}"></div>
        <div class="field"><label for="edMin">Мин. остаток, шт</label><input id="edMin" inputmode="numeric" value="${p.min ?? ""}"></div></div>
        <label class="chk"><input type="checkbox" id="edPhase" ${p.phaseout?"checked":""}><span><b>Распродаём</b> — допиваем остаток, больше не докупаем</span></label>
      </div>
      <div class="fields" style="margin-top:16px"><button class="btn ghost" id="edClose" style="flex:1">Закрыть</button><button class="btn" id="edSave" style="flex:1">Сохранить</button></div>
      <div style="text-align:center"><button class="del" id="edHide" style="margin-top:12px">убрать из меню</button></div>
    </div></div>`;
  document.body.appendChild(bg);
  haptic("light");

  const close = () => { bg.remove(); TG?.BackButton?.hide() };
  TG?.BackButton?.show(); TG?.BackButton?.onClick(close);
  bg.addEventListener("click", e => { if(e.target === bg) close() });
  bg.querySelector("#edClose").onclick = close;
  bg.querySelector("#edSave").onclick = async () => {
    try{
      await apply(API.updateProduct(p.id, {
        cost: num(bg.querySelector("#edCost").value) || null,
        dep:  num(bg.querySelector("#edDep").value) || 0,
        min:  parseInt(bg.querySelector("#edMin").value) || null,
        phaseout: bg.querySelector("#edPhase").checked }));
      toast("Сохранено"); close();
    }catch(e){ toast("Не сохранилось: "+e.message) }
  };
  const hb = bg.querySelector("#edHide");
  hb.onclick = async () => {
    if(!hb.classList.contains("armed")){ hb.classList.add("armed"); hb.textContent = "точно убрать? нажми ещё раз"; return }
    try{ await apply(API.updateProduct(p.id, {hidden:true})); toast("Убрано из меню"); close() }catch(e){ toast("Ошибка: "+e.message) }
  };
}

function tareSheet(M){
  const bg = document.createElement("div");
  bg.className = "sheet-bg";
  const units = a => Math.round(a / C.DEPOSIT);
  bg.innerHTML = `<div class="sheet" role="dialog" aria-label="Сдача тары">
    <div class="grab"><i></i></div>
    <div class="body">
      <h3>Сдал тару</h3>
      <div class="meta">Впиши, сколько выдал автомат — штуки посчитаю сам по ${eur(C.DEPOSIT)}</div>
      <div class="fields" style="margin-top:16px">
        <div class="field"><label for="tSum">Получено, €</label><input id="tSum" inputmode="decimal" placeholder="например 12,45"></div>
        <div class="field"><label for="tWho">Кто сдавал</label><input id="tWho" placeholder="имя"></div>
      </div>
      <p class="note" id="tCalc" style="margin:10px 0 0">Это <b>0 шт</b> тары.</p>
      <label class="chk"><input type="checkbox" id="tTill" checked><span><b>Деньги положил в кассу</b> — тогда приложение не посчитает их донатами за напитки</span></label>
      <div class="blk"><h4>Тара</h4>
        <dl class="recon num">
          <dt>Сдано за всё время</dt><dd>${M.tare.units} шт · ${eur(M.tare.amount)}</dd>
          ${M.tare.last ? `<dt>Последняя сдача</dt><dd>${ddmm(M.tare.last)}</dd>` : ""}
          <dt class="tot">Ждёт сдачи · примерно</dt><dd class="tot">${units(M.tare.waiting)} шт · ${eur(M.tare.waiting)}</dd>
        </dl>
        <p class="note" style="margin:8px 0 0">«Ждёт сдачи» — залог за всё выпитое минус всё, что уже сдали. Цифра приблизительная: часть тары ещё стоит непустой, часть выбрасывают, а иногда наоборот — гости и соседи приносят свои бутылки, и сдаётся больше выпитого. Сверяется сама: сдал — она упала ровно на сумму из автомата.</p>
      </div>
      <div class="fields" style="margin-top:16px"><button class="btn ghost" id="tClose" style="flex:1">Закрыть</button><button class="btn" id="tSave" style="flex:1">Записать</button></div>
    </div></div>`;
  document.body.appendChild(bg);
  const close = () => { bg.remove(); TG?.BackButton?.hide() };
  TG?.BackButton?.show(); TG?.BackButton?.onClick(close);
  bg.addEventListener("click", e => { if(e.target === bg) close() });
  const inp = bg.querySelector("#tSum");
  inp.addEventListener("input", () => {
    const n = units(num(inp.value));
    bg.querySelector("#tCalc").innerHTML = `Это <b>${n}</b> ${plural(n,"штука","штуки","штук")} тары.`;
  });
  bg.querySelector("#tClose").onclick = close;
  bg.querySelector("#tSave").onclick = async () => {
    const amount = num(inp.value);
    if(!amount){ toast("Впиши сумму"); return }
    const btn = bg.querySelector("#tSave"); btn.disabled = true;
    try{
      await apply(API.addReturn({date:new Date().toISOString(), amount, units:units(amount),
        toTill:bg.querySelector("#tTill").checked, by:bg.querySelector("#tWho").value.trim()||null}));
      toast(`Записал: ${units(amount)} шт на ${eur(amount)}`); haptic("medium"); close();
    }catch(e){ toast("Не сохранилось: "+e.message); btn.disabled = false }
  };
}

function moneySheet(r){
  if(!r) return;
  const bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.innerHTML = `<div class="sheet" role="dialog" aria-label="Деньги за период">
    <div class="grab"><i></i></div>
    <div class="body">
      <h3>Деньги за период</h3>
      <div class="meta">${ddmm(r.from.date)} – ${ddmm(r.to.date)} · ${Math.round(r.days)} дн.</div>
      <div style="margin-top:16px">${money(r)}</div>
      <div class="blk"><h4>Куда ушли деньги на бесплатное</h4>
        <dl class="recon num">${S.products.filter(p => isFree(p.cat) && r.cons[p.id] > 0)
          .sort((x,y) => (r.cons[y.id]*(y.cost||0)) - (r.cons[x.id]*(x.cost||0)))
          .map(p => `<dt>${esc(p.name)} ${esc(p.vol||"")} · ${r.cons[p.id]} шт</dt><dd>${p.cost?eur(r.cons[p.id]*p.cost):"—"}</dd>`)
          .join("") || "<dt>ничего не выпито</dt><dd>—</dd>"}</dl></div>
      <div class="blk"><h4>Как это считается</h4><p class="note" style="margin:0">
        Недобор — только по платным напиткам: сколько должны были занести против того, что занесли.
        Вода бесплатная, деньги за неё не вернутся никогда, поэтому она стоит отдельной строкой расхода, а не в недоборе.
        Залог за тару в расход не идёт — это возвратные деньги, они лежат в пустой таре:
        если сдачу тары отметить во вкладке «Закупка», её сумма вычтется из кассы и не сойдёт за донаты.</p></div>
      <button class="btn ghost" id="mClose" style="margin-top:16px">Закрыть</button>
    </div></div>`;
  document.body.appendChild(bg);
  const close = () => { bg.remove(); TG?.BackButton?.hide() };
  TG?.BackButton?.show(); TG?.BackButton?.onClick(close);
  bg.addEventListener("click", e => { if(e.target === bg) close() });
  bg.querySelector("#mClose").onclick = close;
}

/* ---------- каркас ---------- */
function render(){
  if(!S.loaded) return;
  const M = model(); S.M = M;
  const next = M.last ? ddmm(new Date(new Date(M.last.date).getTime() + 14*864e5).toISOString()) : null;
  $("#sub").textContent = M.last ? `подсчёт ${ddmm(M.last.date)} · следующий ~${next}` : "подсчётов ещё не было";
  $("#chips").hidden = S.tab !== "menu";
  const v = $("#view");
  if(!S.products.length){ v.innerHTML = `<div class="empty">Меню пустое. Добавь первый напиток во вкладке «Закупка».</div>`; dock(); return }
  if(S.tab === "menu")  v.innerHTML = renderMenu(M);
  if(S.tab === "buy")   v.innerHTML = renderBuy(M);
  if(S.tab === "count"){v.innerHTML = renderCount(M); previewCount(M)}
  if(S.tab === "hist")  v.innerHTML = renderHist(M);
  dock();
}
function dock(){
  const d = $("#dock"), b = $("#dockBtn");
  if(S.tab === "buy"){
    const n = Object.values(S.buy).reduce((s,v)=>s+(+v||0),0);
    d.hidden = false; b.textContent = n ? `Добавить на склад · ${n} шт` : "Отметь, что купил"; b.disabled = !n; b.dataset.a = "buy";
  } else if(S.tab === "count"){ d.hidden = false; b.textContent = "Сохранить подсчёт"; b.disabled = false; b.dataset.a = "count" }
  else d.hidden = true;
}
function toast(t){ const e = document.createElement("div"); e.className = "toast"; e.textContent = t; document.body.appendChild(e); setTimeout(()=>e.remove(), 2400) }
async function apply(promise){ const d = await promise; S.products = d.products; S.counts = d.counts; S.purchases = d.purchases; S.returns = d.returns || []; render(); return d }

/* ---------- события ---------- */
document.addEventListener("click", async e => {
  const t = e.target.closest("[data-tab]");
  if(t){ S.tab = t.dataset.tab; document.querySelectorAll(".tab").forEach(x => x.setAttribute("aria-selected", x === t)); if(S.tab === "count") S.count = null; haptic("light"); render(); scrollTo(0,0); return }
  const f = e.target.closest("[data-f]"); if(f){ S.filter = f.dataset.f; haptic("light"); render(); return }
  const sc = e.target.closest("[data-sec]"); if(sc){ S.open[sc.dataset.sec] = !S.open[sc.dataset.sec]; haptic("light"); render(); return }
  const c = e.target.closest(".card[data-p]"); if(c){ const p = S.products.find(x => x.id === c.dataset.p); if(p) sheet(p); return }
  if(e.target.closest("#moneyCard")){ moneySheet(S.M.lastRec); return }
  if(e.target.id === "tareBtn"){ tareSheet(S.M); return }
  const s = e.target.closest(".step button");
  // счётчики внутри шторок обслуживают себя сами
  if(s && !s.closest(".sheet-bg")){ const inp = s.parentElement.querySelector("input"), v = Math.max(0,(parseInt(inp.value)||0) + (+s.dataset.d)); inp.value = v; setVal(inp.dataset.k, s.dataset.id, v); haptic("light"); return }
  if(e.target.id === "fillNeed"){ for(const p of S.products){ const n = S.M.items[p.id]?.need; if(n) S.buy[p.id] = n } render(); toast("Список перенесён — поправь по чеку"); return }
  if(e.target.id === "refresh"){ e.target.classList.add("spin"); try{ await apply(API.list()); toast("Обновлено") }catch(err){ toast("Не вышло: "+err.message) } e.target.classList.remove("spin"); return }
  const d = e.target.closest("[data-del]");
  if(d){ if(!d.classList.contains("armed")){ d.classList.add("armed"); d.textContent = "точно удалить?"; return }
    const [col,id] = d.dataset.del.split("/");
    try{ await apply(API.del(col,id)); toast("Удалено") }catch(er){ toast("Ошибка: "+er.message) } return }
  if(e.target.id === "npAdd") return addProduct();
  if(e.target.id === "dockBtn") return e.target.dataset.a === "buy" ? saveBuy() : saveCount();
});
document.addEventListener("input", e => {
  const i = e.target;
  if(i.dataset?.k) setVal(i.dataset.k, i.dataset.id, Math.max(0, parseInt(i.value)||0));
  if(["buySum","buyWho","cCash","cCard","cWho"].includes(i.id)) S.f[i.id] = i.value;
  if(i.id === "cCash" || i.id === "cCard") previewCount(S.M);
});
addEventListener("scroll", () => $("#top").classList.toggle("stuck", scrollY > 6), {passive:true});

function setVal(k,id,v){
  if(k === "b"){ S.buy[id] = v; dock() } else { S.count[id] = v; previewCount(S.M) }
  const el = document.getElementById(k+"-"+id);
  if(el) el.classList.toggle("changed", k === "b" ? v > 0 : v !== Math.round(S.M.items[id].est));
}
async function saveBuy(){
  const items = {}; for(const [k,v] of Object.entries(S.buy)) if(v > 0) items[k] = v;
  if(!Object.keys(items).length) return;
  const b = $("#dockBtn"); b.disabled = true;
  try{
    await apply(API.addPurchase({date:new Date().toISOString(), items, total:num($("#buySum")?.value)||null, by:$("#buyWho")?.value.trim()||null}));
    S.buy = {}; S.f.buySum = ""; toast("Закупка добавлена на склад"); haptic("medium");
    S.tab = "menu"; document.querySelectorAll(".tab").forEach(x => x.setAttribute("aria-selected", x.dataset.tab === "menu")); render(); scrollTo(0,0);
  }catch(e){ toast("Не сохранилось: "+e.message); b.disabled = false }
}
async function saveCount(){
  // в подсчёт попадает только то, что показывали: нулевой сбыт не воскрешаем
  const stock = {}; for(const p of sorted()) if(S.count[p.id] != null) stock[p.id] = S.count[p.id];
  const b = $("#dockBtn"); b.disabled = true;
  try{
    await apply(API.addCount({date:new Date().toISOString(), stock, cash:num($("#cCash").value), card:num($("#cCard").value), by:$("#cWho").value.trim()||null}));
    S.count = null; S.f.cCash = S.f.cCard = ""; toast("Подсчёт сохранён"); haptic("medium");
    S.tab = "hist"; document.querySelectorAll(".tab").forEach(x => x.setAttribute("aria-selected", x.dataset.tab === "hist")); render(); scrollTo(0,0);
  }catch(e){ toast("Не сохранилось: "+e.message); b.disabled = false }
}
async function addProduct(){
  const name = $("#npName").value.trim(); if(!name){ toast("Впиши название"); return }
  const base = name.toLowerCase().replace(/[^a-z0-9а-я]+/gi,"-").replace(/^-|-$/g,"").slice(0,40) + "-" + Date.now().toString(36);
  const id = base.replace(/[^A-Za-z0-9_\-]/g, c => c.charCodeAt(0).toString(36));
  const cat = $("#npCat").value;
  try{
    await apply(API.addProduct(id, {name, vol:$("#npVol").value.trim(), cat, shape:$("#npShape").value,
      cost:num($("#npCost").value)||null, pack:parseInt($("#npPack").value)||null, color:$("#npColor").value,
      order: cat==="sale"?50:isFree(cat)?70:90, min: cat==="shared"?1:6}));
    toast("Добавлено в меню");
  }catch(e){ toast("Не сохранилось: "+e.message) }
}

/* ---------- старт ---------- */
(async () => {
  try{ TG?.ready(); TG?.expand(); TG?.setHeaderColor?.("#FFFFFF"); TG?.setBackgroundColor?.("#FFFFFF"); TG?.disableVerticalSwipes?.() }catch(e){}
  try{
    const d = await API.list();
    S.products = d.products; S.counts = d.counts; S.purchases = d.purchases; S.returns = d.returns || []; S.loaded = true;
    if(!API.live()) $("#sub").dataset.demo = "1";
    render();
    if(!API.live()) toast("Демо-режим: правки живут только в этом браузере");
  }catch(e){
    $("#view").innerHTML = `<div class="empty">Не удалось загрузить склад.<br><span class="note">${esc(e.message)}</span></div>`;
    $("#sub").textContent = "нет связи";
  }
})();
})();

/* HOROVOD HUB · бар — витрина склада. Логика расчётов перенесена из прототипа без изменений. */
(function(){
const C = window.HUB_CONFIG, TG = window.Telegram?.WebApp;
const SALE = C.SALE_PRICE, HORIZON = C.HORIZON, AMBER = C.AMBER, TARGET = C.TARGET;
const CAT = {sale:"По 1,50 €", water:"Вода · бесплатно", snack:"Снеки · бесплатно", shared:"Другое · на полках"};
const catName = c => CAT[c] || "Прочее";
const CATS = ["sale","water","snack","shared"];
const isFree = c => c === "water" || c === "snack";   // купили и раздали — деньги не вернутся
const S = {products:[], counts:[], purchases:[], returns:[], open:{}, tab:"menu", filter:"all", buy:{}, count:null, f:{}, M:null, loaded:false};

const $  = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const eur = n => { const v = Math.abs(+n||0) < 0.005 ? 0 : (+n||0);      // без «−0,00 €»
  return (v<0?"−":"") + Math.abs(v).toFixed(2).replace(".",",") + " €" };
const dec = n => { if(n == null || !isFinite(n)) return "—";   // без «−0,0»: знак как в eur()
  const v = Math.abs(n) < 0.05 ? 0 : n;
  return (v<0?"−":"") + Math.abs(v).toFixed(1).replace(".",",") };
const ddmm = iso => { const d = new Date(iso); return String(d.getDate()).padStart(2,"0")+"."+String(d.getMonth()+1).padStart(2,"0") };
const days = (a,b) => (new Date(b) - new Date(a)) / 864e5;
const plural = (n,a,b,c) => { n = Math.abs(n)%100; const m = n%10; if(n>10&&n<20) return c; if(m>1&&m<5) return b; if(m==1) return a; return c };
const num = v => parseFloat(String(v ?? "").replace(",",".")) || 0;
const haptic = t => { try{ TG?.HapticFeedback?.impactOccurred(t||"light") }catch(e){} };

/* ---------- картинка товара: фото, если есть, иначе рисованная тара ---------- */
function art(p){
  const c = esc(p.color || "#8A90A0"), k = p.shape || "can", cap = esc(p.cap || "#E43");
  if(k==="can")     return `<svg class="fb" viewBox="0 0 40 64"><rect x="6" y="6" width="28" height="54" rx="6" fill="${c}"/><rect x="9" y="3" width="22" height="6" rx="3" fill="#B9BEC8"/><rect x="6" y="24" width="28" height="16" fill="#fff" opacity=".85"/><rect x="12" y="29" width="16" height="6" rx="2" fill="${c}"/></svg>`;
  if(k==="bottle")  return `<svg class="fb" viewBox="0 0 30 72"><rect x="11" y="2" width="8" height="5" rx="1.5" fill="#C9A43A"/><path d="M11 7h8v12c0 4 7 7 7 13v34a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V32c0-6 7-9 7-13z" fill="${c}"/><rect x="4" y="40" width="22" height="16" fill="#fff" opacity=".85"/><rect x="8" y="45" width="14" height="6" rx="2" fill="${c}"/></svg>`;
  if(k==="pet")     return `<svg class="fb" viewBox="0 0 34 80"><rect x="12" y="2" width="10" height="6" rx="2" fill="${cap}"/><path d="M12 8h10v6c0 3 8 6 8 13v47a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V27c0-7 8-10 8-13z" fill="${c}" opacity=".92"/><rect x="4" y="36" width="26" height="18" fill="#fff" opacity=".8"/><rect x="8" y="42" width="18" height="6" rx="2" fill="${c}"/></svg>`;
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
    // Если подсчёт сохранён приложением, деньги периода взяты из него и больше не
    // пересчитываются: правка цены сегодня не должна переписывать прошлый месяц.
    const fz = b.frozen && typeof b.frozen === "object" ? b.frozen : null;
    if(fz){
      if(fz.costSale  != null) costSale  = +fz.costSale;
      if(fz.costWater != null) costWater = +fz.costWater;
      if(fz.depSpent  != null) depSpent  = +fz.depSpent;
    }
    const price = fz?.price != null ? +fz.price : SALE;
    const expected = saleUnits*price, got = (+b.cash||0) + (+b.card||0) - backed;
    recs.push({id:b.id, from:a, to:b, days:days(a.date,b.date), cons, meas, bought, saleUnits, freeUnits, backed, buys,
      frozen:!!fz, price, expected, got, short: got-expected, costSale, costWater, depSpent,
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
                    perWeek: measured && r.days>=1 ? Math.max(0,r.cons[p.id]/r.days*7) : null});
      // Период короче суток — не измерение: пара подсчётов подряд давала бы
      // расход в сотни штук в день и заказ на тысячи штук.
      if(measured && r.days >= 1){ tot += r.cons[p.id]; dd += r.days }
    }
    const rate = dd>0 ? Math.max(0, tot/dd) : null;      // шт в день; null = данных ещё нет
    const exact = (base ?? 0) + (since[p.id]||0);
    let est = exact;
    if(rate) est = Math.max(0, exact - rate*dSince);
    const estimated = !!rate && dSince >= 1;
    // Срок считаем от факта, а не от прогноза: иначе запас «тает» сам и приложение
    // краснеет между подсчётами, хотя никто ничего не мерял.
    const daysLeft = rate ? exact/rate : null;

    // «общие» попадают к нам случайно, «распродаём» специально не докупаем:
    // и те и другие не тревожат красным и не просятся в закупку
    const restock = p.cat !== "shared" && !p.phaseout;
    let st = "none";
    if(restock){
      st = "green";
      // минимум — жёсткий пол: ниже него тревожим, даже если по расходу «хватит надолго»
      if(Math.round(exact) <= 0) st = "red";
      else if(p.min != null && exact < p.min) st = "red";      // минимум значит одно: ниже нельзя
      else if(daysLeft != null && daysLeft < HORIZON) st = "red";
      else if(daysLeft != null && daysLeft < AMBER) st = "amber";
    }

    let need = 0;
    // Предлагаем купить только когда есть повод. Иначе нехватка в треть штуки
    // округлялась до целой упаковки — и в списке висело то, чего хватает на месяц.
    if(restock && st !== "green"){
      const byRate = rate ? rate*TARGET - exact : 0;
      const byMin  = p.min != null ? p.min*2 - exact : 0;
      need = Math.max(0, byRate, byMin);
      if(need>0 && p.pack) need = Math.ceil(need/p.pack)*p.pack; else need = Math.ceil(need);
    }

    items[p.id] = {est, exact, estimated, rate, daysLeft, st, need, restock, periods, bought:since[p.id]||0, base};
  }
  // История цен по товару: цена зависит от магазина, и скачок 0,47 → 0,65 должен
  // объясняться сам — где купили и каким был разброс.
  for(const p of S.products){
    const h = [];
    for(const x of purch){
      const pr = x.prices && typeof x.prices === "object" ? x.prices.list : null;
      const v = pr && pr[p.id];
      if(v > 0) h.push({date:x.date, price:+v, source:x.source || null});
    }
    h.sort((a,b) => a.date < b.date ? -1 : 1);
    items[p.id].prices = h;
  }

  // сдача тары: сколько всего сдали и сколько залога ещё лежит в пустой таре
  const tare = S.returns.reduce((o,r) => ({units:o.units+(+r.units||0), amount:o.amount+(+r.amount||0)}),
                                {units:0, amount:0});
  tare.last = S.returns.map(r => r.date).sort().pop() || null;

  // Залог в пустой таре считаем ОТ ПОСЛЕДНЕЙ СДАЧИ: сдал — значит обнулилось.
  // Раньше это была разница «всё выпитое с июля минус все сдачи», и там оставался
  // хвост, который не сходился ни с чем и не был кратен залогу.
  const lastRet = tare.last;
  // тара копится с последнего события: что позже — подсчёт или сдача
  const from = lastRet && (!last || lastRet > last.date) ? lastRet : last?.date;
  const dGrow = from ? Math.max(0, days(from, new Date().toISOString())) : 0;
  let units = 0;                                   // целые бутылки и банки с залогом
  for(const p of S.products){
    if(!(+p.dep)) continue;
    for(const r of recs){
      const c = Math.max(0, r.cons[p.id] || 0);
      if(!c) continue;
      if(!lastRet){ units += c; continue }
      if(r.to.date <= lastRet) continue;            // период целиком до сдачи — та тара уже сдана
      // сдача пришлась на середину периода — берём часть по дням
      const share = r.from.date >= lastRet ? 1
                  : Math.max(0, Math.min(1, days(lastRet, r.to.date) / (r.days || 1)));
      units += c * share;
    }
    const it = items[p.id];
    if(it?.rate) units += it.rate * dGrow;          // после подсчёта/сдачи — по среднему расходу
  }
  tare.unitsWaiting = Math.max(0, Math.round(units));      // копим целыми штуками
  tare.waiting = tare.unitsWaiting * C.DEPOSIT;            // поэтому сумма всегда кратна залогу
  tare.back = S.returns.reduce((s,r) => s + (+r.amount||0), 0);

  // Накопительный счёт — «карма». Считается от последней амнистии: старый долг
  // не тащим, иначе планка недостижима и приложение перестают открывать.
  const amnestyAt = counts.filter(c => c.amnesty).map(c => c.date).sort().pop() || null;
  const scored = amnestyAt ? recs.filter(r => r.from.date >= amnestyAt) : recs;
  const all = scored.reduce((o,r) => ({expected:o.expected+r.expected, got:o.got+r.got,
    cost:o.cost+r.costSale+r.costWater, units:o.units+r.saleUnits}),
    {expected:0, got:0, cost:0, units:0});
  all.short = all.got - all.expected;
  all.net   = all.got - all.cost;
  all.payRate = all.expected > 0 ? all.got/all.expected : null;
  all.since  = amnestyAt;
  all.periods = scored.length;

  // сколько периодов подряд с конца держим планку — по ним снижаем цену
  all.streak = 0;
  for(let i = scored.length - 1; i >= 0; i--){
    if(scored[i].payRate != null && scored[i].payRate >= C.GOAL_RATE) all.streak++;
    else break;
  }
  all.goalReached = all.streak >= C.GOAL_PERIODS;

  return {counts, purch, recs, last, lastRec:recs[recs.length-1], items, dSince, tare, all};
}

/* ---------- меню ---------- */
const sorted = () => [...S.products].filter(p => S.filter === "hidden" ? p.hidden : !p.hidden)
                                     .sort((a,b)=>(a.order??99)-(b.order??99));
const flag = (it,p) => p.phaseout   ? `<span class="flag grey">Распродаём</span>`
                     : it.st==="red"   ? `<span class="flag red">${Math.round(it.exact)<=0?"Закончилось":"Докупить"}</span>`
                     : it.st==="amber" ? `<span class="flag amber">Скоро</span>` : "";

function stockLine(it){
  // Крупное число — то, что посчитал человек, плюс закупки. Само оно не убывает:
  // средний расход — догадка, и выдавать догадку за остаток нельзя.
  const n = Math.round(it.exact);
  if(n <= 0) return `<div class="stk red"><b class="num">0</b><span>нет</span></div>`;
  const t = it.daysLeft != null
    ? (it.daysLeft > 60 ? "надолго" : it.daysLeft < 1 ? "на исходе" : "на "+Math.floor(it.daysLeft)+" дн.")
    : plural(n,"штука","штуки","штук");
  return `<div class="stk ${it.st!=="green"?it.st:""}"><b class="num">${n}</b><span>${t}</span></div>`;
}
const tagFor = p => p.cat==="sale" ? `<span class="tag num">${eur(SALE)}</span>`
                  : isFree(p.cat) ? `<span class="tag free">бесплатно</span>`
                  : `<span class="tag">общее</span>`;

function money(r){
  const pct = r.payRate != null ? Math.round(r.payRate*100) : null;
  const be  = r.breakEven != null && isFinite(r.breakEven) ? Math.round(r.breakEven*100) : null;
  return `<dl class="recon num">
      <dt>Выпито платных</dt><dd>${r.saleUnits} шт</dd>
      <dt>Должно быть (× ${eur(r.price ?? SALE)})</dt><dd>${eur(r.expected)}</dd>
      <dt>Пришло за напитки</dt><dd>${eur(r.got)}</dd>
      ${r.backed ? `<dt>вычтен возврат залога</dt><dd>−${eur(r.backed)}</dd>` : ""}
      <dt class="tot">Недобор</dt><dd class="tot ${r.short>=0?"pos":"neg"}">${r.short>0?"+":""}${eur(r.short)}${pct!=null?" · оплачено "+pct+"%":""}</dd>
    </dl>
    <dl class="recon num" style="margin-top:12px">
      <dt>Закупка выпитого</dt><dd>${r.costSale?"−":""}${eur(r.costSale)}</dd>
      <dt>Бесплатное · ${r.freeUnits} шт · отбивки нет</dt><dd>${r.costWater?"−":""}${eur(r.costWater)}</dd>
      <dt class="tot">Итог периода</dt><dd class="tot ${r.net>=0?"pos":"neg"}">${r.net>0?"+":""}${eur(r.net)}</dd>
    </dl>
    <p class="note" style="margin:10px 0 0">Если бы платили все — ${r.ideal>0?"+":""}${eur(r.ideal)}. ${be!=null?`В ноль выходим при ${be}% оплаты.`:""}${r.depSpent?" Залога за тару ушло "+eur(r.depSpent)+" — вернётся при сдаче.":""}</p>
    ${(() => {
      const noPrice = S.products.filter(p => (p.cat==="sale"||isFree(p.cat)) && p.cost == null && (r.cons?.[p.id]||0) > 0);
      return noPrice.length ? `<p class="note" style="margin:6px 0 0"><b>Итог завышен:</b> у ${noPrice.length} ${plural(noPrice.length,"позиции","позиций","позиций")} не заполнена цена закупки, их выпили, но в расход они не попали — ${noPrice.map(p=>esc(p.name)).join(", ")}.</p>` : "";
    })()}
    ${r.buys != null ? `<p class="note" style="margin:6px 0 0">За период отмечено закупок: ${r.buys}. Если какая-то не отмечена, выпито посчитается меньше, а недобор выйдет больше настоящего.</p>` : ""}`;
}

function renderMenu(M){
  const all = sorted();
  const shown = all.filter(p => M.items[p.id].restock || Math.round(M.items[p.id].exact) > 0);
  const cnt = f => all.filter(p => M.items[p.id].st === f).length;
  $("#chips").innerHTML =
    `<button class="chip" data-f="all" aria-pressed="${S.filter==="all"}">Всё<span class="n num">${shown.length}</span></button>`+
    `<button class="chip" data-f="red" aria-pressed="${S.filter==="red"}"><span class="dot" style="background:var(--red)"></span>Докупить<span class="n num">${cnt("red")}</span></button>`+
    `<button class="chip" data-f="amber" aria-pressed="${S.filter==="amber"}"><span class="dot" style="background:var(--amber)"></span>Скоро<span class="n num">${cnt("amber")}</span></button>`+
    (S.products.some(p=>p.hidden) ? `<button class="chip" data-f="hidden" aria-pressed="${S.filter==="hidden"}">Убранные<span class="n num">${S.products.filter(p=>p.hidden).length}</span></button>` : "");

  let html = "";
  const r = M.lastRec;
  if(r) html += `<button class="panel pad banner" id="moneyCard" style="margin-top:14px">
    <div class="h"><b>Период ${ddmm(r.from.date)} – ${ddmm(r.to.date)}</b><span class="pill ${r.net>=0?"green":"red"} num">${r.net>0?"+":""}${eur(r.net)}</span></div>
    <div class="note">Недобор ${eur(r.short)} · вода ${eur(r.costWater)}${r.payRate!=null?" · оплачено "+Math.round(r.payRate*100)+"%":""}</div></button>`;

  for(const cat of CATS){
    let ps = all.filter(p => p.cat===cat);
    if(S.filter !== "all") ps = ps.filter(p => M.items[p.id].st === S.filter);
    ps = ps.filter(p => M.items[p.id].restock || Math.round(M.items[p.id].exact) > 0);
    if(!ps.length) continue;
    const fold = cat === "shared";                       // общие свёрнуты, пока не откроешь
    const open = !fold || S.open[cat];
    html += fold
      ? `<button class="sec fold" data-sec="${cat}" aria-expanded="${open}">${CAT[cat]}<em>${ps.length} ${plural(ps.length,"позиция","позиции","позиций")}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></em></button>`
      : `<h2 class="sec">${CAT[cat]}<em>${ps.length} ${plural(ps.length,"позиция","позиции","позиций")}</em></h2>`;
    if(!open) continue;
    html += `<div class="grid">`;
    for(const p of ps){
      const it = M.items[p.id], out = Math.round(it.exact) <= 0;
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
        <div class="sub2 num">${Math.round(it.exact)} шт${p.pack?" · уп. "+p.pack:""}${p.cost?" · ~"+eur(it.need*(p.cost+(+p.dep||0))):""}</div></div>
        <span class="pill ${it.st==="green"?"ink":it.st} num">+${it.need}</span></div>`;
    }
    const goods = needs.reduce((s,p)=> s + (p.cost ? M.items[p.id].need*p.cost : 0), 0);
    const deps  = needs.reduce((s,p)=> s + M.items[p.id].need*(+p.dep||0), 0);
    h += `<div class="row"><div class="info"><div class="nm">Взять с собой</div><div class="sub2">товар ${eur(goods)} с НДС + залог ${eur(deps)}</div></div><b class="num">${eur(goods+deps)}</b></div></div>
      <button class="btn ghost" id="fillNeed" style="margin-top:10px">Перенести в закупку</button>`;
  }
  if(!needs.length) h += `</div>`;

  h += `<h2 class="sec">Чек<em>главный способ завести закупку</em></h2>
  <div class="panel pad">
    <label class="shot" for="rcpt">
      <span class="shot-i">${S.f.photo ? `<img src="${S.f.photo}" alt="">` : `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h2L9 4h6l1.5 2h2A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.5"/></svg>`}</span>
      <span class="shot-t"><b>${S.f.photo ? "Чек прикреплён" : "Сфотографировать чек"}</b>
        <small>${S.f.photo ? "нажми, чтобы переснять" : "фото сохранится в карточке закупки"}</small></span>
    </label>
    <input type="file" accept="image/*" capture="environment" id="rcpt" hidden>
    <p class="note" style="margin:10px 0 0">${C.RECOGNIZE
      ? "Приложение разберёт чек: что куплено, по какой цене за штуку. Покажет разбор — подтвердишь."
      : "Разбор чека пока не подключён — фото сохранится к закупке, а количества отметь ниже."}</p>
    ${S.f.parsing ? `<div class="parsing"><i></i>Читаю чек… это занимает полминуты</div>` : ""}
    ${S.f.parsed && !S.f.parsing ? `<button class="lnk" id="parseAgain">показать разбор снова</button>` : ""}
  </div>
  <button class="lnk" id="manualToggle" aria-expanded="${C.RECOGNIZE && !S.f.manual ? "false" : "true"}">ввести вручную</button>
  <div id="manual"${C.RECOGNIZE && !S.f.manual ? " hidden" : ""}>
  <h2 class="sec">Отметить закупку<em>плюсами — что купил</em></h2><div class="panel">`;
  // позиции на сбыт не докупаем — в списке закупки им делать нечего
  for(const cat of CATS) for(const p of all.filter(x => x.cat===cat && !x.phaseout)){
    h += `<div class="row"><div class="mini">${pic(p)}</div><div class="info"><div class="nm">${esc(p.name)}</div>
      <div class="sub2">${esc(p.vol||"")}${p.pack?" · упак. "+p.pack:""}</div></div>${stepper(p.id, S.buy[p.id]||0, "b")}</div>`;
  }
  h += `</div>
  <button class="btn ghost" id="tareBtn" style="margin-top:12px">Сдал тару · накопилось ${M.tare.unitsWaiting} шт ~${eur(M.tare.waiting)}</button>
  <div class="fields" style="margin-top:12px">
    <div class="field"><label for="buySum">Сумма чека, €</label><input id="buySum" value="${esc(S.f.buySum||"")}" inputmode="decimal" placeholder="например 97,48"></div>
    <div class="field"><label for="buyWho">Кто купил</label><input id="buyWho" value="${esc(S.f.buyWho||"")}" placeholder="имя"></div>
    <div class="field" style="min-width:100%"><label for="buyWhere">Где купили</label><input id="buyWhere" value="${esc(S.f.buyWhere||"")}" placeholder="Metro, Lidl, Kaufland…" list="shops">
      <datalist id="shops">${[...new Set(M.purch.map(x => x.source).filter(Boolean))].map(x => `<option value="${esc(x)}">`).join("")}</datalist></div></div>
  </div>
  <details class="panel pad" style="margin-top:16px"><summary style="cursor:pointer;font-weight:600">+ Новый напиток</summary><div class="stack" style="margin-top:14px">
    <div class="fields"><div class="field"><label for="npName">Название</label><input id="npName" placeholder="Birell 0,0%"></div><div class="field"><label for="npVol">Объём</label><input id="npVol" placeholder="0,5 л, стекло"></div></div>
    <div class="fields"><div class="field"><label for="npCat">Категория</label><select id="npCat"><option value="sale">По 1,50 €</option><option value="water">Вода</option><option value="snack">Снеки</option><option value="shared">Другое, на полках</option></select></div>
    <div class="field"><label for="npShape">Тара</label><select id="npShape"><option value="bottle">Стекло</option><option value="can">Банка</option><option value="pet">ПЭТ</option><option value="water">Вода</option><option value="capsule">Капсула</option></select></div></div>
    <div class="fields"><div class="field"><label for="npCost">Закупка за шт, €</label><input id="npCost" inputmode="decimal"></div><div class="field"><label for="npPack">Упаковка, шт</label><input id="npPack" inputmode="numeric" value="6"></div>
    <div class="field"><label for="npDep">Залог, €</label><input id="npDep" inputmode="decimal" value="0,15"></div>
    <div class="field"><label for="npMin">Мин. остаток, шт</label><input id="npMin" inputmode="numeric" value="6"></div>
    <div class="field"><label for="npColor">Цвет</label><input id="npColor" type="color" value="#2F8F5B" style="padding:4px;height:46px"></div></div>
    <button class="btn ghost" id="npAdd">Добавить в меню</button></div></details>`;
  return h;
}

/* ---------- подсчёт ---------- */
function renderCount(M){
  const all = sorted();
  // Выкидываем позицию из подсчёта только если её обнулил ЧЕЛОВЕК на прошлом подсчёте.
  // По расчётной оценке нельзя: виски на полке «допился» бы сам и исчез из приложения.
  const countable = p => M.items[p.id].restock || (M.items[p.id].base ?? 0) > 0 || M.items[p.id].bought > 0;
  // Поля заполняем фактом: прошлый подсчёт плюс закупки. Расчётным расходом нельзя —
  // иначе догадка приложения молча станет записанным подсчётом.
  if(!S.count){ S.count = {}; for(const p of all) if(countable(p)) S.count[p.id] = Math.round(M.items[p.id].exact) }
  let h = `<h2 class="sec">Подсчёт раз в 2 недели<em>${M.last ? "прошлый "+ddmm(M.last.date)+" · "+Math.floor(M.dSince)+" дн. назад" : ""}</em></h2>
    <p class="note" style="margin:0 0 12px">Посчитай холодильник и полки вместе. Поля заполнены прошлым подсчётом плюс закупки — поправь на то, что видишь.</p><div class="panel">`;
  // кончившееся на сбыте не переспрашиваем: понадобится — заведут заново
  for(const cat of CATS) for(const p of all.filter(x => x.cat===cat && countable(x))){
    const it = M.items[p.id];
    h += `<div class="row"><div class="mini">${pic(p)}</div><div class="info"><div class="nm">${esc(p.name)}</div>
      <div class="sub2 num">было ${esc(it.base ?? "—")}${it.bought?" + куплено "+esc(it.bought):""}</div></div>${stepper(p.id, S.count[p.id] ?? 0, "c")}</div>`;
  }
  h += `</div><h2 class="sec">Деньги за период</h2><div class="fields">
    <div class="field"><label for="cCash">Касса (наличные), €</label><input id="cCash" value="${esc(S.f.cCash||"")}" inputmode="decimal" placeholder="0"></div>
    <div class="field"><label for="cCard">На карту «napoj HUB», €</label><input id="cCard" value="${esc(S.f.cCard||"")}" inputmode="decimal" placeholder="0"></div></div>
    <div class="panel pad" style="margin-top:12px" id="preview"></div>
    <div class="field" style="margin-top:12px"><label for="cWho">Кто считал</label><input id="cWho" value="${esc(S.f.cWho||"")}" placeholder="имя"></div>
    <label class="chk"><input type="checkbox" id="cAmnesty" ${S.f.amnesty?"checked":""}><span><b>Амнистия</b> — списать весь прошлый недобор и начать счёт с этого подсчёта</span></label>
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
  // те же поправки, что и в model(): иначе предпросмотр и сохранённый подсчёт разойдутся
  const from = M.last.date, nowIso = new Date().toISOString();
  const backed = S.returns.filter(r => r.toTill && r.date > from && r.date <= nowIso)
                          .reduce((s,r) => s + (+r.amount||0), 0);
  const buys = M.purch.filter(x => x.date > from && x.date <= nowIso).length;
  const exp = units*SALE;
  const got = num($("#cCash")?.value) + num($("#cCard")?.value) - backed;
  el.innerHTML = money({saleUnits:units, freeUnits:free, expected:exp, got, short:got-exp, backed, buys,
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
      const top = Object.entries(r.cons).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>`${esc(name(k))} ${esc(v)}`).join(" · ");
      h += `<div class="panel pad"><div class="h"><b>Подсчёт ${ddmm(r.to.date)}</b><span class="pill ${r.net>=0?"green":"red"} num">${r.net>0?"+":""}${eur(r.net)}</span></div>
        <p class="note" style="margin:0 0 10px">${ddmm(r.from.date)}–${ddmm(r.to.date)} · ${r.days < 1 ? "меньше суток" : Math.round(r.days)+" дн."}</p>
        ${money(r)}<p class="note" style="margin:10px 0 0">${top}</p>
        ${r.to.note?`<p class="note" style="margin:8px 0 0">${esc(r.to.note)}</p>`:""}
        <div style="text-align:right;margin-top:6px">${r.to.by?`<span class="note">считал(а): ${esc(r.to.by)}</span>`:""} <button class="del ${S.armed==="counts/"+r.to.id?"armed":""}" data-del="counts/${esc(r.to.id)}">${S.armed==="counts/"+r.to.id?"точно удалить?":"удалить"}</button></div></div>`;
    } else if(e.t === "buy"){ const p = e.p;
      const list = Object.entries(p.items||{}).filter(([,v])=>v>0).map(([k,v])=>`${esc(name(k))} +${esc(v)}`).join(" · ");
      const moved = p.prices?.moved && typeof p.prices.moved === "object" ? Object.entries(p.prices.moved) : [];
      h += `<div class="panel pad"><div class="h"><b>Закупка ${ddmm(p.date)}</b>${p.total?`<span class="num">${eur(+p.total)}</span>`:""}</div>
        <p class="note" style="margin:0">${list}</p>${p.source?`<p class="note" style="margin:6px 0 0">${esc(p.source)}</p>`:""}
        ${moved.length ? `<div class="moved">${moved.map(([k,m]) =>
            `<div><span>${esc(name(k))}</span><b class="num ${m.was!=null && m.now>m.was?"neg":"pos"}">${
              m.was==null ? "цена появилась · "+eur(m.now)
                          : eur(m.was)+" → "+eur(m.now)+" · "+(m.now>m.was?"+":"−")+eur(Math.abs(m.now-m.was))}</b></div>`
          ).join("")}</div>` : ""}
        ${p.receipt ? `<button class="lnk rcpt" data-rcpt="${esc(p.id)}">посмотреть чек</button>` : ""}
        <div style="text-align:right;margin-top:6px">${p.by?`<span class="note">${esc(p.by)}</span>`:""} <button class="del ${S.armed==="purchases/"+p.id?"armed":""}" data-del="purchases/${esc(p.id)}">${S.armed==="purchases/"+p.id?"точно удалить?":"удалить"}</button></div></div>`;
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
  const ph = it.prices || [];
  const lastBuy = ph[ph.length - 1];
  const buyLine = p.cost == null ? "цена закупки не заполнена"
    : `закупка ${eur(p.cost)} с НДС` + (dep ? ` · в магазине ${eur(p.cost+dep)} с залогом` : "") + (marg != null ? ` · маржа +${eur(marg)}` : "");
  const n = Math.round(it.exact);
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
      <div class="meta">${esc(p.vol||"")} · ${catName(p.cat)}</div>
      <div class="priceline">
        <b class="num">${p.cat==="sale" ? eur(SALE) : isFree(p.cat) ? "бесплатно" : "не продаётся"}</b>
        <span class="buy num">${buyLine}</span>
      </div>
      <div class="kv num">
        ${kv("Остаток"+(S.M.last?" на "+ddmm(S.M.last.date):""), n+" шт", it.st!=="green"?it.st:"")}
        ${it.estimated ? kv("Сейчас, по расчёту", "≈ "+Math.round(it.est)+" шт · прогноз", "dim") : ""}
        ${kv("Хватит на", it.daysLeft!=null ? (it.daysLeft>60?"больше 60 дн.":it.daysLeft<1?"меньше дня":Math.floor(it.daysLeft)+" "+plural(Math.floor(it.daysLeft),"день","дня","дней"))+" · прогноз" : "нет данных", it.daysLeft==null?"dim":(it.st!=="green"?it.st:""))}
        ${lastBuy ? kv("Цена из чека", eur(lastBuy.price) + (lastBuy.source ? " · "+esc(lastBuy.source) : "") + " · " + ddmm(lastBuy.date)) : ""}
        ${kv("Средний расход", it.rate != null ? dec(it.rate*7)+" в нед." : "нет данных", it.rate!=null?"":"dim")}
        ${kv("Купить на "+TARGET+" дн.", it.need ? "+"+it.need+" шт" : "не нужно", it.need?"":"dim")}
      </div>
      <div class="blk"><h4>Среднее использование</h4>${use}</div>
      ${ph.length > 1 ? `<div class="blk"><h4>Почём брали</h4>
        <div class="moved">${ph.slice(-6).reverse().map(x =>
          `<div><span>${ddmm(x.date)}${x.source ? " · "+esc(x.source) : ""}</span><b class="num">${eur(x.price)}</b></div>`
        ).join("")}</div>
        ${(() => { const v = ph.map(x => x.price), lo = Math.min(...v), hi = Math.max(...v);
          return hi - lo >= 0.005
            ? `<p class="note" style="margin:8px 0 0">Разброс ${eur(lo)} — ${eur(hi)}: цена зависит от магазина. Считаем по последней.</p>`
            : ""; })()}
      </div>` : ""}
      ${p.note ? `<div class="blk"><h4>Закупка</h4><p class="note" style="margin:0">${esc(p.note)}</p></div>` : ""}
      <div class="blk"><h4>Поправить</h4>
        <div class="fields"><div class="field"><label for="edCost">Закупка за шт, € с НДС</label><input id="edCost" inputmode="decimal" value="${p.cost ?? ""}"></div>
        <div class="field"><label for="edDep">Залог за тару, €</label><input id="edDep" inputmode="decimal" value="${p.dep ?? ""}"></div>
        <div class="field"><label for="edMin">Мин. остаток, шт</label><input id="edMin" inputmode="numeric" value="${p.min ?? ""}"></div></div>
        <label class="chk"><input type="checkbox" id="edPhase" ${p.phaseout?"checked":""}><span><b>Распродаём</b> — допиваем остаток, больше не докупаем</span></label>
      </div>
      <div class="fields" style="margin-top:16px"><button class="btn ghost" id="edClose" style="flex:1">Закрыть</button><button class="btn" id="edSave" style="flex:1">Сохранить</button></div>
      <div style="text-align:center"><button class="del" id="edHide" style="margin-top:12px">${p.hidden ? "вернуть в меню" : "убрать из меню"}</button></div>
    </div></div>`;
  document.body.appendChild(bg);
  haptic("light");

  const close = () => { bg.remove(); TG?.BackButton?.offClick(close); TG?.BackButton?.hide() };
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
    if(p.hidden){                                    // вернуть можно без подтверждения
      try{ await apply(API.updateProduct(p.id, {hidden:false})); toast("Вернул в меню"); close() }
      catch(e){ toast("Ошибка: "+e.message) }
      return;
    }
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
        <div class="field" style="min-width:100%"><label for="tNote">Примечание</label><input id="tNote" placeholder="необязательно"></div>
      </div>
      <p class="note" id="tCalc" style="margin:10px 0 0">Это <b>0 шт</b> тары.</p>
      <label class="chk"><input type="checkbox" id="tTill" checked><span><b>Деньги положил в кассу</b> — тогда приложение не посчитает их донатами за напитки</span></label>
      <div class="blk"><h4>Тара</h4>
        <dl class="recon num">
          <dt>Сдано за всё время</dt><dd>${M.tare.units} шт · ${eur(M.tare.amount)}</dd>
          ${M.tare.last ? `<dt>Последняя сдача</dt><dd>${ddmm(M.tare.last)}</dd>` : ""}
          <dt class="tot">Накопилось после сдачи</dt><dd class="tot">${M.tare.unitsWaiting} шт · ${eur(M.tare.waiting)}</dd>
        </dl>
        <p class="note" style="margin:8px 0 0">Считается от последней сдачи: сдал — обнулилось, дальше копится заново. Берутся целые бутылки и банки с залогом, поэтому сумма всегда кратна ${eur(C.DEPOSIT)}. До ближайшего подсчёта это прикидка по среднему расходу, а на подсчёте цифра перепишется на то, что выпили на самом деле.</p>
      </div>
      <div class="fields" style="margin-top:16px"><button class="btn ghost" id="tClose" style="flex:1">Закрыть</button><button class="btn" id="tSave" style="flex:1">Записать</button></div>
    </div></div>`;
  document.body.appendChild(bg);
  const close = () => { bg.remove(); TG?.BackButton?.offClick(close); TG?.BackButton?.hide() };
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
        toTill:bg.querySelector("#tTill").checked, by:bg.querySelector("#tWho").value.trim()||null,
        note:bg.querySelector("#tNote").value.trim()||null}));
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
      ${S.M.all.since && !S.M.all.periods ? `<div class="blk"><h4>Амнистия ${ddmm(S.M.all.since)}</h4>
        <p class="note" style="margin:0">Прошлый недобор списан. Счёт начнётся со следующего подсчёта: цель — платить за ${Math.round(C.GOAL_RATE*100)}% выпитого. Продержим ${C.GOAL_PERIODS} ${plural(C.GOAL_PERIODS,"период","периода","периодов")} подряд — и цена упадёт до ${eur(1)}.</p></div>` : ""}
      ${S.M.all.periods ? `<div class="blk"><h4>${S.M.all.since ? "С амнистии "+ddmm(S.M.all.since) : "За всё время"}</h4>
        <dl class="recon num">
          <dt>Выпито платных</dt><dd>${S.M.all.units} шт</dd>
          <dt>Должно было прийти</dt><dd>${eur(S.M.all.expected)}</dd>
          <dt>Пришло</dt><dd>${eur(S.M.all.got)}${S.M.all.payRate!=null?" · "+Math.round(S.M.all.payRate*100)+"%":""}</dd>
          <dt>Потрачено на напитки</dt><dd>${S.M.all.cost?"−":""}${eur(S.M.all.cost)}</dd>
          <dt class="tot">Бар в сумме</dt><dd class="tot ${S.M.all.net>=0?"pos":"neg"}">${S.M.all.net>0?"+":""}${eur(S.M.all.net)}</dd>
        </dl>
        <div class="goal">
          <div class="goal-bar"><i style="width:${Math.min(100, Math.round((S.M.all.payRate||0)*100))}%" class="${(S.M.all.payRate||0) >= C.GOAL_RATE ? "ok" : ""}"></i><b style="left:${C.GOAL_RATE*100}%"></b></div>
          <p class="note" style="margin:8px 0 0">${
            S.M.all.goalReached
              ? `Планка взята ${S.M.all.streak} ${plural(S.M.all.streak,"период","периода","периодов")} подряд — можно опускать цену до ${eur(1)}.`
              : `Платят за ${Math.round((S.M.all.payRate||0)*100)}% выпитого. Цель — ${Math.round(C.GOAL_RATE*100)}%: ${C.GOAL_PERIODS} ${plural(C.GOAL_PERIODS,"период","периода","периодов")} подряд, и цена падает до ${eur(1)}.${S.M.all.streak?` Держим ${S.M.all.streak} подряд.`:""}`
          }</p></div></div>` : ""}
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
  const close = () => { bg.remove(); TG?.BackButton?.offClick(close); TG?.BackButton?.hide() };
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
  if(t){ const was = S.tab; S.tab = t.dataset.tab;
    document.querySelectorAll(".tab").forEach(x => x.setAttribute("aria-selected", x === t));
    if(S.tab === "count" && was !== "count") S.count = null;   // не стираем набранное при тапе по активной вкладке
    haptic("light"); render(); scrollTo(0,0); return }
  const f = e.target.closest("[data-f]"); if(f){ S.filter = f.dataset.f; haptic("light"); render(); return }
  const sc = e.target.closest("[data-sec]"); if(sc){ S.open[sc.dataset.sec] = !S.open[sc.dataset.sec]; haptic("light"); render(); return }
  const c = e.target.closest(".card[data-p]"); if(c){ const p = S.products.find(x => x.id === c.dataset.p); if(p) sheet(p); return }
  if(e.target.closest("#moneyCard")){ moneySheet(S.M.lastRec); return }
  if(e.target.id === "tareBtn"){ tareSheet(S.M); return }
  const s = e.target.closest(".step button");
  // счётчики внутри шторок обслуживают себя сами
  if(s && !s.closest(".sheet-bg")){ const inp = s.parentElement.querySelector("input"), v = Math.max(0,(parseInt(inp.value)||0) + (+s.dataset.d)); inp.value = v; setVal(inp.dataset.k, s.dataset.id, v); haptic("light"); return }
  if(e.target.closest("#fillNeed")){ for(const p of sorted()){ const n = S.M.items[p.id]?.need; if(n) S.buy[p.id] = n } render(); toast("Список перенесён — поправь по чеку"); return }
  const rf = e.target.closest("#refresh");
  if(e.target.id === "manualToggle"){ S.f.manual = !S.f.manual; render(); return }
  if(e.target.id === "parseAgain"){ parseSheet(); return }
  const rc = e.target.closest?.("[data-rcpt]");
  if(rc){
    const id = rc.dataset.rcpt, was = rc.textContent;
    rc.textContent = "загружаю…"; rc.disabled = true;
    try{
      const f = await API.receipt(id);
      showReceipt(`data:${f.mime};base64,${f.data}`);
    }catch(err){ toast("Не вышло: "+err.message) }
    rc.textContent = was; rc.disabled = false;
    return;
  }
  if(rf){ rf.classList.add("spin"); try{ await apply(API.list(true)); toast("Обновлено") }catch(err){ toast("Не вышло: "+err.message) } rf.classList.remove("spin"); return }
  const d = e.target.closest("[data-del]");
  if(d){ if(S.armed !== d.dataset.del){ S.armed = d.dataset.del; render(); return }
    const [col,id] = d.dataset.del.split("/");
    S.armed = null;
    try{ await apply(API.del(col,id)); toast("Удалено") }catch(er){ toast("Ошибка: "+er.message) } return }
  if(e.target.id === "npAdd") return addProduct();
  if(e.target.id === "dockBtn") return e.target.dataset.a === "buy" ? saveBuy() : saveCount();
});
document.addEventListener("input", e => {
  const i = e.target;
  if(i.dataset?.k){
    const v = Math.max(0, parseInt(i.value)||0);
    if(String(v) !== i.value.trim() && i.value.trim() !== "") i.value = v;   // не даём полю врать
    setVal(i.dataset.k, i.dataset.id, v);
  }
  if(["buySum","buyWho","buyWhere","cCash","cCard","cWho"].includes(i.id)) S.f[i.id] = i.value;
  if(i.id === "cAmnesty") S.f.amnesty = i.checked;
  if(i.id === "cCash" || i.id === "cCard") previewCount(S.M);
});
addEventListener("scroll", () => $("#top").classList.toggle("stuck", scrollY > 6), {passive:true});

function setVal(k,id,v){
  if(k === "b"){ S.buy[id] = v; dock() } else { S.count[id] = v; previewCount(S.M) }
  const el = document.getElementById(k+"-"+id);
  if(el) el.classList.toggle("changed", k === "b" ? v > 0 : v !== Math.round(S.M.items[id].exact));
}
/* Чек — это плотный мелкий текст, а не этикетка: ужимать его как картинку нельзя,
   иначе цены и названия превращаются в кашу. Держим до 2400 px по длинной стороне
   и высокое качество; снимок с телефона после этого весит около мегабайта —
   для одного запроса в месяц это нормально, а строки чека остаются читаемыми. */
function shrink(file, max = 2400, q = 0.88){
  return new Promise((ok, no) => {
    const fr = new FileReader();
    fr.onerror = () => no(new Error("Не получилось прочитать файл"));
    fr.onload = () => {
      const im = new Image();
      im.onerror = () => no(new Error("Это не похоже на картинку"));
      im.onload = () => {
        const k = Math.min(1, max/Math.max(im.width, im.height));
        const c = document.createElement("canvas");
        c.width = Math.round(im.width*k); c.height = Math.round(im.height*k);
        c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
        ok(c.toDataURL("image/jpeg", q));
      };
      im.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

addEventListener("change", async e => {
  if(e.target.id !== "rcpt") return;
  const f = e.target.files?.[0]; if(!f) return;
  if(!/^image\//.test(f.type)) return toast("Нужна фотография чека");
  try{
    S.f.photo = await shrink(f);
    const kb = Math.round(S.f.photo.length * 0.75 / 1024);
    toast(`Чек прикреплён · ${kb >= 1024 ? (kb/1024).toFixed(1)+" МБ" : kb+" КБ"}`);
    haptic("light");
    render();
    if(C.RECOGNIZE && API.live()) readReceipt();
  }catch(err){ toast("Не вышло: "+err.message) }
});

/* Разбор чека и подтверждение.
   Модель ошибается, поэтому записываем только то, что человек увидел глазами.
   Спорное показываем сразу, понятное прячем под строку — чтобы не листать
   пятнадцать одинаковых строк и не терять бдительность на шестнадцатой. */
async function readReceipt(){
  S.f.parsing = true; render();
  try{
    const d = await API.parse(S.f.photo);
    S.f.parsing = false;
    S.f.parsed = prepParsed(d);
    render();
    parseSheet();
  }catch(err){
    S.f.parsing = false; render();
    toast("Не разобрал: " + err.message);
  }
}

// «спорной» считаем строку, где модель не уверена или цифра выглядит странно
function prepParsed(d){
  const rows = (d.lines || []).map((l, i) => {
    const p = l.match ? S.products.find(x => x.id === l.match) : null;
    const was = p && p.cost != null ? +p.cost : null;
    const jump = was != null && l.unit != null && was > 0
      ? Math.abs(l.unit - was) / was : 0;
    const why = !l.match ? "не понял, что за товар"
              : l.unit == null ? "не разобрал цену"
              : !l.qty ? "не разобрал количество"
              : jump > 0.25 ? `цена ушла на ${Math.round(jump*100)}% (было ${eur(was)})`
              : null;
    return {i, name:l.name, article:l.article||null, qty:l.qty||0, unit:l.unit,
            id:l.match || "", was, doubt:why, use:true};
  });
  return {shop:d.shop||"", date:d.date||"", total:d.total ?? null,
          check:d.check||null, skipped:d.skipped||0, rows};
}

async function saveBuy(){
  const items = {}; for(const [k,v] of Object.entries(S.buy)) if(v > 0) items[k] = v;
  if(!Object.keys(items).length) return;
  // Без суммы и без имени закупка бесполезна: по ней не пересчитать цену за штуку
  // и не спросить, если что-то не сходится.
  const total = num($("#buySum")?.value), who = $("#buyWho")?.value.trim(),
        where = $("#buyWhere")?.value.trim();
  if(!(total > 0)){ toast("Впиши сумму чека"); $("#buySum")?.focus(); return }
  if(!who){ toast("Впиши, кто закупал"); $("#buyWho")?.focus(); return }
  // без магазина цена за штуку повисает в воздухе: в Metro одна, в Kaufland другая
  if(!where){ toast("Впиши, где купили"); $("#buyWhere")?.focus(); return }
  const b = $("#dockBtn"); b.disabled = true;
  try{
    await apply(API.addPurchase({date:new Date().toISOString(), items, total, by:who,
                                 source:where, photo:S.f.photo||null}));
    S.buy = {}; S.f.buySum = ""; S.f.photo = null; toast("Закупка добавлена на склад"); haptic("medium");
    S.tab = "menu"; document.querySelectorAll(".tab").forEach(x => x.setAttribute("aria-selected", x.dataset.tab === "menu")); render(); scrollTo(0,0);
  }catch(e){ toast("Не сохранилось: "+e.message); b.disabled = false }
}
async function saveCount(){
  // В подсчёт идёт то, что показывали. Скрытым переносим прошлый остаток:
  // иначе убранная из меню позиция рвёт расчёт расхода в следующем периоде.
  const stock = {};
  for(const p of S.products){
    if(S.count[p.id] != null) stock[p.id] = S.count[p.id];
    else if(p.hidden && S.M.items[p.id]?.base != null) stock[p.id] = S.M.items[p.id].base;
  }
  const b = $("#dockBtn"); b.disabled = true;
  try{
    // вместе с остатками сохраняем деньги периода как факт, а не как формулу
    const M = S.M, base = M.last?.stock || {};
    let saleU = 0, freeU = 0, cSale = 0, cWater = 0, dep = 0;
    for(const p of sorted()){
      dep += (M.items[p.id]?.bought || 0) * (+p.dep || 0);
      if(base[p.id] == null || stock[p.id] == null) continue;
      const c = base[p.id] + (M.items[p.id]?.bought || 0) - stock[p.id];
      if(p.cat === "sale"){ saleU += c; if(p.cost != null) cSale += c*p.cost }
      if(isFree(p.cat)){ freeU += c; if(p.cost != null) cWater += c*p.cost }
    }
    await apply(API.addCount({date:new Date().toISOString(), stock,
      cash:num($("#cCash").value), card:num($("#cCard").value), by:$("#cWho").value.trim()||null,
      amnesty: !!$("#cAmnesty")?.checked,
      frozen:{price:SALE, saleUnits:saleU, freeUnits:freeU, costSale:+cSale.toFixed(4),
              costWater:+cWater.toFixed(4), depSpent:+dep.toFixed(4)}}));
    S.count = null; S.f.cCash = S.f.cCard = ""; toast("Подсчёт сохранён"); haptic("medium");
    S.tab = "hist"; document.querySelectorAll(".tab").forEach(x => x.setAttribute("aria-selected", x.dataset.tab === "hist")); render(); scrollTo(0,0);
  }catch(e){ toast("Не сохранилось: "+e.message); b.disabled = false }
}
async function addProduct(){
  const name = $("#npName").value.trim(); if(!name){ toast("Впиши название"); return }
  // кириллицу переводим в латиницу: id попадает в имя файла с фотографией
  const TR = {а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"e",ж:"zh",з:"z",и:"i",й:"y",к:"k",л:"l",м:"m",н:"n",
    о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"h",ц:"c",ч:"ch",ш:"sh",щ:"sch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya"};
  const id = (name.toLowerCase().replace(/[а-яё]/g, c => TR[c] ?? "")
    .replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,28) || "item") + "-" + Date.now().toString(36);
  const cat = $("#npCat").value;
  try{
    await apply(API.addProduct(id, {name, vol:$("#npVol").value.trim(), cat, shape:$("#npShape").value,
      cost:num($("#npCost").value)||null, dep:num($("#npDep").value)||0,
      pack:parseInt($("#npPack").value)||null, color:$("#npColor").value,
      order: cat==="sale"?50:isFree(cat)?70:90,
      min: parseInt($("#npMin").value) || (cat==="shared"?1:6), phaseout:false, hidden:false}));
    toast("Добавлено в меню");
  }catch(e){ toast("Не сохранилось: "+e.message) }
}

/* Отладочный доступ к модели: включается только адресом с ?debug=1.
   Нужен для сверки цифр приложения против эталонного пересчёта. */
if(location.search.includes("debug=1")) window.__hub = {S, model, get M(){ return S.M }};

/* Окно подтверждения разбора */
function parseSheet(){
  const P = S.f.parsed; if(!P) return;
  const opts = id => `<option value=""${id?"":" selected"}>— не заводить —</option>` +
    CATS.flatMap(c => S.products.filter(p => p.cat === c && !p.hidden)
      .map(p => `<option value="${esc(p.id)}"${p.id===id?" selected":""}>${esc(p.name)}${p.vol?" · "+esc(p.vol):""}</option>`)).join("");

  const row = r => `<div class="prow${r.doubt?" doubt":""}" data-i="${r.i}">
    <div class="prow-h"><label class="chk"><input type="checkbox" class="pUse" ${r.use?"checked":""}><span>${esc(r.name)}</span></label></div>
    ${r.doubt ? `<div class="prow-w">${esc(r.doubt)}</div>` : ""}
    <div class="fields">
      <div class="field" style="min-width:100%"><label>Товар</label><select class="pId">${opts(r.id)}</select></div>
      <div class="field"><label>Штук</label><input class="pQty" inputmode="numeric" value="${r.qty||""}"></div>
      <div class="field"><label>За штуку, €</label><input class="pUnit" inputmode="decimal" value="${r.unit ?? ""}"></div>
    </div></div>`;

  const bad = P.rows.filter(r => r.doubt), good = P.rows.filter(r => !r.doubt);
  const bg = document.createElement("div");
  bg.className = "sheetbg";
  bg.innerHTML = `<div class="sheet"><div class="grab"></div><div class="pad">
    <h3>Чек разобран</h3>
    <p class="note" style="margin:2px 0 12px">${esc(P.shop||"магазин не распознан")}${P.date?" · "+esc(P.date):""}${P.total!=null?" · итог "+eur(P.total):""}${P.skipped?` · пропущено залоговых строк: ${P.skipped}`:""}</p>
    ${P.check && P.check.fits === false ? `<p class="warn">Сумма позиций ${eur(P.check.sum)} не сходится с итогом чека ${eur(P.check.total)}. Проверь внимательно.</p>` : ""}
    ${bad.length ? `<h4 class="psec">Требует внимания · ${bad.length}</h4>${bad.map(row).join("")}` : `<p class="note" style="margin:0 0 12px">Вопросов нет — всё сопоставилось.</p>`}
    ${good.length ? `<details class="fold"><summary>Ещё ${good.length} ${plural(good.length,"позиция","позиции","позиций")} · всё понятно</summary>${good.map(row).join("")}</details>` : ""}
    <div class="fields" style="margin-top:16px">
      <button class="btn ghost" id="pCancel" style="flex:1">Отмена</button>
      <button class="btn" id="pOk" style="flex:1">Записать закупку</button>
    </div></div></div>`;
  document.body.appendChild(bg);
  const close = () => { bg.remove(); TG?.BackButton?.offClick(close); TG?.BackButton?.hide() };
  TG?.BackButton?.show(); TG?.BackButton?.onClick(close);

  bg.addEventListener("input", e => {
    const el = e.target.closest(".prow"); if(!el) return;
    const r = P.rows[+el.dataset.i];
    if(e.target.classList.contains("pId"))   r.id   = e.target.value;
    if(e.target.classList.contains("pQty"))  r.qty  = Math.max(0, parseInt(e.target.value)||0);
    if(e.target.classList.contains("pUnit")) r.unit = num(e.target.value) || null;
    if(e.target.classList.contains("pUse"))  r.use  = e.target.checked;
  });
  bg.addEventListener("click", async e => {
    if(e.target === bg || e.target.id === "pCancel") return close();
    if(e.target.id !== "pOk") return;
    const take = P.rows.filter(r => r.use && r.id && r.qty > 0);
    if(!take.length) return toast("Нечего записывать");
    const items = {}, prices = {}, learn = [];
    for(const r of take){
      items[r.id] = (items[r.id] || 0) + r.qty;
      if(r.unit > 0) prices[r.id] = r.unit;
      learn.push({id:r.id, name:r.name, article:r.article, shop:P.shop});
    }
    e.target.disabled = true;
    try{
      await apply(API.addPurchase({date:new Date().toISOString(), items, prices, learn,
        total: P.total ?? (num($("#buySum")?.value) || null),
        by: $("#buyWho")?.value.trim() || null, source: P.shop || null, photo: S.f.photo || null}));
      S.buy = {}; S.f.photo = null; S.f.parsed = null; S.f.buySum = "";
      toast("Закупка записана по чеку"); haptic("medium"); close(); render();
    }catch(err){ toast("Не сохранилось: "+err.message); e.target.disabled = false }
  });
}

function showReceipt(src){
  const bg = document.createElement("div");
  bg.className = "sheetbg photo";
  bg.innerHTML = `<div class="photowrap"><img src="${src}" alt="Чек"><button class="btn ghost" id="pClose">Закрыть</button></div>`;
  document.body.appendChild(bg);
  const close = () => { bg.remove(); TG?.BackButton?.offClick(close); TG?.BackButton?.hide() };
  bg.addEventListener("click", ev => { if(ev.target === bg || ev.target.id === "pClose") close() });
  TG?.BackButton?.show(); TG?.BackButton?.onClick(close);
}

/* ---------- старт ---------- */
(async () => {
  try{ TG?.ready(); TG?.expand(); TG?.setHeaderColor?.("#FFFFFF"); TG?.setBackgroundColor?.("#FFFFFF"); TG?.disableVerticalSwipes?.() }catch(e){}
  try{
    // Демо-режим уместен только локально. На боевом хосте пустой API означает одно:
    // Telegram поднял страницу из кэша, где ещё не было адреса сервера. Молчать нельзя —
    // иначе человек видит пустой склад и думает, что данные пропали.
    const localHost = ["localhost","127.0.0.1","0.0.0.0",""].includes(location.hostname);
    if(!API.live() && !localHost)
      throw new Error("Приложение поднялось из кэша Telegram. Закрой его полностью и открой заново.");
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

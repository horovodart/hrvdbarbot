/* Генератор случайных складов. Детерминированный: один и тот же seed → те же данные. */

export function mulberry32(a){
  return function(){ a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296 };
}

const DAY = 864e5;
const CATS = ["sale","water","snack","shared"];

export function gen(seed){
  const R = mulberry32(seed);
  const ri = (a,b) => a + Math.floor(R()*(b-a+1));
  const rf = (a,b) => a + R()*(b-a);
  const pick = a => a[Math.floor(R()*a.length)];
  const chance = p => R() < p;

  // ---- злые режимы, включаются по жребию -------------------------------
  const tag = new Set();
  const zeroProducts = chance(0.05);
  const zeroCounts   = chance(0.04);
  const singleCount  = !zeroCounts && chance(0.15);
  const dupDate      = !zeroCounts && !singleCount && chance(0.25);
  const negCons      = chance(0.30);
  const missingProd  = chance(0.35);
  const nullCost     = chance(0.40);
  const emptyStock   = chance(0.15);
  const allNotToTill = chance(0.25);
  const earlyReturn  = chance(0.25);
  const useFrozen    = chance(0.12);
  const useAmnesty   = chance(0.12);
  const fracStock    = chance(0.18);   // дробные остатки — проверка округлений
  const onBoundary   = chance(0.30);   // даты закупок/возвратов ровно в дату подсчёта
  if(zeroProducts) tag.add("zeroProducts");
  if(zeroCounts)   tag.add("zeroCounts");
  if(singleCount)  tag.add("singleCount");
  if(dupDate)      tag.add("dupDate");
  if(useFrozen)    tag.add("frozen");
  if(useAmnesty)   tag.add("amnesty");
  if(fracStock)    tag.add("fracStock");

  // ---- товары -----------------------------------------------------------
  const nP = zeroProducts ? 0 : ri(3,15);
  const products = {};
  const ids = [];
  for(let i=0;i<nP;i++){
    const id = "p"+i; ids.push(id);
    const cat = pick(CATS);
    products[id] = {
      name:"Товар "+i, cat,
      cost: (nullCost && chance(0.30)) ? null : +rf(0.25,3.5).toFixed(2),
      dep: chance(0.5) ? 0.15 : 0,
      pack: chance(0.45) ? null : pick([6,12,24]),
      min: chance(0.1) ? null : ri(0,12),
      phaseout: chance(0.12),
      order: i
    };
  }

  // ---- подсчёты ---------------------------------------------------------
  const t0 = Date.UTC(2026,0,10,9,0,0);
  const nC = zeroCounts ? 0 : singleCount ? 1 : ri(2,4);
  const dates = [];
  let t = t0;
  for(let i=0;i<nC;i++){
    if(i>0){
      // ноль длины периода — отдельно просимый злой случай
      t += (dupDate && i===1) ? 0 : Math.round(rf(0.2,25)*DAY);
    }
    dates.push(new Date(t).toISOString());
  }

  const counts = {};
  const prevStock = {};
  dates.forEach((date,i) => {
    const c = { date, by:"фаззер", cash:+rf(0,200).toFixed(2), card:+rf(0,150).toFixed(2) };
    if(emptyStock && i>0 && chance(0.4)){ c.stock = {}; }
    else {
      const st = {};
      for(const id of ids){
        if(missingProd && chance(0.18)) continue;            // позиции нет в этом подсчёте
        const frac = fracStock && chance(0.5) ? pick([0.5,0.25,1.5,2.5]) : 0;
        if(i===0) st[id] = ri(0,60) + frac;
        else {
          const base = prevStock[id] ?? ri(0,60);
          // отрицательный расход: стало больше, чем было
          st[id] = negCons && chance(0.25) ? base + ri(1,25) : Math.max(0, base - ri(0,20)) + frac;
        }
      }
      c.stock = st;
      for(const [k,v] of Object.entries(st)) prevStock[k] = v;
    }
    if(useFrozen && i>0 && chance(0.5))
      c.frozen = {costSale:+rf(0,80).toFixed(2), costWater:+rf(0,40).toFixed(2),
                  depSpent:+rf(0,20).toFixed(2), price:pick([1.0,1.5,2.0])};
    if(useAmnesty && i>0 && chance(0.5)) c.amnesty = true;
    counts["c"+i] = c;
  });

  const span = dates.length ? Date.parse(dates[dates.length-1]) - t0 : 20*DAY;

  // ---- закупки ----------------------------------------------------------
  const purchases = {};
  const nB = ri(0,5);
  for(let i=0;i<nB;i++){
    const items = {};
    for(const id of ids) if(chance(0.35)) items[id] = ri(1,48);
    purchases["b"+i] = {
      date: (onBoundary && dates.length && chance(0.5)) ? pick(dates)
            : new Date(t0 + Math.round(rf(-2, (span/DAY)+15)*DAY)).toISOString(),
      by:"фаззер", items, total:+rf(0,300).toFixed(2)
    };
  }

  // ---- возвраты тары ----------------------------------------------------
  const returns = {};
  const nR = ri(0,4);
  for(let i=0;i<nR;i++){
    const early = earlyReturn && chance(0.4);
    returns["r"+i] = {
      date: (onBoundary && !early && dates.length && chance(0.5)) ? pick(dates)
            : new Date(t0 + Math.round(rf(early ? -12 : 0, (span/DAY)+10)*DAY)).toISOString(),
      units: ri(0,120), amount:+rf(0,25).toFixed(2),
      toTill: allNotToTill ? false : chance(0.5)
    };
  }

  // ---- «сейчас» ---------------------------------------------------------
  const lastT = dates.length ? Date.parse(dates[dates.length-1]) : t0;
  const now = new Date(lastT + Math.round(rf(chance(0.12) ? -8 : 0, 40)*DAY)).toISOString();

  return { data:{products, counts, purchases, returns}, now, tags:[...tag] };
}

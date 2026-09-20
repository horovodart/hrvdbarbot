/* Данные для первичной заливки: позиции меню, опорный подсчёт 22.07.2026
   и закупка Tesco 17.08.2026. После успешного setup() файл можно удалить. */

var SEED = {
  "counts": {
    "c-2026-07-22": {
      "by": "чек Metro",
      "card": 0,
      "cash": 0,
      "date": "2026-07-22T13:21:00.000Z",
      "initial": true,
      "note": "Опорная точка: остаток сразу после закупки в Metro. Позиции без закупки взяты по текущему подсчёту — они стояли там же.",
      "source": "Metro faktúra 0/0/2003/026117 · 190,33 €",
      "stock": {
        "aro05": 120,
        "aro15": 12,
        "coffee": 72,
        "cola033": 24,
        "cola2": 4,
        "colazero2": 1,
        "hell250": 48,
        "kofola2": 6,
        "kozel05": 21,
        "pelle033": 12,
        "slivki": 1,
        "staro05": 7,
        "staro15": 12,
        "tonic15": 4,
        "zbnealko": 38,
        "zbtmave": 12,
        "redbull250": 0
      }
    },
    "c-2026-09-20": {
      "by": "Миша",
      "card": 141.15,
      "cash": 0,
      "date": "2026-09-20T15:00:00.000Z",
      "note": "Деньги: 141,15 € пришло за период 22.07–20.09.",
      "stock": {
        "aro05": 40,
        "aro15": 6,
        "coffee": 72,
        "cola033": 0,
        "cola2": 4,
        "colazero2": 1,
        "hell250": 6,
        "kofola2": 2,
        "kozel05": 21,
        "pelle033": 0,
        "slivki": 1,
        "staro05": 7,
        "staro15": 12,
        "tonic15": 4,
        "zbnealko": 0,
        "zbtmave": 0,
        "redbull250": 0
      }
    }
  },
  "products": {
    "aro05": {
      "cat": "free",
      "color": "#4FA3D9",
      "cost": 0.35,
      "min": 12,
      "name": "Вода Aro",
      "note": "Metro 22.07: 0,21 € без НДС минус акция ≈ 0,20 € + 0,15 € залог.",
      "order": 10,
      "pack": 12,
      "shape": "water",
      "vol": "0,5 л · негаз."
    },
    "aro15": {
      "cat": "free",
      "color": "#3B8BC4",
      "cost": 0.42,
      "min": 2,
      "name": "Вода Aro",
      "note": "Metro 22.07: 0,27 € без НДС + 0,15 € залог.",
      "order": 11,
      "pack": 6,
      "shape": "water",
      "vol": "1,5 л · негаз."
    },
    "coffee": {
      "cat": "sale",
      "color": "#6B4226",
      "cost": null,
      "min": 15,
      "name": "Кофе-капсула",
      "note": "Впиши цену капсулы — посчитается маржа.",
      "order": 6,
      "pack": null,
      "shape": "capsule",
      "vol": "1 шт"
    },
    "cola033": {
      "cat": "sale",
      "color": "#D71920",
      "cost": 0.74,
      "min": 6,
      "name": "Coca-Cola / Zero",
      "note": "Metro 22.07: 14,16 € за 24 шт (0,59 €) + 0,15 € залог. Обычная и Zero по одной цене.",
      "order": 4,
      "pack": 24,
      "shape": "can",
      "vol": "0,33 л · банка"
    },
    "cola2": {
      "cap": "#D71920",
      "cat": "shared",
      "color": "#D71920",
      "cost": 1.89,
      "min": 1,
      "name": "Coca-Cola",
      "note": "Metro 22.07: 10,46 € за 6 шт (1,74 €) + 0,15 € залог.",
      "order": 20,
      "pack": 6,
      "shape": "pet",
      "vol": "2 л"
    },
    "colazero2": {
      "cap": "#D71920",
      "cat": "shared",
      "color": "#1A1A1A",
      "cost": 1.89,
      "min": 1,
      "name": "Coca-Cola Zero",
      "note": "Цена принята как у обычной 2 л — в чеке 22.07 её не было.",
      "order": 21,
      "pack": 6,
      "shape": "pet",
      "vol": "2 л"
    },
    "hell250": {
      "cat": "sale",
      "color": "#1E1E24",
      "cost": 0.62,
      "min": 6,
      "name": "Hell Energy",
      "note": "Tesco 17.08: 1,89 € за 4 шт = 0,47 €/шт + 0,15 € залог. В Metro 22.07 было 0,59 + залог.",
      "order": 5,
      "pack": 24,
      "shape": "can",
      "vol": "0,25 л · банка"
    },
    "kofola2": {
      "cap": "#C8102E",
      "cat": "shared",
      "color": "#4A2A17",
      "cost": 1.58,
      "min": 1,
      "name": "Kofola",
      "note": "Metro 22.07: 8,55 € за 6 шт (1,43 €) + 0,15 € залог. Была акция «Kofola за 1 €».",
      "order": 22,
      "pack": 6,
      "shape": "pet",
      "vol": "2 л"
    },
    "kozel05": {
      "cat": "sale",
      "color": "#8E2B2F",
      "cost": null,
      "min": 6,
      "name": "Kozel",
      "note": "Kozel нет в чеках от 22.07 — впиши цену закупки.",
      "order": 1,
      "pack": 20,
      "shape": "can",
      "vol": "0,5 л · банка · 4,2%"
    },
    "pelle033": {
      "cat": "sale",
      "color": "#E8552D",
      "cost": 1.07,
      "min": 6,
      "name": "San Pellegrino",
      "note": "Metro 22.07: 0,92 € без НДС + 0,15 € залог. В чеке «MAND.» — это вкус Clementina (мандарин).",
      "order": 7,
      "pack": 6,
      "shape": "can",
      "vol": "0,33 л · банка · мандарин"
    },
    "slivki": {
      "cat": "shared",
      "color": "#9DB4C8",
      "cost": null,
      "min": 1,
      "name": "Сливки",
      "note": "Плюс 2 открытые на 20.09 — не считаются.",
      "order": 25,
      "pack": null,
      "shape": "carton",
      "vol": "закрытые упаковки"
    },
    "staro05": {
      "cat": "sale",
      "color": "#B8322E",
      "cost": 0.64,
      "min": 6,
      "name": "Staropramen",
      "note": "Metro 22.07: 0,49 € без НДС + 0,15 € залог.",
      "order": 2,
      "pack": 20,
      "shape": "can",
      "vol": "0,5 л · банка · 4%"
    },
    "staro15": {
      "cap": "#D9A441",
      "cat": "shared",
      "color": "#B8322E",
      "cost": null,
      "min": 2,
      "name": "Staropramen",
      "order": 24,
      "pack": 6,
      "shape": "pet",
      "vol": "1,5 л · ПЭТ · 4%"
    },
    "tonic15": {
      "cap": "#E8B400",
      "cat": "shared",
      "color": "#6FA898",
      "cost": null,
      "min": 1,
      "name": "Kinley Tonic",
      "order": 23,
      "pack": 6,
      "shape": "pet",
      "vol": "1,5 л"
    },
    "zbnealko": {
      "cat": "sale",
      "color": "#2E7D4F",
      "cost": 0.79,
      "min": 6,
      "name": "Zlatý Bažant 0,0%",
      "note": "Metro 22.07: 0,64 € + 0,15 € залог. Birell 0,0% (0,65 €) считаем этой же позицией — разные вкусы.",
      "order": 3,
      "pack": 6,
      "shape": "can",
      "vol": "0,5 л · банка · nealko, разные вкусы"
    },
    "zbtmave": {
      "cat": "sale",
      "color": "#5C3317",
      "cost": 0.94,
      "min": 6,
      "name": "Zlatý Bažant tmavé",
      "note": "Metro 22.07: 0,79 € без НДС + 0,15 € залог. В чеке код PLZ — то же, что у Hell и колы, то есть банка.",
      "order": 2.5,
      "pack": 6,
      "shape": "can",
      "vol": "0,5 л · банка · тёмное"
    },
    "redbull250": {
      "cat": "sale",
      "color": "#1B3A6B",
      "cost": null,
      "min": 6,
      "name": "Red Bull",
      "note": "Новая позиция, в чеках 22.07 и 17.08 её нет. Впиши цену закупки — посчитается маржа.",
      "order": 5.5,
      "pack": 24,
      "shape": "can",
      "vol": "0,25 л · банка"
    }
  },
  "purchases": {
    "p-2026-08-17": {
      "by": "Миша",
      "date": "2026-08-17T12:10:00.000Z",
      "items": {
        "hell250": 72
      },
      "source": "Tesco Ružinov 17.08 · 18 × 4 шт по 1,89 € + залог 10,80 €",
      "total": 44.82
    }
  }
};

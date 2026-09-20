/* Настройки приложения. Единственный файл, который меняется при деплое. */
window.HUB_CONFIG = {
  // URL веб-приложения Google Apps Script. Пусто → приложение работает
  // в демо-режиме: читает hub-bar-data.json и держит правки в браузере.
  API: "https://script.google.com/macros/s/AKfycbzi8qpBcZcRBG2ILmajQ6Nj-8DelwH8y1cUJkOZqeTucJnkzW6vaeNixEKXuIIUDKJ9/exec",

  SEED: "hub-bar-data.json",
  SALE_PRICE: 1.50,   // цена напитка для команды
  DEPOSIT: 0.15,      // залог за бутылку/банку, уже включён в cost товара
  HORIZON: 14,        // «красный»: запаса меньше чем на столько дней
  AMBER: 21,          // «жёлтый»: меньше чем на столько дней
  TARGET: 28          // «что купить» считается на столько дней вперёд
};

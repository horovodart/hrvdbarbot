#!/usr/bin/env node
/* Справочник товаров, команда и стартовые данные живут в apps-script/Seed.gs.
   Сервер на Cloudflare берёт их из worker/src/seed.js — этот скрипт его пересобирает.
   Запуск: node tools/build-seed.mjs (deploy.sh делает это сам). */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const src = readFileSync(path.join(ROOT, "apps-script/Seed.gs"), "utf8");
const s = new Function(src + ";return {SEED_VERSION, SEED_RETIRE: typeof SEED_RETIRE === 'undefined' ? {} : SEED_RETIRE, TEAM_SEED, RETURNS_SEED, SEED}")();
const out = "// Собрано из apps-script/Seed.gs скриптом tools/build-seed.mjs. Руками не править.\n" +
  Object.entries(s).map(([k, v]) => `export const ${k} = ${JSON.stringify(v, null, 1)};`).join("\n") + "\n";
writeFileSync(path.join(ROOT, "worker/src/seed.js"), out);
console.log("worker/src/seed.js: версия справочника " + s.SEED_VERSION + ", товаров " + Object.keys(s.SEED.products).length);

#!/usr/bin/env node
/* Переезд: выгрузку старого сервера (действие export) превращает в SQL для D1.
   Всё, что было в базе, заменяется выгрузкой целиком — порядок записей сохраняется.
   node tools/import-d1.mjs выгрузка.json > import.sql
   npx wrangler d1 execute hrvd-bar --remote --file import.sql   (из папки worker) */
import { readFileSync } from "node:fs";
const d = JSON.parse(readFileSync(process.argv[2], "utf8"));
const q = (v) => v == null ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'";
const out = [];
for (const t of ["products", "counts", "purchases", "returns", "team", "props", "rids"]) out.push(`DELETE FROM ${t};`);
for (const t of ["products", "counts", "purchases", "returns"])
  for (const [id, row] of Object.entries(d[t] || {})) { const { id: _, ...data } = row; out.push(`INSERT INTO ${t} (id, data) VALUES (${q(id)}, ${q(JSON.stringify(data))});`) }
for (const m of d.team || []) out.push(`INSERT INTO team (tg_id, name, role) VALUES (${q(String(m.tg_id).trim())}, ${q(m.name)}, ${q(m.role)});`);
for (const [k, v] of Object.entries(d.props || {})) if (!/TOKEN|KEY|SECRET/i.test(k)) out.push(`INSERT INTO props (key, value) VALUES (${q(k)}, ${q(v)});`);
process.stdout.write(out.join("\n") + "\n");

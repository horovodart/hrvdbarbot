-- HOROVOD HUB · бар на Cloudflare D1. Можно запускать повторно (IF NOT EXISTS).
-- Каждая запись — JSON в колонке data с теми же полями, что были колонками Google-таблицы.
CREATE TABLE IF NOT EXISTS products  (id TEXT PRIMARY KEY, data TEXT NOT NULL);  -- справочник товаров
CREATE TABLE IF NOT EXISTS counts    (id TEXT PRIMARY KEY, data TEXT NOT NULL);  -- подсчёты склада
CREATE TABLE IF NOT EXISTS purchases (id TEXT PRIMARY KEY, data TEXT NOT NULL);  -- закупки
CREATE TABLE IF NOT EXISTS returns   (id TEXT PRIMARY KEY, data TEXT NOT NULL);  -- сдачи тары
CREATE TABLE IF NOT EXISTS team      (tg_id TEXT PRIMARY KEY, name TEXT, role TEXT);  -- кто может открыть приложение
CREATE TABLE IF NOT EXISTS props     (key TEXT PRIMARY KEY, value TEXT);          -- настройки и память напоминаний
CREATE TABLE IF NOT EXISTS rids      (rid TEXT PRIMARY KEY, at TEXT);             -- защита от дубля при повторе запроса

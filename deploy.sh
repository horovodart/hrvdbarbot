#!/usr/bin/env bash
# Выкатка HOROVOD HUB целиком: тесты → версия → GitHub Pages → сервер на Cloudflare → проверка живого API.
# Ни один шаг не выполняется, если упали тесты.
#
#   ./deploy.sh "что поменяли"    — закоммитить правки и выкатить
#   ./deploy.sh                   — выкатить то, что уже закоммичено
#
# Нужен .env.local с BOT_TOKEN и CLOUDFLARE_API_TOKEN (в git не попадает).
set -uo pipefail
cd "$(dirname "$0")"

API="https://hrvd-bar.horovod.workers.dev/"
MSG="${1:-}"
[ -f .env.local ] && . ./.env.local
export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
export CLOUDFLARE_ACCOUNT_ID=19657a445252a6081236e6f6aee7b405

die () { echo; echo "✗ $1"; exit 1; }

[ -n "$CLOUDFLARE_API_TOKEN" ] || die "Нет CLOUDFLARE_API_TOKEN в .env.local — сервер не выкатить."

# 1. Тесты. Всё остальное — только после них.
./tools/test.sh 500 || die "Тесты не прошли, ничего не выкачено."

# 2. Версия на js/css: без неё Telegram будет держать старый код из кэша.
echo
python3 tools/bump.py

# 3. Коммит и GitHub Pages.
if [ -n "$(git status --porcelain)" ]; then
  [ -n "$MSG" ] || die "Есть незакоммиченные правки — передай сообщение: ./deploy.sh \"что поменяли\""
  git add -A && git commit -q -m "$MSG" || die "Коммит не прошёл."
fi
git push -q --no-verify origin main || die "Пуш в GitHub не прошёл."
echo "GitHub Pages: запушено ($(git rev-parse --short HEAD))"

# 4. Сервер на Cloudflare. Справочник для него собирается из apps-script/Seed.gs.
# Старый Apps Script заморожен (только чтение) и больше не выкатывается.
node tools/build-seed.mjs >/dev/null
[ -d worker/node_modules ] || (cd worker && npm install --silent) || die "npm install в worker не прошёл."
(cd worker && npx wrangler deploy --var "VERSION:$(git rev-parse --short HEAD)" >/dev/null 2>&1) || die "wrangler deploy не прошёл."
echo "Сервер: выкачен на $API"

# 5. Адрес мини-приложения в боте — со свежей версией.
# Telegram кэширует index.html намертво и версии на js/css его не трогают:
# единственный способ заставить его перечитать страницу — сменить сам адрес.
if [ -f .env.local ]; then
  if [ -n "${BOT_TOKEN:-}" ]; then
    MENU_URL="https://horovodart.github.io/hrvdbarbot/?v=$(git rev-parse --short HEAD)"
    OUT="$(curl -s -X POST "https://api.telegram.org/bot$BOT_TOKEN/setChatMenuButton" \
      -H 'Content-Type: application/json' \
      -d "{\"menu_button\":{\"type\":\"web_app\",\"text\":\"Бар\",\"web_app\":{\"url\":\"$MENU_URL\"}}}")"
    echo "$OUT" | grep -q '"ok":true' && echo "Кнопка бота: $MENU_URL" || die "Не вышло обновить кнопку бота: $OUT"
  fi
else
  echo "Кнопка бота не обновлена: нет .env.local с BOT_TOKEN"
fi

# 6. Живой API должен ответить — деплой без проверки не считается сделанным.
RESP=""
for i in 1 2 3 4; do
  RESP="$(curl -s -L --max-time 30 "$API")"
  echo "$RESP" | grep -q '"alive":true' && break
  sleep $((i * 3))
done
echo "$RESP" | grep -q '"alive":true' || die "API не отвечает как надо: ${RESP:0:200}"
echo "API живой: ${RESP:0:80}"

# 7. Дымовой тест на живом: склад целиком, приложение сходится с эталоном на
# настоящих данных, чек читается, напоминания строятся. Ничего не пишет.
echo
node tools/smoke.mjs || die "Дымовой тест не прошёл — выкачено, но на живом что-то не так. Смотри выше."
echo
echo "Готово."

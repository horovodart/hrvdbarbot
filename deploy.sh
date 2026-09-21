#!/usr/bin/env bash
# Выкатка HOROVOD HUB целиком: тесты → версия → GitHub Pages → Apps Script → проверка живого API.
# Ни один шаг не выполняется, если упали тесты.
#
#   ./deploy.sh "что поменяли"    — закоммитить правки и выкатить
#   ./deploy.sh                   — выкатить то, что уже закоммичено
set -uo pipefail
cd "$(dirname "$0")"

DEPLOY_ID=AKfycbzi8qpBcZcRBG2ILmajQ6Nj-8DelwH8y1cUJkOZqeTucJnkzW6vaeNixEKXuIIUDKJ9
API="https://script.google.com/macros/s/$DEPLOY_ID/exec"
CLASP=./node_modules/.bin/clasp
MSG="${1:-}"

die () { echo; echo "✗ $1"; exit 1; }

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

# 4. Apps Script — на тот же адрес, чтобы config.js не пришлось править.
$CLASP push --force >/dev/null || die "clasp push не прошёл."
$CLASP deploy --deploymentId "$DEPLOY_ID" --description "${MSG:-$(git log -1 --pretty=%s)}" >/dev/null \
  || die "clasp deploy не прошёл."
echo "Apps Script: выкачено на прежний адрес"

# 5. Живой API должен ответить — деплой без проверки не считается сделанным.
sleep 3
RESP="$(curl -s -L --max-time 30 "$API")"
echo "$RESP" | grep -q '"alive":true' || die "API не отвечает как надо: ${RESP:0:200}"
echo "API живой: ${RESP:0:80}"
echo
echo "Готово."

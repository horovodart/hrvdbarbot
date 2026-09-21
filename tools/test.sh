#!/usr/bin/env bash
# Все проверки разом. Возвращает 0 только если сошлось всё.
# Запуск: tools/test.sh [кол-во случаев фаззинга]
set -uo pipefail
cd "$(dirname "$0")/.."

FUZZ_N="${1:-500}"
fail=0

step () {                       # step «название» команда…
  local title="$1"; shift
  local out; out="$("$@" 2>&1)"; local code=$?
  local tail; tail="$(echo "$out" | grep -E 'прошло |ИТОГО:|случаев:|регрессии: ' | tail -1)"
  if [ $code -ne 0 ] || echo "$out" | grep -qE 'ПРОВАЛ [1-9]|разошлось: [1-9]|исключений: приложение [1-9]|исключений: приложение 0, эталон [1-9]'; then
    echo "  ✗ $title — ${tail:-код $code}"
    echo "$out" | grep -E 'ПРОВАЛ|▸ |расхожд' | head -20 | sed 's/^/      /'
    fail=1
  else
    echo "  ✓ $title — ${tail:-ок}"
  fi
}

echo "Проверки:"
step "фронтенд"        node tools/tests/front/run.mjs
step "Apps Script"     node tools/tests/server/run.mjs
step "фаззинг ($FUZZ_N случаев против эталона)" node tools/tests/fuzz/run.mjs "$FUZZ_N" 1
step "регрессии (починенные расхождения)" node tools/tests/fuzz/minimal.mjs
step "эталон на боевых данных" python3 tools/reference.py

if [ $fail -ne 0 ]; then
  echo
  echo "Тесты не прошли — деплой отменён."
  exit 1
fi
echo "Всё сошлось."

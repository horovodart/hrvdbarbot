#!/usr/bin/env bash
# Ставит git-хук: тесты гоняются на каждый git push, даже мимо deploy.sh.
set -e
root="$(git rev-parse --show-toplevel)"
install -m 755 "$root/tools/hooks/pre-push" "$root/.git/hooks/pre-push"
echo "Хук поставлен: тесты теперь гоняются на каждый git push."

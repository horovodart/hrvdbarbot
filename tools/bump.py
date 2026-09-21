#!/usr/bin/env python3
"""Штампует версию на подключаемых файлах в index.html.

Telegram WebView кэширует js/css агрессивно: без этого команда после деплоя
продолжает работать на старом коде. Запускать перед каждым коммитом.
"""
import re, subprocess, sys, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
idx = root / "index.html"
try:
    ver = subprocess.run(["git", "-C", str(root), "rev-parse", "--short", "HEAD"],
                         capture_output=True, text=True).stdout.strip() or "dev"
except Exception:
    ver = "dev"
ver += "-" + subprocess.run(["date", "+%H%M%S"], capture_output=True, text=True).stdout.strip()

html = idx.read_text()
html = re.sub(r'(href="app\.css)(\?v=[^"]*)?"', rf'\1?v={ver}"', html)
html = re.sub(r'(src="(?:config|api|app)\.js)(\?v=[^"]*)?"', rf'\1?v={ver}"', html)
idx.write_text(html)
print("версия проставлена:", ver)

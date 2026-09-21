#!/usr/bin/env python3
"""Фото товаров: поиск дыр и вырезание фона.

  python3 tools/photo.py missing              — какие позиции без фото
  python3 tools/photo.py cut <id> <файл>      — вырезать фон и положить в img/<id>.webp

Скачивание картинки намеренно отделено от вырезания: подобрать правильный кадр
(тот вкус, та тара, та ёмкость) без глаз нельзя — автомат регулярно приносит
шестибаночную упаковку вместо банки. Поэтому кадр выбирается глазами, а вся
рутина после выбора — одной командой.
"""
import json, sys, pathlib
from collections import deque
from PIL import Image, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
IMG, SIZE, PAD = ROOT/"img", 512, 0.06

def missing():
    d = json.load(open(ROOT/"hub-bar-data.json"))
    gone = [(pid, p["name"], p.get("vol","")) for pid, p in sorted(d["products"].items())
            if not (IMG/f"{pid}.webp").exists()]
    for pid, name, vol in gone:
        print(f"{pid:22} {name} · {vol}")
    print(f"\nбез фото: {len(gone)} из {len(d['products'])}")
    return gone

def flatten(im):
    im = im.convert("RGBA")
    bg = Image.new("RGBA", im.size, (255,255,255,255)); bg.alpha_composite(im)
    return bg.convert("RGB")

def key_white(rgb, tol=232, sat=20):
    """Заливкой от краёв гасим белый фон, не трогая белое внутри этикетки."""
    w, h = rgb.size; px = rgb.load()
    mask = Image.new("L", (w,h), 255); mp = mask.load()
    seen = bytearray(w*h); q = deque()
    def white(x, y):
        r, g, b = px[x,y]
        return min(r,g,b) >= tol and (max(r,g,b)-min(r,g,b)) <= sat
    for x in range(w):
        for y in (0, h-1):
            if not seen[y*w+x] and white(x,y): seen[y*w+x] = 1; q.append((x,y))
    for y in range(h):
        for x in (0, w-1):
            if not seen[y*w+x] and white(x,y): seen[y*w+x] = 1; q.append((x,y))
    while q:
        x, y = q.popleft(); mp[x,y] = 0
        for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
            nx, ny = x+dx, y+dy
            if 0 <= nx < w and 0 <= ny < h and not seen[ny*w+nx] and white(nx,ny):
                seen[ny*w+nx] = 1; q.append((nx,ny))
    return mask

def cut(pid, src, crop=None):
    im = flatten(Image.open(src))
    if crop: im = im.crop(tuple(int(v) for v in crop.split(",")))
    im.thumbnail((900,900))
    a = key_white(im).filter(ImageFilter.GaussianBlur(0.6))
    o = im.convert("RGBA"); o.putalpha(a)
    bb = o.getbbox()
    if bb: o = o.crop(bb)
    side = int(max(o.size) * (1 + PAD*2))
    sq = Image.new("RGBA", (side, side), (0,0,0,0))
    sq.paste(o, ((side-o.width)//2, (side-o.height)//2), o)
    out = IMG/f"{pid}.webp"
    sq.resize((SIZE,SIZE), Image.LANCZOS).save(out, "WEBP", quality=88, method=6)
    print(f"{out} — {out.stat().st_size//1024} КБ, исходный объект {o.size[0]}×{o.size[1]}")

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "missing"
    if cmd == "missing": missing()
    elif cmd == "cut":   cut(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else None)
    else: print(__doc__)

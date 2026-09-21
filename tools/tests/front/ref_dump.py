#!/usr/bin/env python3
"""Выгрузка эталонного расчёта (tools/reference.py) в JSON на фиксированный «сейчас»."""
import json, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
import reference

now = sys.argv[1] if len(sys.argv) > 1 else None
d = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "..", "hub-bar-data.json")))
M = reference.compute(d, now)
out = {"recs": [{k: v for k, v in r.items() if k not in ("frm", "to", "cons", "meas", "bought")} for r in M["recs"]],
       "items": M["items"], "tare": M["tare"], "dSince": M["dSince"]}
print(json.dumps(out, ensure_ascii=False, default=str))

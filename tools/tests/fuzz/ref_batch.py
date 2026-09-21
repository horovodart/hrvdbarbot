#!/usr/bin/env python3
"""Пакетный прогон эталона: читает JSONL {"data":..., "now":...}, пишет JSONL с результатом.

Живёт в песочнице фаззера, tools/reference.py не трогает — только импортирует.
"""
import json, sys, os, traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..", "..")))
import reference  # tools/reference.py

REC = ("saleUnits","freeUnits","expected","got","backed","short","frozen","price",
       "costSale","costWater","depSpent","net","ideal","payRate","breakEven")
ITEM = ("est","exact","estimated","rate","daysLeft","st","need","restock")
TARE = ("units","amount","back","paid","waiting")
ALL  = ("expected","got","cost","units","short","net","payRate","since","periods","streak","goalReached")
PER  = ("days","cons","bought","measured","perWeek")

def slim(M):
    return {
        "recs": [{k: r[k] for k in REC} for r in M["recs"]],
        "items": {pid: dict({k: it[k] for k in ITEM},
                            periods=[{k: x[k] for k in PER} for x in it["periods"]])
                  for pid, it in M["items"].items()},
        "tare": {k: M["tare"][k] for k in TARE},
        "all": {k: M["all"][k] for k in ALL},
        "dSince": M["dSince"],
    }

def main():
    inp, outp = sys.argv[1], sys.argv[2]
    with open(inp) as f, open(outp, "w") as g:
        for line in f:
            line = line.strip()
            if not line: continue
            case = json.loads(line)
            try:
                out = {"ok": True, "M": slim(reference.compute(case["data"], case["now"]))}
            except Exception as e:
                out = {"ok": False, "error": f"{type(e).__name__}: {e}",
                       "trace": traceback.format_exc()[-800:]}
            g.write(json.dumps(out, default=str) + "\n")

if __name__ == "__main__":
    main()

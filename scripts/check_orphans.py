import json
import sqlite3
import psycopg2
import sys
sys.path.insert(0, "/home/ubuntu/CourseForge")
from scripts.rebalance_odysee_wallets import ACCOUNTS, ODYSEE_PROXY
import urllib.request

valid_claims = set()

with open("/home/ubuntu/CourseForge/new_5_curricula.json") as f:
    curricula = json.load(f)
for c in curricula:
    for it in c.get("items", []):
        cid = it.get("claim_id")
        if cid:
            valid_claims.add(cid)

pg = psycopg2.connect("postgresql://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite")
cur = pg.cursor()
cur.execute("SELECT claim_id FROM lesson_providers WHERE length(claim_id) > 5;")
for r in cur.fetchall():
    valid_claims.add(r[0])
cur.execute("SELECT claim_id FROM materials WHERE length(claim_id) > 5;")
for r in cur.fetchall():
    valid_claims.add(r[0])
cur.close()
pg.close()

with open("/home/ubuntu/CourseForge/data/odysee_manifest.json") as f:
    mf = json.load(f)
for k, v in mf.items():
    if isinstance(v, dict) and "claim_id" in v:
        valid_claims.add(v["claim_id"])

with open("/home/ubuntu/CourseForge/data/odysee_docs_manifest.json") as f:
    dmf = json.load(f)
for k, v in dmf.items():
    if isinstance(v, dict) and "claim_id" in v:
        valid_claims.add(v["claim_id"])

print(f"Total Valid Referenced Claims in System: {len(valid_claims)}")

def rpc(token, method, params):
    req = urllib.request.Request(
        ODYSEE_PROXY + f"?m={method}",
        data=json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": 1}).encode(),
        headers={"X-Lbry-Auth-Token": token, "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}
    )
    return json.loads(urllib.request.urlopen(req, timeout=20).read().decode()).get("result", {})

total_orphan = 0
orphan_amount = 0.0

for acc in ACCOUNTS:
    token = acc["token"]
    name = acc["name"]
    res = rpc(token, "claim_list", {"claim_type": ["stream"], "page": 1, "page_size": 50})
    total_items = res.get("total_items", 0)
    items = res.get("items", [])
    orphans = [it for it in items if it.get("claim_id") not in valid_claims]
    if orphans:
        print(f"[{name}] Total claims: {total_items} | Orphans in page 1: {len(orphans)}")
        for o in orphans:
            print(f"   Orphan: {o.get("name")} | amount: {o.get("amount")}")
            total_orphan += 1
            orphan_amount += float(o.get(amount, 0.0))
    else:
        print(f"[{name}] Total claims: {total_items} | All sampled claims are 100% valid course claims.")

print(f"Total sampled orphans found: {total_orphan} (Value: {orphan_amount:.6f} LBC)")

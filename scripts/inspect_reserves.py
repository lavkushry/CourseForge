import json
import urllib.request
from scripts.rebalance_odysee_wallets import ACCOUNTS, ODYSEE_PROXY

def rpc(token, method, params):
    req = urllib.request.Request(
        ODYSEE_PROXY + f"?m={method}",
        data=json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": 1}).encode(),
        headers={"X-Lbry-Auth-Token": token, "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}
    )
    try:
        return json.loads(urllib.request.urlopen(req, timeout=15).read().decode()).get("result", {})
    except Exception as e:
        return {"error": str(e)}

print("=== AUDITING RESERVED LBC ACROSS ALL 8 WORKERS ===")
total_reserved = 0.0
total_supports = 0.0

for acc in ACCOUNTS:
    token = acc["token"]
    name = acc["name"]
    
    bal = rpc(token, "wallet_balance", {})
    avail = float(bal.get("available", 0.0))
    res = float(bal.get("reserved", 0.0))
    total_reserved += res
    
    supports = rpc(token, "support_list", {"page": 1, "page_size": 50})
    sup_items = supports.get("items", []) if isinstance(supports, dict) else []
    sup_amount = sum(float(s.get("amount", 0.0)) for s in sup_items)
    total_supports += sup_amount
    
    chan_res = rpc(token, "channel_list", {"page": 1, "page_size": 10})
    chan_items = chan_res.get("items", []) if isinstance(chan_res, dict) else []
    
    stream_res = rpc(token, "claim_list", {"claim_type": ["stream"], "page": 1, "page_size": 1})
    stream_count = stream_res.get("total_items", 0) if isinstance(stream_res, dict) else 0
    
    print(f"[{name}]")
    print(f"   Available: {avail:.6f} | Reserved: {res:.6f} | Supports: {len(sup_items)} ({sup_amount:.6f} LBC)")
    print(f"   Stream Claims: {stream_count}")
    for ch in chan_items:
        print(f"   Channel: {ch.get(name)} | Claim ID: {ch.get(claim_id)[:10]}... | Bid: {ch.get(amount)}")

print(f"\nTotal Reserved across workers: {total_reserved:.6f} LBC")
print(f"Total in Supports: {total_supports:.6f} LBC")

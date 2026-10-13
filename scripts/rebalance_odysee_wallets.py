#!/usr/bin/env python3
"""
Automated Odysee Multi-Wallet Liquidity Refill & Rebalancer:
Equally distributes LBC across all 5 upload workers:
1. Unlocks any existing tips/supports into available spendable LBC via support_abandon.
2. Identifies accounts with surplus (> 0.04 LBC) and accounts running low (< 0.02 LBC).
3. Transfers tips from surplus accounts to low accounts via support_create.
4. Immediately unlocks received tips into spendable available balance via support_abandon.
5. Ensures all 5 upload workers stay healthy with ample LBC for thousands of claims.
"""
from __future__ import annotations

import json
import time
import urllib.request
from typing import Dict, List, Tuple

ODYSEE_PROXY = "https://api.na-backend.odysee.com/api/v1/proxy"

ACCOUNTS = [
    {
        "id": 1,
        "name": "Worker #1 (@courseforge-vault-3)",
        "token": "9ryTA4sULdxnA3hZZPaPVVQDJvBa4G5u",
        "channel_id": "97af564bce47e5ed942e992d720da25fa173b00c",
    },
    {
        "id": 2,
        "name": "Worker #2 (@frdweb12)",
        "token": "31feNHAQyrk5KCXnxwQuFQbRg83hAGr7",
        "channel_id": "096b6b7c7e831d4c2051d173cd1c528998df2e98",
    },
    {
        "id": 3,
        "name": "Worker #3 (@babyMosai)",
        "token": "Cf98LFvmLBNQsqbmy1mZXxmP2wnbHroZ",
        "channel_id": "8fb43b578a5c8508b03bfd75e8dfe2a6f9ba1cde",
    },
    {
        "id": 4,
        "name": "Worker #4 (@kumarvivekanand427)",
        "token": "6KN2Wfe14qhyinSshBTgwt6igwnBmoqx",
        "channel_id": "485e18e67c115b92834b540c8e1cb1a9b2bd5ea9",
    },
    {
        "id": 5,
        "name": "Worker #5 (@hoanganh368394)",
        "token": "8kB1fxCZRqnm4KdMCAzkfJH9bJpkKh1N",
        "channel_id": "0ee459506ea893bd2692a680ffb64780080732d0",
    },
]


def rpc_call(auth_token: str, method: str, params: dict) -> dict:
    req = urllib.request.Request(
        f"{ODYSEE_PROXY}?m={method}",
        data=json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": int(time.time() * 1000)}).encode(),
        headers={
            "X-Lbry-Auth-Token": auth_token,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def get_balance(auth_token: str) -> float:
    res = rpc_call(auth_token, "wallet_balance", {})
    val = (res.get("result") or {}).get("available", "0.0")
    return float(val)


def unlock_all_tips(acc: dict) -> float:
    """Check if account has any tips in support_list and abandon them to available balance."""
    token = acc["token"]
    unlocked = 0.0
    try:
        res = rpc_call(token, "support_list", {})
        items = (res.get("result") or {}).get("items") or []
        for it in items:
            txid = it.get("txid")
            nout = it.get("nout", 0)
            amt = float(it.get("amount", 0.0))
            if txid:
                try:
                    rpc_call(token, "support_abandon", {"txid": txid, "nout": nout})
                    unlocked += amt
                    print(f"  🔓 [{acc['name']}] Unlocked tip of {amt:.4f} LBC (txid: {txid[:10]}...)")
                except Exception as e:
                    print(f"  ⚠️ [{acc['name']}] support_abandon note: {e}")
    except Exception as e:
        print(f"  ⚠️ [{acc['name']}] support_list error: {e}")
    return unlocked


def send_tip(from_acc: dict, to_acc: dict, amount: float) -> bool:
    """Send a tip of `amount` LBC from `from_acc` to `to_acc` channel."""
    token = from_acc["token"]
    dest_claim_id = to_acc["channel_id"]
    amt_str = f"{amount:.4f}"
    print(f"  💸 Transferring {amt_str} LBC from [{from_acc['name']}] -> [{to_acc['name']}]...")
    try:
        res = rpc_call(
            token,
            "support_create",
            {
                "claim_id": dest_claim_id,
                "amount": amt_str,
                "tip": True,
            },
        )
        if res.get("error"):
            print(f"    ❌ Error: {res[error]}")
            return False
        print(f"    ✅ Sent {amt_str} LBC successfully!")
        return True
    except Exception as e:
        print(f"    ❌ Exception sending tip: {e}")
        return False


def main():
    print("================================================================================")
    print("💰 ODYSEE MULTI-WALLET LIQUIDITY REBALANCER & REFILL SYSTEM")
    print("================================================================================")

    # Step 1: Unlock any pending tips on all 5 accounts
    print("\n🔍 Step 1: Unlocking any pending tips/supports across all 5 accounts...")
    for acc in ACCOUNTS:
        unlock_all_tips(acc)

    # Step 2: Read current available balances
    print("\n📊 Step 2: Reading available balances...")
    balances = {}
    for acc in ACCOUNTS:
        bal = get_balance(acc["token"])
        balances[acc["id"]] = bal
        print(f"   [{acc['name']}]: {bal:.6f} LBC")

    total_avail = sum(balances.values())
    print(f"\n   Total Pooled Available: {total_avail:.6f} LBC")

    # Target per account
    target = round(total_avail / len(ACCOUNTS), 4)
    print(f"   Ideal Target Per Account: ~{target:.4f} LBC\n")

    # Step 3: Rebalance from surplus accounts to deficit accounts
    print("🔄 Step 3: Rebalancing funds to low accounts (< 0.025 LBC)...")
    surplus_accs = [acc for acc in ACCOUNTS if balances[acc["id"]] > target + 0.01]
    low_accs = [acc for acc in ACCOUNTS if balances[acc["id"]] < 0.025]

    for low in low_accs:
        needed = target - balances[low["id"]]
        if needed <= 0.005:
            continue
        for sur in surplus_accs:
            avail_sur = balances[sur["id"]] - target
            if avail_sur <= 0.005:
                continue
            to_send = min(needed, avail_sur)
            if to_send >= 0.01:
                ok = send_tip(sur, low, to_send)
                if ok:
                    balances[sur["id"]] -= to_send
                    time.sleep(2)
                    unlock_all_tips(low)
                    needed -= to_send
                    if needed <= 0.005:
                        break

    # Step 4: Final verification
    time.sleep(2)
    print("\n================================================================================")
    print("🏁 FINAL REBALANCED BALANCES ACROSS ALL 5 WORKERS")
    print("================================================================================")
    for acc in ACCOUNTS:
        unlock_all_tips(acc)
        final_bal = get_balance(acc["token"])
        print(f"   ✅ {acc['name']:<35} : {final_bal:.6f} LBC")
    print("================================================================================\n")


if __name__ == "__main__":
    main()

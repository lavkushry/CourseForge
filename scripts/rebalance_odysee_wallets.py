#!/usr/bin/env python3
"""
Automated Odysee Multi-Wallet Autonomous Fuel Daemon (Method 3 + Method 4):
1. Method 3 (Reward Claimer):
   - Audits each worker account against Odysee's Rewards API (https://api.odysee.com/reward/list).
   - Automatically claims all eligible welcome, watch, streaming, and referral rewards via https://api.odysee.com/reward/claim.
   - Injects free on-chain LBC directly into the worker wallets.

2. Method 4 (Liquidity Rebalancer & Tip Recycler):
   - Audits all 5 worker channels for incoming tips/supports via support_list.
   - Executes support_abandon to unlock tips straight into liquid available spendable balance.
   - Balances funds across all 5 workers: transfers micro-tips from surplus accounts (> 0.04 LBC)
     to low-balance workers (< 0.025 LBC), then immediately unlocks them.
   - Keeps all 5 concurrent upload workers fully fueled 24/7.
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from typing import Dict, List, Any

ODYSEE_PROXY = "https://api.na-backend.odysee.com/api/v1/proxy"
ODYSEE_API = "https://api.odysee.com"

ACCOUNTS = [
    {
        "id": 1,
        "name": "Worker #1 (@courseforge-vault-3)",
        "token": "9ryTA4sULdxnA3hZZPaPVVQDJvBa4G5u",
        "channel_id": "97af564bce47e5ed942e992d720da25fa173b00c",
        "wallet_address": "bDejtcHBAX3JN69A9Ke4FKrkBDJz5fm7nU",
    },
    {
        "id": 2,
        "name": "Worker #2 (@frdweb12)",
        "token": "31feNHAQyrk5KCXnxwQuFQbRg83hAGr7",
        "channel_id": "096b6b7c7e831d4c2051d173cd1c528998df2e98",
        "wallet_address": "bFcGsd6EEpJEvT6cgah4wFBYa5x8E5aM1F",
    },
    {
        "id": 3,
        "name": "Worker #3 (@babyMosai)",
        "token": "Cf98LFvmLBNQsqbmy1mZXxmP2wnbHroZ",
        "channel_id": "8fb43b578a5c8508b03bfd75e8dfe2a6f9ba1cde",
        "wallet_address": "bN3ryjn3F7TCgwCUh9wDMS7bqd9ignz7e6",
    },
    {
        "id": 4,
        "name": "Worker #4 (@kumarvivekanand427)",
        "token": "6KN2Wfe14qhyinSshBTgwt6igwnBmoqx",
        "channel_id": "485e18e67c115b92834b540c8e1cb1a9b2bd5ea9",
        "wallet_address": "bL6MMZz3b4ti1JY23JNA2tkVxFyAQW4Zur",
    },
    {
        "id": 5,
        "name": "Worker #5 (@hoanganh368394)",
        "token": "8kB1fxCZRqnm4KdMCAzkfJH9bJpkKh1N",
        "channel_id": "0ee459506ea893bd2692a680ffb64780080732d0",
        "wallet_address": "bTn9To86BbkqHKgSvawiP4U8wwuP1rJCs4",
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


def api_post(endpoint: str, data: dict) -> dict:
    encoded = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(
        f"{ODYSEE_API}/{endpoint.lstrip('/')}",
        data=encoded,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Mozilla/5.0",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())


def get_balance(auth_token: str) -> float:
    try:
        res = rpc_call(auth_token, "wallet_balance", {})
        val = (res.get("result") or {}).get("available", "0.0")
        return float(val)
    except Exception as e:
        print(f"  ⚠️ Error reading balance: {e}")
        return 0.0


def harvest_rewards(acc: dict) -> float:
    """Method 3: Automatically claim any pending/available rewards on Odysee API."""
    token = acc["token"]
    addr = acc["wallet_address"]
    name = acc["name"]
    claimed_total = 0.0

    try:
        res = api_post("reward/list", {"auth_token": token})
        rewards = res.get("data") or []
        for r in rewards:
            if r.get("created_at") == "0001-01-01T00:00:00Z" and r.get("claim_code"):
                r_type = r.get("reward_type")
                r_title = r.get("reward_title")
                r_code = r.get("claim_code")
                try:
                    c_res = api_post(
                        "reward/claim",
                        {
                            "auth_token": token,
                            "reward_type": r_type,
                            "wallet_address": addr,
                            "claim_code": r_code,
                        },
                    )
                    if c_res.get("success"):
                        amt = float(c_res.get("data", {}).get("reward_amount", 0.0))
                        txid = (c_res.get("data", {}).get("transaction_id") or "")[:10]
                        claimed_total += amt
                        print(f"  🎁 [{name}] Method 3 Reward Claimed: '{r_title}' -> +{amt:.4f} LBC (tx: {txid}...)")
                except urllib.error.HTTPError:
                    pass
                except Exception:
                    pass
    except Exception as e:
        print(f"  ⚠️ [{name}] Method 3 reward audit note: {e}")

    return claimed_total


def unlock_all_tips(acc: dict) -> float:
    """Method 4: Check if account has any tips in support_list and abandon them to available balance."""
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
                except Exception:
                    pass
    except Exception:
        pass
    return unlocked


def send_tip(from_acc: dict, to_acc: dict, amount: float) -> bool:
    """Send a tip of amount LBC from from_acc to to_acc channel."""
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
            print(f"    ❌ Error: {res.get('error')}")
            return False
        print(f"    ✅ Sent {amt_str} LBC successfully!")
        return True
    except Exception as e:
        print(f"    ❌ Exception sending tip: {e}")
        return False


def main():
    print("=" * 80)
    print("💰 ODYSEE MULTI-WALLET AUTONOMOUS FUEL & REBALANCE DAEMON (METHOD 3 + 4)")
    print("=" * 80)

    # Step 1: Harvest any available Odysee Rewards (Method 3)
    print("
🎁 Step 1 (Method 3): Harvesting available Odysee API rewards across all accounts...")
    total_rewards = 0.0
    for acc in ACCOUNTS:
        total_rewards += harvest_rewards(acc)
    if total_rewards == 0.0:
        print("   No immediate rewards ready to claim (or already harvested).")

    # Step 2: Unlock any pending tips on all 5 accounts (Method 4)
    print("
🔍 Step 2 (Method 4): Unlocking any pending tips/supports across all 5 accounts...")
    for acc in ACCOUNTS:
        unlock_all_tips(acc)

    # Step 3: Read current available balances
    print("
📊 Step 3: Reading available balances...")
    balances = {}
    for acc in ACCOUNTS:
        bal = get_balance(acc["token"])
        balances[acc["id"]] = bal
        print(f"   [{acc['name']}]: {bal:.6f} LBC")

    total_avail = sum(balances.values())
    print(f"
   Total Pooled Available: {total_avail:.6f} LBC (Capacity: {int(total_avail / 0.0001):,} video claims)")

    target = round(total_avail / len(ACCOUNTS), 4)
    print(f"   Ideal Target Per Account: ~{target:.4f} LBC
")

    # Step 4: Rebalance from surplus accounts to deficit accounts (Method 4)
    print("🔄 Step 4 (Method 4): Rebalancing liquidity to accounts below 0.025 LBC threshold...")
    surplus_accs = [acc for acc in ACCOUNTS if balances[acc["id"]] > target + 0.01]
    low_accs = [acc for acc in ACCOUNTS if balances[acc["id"]] < 0.025]

    if not low_accs:
        print("   ✅ All workers have healthy balances (>= 0.025 LBC). No rebalancing required.")
    else:
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

    # Step 5: Final verification
    time.sleep(1)
    print("
" + "=" * 80)
    print("🏁 FINAL FUEL & LIQUIDITY STATUS ACROSS ALL 5 WORKERS")
    print("=" * 80)
    for acc in ACCOUNTS:
        unlock_all_tips(acc)
        final_bal = get_balance(acc["token"])
        claims_capacity = int(final_bal / 0.0001)
        print(f"   ✅ {acc['name']:<35} : {final_bal:.6f} LBC  (~{claims_capacity:,} claims)")
    print("=" * 80 + "
")


if __name__ == "__main__":
    main()

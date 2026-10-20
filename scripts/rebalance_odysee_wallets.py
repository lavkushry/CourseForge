#!/usr/bin/env python3
"""
Autonomous Smart Odysee Multi-Wallet Rebalancer & Fuel Daemon:
- Audits all 7 worker accounts.
- Trims channel bids to 0.001 LBC to keep maximum LBC liquid and spendable.
- Automatically claims any eligible API rewards.
- Unlocks any legacy pending tips/supports via support_abandon.
- Smart Liquidity Rebalancing: Uses direct on-chain wallet_send to evenly
  distribute funds across all 7 workers with minimal miner fees (~0.00012 LBC).
"""
import json
import time
import urllib.parse
import urllib.request
from typing import Dict, List, Any

ODYSEE_PROXY = "https://api.na-backend.odysee.com/api/v1/proxy"
ODYSEE_API = "https://api.odysee.com"

ACCOUNTS = [
    {
        "id": 0,
        "name": "Worker #0 (@lavkushry)",
        "token": "3Nj7vMUEayo8PLWgYTLMfpbcbtSzVj9f",
        "channel_id": "29a2037dd2bf5e8d3c5eaee36243368fd8410fba",
        "wallet_address": "bUm3onjke3sVGWH27GWiguXxF5gh4wj3bv",
    },
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
    {
        "id": 6,
        "name": "Worker #6 (@courseforge-vault-6)",
        "token": "FFR6ckhays2Jj4VUnfAE84TWevBWeT1b",
        "channel_id": "b724ab1577929a9c337e809848d04870f097a550",
        "wallet_address": "bPoSFKHAHpFLJKqzFZxYaAoAmu67RRr4VJ",
    },
]


def rpc_call(auth_token: str, method: str, params: dict, timeout: int = 25) -> dict:
    req = urllib.request.Request(
        f"{ODYSEE_PROXY}?m={method}",
        data=json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": int(time.time() * 1000)}).encode(),
        headers={
            "X-Lbry-Auth-Token": auth_token,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def api_post(endpoint: str, data: dict, timeout: int = 20) -> dict:
    encoded = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(
        f"{ODYSEE_API}/{endpoint.lstrip('/')}",
        data=encoded,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Mozilla/5.0",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def get_balance(auth_token: str) -> float:
    try:
        res = rpc_call(auth_token, "wallet_balance", {})
        val = (res.get("result") or {}).get("available", "0.0")
        return float(val)
    except Exception as e:
        print(f"  ⚠️ Error reading balance: {e}")
        return 0.0


def trim_channel_bids(acc: dict):
    """Ensure channel bids are trimmed to 0.001 so excess LBC is liquid."""
    try:
        token = acc["token"]
        ch_id = acc["channel_id"]
        res = rpc_call(token, "channel_list", {})
        items = (res.get("result") or {}).get("items") or []
        for ch in items:
            if ch.get("claim_id") == ch_id:
                amt = float(ch.get("amount", "0.0"))
                if amt > 0.0015:
                    print(f"  ✂️ [{acc['name']}] Trimming channel bid from {amt} down to 0.001 LBC...")
                    rpc_call(token, "channel_update", {"claim_id": ch_id, "bid": "0.001"})
                    time.sleep(1)
    except Exception:
        pass


def harvest_rewards(acc: dict) -> float:
    """Automatically claim any pending/available rewards on Odysee API."""
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
                        print(f"  🎁 [{name}] Reward Claimed: '{r_title}' -> +{amt:.4f} LBC (tx: {txid}...)")
                except Exception:
                    pass
    except Exception:
        pass

    return claimed_total


def unlock_all_tips(acc: dict) -> float:
    """Check if account has any tips in support_list and abandon them to available balance."""
    token = acc["token"]
    unlocked = 0.0
    try:
        res = rpc_call(token, "support_list", {}, timeout=30)
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
                    time.sleep(1)
                except Exception:
                    pass
    except Exception:
        pass
    return unlocked


def direct_wallet_send(from_acc: dict, to_acc: dict, amount: float) -> bool:
    """
    Direct on-chain wallet transfer:
    - Costs only ~0.00012 LBC miner fee (no double fee).
    - Lands directly in spendable available balance immediately.
    """
    token = from_acc["token"]
    dest_address = to_acc["wallet_address"]
    amt_str = f"{amount:.4f}"
    print(f"  💸 Transferring {amt_str} LBC from [{from_acc['name']}] -> [{to_acc['name']}] ({dest_address})...")
    try:
        res = rpc_call(
            token,
            "wallet_send",
            {
                "amount": amt_str,
                "addresses": [dest_address],
            },
            timeout=30,
        )
        if res.get("error"):
            print(f"    ❌ Error: {res.get('error')}")
            return False
        txid = res.get("result", {}).get("txid", "")[:12]
        fee = res.get("result", {}).get("total_fee", "0.00012")
        print(f"    ✅ Sent {amt_str} LBC successfully! (tx: {txid}..., miner fee: {fee} LBC)")
        return True
    except Exception as e:
        print(f"    ❌ Exception sending wallet transfer: {e}")
        return False


def main():
    print("=" * 80)
    print(f"💰 AUTONOMOUS SMART ODYSEE MULTI-WALLET REBALANCER ({time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())})")
    print("=" * 80)

    # Step 0: Ensure channel bids are trimmed to 0.001 LBC
    for acc in ACCOUNTS:
        trim_channel_bids(acc)

    # Step 1: Harvest any available Odysee Rewards
    print("\n🎁 Step 1: Harvesting available Odysee API rewards across all accounts...")
    total_rewards = 0.0
    for acc in ACCOUNTS:
        total_rewards += harvest_rewards(acc)
    if total_rewards == 0.0:
        print("   No pending rewards ready to claim.")

    # Step 2: Unlock any pending tips across all accounts
    print("\n🔍 Step 2: Unlocking any pending tips/supports into liquid balance...")
    for acc in ACCOUNTS:
        unlock_all_tips(acc)

    # Step 3: Read current available balances
    print("\n📊 Step 3: Reading available liquid balances...")
    balances = {}
    for acc in ACCOUNTS:
        bal = get_balance(acc["token"])
        balances[acc["id"]] = bal
        print(f"   [{acc['name']}]: {bal:.6f} LBC")

    total_avail = sum(balances.values())
    target = round(total_avail / len(ACCOUNTS), 4)
    print(f"\n   Total Pooled Available: {total_avail:.6f} LBC across {len(ACCOUNTS)} workers")
    print(f"   Ideal Balanced Target Per Account: ~{target:.4f} LBC")

    # Step 4: Rebalance from surplus accounts to deficit accounts via direct wallet_send
    print("\n🔄 Step 4: Smart Liquidity Rebalancing (Direct crypto transfer)...")
    surplus_accs = [acc for acc in ACCOUNTS if balances[acc["id"]] > target + 0.001]
    low_accs = [acc for acc in ACCOUNTS if balances[acc["id"]] < target - 0.001]

    if not low_accs or not surplus_accs or target < 0.002:
        print("   ✅ Balances already evenly distributed or pool below transfer threshold. No rebalancing needed.")
    else:
        for low in low_accs:
            needed = target - balances[low["id"]]
            if needed < 0.002:
                continue
            for sur in surplus_accs:
                avail_sur = balances[sur["id"]] - target
                if avail_sur < 0.002:
                    continue
                to_send = round(min(needed, avail_sur), 4)
                if to_send >= 0.002:
                    ok = direct_wallet_send(sur, low, to_send)
                    if ok:
                        balances[sur["id"]] -= to_send
                        balances[low["id"]] += to_send
                        time.sleep(2)
                        needed -= to_send
                        if needed < 0.002:
                            break

    # Step 5: Final verification
    time.sleep(1)
    print("\n" + "=" * 80)
    print("🏁 FINAL REBALANCED LIQUIDITY STATUS ACROSS ALL 7 WORKERS")
    print("=" * 80)
    for acc in ACCOUNTS:
        final_bal = get_balance(acc["token"])
        claims_capacity = int(final_bal / 0.00046) if final_bal > 0 else 0
        print(f"   ✅ {acc['name']:<35} : {final_bal:.6f} LBC  (~{claims_capacity} video claims capacity)")
    print("=" * 80)
    print()


if __name__ == "__main__":
    main()

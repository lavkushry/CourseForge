#!/usr/bin/env python3
import json
import urllib.parse
import urllib.request
import sys
from pathlib import Path

ROOT = Path("/home/ubuntu/CourseForge")
sys.path.insert(0, str(ROOT))

from scripts.rebalance_odysee_wallets import ACCOUNTS, rpc_call, api_post

print("=" * 80)
print("💰 ODYSEE MULTI-WALLET & DAILY REWARDS AUDIT")
print("=" * 80)

total_avail = 0.0
total_reserved = 0.0

for acc in ACCOUNTS:
    name = acc["name"]
    token = acc["token"]
    
    # 1. Balance
    try:
        res = rpc_call(token, "wallet_balance", {}, timeout=10)
        bal_dict = res.get("result", {})
        avail = float(bal_dict.get("available", 0.0))
        reserved = float(bal_dict.get("reserved", 0.0))
        tot = float(bal_dict.get("total", 0.0))
        total_avail += avail
        total_reserved += reserved
        
        # Check rewards
        claimable_rewards = []
        try:
            r_res = api_post("reward/list", {"auth_token": token}, timeout=10)
            if r_res.get("success"):
                rewards = r_res.get("data", [])
                for rw in rewards:
                    if rw.get("reward_type") and not rw.get("transaction_id"):
                        claimable_rewards.append(rw.get("reward_type"))
        except Exception:
            pass

        r_str = f" | Pending Rewards: {', '.join(claimable_rewards)}" if claimable_rewards else " | No pending rewards"
        print(f"[{name:30s}] Avail: {avail:8.6f} LBC | Locked: {reserved:8.6f} LBC{r_str}")
    except Exception as e:
        print(f"[{name:30s}] Error querying balance: {e}")

print("=" * 80)
print(f"📊 SUMMARY: Liquid Available: {total_avail:8.6f} LBC | Collateral Locked: {total_reserved:8.6f} LBC")
print("=" * 80)

#!/usr/bin/env python3
"""Fetch a small batch of missing claim-backed materials from Odysee.

Usage:
  set -a; source .env; set +a
  .venv/bin/python -u scripts/fetch_missing_materials_batch.py --offset 0 --limit 2 --wallets 0,2,3
"""
from __future__ import annotations

import argparse
import binascii
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parents[1]
PROXY = "https://api.na-backend.odysee.com/api/v1/proxy"
DSN = os.environ.get(
    "CF_DATABASE_URL",
    "postgresql://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite",
)


def load_wallets(indexes: list[int]) -> list[tuple[int, str, str]]:
    out: list[tuple[int, str, str]] = []
    for i in indexes:
        if i == 0:
            t, c = os.environ.get("ODYSEE_AUTH_TOKEN"), os.environ.get("ODYSEE_CHANNEL_ID")
        else:
            t, c = os.environ.get(f"ODYSEE_AUTH_TOKEN_{i}"), os.environ.get(f"ODYSEE_CHANNEL_ID_{i}")
        if t and c:
            out.append((i, t, c))
    return out


def rpc(token: str, method: str, params: dict, timeout: int = 25) -> dict:
    body = json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": 1}).encode()
    req = urllib.request.Request(
        f"{PROXY}?m={method}",
        data=body,
        headers={
            "X-Lbry-Auth-Token": token,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def signed_url(token: str, channel: str, cname: str, cid: str) -> tuple[str | None, str | None]:
    signed = rpc(
        token,
        "channel_sign",
        {"channel_id": channel, "hexdata": binascii.hexlify(cid.encode()).decode()},
    )
    res = signed.get("result") or {}
    sig, ts = res.get("signature"), str(res.get("signing_ts") or "")
    if not sig or not ts or ts in ("None", ""):
        return None, f"sign:{signed.get('error') or 'empty'}"
    got = rpc(
        token,
        "get",
        {"uri": f"lbry://{cname}#{cid}", "signature": sig, "signature_ts": ts},
    )
    if got.get("error"):
        err = got["error"]
        if isinstance(err, dict):
            return None, str(err.get("message") or err)
        return None, str(err)
    url = ((got.get("result") or {}).get("streaming_url") or "").strip()
    return (url, None) if url else (None, "empty_url")


def list_missing(conn) -> list[dict]:
    cur = conn.cursor()
    cur.execute(
        "SELECT id, course_id, filename, relative_path, claim_name, claim_id "
        "FROM materials WHERE NOT removed ORDER BY course_id, filename"
    )
    rows = []
    for mid, course, fn, rel, cname, cid in cur.fetchall():
        if not rel or not (ROOT / rel).is_file():
            rows.append(
                {
                    "id": mid,
                    "course_id": course,
                    "filename": fn,
                    "relative_path": rel,
                    "claim_name": cname or "",
                    "claim_id": cid or "",
                }
            )
    return rows


def download(url: str, dest: Path) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://odysee.com/",
            "Origin": "https://odysee.com/",
        },
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = resp.read()
    if len(data) < 50:
        raise RuntimeError(f"too small ({len(data)} bytes)")
    dest.write_bytes(data)
    return len(data)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offset", type=int, default=0)
    ap.add_argument("--limit", type=int, default=2)
    ap.add_argument("--wallets", default="0,2,3", help="comma wallet indexes")
    ap.add_argument("--sleep", type=float, default=2.0)
    ap.add_argument("--claims-only", action="store_true", help="skip rows without claim_id")
    args = ap.parse_args()
    indexes = [int(x) for x in args.wallets.split(",") if x.strip() != ""]
    wallets = load_wallets(indexes)
    print(f"wallets={len(wallets)} indexes={[w[0] for w in wallets]}", flush=True)

    conn = psycopg2.connect(DSN)
    missing = list_missing(conn)
    if args.claims_only:
        missing = [m for m in missing if m["claim_id"] and m["claim_name"]]
    batch = missing[args.offset : args.offset + args.limit]
    print(f"missing_total={len(missing)} batch={len(batch)} offset={args.offset}", flush=True)

    cur = conn.cursor()
    results = []
    for m in batch:
        dest = ROOT / "data" / "materials" / m["course_id"] / m["filename"]
        print(f">> {m['filename'][:70]}", flush=True)
        entry = {
            "id": m["id"],
            "course_id": m["course_id"],
            "filename": m["filename"],
            "claim_name": m["claim_name"],
            "claim_id": m["claim_id"],
            "expected_path": str(dest.relative_to(ROOT)),
        }
        if not m["claim_id"] or not m["claim_name"]:
            entry["status"] = "no_claim"
            entry["why"] = "no claim (misclassified)"
            results.append(entry)
            print("  no_claim", flush=True)
            continue
        url = None
        used = None
        errs: list[str] = []
        for idx, token, channel in wallets:
            try:
                url, err = signed_url(token, channel, m["claim_name"], m["claim_id"])
                time.sleep(args.sleep)
                if url:
                    used = idx
                    break
                errs.append(f"w{idx}:{err}")
            except urllib.error.HTTPError as e:
                errs.append(f"w{idx}:HTTP{e.code}")
                time.sleep(args.sleep * 2 if e.code == 429 else args.sleep)
            except Exception as e:
                errs.append(f"w{idx}:{type(e).__name__}:{e}")
                time.sleep(args.sleep)
        if not url:
            entry["status"] = "fetch_failed"
            entry["why"] = (errs[-1] if errs else "unknown")[:200]
            entry["tried"] = errs
            results.append(entry)
            print("  fail", entry["why"][:100], flush=True)
            continue
        try:
            n = download(url, dest)
            rel = str(dest.relative_to(ROOT))
            cur.execute(
                "UPDATE materials SET relative_path=%s, updated_at=NOW() WHERE id=%s",
                (rel, m["id"]),
            )
            conn.commit()
            entry["status"] = "downloaded"
            entry["bytes"] = n
            entry["wallet"] = used
            entry["path"] = rel
            print(f"  downloaded {n} via w{used} -> {rel}", flush=True)
        except Exception as e:
            entry["status"] = "download_failed"
            entry["why"] = f"{type(e).__name__}:{e}"[:200]
            print("  dl_fail", entry["why"][:100], flush=True)
        results.append(entry)

    conn.close()
    out = ROOT / "tmp_missing_batch.json" if False else Path("/tmp/missing_batch.json")
    # append results
    prev = []
    p = Path("/tmp/missing_batch_results.json")
    if p.exists():
        try:
            prev = json.loads(p.read_text())
        except Exception:
            prev = []
    prev.extend(results)
    p.write_text(json.dumps(prev, indent=2))
    print("batch_done", [r["status"] for r in results], flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

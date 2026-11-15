#!/usr/bin/env python3
"""
Continuous Companion Materials Synchronization & Pipeline Guardian Daemon:
1. Keeps PostgreSQL, SQLite, and COMPANION_MATERIALS_AUDIT.json synced with odysee_docs_manifest.json.
2. Ensures fast_upload_companion_materials.py is running while items remain pending and liquid funds are available.
3. Ensures linux_pipeline.py is running via watchdog.sh until all 20 remaining videos finish.
"""
import json
import os
import subprocess
import time
from pathlib import Path

ROOT_DIR = Path("/home/ubuntu/CourseForge")
SCRIPTS_DIR = ROOT_DIR / "scripts"
MANIFEST_PATH = ROOT_DIR / "data/odysee_docs_manifest.json"
AUDIT_PATH = ROOT_DIR / "COMPANION_MATERIALS_AUDIT.json"
CURRICULA_PATH = ROOT_DIR / "new_5_curricula.json"
ODYSEE_PROXY = "https://api.na-backend.odysee.com/api/v1/proxy"

CHECK_TOKENS = [
    "CszwoJHQaGAo4DFyJPrgrGn2JmyKGf5F",
    "5hgCwtn2GCcunCpPg7z8fuUgYV5frxBF",
    "9ryTA4sULdxnA3hZZPaPVVQDJvBa4G5u",
    "31feNHAQyrk5KCXnxwQuFQbRg83hAGr7",
    "Cf98LFvmLBNQsqbmy1mZXxmP2wnbHroZ",
    "6KN2Wfe14qhyinSshBTgwt6igwnBmoqx",
    "8kB1fxCZRqnm4KdMCAzkfJH9bJpkKh1N",
    "FFR6ckhays2Jj4VUnfAE84TWevBWeT1b",
    "AhSUNhNrXGFstrNp1t8MGyACM4fsALLA",
    "2nq2diujNk94uUeX85Zd56V8ma4ejchK",
    "EwwfiF8E1Vo3NZ4C6afgCBmvuQ5HHTyx",
    "BGMo9GGWgStVggKFhXWxuGKLhmUzWJ6S",
    "BHKsS8y3kuj6mtDrtA1wLQxT8v62mRvF",
    "XTKSBbzbjgGQudvvPZ2VmvtbHtf1iWr2",
    "jq8K5GV2rQrJ1H3i48KZ5UT7SYWCCGda",
]


def get_max_worker_liquid_lbc() -> float:
    import urllib.request
    max_worker = 0.0
    for tok in CHECK_TOKENS:
        try:
            req = urllib.request.Request(
                f"{ODYSEE_PROXY}?m=wallet_balance",
                data=json.dumps({"jsonrpc": "2.0", "method": "wallet_balance", "params": {}, "id": 1}).encode(),
                headers={"X-Lbry-Auth-Token": tok, "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"},
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode())
                avail = float((data.get("result") or {}).get("available", 0.0))
                if avail > max_worker:
                    max_worker = avail
        except Exception:
            pass
    return max_worker


def run_cmd(cmd: list[str]) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        return p.returncode, p.stdout.strip()
    except Exception as e:
        return 1, str(e)


def is_process_running(proc_name: str) -> bool:
    rc, out = run_cmd(["pgrep", "-f", proc_name])
    return rc == 0 and bool(out)


def sync_db():
    sync_script = SCRIPTS_DIR / "sync_companion_materials_db.py"
    if sync_script.exists():
        run_cmd(["python3", str(sync_script)])


def check_and_supervise():
    # 1. Sync DB
    sync_db()

    # 2. Check uploader status
    if not is_process_running("fast_upload_companion_materials.py"):
        # Check if pending items remain
        if MANIFEST_PATH.exists() and AUDIT_PATH.exists():
            try:
                manifest = json.loads(MANIFEST_PATH.read_text())
                audit = json.loads(AUDIT_PATH.read_text())
                pending = [item for item in audit if f"{item['course_id']}/{item['filename']}" not in manifest]
                if pending:
                    max_worker_lbc = get_max_worker_liquid_lbc()
                    if max_worker_lbc >= 0.002:
                        print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Liquid fuel detected ({max_worker_lbc:.6f} LBC >= 0.002 LBC). Relaunching fast_upload_companion_materials.py ({len(pending)} pending)...", flush=True)
                        subprocess.Popen(
                            ["python3", str(SCRIPTS_DIR / "fast_upload_companion_materials.py")],
                            cwd=str(ROOT_DIR),
                            stdout=open(ROOT_DIR / "fast_upload.log", "a"),
                            stderr=subprocess.STDOUT,
                        )
                    else:
                        print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {len(pending)} companion materials pending. Standing by for liquid fuel (max worker balance: {max_worker_lbc:.6f} < 0.002 LBC).", flush=True)
            except Exception as e:
                print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Error checking pending materials: {e}", flush=True)

    # 3. Supervise video pipeline
    if not is_process_running("linux_pipeline.py"):
        watchdog = ROOT_DIR / "watchdog.sh"
        if watchdog.exists():
            print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Triggering watchdog.sh...", flush=True)
            run_cmd(["bash", str(watchdog)])


def main():
    print(f"🚀 Started Companion Materials & Pipeline Guardian Daemon at {time.strftime('%Y-%m-%d %H:%M:%S')}", flush=True)
    while True:
        try:
            check_and_supervise()
        except Exception as e:
            print(f"Daemon loop exception: {e}", flush=True)
        time.sleep(60)


if __name__ == "__main__":
    main()

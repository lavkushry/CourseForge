import urllib.request, json

tokens = [
    ("Token 1 (@courseforge-vault-3)", "9ryTA4sULdxnA3hZZPaPVVQDJvBa4G5u", "97af564bce47e5ed942e992d720da25fa173b00c"),
    ("Token 2 (@frdweb12)", "31feNHAQyrk5KCXnxwQuFQbRg83hAGr7", "096b6b7c7e831d4c2051d173cd1c528998df2e98"),
    ("Token 3 (@babyMosai)", "Cf98LFvmLBNQsqbmy1mZXxmP2wnbHroZ", "8fb43b578a5c8508b03bfd75e8dfe2a6f9ba1cde"),
    ("Token 4 (@kumarvivekanand427)", "6KN2Wfe14qhyinSshBTgwt6igwnBmoqx", "485e18e67c115b92834b540c8e1cb1a9b2bd5ea9"),
    ("Token 5 (@hoanganh368394)", "8kB1fxCZRqnm4KdMCAzkfJH9bJpkKh1N", "0ee459506ea893bd2692a680ffb64780080732d0"),
]

for name, tok, ch_id in tokens:
    req = urllib.request.Request(
        "https://api.na-backend.odysee.com/api/v1/proxy?m=wallet_balance",
        data=json.dumps({"jsonrpc": "2.0", "method": "wallet_balance", "params": {}, "id": 1}).encode(),
        headers={"X-Lbry-Auth-Token": tok, "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            res = json.loads(r.read().decode())
            w = res.get("result", {})
            avail = w.get("available")
            resrv = w.get("reserved")
            subs = w.get("reserved_subtotals")
            tot = w.get("total")
            print(f"{name}: Available={avail}, Reserved={resrv}, Subtotals={subs}, Total={tot}")
    except Exception as e:
        print(f"{name} error: {e}")

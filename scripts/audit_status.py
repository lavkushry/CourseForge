import json

with open("new_5_curricula.json") as f:
    curricula = json.load(f)

hundred_pct = []
high_pct = []
in_progress = []

doc_exts = (".pdf", ".txt", ".zip", ".ipynb", ".md")

for c in curricula:
    name = c.get("course_title", c.get("course_name", "Unknown"))
    items = c.get("items", [])
    total = len(items)
    mapped = sum(1 for it in items if it.get("claim_id") or it.get("video_url"))
    docs = sum(1 for it in items if it.get("type") in ["document", "pdf", "notes", "material"] or it.get("clean_filename", "").lower().endswith(doc_exts))
    pct = (mapped / total * 100) if total > 0 else 0
    if pct >= 99.9:
        hundred_pct.append((name, mapped, total, docs))
    elif pct >= 80.0:
        high_pct.append((name, mapped, total, docs, pct))
    else:
        in_progress.append((name, mapped, total, docs, pct))

print(f"=== NEW_5_CURRICULA AUDIT ({len(curricula)} Active Curricula) ===")
print(f"--- 100% Complete: {len(hundred_pct)} courses ---")
for name, m, t, d in hundred_pct:
    print(f"  ✅ [100%] {name} -> {m}/{t} items (Companion/Docs: {d})")

print(f"\n--- >80% Complete: {len(high_pct)} courses ---")
for name, m, t, d, p in high_pct:
    print(f"  ⚠️ [{p:.1f}%] {name} -> {m}/{t} items (Companion/Docs: {d})")

print(f"\n--- In Progress / Staged: {len(in_progress)} courses ---")
for name, m, t, d, p in in_progress:
    print(f"  ⏳ [{p:.1f}%] {name} -> {m}/{t} items (Companion/Docs: {d})")

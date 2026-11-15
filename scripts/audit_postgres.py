import psycopg2

conn = psycopg2.connect("postgresql://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite")
cur = conn.cursor()

# Get courses summary
cur.execute("""
    SELECT c.id, c.title, c.published, COUNT(l.id) AS total_lessons,
           COUNT(lp.claim_id) AS mapped_providers
    FROM courses c
    LEFT JOIN lessons l ON l.course_id = c.id
    LEFT JOIN lesson_providers lp ON lp.lesson_id = l.id
    GROUP BY c.id, c.title, c.published
    ORDER BY total_lessons DESC;
""")
courses = cur.fetchall()

print(f"=== POSTGRESQL COURSES AUDIT ({len(courses)} Total Registered Courses) ===")
full_count = 0
partial_count = 0
staged_count = 0

for cid, title, pub, total, mapped in courses:
    pct = (mapped / total * 100) if total > 0 else 0
    cur.execute("SELECT COUNT(*) FROM materials WHERE course_id = %s;", (cid,))
    mat_count = cur.fetchone()[0]
    
    if pct >= 99.9 and total > 0:
        full_count += 1
        tag = "✅ [100%]"
    elif pct >= 80.0:
        partial_count += 1
        tag = f"⚠️ [{pct:.1f}%]"
    else:
        staged_count += 1
        tag = f"⏳ [{pct:.1f}%]"
    
    ratio = f"{mapped}/{total}"
    print(f"{tag} {title[:50].ljust(50)} | Lessons: {ratio:<11} | Materials: {mat_count:<3} | Pub: {pub}")

print(f"\nSummary: {full_count} at 100% | {partial_count} at >80% | {staged_count} in-progress/staged")

cur.execute("SELECT COUNT(*) FROM materials;")
total_mat = cur.fetchone()[0]
cur.execute("SELECT COUNT(*) FROM lesson_providers;")
total_lp = cur.fetchone()[0]
cur.execute("SELECT COUNT(*) FROM lessons;")
total_less = cur.fetchone()[0]
print(f"Total Database Metrics -> Lessons: {total_less} | Lesson Providers: {total_lp} | Materials: {total_mat}")

cur.close()
conn.close()

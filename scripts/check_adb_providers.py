import psycopg2

conn = psycopg2.connect("postgresql://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite")
cur = conn.cursor()
cur.execute("""
    SELECT l.id, l.title, l.status, lp.claim_name, lp.claim_id 
    FROM lessons l 
    LEFT JOIN lesson_providers lp ON l.id = lp.lesson_id 
    WHERE l.course_id = %s 
    ORDER BY l.sort_order;
""", ('Azure Data Bricks by Sameer Sir Durgasoft',))
rows = cur.fetchall()
print(f"Lessons count: {len(rows)}")
mapped = sum(1 for r in rows if r[4] is not None)
print(f"Mapped with claim_id: {mapped} / {len(rows)}")
for r in rows[:5]:
    print(r)
if len(rows) > 5:
    print("... last:", rows[-1])
cur.close()
conn.close()

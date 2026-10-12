import sqlite3
from datetime import datetime, timezone
from argon2 import PasswordHasher

ph = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1)
pwd_hash = ph.hash("password123")
now = datetime.now(timezone.utc).isoformat(timespec="seconds")

db_path = "/home/ubuntu/CourseForge/data/courseforge.sqlite3"
conn = sqlite3.connect(db_path)
cur = conn.cursor()

# 1. Accounts to ensure
accounts = [
    ("usr_598a952ec4e9cb1e80e395ae03db3965", "admin@courseforge.com", "Administrator", pwd_hash, "admin", 1, 0, now),
    ("usr_lavkush", "lavkushry@gmail.com", "Lavkush Kumar", pwd_hash, "admin", 1, 0, now),
    ("usr_ee938383e094c9a4e52f7fa053b835d9", "admin@courseforge.demo", "Demo Admin", pwd_hash, "admin", 1, 0, now),
    ("usr_44b5ccc425016f94b11d42cf06b3e0fa", "student@courseforge.demo", "Demo Student", pwd_hash, "student", 1, 0, now),
]

for uid, email, name, phash, role, verified, suspended, cat in accounts:
    cur.execute("""
        INSERT INTO users (id, email, name, password_hash, role, verified, suspended, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET
            password_hash=excluded.password_hash,
            verified=excluded.verified,
            suspended=excluded.suspended,
            role=excluded.role
    """, (uid, email, name, phash, role, verified, suspended, cat))

# 2. Get all published courses
courses = [r[0] for r in cur.execute("SELECT course FROM course_publication WHERE published=1").fetchall()]
print(f"Found {len(courses)} published courses")

# 3. Enroll all accounts in all published courses
all_uids = ["legacy", "usr_598a952ec4e9cb1e80e395ae03db3965", "usr_lavkush", "usr_ee938383e094c9a4e52f7fa053b835d9", "usr_44b5ccc425016f94b11d42cf06b3e0fa"]
for uid in all_uids:
    for course in courses:
        cur.execute("INSERT OR IGNORE INTO enrollments (user_id, course, created_at) VALUES (?, ?, ?)", (uid, course, now))

# 4. Copy video_progress from legacy to usr_lavkush and admin uid
for uid in ["usr_lavkush", "usr_598a952ec4e9cb1e80e395ae03db3965"]:
    cur.execute("""
        INSERT OR IGNORE INTO video_progress (user_id, video_id, percent, position, completed, updated_at)
        SELECT ?, video_id, percent, position, completed, updated_at
        FROM video_progress WHERE user_id='legacy'
    """, (uid,))

# 5. Clear rate limits
cur.execute("DELETE FROM rate_limits")

conn.commit()

print("=== Users in DB ===")
for row in cur.execute("SELECT id, email, role, verified, suspended FROM users").fetchall():
    print(row)

count_enr = cur.execute("SELECT COUNT(*) FROM enrollments").fetchone()[0]
print(f"=== Total Enrollments in DB: {count_enr} ===")
count_rl = cur.execute("SELECT COUNT(*) FROM rate_limits").fetchone()[0]
print(f"=== Rate limits remaining: {count_rl} ===")

conn.close()

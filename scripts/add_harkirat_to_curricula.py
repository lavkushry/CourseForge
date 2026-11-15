import json, re, hashlib
from pathlib import Path

ROOT_DIR = Path('/home/ubuntu/CourseForge')
RAW_JSON_PATH = ROOT_DIR / 'harkirat_super30_raw.json'
CURRICULA_PATH = ROOT_DIR / 'new_5_curricula.json'
COURSE_KEY = 'Harkirat Singh Super 30 Courses'
CLAIM_PREFIX = 'harkirat-super30-2026'

def sanitize_filename(name: str) -> str:
    s = re.sub(r'[\\/*?:"<>|]', ' ', name)
    return re.sub(r'\s+', ' ', s).strip()

def make_slug(name: str) -> str:
    s = re.sub(r'[^a-zA-Z0-9]+', '-', name.lower()).strip('-')
    return s[:78].strip('-')

MODULES = [
    (1, 1, 15, 'Module 01', 'Season 1.0: Advanced Microservices, Real-Time Systems & Architecture', []),
    (2, 16, 26, 'Module 02', 'Season 1.0: Enterprise Backend & Cloud Infrastructure', []),
    (3, 27, 40, 'Module 03', 'Season 1.0: Scalable Frontend Systems & DevOps Automation', []),
    (4, 41, 56, 'Module 04', 'Season 2.0: High-Frequency Trading Platform Architecture (Exness Clone)', []),
    (5, 57, 70, 'Module 05', 'Season 2.0: Limit Order Book, In-Memory Matching Engine & Market Data', []),
    (6, 71, 85, 'Module 06', 'Season 2.0: Margin Trading, Risk Engine & Real-Time Settlement', []),
    (7, 86, 95, 'Module 07', 'Season 2.0: Solana Web3 & Decentralized Financial Infrastructure', []),
    (8, 96, 105, 'Module 08', 'Season 2.0: Production Cross-Platform Mobile Engineering (React Native)', []),
]

with open(RAW_JSON_PATH) as f:
    raw_items = json.load(f)

video_items = []
for idx, r in enumerate(raw_items, 1):
    mod_num, mod_tag, mod_title = 8, 'Module 08', MODULES[-1][4]
    for mn, s, e, mt, mtitle, _ in MODULES:
        if s <= idx <= e:
            mod_num, mod_tag, mod_title = mn, mt, mtitle
            break

    fn = r.get('filename') or ''
    txt = (r.get('caption') or '').strip().split('\n')[0]
    base_name = txt or fn or f'Lecture {idx:03d}'
    base_name = re.sub(r'@hmaracollege(\.[a-zA-Z0-9]+)?', '', base_name, flags=re.I)
    base_name = re.sub(r'@thebatmanreborn', '', base_name, flags=re.I)
    base_name = re.sub(r'@thebatmanr', '', base_name, flags=re.I)
    base_name = re.sub(r'\.(mp4|ts|mkv)$', '', base_name, flags=re.I)
    base_name = re.sub(r'GMT\d+-\d+', '', base_name).strip()
    base_name = re.sub(r'^\d+[_.\s]+', '', base_name).strip()
    base_name = re.sub(r'\s+', ' ', base_name).strip() or f'Lecture {idx:03d}'

    title = f'[{idx:03d}] {mod_tag} - {base_name}'
    clean_fn = sanitize_filename(title) + '.mp4'
    vid_id = 'v_' + hashlib.sha1(f'{COURSE_KEY}:{r["msg_id"]}'.encode()).hexdigest()[:12]
    claim_name = make_slug(f'{CLAIM_PREFIX}-{idx:03d}-{base_name}')[:78]

    video_items.append({
        'idx': idx,
        'msg_id': r['msg_id'],
        'kind': 'video',
        'module_num': mod_num,
        'module_tag': mod_tag,
        'module_title': mod_title,
        'title': title,
        'clean_filename': clean_fn,
        'orig_filename': fn,
        'needs_remux': False,
        'size': r.get('size') or 0,
        'duration': float(r.get('duration') or 0),
        'video_id': vid_id,
        'claim_name': claim_name,
    })

course_obj = {
    'course_key': COURSE_KEY,
    'course_title': 'Harkirat Singh — 100xDevs Super 30 (Season 1.0 & Season 2.0)',
    'instructor': 'Harkirat Singh (100xDevs)',
    'category': 'Full-Stack, Distributed Systems & Financial Engineering',
    'tags': ['Super 30', 'Harkirat Singh', 'Golang', 'Kubernetes', 'Trading Engine', 'Orderbook', 'Solana', 'Anchor', 'React Native', 'Distributed Systems'],
    'description': 'The elite Harkirat Singh 100xDevs Super 30 curriculum combining Season 1.0 (Golang Microservices, Kubernetes Ingress, Video Transcoding, Unacademy Backend, React 19 Internals & AI Agents) and Season 2.0 (High-Frequency Exness Trading Platform Clone, Real-Time Limit Order Book, Margin & Risk Engines, Solana Smart Contracts, and React Native Production Mobile Bootcamp).',
    'channel_id': -1003258779632,
    'topic_id': None,
    'claim_prefix': CLAIM_PREFIX,
    'learning_path_id': 'lp_harkirat_super30_2026',
    'learning_path_goal': 'Achieve Elite Principal Engineering Mastery: Architect High-Frequency Financial Engines, Scalable Kubernetes Microservices, Decentralized Web3 Systems, and Cross-Platform Native Mobile Applications.',
    'cover_colors': ((15, 23, 42), (147, 51, 234), 'HARKIRAT • 100xDEVS SUPER 30', '105 Masterclass Lectures + 24 Verified Study Guides'),
    'modules': [{'num': mn, 'tag': mt, 'title': mtitle, 'objectives': []} for mn, _, _, mt, mtitle, _ in MODULES],
    'items': video_items,
}

with open(CURRICULA_PATH, 'r') as f:
    curricula = json.load(f)

curricula = [c for c in curricula if c.get('course_key') != COURSE_KEY]
curricula.append(course_obj)
with open(CURRICULA_PATH, 'w') as f:
    json.dump(curricula, f, indent=2)

print(f'Successfully added {COURSE_KEY} to {CURRICULA_PATH}! Total courses now: {len(curricula)}')

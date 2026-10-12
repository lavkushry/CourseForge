import re

path = "/home/ubuntu/CourseForge/app/tutor.py"
with open(path, "r") as f:
    code = f.read()

# 1. Update retrieve function
old_retrieve = """def retrieve(query: str, course: str | None = None, video_id: str | None = None,
             limit: int = 7) -> list[dict]:
    try:
        semantic = semantic_search(query, course=course, video_id=video_id, limit=limit)
    except Exception:
        semantic = []  # Keyword fallback if Qdrant or embeddings is temporarily unavailable.
    keywords = keyword_search(query, course=course, video_id=video_id, limit=4)
    seen: set[str] = set()
    combined: list[dict] = []
    for hit in semantic + keywords:
        if not course_allowed(hit['course']):
            continue
        cid = hit.get('chunk_id') or hit.get('id')
        if cid in seen:
            continue
        seen.add(cid)
        combined.append({
            'chunk_id': cid, 'video_id': hit['video_id'], 'course': hit['course'], 'title': hit['title'],
            'kind': hit['kind'], 'start': hit['start'], 'end': hit['end'],
            'text': hit['text'], 'frame_path': hit.get('frame_path'),
            'score': hit.get('score'),
        })
        if len(combined) >= limit:
            break
    return combined"""

new_retrieve = """def retrieve(query: str, course: str | None = None, video_id: str | None = None,
             limit: int = 7) -> list[dict]:
    try:
        semantic = semantic_search(query, course=course, video_id=video_id, limit=limit)
    except Exception:
        semantic = []  # Keyword fallback if Qdrant or embeddings is temporarily unavailable.
    keywords = keyword_search(query, course=course, video_id=video_id, limit=limit)
    seen: set[str] = set()
    combined: list[dict] = []
    for hit in semantic + keywords:
        if not course_allowed(hit['course']):
            continue
        cid = hit.get('chunk_id') or hit.get('id')
        if cid in seen:
            continue
        seen.add(cid)
        combined.append({
            'chunk_id': cid, 'video_id': hit['video_id'], 'course': hit['course'], 'title': hit['title'],
            'kind': hit['kind'], 'start': hit['start'], 'end': hit['end'],
            'text': hit['text'], 'frame_path': hit.get('frame_path'),
            'score': hit.get('score'),
        })
        if len(combined) >= limit:
            break

    # Robust multi-level fallback if query phrasing was broad or unique
    if not combined:
        with connect() as conn:
            if video_id:
                for r in conn.execute('SELECT c.*, v.title, v.course FROM chunks c JOIN videos v ON v.id=c.video_id WHERE c.video_id=? ORDER BY c.start LIMIT ?', (video_id, limit)).fetchall():
                    cid = r['id']
                    if cid not in seen:
                        seen.add(cid)
                        combined.append(dict(r, chunk_id=cid))
            elif course:
                for r in conn.execute('SELECT c.*, v.title, v.course FROM chunks c JOIN videos v ON v.id=c.video_id WHERE v.course=? ORDER BY c.start LIMIT ?', (course, limit)).fetchall():
                    cid = r['id']
                    if cid not in seen:
                        seen.add(cid)
                        combined.append(dict(r, chunk_id=cid))
            if not combined:
                terms = [w.lower() for w in re.findall(r'\\b[A-Za-z0-9_-]{3,}\\b', query)
                         if w.lower() not in {'what', 'when', 'where', 'which', 'explain', 'tell', 'show', 'give', 'about', 'from', 'course', 'lesson', 'lecture', 'core', 'concept', 'step'}]
                for term in terms[:3]:
                    for r in conn.execute('''SELECT c.*, v.title, v.course FROM chunks c JOIN videos v ON v.id=c.video_id
                                            WHERE (v.title LIKE ? OR c.text LIKE ?) AND cf_course_allowed(v.course)
                                            ORDER BY c.start LIMIT ?''', (f'%{term}%', f'%{term}%', limit - len(combined))).fetchall():
                        cid = r['id']
                        if cid not in seen:
                            seen.add(cid)
                            combined.append(dict(r, chunk_id=cid))
                    if len(combined) >= limit:
                        break

    return combined"""

assert old_retrieve in code, "old_retrieve target not found"
code = code.replace(old_retrieve, new_retrieve, 1)

# 2. Update Ollama chat call options: timeout=60, num_ctx: 2048, num_predict: 350
old_call = """        with httpx.Client(timeout=45) as http:
            response = http.post(settings.ollama_url + '/api/chat', json={
                'model': settings.chat_model, 'stream': False,
                'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
                'options': {'temperature': 0.2, 'num_ctx': 8192},
            })"""

new_call = """        with httpx.Client(timeout=60) as http:
            response = http.post(settings.ollama_url + '/api/chat', json={
                'model': settings.chat_model, 'stream': False,
                'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
                'options': {'temperature': 0.2, 'num_ctx': 2048, 'num_predict': 350},
            })"""

assert old_call in code, "old_call target not found"
code = code.replace(old_call, new_call, 1)

# 3. Update not evidence handling
old_no_ev = """    if not evidence:
        return {'answer': 'I could not find relevant indexed course material for this topic in your enrolled courses. This concept is not covered in your current course content.',
                'sources': []}"""

new_no_ev = """    if not evidence:
        system_fallback = (
            'You are CourseForge, a practical, personal AI tutor for engineering students. '
            'Explain the requested concept clearly from fundamentals with a concrete example. '
            'Note gently that this is supplementary guidance as this specific term was not found in enrolled lecture titles.'
        )
        try:
            with httpx.Client(timeout=60) as http:
                response = http.post(settings.ollama_url + '/api/chat', json={
                    'model': settings.chat_model, 'stream': False,
                    'messages': [{'role': 'system', 'content': system_fallback}, {'role': 'user', 'content': f'{prompt_for(mode)}\\n\\n{question}'}],
                    'options': {'temperature': 0.2, 'num_ctx': 2048, 'num_predict': 350},
                })
                response.raise_for_status()
                return {'answer': response.json()['message']['content'].strip(), 'sources': []}
        except Exception:
            return {'answer': 'I could not find matching lectures for this query in your enrolled courses. Try asking about specific course topics like System Design, Big Data, Spark, Kafka, SQL, or Agentic AI.', 'sources': []}"""

assert old_no_ev in code, "old_no_ev target not found"
code = code.replace(old_no_ev, new_no_ev, 1)

with open(path, "w") as f:
    f.write(code)

print("app/tutor.py updated successfully!")

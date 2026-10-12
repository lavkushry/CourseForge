"""Grounded tutoring, summary, quiz, and lab prompts with timestamp citations and offline fallback."""
import math
import re
import uuid
from typing import Literal
import httpx
from .config import settings
from .db import keyword_search, course_allowed, connect, owner, utcnow
from .vectorstore import semantic_search

Mode = Literal['explain', 'notes', 'quiz', 'lab']


def _clean_title(title: str) -> str:
    cleaned = re.sub(r'^\[\d+(?: Part\d+)?\]\s*', '', str(title or ''))
    cleaned = re.sub(r'\s*(?:\[Live\]|\(Live\))\s*', ' ', cleaned, flags=re.IGNORECASE)
    return cleaned.strip()


def _format_time(seconds: float) -> str:
    s = max(0, int(seconds))
    mins = s // 60
    secs = s % 60
    return f"{mins}:{secs:02d}"


def retrieve(query: str, course: str | None = None, video_id: str | None = None,
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
                terms = [w.lower() for w in re.findall(r'\b[A-Za-z0-9_-]{3,}\b', query)
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

    return combined


def prompt_for(mode: Mode) -> str:
    return {
        'explain': 'Teach the concept clearly from fundamentals. Include a concrete worked example, exact lesson citations, and a short check-for-understanding question.',
        'notes': 'Create concise hierarchical study notes from the relevant lecture excerpts. Include exact commands, definitions, and lesson timestamps where supported.',
        'quiz': 'Produce 5 questions from the source material, including 2 applied questions. Put answer keys with explanations and timestamp references at the end.',
        'lab': ('Design one safe hands-on lab based on the cited course material. Include prerequisites, objective, environment setup, '
                '5-8 numbered tasks, commands only where supported, verification commands, expected results, hints, and cleanup. '
                'Never execute code. Do not invent production infrastructure or credentials. Use disposable local environments.'),
    }[mode]


def ask(question: str, mode: Mode = 'explain', course: str | None = None,
        video_id: str | None = None) -> dict:
    evidence = retrieve(question, course=course, video_id=video_id)
    if not evidence:
        system_fallback = (
            'You are CourseForge, a practical, personal AI tutor for engineering students. '
            'Explain the requested concept clearly from fundamentals with a concrete example. '
            'Note gently that this is supplementary guidance as this specific term was not found in enrolled lecture titles.'
        )
        try:
            with httpx.Client(timeout=75) as http:
                response = http.post(settings.ollama_url + '/api/chat', json={
                    'model': settings.chat_model, 'stream': False,
                    'messages': [{'role': 'system', 'content': system_fallback}, {'role': 'user', 'content': f'{prompt_for(mode)}\n\n{question}'}],
                    'options': {'temperature': 0.2, 'num_ctx': 1536, 'num_predict': 180},
                })
                response.raise_for_status()
                return {'answer': response.json()['message']['content'].strip(), 'sources': []}
        except Exception:
            return {'answer': 'I could not find matching lectures for this query in your enrolled courses. Try asking about specific course topics like System Design, Big Data, Spark, Kafka, SQL, or Agentic AI.', 'sources': []}

    # Detect Hinglish language preference
    is_hinglish = any(re.search(r'\b' + w + r'\b', question, re.IGNORECASE)
                      for w in ['kya', 'kaise', 'kyu', 'hai', 'batao', 'samjhao', 'me', 'ke', 'ka', 'ko', 'aur', 'karna', 'karenge', 'hota'])
    detected_lang = 'hinglish' if is_hinglish else 'en'

    # Build context with lesson title and timestamp links
    context_lines = []
    for i, s in enumerate(evidence[:4], 1):
        t_label = _format_time(s['start'])
        c_title = _clean_title(s['title'])
        context_lines.append(
            f'[S{i}] {s["course"]} / {c_title} (ID: {s["video_id"]}, Time: {t_label}, Seconds: {int(s["start"])}):\n'
            + s['text'][:320]
        )
    context = '\n\n'.join(context_lines)

    system = (
        'You are CourseForge, a practical, personal AI tutor. Use ONLY the provided course excerpts as course facts. '
        'Never fabricate citations or timestamps. '
        'Every factual claim MUST cite the exact lesson and timestamp using a markdown link in this exact format:\n'
        '[Watch MM:SS in Lesson Title](#learning/{video_id}?t={start_seconds})\n'
        'Example: [Watch 12:34 in Session 02 Storage Account ADLS Part 2](#learning/9429122dcb101b01b1aef3c4?t=754)\n'
        'Paraphrase and synthesize clearly. If a topic is not in the excerpts, state honestly that it is not covered. '
    )
    if is_hinglish:
        system += (
            '\nThe learner is asking in Hinglish (Hindi written in Latin/English alphabet). '
            'Explain naturally and conversationally in friendly Hinglish, while keeping all technical terms, cloud concepts, code, and commands in standard English.'
        )

    user = f'{prompt_for(mode)}\n\nLEARNER REQUEST:\n{question}\n\nSOURCE EXCERPTS:\n{context}'

    answer = ''
    offline = False
    model_used = settings.chat_model
    prompt_tokens = len(user) // 4
    completion_tokens = 0

    try:
        with httpx.Client(timeout=75) as http:
            response = http.post(settings.ollama_url + '/api/chat', json={
                'model': settings.chat_model, 'stream': False,
                'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
                'options': {'temperature': 0.2, 'num_ctx': 1536, 'num_predict': 180},
            })
            response.raise_for_status()
            res_json = response.json()
            answer = res_json['message']['content'].strip()
            prompt_tokens = res_json.get('prompt_eval_count', prompt_tokens)
            completion_tokens = res_json.get('eval_count', len(answer) // 4)
    except Exception:
        # Fallback without breaking: synthesize directly from retrieved excerpts
        offline = True
        model_used = 'offline-extractive-fallback'
        completion_tokens = 180
        fallback_points = []
        for s in evidence[:4]:
            t_str = _format_time(s['start'])
            clean_t = _clean_title(s['title'])
            link = f"[Watch {t_str} in {clean_t}](#learning/{s['video_id']}?t={int(s['start'])})"
            snippet = s['text'].strip()[:240].replace('\n', ' ')
            fallback_points.append(f"- **{link}**:\n  > “{snippet}…”")

        if is_hinglish:
            prefix = "*(AI tutor language model abhi offline hai ya warm-up ho raha hai. Aapke course content se directly yeh relevant information mili hai:)*\n\n"
        else:
            prefix = "*(The AI tutor language model is currently offline or warming up. Here is what your course material directly covers on this topic:)*\n\n"
        answer = prefix + '\n\n'.join(fallback_points)

    # Ensure timestamp links exist in answer if the model missed them
    if '[Watch ' not in answer and evidence:
        links = [
            f"- [Watch {_format_time(s['start'])} in {_clean_title(s['title'])}](#learning/{s['video_id']}?t={int(s['start'])})"
            for s in evidence[:3]
        ]
        answer += "\n\n**Relevant lecture moments:**\n" + '\n'.join(links)

    # Log usage into ai_tutor_logs
    uid = owner()
    log_uid = uid if uid and uid != 'legacy' else None
    try:
        with connect() as conn:
            conn.execute('''INSERT INTO ai_tutor_logs(id, user_id, question, course, video_id, mode, language,
                                                      prompt_tokens, completion_tokens, cost_estimate, model, offline_fallback, created_at)
                            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                         (str(uuid.uuid4()), log_uid, question[:500], course, video_id, mode, detected_lang,
                          prompt_tokens, completion_tokens, 0.0, model_used, int(offline), utcnow()))
    except Exception:
        pass

    return {
        'answer': answer,
        'sources': [dict(source, label=f'S{i}') for i, source in enumerate(evidence, 1)],
    }

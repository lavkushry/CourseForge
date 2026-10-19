"""Local, source-linked concepts, quizzes, flashcards and checkpoints.

No model is required. Each item quotes a transcript sentence or an OCR reading
and keeps that sentence's timestamp. One builder failure must not be fatal:
callers persist whatever this module returns.
"""
import hashlib
import json
import logging
import re
import uuid
from pathlib import Path

from .chunking import make_chunk_id
from .db import connect, utcnow

log = logging.getLogger(__name__)

_STOP = frozenset('''
a an the of to and or in on for with from by at as is are was were be been being
this that these those it its into over under about than then so if but not no yes
you your we our they their them what which who how when where why can will just
also more most other using use used lecture video lesson course says said
'''.split())
_WORD = re.compile(r"[A-Za-z][A-Za-z0-9_+#-]{2,}")
_ABSENT = (
    'The lecture does not state this.',
    'This idea is absent from the lecture.',
    'The recording skips this point.',
)
_MAX_CONCEPTS = 8
_MAX_CHECKPOINTS = 5
_MIN_CHECKPOINT_GAP = 15.0


def _terms(text: str) -> list[str]:
    return [word for word in _WORD.findall(text) if word.lower() not in _STOP]


def _title(text: str) -> str:
    terms = _terms(text)
    if not terms:
        return text.strip()[:80] or 'Lecture idea'
    proper = [term for term in terms if term[0].isupper()]
    chosen = proper[:3] if len(proper) >= 2 else terms[:3]
    return ' '.join(chosen)[:80]


def _jaccard(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def _moment(text: str, start: float, end: float, source: str) -> dict | None:
    cleaned = ' '.join(text.split())
    terms = _terms(cleaned)
    if len(terms) < 3 and len(cleaned) < 40:
        return None
    return {
        'title': _title(cleaned),
        'summary': cleaned[:500],
        'start': round(max(0.0, float(start)), 3),
        'end': round(max(float(start), float(end)), 3),
        'source': source,
        'terms': {term.lower() for term in terms},
    }


def extract_concepts(segments: list[dict], frames: list[dict] | None = None,
                     *, limit: int = _MAX_CONCEPTS) -> list[dict]:
    """Earliest distinct ideas from speech, then on-screen text the speech did not already cover."""
    found: list[dict] = []

    def add(moment: dict | None) -> None:
        if moment is None or len(found) >= limit:
            return
        if any(_jaccard(moment['terms'], item['terms']) >= 0.6 for item in found):
            return
        found.append(moment)

    for segment in segments:
        add(_moment(str(segment.get('text') or ''), float(segment.get('start') or 0),
                    float(segment.get('end') or segment.get('start') or 0), 'speech'))
    for frame in frames or []:
        add(_moment(str(frame.get('text') or ''), float(frame.get('start') or 0),
                    float(frame.get('end') or frame.get('start') or 0), 'screen'))
    for item in found:
        item.pop('terms', None)
    return found


def _options(correct: str, others: list[str], salt: str) -> tuple[list[str], int]:
    choices = [correct]
    for candidate in others + list(_ABSENT):
        text = ' '.join(str(candidate).split())[:180]
        if text and text.casefold() not in {item.casefold() for item in choices}:
            choices.append(text)
        if len(choices) == 4:
            break
    while len(choices) < 4:
        filler = f'Unstated option {len(choices)}'
        if filler.casefold() not in {item.casefold() for item in choices}:
            choices.append(filler)
    shift = int(hashlib.sha256(salt.encode()).hexdigest(), 16) % 4
    rotated = choices[shift:] + choices[:shift]
    return rotated, rotated.index(correct)


def build_quiz(concepts: list[dict]) -> list[dict]:
    questions = []
    summaries = [item['summary'][:180] for item in concepts]
    for index, concept in enumerate(concepts[:4]):
        correct = concept['summary'][:180]
        options, correct_index = _options(correct, summaries[index + 1:] + summaries[:index], concept['title'])
        digest = hashlib.sha256(f"{concept['title']}:{concept['start']}:{index}".encode()).hexdigest()[:8]
        questions.append({
            'id': f'q_{index + 1}_{digest}',
            'question': f"What does the lecture say about {concept['title']}?",
            'options': options,
            'correct_index': correct_index,
            'explanation': f"At {int(concept['start'])}s the lecture says: {concept['summary'][:240]}",
            'concept': concept['title'],
            'source_start': concept['start'],
            'source': concept['source'],
        })
    return questions


def build_flashcards(video_id: str, concepts: list[dict]) -> list[dict]:
    cards = []
    for index, concept in enumerate(concepts[:8]):
        question = f"What does the lecture say about {concept['title']}?"
        answer = concept['summary'][:500]
        if len(question) < 8 or not answer:
            continue
        stamp = concept['start']
        cards.append({
            'id': 'lf_' + hashlib.sha256(f'{video_id}:{index}:{stamp}'.encode()).hexdigest()[:16],
            'video_id': video_id,
            'question': question[:500],
            'answer': answer,
            'source_start': concept['start'],
            'concept': concept['title'],
        })
    return cards


def build_checkpoints(concepts: list[dict]) -> list[dict]:
    """One pause after an idea has been stated. Skip ideas that sit on top of the previous pause."""
    checkpoints = []
    last_at = None
    short = len(concepts) <= 1 or (
        concepts and max(item['end'] for item in concepts) - min(item['start'] for item in concepts) < 20
    )
    for concept in concepts:
        if len(checkpoints) >= _MAX_CHECKPOINTS:
            break
        words = _terms(concept['summary'])
        if len(words) < 4 and len(concept['summary']) < 40:
            continue
        at = concept['end'] if concept['end'] > concept['start'] else concept['start']
        if short:
            at = concept['start'] if concept['end'] - concept['start'] < 1 else round((concept['start'] + concept['end']) / 2, 3)
        if last_at is not None and at - last_at < _MIN_CHECKPOINT_GAP:
            continue
        checkpoints.append({
            'id': f"cp_{len(checkpoints) + 1}_{hashlib.sha256(concept['title'].encode()).hexdigest()[:8]}",
            'start': round(float(at), 3),
            'prompt': f"What does the lecture say about {concept['title']}?",
            'answer': concept['summary'][:500],
            'concept': concept['title'],
        })
        last_at = at
        if short:
            break
    return checkpoints


def assemble(video_id: str, segments: list[dict], frames: list[dict] | None = None) -> dict:
    concepts = extract_concepts(segments, frames)
    return {
        'concepts': concepts,
        'quizzes': build_quiz(concepts),
        'flashcards': build_flashcards(video_id, concepts),
        'checkpoints': build_checkpoints(concepts),
    }


def learning_chunks(video_id: str, built: dict) -> list[dict]:
    """Searchable copies. Checkpoint text is the prompt only, so the timeline does not reveal the answer."""
    chunks: list[dict] = []
    for index, concept in enumerate(built.get('concepts') or []):
        chunks.append({
            'id': make_chunk_id(video_id, 'concept', concept['start'], index),
            'video_id': video_id, 'kind': 'concept',
            'start': concept['start'], 'end': concept['end'],
            'text': f"{concept['title']}. {concept['summary']}",
            'frame_path': None,
        })
    for index, card in enumerate(built.get('flashcards') or []):
        chunks.append({
            'id': make_chunk_id(video_id, 'flashcard', card['source_start'], index),
            'video_id': video_id, 'kind': 'flashcard',
            'start': card['source_start'], 'end': card['source_start'],
            'text': f"{card['question']} {card['answer']}",
            'frame_path': None,
        })
    for index, checkpoint in enumerate(built.get('checkpoints') or []):
        chunks.append({
            'id': make_chunk_id(video_id, 'checkpoint', checkpoint['start'], index),
            'video_id': video_id, 'kind': 'checkpoint',
            'start': checkpoint['start'], 'end': checkpoint['start'],
            'text': 'Checkpoint: ' + checkpoint['prompt'],
            'frame_path': None,
        })
    return chunks


def ensure_schema(path: Path | None = None) -> None:
    with connect(path) as db:
        db.executescript('''
        CREATE TABLE IF NOT EXISTS learning_objects (
          video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
          concepts_json TEXT NOT NULL,
          flashcards_json TEXT NOT NULL,
          checkpoints_json TEXT NOT NULL,
          stages_json TEXT NOT NULL,
          updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS lesson_flashcards (
          id TEXT PRIMARY KEY,
          video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
          course TEXT NOT NULL,
          question TEXT NOT NULL,
          answer TEXT NOT NULL,
          source_start REAL NOT NULL,
          concept TEXT NOT NULL DEFAULT '');
        CREATE INDEX IF NOT EXISTS lesson_flashcards_video ON lesson_flashcards(video_id);
        ''')


def persist(video: dict, built: dict, stages: list[dict], *, source_ready: bool = True,
           path: Path | None = None) -> None:
    """Replace this lecture's derived object when a source stage actually ran.

    A failed whisper and a failed keyframe pass leave an earlier quiz in place.
    Learner quiz attempts stay attached to the stable quiz id when the row is updated.
    """
    ensure_schema(path)
    video_id = video['id']
    course = video['course']
    now = utcnow()
    quiz_id = 'lq_' + hashlib.sha256(video_id.encode()).hexdigest()[:16]
    concepts = built.get('concepts') or []
    if not concepts and not source_ready:
        write_stages(video_id, stages, path)
        log.info('learning object kept previous quiz video=%s reason=no new source', video_id)
        return
    with connect(path) as db:
        db.execute('DELETE FROM lesson_flashcards WHERE video_id=?', (video_id,))
        db.executemany('''INSERT INTO lesson_flashcards(id,video_id,course,question,answer,source_start,concept)
                          VALUES (:id,:video_id,:course,:question,:answer,:source_start,:concept)''',
                       [{**card, 'course': course} for card in built.get('flashcards') or []])
        questions = built.get('quizzes') or []
        if questions:
            payload = json.dumps(questions)
            existing = db.execute('SELECT id FROM lesson_quizzes WHERE video_id=?', (video_id,)).fetchone()
            if existing:
                db.execute('UPDATE lesson_quizzes SET questions_json=?, course=? WHERE id=?',
                           (payload, course, existing['id']))
            else:
                db.execute('''INSERT INTO lesson_quizzes(id,video_id,course,questions_json,created_at)
                              VALUES (?,?,?,?,?)''', (quiz_id, video_id, course, payload, now))
        elif source_ready:
            db.execute('DELETE FROM lesson_quizzes WHERE video_id=?', (video_id,))
        db.execute('''INSERT INTO learning_objects(video_id,concepts_json,flashcards_json,checkpoints_json,stages_json,updated_at)
                      VALUES (?,?,?,?,?,?)
                      ON CONFLICT(video_id) DO UPDATE SET
                        concepts_json=excluded.concepts_json,
                        flashcards_json=excluded.flashcards_json,
                        checkpoints_json=excluded.checkpoints_json,
                        stages_json=excluded.stages_json,
                        updated_at=excluded.updated_at''',
                   (video_id, json.dumps(built.get('concepts') or []), json.dumps(built.get('flashcards') or []),
                    json.dumps(built.get('checkpoints') or []), json.dumps(stages), now))
    log.info('learning object stored video=%s concepts=%s quizzes=%s flashcards=%s checkpoints=%s',
             video_id, len(built.get('concepts') or []), len(built.get('quizzes') or []),
             len(built.get('flashcards') or []), len(built.get('checkpoints') or []))


def write_stages(video_id: str, stages: list[dict], path: Path | None = None) -> None:
    """Record the final stage report, including failures that happened after the first save."""
    ensure_schema(path)
    with connect(path) as db:
        db.execute('''UPDATE learning_objects SET stages_json=?, updated_at=? WHERE video_id=?''',
                   (json.dumps(stages), utcnow(), video_id))


def checkpoints_for(video_id: str, path: Path | None = None) -> list[dict]:
    ensure_schema(path)
    with connect(path) as db:
        row = db.execute('SELECT checkpoints_json FROM learning_objects WHERE video_id=?', (video_id,)).fetchone()
    if not row:
        return []
    try:
        data = json.loads(row['checkpoints_json'])
    except (TypeError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    return [{'id': item.get('id'), 'start': item.get('start'), 'prompt': item.get('prompt'),
             'answer': item.get('answer'), 'concept': item.get('concept')}
            for item in data if isinstance(item, dict)]

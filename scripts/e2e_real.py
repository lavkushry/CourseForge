"""Real-machine E2E smoke test. Needs 1 indexed video, Ollama, Qdrant and FFmpeg.

Unlike pytest integration tests, this exercises REAL Whisper, vision, embeddings,
vector DB, tutor, syllabus and flashcards. It may take minutes on a CPU laptop.
"""
import argparse
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.config import settings
from app import db, extractor, vision, vectorstore, syllabus, reviews, tutor
from app.chunking import transcript_chunks


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--video-id', required=True, help='Video ID shown in GET /api/videos')
    args=parser.parse_args()
    db.init_db()
    video=db.fetch_video(args.video_id)
    if not video:
        parser.error('Unknown video ID; Scan Library first')
    path=Path(video['path']).resolve()
    if not path.is_file() or not path.is_relative_to(settings.courses_dir):
        parser.error('Video is outside configured library or file missing')
    print('1/6 Transcribing REAL video:',path.name,flush=True)
    segs,language=extractor.transcribe(path,args.video_id)
    assert segs, 'No speech detected; choose a lecture containing speech'
    print('2/6 Extracting REAL frames + vision',flush=True)
    frames=vision.enrich_frames(extractor.extract_frames(path,args.video_id))
    if settings.enable_vision and not any('Visual explanation:' in f['text'] for f in frames):
        raise AssertionError('Vision was enabled, but no frame was described. Check model, logs, or choose a lecture with screen changes.')
    chunks=transcript_chunks(args.video_id,segs)+frames
    print('3/6 Embedding and writing real Qdrant vectors',flush=True)
    vectorstore.index_video(video,chunks)
    db.replace_chunks(args.video_id,chunks)
    with db.connect() as conn:
        conn.execute('UPDATE videos SET status=?,indexed_at=?,language=?,duration=? WHERE id=?',
                     ('done',db.utcnow(),language,extractor.video_duration(path),args.video_id))
    print('4/6 Asking grounded tutor',flush=True)
    answer=tutor.ask('What is the main concept discussed in this lecture?',video_id=args.video_id)
    assert answer['sources'] and answer['answer'], 'Tutor produced no evidence or answer'
    print('5/6 Generating course syllabus',flush=True)
    plan=syllabus.generate(video['course'])
    assert plan['topics'], 'No syllabus topics'
    print('6/6 Generating real active-recall flashcards',flush=True)
    cards=reviews.generate_cards(video['course'],'core concepts',3)
    assert cards['created']>0 and db.fetch_videos(), 'No cards generated'
    print('PASS: Real Whisper, OCR/vision, embedding/Qdrant, tutoring, syllabus, and quiz workflow.')
    print(f"Created {cards['created']} review cards, {len(plan['topics'])} syllabus topics; language {language}")


if __name__=='__main__':
    main()

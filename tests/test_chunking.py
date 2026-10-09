from app.chunking import transcript_chunks, make_chunk_id, video_id_for_path


def test_time_boundaries_and_overlap():
    segments = [{'start': i*30, 'end': i*30+20, 'text': f'Concept {i} explained thoroughly.'}
                for i in range(9)]
    chunks = transcript_chunks('vid', segments, max_chars=120, max_seconds=110)
    assert len(chunks) > 1
    assert all(c['start'] <= c['end'] for c in chunks)
    assert 'Concept 0' in chunks[0]['text']
    assert 'Concept 8' in chunks[-1]['text']
    assert all(c['kind'] == 'speech' for c in chunks)
    assert len(set(c['id'] for c in chunks)) == len(chunks)


def test_chunking_empty_transcript():
    assert transcript_chunks('v', []) == []
    assert transcript_chunks('v', [{'start': 0, 'end': 1, 'text': '  '}]) == []


def test_stable_ids():
    assert video_id_for_path('/foo/bar.mp4') == video_id_for_path('/foo/bar.mp4')
    assert video_id_for_path('/foo/bar.mp4') != video_id_for_path('/foo/baz.mp4')
    assert make_chunk_id('v', 'speech', 1.5, 0) != make_chunk_id('v', 'screen', 1.5, 0)

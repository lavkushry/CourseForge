from app import tutor


def test_ask_when_no_evidence(monkeypatch):
    monkeypatch.setattr(tutor, 'retrieve', lambda *args, **kwargs: [])
    outcome=tutor.ask('Explain Kafka')
    assert outcome['sources']==[]
    assert 'could not find' in outcome['answer'].lower()


def test_retrieval_deduplicates(monkeypatch):
    result = {'id':'same','video_id':'a','course':'Data','title':'Data 01',
              'kind':'speech','start':0,'end':11,'text':'data lake', 'frame_path':None}
    monkeypatch.setattr(tutor, 'semantic_search', lambda *args, **kwargs: [{**result, 'chunk_id':'same','score':0.83}])
    monkeypatch.setattr(tutor, 'keyword_search', lambda *args, **kwargs: [result])
    results=tutor.retrieve('data lake')
    assert len(results)==1
    assert results[0]['score']==0.83

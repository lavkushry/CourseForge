from pathlib import Path
from dataclasses import replace
from app import vision


def test_vision_enriches_frame_and_respects_budget(tmp_path,monkeypatch):
    root=tmp_path/'data';(root/'frames').mkdir(parents=True)
    (root/'frames'/'sample.jpg').write_bytes(b'fake image')
    monkeypatch.setattr(vision,'settings',replace(vision.settings,data_dir=root,enable_vision=True,max_vision_frames=1))
    monkeypatch.setattr(vision,'describe_image',lambda *_:'A diagram shows two pods linked through a Service')
    frames=[{'frame_path':'frames/sample.jpg','text':'apiVersion'}, {'frame_path':'frames/sample.jpg','text':'more'}]
    result=vision.enrich_frames(frames)
    assert 'two pods' in result[0]['text']
    assert result[1]['text']=='more'


def test_vision_failure_keeps_ocr(tmp_path,monkeypatch):
    root=tmp_path/'data';root.mkdir()
    (root/'x.jpg').write_bytes(b'fake')
    monkeypatch.setattr(vision,'settings',replace(vision.settings,data_dir=root,enable_vision=True,vision_required=False))
    monkeypatch.setattr(vision,'describe_image',lambda *_: (_ for _ in ()).throw(ValueError('no model')))
    frames=[{'frame_path':'x.jpg','text':'kubectl get pods'}]
    assert vision.enrich_frames(frames)[0]['text']=='kubectl get pods'

"""Course catalog contracts, image validation, and real FFmpeg frame thumbnail smoke test."""
from dataclasses import replace
import io
import shutil
import subprocess
from pathlib import Path

from client_helpers import TestClient
from PIL import Image
import pytest

from app import db, library, main, course_metadata


def config_client(tmp_path, monkeypatch):
    course_dir=tmp_path/'courses'/'SQL & Spark'
    course_dir.mkdir(parents=True)
    (course_dir/'lesson.mp4').write_bytes(b'fake-clip')
    conf=replace(db.settings, courses_dir=course_dir.parent,data_dir=tmp_path/'data')
    for module in (main, db, library, course_metadata):
        monkeypatch.setattr(module,'settings',conf)
    return conf


def png_bytes():
    image=Image.new('RGB',(640,360),'navy')
    data=io.BytesIO()
    image.save(data,format='PNG')
    return data.getvalue()


def test_catalog_persists_metadata_across_scan_and_uses_safe_folder_id(tmp_path,monkeypatch):
    conf=config_client(tmp_path,monkeypatch)
    with TestClient(main.app) as client:
        client.post('/api/scan')
        assert client.get('/api/courses').json()['courses'][0]['id']=='SQL & Spark'
        endpoint='/api/courses/SQL%20%26%20Spark'
        result=client.patch(endpoint,json={'title':'Modern Data Engineering','instructor':'Ada','category':'Data Engineering','tags':['SQL','PySpark']})
        assert result.status_code==200,result.text
        assert result.json()['title']=='Modern Data Engineering'
        assert result.json()['instructor']=='Ada'
        assert result.json()['tags']==['SQL','PySpark']
        assert result.json()['id']=='SQL & Spark'
        client.post('/api/scan')
        assert client.get('/api/courses').json()['courses'][0]['title']=='Modern Data Engineering'
        assert client.get('/api/videos').json()['videos'][0]['course']=='SQL & Spark'
        assert client.get(endpoint).status_code==405  # API exposes edited catalog through /api/courses
        assert client.patch(endpoint,json={'tags':['SQL','sql']}).status_code==422
        assert client.patch(endpoint,json={'tags':['a']*13}).status_code==422
        assert client.patch('/api/courses/missing',json={'title':'bad'}).status_code==404
        assert not (conf.courses_dir/'SQL & Spark'/'cover.jpg').exists()


def test_cover_upload_reset_and_validation(tmp_path,monkeypatch):
    conf=config_client(tmp_path,monkeypatch)
    with TestClient(main.app) as client:
        client.post('/api/scan')
        url='/api/courses/SQL%20%26%20Spark/cover'
        assert client.put(url,content=b'not an image',headers={'Content-Type':'image/png'}).status_code==422
        assert client.put(url,content=b'test',headers={'Content-Type':'text/plain'}).status_code==415
        assert client.put(url,content=b'x'*(course_metadata.MAX_IMAGE_BYTES+1),headers={'Content-Type':'image/png'}).status_code==413
        resp=client.put(url,content=png_bytes(),headers={'Content-Type':'image/png'})
        assert resp.status_code==200,resp.text
        assert resp.json()['cover_kind']=='custom'
        saved=client.get(url)
        assert saved.status_code==200
        assert saved.headers['content-type'].startswith('image/jpeg')
        with Image.open(io.BytesIO(saved.content)) as img:
            assert img.size==(960,540)
        assert client.delete(url).status_code==200
        assert client.get('/api/courses').json()['courses'][0]['cover_kind'] is None
        assert client.get(url).status_code==404  # invalid placeholder clip
        assert client.delete('/api/courses/missing/cover').status_code==404
        assert client.put('/api/courses/missing/cover',content=png_bytes(),headers={'Content-Type':'image/png'}).status_code==404
        assert not list(conf.courses_dir.rglob('*.jpg'))  # never writes into source videos


@pytest.mark.skipif(not shutil.which('ffmpeg'),reason='FFmpeg unavailable')
def test_video_frame_generated_and_cached(tmp_path,monkeypatch):
    conf=config_client(tmp_path,monkeypatch)
    video=conf.courses_dir/'SQL & Spark'/'lesson.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=steelblue:s=320x180:r=5',
                    '-t','3','-c:v','mpeg4','-y',str(video)],check=True,timeout=20)
    with TestClient(main.app) as client:
        client.post('/api/scan')
        cover=client.get('/api/courses/SQL%20%26%20Spark/cover')
        assert cover.status_code==200, cover.text[:300] if cover.status_code != 200 else ''
        with Image.open(io.BytesIO(cover.content)) as img:
            assert img.size==(960,540)
        cache=course_metadata._cover_path('SQL & Spark', conf.data_dir)
        assert cache.is_file()
        first_mtime=cache.stat().st_mtime_ns
        assert client.get('/api/courses/SQL%20%26%20Spark/cover').status_code==200
        assert cache.stat().st_mtime_ns==first_mtime

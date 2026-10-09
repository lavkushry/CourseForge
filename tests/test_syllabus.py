from app.syllabus import canonical, topic_similarity, cosine, cluster_topics, generate, get_syllabus
from app import db, library
from dataclasses import replace


def test_topics_are_collapsed_but_sources_retained():
    raw=[{'title':'Kubernetes Pod Networking','objectives':['Know CNI'],'video_id':'a','video_title':'intro','start':3},
         {'title':'Pod Networking in Kubernetes','objectives':['Know networking'],'video_id':'b','video_title':'advanced','start':35},
         {'title':'Kafka Consumer Groups','objectives':[],'video_id':'c','video_title':'kafka','start':4}]
    result=cluster_topics(raw,vectors=[[1,0],[.999,.01],[0,1]])
    assert len(result)==2
    assert len(result[0]['sources'])==2
    assert result[0]['repeat_count']==1


def test_lexical_topic_dedup():
    topics=[{'title':'Python data frames','video_id':'a','video_title':'a','start':0},
            {'title':'Python Data Frames','video_id':'b','video_title':'b','start':9}]
    assert len(cluster_topics(topics))==1
    assert cosine([0,1],[1,0])==0


def test_syllabus_end_to_end_with_fake_llm(tmp_path,monkeypatch):
    root=tmp_path/'courses'; (root/'SQL').mkdir(parents=True)
    (root/'SQL'/'a.mp4').write_bytes(b'a')
    (root/'SQL'/'b.mp4').write_bytes(b'b')
    f=tmp_path/'db.sqlite3'
    for mod in (db,library):
        monkeypatch.setattr(mod,'settings',replace(db.settings,courses_dir=root,data_dir=tmp_path))
    db.init_db(f); library.scan_courses(root,f)
    for row in db.fetch_videos(f):
        with db.connect(f) as conn:
            conn.execute("UPDATE videos SET status='done',indexed_at=? WHERE id=?",('2026-10-09',row['id']))
        db.replace_chunks(row['id'],[{'id':row['id'],'video_id':row['id'],'kind':'speech','start':13,'end':30,
                 'text':'SQL joins connect related entities using matching keys and result in related rows.', 'frame_path':None}],path=f)
    s=generate('SQL',db_path=f,llm=lambda title,text:[{'title':'SQL joins','objectives':['Join tables'],'source_index':0}],embed=lambda texts:[[1,0] for _ in texts])
    assert s['duplicates_collapsed']==1
    assert len(s['topics'][0]['sources'])==2
    assert get_syllabus('SQL',f)['course']=='SQL'

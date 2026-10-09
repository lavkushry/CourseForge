"""Deterministic unit tests for reviewed P1 hands-on exercises."""
from pathlib import Path
from app import labs

def test_catalog_and_safety():
    assert len(labs.LABS)==8
    categories={x['category'] for x in labs.list_labs() if x.get('category')}
    assert {'SQL','PySpark','Docker','Ansible','Backend'} <= categories
    assert all('starter' not in x for x in labs.list_labs())
    spark=labs.docker_command(Path('/tmp'), 'pyspark-order-analytics')
    assert 'courseforge-lab-spark:local' in spark
    for x in ('--network=none','--read-only','--cap-drop=ALL','--memory=2g','--cpus=2'):
        assert x in spark
    assert not any('docker.sock' in x for x in spark)

def test_new_grader_module_uses_readonly_sql_and_static_config():
    root=Path(__file__).resolve().parents[1]
    grade=(root/'app/lab_graders/tracks.py').read_text()
    assert 'SQLITE_DENY' in grade and 'set_authorizer' in grade
    assert "safe_load_all" in grade
    assert "runpy.run_path" in grade
    assert (root/'docker/lab-spark.Dockerfile').is_file()

import json
import subprocess
import sys
from dataclasses import replace
from pathlib import Path
import pytest
from app import labs, db


def initialize(tmp_path,monkeypatch):
    settings=replace(labs.settings,data_dir=tmp_path/'data')
    monkeypatch.setattr(labs,'settings',settings)
    monkeypatch.setattr(db,'settings',settings)
    db.init_db()


def test_workspace_starter_and_edit(tmp_path,monkeypatch):
    initialize(tmp_path,monkeypatch)
    lab=labs.start_lab('python-log-analysis')
    assert 'count_errors' in labs.get_lab(lab['session_id'])['content']
    assert labs.update_file(lab['session_id'],'print(123)')['saved']
    assert labs.get_lab(lab['session_id'])['content']=='print(123)'
    with pytest.raises(ValueError):
        labs.update_file(lab['session_id'],'a'*101000)


def test_docker_flags_restrict_execution(tmp_path):
    args=labs.docker_command(tmp_path,'python-log-analysis')
    assert '--network=none' in args
    assert '--cap-drop=ALL' in args
    assert '--read-only' in args
    assert '--pids-limit=64' in args
    assert not any('docker.sock' in a for a in args)


def test_submit_mocked_docker(tmp_path,monkeypatch):
    initialize(tmp_path,monkeypatch)
    lab=labs.start_lab('shell-http-analysis')
    monkeypatch.setattr(labs,'_offline_grading',lambda *args:{'passed':True,'checks':[{'name':'x','passed':True}]})
    result=labs.submit_lab(lab['session_id'])
    assert result['passed']
    assert labs.get_lab(lab['session_id'])['status']=='passed'


def test_kind_is_disabled_by_default(tmp_path,monkeypatch):
    initialize(tmp_path,monkeypatch)
    assert labs._kind_live_validation(tmp_path)['skipped']


def test_curated_grader_python_and_shell(tmp_path):
    grader=Path(__file__).resolve().parents[1]/'app/lab_graders/grade.py'
    assert grader.is_file()
    assert 'shell-http-analysis' in grader.read_text()


def test_grader_validates_kubernetes_yaml(tmp_path,monkeypatch):
    import importlib.util
    location=Path(__file__).resolve().parents[1]/'app/lab_graders/grade.py'
    spec=importlib.util.spec_from_file_location('courseforge_grader_test',location)
    grader=importlib.util.module_from_spec(spec);spec.loader.exec_module(grader)
    monkeypatch.setattr(grader,'BASE',tmp_path)
    yaml=pytest.importorskip('yaml')
    template=labs.LABS['k8s-resilient-service']['starter']
    (tmp_path/'manifest.yaml').write_text(template)
    assert not all(c['passed'] for c in grader.k8s_lab())
    correct=template.replace('replicas: 1','replicas: 2').replace('          ports:\n', '''          readinessProbe:
            httpGet:
              path: /health
              port: 8080
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
            limits:
              cpu: 100m
              memory: 64Mi
          ports:
''')
    (tmp_path/'manifest.yaml').write_text(correct)
    result=grader.k8s_lab()
    assert all(c['passed'] for c in result),result


def test_grader_checks_shell_and_python(tmp_path,monkeypatch):
    import importlib.util
    location=Path(__file__).resolve().parents[1]/'app/lab_graders/grade.py'
    spec=importlib.util.spec_from_file_location('courseforge_grader_test2',location)
    grader=importlib.util.module_from_spec(spec);spec.loader.exec_module(grader)
    monkeypatch.setattr(grader,'BASE',tmp_path)
    (tmp_path/'solution.sh').write_text("#!/bin/sh\nawk '$3>=500 && $3<=599 {n++} END {print n+0}'\n")
    assert all(c['passed'] for c in grader.shell_lab())
    (tmp_path/'solution.py').write_text("def count_errors(lines):\n    return sum('ERROR' in l.split() for l in lines)\n")
    assert all(c['passed'] for c in grader.python_lab())

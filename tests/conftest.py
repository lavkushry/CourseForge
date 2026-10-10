"""Keep network provider refresh out of deterministic regression tests."""
import os
os.environ['ALLOWED_HOSTS']='localhost,127.0.0.1,testserver'
os.environ['PUBLIC_BASE_URL']='https://testserver'
os.environ['COOKIE_SECURE']='1'
import pytest
from app import academy


@pytest.fixture(autouse=True)
def no_provider_network(monkeypatch):
    monkeypatch.setattr(academy,'sync_provider_mappings',lambda:None)

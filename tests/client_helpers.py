"""Authenticated transport for pre-academy business-logic regression tests.

These tests seed 'legacy' learning records, so the admin uses that owner ID.
The academy tests use ordinary TestClient with genuine independent accounts.
"""
import httpx
from fastapi.testclient import TestClient as BaseClient
from app import auth,db,academy_worker


class TestClient(BaseClient):
    __test__=False

    def __init__(self,*args,**kwargs):
        kwargs.setdefault('base_url','https://testserver')
        super().__init__(*args,**kwargs)
        db.init_db()
        with db.connect() as conn:
            conn.execute('''INSERT OR IGNORE INTO users VALUES('legacy','regression@courseforge.test',
                'Regression administrator',?,'admin',1,0,?)''',(auth.hasher.hash('Regression password 123'),db.utcnow()))
        response=super().request('POST','/api/auth/login',json={'email':'regression@courseforge.test','password':'Regression password 123'})
        assert response.status_code==200,response.text
        self.headers['X-CSRF-Token']=response.json()['csrf_token']

    def resolve(self,response):
        """Assert queued HTTP contract, run the real worker, then fetch result."""
        assert response.status_code==202,response.text
        tid=response.json()['task_id']
        for _ in range(10):
            academy_worker.process_one()
            poll=self.get('/api/tasks/'+tid)
            assert poll.status_code==200,poll.text
            if poll.json()['status']=='done':
                return httpx.Response(200,json=poll.json()['result'],request=response.request)
            if poll.json()['status']=='failed':
                raise AssertionError(poll.text)
        raise AssertionError('Task did not finish')

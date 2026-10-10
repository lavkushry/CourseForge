"""Immediate registration without mail preserves authentication and course boundaries."""
from fastapi.testclient import TestClient
from app import auth, db, main
from test_academy import academy_env, PASSWORD, link_token


def open_registration(monkeypatch):
    monkeypatch.setenv('REGISTRATION_MODE', 'open')
    for key in ('SMTP_HOST', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASSWORD'):
        monkeypatch.delenv(key, raising=False)


def register(client, email='new@courseforge.test', **extra):
    return client.post('/api/auth/register', json={
        'name':'New learner', 'email':email, 'password':PASSWORD, **extra})


def test_immediate_registration_session_enrollment_and_audit(academy_env, monkeypatch):
    _, _, admin, _, sent = academy_env
    open_registration(monkeypatch)
    guest = TestClient(main.app, base_url='https://testserver')
    options = guest.get('/api/public/account-options').json()
    assert options['registration_enabled'] and options['registration_mode'] == 'open'
    assert not options['email_delivery'] and not options['email_registration']
    r = register(guest, email=' NEW@CourseForge.test ', role='admin', verified=False)
    assert r.status_code == 201, r.text
    result = r.json(); user = result['user']
    assert user['email'] == 'new@courseforge.test' and user['role'] == 'student' and user['verified'] == 1
    assert 'password_hash' not in user and not sent
    cookie = r.headers['set-cookie'].lower()
    assert 'httponly' in cookie and 'secure' in cookie and 'samesite=lax' in cookie
    assert guest.get('/api/me').json()['user']['id'] == user['id']
    assert guest.get('/api/videos').json()['videos'] == []
    assert guest.get('/api/videos/lecture').status_code == 403
    assert guest.post('/api/courses/SQL/enroll', json={}).status_code == 403
    guest.headers['x-csrf-token'] = result['csrf_token']
    assert guest.post('/api/courses/SQL/enroll', json={}).status_code == 201
    assert guest.get('/api/videos/lecture').status_code == 200
    assert guest.post('/api/courses/Private/enroll', json={}).status_code == 404
    assert guest.get('/api/videos/private').status_code == 403
    assert guest.get('/api/admin/users').status_code == 403
    assert guest.post('/api/scan').status_code == 403
    with db.connect() as conn:
        row = conn.execute('SELECT * FROM users WHERE id=?', (user['id'],)).fetchone()
        assert row['password_hash'] != PASSWORD and auth.check_password(row['password_hash'], PASSWORD)
        assert not conn.execute('SELECT 1 FROM account_tokens WHERE user_id=?', (user['id'],)).fetchone()
        assert conn.execute('SELECT token_hash FROM auth_sessions WHERE id=?',
                            (result['session_id'],)).fetchone()[0] == auth.digest(guest.cookies.get(auth.COOKIE))
    events = admin.get('/api/admin/users/'+user['id']).json()['access']
    assert {'registered', 'login', 'access_denied'} <= {e['event_type'] for e in events}
    assert PASSWORD not in str(events)


def test_registration_does_not_replace_existing_or_activate_invited_accounts(academy_env, monkeypatch):
    _, _, admin, _, _ = academy_env
    invitation = admin.post('/api/admin/invitations', json={
        'name':'Invited learner', 'email':'invited@courseforge.test'}).json()
    uid = invitation['user_id']
    with db.connect() as conn:
        before = dict(conn.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone())
    open_registration(monkeypatch)
    guest = TestClient(main.app, base_url='https://testserver')
    for email in ('INVITED@courseforge.test', 'ADMIN@courseforge.test'):
        r = register(guest, email=email, password=PASSWORD+' different', role='admin')
        assert r.status_code == 201 and 'user' not in r.json() and 'set-cookie' not in r.headers
    assert guest.get('/api/me').status_code == 401
    with db.connect() as conn:
        assert dict(conn.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()) == before
        assert conn.execute("SELECT role FROM users WHERE email='admin@courseforge.test'").fetchone()[0] == 'admin'
    assert guest.post('/api/auth/activate', json={
        'token':link_token(invitation['activation_url']), 'password':PASSWORD}).status_code == 200


def test_registration_validates_input_and_rejects_cross_origin(academy_env, monkeypatch):
    open_registration(monkeypatch)
    guest = TestClient(main.app, base_url='https://testserver')
    for extra in ({'password':'short'}, {'name':'   '}, {'email':'invalid'}):
        assert register(guest, **extra).status_code == 422
    assert guest.post('/api/auth/register', headers={'origin':'https://other.test'}, json={
        'name':'Learner', 'email':'cross@courseforge.test', 'password':PASSWORD}).status_code == 403
    with db.connect() as conn:
        assert conn.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 1


def test_registration_remains_rate_limited(academy_env, monkeypatch):
    open_registration(monkeypatch)
    guest = TestClient(main.app, base_url='https://testserver')
    for _ in range(5):
        assert register(guest, email='admin@courseforge.test').status_code == 201
    r = register(guest)
    assert r.status_code == 429 and r.headers.get('retry-after')
    with db.connect() as conn:
        assert conn.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 1


def test_modes_require_explicit_open_access(academy_env, monkeypatch):
    guest = TestClient(main.app, base_url='https://testserver')
    for mode in ('invite', 'mistyped-value'):
        monkeypatch.setenv('REGISTRATION_MODE', mode)
        assert not guest.get('/api/public/account-options').json()['registration_enabled']
        assert register(guest).status_code == 403
    monkeypatch.delenv('REGISTRATION_MODE')
    monkeypatch.delenv('SMTP_HOST')
    assert register(guest).status_code == 503
    with db.connect() as conn:
        assert conn.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 1


def test_registration_rotates_session_and_admin_recovery_works_without_mail(academy_env, monkeypatch):
    _, _, admin, student, _ = academy_env
    client, previous = student()
    old_session = client.get('/api/me').json()['session_id']
    note = client.post('/api/videos/lecture/notes', json={'content':'Private note', 'position':5}).json()
    open_registration(monkeypatch)
    r = register(client)
    assert r.status_code == 201, r.text
    user = r.json()['user']; client.headers['x-csrf-token'] = r.json()['csrf_token']
    assert client.get('/api/me').json()['user']['id'] == user['id']
    with db.connect() as conn:
        assert not conn.execute('SELECT 1 FROM auth_sessions WHERE id=?', (old_session,)).fetchone()
    assert client.post('/api/courses/SQL/enroll', json={}).status_code == 201
    assert client.get('/api/videos/lecture/notes').json()['notes'] == []
    assert client.delete('/api/notes/'+note['id']).status_code == 404
    assert admin.get('/api/admin/users/'+previous['id']).json()['note_count'] == 1
    guest = TestClient(main.app, base_url='https://testserver')
    assert guest.post('/api/auth/forgot', json={'email':user['email']}).status_code == 503
    recovery = admin.post('/api/admin/users/'+user['id']+'/account-link', json={}).json()
    token = link_token(recovery['account_url'])
    assert guest.post('/api/auth/reset', json={'token':token, 'password':PASSWORD+' reset'}).status_code == 200
    assert client.get('/api/me').status_code == 401
    assert guest.post('/api/auth/login', json={'email':user['email'], 'password':PASSWORD+' reset'}).status_code == 200

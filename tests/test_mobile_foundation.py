from tests.test_academy import academy_env


def test_bootstrap_is_private_and_enrollment_scoped(academy_env):
    _, _, admin, student, _ = academy_env
    client, user = student()
    response = client.get('/api/me/bootstrap', headers={'accept-encoding': 'gzip'})
    assert response.status_code == 200
    data = response.json()
    assert data['user']['id'] == user['id']
    assert [v['id'] for v in data['videos']] == ['lecture']
    assert [c['id'] for c in data['courses']] == ['SQL']
    assert 'path' not in data['videos'][0]
    assert 'stream_url' not in data['videos'][0]
    assert response.headers['cache-control'] == 'no-store'
    assert response.headers['content-encoding'] == 'gzip'
    client.cookies.clear()
    assert client.get('/api/me/bootstrap').status_code == 401


def test_static_page_is_compressed_without_changing_media_delivery(academy_env):
    _, _, admin, _, _ = academy_env
    response = admin.get('/static/core.js', headers={'accept-encoding': 'gzip'})
    assert response.status_code == 200
    assert response.headers['content-encoding'] == 'gzip'
    assert response.text.startswith('/* services.js */')

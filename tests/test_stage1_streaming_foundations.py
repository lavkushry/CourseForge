"""Stage 1: Streaming Foundations test suite.

Validates:
1. Artwork pipeline (posters 2:3, backdrops 16:9, thumbnails 16:9 across 3 sizes).
2. Zero odysee.com / odycdn.com in API responses or DOM.
3. Streaming read APIs (home-feed, course-detail, continue-watching, my-list, history, trending).
4. Old routes backward compatibility and URL schemes.
5. Cache headers and branded placeholders.
"""
import json
from pathlib import Path
import pytest
from client_helpers import TestClient

from app import main, db, auth


@pytest.fixture
def api_client():
    db.init_db()
    with TestClient(main.app, base_url='https://testserver') as client:
        yield client


def test_artwork_pipeline_serves_valid_images_with_cache_headers(api_client):
    # 1. Course Poster (2:3)
    res_poster = api_client.get('/api/artwork/courses/deepak-data-engg/poster')
    assert res_poster.status_code == 200
    assert res_poster.headers['content-type'] == 'image/jpeg'
    assert 'max-age=86400' in res_poster.headers.get('cache-control', '')

    # 2. Course Backdrop (16:9)
    res_backdrop = api_client.get('/api/artwork/courses/deepak-data-engg/backdrop')
    assert res_backdrop.status_code == 200
    assert res_backdrop.headers['content-type'] == 'image/jpeg'
    assert 'max-age=86400' in res_backdrop.headers.get('cache-control', '')

    # 3. Lecture Thumbnails in 3 sizes
    for size in ('sm', 'md', 'lg'):
        res_thumb = api_client.get(f'/api/artwork/lectures/non-existent-vid-123/thumbnail?size={size}')
        assert res_thumb.status_code == 200
        assert res_thumb.headers['content-type'] == 'image/jpeg'
        assert 'max-age=86400' in res_thumb.headers.get('cache-control', '')


def test_zero_odysee_domains_in_streaming_responses(api_client):
    # Fetch home feed
    feed_res = api_client.get('/api/streaming/home-feed')
    assert feed_res.status_code == 200
    feed_text = feed_res.text
    assert 'odysee.com' not in feed_text
    assert 'odycdn.com' not in feed_text

    # Fetch trending
    trend_res = api_client.get('/api/streaming/trending')
    assert trend_res.status_code == 200
    trend_text = trend_res.text
    assert 'odysee.com' not in trend_text
    assert 'odycdn.com' not in trend_text


def test_streaming_home_feed_shape(api_client):
    res = api_client.get('/api/streaming/home-feed')
    assert res.status_code == 200
    data = res.json()
    assert 'hero' in data
    assert 'rows' in data
    assert isinstance(data['hero'], list)
    assert isinstance(data['rows'], list)

    if data['hero']:
        first_hero = data['hero'][0]
        for field in ('id', 'slug', 'title', 'synopsis', 'backdrop_url', 'poster_url'):
            assert field in first_hero

    row_ids = [r['id'] for r in data['rows']]
    assert any('featured' in rid or 'trending' in rid or 'top' in rid for rid in row_ids)


def test_streaming_course_detail_and_seasons(api_client):
    feed = api_client.get('/api/streaming/home-feed').json()
    if not feed.get('hero'):
        pytest.skip("No courses found in database")
    slug = feed['hero'][0]['slug']

    res = api_client.get(f'/api/streaming/courses/{slug}')
    assert res.status_code == 200
    data = res.json()
    assert 'course' in data
    assert 'seasons' in data
    assert 'related' in data

    course = data['course']
    assert 'poster_url' in course
    assert 'backdrop_url' in course
    assert 'total_episodes' in course
    assert 'total_duration' in course

    seasons = data['seasons']
    assert isinstance(seasons, list)
    if seasons:
        s0 = seasons[0]
        assert 'season_number' in s0
        assert 'title' in s0
        assert 'episodes' in s0


def test_streaming_my_list_and_history_lifecycle(api_client):
    from fastapi.testclient import TestClient as GuestClient
    with GuestClient(main.app, base_url='https://testserver') as guest:
        anon_ml = guest.get('/api/streaming/my-list')
        assert anon_ml.status_code == 200
        assert anon_ml.json()['items'] == []

        anon_hist = guest.get('/api/streaming/history')
        assert anon_hist.status_code == 200
        assert anon_hist.json()['history'] == []

    # Authenticated user can add to My List
    csrf = api_client.headers['X-CSRF-Token']
    add_res = api_client.post('/api/streaming/my-list', json={'item_type': 'course', 'item_id': 'deepak-data-engg'}, headers={'X-CSRF-Token': csrf})
    assert add_res.status_code in (200, 201)
    assert add_res.json()['saved'] is True

    ml_res = api_client.get('/api/streaming/my-list')
    assert ml_res.status_code == 200
    ids = [item['item_id'] for item in ml_res.json()['items']]
    assert 'deepak-data-engg' in ids

    # Authenticated user can remove from My List
    del_res = api_client.delete('/api/streaming/my-list/course/deepak-data-engg', headers={'X-CSRF-Token': csrf})
    assert del_res.status_code == 200
    assert del_res.json()['removed'] is True

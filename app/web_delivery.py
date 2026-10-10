"""Compress the page and small JSON responses without buffering video streams."""
from starlette.middleware.gzip import GZipMiddleware


class PageCompression:
    def __init__(self, app):
        self.app = app
        self.compressed = GZipMiddleware(app, minimum_size=500, compresslevel=6)

    async def __call__(self, scope, receive, send):
        path = scope.get('path', '')
        use = scope['type'] == 'http' and (
            path == '/' or path.startswith('/static/') or path == '/api/me/bootstrap')
        await (self.compressed if use else self.app)(scope, receive, send)

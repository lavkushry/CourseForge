// Exercise the actual dev proxy against distinct, ephemeral API/media upstreams.
// Only synthetic headers reach these fixtures; reports omit their values.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from 'vite';

const upstreams = [];
let vite;
try {
  for (const label of ['api', 'media']) {
    const upstream = http.createServer((request, response) => {
      response.setHeader('X-Probe-Upstream', label);
      response.setHeader('X-Range-Preserved', String(request.headers.range === 'bytes=0-15'));
      response.setHeader('X-Cookie-Preserved', String(request.headers.cookie === 'cf_session=synthetic'));
      response.setHeader('X-Csrf-Preserved', String(request.headers['x-csrf-token'] === 'synthetic-csrf'));
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ upstream: label }));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    upstreams.push(upstream);
  }
  process.env.COURSEFORGE_API_URL = `http://127.0.0.1:${upstreams[0].address().port}`;
  process.env.COURSEFORGE_MEDIA_URL = `http://127.0.0.1:${upstreams[1].address().port}`;
  vite = await createServer({ configFile: './vite.config.ts', server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'silent' });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const cases = [
    ['GET', '/api/v1/public/courses', 'api'],
    ['HEAD', '/api/v1/playback/sessions/synthetic/media?opaque=fixture', 'media'],
    ['GET', '/api/v1/playback/sessions/synthetic/media?opaque=fixture', 'media'],
    ['POST', '/api/v1/playback/sessions/synthetic/pulse', 'api'],
    ['GET', '/verify/synthetic-certificate', 'api'],
    ['GET', '/api/v1/certificates/verify/synthetic-certificate', 'api'],
  ];
  for (const [method, path, expected] of cases) {
    const response = await fetch(origin + path, { method, headers: { Range: 'bytes=0-15', Cookie: 'cf_session=synthetic', 'X-CSRF-Token': 'synthetic-csrf' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Probe-Upstream'), expected);
    for (const header of ['X-Range-Preserved', 'X-Cookie-Preserved', 'X-Csrf-Preserved']) assert.equal(response.headers.get(header), 'true');
    const body = await response.text();
    if (method === 'HEAD') assert.equal(body, '');
  }
  console.log(JSON.stringify({ status: 'passed', cases: cases.length, scope: 'actual Vite API/media/certificate routing, HEAD and Range/cookie/CSRF forwarding against isolated fixtures' }));
} finally {
  await vite?.close();
  await Promise.all(upstreams.map(server => new Promise(resolve => server.close(resolve))));
}

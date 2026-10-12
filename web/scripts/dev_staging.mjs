// A named, read-only guarded launch for the local synthetic rewrite stack.
// URLs are fixed here so an inherited environment cannot point this command at
// production. Generic `npm run dev` retains its normal development defaults.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const api = 'http://127.0.0.1:18090';
const media = 'http://127.0.0.1:18094';
const simulator = 'http://127.0.0.1:18092';
try {
  const ready = await Promise.allSettled([[api + '/health/ready', 'GET'], [media + '/health/ready', 'GET'], [simulator + '/healthz', 'GET'], [simulator + '/media.mp4', 'HEAD']].map(async ([url, method]) => {
    const response = await fetch(url, { method, signal: AbortSignal.timeout(5000) });
    if (response.status !== 200) throw new Error('not ready');
  }));
  if (ready.some(result => result.status !== 'fulfilled')) throw new Error('The isolated Go API18090, media18094 and media simulator18092 must all be ready. Start the synthetic rewrite stack first.');
  const response = await fetch(api + '/api/v1/public/courses/fixture-course', { signal: AbortSignal.timeout(5000) });
  if (response.status !== 200) throw new Error('Synthetic course fixture guard failed. No browser server was started.');
  const fixture = await response.json();
  if (fixture?.course?.id !== 'fixture-course' || typeof fixture.course.description !== 'string' || !fixture.course.description.toLowerCase().includes('synthetic')) throw new Error('The API does not expose the expected synthetic staging fixture. No browser server was started.');
  if (process.argv.includes('--check')) {
    console.log('Isolated staging guard passed: API18090, media18094, simulator18092 and the synthetic course fixture are ready. No writes performed.');
  } else {
    process.env.COURSEFORGE_API_URL = api;
    process.env.COURSEFORGE_MEDIA_URL = media;
    const server = await createServer({ configFile: './vite.config.ts', server: { host: '127.0.0.1', port: 5173, strictPort: true } });
    await server.listen(); server.printUrls();
    console.log('Staging API ->127.0.0.1:18090; media ->127.0.0.1:18094.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void server.close().then(() => process.exit(0)); });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Isolated staging launch failed.');
  process.exitCode = 1;
}

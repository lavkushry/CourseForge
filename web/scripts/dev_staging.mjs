// A named, read-only guarded launch for the local synthetic rewrite stack.
// URLs are fixed here so an inherited environment cannot point this command at
// production. Generic `npm run dev` retains its normal development defaults.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const api = process.env.COURSEFORGE_API_URL || 'http://127.0.0.1:18090';
const media = process.env.COURSEFORGE_MEDIA_URL || 'http://127.0.0.1:18094';
const simulator = process.env.COURSEFORGE_MEDIA_SIMULATOR_URL || 'http://127.0.0.1:18092';
try {
  const ready = await Promise.allSettled(
    [
      [api + '/health/ready', 'GET'],
      [media + '/health/ready', 'GET'],
      [simulator + '/healthz', 'GET'],
      [simulator + '/media.mp4', 'HEAD'],
    ].map(async ([url, method]) => {
      const response = await fetch(url, { method, signal: AbortSignal.timeout(5000) });
      if (response.status !== 200) throw new Error('not ready');
    }),
  );
  if (ready.some(result => result.status !== 'fulfilled'))
    throw new Error(
      'The Go API (), media () and simulator () must all be ready.',
    );
  const response = await fetch(api + '/api/v1/public/courses/fixture-course', { signal: AbortSignal.timeout(5000) });
  if (response.status !== 200) throw new Error('Synthetic course fixture guard failed. No browser server was started.');
  const fixture = await response.json();
  if (
    fixture?.course?.id !== 'fixture-course' ||
    typeof fixture.course.description !== 'string' ||
    !fixture.course.description.toLowerCase().includes('synthetic')
  )
    throw new Error('The API does not expose the expected synthetic staging fixture. No browser server was started.');
  const catalog = await fetch(api + '/api/v1/public/courses?limit=100', { signal: AbortSignal.timeout(5000) }).then(
    response => response.json(),
  );
  if (
    !Array.isArray(catalog?.courses) ||
    catalog.next_cursor ||
    process.env.COURSEFORGE_STRICT_FIXTURE_ONLY === 'true' && catalog.courses.some(course => !['fixture-course', 'fixture-other'].includes(course.id))
  )
    throw new Error('Synthetic staging contains nonfixture courses. Refusing browser test launch.');
  if (process.argv.includes('--check')) {
    console.log(
      `Isolated staging guard passed: API (), media (), simulator () are ready.`,
    );
  } else {
    process.env.COURSEFORGE_API_URL = api;
    process.env.COURSEFORGE_MEDIA_URL = media;
    const server = await createServer({
      configFile: './vite.config.ts',
      server: { host: '127.0.0.1', port: 5173, strictPort: true },
    });
    await server.listen();
    server.printUrls();
    console.log(`Staging API -> ; media -> .`);
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.once(signal, () => {
        void server.close().then(() => process.exit(0));
      });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Isolated staging launch failed.');
  process.exitCode = 1;
}

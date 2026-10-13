import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/test-results*/**', '**/playwright-report/**', '**/.playwright-cli/**', '**/evidence/**'] },
    proxy: {
      '^/api/v1/playback/sessions/[^/]+/media(?:\\?|$)': { target: process.env.COURSEFORGE_MEDIA_URL || 'http://127.0.0.1:18194' },
      '/api': { target: process.env.COURSEFORGE_API_URL || 'http://127.0.0.1:18190' },
      '/verify/': { target: process.env.COURSEFORGE_API_URL || 'http://127.0.0.1:18190' },
      '/media': { target: process.env.COURSEFORGE_MEDIA_URL || 'http://127.0.0.1:18194' },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('media-chrome')) {
            return 'media-chrome';
          }
        },
      },
    },
  },
});

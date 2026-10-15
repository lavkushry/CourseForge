import { ApiError, errorMessage } from '../api';
import { required } from '../components';
import { installBindings } from './bindings';
import { installClassroom } from './classroom';
import { createBaseContext } from './context';
import { installFeatureBootstraps } from './features/bootstrap';
import { installRouter } from './router';
import { installShell } from './shell';

function clearStaleServiceWorkers(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker
    .getRegistrations()
    .then(regs => {
      for (const r of regs) r.unregister();
    })
    .catch(() => {});
  if ('caches' in window) {
    caches
      .keys()
      .then(keys => {
        for (const k of keys) {
          if (k.startsWith('courseforge')) caches.delete(k);
        }
      })
      .catch(() => {});
  }
}

export function createApp() {
  clearStaleServiceWorkers();
  const app = required<HTMLElement>('#app');
  const ctx = createBaseContext(app);
  installRouter(ctx);
  installShell(ctx);
  installFeatureBootstraps(ctx);
  installBindings(ctx);
  installClassroom(ctx);

  async function bootstrap(): Promise<void> {
    app.textContent = 'Opening CourseForge…';
    try {
      const auth = await ctx.api.me();
      ctx.renderApp(auth.user);
    } catch (error) {
      ctx.renderLogin(error instanceof ApiError && error.status === 401 ? '' : errorMessage(error));
    }
  }

  return { ctx, bootstrap };
}

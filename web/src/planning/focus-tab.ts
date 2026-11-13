import { errorMessage } from '../api';
import { remaining } from './contracts';
import type { PlanningHost } from './host';

function formatCountdown(totalSeconds: number): string {
  const secs = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

export function renderFocus(host: PlanningHost): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'planning-tab-content focus-timer-section';

  const h = document.createElement('h2');
  h.className = 'planning-heading';
  h.textContent = 'Focus timer';
  sec.append(h);

  const card = document.createElement('div');
  card.className = 'planning-card focus-card';

  const session = host.currentFocus;
  const active = session && (session.status === 'running' || session.status === 'paused');

  if (active && session) {
    const statusP = document.createElement('p');
    statusP.className = 'focus-status-display';
    const modeName = session.mode === 'focus' ? 'Focus' : 'Break';
    statusP.textContent = `${modeName} · ${session.status}${session.title ? ` · ${session.title}` : ''}`;
    card.append(statusP);

    const clockDisplay = document.createElement('div');
    clockDisplay.className = 'focus-digital-clock';
    clockDisplay.setAttribute('aria-live', 'polite');
    const paint = () => {
      const left = remaining(session, host.focusReceivedAt, Date.now());
      clockDisplay.textContent = formatCountdown(left);
    };
    paint();
    card.append(clockDisplay);

    if (session.status === 'running' && host.focusReceivedAt > 0) {
      const timer = window.setInterval(paint, 250);
      const stop = () => window.clearInterval(timer);
      sec.addEventListener('planning:dispose', stop, { once: true });
      // Clean up when the host re-renders and replaces this subtree.
      const observer = new MutationObserver(() => {
        if (!sec.isConnected) {
          stop();
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    const controlsRow = document.createElement('div');
    controlsRow.className = 'focus-actions-row';

    if (session.status === 'running') {
      const pauseBtn = document.createElement('button');
      pauseBtn.type = 'button';
      pauseBtn.className = 'button';
      pauseBtn.textContent = 'Pause';
      pauseBtn.onclick = async () => {
        const body = { action: 'pause' as const, expected_revision: session.revision };
        const key = host.commands.get(`focus:actions:${session.id}:pause`, body).key;
        try {
          const next = await host.planningApi.focusAction(session, 'pause', key, host.signal);
          host.noteFocusSnapshot(next);
          host.render();
        } catch (err) {
          host.statusMessage = errorMessage(err);
          host.render();
        }
      };
      controlsRow.append(pauseBtn);
    } else if (session.status === 'paused') {
      const resumeBtn = document.createElement('button');
      resumeBtn.type = 'button';
      resumeBtn.className = 'button primary';
      resumeBtn.textContent = 'Resume';
      resumeBtn.onclick = async () => {
        const body = { action: 'resume' as const, expected_revision: session.revision };
        const key = host.commands.get(`focus:actions:${session.id}:resume`, body).key;
        try {
          const next = await host.planningApi.focusAction(session, 'resume', key, host.signal);
          host.noteFocusSnapshot(next);
          host.render();
        } catch (err) {
          host.statusMessage = errorMessage(err);
          host.render();
        }
      };
      controlsRow.append(resumeBtn);
    }

    const finishBtn = document.createElement('button');
    finishBtn.type = 'button';
    finishBtn.className = 'button';
    finishBtn.textContent = 'Finish session';
    finishBtn.onclick = async () => {
      const body = { action: 'finish' as const, expected_revision: session.revision };
      const key = host.commands.get(`focus:actions:${session.id}:finish`, body).key;
      try {
        await host.planningApi.focusAction(session, 'finish', key, host.signal);
        host.noteFocusSnapshot(null);
        host.render();
      } catch (err) {
        host.statusMessage = errorMessage(err);
        host.render();
      }
    };
    controlsRow.append(finishBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'button quiet';
    cancelBtn.textContent = 'Cancel session';
    cancelBtn.onclick = async () => {
      const body = { action: 'cancel' as const, expected_revision: session.revision };
      const key = host.commands.get(`focus:actions:${session.id}:cancel`, body).key;
      try {
        await host.planningApi.focusAction(session, 'cancel', key, host.signal);
        host.noteFocusSnapshot(null);
        host.render();
      } catch (err) {
        host.statusMessage = errorMessage(err);
        host.render();
      }
    };
    controlsRow.append(cancelBtn);

    card.append(controlsRow);
  } else {
    const clockDisplay = document.createElement('div');
    clockDisplay.className = 'focus-digital-clock';
    clockDisplay.textContent = `${String(host.focusDurationMinutes).padStart(2, '0')}:00`;
    const emptyP = document.createElement('p');
    emptyP.className = 'muted no-active-timer-msg';
    emptyP.textContent = 'No active timer — start a measured focus session below.';
    card.append(clockDisplay, emptyP);
  }

  const curLesson = host.hooks.currentLesson?.();
  if (curLesson) {
    const linkLessonBtn = document.createElement('button');
    linkLessonBtn.type = 'button';
    linkLessonBtn.className = 'button quiet';
    linkLessonBtn.textContent = 'Focus on current lesson';
    linkLessonBtn.onclick = () => {
      host.focusLessonId = curLesson.id;
      host.focusTitle = curLesson.title;
      host.statusMessage = `Linked to lesson: ${curLesson.title}`;
      host.render();
    };
    card.append(linkLessonBtn);
  }

  const startRow = document.createElement('div');
  startRow.className = 'focus-start-row';

  const durLabel = document.createElement('label');
  durLabel.htmlFor = 'focus-duration';
  durLabel.textContent = 'Duration minutes';

  const durInput = document.createElement('input');
  durInput.id = 'focus-duration';
  durInput.type = 'number';
  durInput.min = '1';
  durInput.max = '120';
  durInput.value = String(host.focusDurationMinutes);
  durInput.oninput = () => {
    host.focusDurationMinutes = Number(durInput.value || 25);
  };

  const startBtn = document.createElement('button');
  startBtn.type = 'button';
  startBtn.className = 'button primary';
  startBtn.textContent = 'Start timer';
  startBtn.disabled = Boolean(active);
  startBtn.onclick = async () => {
    const mins = Number(durInput.value || 25);
    const body: { mode: 'focus'; duration_minutes: number; title: string; lesson_id?: string } = {
      mode: 'focus',
      duration_minutes: mins,
      title: host.focusTitle,
    };
    if (host.focusLessonId) {
      body.lesson_id = host.focusLessonId;
    }
    const key = host.commands.get('focus:sessions', body).key;
    try {
      const next = await host.planningApi.start(body, key, host.signal);
      host.noteFocusSnapshot(next);
      host.statusMessage = '';
      host.render();
    } catch (err) {
      host.statusMessage = errorMessage(err);
      host.render();
    }
  };

  startRow.append(durLabel, durInput, startBtn);
  card.append(startRow);
  sec.append(card);

  return sec;
}

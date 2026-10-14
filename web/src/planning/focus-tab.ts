import { errorMessage } from '../api';
import type { PlanningHost } from './host';

export function renderFocus(host: PlanningHost): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'planning-tab-content focus-timer-section';

  const h = document.createElement('h2');
  h.className = 'planning-heading';
  h.textContent = 'Focus timer';
  sec.append(h);

  const card = document.createElement('div');
  card.className = 'planning-card focus-card';

  if (host.currentFocus && (host.currentFocus.status === 'running' || host.currentFocus.status === 'paused')) {
    const statusP = document.createElement('p');
    statusP.className = 'focus-status-display';
    const modeName = host.currentFocus.mode === 'focus' ? 'Focus' : 'Break';
    statusP.textContent = `${modeName} · ${host.currentFocus.status}`;
    card.append(statusP);

    const controlsRow = document.createElement('div');
    controlsRow.className = 'focus-actions-row';

    if (host.currentFocus.status === 'running') {
      const pauseBtn = document.createElement('button');
      pauseBtn.type = 'button';
      pauseBtn.className = 'button';
      pauseBtn.textContent = 'Pause';
      pauseBtn.onclick = async () => {
        const body = { action: 'pause' as const, expected_revision: host.currentFocus!.revision };
        const key = host.commands.get(`focus:actions:${host.currentFocus!.id}:pause`, body).key;
        try {
          host.currentFocus = await host.planningApi.focusAction(host.currentFocus!, 'pause', key, host.signal);
          host.render();
        } catch (err) {
          host.statusMessage = errorMessage(err);
          host.render();
        }
      };
      controlsRow.append(pauseBtn);
    } else if (host.currentFocus.status === 'paused') {
      const resumeBtn = document.createElement('button');
      resumeBtn.type = 'button';
      resumeBtn.className = 'button primary';
      resumeBtn.textContent = 'Resume';
      resumeBtn.onclick = async () => {
        const body = { action: 'resume' as const, expected_revision: host.currentFocus!.revision };
        const key = host.commands.get(`focus:actions:${host.currentFocus!.id}:resume`, body).key;
        try {
          host.currentFocus = await host.planningApi.focusAction(host.currentFocus!, 'resume', key, host.signal);
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
      const body = { action: 'finish' as const, expected_revision: host.currentFocus!.revision };
      const key = host.commands.get(`focus:actions:${host.currentFocus!.id}:finish`, body).key;
      try {
        await host.planningApi.focusAction(host.currentFocus!, 'finish', key, host.signal);
        host.currentFocus = null;
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
      const body = { action: 'cancel' as const, expected_revision: host.currentFocus!.revision };
      const key = host.commands.get(`focus:actions:${host.currentFocus!.id}:cancel`, body).key;
      try {
        await host.planningApi.focusAction(host.currentFocus!, 'cancel', key, host.signal);
        host.currentFocus = null;
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
    emptyP.textContent = 'No active timer';
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
      host.currentFocus = await host.planningApi.start(body, key, host.signal);
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

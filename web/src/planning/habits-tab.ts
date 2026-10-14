import { errorMessage } from '../api';
import type { PlanningHost } from './host';

export function renderHabits(host: PlanningHost): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'planning-tab-content habits-section';

  const h = document.createElement('h2');
  h.className = 'planning-heading';
  h.textContent = 'Habits & Insights';
  sec.append(h);

  const card = document.createElement('div');
  card.className = 'planning-card habits-card';

  const tzLabel = document.createElement('label');
  tzLabel.htmlFor = 'habit-timezone';
  tzLabel.textContent = 'Learning timezone';

  const tzInput = document.createElement('input');
  tzInput.id = 'habit-timezone';
  tzInput.type = 'text';
  tzInput.value = host.currentHabits?.preferences.timezone || 'UTC';
  if (host.currentHabits?.timezone_anchored) {
    tzInput.disabled = true;
  }

  const goalLabel = document.createElement('label');
  goalLabel.htmlFor = 'habit-goal';
  goalLabel.textContent = 'Daily habit goal';

  const goalSelect = document.createElement('select');
  goalSelect.id = 'habit-goal';
  const optMin = document.createElement('option');
  optMin.value = 'minutes';
  optMin.textContent = 'minutes';
  const optLes = document.createElement('option');
  optLes.value = 'lesson';
  optLes.textContent = 'lesson';
  goalSelect.append(optMin, optLes);
  goalSelect.value = host.currentHabits?.preferences.goal || 'minutes';

  const remLabel = document.createElement('label');
  remLabel.htmlFor = 'habit-reminder';
  remLabel.textContent = 'Send a weekly learning reminder';

  const remCheck = document.createElement('input');
  remCheck.id = 'habit-reminder';
  remCheck.type = 'checkbox';
  remCheck.checked = Boolean(host.currentHabits?.preferences.reminder_email);

  const saveHabitsBtn = document.createElement('button');
  saveHabitsBtn.type = 'button';
  saveHabitsBtn.className = 'button primary';
  saveHabitsBtn.textContent = 'Save habit preferences';
  saveHabitsBtn.onclick = async () => {
    const tz = tzInput.value || 'UTC';
    const goal = goalSelect.value as 'minutes' | 'lesson';
    const reminder = remCheck.checked;
    const body = {
      goal,
      timezone: tz,
      reminder_email: reminder,
    };
    const key = host.commands.get('me:habit-preferences', body).key;
    try {
      host.currentHabits = await host.planningApi.saveHabits(body, key, host.signal);
      host.render();
    } catch (err) {
      host.statusMessage = errorMessage(err);
      host.render();
    }
  };

  card.append(tzLabel, tzInput, goalLabel, goalSelect, remLabel, remCheck, saveHabitsBtn);

  if (host.currentHabits && !host.currentHabits.reminder_delivery_available && host.currentHabits.preferences.reminder_email) {
    const warn = document.createElement('p');
    warn.className = 'habit-warning-text';
    warn.textContent = 'Delivery is not available at this time.';
    card.append(warn);
  }

  if (host.currentHabits) {
    const todayM = Math.floor(host.currentHabits.today.watched_seconds / 60);
    const weekM = Math.floor(host.currentHabits.week.watched_seconds / 60);
    const tP = document.createElement('p');
    tP.textContent = `${todayM} watched minutes`;
    const wP = document.createElement('p');
    wP.textContent = `${weekM} watched minutes`;
    card.append(tP, wP);
  }

  const recallBtn = document.createElement('button');
  recallBtn.type = 'button';
  recallBtn.className = 'button quiet';
  recallBtn.textContent = 'Recall insights';
  recallBtn.onclick = async () => {
    try {
      host.currentInsights = await host.planningApi.insights(host.signal);
      host.render();
    } catch (err) {
      host.statusMessage = errorMessage(err);
      host.render();
    }
  };
  card.append(recallBtn);

  if (host.currentInsights) {
    const p = document.createElement('p');
    p.className = 'insights-display';
    if (host.currentInsights.mastery_signal_percent === null) {
      p.textContent = 'No recall signal yet.';
    } else {
      p.textContent = `Mastery signal: ${host.currentInsights.mastery_signal_percent}%`;
    }
    card.append(p);
  }

  sec.append(card);
  return sec;
}

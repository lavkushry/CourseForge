import { el } from '../components';
import { errorMessage, isAbort } from '../api';
import type { CareerStudioHost } from './view-host';

export function renderAlerts(host: CareerStudioHost): HTMLElement {
  const panel = el('section', 'career-panel');
  panel.append(
    el('h2', '', 'Apply-early alerts'),
    el(
      'p',
      'muted',
      'Register Greenhouse, Lever, or Ashby boards. A worker polls with ETag/dedupe and creates in-app notifications only — never emails or messages.',
    ),
  );

  const form = el('form', 'career-form') as HTMLFormElement;
  const provider = el('select', '') as HTMLSelectElement;
  for (const [value, label] of [
    ['greenhouse', 'Greenhouse'],
    ['lever', 'Lever'],
    ['ashby', 'Ashby'],
  ] as const) {
    const opt = el('option', '', label) as HTMLOptionElement;
    opt.value = value;
    provider.append(opt);
  }
  const token = el('input', '') as HTMLInputElement;
  token.placeholder = 'Board token / company slug';
  token.required = true;
  token.maxLength = 120;
  const label = el('input', '') as HTMLInputElement;
  label.placeholder = 'Label (optional)';
  label.maxLength = 120;
  const keywords = el('input', '') as HTMLInputElement;
  keywords.placeholder = 'Extra keywords, comma-separated';
  const track = el('select', '') as HTMLSelectElement;
  const none = el('option', '', 'Match track (optional)') as HTMLOptionElement;
  none.value = '';
  track.append(none);
  for (const t of host.tracks) {
    const opt = el('option', '', t.title) as HTMLOptionElement;
    opt.value = t.id;
    if (t.id === host.selectedTrackId) opt.selected = true;
    track.append(opt);
  }
  const submit = el('button', 'button primary', 'Watch board') as HTMLButtonElement;
  submit.type = 'submit';
  form.append(provider, token, label, track, keywords, submit);
  form.addEventListener('submit', ev => {
    ev.preventDefault();
    void createSource(host, {
      provider: provider.value,
      board_token: token.value,
      label: label.value,
      track_id: track.value,
      keywords: keywords.value
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
    });
  });
  panel.append(form);

  const list = el('div', 'career-alert-list');
  if (!host.alertSources.length) {
    list.append(el('p', 'muted', 'No boards registered yet.'));
  }
  for (const src of host.alertSources) {
    const card = el('div', 'career-fact-card');
    card.append(el('strong', '', src.label || `${src.provider}:${src.board_token}`));
    card.append(
      el('p', 'muted', `${src.provider} · ${src.board_token}${src.track_id ? ` · track ${src.track_id}` : ''}`),
    );
    if (src.keywords.length) {
      card.append(el('p', 'muted', `Keywords: ${src.keywords.join(', ')}`));
    }
    if (src.last_error) {
      card.append(el('p', 'career-warn', `Last poll error: ${src.last_error}`));
    }
    const del = el('button', 'button', 'Remove') as HTMLButtonElement;
    del.type = 'button';
    del.addEventListener('click', () => void deleteSource(host, src.id));
    card.append(del);
    list.append(card);
  }
  panel.append(list);

  const notifHead = el('div', 'career-app-row');
  notifHead.append(el('h3', '', 'In-app notifications'));
  const markAll = el('button', 'button', 'Mark all read') as HTMLButtonElement;
  markAll.type = 'button';
  markAll.disabled = !host.notifications.some(n => !n.read_at);
  markAll.addEventListener('click', () => void markAllRead(host));
  notifHead.append(markAll);
  panel.append(notifHead);

  const notifs = el('div', 'career-alert-list');
  if (!host.notifications.length) {
    notifs.append(el('p', 'muted', 'No openings matched yet.'));
  }
  for (const n of host.notifications) {
    const card = el('div', `career-fact-card${n.read_at ? '' : ' career-notif-unread'}`);
    card.append(el('strong', '', n.title));
    card.append(el('p', '', n.body));
    if (n.href) {
      const link = el('a', 'career-bridge-link', 'Open posting') as HTMLAnchorElement;
      link.href = n.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      card.append(link);
    }
    if (!n.read_at) {
      const readBtn = el('button', 'button', 'Mark read') as HTMLButtonElement;
      readBtn.type = 'button';
      readBtn.addEventListener('click', () => void markRead(host, n.id));
      card.append(readBtn);
    }
    notifs.append(card);
  }
  panel.append(notifs);
  return panel;
}

async function createSource(
  host: CareerStudioHost,
  input: {
    provider: string;
    board_token: string;
    label: string;
    track_id: string;
    keywords: string[];
  },
): Promise<void> {
  if (host.busy) return;
  host.busy = true;
  try {
    await host.career.createAlertSource(
      {
        provider: input.provider,
        board_token: input.board_token.trim(),
        label: input.label.trim(),
        ...(input.track_id ? { track_id: input.track_id } : {}),
        keywords: input.keywords,
        poll_interval_seconds: 900,
      },
      host.signal ?? undefined,
    );
    host.options.feedback('Careers board registered for apply-early alerts');
    await host.reload();
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  } finally {
    host.busy = false;
  }
}

async function deleteSource(host: CareerStudioHost, id: string): Promise<void> {
  if (host.busy) return;
  host.busy = true;
  try {
    await host.career.deleteAlertSource(id, host.signal ?? undefined);
    host.options.feedback('Alert source removed');
    await host.reload();
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  } finally {
    host.busy = false;
  }
}

async function markRead(host: CareerStudioHost, id: string): Promise<void> {
  try {
    await host.career.markNotificationRead(id, host.signal ?? undefined);
    await host.reload();
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  }
}

async function markAllRead(host: CareerStudioHost): Promise<void> {
  try {
    await host.career.markAllNotificationsRead(host.signal ?? undefined);
    await host.reload();
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  }
}

import { el } from '../components';
import type { CareerStudioHost } from './view-host';

export function renderTracks(host: CareerStudioHost): HTMLElement {
  const panel = el('section', 'career-panel');
  panel.append(
    el('h2', '', 'Role tracks'),
    el('p', 'muted', 'Section order and keyword weights for each target role.'),
  );
  const list = el('div', 'career-track-list');
  for (const track of host.tracks) {
    const btn = el(
      'button',
      `career-track-card${track.id === host.selectedTrackId ? ' active' : ''}`,
    ) as HTMLButtonElement;
    btn.type = 'button';
    btn.append(el('strong', '', track.title), el('span', 'muted', track.description));
    const order = el('p', 'career-chip-row');
    for (const section of track.section_order) {
      order.append(el('span', 'career-chip', section));
    }
    btn.append(order);
    btn.addEventListener('click', () => {
      host.selectedTrackId = track.id;
      host.match = null;
      host.render();
    });
    list.append(btn);
  }
  panel.append(list);
  const selected = host.tracks.find(t => t.id === host.selectedTrackId);
  if (selected) {
    const kw = el('div', 'career-keyword-block');
    kw.append(el('h3', '', `${selected.title} keywords`));
    for (const [category, items] of Object.entries(selected.keywords)) {
      const row = el('div', 'career-chip-row');
      row.append(el('span', 'career-cat', category));
      for (const item of items.slice(0, 12)) {
        row.append(el('span', 'career-chip', `${item.term} · ${item.weight}`));
      }
      kw.append(row);
    }
    panel.append(kw);
  }
  return panel;
}

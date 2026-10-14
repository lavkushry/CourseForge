import { formatKnowledgeClock } from './api';
import type { LessonKnowledge } from './types';
// Styles live in panel.css; import that stylesheet when mounting the panel.

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** Build a knowledge side panel. Not mounted by the player until a later step. */
export function renderKnowledgePanel(data: LessonKnowledge): HTMLElement {
  const root = el('section', 'knowledge-panel');
  root.setAttribute('aria-label', 'Living video knowledge');

  const header = el('div', 'knowledge-panel__header');
  header.append(el('h2', 'knowledge-panel__title', 'Knowledge'));
  const status = el('p', 'knowledge-panel__status', statusLabel(data.document.status));
  status.dataset.state = data.document.status;
  header.append(status);
  header.append(
    el(
      'p',
      'knowledge-panel__meta',
      `${data.document.segment_count} segments · ${data.document.keyframe_count} keyframes`,
    ),
  );
  root.append(header);

  const list = el('ul', 'knowledge-panel__list');
  for (const segment of data.segments) {
    const item = el('li', 'knowledge-panel__item');
    item.append(el('span', 'knowledge-panel__time', formatKnowledgeClock(segment.start_ms)));
    item.append(el('p', 'knowledge-panel__text', segment.text));
    list.append(item);
  }
  for (const keyframe of data.keyframes) {
    if (!keyframe.ocr?.text) continue;
    const item = el('li', 'knowledge-panel__item');
    item.append(el('span', 'knowledge-panel__time', formatKnowledgeClock(keyframe.time_ms)));
    const body = el('div');
    body.append(el('p', 'knowledge-panel__text', keyframe.ocr.text));
    if (keyframe.ocr.tags.length) {
      const tags = el('div', 'knowledge-panel__tags');
      for (const tag of keyframe.ocr.tags) {
        tags.append(el('span', 'knowledge-panel__tag', tag));
      }
      body.append(tags);
    }
    item.append(body);
    list.append(item);
  }
  root.append(list);
  return root;
}

function statusLabel(status: string): string {
  switch (status) {
    case 'ready':
      return 'Ready';
    case 'failed':
      return 'Unavailable';
    default:
      return 'Processing';
  }
}

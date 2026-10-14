import { clockToMs, formatKnowledgeClock } from './api';
import type { AskResponse, KnowledgeChapter, LessonKnowledge } from './types';
// Styles live in panel.css; import that stylesheet when mounting the panel.

export type KnowledgePanelOptions = {
  chapters?: KnowledgeChapter[];
  onSeek?: (ms: number) => void;
  onAsk?: (question: string) => Promise<AskResponse>;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** Build a knowledge side panel. Not mounted by the player until a later step. */
export function renderKnowledgePanel(data: LessonKnowledge, options: KnowledgePanelOptions = {}): HTMLElement {
  const root = el('section', 'knowledge-panel');
  root.setAttribute('aria-label', 'Living video knowledge');

  const header = el('div', 'knowledge-panel__header');
  header.append(el('h2', 'knowledge-panel__title', 'Knowledge'));
  const status = el('p', 'knowledge-panel__status', statusLabel(data.document.status));
  status.dataset.state = data.document.status;
  header.append(status);
  const chapterCount = options.chapters?.length ?? data.chapters?.length ?? data.document.chapter_count ?? 0;
  header.append(
    el(
      'p',
      'knowledge-panel__meta',
      `${chapterCount} chapters · ${data.document.segment_count} segments · ${data.document.keyframe_count} keyframes`,
    ),
  );
  root.append(header);

  const chapters = options.chapters ?? data.chapters ?? [];
  if (chapters.length) {
    root.append(renderChapters(chapters, options.onSeek));
  }

  root.append(renderAskBox(options.onAsk, options.onSeek));

  const list = el('ul', 'knowledge-panel__list');
  for (const segment of data.segments) {
    const item = el('li', 'knowledge-panel__item');
    item.append(seekTime(formatKnowledgeClock(segment.start_ms), segment.start_ms, options.onSeek));
    item.append(el('p', 'knowledge-panel__text', segment.text));
    list.append(item);
  }
  for (const keyframe of data.keyframes) {
    if (!keyframe.ocr?.text) continue;
    const item = el('li', 'knowledge-panel__item');
    item.append(seekTime(formatKnowledgeClock(keyframe.time_ms), keyframe.time_ms, options.onSeek));
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
  if (list.childElementCount) {
    root.append(list);
  }
  return root;
}

function renderChapters(chapters: KnowledgeChapter[], onSeek?: (ms: number) => void): HTMLElement {
  const section = el('div', 'knowledge-panel__chapters');
  section.append(el('h3', 'knowledge-panel__subtitle', 'Chapters'));
  const list = el('ul', 'knowledge-panel__chapter-list');
  for (const chapter of chapters) {
    const item = el('li', 'knowledge-panel__chapter');
    item.append(seekTime(formatKnowledgeClock(chapter.start_ms), chapter.start_ms, onSeek));
    const body = el('div');
    body.append(el('p', 'knowledge-panel__chapter-title', chapter.title));
    if (chapter.summary) {
      body.append(el('p', 'knowledge-panel__text', chapter.summary));
    }
    item.append(body);
    list.append(item);
  }
  section.append(list);
  return section;
}

function renderAskBox(onAsk?: (question: string) => Promise<AskResponse>, onSeek?: (ms: number) => void): HTMLElement {
  const section = el('div', 'knowledge-panel__ask');
  section.append(el('h3', 'knowledge-panel__subtitle', 'Ask the video'));
  const form = el('form', 'knowledge-panel__ask-form') as HTMLFormElement;
  const input = el('input', 'knowledge-panel__ask-input') as HTMLInputElement;
  input.type = 'text';
  input.name = 'question';
  input.placeholder = 'Ask about this lesson…';
  input.autocomplete = 'off';
  const submit = el('button', 'knowledge-panel__ask-submit', 'Ask') as HTMLButtonElement;
  submit.type = 'submit';
  form.append(input, submit);
  const answer = el('div', 'knowledge-panel__ask-answer');
  answer.hidden = true;
  form.addEventListener('submit', event => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question || !onAsk) return;
    submit.disabled = true;
    answer.hidden = false;
    answer.replaceChildren(el('p', 'knowledge-panel__text', 'Thinking…'));
    void onAsk(question)
      .then(response => {
        answer.replaceChildren(renderAskAnswer(response, onSeek));
      })
      .catch(() => {
        answer.replaceChildren(el('p', 'knowledge-panel__text', 'Ask failed. Try again.'));
      })
      .finally(() => {
        submit.disabled = false;
      });
  });
  section.append(form, answer);
  return section;
}

function renderAskAnswer(response: AskResponse, onSeek?: (ms: number) => void): HTMLElement {
  const wrap = el('div');
  wrap.append(renderAnswerWithCitations(response.answer, response.citations, onSeek));
  if (response.citations?.length) {
    const cites = el('ul', 'knowledge-panel__citations');
    for (const citation of response.citations) {
      const item = el('li', 'knowledge-panel__citation');
      item.append(seekTime(citation.label || formatKnowledgeClock(citation.start_ms), citation.start_ms, onSeek));
      item.append(el('span', 'knowledge-panel__text', citation.text));
      cites.append(item);
    }
    wrap.append(cites);
  }
  return wrap;
}

function renderAnswerWithCitations(
  answer: string,
  citations: AskResponse['citations'],
  onSeek?: (ms: number) => void,
): HTMLElement {
  const p = el('p', 'knowledge-panel__text');
  const byLabel = new Map((citations ?? []).map(c => [c.label || formatKnowledgeClock(c.start_ms), c] as const));
  const parts = answer.split(/(\[\d{1,2}:\d{2}\])/g);
  for (const part of parts) {
    const match = /^\[(\d{1,2}:\d{2})\]$/.exec(part);
    const label = match?.[1];
    if (!label) {
      p.append(document.createTextNode(part));
      continue;
    }
    const ms = byLabel.get(label)?.start_ms ?? clockToMs(label);
    p.append(seekTime(label, ms, onSeek, true));
  }
  return p;
}

function seekTime(label: string, ms: number, onSeek?: (ms: number) => void, bracket = false): HTMLElement {
  const node = el('button', 'knowledge-panel__time', bracket ? `[${label}]` : label);
  node.type = 'button';
  if (onSeek) {
    node.addEventListener('click', () => onSeek(ms));
  } else {
    node.disabled = true;
  }
  return node;
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

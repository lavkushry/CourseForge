import { clockToMs, formatKnowledgeClock } from './api';
import type {
  AskResponse,
  ConfusionHotspot,
  KnowledgeChapter,
  KnowledgeConcept,
  LessonKnowledge,
  RecallQuestion,
  ReviewQueueItem,
} from './types';
// Styles live in panel.css; import that stylesheet when mounting the panel.

export type KnowledgePanelOptions = {
  chapters?: KnowledgeChapter[];
  concepts?: KnowledgeConcept[];
  recall?: RecallQuestion[];
  reviewQueue?: ReviewQueueItem[];
  hotspots?: ConfusionHotspot[];
  isAdmin?: boolean;
  onSeek?: (ms: number) => void;
  onAsk?: (question: string) => Promise<AskResponse>;
  onReview?: (cardId: string, rating: number) => Promise<void>;
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

  if (options.recall?.length) {
    root.append(renderRecall(options.recall, options.onSeek));
  }
  if (options.reviewQueue?.length) {
    root.append(renderReviewQueue(options.reviewQueue, options.onReview, options.onSeek));
  }
  if (options.concepts?.length) {
    root.append(renderConcepts(options.concepts));
  }
  if (options.isAdmin && options.hotspots?.length) {
    root.append(renderHotspots(options.hotspots, options.onSeek));
  }

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

function renderRecall(questions: RecallQuestion[], onSeek?: (ms: number) => void): HTMLElement {
  const section = el('div', 'knowledge-panel__recall');
  section.append(el('h3', 'knowledge-panel__subtitle', 'Pause & recall'));
  const list = el('ul', 'knowledge-panel__list');
  for (const q of questions) {
    const item = el('li', 'knowledge-panel__item');
    item.append(seekTime(formatKnowledgeClock(q.segment_end_ms), q.segment_end_ms, onSeek));
    const body = el('div');
    body.append(el('p', 'knowledge-panel__text', q.prompt));
    if (q.answer) {
      const reveal = el('button', 'knowledge-panel__ask-submit', 'Reveal') as HTMLButtonElement;
      reveal.type = 'button';
      const answer = el('p', 'knowledge-panel__text', q.answer);
      answer.hidden = true;
      reveal.addEventListener('click', () => {
        answer.hidden = !answer.hidden;
        reveal.textContent = answer.hidden ? 'Reveal' : 'Hide';
      });
      body.append(reveal, answer);
    }
    item.append(body);
    list.append(item);
  }
  section.append(list);
  return section;
}

function renderReviewQueue(
  items: ReviewQueueItem[],
  onReview?: (cardId: string, rating: number) => Promise<void>,
  onSeek?: (ms: number) => void,
): HTMLElement {
  const section = el('div', 'knowledge-panel__review');
  section.append(el('h3', 'knowledge-panel__subtitle', 'Review queue'));
  const list = el('ul', 'knowledge-panel__list');
  for (const item of items) {
    const row = el('li', 'knowledge-panel__item');
    row.append(seekTime(formatKnowledgeClock(item.card.source_start_ms), item.card.source_start_ms, onSeek));
    const body = el('div');
    body.append(el('p', 'knowledge-panel__chapter-title', item.card.front));
    body.append(el('p', 'knowledge-panel__text', item.card.back));
    if (onReview) {
      const ratings = el('div', 'knowledge-panel__tags');
      for (const [label, rating] of [
        ['Again', 1],
        ['Hard', 2],
        ['Good', 3],
        ['Easy', 4],
      ] as const) {
        const btn = el('button', 'knowledge-panel__tag', label) as HTMLButtonElement;
        btn.type = 'button';
        btn.addEventListener('click', () => {
          void onReview(item.card.id, rating).then(() => row.remove());
        });
        ratings.append(btn);
      }
      body.append(ratings);
    }
    row.append(body);
    list.append(row);
  }
  section.append(list);
  return section;
}

function renderConcepts(concepts: KnowledgeConcept[]): HTMLElement {
  const section = el('div', 'knowledge-panel__concepts');
  section.append(el('h3', 'knowledge-panel__subtitle', 'Concepts'));
  const list = el('ul', 'knowledge-panel__list');
  for (const c of concepts) {
    const item = el('li', 'knowledge-panel__item');
    item.append(el('span', 'knowledge-panel__meta', String(c.ordinal + 1)));
    const body = el('div');
    body.append(el('p', 'knowledge-panel__chapter-title', c.title));
    if (c.summary) body.append(el('p', 'knowledge-panel__text', c.summary));
    item.append(body);
    list.append(item);
  }
  section.append(list);
  return section;
}

function renderHotspots(hotspots: ConfusionHotspot[], onSeek?: (ms: number) => void): HTMLElement {
  const section = el('div', 'knowledge-panel__hotspots');
  section.append(el('h3', 'knowledge-panel__subtitle', 'Confusion hotspots'));
  const list = el('ul', 'knowledge-panel__list');
  for (const h of hotspots) {
    const item = el('li', 'knowledge-panel__item');
    item.append(seekTime(formatKnowledgeClock(h.bucket_ms), h.bucket_ms, onSeek));
    const body = el('div');
    body.append(
      el(
        'p',
        'knowledge-panel__text',
        `Score ${h.score.toFixed(1)} · Q ${h.question_count} · rewind ${h.rewind_count} · drop ${h.dropoff_count} · quiz ${h.quiz_error_count}`,
      ),
    );
    for (const ann of h.annotations ?? []) {
      body.append(el('p', 'knowledge-panel__meta', `${ann.author_type}: ${ann.body}`));
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

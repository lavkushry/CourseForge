import type { ApiClient } from '../api';
import { errorMessage, isAbort } from '../api';
import { LearningApi } from '../learning/api';
import type { Card, Grade } from '../learning/contracts';
import { el, emptyState } from '../components';
import { panelSkeleton } from '../ui/skeleton';
import { reviewsEmptyCopy, reviewsLoadFailureCopy } from './status';

export interface ReviewsViewOptions {
  root: HTMLElement;
  api: ApiClient;
}

export class ReviewsView {
  private learningApi: LearningApi;
  private cards: Card[] = [];
  private activeCard: Card | null = null;
  private answerRevealed = false;
  private loading = false;
  private loadError: string | null = null;
  private loadSignal: AbortSignal | null = null;
  private gradeError: string | null = null;
  private lastSchedule: { grade: Grade; quality: number } | null = null;
  private completedToday = 0;

  constructor(private readonly options: ReviewsViewOptions) {
    this.learningApi = new LearningApi(options.api);
  }

  activate(signal: AbortSignal): void {
    this.options.root.hidden = false;
    this.loadSignal = signal;
    this.loading = true;
    this.loadError = null;
    this.gradeError = null;
    this.lastSchedule = null;
    this.render();

    void this.learningApi
      .cards('', true, signal)
      .then(res => {
        if (signal.aborted) return;
        this.cards = res.items;
        this.activeCard = this.cards[0] || null;
        this.answerRevealed = false;
        this.loading = false;
        this.loadError = null;
        this.render();
      })
      .catch(error => {
        if (signal.aborted || isAbort(error)) return;
        this.loading = false;
        this.cards = [];
        this.activeCard = null;
        this.loadError = errorMessage(error);
        this.render();
      });
  }

  deactivate(): void {
    this.options.root.hidden = true;
    this.options.root.replaceChildren();
  }

  render(): void {
    const root = this.options.root;
    root.replaceChildren();

    const pageHead = el('div', 'page-heading');
    pageHead.append(
      el('span', 'eyebrow', 'SPACED REPETITION WORKSPACE'),
      el('h1', '', 'Retain What You Learn'),
      el(
        'p',
        'muted',
        'Review due flashcards from your private SM-2 schedule. Empty means none are due — not a fabricated catch-up.',
      ),
    );
    root.append(pageHead);

    const container = el('div', 'reviews-container');

    if (this.loading) {
      container.append(panelSkeleton({ variant: 'panel', count: 2, label: 'Loading due review cards…' }));
      root.append(container);
      return;
    }

    if (this.loadError) {
      const retry = el('button', 'button primary');
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => {
        this.activate(this.loadSignal && !this.loadSignal.aborted ? this.loadSignal : new AbortController().signal);
      });
      const failure = reviewsLoadFailureCopy(this.loadError);
      container.append(
        emptyState({
          className: 'catalog-empty reviews-empty-card',
          icon: 'cards',
          title: failure.title,
          description: failure.description,
          action: retry,
        }),
      );
      root.append(container);
      return;
    }

    if (!this.activeCard) {
      const empty = reviewsEmptyCopy(this.completedToday);
      container.append(
        emptyState({
          className: 'catalog-empty reviews-empty-card',
          icon: 'party',
          title: empty.title,
          description: empty.description,
        }),
      );
      root.append(container);
      return;
    }

    if (this.gradeError) {
      container.append(el('p', 'planning-status-alert', this.gradeError));
    }
    if (this.lastSchedule) {
      const days = this.lastSchedule.grade.interval_days;
      container.append(
        el(
          'p',
          'muted review-schedule-note',
          `Last grade scheduled next review in ${days} day${days === 1 ? '' : 's'} (SM-2 quality ${this.lastSchedule.quality}).`,
        ),
      );
    }

    const cardEl = el('div', 'review-flashcard');
    const cardHeader = el('div', 'review-card-header');
    cardHeader.append(
      el('span', 'tag', `${this.cards.length} Due`),
      el('span', 'card-course-badge', this.activeCard.course_id || 'Concept Review'),
    );
    cardEl.append(cardHeader);

    const questionBox = el('div', 'review-question-box');
    questionBox.append(el('span', 'eyebrow', 'QUESTION'), el('h2', 'review-question-text', this.activeCard.question));
    cardEl.append(questionBox);

    if (!this.answerRevealed) {
      const revealBtn = el('button', 'button primary review-reveal-btn', 'Reveal Answer');
      revealBtn.type = 'button';
      revealBtn.addEventListener('click', () => {
        this.answerRevealed = true;
        this.gradeError = null;
        this.render();
      });
      cardEl.append(revealBtn);
    } else {
      const answerBox = el('div', 'review-answer-box');
      answerBox.append(el('span', 'eyebrow', 'VERIFIED ANSWER'), el('p', 'review-answer-text', this.activeCard.answer));
      cardEl.append(answerBox);

      const gradePrompt = el('p', 'grade-prompt', 'How well did you recall this concept?');
      const gradesRow = el('div', 'review-grades-row');

      // SM-2 quality 0–5 — labels map to measured schedule updates, never fabricated mastery.
      const grades: Array<{ label: string; score: number; cls: string }> = [
        { label: 'Blackout (0)', score: 0, cls: 'grade-again' },
        { label: 'Again (1)', score: 1, cls: 'grade-again' },
        { label: 'Hard (2)', score: 2, cls: 'grade-hard' },
        { label: 'Good (3)', score: 3, cls: 'grade-good' },
        { label: 'Easy (4)', score: 4, cls: 'grade-easy' },
        { label: 'Perfect (5)', score: 5, cls: 'grade-easy' },
      ];

      for (const g of grades) {
        const btn = el('button', `button ${g.cls}`, g.label);
        btn.type = 'button';
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            const graded = await this.learningApi.grade(
              this.activeCard!.id,
              { quality: g.score, expected_revision: this.activeCard!.revision },
              crypto.randomUUID(),
              this.loadSignal && !this.loadSignal.aborted
                ? this.loadSignal
                : new AbortController().signal,
            );
            this.lastSchedule = { grade: graded, quality: g.score };
            this.completedToday++;
            this.cards.shift();
            this.activeCard = this.cards[0] || null;
            this.answerRevealed = false;
            this.gradeError = null;
            this.render();
          } catch (err) {
            this.gradeError = errorMessage(err);
            this.render();
          }
        });
        gradesRow.append(btn);
      }

      cardEl.append(gradePrompt, gradesRow);
    }

    container.append(cardEl);
    root.append(container);
  }
}

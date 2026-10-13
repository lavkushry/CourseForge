import { svgIcon } from '../icons';
import { ApiClient, ApiError, errorMessage } from '../api';
import { LearningApi } from '../learning/api';
import type { Card } from '../learning/contracts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

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
  private completedToday = 0;

  constructor(private readonly options: ReviewsViewOptions) {
    this.learningApi = new LearningApi(options.api);
  }

  activate(signal: AbortSignal): void {
    this.options.root.hidden = false;
    this.loading = true;
    this.render();

    void this.learningApi.cards('', true, signal).then(res => {
      this.cards = res.items;
      this.activeCard = this.cards[0] || null;
      this.answerRevealed = false;
      this.loading = false;
      this.render();
    }).catch(() => {
      this.loading = false;
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
      el('p', 'muted', 'Review active concept flashcards with the SM-2 spaced repetition algorithm. Practice a few minutes daily to never forget.'),
    );
    root.append(pageHead);

    const container = el('div', 'reviews-container');

    if (this.loading) {
      container.append(el('p', 'muted', 'Loading due review cards…'));
      root.append(container);
      return;
    }

    if (!this.activeCard) {
      const emptyCard = el('div', 'catalog-empty reviews-empty-card');
      emptyCard.append(
        (() => { const s = el('span', 'empty-symbol'); s.append(svgIcon('party')); return s; })(),
        el('h2', '', 'You are all caught up!'),
        el('p', 'muted', `Reviewed ${this.completedToday} cards today. No more flashcards due right now. Complete quizzes in your lectures to schedule new concepts.`),
      );
      container.append(emptyCard);
      root.append(container);
      return;
    }

    // Flashcard Study Card
    const cardEl = el('div', 'review-flashcard');
    const cardHeader = el('div', 'review-card-header');
    cardHeader.append(
      el('span', 'tag', `${this.cards.length} Due`),
      el('span', 'card-course-badge', this.activeCard.course_id || 'Concept Review'),
    );
    cardEl.append(cardHeader);

    const questionBox = el('div', 'review-question-box');
    questionBox.append(
      el('span', 'eyebrow', 'QUESTION'),
      el('h2', 'review-question-text', this.activeCard.question),
    );
    cardEl.append(questionBox);

    if (!this.answerRevealed) {
      const revealBtn = el('button', 'button primary review-reveal-btn', 'Reveal Answer');
      revealBtn.type = 'button';
      revealBtn.addEventListener('click', () => {
        this.answerRevealed = true;
        this.render();
      });
      cardEl.append(revealBtn);
    } else {
      const answerBox = el('div', 'review-answer-box');
      answerBox.append(
        el('span', 'eyebrow', 'VERIFIED ANSWER'),
        el('p', 'review-answer-text', this.activeCard.answer),
      );
      cardEl.append(answerBox);

      // Recall Grading Buttons
      const gradePrompt = el('p', 'grade-prompt', 'How well did you recall this concept?');
      const gradesRow = el('div', 'review-grades-row');

      const grades: Array<{ label: string; score: number; cls: string }> = [
        { label: 'Again (1)', score: 1, cls: 'grade-again' },
        { label: 'Hard (2)', score: 2, cls: 'grade-hard' },
        { label: 'Good (3)', score: 3, cls: 'grade-good' },
        { label: 'Easy (4)', score: 4, cls: 'grade-easy' },
      ];

      for (const g of grades) {
        const btn = el('button', `button ${g.cls}`, g.label);
        btn.type = 'button';
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await this.learningApi.grade(
              this.activeCard!.id,
              { quality: g.score, expected_revision: this.activeCard!.revision },
              crypto.randomUUID(),
              new AbortController().signal,
            );
            this.completedToday++;
            this.cards.shift();
            this.activeCard = this.cards[0] || null;
            this.answerRevealed = false;
            this.render();
          } catch (err) {
            alert(errorMessage(err));
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

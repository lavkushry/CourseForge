import { ApiError, errorMessage, isAbort } from "../api";
import type { Lesson } from "../contracts";
import { formatTime } from "../player/controller";
import { Commands, LearningApi } from "./api";
import type { Card, QuizResult, ReviewAttempt, TutorSource } from "./contracts";
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  n.textContent = text;
  return n;
}
function button(text: string, action: () => void, cls = "button quiet") {
  const n = el("button", cls, text);
  n.type = "button";
  n.addEventListener("click", action);
  return n;
}
function field(
  form: HTMLElement,
  label: string,
  name: string,
  max: number,
  multiline = false,
) {
  const wrap = el("label", "learning-field", label);
  const input = multiline ? el("textarea") : el("input");
  input.name = name;
  input.required = true;
  input.maxLength = max;
  if (input instanceof HTMLTextAreaElement) input.rows = 3;
  wrap.append(input);
  form.append(wrap);
  return input;
}
function date(value: string) {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : value;
}
type Tab = "bookmarks" | "quiz" | "reviews" | "tutor";
interface Context {
  lesson: Lesson;
  signal: AbortSignal;
}
export class LearningView {
  private busy = false;
  private scope = new AbortController();
  private generation = 0;
  private context: Context | null = null;
  private readonly commands = new Commands();
  private panel = el("div");
  private status = el("p");
  private tab: Tab | null = null;
  private attempts: string[] = [];
  private bookmarkDraft: { label: string; position: number } | null = null;
  private cardDraft: {
    question: string;
    answer: string;
    source_start: number;
  } | null = null;
  private cards: Card[] = [];
  private cardCursor = "";
  private due = true;
  private activeCard: Card | null = null;
  private tutorMode: "explain" | "notes" | "quiz" | "lab" = "explain";
  private tutorHistory: Array<{
    question: string;
    answer: string;
    sources: TutorSource[];
    mode: string;
  }> = [];
  private current(): boolean {
    return this.context !== null && !this.scope.signal.aborted;
  }
  constructor(
    private readonly root: HTMLElement,
    private readonly api: LearningApi,
    private readonly position: () => number,
    private readonly seek: (n: number) => void,
    private readonly unauthorized: () => void,
    private readonly passed: (lesson: string) => void = () => {},
  ) {
    root.hidden = true;
  }
  close(): void {
    this.scope.abort();
    this.busy = false;
    this.generation++;
    this.context = null;
    this.commands.clear();
    this.attempts = [];
    this.cards = [];
    this.activeCard = null;
    this.tab = null;
    this.bookmarkDraft = null;
    this.cardDraft = null;
    this.tutorHistory = [];
    this.tutorMode = "explain";
    this.root.replaceChildren();
    this.root.hidden = true;
  }
  open(lesson: Lesson, signal: AbortSignal): void {
    this.close();
    this.scope = new AbortController();
    const abort = () => this.close();
    signal.addEventListener("abort", abort, { once: true });
    this.scope.signal.addEventListener(
      "abort",
      () => signal.removeEventListener("abort", abort),
      { once: true },
    );
    if (signal.aborted) {
      this.close();
      return;
    }
    this.context = { lesson, signal: this.scope.signal };
    const heading = el("div", "learning-heading");
    heading.append(
      el("span", "eyebrow", "Keep the ideas with you"),
      el("h2", "", "Learning tools"),
    );
    const nav = el("div", "learning-nav");
    nav.setAttribute("aria-label", "Learning tools");
    for (const [key, title] of [
      ["bookmarks", "Bookmarks"],
      ["quiz", "Lesson quiz"],
      ["reviews", "Review cards"],
      ["tutor", "AI Tutor"],
    ] as const) {
      const b = button(title, () => {
        void this.run(async () => {
          this.tab = key;
          for (const n of nav.querySelectorAll("button"))
            n.setAttribute("aria-pressed", String(n === b));
          await this.renderTab();
        });
      });
      b.dataset.learningTab = key;
      b.setAttribute("aria-pressed", "false");
      nav.append(b);
    }
    this.status = el("p", "learning-status");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.panel = el("div", "learning-panel");
    this.panel.append(
      el(
        "p",
        "muted",
        "Save a moment, check your understanding or practise what you learned.",
      ),
    );
    this.root.replaceChildren(heading, nav, this.status, this.panel);
    this.root.hidden = false;
  }
  private async run(action: () => Promise<void>): Promise<void> {
    if (!this.current() || this.busy) return;
    this.busy = true;
    const generation = this.generation;
    this.message("");
    this.root.setAttribute("aria-busy", "true");
    for (const b of this.root.querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement
    >("button, input, textarea")) {
      b.dataset.wasDisabled = String(b.disabled);
      b.disabled = true;
    }
    try {
      await action();
    } catch (error) {
      if (generation !== this.generation || !this.current() || isAbort(error))
        return;
      if (error instanceof ApiError && error.status === 401) {
        this.close();
        this.unauthorized();
        return;
      }
      if (error instanceof ApiError && [403, 404].includes(error.status)) {
        this.close();
        this.root.hidden = false;
        const notice = el(
          "p",
          "learning-status is-error",
          "Learning tools are unavailable for this lesson. Return to the course and reload the lesson to check access.",
        );
        notice.setAttribute("role", "status");
        this.root.append(notice);
        return;
      }
      this.message(
        errorMessage(error) +
          (error instanceof ApiError && error.status === 409
            ? " Reload this tool before starting a new attempt."
            : " You can retry."),
        true,
      );
    } finally {
      if (generation === this.generation && this.current()) {
        this.busy = false;
        this.root.setAttribute("aria-busy", "false");
        for (const b of this.root.querySelectorAll<
          HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement
        >("button, input, textarea")) {
          if (b.dataset.wasDisabled !== undefined)
            b.disabled = b.dataset.wasDisabled === "true";
          delete b.dataset.wasDisabled;
        }
      }
    }
  }
  private valid(ctx: Context): boolean {
    return this.context === ctx && !ctx.signal.aborted;
  }
  private message(text: string, error = false) {
    this.status.textContent = text;
    this.status.classList.toggle("is-error", error);
  }
  private async renderTab(): Promise<void> {
    this.panel.replaceChildren();
    if (this.tab === "bookmarks") await this.bookmarks();
    else if (this.tab === "quiz") await this.quiz();
    else if (this.tab === "reviews") await this.reviews();
    else if (this.tab === "tutor") await this.tutor();
  }
  private async bookmarks(): Promise<void> {
    const ctx = this.context;
    if (!ctx) return;
    const form = el("form", "learning-form");
    form.setAttribute("aria-label", "Save bookmark");
    const label = field(form, "Bookmark label", "label", 160);
    const save = el("button", "button", "Save bookmark");
    save.type = "submit";
    form.append(save);
    const list = el("div", "learning-list");
    const more = button("More bookmarks", () => {
      void this.run(() => load(true));
    });
    let cursor = "";
    const load = async (append = false) => {
      const response = await this.api.bookmarks(
        ctx.lesson.id,
        ctx.signal,
        append ? cursor : "",
      );
      if (!this.valid(ctx)) return;
      if (!append) list.replaceChildren();
      for (const b of response.items) {
        if (b.lesson_id !== ctx.lesson.id) continue;
        const row = el("article", "learning-row");
        row.append(
          button(
            formatTime(b.position),
            () => this.seek(b.position),
            "text-button",
          ),
          el("p", "", b.label),
          button("Delete bookmark", () => {
            void this.run(async () => {
              await this.api.deleteBookmark(b.id, ctx.signal);
              if (this.valid(ctx)) {
                await load();
                this.message("Bookmark deleted.");
              }
            });
          }),
        );
        list.append(row);
      }
      if (!list.childElementCount)
        list.append(el("p", "muted", "Your saved moments will appear here."));
      cursor = response.cursor;
      more.hidden = !cursor;
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.run(async () => {
        const text = label.value.trim();
        if (!text) return;
        if (this.bookmarkDraft?.label !== text)
          this.bookmarkDraft = { label: text, position: this.position() };
        const command = this.commands.get("bookmark", this.bookmarkDraft);
        const saved = await this.api.createBookmark(
          ctx.lesson.id,
          command.body,
          command.key,
          ctx.signal,
        );
        if (!this.valid(ctx)) return;
        this.commands.acknowledge("bookmark");
        this.bookmarkDraft = null;
        label.value = "";
        await load();
        if (this.valid(ctx))
          this.message(`Bookmark saved at ${formatTime(saved.position)}.`);
      });
    });
    this.panel.append(el("h3", "", "Your saved moments"), form, list, more);
    await load();
  }
  private async quiz(): Promise<void> {
    const ctx = this.context;
    if (!ctx) return;
    this.panel.append(el("p", "muted", "Loading lesson quiz…"));
    const data = await this.api.quiz(ctx.lesson.id, ctx.signal);
    if (!this.valid(ctx)) return;
    if (data.lesson_id !== ctx.lesson.id)
      throw new Error("Quiz belongs to a different lesson.");
    if (data.state === "ready" && data.status.passed)
      this.passed(ctx.lesson.id);
    this.panel.replaceChildren();
    this.panel.append(
      el("h3", "", "Check your understanding"),
      button("Reload quiz", () => {
        void this.run(() => this.quiz());
      }),
    );
    if (data.state === "pending")
      this.panel.append(
        el(
          "p",
          "muted",
          "This lesson quiz is awaiting approval. Come back when it is ready.",
        ),
      );
    else {
      this.panel.append(
        el(
          "p",
          "muted",
          data.status.passed
            ? `Learned · ${data.status.attempts} attempts. Retake to refresh your recall.`
            : `${data.questions.length} questions · Answer every question to receive feedback.`,
        ),
      );
      const form = el("form", "learning-form quiz-form");
      form.setAttribute("aria-label", "Lesson quiz");
      data.questions.forEach((q, index) => {
        const group = el("fieldset", "quiz-question");
        group.append(el("legend", "", `${index + 1}. ${q.question}`));
        q.options.forEach((option, choice) => {
          const label = el("label", "quiz-choice");
          const radio = el("input");
          radio.type = "radio";
          radio.name = `question-${index}`;
          radio.value = String(choice);
          radio.required = true;
          label.append(radio, el("span", "", option));
          group.append(label);
        });
        form.append(group);
      });
      const submit = el("button", "button primary", "Submit quiz");
      submit.type = "submit";
      form.append(submit);
      const results = el("div", "quiz-result");
      results.setAttribute("aria-live", "polite");
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void this.run(async () => {
          const answers: Record<string, number> = {};
          data.questions.forEach((q, index) => {
            const chosen = form.querySelector<HTMLInputElement>(
              `input[name="question-${index}"]:checked`,
            );
            if (chosen) answers[q.id] = Number(chosen.value);
          });
          if (Object.keys(answers).length !== data.questions.length) {
            this.message("Answer every question before submitting.", true);
            return;
          }
          const command = this.commands.get("quiz", {
            quiz_id: data.quiz_id,
            revision: data.revision,
            answers,
          });
          const graded = await this.api.attempt(
            ctx.lesson.id,
            command.body,
            command.key,
            ctx.signal,
          );
          if (!this.valid(ctx)) return;
          if (
            graded.lesson_id !== ctx.lesson.id ||
            graded.quiz_id !== data.quiz_id ||
            graded.revision !== data.revision
          )
            throw new Error("Quiz result does not match this attempt.");
          this.commands.acknowledge("quiz");
          if (graded.passed) this.passed(ctx.lesson.id);
          results.replaceChildren(this.renderResult(graded));
          this.message("Your private quiz result is saved.");
          await loadHistory();
        });
      });
      this.panel.append(form, results);
    }
    const history = el("div", "learning-list");
    let cursor = "";
    const more = button("More quiz attempts", () => {
      void this.run(() => loadHistory(true));
    });
    const loadHistory = async (append = false) => {
      const response = await this.api.quizHistory(
        ctx.lesson.id,
        ctx.signal,
        append ? cursor : "",
      );
      if (!this.valid(ctx)) return;
      if (!append) history.replaceChildren();
      for (const attempt of response.items) {
        if (attempt.lesson_id !== ctx.lesson.id) continue;
        const details = el("details", "learning-attempt");
        details.append(
          el(
            "summary",
            "",
            `${attempt.score}% · ${attempt.passed ? "Passed" : "Keep practising"} · ${date(attempt.completed_at)}`,
          ),
          this.renderResult(attempt),
        );
        history.append(details);
      }
      if (!history.childElementCount)
        history.append(
          el("p", "muted", "Your graded attempts will appear here."),
        );
      cursor = response.cursor;
      more.hidden = !cursor;
    };
    this.panel.append(el("h3", "", "Your quiz attempts"), history, more);
    await loadHistory();
  }
  private renderResult(result: QuizResult): HTMLElement {
    const article = el("article", "learning-result");
    article.append(
      el(
        "h4",
        "",
        `${result.score}% · ${result.passed ? "Passed" : "Keep practising"}`,
      ),
      el(
        "p",
        "muted",
        `${result.correct_count}/${result.total_count} correct · ${result.passing_threshold}% to pass`,
      ),
    );
    result.feedback.forEach((f, index) => {
      const item = el("div", "quiz-feedback");
      item.append(
        el(
          "strong",
          f.correct ? "feedback-correct" : "feedback-incorrect",
          `Question ${index + 1}: ${f.correct ? "Correct" : "Review this idea"}`,
        ),
        el("p", "", f.explanation),
      );
      // Retained history can have obsolete options: do not pair old feedback with
      // today's question text. The immutable result keeps its own choice indices.
      item.append(
        el(
          "p",
          "muted",
          `Your choice: ${f.chosen_index + 1} · Correct choice: ${f.correct_index + 1}`,
        ),
      );
      if (this.context?.lesson.id === result.lesson_id)
        item.append(
          button(
            `Review at ${formatTime(f.source_start)}`,
            () => this.seek(f.source_start),
            "text-button",
          ),
        );
      article.append(item);
    });
    article.append(el("p", "muted", result.suggested_review));
    return article;
  }
  private async reviews(): Promise<void> {
    const ctx = this.context;
    if (!ctx) return;
    this.panel.append(
      el("h3", "", "Practise what you learned"),
      el(
        "p",
        "muted",
        "Cards and review history belong to this course. Reveal an answer before grading your recall.",
      ),
    );
    const controls = el("div", "learning-nav");
    const study = el("div", "review-study");
    const listing = el("div", "learning-list");
    let historyCursor = "";
    const more = button("More cards", () => {
      void this.run(() => loadCards(true));
    });
    const finish = button("Finish review", () => {
      void this.run(async () => {
        if (!this.attempts.length) return;
        const command = this.commands.get("complete-review", {
          attempts: [...this.attempts].sort(),
        });
        const done = await this.api.complete(
          ctx.lesson.course_id,
          command.body.attempts,
          command.key,
          ctx.signal,
        );
        if (!this.valid(ctx)) return;
        this.commands.acknowledge("complete-review");
        this.attempts = [];
        finish.disabled = true;
        finish.dataset.wasDisabled = "true";
        this.message(
          `Review saved · ${done.cards_reviewed} cards${done.habit_credited ? " · Habit credit earned" : ""}.`,
        );
        await loadHistory();
      });
    });
    finish.disabled = this.attempts.length === 0;
    const draw = () => {
      listing.replaceChildren();
      for (const c of this.cards) {
        const row = el("article", "learning-row");
        row.append(
          el("p", "", c.question),
          el("span", "muted", `Due ${date(c.due_at)}`),
          button("Review card", () =>
            this.showCard(c, study, finish, loadCards, loadHistory),
          ),
        );
        listing.append(row);
      }
      if (!this.cards.length)
        listing.append(
          el(
            "p",
            "muted",
            this.due
              ? "You’re all caught up. Create a card or view all your cards."
              : "Create your first card from this lesson.",
          ),
        );
      more.hidden = !this.cardCursor;
    };
    const loadCards = async (append = false) => {
      const response = await this.api.cards(
        ctx.lesson.course_id,
        this.due,
        ctx.signal,
        append ? this.cardCursor : "",
      );
      if (!this.valid(ctx)) return;
      this.cards = append
        ? [
            ...this.cards,
            ...response.items.filter(
              (c) => c.course_id === ctx.lesson.course_id,
            ),
          ]
        : response.items.filter((c) => c.course_id === ctx.lesson.course_id);
      this.cardCursor = response.cursor;
      draw();
    };
    for (const [due, text] of [
      [true, "Due cards"],
      [false, "All cards"],
    ] as const)
      controls.append(
        button(text, () => {
          void this.run(async () => {
            this.due = due;
            this.activeCard = null;
            study.replaceChildren();
            await loadCards();
          });
        }),
      );
    const form = el("form", "learning-form");
    form.setAttribute("aria-label", "Create review card");
    const question = field(form, "Card question", "question", 500, true);
    question.minLength = 8;
    const answer = field(form, "Card answer", "answer", 1000, true);
    const create = el("button", "button", "Create review card");
    create.type = "submit";
    form.append(create);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.run(async () => {
        const q = question.value.trim();
        const a = answer.value.trim();
        if (q.length < 8 || !a) {
          this.message(
            "Write a question of at least 8 characters and an answer.",
            true,
          );
          return;
        }
        if (this.cardDraft?.question !== q || this.cardDraft?.answer !== a)
          this.cardDraft = {
            question: q,
            answer: a,
            source_start: this.position(),
          };
        const command = this.commands.get("card", {
          course_id: ctx.lesson.course_id,
          lesson_id: ctx.lesson.id,
          ...this.cardDraft,
        });
        await this.api.createCard(command.body, command.key, ctx.signal);
        if (!this.valid(ctx)) return;
        this.commands.acknowledge("card");
        this.cardDraft = null;
        question.value = "";
        answer.value = "";
        await loadCards();
        if (this.valid(ctx)) this.message("Your review card is saved.");
      });
    });
    const history = el("div", "learning-list");
    const historyMore = button("More review history", () => {
      void this.run(() => loadHistory(true));
    });
    const loadHistory = async (append = false) => {
      const response = await this.api.history(
        ctx.lesson.course_id,
        ctx.signal,
        append ? historyCursor : "",
      );
      if (!this.valid(ctx)) return;
      if (!append) history.replaceChildren();
      for (const a of response.items)
        history.append(this.renderReviewAttempt(a));
      if (!history.childElementCount)
        history.append(el("p", "muted", "Your graded cards will appear here."));
      historyCursor = response.cursor;
      historyMore.hidden = !historyCursor;
    };
    this.panel.append(
      controls,
      finish,
      study,
      listing,
      more,
      el("h3", "", "Make a card from this lesson"),
      form,
      el("h3", "", "Your review history"),
      history,
      historyMore,
    );
    await loadCards();
    if (this.valid(ctx)) await loadHistory();
  }
  private showCard(
    card: Card,
    study: HTMLElement,
    finish: HTMLButtonElement,
    loadCards: () => Promise<void>,
    loadHistory: () => Promise<void>,
  ): void {
    const ctx = this.context;
    if (!ctx) return;
    this.activeCard = card;
    study.replaceChildren(el("h4", "", card.question));
    const answer = el("p", "review-answer", card.answer);
    answer.hidden = true;
    const grades = el("div", "review-grades");
    grades.hidden = true;
    for (const [quality, title] of [
      "Forgot",
      "Hard to recall",
      "Almost",
      "With effort",
      "Remembered",
      "Easy",
    ].entries())
      grades.append(
        button(`${quality} · ${title}`, () => {
          void this.run(async () => {
            if (this.activeCard !== card) return;
            const command = this.commands.get(`grade:${card.id}`, {
              quality,
              expected_revision: card.revision,
            });
            const accepted = await this.api.grade(
              card.id,
              command.body,
              command.key,
              ctx.signal,
            );
            if (!this.valid(ctx)) return;
            if (accepted.card_id !== card.id)
              throw new Error(
                "Review acknowledgement does not match this card.",
              );
            this.commands.acknowledge(`grade:${card.id}`);
            if (!this.attempts.includes(accepted.attempt_id))
              this.attempts.push(accepted.attempt_id);
            finish.disabled = false;
            finish.dataset.wasDisabled = "false";
            this.activeCard = null;
            study.replaceChildren(
              el(
                "p",
                "",
                `Recall saved · Next review ${date(accepted.due_at)}. Finish review to save this session.`,
              ),
            );
            await loadCards();
            if (this.valid(ctx)) await loadHistory();
          });
        }),
      );
    const reveal = button("Reveal answer", () => {
      answer.hidden = false;
      grades.hidden = false;
      reveal.hidden = true;
    });
    study.append(reveal, answer, grades);
    if (card.lesson_id === ctx.lesson.id)
      study.append(
        button(
          `Source at ${formatTime(card.source_start)}`,
          () => this.seek(card.source_start),
          "text-button",
        ),
      );
  }
  private renderReviewAttempt(a: ReviewAttempt) {
    const row = el("article", "learning-row");
    row.append(
      el("strong", "", `Recall ${a.quality}/5`),
      el("p", "muted", date(a.reviewed_at)),
      el(
        "p",
        "muted",
        `Next review ${date(a.schedule.due_at)} · ${a.schedule.interval_days} days`,
      ),
    );
    return row;
  }
  private async tutor(): Promise<void> {
    const ctx = this.context;
    if (!ctx) return;

    const container = el("div", "learning-tutor");

    const modeBar = el("div", "learning-tutor-modes");
    modeBar.setAttribute("role", "toolbar");
    modeBar.setAttribute("aria-label", "AI Tutor modes");

    const modes = [
      { id: "explain", label: "💡 Explain Concept", desc: "Clear explanation with examples & citations" },
      { id: "notes", label: "📝 Study Notes", desc: "Structured hierarchical summary" },
      { id: "quiz", label: "❓ Concept Quiz", desc: "Self-check questions with solutions" },
      { id: "lab", label: "🛠️ Hands-on Lab", desc: "Practical hands-on terminal exercise" },
    ] as const;

    for (const m of modes) {
      const modeBtn = button(
        m.label,
        () => {
          this.tutorMode = m.id;
          for (const b of modeBar.querySelectorAll("button")) {
            b.setAttribute("aria-pressed", String(b.dataset.mode === m.id));
          }
        },
        "button quiet tutor-mode-btn",
      );
      modeBtn.dataset.mode = m.id;
      modeBtn.title = m.desc;
      modeBtn.setAttribute("aria-pressed", String(this.tutorMode === m.id));
      modeBar.append(modeBtn);
    }
    container.append(modeBar);

    const form = el("form", "learning-form tutor-form");
    form.setAttribute("aria-label", "Ask AI Tutor");
    const input = field(form, "Question or Topic", "question", 1000, true);
    input.placeholder = "Ask anything about this lecture (e.g. How does Spark RDD memory management work?)...";

    const suggestions = el("div", "learning-tutor-suggestions");
    const suggestionsList = [
      "Explain this lesson's core concept",
      "What are the key technical takeaways?",
      "Test my understanding with 3 questions",
      "Design a hands-on verification lab",
    ];
    for (const promptText of suggestionsList) {
      const pill = button(
        promptText,
        () => {
          input.value = promptText;
          input.focus();
        },
        "button quiet suggestion-pill",
      );
      suggestions.append(pill);
    }
    container.append(suggestions);

    const askBtn = el("button", "button", "Ask AI Tutor");
    askBtn.type = "submit";
    form.append(askBtn);
    container.append(form);

    const resultsContainer = el("div", "learning-tutor-results");
    container.append(resultsContainer);

    const renderResults = () => {
      resultsContainer.replaceChildren();
      if (this.tutorHistory.length === 0) {
        const placeholder = el(
          "p",
          "muted",
          "Ask a question above or select a study mode to receive grounded explanations citing exact timestamps in this course.",
        );
        resultsContainer.append(placeholder);
        return;
      }

      for (const item of this.tutorHistory) {
        if (!item) continue;
        const itemBox = el("article", "learning-tutor-item");

        const qHeader = el("div", "learning-tutor-q");
        qHeader.append(
          el("span", "tutor-badge", item.mode.toUpperCase()),
          el("strong", "", item.question),
        );
        itemBox.append(qHeader);

        const aBody = el("div", "learning-tutor-a");
        this.renderTutorContent(aBody, item.answer, ctx.lesson.id);
        itemBox.append(aBody);

        if (item.sources.length > 0) {
          const sourcesDetails = el("details", "learning-tutor-sources");
          const summary = el(
            "summary",
            "",
            `Citations & Transcripts (${item.sources.length})`,
          );
          sourcesDetails.append(summary);
          for (const src of item.sources) {
            const srcRow = el("div", "source-row");
            const tsBtn = button(
              `⏱ ${formatTime(src.start_seconds)} - ${formatTime(src.end_seconds)}: ${src.lesson_title}`,
              () => {
                if (src.lesson_id === ctx.lesson.id) {
                  this.seek(src.start_seconds);
                } else {
                  window.location.hash = `#learning/${src.lesson_id}?t=${Math.floor(src.start_seconds)}`;
                }
              },
              "text-button source-time",
            );
            srcRow.append(tsBtn, el("p", "source-text", src.text));
            sourcesDetails.append(srcRow);
          }
          itemBox.append(sourcesDetails);
        }

        resultsContainer.append(itemBox);
      }
    };

    renderResults();

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const question = input.value.trim();
      if (!question) return;

      void this.run(async () => {
        this.message("Consulting CourseForge AI Tutor...");
        const resp = await this.api.tutor(
          {
            question,
            mode: this.tutorMode,
            lesson_id: ctx.lesson.id,
            course_id: ctx.lesson.course_id,
          },
          ctx.signal,
        );
        if (!this.valid(ctx)) return;

        this.tutorHistory.unshift({
          question,
          answer: resp.answer,
          sources: resp.sources,
          mode: resp.mode,
        });
        this.message("");
        input.value = "";
        renderResults();
      });
    });

    this.panel.append(container);
  }

  private renderTutorContent(
    container: HTMLElement,
    markdownText: string,
    currentLessonId: string,
  ): void {
    const lines = markdownText.split("\n");
    let currentP: HTMLElement | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        currentP = null;
        continue;
      }

      if (line.startsWith("- ") || line.startsWith("* ")) {
        const li = el("div", "tutor-list-item");
        this.renderInlineContent(li, line.slice(2), currentLessonId);
        container.append(li);
        currentP = null;
        continue;
      }

      if (line.startsWith("> ")) {
        const blockquote = el("blockquote", "tutor-quote");
        this.renderInlineContent(blockquote, line.slice(2), currentLessonId);
        container.append(blockquote);
        currentP = null;
        continue;
      }

      if (!currentP) {
        currentP = el("p", "tutor-paragraph");
        container.append(currentP);
      } else {
        currentP.append(document.createTextNode(" "));
      }
      this.renderInlineContent(currentP, line, currentLessonId);
    }
  }

  private renderInlineContent(
    parent: HTMLElement,
    text: string,
    currentLessonId: string,
  ): void {
    const linkRegex = /\[([^\]]+)\]\((#[^)]+)\)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = linkRegex.exec(text)) !== null) {
      const mIdx = match.index;
      if (mIdx !== undefined && mIdx > lastIndex) {
        parent.append(
          document.createTextNode(text.slice(lastIndex, mIdx)),
        );
      }
      const linkText = String(match[1] || "");
      const linkHref = String(match[2] || "");

      const timeMatch = /#learning\/([^?]+)\?t=(\d+)/.exec(linkHref);
      const targetLessonId = timeMatch?.[1];
      const targetSeconds = parseInt(timeMatch?.[2] ?? "0", 10);
      if (targetLessonId && !isNaN(targetSeconds)) {
        const linkBtn = button(
          linkText,
          () => {
            if (targetLessonId === currentLessonId) {
              this.seek(targetSeconds);
            } else {
              window.location.hash = `#learning/${targetLessonId}?t=${targetSeconds}`;
            }
          },
          "button quiet citation-link",
        );
        parent.append(linkBtn);
      } else {
        const a = el("a", "external-link", linkText);
        a.setAttribute("href", linkHref);
        parent.append(a);
      }
      lastIndex = linkRegex.lastIndex;
    }

    if (lastIndex < text.length) {
      parent.append(document.createTextNode(text.slice(lastIndex)));
    }
  }
}

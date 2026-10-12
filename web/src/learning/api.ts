import { ApiClient } from "../api";
import {
  bookmark,
  card,
  completion,
  courseStatus,
  grade,
  page,
  quiz,
  result,
  reviewAttempt,
  tutorResponse,
  type TutorResponse,
} from "./contracts";
const id = encodeURIComponent;
function query(course: string, cursor = "") {
  const q = new URLSearchParams({ course, limit: "30" });
  if (cursor) q.set("cursor", cursor);
  return q;
}
export class LearningApi {
  constructor(private readonly api: ApiClient) {}
  courseStatus(course: string, signal: AbortSignal, cursor = "") {
    return this.api
      .request(`/courses/${id(course)}/quizzes/status?${query("", cursor)}`, {
        signal,
      })
      .then(courseStatus);
  }
  bookmarks(lesson: string, signal: AbortSignal, cursor = "") {
    return this.api
      .request(`/lessons/${id(lesson)}/bookmarks?${query("", cursor)}`, {
        signal,
      })
      .then((v) => page(v, "bookmarks", bookmark));
  }
  createBookmark(
    lesson: string,
    body: { label: string; position: number },
    key: string,
    signal: AbortSignal,
  ) {
    return this.api
      .request(`/lessons/${id(lesson)}/bookmarks`, {
        method: "POST",
        body,
        idempotencyKey: key,
        signal,
      })
      .then(bookmark);
  }
  deleteBookmark(bookmarkId: string, signal: AbortSignal) {
    return this.api.request(`/bookmarks/${id(bookmarkId)}`, {
      method: "DELETE",
      signal,
    });
  }
  quiz(lesson: string, signal: AbortSignal) {
    return this.api
      .request(`/lessons/${id(lesson)}/quiz`, { signal })
      .then(quiz);
  }
  attempt(
    lesson: string,
    body: {
      quiz_id: string;
      revision: number;
      answers: Record<string, number>;
    },
    key: string,
    signal: AbortSignal,
  ) {
    return this.api
      .request(`/lessons/${id(lesson)}/quiz/attempts`, {
        method: "POST",
        body,
        idempotencyKey: key,
        signal,
      })
      .then(result);
  }
  quizHistory(lesson: string, signal: AbortSignal, cursor = "") {
    return this.api
      .request(`/lessons/${id(lesson)}/quiz/attempts?${query("", cursor)}`, {
        signal,
      })
      .then((v) => page(v, "attempts", result));
  }
  cards(course: string, due: boolean, signal: AbortSignal, cursor = "") {
    return this.api
      .request(`/reviews/${due ? "due" : "cards"}?${query(course, cursor)}`, {
        signal,
      })
      .then((v) => page(v, "cards", card));
  }
  createCard(
    body: {
      course_id: string;
      lesson_id: string;
      question: string;
      answer: string;
      source_start: number;
    },
    key: string,
    signal: AbortSignal,
  ) {
    return this.api
      .request("/reviews/cards", {
        method: "POST",
        body,
        idempotencyKey: key,
        signal,
      })
      .then(card);
  }
  grade(
    cardId: string,
    body: { quality: number; expected_revision: number },
    key: string,
    signal: AbortSignal,
  ) {
    return this.api
      .request(`/reviews/${id(cardId)}/grade`, {
        method: "POST",
        body,
        idempotencyKey: key,
        signal,
      })
      .then(grade);
  }
  history(course: string, signal: AbortSignal, cursor = "") {
    return this.api
      .request(`/reviews/history?${query(course, cursor)}`, { signal })
      .then((v) => page(v, "attempts", reviewAttempt));
  }
  complete(
    course: string,
    attempts: string[],
    key: string,
    signal: AbortSignal,
  ) {
    return this.api
      .request("/reviews/complete", {
        method: "POST",
        body: { course, attempt_ids: attempts },
        idempotencyKey: key,
        signal,
      })
      .then(completion);
  }
  tutor(
    body: {
      question: string;
      mode?: string;
      lesson_id?: string;
      course_id?: string;
    },
    signal: AbortSignal,
  ): Promise<TutorResponse> {
    return this.api
      .request("/learning/tutor", {
        method: "POST",
        body,
        signal,
      })
      .then(tutorResponse);
  }
}

// Keep an uncertain command stable through manual retries. Only one outstanding
// snapshot per action exists; editing its payload replaces it, acknowledgement
// clears it, and navigation discards the complete in-memory ledger.
export class Commands {
  private readonly pending = new Map<
    string,
    { fingerprint: string; key: string; body: unknown }
  >();
  get<T>(action: string, body: T): { key: string; body: T } {
    const fingerprint = JSON.stringify(body);
    let command = this.pending.get(action);
    if (!command || command.fingerprint !== fingerprint) {
      command = {
        fingerprint,
        key: crypto.randomUUID(),
        body: JSON.parse(fingerprint) as unknown,
      };
      this.pending.set(action, command);
    }
    return { key: command.key, body: command.body as T };
  }
  acknowledge(action: string): void {
    this.pending.delete(action);
  }
  clear(): void {
    this.pending.clear();
  }
}

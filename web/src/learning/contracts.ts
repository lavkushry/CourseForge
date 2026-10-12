import { ApiError } from "../api";

export interface Bookmark {
  id: string;
  lesson_id: string;
  position: number;
  label: string;
  created_at: string;
}
export interface Question {
  id: string;
  question: string;
  options: string[];
  concept: string;
}
export type LessonQuiz =
  | { state: "pending"; lesson_id: string; questions: Question[] }
  | {
      state: "ready";
      lesson_id: string;
      quiz_id: string;
      revision: number;
      questions: Question[];
      status: { attempts: number; passed: boolean; last_score: number | null };
    };
export interface Feedback {
  question_id: string;
  correct: boolean;
  chosen_index: number;
  correct_index: number;
  explanation: string;
  source_start: number;
  concept: string;
}
export interface QuizResult {
  attempt_id: string;
  lesson_id: string;
  quiz_id: string;
  revision: number;
  score: number;
  passed: boolean;
  correct_count: number;
  total_count: number;
  passing_threshold: number;
  feedback: Feedback[];
  suggested_review: string;
  completed_at: string;
}
export interface Card {
  id: string;
  course_id: string;
  lesson_id: string | null;
  question: string;
  answer: string;
  source_start: number;
  revision: number;
  due_at: string;
  interval_days: number;
  repetitions: number;
}
export interface Grade {
  attempt_id: string;
  card_id: string;
  revision: number;
  due_at: string;
  interval_days: number;
  repetitions: number;
}
export interface ReviewAttempt {
  id: string;
  card_id: string;
  course_id: string;
  quality: number;
  reviewed_at: string;
  schedule: { due_at: string; interval_days: number };
}
export interface ReviewCompletion {
  session_id: string;
  status: "completed";
  cards_reviewed: number;
  habit_credited: boolean;
  completed_at: string;
}
export interface Page<T> {
  items: T[];
  cursor: string;
}
const invalid = (): never => {
  throw new ApiError(
    "Learning data could not be read. Please reload.",
    502,
    "invalid_learning_response",
  );
};
export function record(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : invalid();
}
function str(v: unknown): string {
  return typeof v === "string" ? v : invalid();
}
function num(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max
    ? v
    : invalid();
}
function integer(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = num(v, min, max);
  return Number.isInteger(n) ? n : invalid();
}
function bool(v: unknown): boolean {
  return typeof v === "boolean" ? v : invalid();
}
function array<T>(v: unknown, parse: (v: unknown) => T, max = 100): T[] {
  return Array.isArray(v) && v.length <= max ? v.map(parse) : invalid();
}
export function page<T>(
  v: unknown,
  key: string,
  parse: (v: unknown) => T,
): Page<T> {
  const r = record(v);
  return {
    items: array(r[key], parse),
    cursor: r.next_cursor == null ? "" : str(r.next_cursor),
  };
}
export function bookmark(v: unknown): Bookmark {
  const r = record(v);
  return {
    id: str(r.id),
    lesson_id: str(r.lesson_id),
    position: num(r.position),
    label: str(r.label),
    created_at: str(r.created_at),
  };
}
export function quiz(v: unknown): LessonQuiz {
  const r = record(v);
  const lesson_id = str(r.lesson_id);
  if (r.state === "pending")
    return { state: "pending", lesson_id, questions: [] };
  if (r.state !== "ready") return invalid();
  const questions = array(
    r.questions,
    (v) => {
      const q = record(v);
      return {
        id: str(q.id),
        question: str(q.question),
        options: array(q.options, str, 8),
        concept: str(q.concept),
      };
    },
    20,
  );
  if (
    !questions.length ||
    questions.some((q) => !q.id || q.options.length < 2) ||
    new Set(questions.map((q) => q.id)).size !== questions.length
  )
    return invalid();
  const s = record(r.status);
  return {
    state: "ready",
    lesson_id,
    quiz_id: str(r.quiz_id),
    revision: integer(r.revision, 1),
    questions,
    status: {
      attempts: integer(s.attempts),
      passed: bool(s.passed),
      last_score: s.last_score === null ? null : integer(s.last_score, 0, 100),
    },
  };
}
export function result(v: unknown): QuizResult {
  const r = record(v);
  return {
    attempt_id: str(r.attempt_id),
    lesson_id: str(r.lesson_id),
    quiz_id: str(r.quiz_id),
    revision: integer(r.revision, 1),
    score: integer(r.score, 0, 100),
    passed: bool(r.passed),
    correct_count: integer(r.correct_count),
    total_count: integer(r.total_count, 1, 20),
    passing_threshold: integer(r.passing_threshold, 0, 100),
    suggested_review: str(r.suggested_review),
    completed_at: str(r.completed_at),
    feedback: array(
      r.feedback,
      (v) => {
        const f = record(v);
        return {
          question_id: str(f.question_id),
          correct: bool(f.correct),
          chosen_index: integer(f.chosen_index, 0, 7),
          correct_index: integer(f.correct_index, 0, 7),
          explanation: str(f.explanation),
          source_start: num(f.source_start),
          concept: str(f.concept),
        };
      },
      20,
    ),
  };
}
export function card(v: unknown): Card {
  const r = record(v);
  return {
    id: str(r.id),
    course_id: str(r.course_id),
    lesson_id: r.lesson_id === null ? null : str(r.lesson_id),
    question: str(r.question),
    answer: str(r.answer),
    source_start: num(r.source_start),
    revision: integer(r.revision, 1),
    due_at: str(r.due_at),
    interval_days: integer(r.interval_days),
    repetitions: integer(r.repetitions),
  };
}
export function grade(v: unknown): Grade {
  const r = record(v);
  return {
    attempt_id: str(r.attempt_id),
    card_id: str(r.card_id),
    revision: integer(r.revision, 1),
    due_at: str(r.due_at),
    interval_days: integer(r.interval_days),
    repetitions: integer(r.repetitions),
  };
}
export function reviewAttempt(v: unknown): ReviewAttempt {
  const r = record(v);
  const s = record(r.schedule);
  return {
    id: str(r.id),
    card_id: str(r.card_id),
    course_id: str(r.course_id),
    quality: integer(r.quality, 0, 5),
    reviewed_at: str(r.reviewed_at),
    schedule: {
      due_at: str(s.due_at),
      interval_days: integer(s.interval_days),
    },
  };
}
export function completion(v: unknown): ReviewCompletion {
  const r = record(v);
  if (r.status !== "completed") return invalid();
  return {
    session_id: str(r.session_id),
    status: "completed",
    cards_reviewed: integer(r.cards_reviewed, 1, 100),
    habit_credited: bool(r.habit_credited),
    completed_at: str(r.completed_at),
  };
}
export function courseStatus(v: unknown): { passed: string[]; cursor: string } {
  const r = record(v);
  const status = record(r.status);
  const passed: string[] = [];
  if (Object.keys(status).length > 100) return invalid();
  for (const [lesson, value] of Object.entries(status)) {
    const s = record(value);
    if (bool(s.passed)) {
      integer(s.score, 0, 100);
      passed.push(lesson);
    }
  }
  return { passed, cursor: r.next_cursor == null ? "" : str(r.next_cursor) };
}

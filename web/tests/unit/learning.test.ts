import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../src/api";
import { Commands, LearningApi } from "../../src/learning/api";
import {
  card,
  completion,
  courseStatus,
  page,
  quiz,
  result,
  reviewAttempt,
  tutorResponse,
} from "../../src/learning/contracts";
const definition = {
  state: "ready",
  lesson_id: "lesson",
  quiz_id: "quiz",
  revision: 2,
  questions: [
    {
      id: "q1",
      question: "Choose the option.",
      options: ["A", "B"],
      concept: "Recall",
      correct_index: 1,
      explanation: "Never render me early.",
    },
  ],
  status: { attempts: 0, passed: false, last_score: null },
};
describe("learning trust boundary", () => {
  it("projects only public question fields before grading, even if a response supplies solutions", () => {
    const parsed = quiz(definition);
    expect(parsed.questions[0]).toEqual({
      id: "q1",
      question: "Choose the option.",
      options: ["A", "B"],
      concept: "Recall",
    });
    expect(JSON.stringify(parsed)).not.toContain("Never render");
  });
  it("rejects malformed and duplicate question definitions instead of allowing ungradable answers", () => {
    expect(() =>
      quiz({
        ...definition,
        questions: [...definition.questions, ...definition.questions],
      }),
    ).toThrow();
    expect(() => quiz({ ...definition, revision: 1.2 })).toThrow();
    expect(() =>
      quiz({
        ...definition,
        questions: [{ ...definition.questions[0], options: ["A"] }],
      }),
    ).toThrow();
  });
  it("reads bounded learned badges only from positive server quiz status", () => {
    expect(
      courseStatus({
        status: { lesson: { passed: true, score: 75 } },
        next_cursor: "cursor",
      }),
    ).toEqual({ passed: ["lesson"], cursor: "cursor" });
    expect(() =>
      courseStatus({ status: { lesson: { passed: true, score: 101 } } }),
    ).toThrow();
  });
  it("retains the pending state without fabricating a quiz or successful result", () => {
    expect(
      quiz({ state: "pending", lesson_id: "lesson", questions: [] }),
    ).toEqual({ state: "pending", lesson_id: "lesson", questions: [] });
    expect(() => result({ score: 100 })).toThrow();
  });
  it("bounds response pages and validates private scheduling and acknowledged completion", () => {
    expect(() =>
      page({ cards: new Array(101).fill({}), next_cursor: "" }, "cards", card),
    ).toThrow();
    expect(() => card({ id: "card", revision: 0 })).toThrow();
    expect(() => completion({ status: "queued" })).toThrow();
    expect(() => reviewAttempt({ quality: 6 })).toThrow();
  });
});
describe("uncertain learning commands", () => {
  it("retains a frozen snapshot and key through retry, replaces edits, and forgets acknowledged writes", () => {
    const commands = new Commands();
    const answers = { q1: 1 };
    const initial = commands.get("quiz", { answers });
    answers.q1 = 0;
    const retry = commands.get("quiz", { answers: { q1: 1 } });
    expect(retry).toEqual(initial);
    expect(initial.body.answers.q1).toBe(1);
    const changed = commands.get("quiz", { answers: { q1: 0 } });
    expect(changed.key).not.toBe(initial.key);
    commands.acknowledge("quiz");
    expect(commands.get("quiz", changed.body).key).not.toBe(changed.key);
    const beforeNavigation = commands.get("grade", { quality: 4 });
    commands.clear();
    expect(commands.get("grade", { quality: 4 }).key).not.toBe(
      beforeNavigation.key,
    );
  });
  it("sends the same idempotency/CSRF command after a response is lost, with no invented success", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user: { id: "learner", email: "fixture@example.test" },
            csrf_token: "synthetic-csrf",
          }),
        ),
      )
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "bookmark",
            lesson_id: "lesson",
            label: "Moment",
            position: 3,
            created_at: "2026-10-12T12:00:00Z",
          }),
        ),
      );
    const client = new ApiClient(fetcher);
    await client.me();
    const api = new LearningApi(client);
    const commands = new Commands();
    const signal = new AbortController().signal;
    const command = commands.get("bookmark", { label: "Moment", position: 3 });
    await expect(
      api.createBookmark("lesson", command.body, command.key, signal),
    ).rejects.toThrow("connection lost");
    const retried = commands.get("bookmark", { label: "Moment", position: 3 });
    expect(
      (await api.createBookmark("lesson", retried.body, retried.key, signal))
        .position,
    ).toBe(3);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      credentials: "same-origin",
      headers: {
        "X-CSRF-Token": "synthetic-csrf",
        "Idempotency-Key": command.key,
      },
      body: JSON.stringify(command.body),
    });
    const first = fetcher.mock.calls[1]?.[1];
    const second = fetcher.mock.calls[2]?.[1];
    expect(second?.headers).toEqual(first?.headers);
    expect(second?.body).toEqual(first?.body);
    expect(second?.credentials).toBe(first?.credentials);
  });
});
describe("ai tutor integration", () => {
  it("parses tutor response with sources and default mode fallback safely", () => {
    const raw = {
      answer: "Spark partitions are distributed across workers.",
      sources: [
        {
          lesson_id: "l1",
          lesson_title: "Spark RDD",
          course_id: "spark",
          start_seconds: 120,
          end_seconds: 180,
          text: "Partitions represent logical chunks of data.",
        },
      ],
      mode: "explain",
    };
    const parsed = tutorResponse(raw);
    expect(parsed.answer).toBe(raw.answer);
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.sources[0]?.start_seconds).toBe(120);
    expect(parsed.mode).toBe("explain");
  });

  it("handles empty sources and missing fields without crashing", () => {
    const parsed = tutorResponse({ answer: "Grounded response" });
    expect(parsed.answer).toBe("Grounded response");
    expect(parsed.sources).toEqual([]);
    expect(parsed.mode).toBe("explain");
  });

  it("sends tutor question and returns grounded response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          answer: "RDD stands for Resilient Distributed Dataset.",
          sources: [],
          mode: "explain",
        }),
      ),
    );
    const client = new ApiClient(fetcher);
    const api = new LearningApi(client);
    const signal = new AbortController().signal;

    const res = await api.tutor(
      {
        question: "What is RDD?",
        mode: "explain",
        lesson_id: "l1",
        course_id: "c1",
      },
      signal,
    );
    expect(res.answer).toContain("Resilient Distributed Dataset");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/learning/tutor",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          question: "What is RDD?",
          mode: "explain",
          lesson_id: "l1",
          course_id: "c1",
        }),
      }),
    );
  });
});


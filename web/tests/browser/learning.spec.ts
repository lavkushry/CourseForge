import { test, expect } from "@playwright/test";
import { installContractFixture } from "./fixture";
import { installLearningFixture } from "./learning-fixture";
import type { Page } from "@playwright/test";
async function open(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email address").fill("learner@example.test");
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Open course" }).click();
  if (await page.locator("#lesson-list").isVisible())
    await page.locator("#lesson-list button").first().click();
  else {
    await page.getByRole("button", { name: "Lessons", exact: true }).click();
    await page.locator("#drawer-lessons button").first().click();
  }
  await expect(page.locator("#learning-tools")).toBeVisible();
  await expect(page.locator("#player-wrap")).toHaveAttribute(
    "data-state",
    "ready",
  );
}
test.beforeEach(async ({ context }) => {
  await installContractFixture(context);
});
test("bookmarks retain command and timestamp after an uncertain save; paginate, seek and delete safely", async ({
  page,
  context,
}) => {
  const state = await installLearningFixture(context);
  await open(page);
  await page.getByRole("button", { name: "Bookmarks", exact: true }).click();
  await expect(page.getByText("Saved idea 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "More bookmarks" }).click();
  await expect(page.getByText("Saved idea 3", { exact: true })).toBeVisible();
  state.dropBookmark = true;
  await page.getByLabel("Bookmark label").fill("<img src=x onerror=alert(1)>");
  await page
    .getByRole("button", { name: "Save bookmark", exact: true })
    .click();
  await expect(page.locator(".learning-status")).toContainText("retry");
  await page
    .getByRole("button", { name: "Save bookmark", exact: true })
    .click();
  await expect(page.locator(".learning-status")).toContainText(
    "Bookmark saved",
  );
  expect(state.bookmarkPosts).toHaveLength(2);
  expect(state.bookmarkPosts[0]).toEqual(state.bookmarkPosts[1]);
  expect(state.bookmarks.filter((b) => b.label.includes("<img"))).toHaveLength(
    1,
  );
  await page.getByRole("button", { name: "More bookmarks" }).click();
  await expect(
    page.getByText("<img src=x onerror=alert(1)>", { exact: true }),
  ).toBeVisible();
  expect(await page.locator("#learning-tools img").count()).toBe(0);
  const first = page.locator(".learning-row").first();
  await first.getByRole("button", { name: "0:01", exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator("#lesson-video")
        .evaluate((v: HTMLVideoElement) => v.currentTime),
    )
    .toBeGreaterThanOrEqual(1);
  await first.getByRole("button", { name: "Delete bookmark" }).click();
  await expect(page.getByText("Saved idea 1", { exact: true })).toHaveCount(0);
});
test("quiz solutions appear only after grading and uncertain retry creates one private attempt", async ({
  page,
  context,
}) => {
  const state = await installLearningFixture(context);
  await open(page);
  await page.getByRole("button", { name: "Lesson quiz", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "1. What protects playback ownership?" }),
  ).toBeVisible();
  await expect(
    page.getByText("A lease protects playback ownership.", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Submit quiz" }).click();
  expect(state.quizPosts).toHaveLength(0);
  await page.getByLabel("A lease", { exact: true }).check();
  await page.getByLabel("After acknowledgement", { exact: true }).check();
  state.dropQuiz = true;
  await page.getByRole("button", { name: "Submit quiz" }).click();
  await expect(page.locator(".learning-status")).toContainText("retry");
  await page.getByRole("button", { name: "Submit quiz" }).click();
  await expect(page.locator(".quiz-result")).toContainText("100% · Passed");
  expect(state.quizAttempts).toHaveLength(1);
  expect(state.quizPosts[0]).toBe(state.quizPosts[1]);
  await expect(page.locator("#drawer-lessons .learned-badge")).toHaveText(
    "✓ Learned",
  );
  await expect(page.locator(".quiz-result")).toContainText(
    "A lease protects playback ownership.",
  );
  await page
    .locator(".quiz-result")
    .getByRole("button", { name: "Review at 0:04" })
    .click();
  await expect
    .poll(() =>
      page
        .locator("#lesson-video")
        .evaluate((v: HTMLVideoElement) => v.currentTime),
    )
    .toBeGreaterThanOrEqual(4);
  await page.locator(".learning-attempt summary").click();
  await expect(page.locator(".learning-attempt")).toContainText(
    "Correct choice: 1",
  );
  state.quizPending = true;
  await page.getByRole("button", { name: "Reload quiz" }).click();
  await expect(page.getByText(/quiz is awaiting approval/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit quiz" })).toHaveCount(
    0,
  );
  await expect(page.locator(".learning-attempt")).toHaveCount(1);
});
test("private review reveal, grade and completion survive uncertain retries without repeated credit", async ({
  page,
  context,
}) => {
  const state = await installLearningFixture(context);
  await open(page);
  await page.getByRole("button", { name: "Review cards", exact: true }).click();
  await page.getByLabel("Card question").fill("What confirms a saved record?");
  await page.getByLabel("Card answer").fill("A committed acknowledgement.");
  await page
    .getByRole("button", { name: "Create review card", exact: true })
    .click();
  await expect(page.locator(".learning-status")).toContainText(
    "review card is saved",
  );
  await page.getByRole("button", { name: "Review card", exact: true }).click();
  await expect(page.locator(".review-answer")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "4 · Remembered" }),
  ).toBeHidden();
  await page.getByRole("button", { name: "Reveal answer" }).click();
  await expect(page.locator(".review-answer")).toBeVisible();
  state.dropGrade = true;
  await page.getByRole("button", { name: "4 · Remembered" }).click();
  await expect(page.locator(".learning-status")).toContainText("retry");
  await page.getByRole("button", { name: "4 · Remembered" }).click();
  await expect(page.locator(".review-study")).toContainText("Recall saved");
  expect(state.reviewAttempts).toHaveLength(1);
  expect(state.gradePosts[0]).toBe(state.gradePosts[1]);
  state.dropComplete = true;
  await page.getByRole("button", { name: "Finish review" }).click();
  await expect(page.locator(".learning-status")).toContainText("retry");
  await page.getByRole("button", { name: "Finish review" }).click();
  await expect(page.locator(".learning-status")).toContainText(
    "Review saved · 1 cards",
  );
  expect(state.completions).toBe(1);
  expect(state.completePosts[0]).toBe(state.completePosts[1]);
  await expect(
    page.getByRole("button", { name: "Finish review" }),
  ).toBeDisabled();
  await expect(page.getByText("Recall 4/5", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "All cards", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Review card", exact: true }),
  ).toBeVisible();
});
test("stale quiz revision stays visible and requires reload before a new accepted attempt", async ({
  page,
  context,
}) => {
  const state = await installLearningFixture(context);
  await open(page);
  await page.getByRole("button", { name: "Lesson quiz", exact: true }).click();
  await page.getByLabel("A lease", { exact: true }).check();
  await page.getByLabel("After acknowledgement", { exact: true }).check();
  state.staleQuiz = true;
  await page.getByRole("button", { name: "Submit quiz" }).click();
  await expect(page.locator(".learning-status")).toContainText(
    "Reload this tool",
  );
  expect(state.quizAttempts).toHaveLength(0);
  await page.getByRole("button", { name: "Reload quiz" }).click();
  await page.getByLabel("A lease", { exact: true }).check();
  await page.getByLabel("After acknowledgement", { exact: true }).check();
  await page.getByRole("button", { name: "Submit quiz" }).click();
  await expect(page.locator(".quiz-result")).toContainText("Passed");
  expect(state.quizAttempts[0]?.revision).toBe(2);
});
test("lesson navigation cancels late private results and authorization loss clears learning tools", async ({
  page,
  context,
}) => {
  const state = await installLearningFixture(context);
  await open(page);
  state.bookmarkDelay = 1200;
  await page.getByRole("button", { name: "Bookmarks", exact: true }).click();
  await page
    .getByRole("button", { name: "Next lesson →", exact: true })
    .click();
  await expect(page.locator("#lesson-title")).toContainText("Lesson 2");
  await expect(page.locator(".learning-panel")).toContainText("Save a moment");
  await expect(page.getByText("Saved idea 1", { exact: true })).toHaveCount(0);
  state.denied = true;
  await page.getByRole("button", { name: "Lesson quiz", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  await expect(page.locator("#learning-tools")).toHaveCount(0);
});

test("course access denial clears previously loaded learning records without retrying writes", async ({
  page,
  context,
}) => {
  const state = await installLearningFixture(context);
  await open(page);
  await page.getByRole("button", { name: "Bookmarks", exact: true }).click();
  await expect(page.getByText("Saved idea 1", { exact: true })).toBeVisible();
  state.denied = true;
  state.denialStatus = 403;
  await page.getByRole("button", { name: "Lesson quiz", exact: true }).click();
  await expect(page.locator("#learning-tools")).toContainText(
    "Learning tools are unavailable",
  );
  await expect(page.getByText("Saved idea 1", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save bookmark", exact: true }),
  ).toHaveCount(0);
});


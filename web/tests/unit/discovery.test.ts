import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  courseCover,
  measuredTrending,
  parseContinued,
  parseHomeFeed,
  parseSaved,
  parseTrending,
  personalRowsFromHomeFeed,
} from '../../src/discovery/contracts';
import { toTitleCase, cleanLessonTitle, formatModuleBadge, createSvgThumbnailDataUri } from '../../src/discovery/view';

describe('untrusted discovery responses', () => {
  it('accepts saved course and lesson ownership metadata, including empty lists', () => {
    expect(parseSaved({ items: [], next_cursor: '' })).toEqual({ items: [], next_cursor: null });
    expect(
      parseSaved({ items: [{ id: 'lesson', item_type: 'lecture', course_id: 'course', title: 'Lesson' }] }).items[0]
        ?.course_id,
    ).toBe('course');
  });
  it('rejects unknown saved types, missing course scope and unbounded lists', () => {
    expect(() => parseSaved({ items: [{ id: 'x', item_type: 'user', title: 'x', course_id: 'x' }] })).toThrow();
    expect(() => parseSaved({ items: [{ id: 'x', item_type: 'course', title: 'x' }] })).toThrow();
    expect(() => parseSaved({ items: Array(101).fill({}) })).toThrow();
  });
  it('rejects invalid progress instead of fabricating resume positions', () => {
    const lesson = {
      id: 'lesson',
      course_id: 'course',
      title: 'Lesson',
      duration_seconds: 30,
      position: 12,
      percent: 30,
      completed: false,
    };
    expect(parseContinued({ items: [lesson] })[0]?.position).toBe(12);
    for (const position of [-1, NaN, Infinity, '12'])
      expect(() => parseContinued({ items: [{ ...lesson, position }] })).toThrow();
  });
  it('uses only same-site authorized cover paths; external URLs cannot track learners', () => {
    const course = { id: 'x', title: 'Title' };
    expect(courseCover({ ...course, cover_url: '/api/v1/courses/x/cover?v=4' })).toBe('/api/v1/courses/x/cover?v=4');
    for (const cover_url of [
      'https://tracker.example/cover',
      '//tracker.example/cover',
      '/api/v1/auth/me',
      'javascript:alert(1)',
    ])
      expect(courseCover({ ...course, cover_url })).toBeNull();
  });
});

describe('dribbble LMS title and badge refinement helpers', () => {
  it('formats titles in clean Title Case preserving acronyms', () => {
    expect(toTitleCase('AI & AGENTS')).toBe('AI & Agents');
    expect(toTitleCase('STUDIO LECTURE')).toBe('Studio Lecture');
    expect(toTitleCase('3d design')).toBe('3D Design');
    expect(toTitleCase('cinema 4d')).toBe('Cinema 4D');
    expect(toTitleCase('GENAI FOUNDATIONS')).toBe('GenAI Foundations');
    expect(toTitleCase('UI/UX DESIGN')).toBe('UI/UX Design');
  });

  it('strips redundant bracketed index and module prefix noise from lesson titles', () => {
    expect(cleanLessonTitle('[002] Module 00 (Python) - Introduction to Python')).toBe('Introduction to Python');
    expect(cleanLessonTitle('[001] [HD] 1. Setting up Environment')).toBe('Setting up Environment');
    expect(cleanLessonTitle('Lecture 01: Getting Started')).toBe('Getting Started');
    expect(cleanLessonTitle('[418] Module 06 - Live lesson 1')).toBe('Live lesson 1');
    expect(
      cleanLessonTitle(
        '[061] Module 09 (2. Concepts — 7. Observability in Distributed Systems) - Conclusion to Observability',
      ),
    ).toBe('Conclusion to Observability');
    expect(cleanLessonTitle('[Module 05 Study 31] NOTES')).toBe('NOTES');
    expect(cleanLessonTitle('Lesson 1 — Playback and progress')).toBe('Lesson 1 — Playback and progress');
    expect(cleanLessonTitle('Lesson 2')).toBe('Lesson 2');
    expect(cleanLessonTitle('[226] Week 18 Web Development React Part 1 15052026')).toBe('Web Development React Part 1');
    expect(
      cleanLessonTitle(
        '[044] Module 12 (Case Study 1 — Payment Tracking App (Splitwise) Design & Machine Coding) - Simplified Balances algorithm 1',
      ),
    ).toBe('Simplified Balances algorithm 1');
    expect(cleanLessonTitle('[045] Module 08 (LangChain) Day 44 Tool Calling, Custom Tools & LangChain Agents')).toBe(
      'Day 44 Tool Calling, Custom Tools & LangChain Agents',
    );
  });

  it('shortens module badges concisely to Title Case Module X / Week X', () => {
    expect(formatModuleBadge('MODULE 1 — PYTHON & GENAI FOUNDATIONS')).toBe('Module 1');
    expect(formatModuleBadge('Module 02: Advanced Concepts')).toBe('Module 2');
    expect(formatModuleBadge('Week 09 (Apache Spark...)')).toBe('Week 9');
    expect(formatModuleBadge('Milestone 01 (Lending Club...)')).toBe('Milestone 1');
    expect(formatModuleBadge('Chapter 03: Distributed Systems')).toBe('Chapter 3');
    expect(formatModuleBadge('Distributed Systems Foundations')).toBe('Distributed Systems');
    expect(formatModuleBadge(undefined)).toBe('Module 1');
    expect(formatModuleBadge('')).toBe('Module 1');
  });

  it('generates rich topic-themed SVG thumbnail posters', () => {
    const uri = createSvgThumbnailDataUri('Introduction to Python', 'Engineering');
    expect(uri.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    expect(decodeURIComponent(uri)).toContain('<svg');
    expect(decodeURIComponent(uri)).toContain('Introduction to Python');
  });
});

describe('streaming feed honesty parsers', () => {
  const measured = {
    rank: 1,
    lesson_id: 'lesson-z',
    title: 'First',
    course_id: 'course-a',
    duration_seconds: 120,
    viewers: 2,
  };

  it('accepts measured trending ranks and rejects zero-viewer popularity chrome', () => {
    expect(parseTrending({ items: [measured] })[0]?.viewers).toBe(2);
    expect(measuredTrending(parseTrending({ items: [measured] }))).toHaveLength(1);
    expect(() => parseTrending({ items: [{ ...measured, viewers: 0 }] })).toThrow();
    expect(() => parseTrending({ items: [{ ...measured, rank: 0 }] })).toThrow();
  });

  it('allows ranked home-feed rows only when trending items are measured', () => {
    const feed = parseHomeFeed({
      hero: [{ id: 'course-a', title: 'Published A' }],
      rows: [
        { id: 'continue-watching', title: 'Continue Watching', kind: 'lecture_card', items: [] },
        { id: 'trending-top-10', title: 'Top 10 This Week', kind: 'rank_card', items: [measured] },
        { id: 'featured-titles', title: 'Featured Titles', kind: 'course_card', items: [] },
      ],
    });
    expect(feed.rows.some(row => row.kind === 'rank_card')).toBe(true);
    expect(() =>
      parseHomeFeed({
        hero: [],
        rows: [{ id: 'trending-top-10', title: 'Top 10 This Week', kind: 'rank_card', items: [] }],
      }),
    ).toThrow();
    expect(() =>
      parseHomeFeed({
        hero: [],
        rows: [{ id: 'fake-rank', title: 'Top 10', kind: 'rank_card', items: [measured] }],
      }),
    ).toThrow();
  });

  it('extracts continue/saved/trending from home-feed without inventing rows', () => {
    const lesson = {
      id: 'lesson-z',
      course_id: 'course-a',
      title: 'Lesson',
      duration_seconds: 30,
      position: 12,
      percent: 30,
      completed: false,
    };
    const feed = parseHomeFeed({
      hero: [{ id: 'course-a', title: 'Published A' }],
      rows: [
        { id: 'continue-watching', title: 'Continue Watching', kind: 'lecture_card', items: [lesson] },
        {
          id: 'my-list',
          title: 'My List',
          kind: 'saved_card',
          items: [{ id: 'course-a', item_type: 'course', course_id: 'course-a', title: 'Published A' }],
        },
        { id: 'trending-top-10', title: 'Top 10 This Week', kind: 'rank_card', items: [measured] },
      ],
    });
    const personal = personalRowsFromHomeFeed(feed);
    expect(personal.continued[0]?.position).toBe(12);
    expect(personal.saved[0]?.id).toBe('course-a');
    expect(personal.trending[0]?.viewers).toBe(2);
    expect(personalRowsFromHomeFeed(parseHomeFeed({ hero: [], rows: [] }))).toEqual({
      continued: [],
      saved: [],
      trending: [],
    });
  });
});

describe('discovery honesty chrome', () => {
  it('does not ship fabricated Match/% popularity or unverified tech badges', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../src/discovery');
    const view = readFileSync(join(root, 'view.ts'), 'utf8');
    const syllabus = readFileSync(join(root, 'syllabus-dialog.ts'), 'utf8');
    expect(view).not.toMatch(/98%\s*Match/);
    expect(view).not.toMatch(/hero-badge-match/);
    expect(view).not.toMatch(/4K Ultra HD/);
    expect(view).not.toMatch(/Dolby Audio/);
    expect(view).not.toMatch(/Top 10 Masterclasses/);
    expect(view).toMatch(/measuredTrending/);
    expect(view).toMatch(/Top 10 This Week/);
    expect(syllabus).not.toMatch(/1080p HD/);
  });
});

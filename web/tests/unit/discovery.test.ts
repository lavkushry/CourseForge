import { describe, expect, it } from 'vitest';
import { courseCover, parseContinued, parseSaved } from '../../src/discovery/contracts';

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

import { toTitleCase, cleanLessonTitle, formatModuleBadge, createSvgThumbnailDataUri } from '../../src/discovery/view';

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
    expect(cleanLessonTitle('[044] Module 12 (Case Study 1 — Payment Tracking App (Splitwise) Design & Machine Coding) - Simplified Balances algorithm 1')).toBe('Simplified Balances algorithm 1');
    expect(cleanLessonTitle('[045] Module 08 (LangChain) Day 44 Tool Calling, Custom Tools & LangChain Agents')).toBe('Day 44 Tool Calling, Custom Tools & LangChain Agents');
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

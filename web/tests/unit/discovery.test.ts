import { describe, expect, it } from 'vitest';
import { courseCover, parseContinued, parseSaved } from '../../src/discovery/contracts';

describe('untrusted discovery responses', () => {
  it('accepts saved course and lesson ownership metadata, including empty lists', () => {
    expect(parseSaved({ items: [], next_cursor: '' })).toEqual({ items: [], next_cursor: null });
    expect(parseSaved({ items: [{ id: 'lesson', item_type: 'lecture', course_id: 'course', title: 'Lesson' }] }).items[0]?.course_id).toBe('course');
  });
  it('rejects unknown saved types, missing course scope and unbounded lists', () => {
    expect(() => parseSaved({ items: [{ id: 'x', item_type: 'user', title: 'x', course_id: 'x' }] })).toThrow();
    expect(() => parseSaved({ items: [{ id: 'x', item_type: 'course', title: 'x' }] })).toThrow();
    expect(() => parseSaved({ items: Array(101).fill({}) })).toThrow();
  });
  it('rejects invalid progress instead of fabricating resume positions', () => {
    const lesson = { id: 'lesson', course_id: 'course', title: 'Lesson', duration_seconds: 30, position: 12, percent: 30, completed: false };
    expect(parseContinued({ items: [lesson] })[0]?.position).toBe(12);
    for (const position of [-1, NaN, Infinity, '12']) expect(() => parseContinued({ items: [{ ...lesson, position }] })).toThrow();
  });
  it('uses only same-site authorized cover paths; external URLs cannot track learners', () => {
    const course = { id: 'x', title: 'Title' };
    expect(courseCover({ ...course, cover_url: '/api/v1/courses/x/cover?v=4' })).toBe('/api/v1/courses/x/cover?v=4');
    for (const cover_url of ['https://tracker.example/cover', '//tracker.example/cover', '/api/v1/auth/me', 'javascript:alert(1)']) expect(courseCover({ ...course, cover_url })).toBeNull();
  });
});

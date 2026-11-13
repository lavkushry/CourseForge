import { describe, expect, it } from 'vitest';
import { parseLabsCatalog } from '../../src/api/labs';

describe('labs catalog honesty', () => {
  it('parses curated labs and grading availability flags', () => {
    const parsed = parseLabsCatalog({
      labs: [
        {
          slug: 'sql-customer-revenue',
          title: 'SQL: revenue per customer',
          type: 'sql',
          objective: 'Aggregate paid revenue',
          filename: 'solution.sql',
          tip: 'GROUP BY customer',
          category: 'SQL',
          level: 'Intermediate',
        },
      ],
      grading_available: false,
      kind_available: false,
    });
    expect(parsed.labs).toHaveLength(1);
    expect(parsed.labs[0]?.slug).toBe('sql-customer-revenue');
    expect(parsed.grading_available).toBe(false);
    expect(parsed.kind_available).toBe(false);
  });

  it('requires grading_available === true (never coerces missing flags to online)', () => {
    const parsed = parseLabsCatalog({ labs: [] });
    expect(parsed.grading_available).toBe(false);
    expect(parsed.kind_available).toBe(false);
  });

  it('rejects malformed catalog payloads', () => {
    expect(() => parseLabsCatalog(null)).toThrow();
    expect(() => parseLabsCatalog({ labs: [{ title: 'missing slug' }] })).toThrow();
  });
});

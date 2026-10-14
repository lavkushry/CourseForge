import { describe, expect, it } from 'vitest';
import {
  parseCompanies,
  parseFact,
  parseHiringProfile,
  parseMatchResult,
  parseRoleTracks,
} from '../../src/career/contracts';

describe('Career contracts', () => {
  it('parses seeded role tracks with section order and keyword weights', () => {
    const parsed = parseRoleTracks({
      tracks: [
        {
          id: 'backend',
          title: 'Backend Engineer',
          description: 'APIs and services',
          section_order: ['summary', 'experience', 'skills'],
          keywords: {
            skills: [{ term: 'api design', weight: 5 }],
            tools: [{ term: 'go', weight: 5, frequency: 2 }],
          },
        },
      ],
    });
    expect(parsed.tracks).toHaveLength(1);
    expect(parsed.tracks[0]!.id).toBe('backend');
    expect(parsed.tracks[0]!.section_order).toEqual(['summary', 'experience', 'skills']);
    expect(parsed.tracks[0]!.keywords.tools![0]!.term).toBe('go');
    expect(parsed.tracks[0]!.keywords.tools![0]!.weight).toBe(5);
  });

  it('parses company list and hiring profile frequencies', () => {
    const companies = parseCompanies({
      companies: [
        {
          id: 'co_1',
          name: 'Acme',
          notes: '',
          jd_count: 3,
          created_at: '2026-10-01T00:00:00Z',
          updated_at: '2026-10-02T00:00:00Z',
        },
      ],
    });
    expect(companies.companies[0]!.jd_count).toBe(3);

    const profile = parseHiringProfile({
      company_id: 'co_1',
      company_name: 'Acme',
      jd_count: 3,
      skills: [{ term: 'ci/cd', weight: 2, frequency: 2 }],
      tools: [{ term: 'kubernetes', weight: 3, frequency: 3 }],
      seniority_signals: [{ term: 'senior', weight: 2, frequency: 2 }],
      updated_at: '2026-10-02T00:00:00Z',
    });
    expect(profile.tools[0]!.frequency).toBe(3);
    expect(profile.skills[0]!.term).toBe('ci/cd');
  });

  it('parses match results and never treats missing metrics as invented values', () => {
    const match = parseMatchResult({
      track_id: 'backend',
      company_id: 'co_1',
      score: 62.5,
      matched_keywords: [{ term: 'go', weight: 5, category: 'tools' }],
      missing_keywords: [{ term: 'redis', weight: 4, category: 'tools' }],
      suggested_bullets: [
        {
          fact_id: 'fact_1',
          text: 'Built API gateway cut latency ([METRIC])',
          missing_metric: true,
          metric_placeholder: '[METRIC]',
          matched_keywords: ['go'],
          source_only: true,
        },
      ],
      extraction_source: 'hiring_profile',
      jd_keywords: { skills: ['api design'], tools: ['go'], seniority_signals: ['senior'] },
    });
    expect(match.score).toBe(62.5);
    expect(match.matched_keywords[0]!.term).toBe('go');
    expect(match.missing_keywords[0]!.term).toBe('redis');
    expect(match.suggested_bullets[0]!.missing_metric).toBe(true);
    expect(match.suggested_bullets[0]!.text).toContain('[METRIC]');
    expect(match.suggested_bullets[0]!.source_only).toBe(true);
  });

  it('parses confirmed facts with nullable metrics', () => {
    const withMetric = parseFact({
      id: 'f1',
      action: 'Shipped service',
      impact: 'improved uptime',
      metric: '99.9%',
      skills: ['go'],
      confirmed: true,
      created_at: '2026-10-01T00:00:00Z',
    });
    expect(withMetric.metric).toBe('99.9%');

    const without = parseFact({
      id: 'f2',
      action: 'Migrated DB',
      impact: 'reduced risk',
      metric: null,
      skills: ['postgresql'],
      confirmed: true,
      created_at: '2026-10-01T00:00:00Z',
    });
    expect(without.metric).toBeNull();
  });

  it('rejects malformed career payloads', () => {
    expect(() => parseRoleTracks(null)).toThrow();
    expect(() => parseCompanies({ companies: 'nope' })).toThrow();
    expect(() => parseMatchResult('bad')).toThrow();
  });
});

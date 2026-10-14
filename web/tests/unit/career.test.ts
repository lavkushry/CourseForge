import { describe, expect, it } from 'vitest';
import {
  emptyResumeDraft,
  parseApplications,
  parseCompanies,
  parseFact,
  parseHiringProfile,
  parseMatchResult,
  parseResumeVersion,
  parseRoleTracks,
  parseTemplates,
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

  it('parses resume templates, applications, and skim-scored versions', () => {
    const templates = parseTemplates({
      templates: [
        { id: 'ats_classic', name: 'ATS Classic', description: 'Single column' },
        { id: 'ats_compact', name: 'ATS Compact', description: 'Tighter' },
      ],
    });
    expect(templates.templates).toHaveLength(2);
    expect(templates.templates[0]!.id).toBe('ats_classic');

    const apps = parseApplications({
      applications: [
        {
          id: 'app_1',
          title: 'Backend Engineer',
          notes: '',
          target_skills: ['go', 'postgresql'],
          resume_draft: {
            ...emptyResumeDraft('Backend Engineer'),
            full_name: 'Casey Dev',
            email: 'casey@example.test',
            skills: ['go'],
            experience: [
              {
                company: 'Acme',
                role: 'Backend Engineer',
                start: '2021',
                end: 'Present',
                bullets: ['Cut p99 latency 40%', 'Improved cache hit rate [METRIC]'],
              },
            ],
          },
          created_at: '2026-10-01T00:00:00Z',
          updated_at: '2026-10-02T00:00:00Z',
        },
      ],
    });
    expect(apps.applications[0]!.resume_draft.experience[0]!.bullets[1]).toContain('[METRIC]');
    expect(apps.applications[0]!.target_skills).toEqual(['go', 'postgresql']);

    const version = parseResumeVersion({
      id: 'rv_1',
      application_id: 'app_1',
      template_id: 'ats_classic',
      snapshot: apps.applications[0]!.resume_draft,
      status: 'ready',
      compiler: 'tectonic',
      skim_score: {
        score: 85,
        feedback: [
          { code: 'title_in_top_third', ok: true, message: 'Title visible' },
          { code: 'quantified_metrics', ok: true, message: 'Metrics visible' },
          { code: 'jd_skills_visible', ok: false, message: 'Surface postgresql earlier' },
        ],
      },
      verified_fields: ['full_name', 'title'],
      has_pdf: true,
      created_at: '2026-10-02T00:00:00Z',
      updated_at: '2026-10-02T00:00:00Z',
      latex_source: '\\documentclass{article}',
    });
    expect(version.has_pdf).toBe(true);
    expect(version.skim_score?.score).toBe(85);
    expect(version.skim_score?.feedback[2]!.ok).toBe(false);
    expect(version.latex_source).toContain('documentclass');
  });
});

import { describe, expect, it } from 'vitest';
import {
  APPLICATION_CSV_COLUMNS,
  APPLICATION_CSV_FORMAT_DOCS,
  emptyResumeDraft,
  parseAlertSources,
  parseAnalyticsReport,
  parseApplications,
  parseCompanies,
  parseCSVImportReport,
  parseFact,
  parseHiringProfile,
  parseMatchResult,
  parseNotifications,
  parseReferralContacts,
  parseReferralDraft,
  parseResumeVersion,
  parseRoleTracks,
  parseTemplates,
  validateApplicationCSVHeader,
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
      skill_bridges: [
        {
          skill: 'redis',
          courses: [{ id: 'course-redis', title: 'Caching with Redis', href: '#courses' }],
          lessons: [{ id: 'lesson-1', title: 'Redis basics', course_id: 'course-redis', href: '#learning/lesson-1' }],
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
    expect(match.skill_bridges[0]!.skill).toBe('redis');
    expect(match.skill_bridges[0]!.lessons[0]!.href).toContain('lesson-1');
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
          status: 'callback',
          applied_at: '2026-10-01T00:00:00Z',
          callback_at: '2026-10-05T00:00:00Z',
          resume_version_type: 'tailored',
          posting_date: '2026-09-28',
          applied_days_after_posting: 3,
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
    expect(apps.applications[0]!.status).toBe('callback');
    expect(apps.applications[0]!.resume_version_type).toBe('tailored');
    expect(apps.applications[0]!.applied_days_after_posting).toBe(3);

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

  it('documents application CSV columns and validates headers', () => {
    expect(APPLICATION_CSV_COLUMNS).toContain('company');
    expect(APPLICATION_CSV_COLUMNS).toContain('resume_version_type');
    expect(APPLICATION_CSV_FORMAT_DOCS.toLowerCase()).toContain('company');
    expect(validateApplicationCSVHeader('company,role,status\nAcme,SRE,applied').ok).toBe(true);
    expect(validateApplicationCSVHeader('role,status\nx,applied').missing).toEqual(['company']);
  });

  it('parses analytics with Wilson intervals and unreliable n warning', () => {
    const report = parseAnalyticsReport({
      total_applications: 12,
      min_reliable_n: 100,
      warning: 'n<100: result is not statistically reliable',
      by_resume_version: [],
      by_version_type: [
        {
          key: 'original',
          label: 'original',
          callback: {
            label: 'original callback',
            n: 8,
            successes: 2,
            rate: 0.25,
            wilson_low: 0.07,
            wilson_high: 0.59,
            wilson_ok: true,
            unreliable: true,
            unreliable_note: 'n<100: result is not statistically reliable',
          },
          interview: {
            label: 'original interview',
            n: 8,
            successes: 1,
            rate: 0.125,
            wilson_low: 0.02,
            wilson_high: 0.47,
            wilson_ok: true,
            unreliable: true,
          },
        },
      ],
      by_role_track: [],
      by_company: [],
      by_rejection_reason: [],
      by_applied_days: [
        {
          key: '0-1',
          label: '0-1',
          callback: {
            label: '0-1 callback',
            n: 3,
            successes: 1,
            rate: 0.333,
            wilson_low: 0.06,
            wilson_high: 0.79,
            wilson_ok: true,
            unreliable: true,
          },
          interview: {
            label: '0-1 interview',
            n: 3,
            successes: 0,
            rate: 0,
            wilson_low: 0,
            wilson_high: 0.56,
            wilson_ok: true,
            unreliable: true,
          },
        },
      ],
      matched_pairs: [
        {
          company_id: 'co_1',
          company_name: 'Acme',
          track_id: 'backend',
          original_callback: {
            label: 'original callback',
            n: 5,
            successes: 1,
            rate: 0.2,
            wilson_low: 0.04,
            wilson_high: 0.62,
            wilson_ok: true,
            unreliable: true,
          },
          tailored_callback: {
            label: 'tailored callback',
            n: 5,
            successes: 3,
            rate: 0.6,
            wilson_low: 0.23,
            wilson_high: 0.88,
            wilson_ok: true,
            unreliable: true,
          },
          original_interview: {
            label: 'original interview',
            n: 5,
            successes: 0,
            rate: 0,
            wilson_low: 0,
            wilson_high: 0.43,
            wilson_ok: true,
            unreliable: true,
          },
          tailored_interview: {
            label: 'tailored interview',
            n: 5,
            successes: 2,
            rate: 0.4,
            wilson_low: 0.12,
            wilson_high: 0.77,
            wilson_ok: true,
            unreliable: true,
          },
        },
      ],
    });
    expect(report.warning).toContain('not statistically reliable');
    expect(report.by_version_type[0]!.callback.unreliable).toBe(true);
    expect(report.matched_pairs[0]!.tailored_callback.successes).toBe(3);
    expect(report.by_applied_days[0]!.key).toBe('0-1');
  });

  it('parses CSV import reports and clipboard-only referral drafts', () => {
    const importReport = parseCSVImportReport({
      columns: [...APPLICATION_CSV_COLUMNS],
      dry_run: true,
      total_rows: 2,
      valid_rows: 1,
      invalid_rows: 1,
      created: 0,
      errors: [{ row: 3, field: 'status', message: 'invalid status' }],
      preview: [{ company: 'Acme', role: 'SRE', status: 'applied' }],
      format_docs: APPLICATION_CSV_FORMAT_DOCS,
    });
    expect(importReport.dry_run).toBe(true);
    expect(importReport.errors[0]!.field).toBe('status');
    expect(importReport.preview).toHaveLength(1);

    const contacts = parseReferralContacts({
      contacts: [
        {
          id: 'rc_1',
          name: 'Ada',
          company: 'Acme',
          relation: 'alumni',
          link: '',
          created_at: '2026-10-01T00:00:00Z',
        },
      ],
    });
    expect(contacts.contacts[0]!.relation).toBe('alumni');

    const draft = parseReferralDraft({
      contact_id: 'rc_1',
      contact_name: 'Ada',
      company: 'Acme',
      role: 'SRE',
      message: 'Hi Ada…',
      delivery: 'clipboard_only',
    });
    expect(draft.delivery).toBe('clipboard_only');
  });

  it('parses apply-early alert sources and in-app notifications', () => {
    const sources = parseAlertSources({
      sources: [
        {
          id: 'src_1',
          provider: 'greenhouse',
          board_token: 'acme',
          label: 'Acme GH',
          track_id: 'backend',
          keywords: ['go', 'kubernetes'],
          enabled: true,
          next_poll_at: '2026-10-14T12:00:00Z',
          poll_interval_seconds: 900,
          backoff_seconds: 0,
          consecutive_failures: 0,
          last_error: '',
          created_at: '2026-10-14T00:00:00Z',
          updated_at: '2026-10-14T00:00:00Z',
        },
      ],
    });
    expect(sources.sources[0]!.provider).toBe('greenhouse');
    expect(sources.sources[0]!.keywords).toEqual(['go', 'kubernetes']);

    const notifs = parseNotifications({
      notifications: [
        {
          id: 'nt_1',
          kind: 'new_opening',
          title: 'New opening: Backend Engineer',
          body: 'Backend Engineer · Remote · matched: go',
          href: 'https://boards.greenhouse.io/acme/jobs/1',
          read_at: null,
          created_at: '2026-10-14T01:00:00Z',
        },
      ],
    });
    expect(notifs.notifications[0]!.kind).toBe('new_opening');
    expect(notifs.notifications[0]!.read_at).toBeNull();
    expect(notifs.notifications[0]!.href).toContain('greenhouse');
  });
});

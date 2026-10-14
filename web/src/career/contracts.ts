import { ContractError } from '../validation';

export interface KeywordWeight {
  term: string;
  weight: number;
  frequency?: number;
  category?: string;
}

export interface RoleTrack {
  id: string;
  title: string;
  description: string;
  section_order: string[];
  keywords: Record<string, KeywordWeight[]>;
}

export interface Company {
  id: string;
  name: string;
  notes: string;
  jd_count: number;
  created_at: string;
  updated_at: string;
}

export interface ExtractedSignals {
  skills: string[];
  tools: string[];
  seniority_signals: string[];
}

export interface JobDescription {
  id: string;
  company_id: string;
  title: string;
  extracted: ExtractedSignals;
  extraction_source: string;
  created_at: string;
}

export interface HiringProfile {
  company_id: string;
  company_name: string;
  jd_count: number;
  skills: KeywordWeight[];
  tools: KeywordWeight[];
  seniority_signals: KeywordWeight[];
  updated_at: string;
}

export interface ConfirmedFact {
  id: string;
  action: string;
  impact: string;
  metric: string | null;
  skills: string[];
  confirmed: boolean;
  created_at: string;
}

export interface BulletSuggestion {
  fact_id: string;
  text: string;
  missing_metric: boolean;
  metric_placeholder?: string;
  matched_keywords: string[];
  source_only: boolean;
}

export interface MatchResult {
  track_id?: string;
  company_id?: string;
  score: number;
  matched_keywords: KeywordWeight[];
  missing_keywords: KeywordWeight[];
  suggested_bullets: BulletSuggestion[];
  extraction_source: string;
  jd_keywords: ExtractedSignals;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new ContractError(label);
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function parseKeyword(value: unknown): KeywordWeight {
  const d = asRecord(value, 'keyword');
  const out: KeywordWeight = {
    term: asString(d.term),
    weight: asNumber(d.weight, 1),
  };
  if (typeof d.frequency === 'number') out.frequency = d.frequency;
  if (typeof d.category === 'string') out.category = d.category;
  return out;
}

function parseSignals(value: unknown): ExtractedSignals {
  const d = asRecord(value || {}, 'signals');
  return {
    skills: asStringArray(d.skills),
    tools: asStringArray(d.tools),
    seniority_signals: asStringArray(d.seniority_signals),
  };
}

export function parseRoleTracks(value: unknown): { tracks: RoleTrack[] } {
  const d = asRecord(value, 'role tracks');
  if (!Array.isArray(d.tracks)) throw new ContractError('tracks array');
  return { tracks: d.tracks.map(parseRoleTrack) };
}

export function parseRoleTrack(value: unknown): RoleTrack {
  const d = asRecord(value, 'role track');
  const rawKeywords = asRecord(d.keywords || {}, 'keywords');
  const keywords: Record<string, KeywordWeight[]> = {};
  for (const [key, list] of Object.entries(rawKeywords)) {
    keywords[key] = Array.isArray(list) ? list.map(parseKeyword) : [];
  }
  return {
    id: asString(d.id),
    title: asString(d.title),
    description: asString(d.description),
    section_order: asStringArray(d.section_order),
    keywords,
  };
}

export function parseCompanies(value: unknown): { companies: Company[] } {
  const d = asRecord(value, 'companies');
  if (!Array.isArray(d.companies)) throw new ContractError('companies array');
  return { companies: d.companies.map(parseCompany) };
}

export function parseCompany(value: unknown): Company {
  const d = asRecord(value, 'company');
  return {
    id: asString(d.id),
    name: asString(d.name),
    notes: asString(d.notes),
    jd_count: asNumber(d.jd_count),
    created_at: asString(d.created_at),
    updated_at: asString(d.updated_at),
  };
}

export function parseJobDescriptions(value: unknown): { job_descriptions: JobDescription[] } {
  const d = asRecord(value, 'job descriptions');
  if (!Array.isArray(d.job_descriptions)) throw new ContractError('job_descriptions array');
  return { job_descriptions: d.job_descriptions.map(parseJobDescription) };
}

export function parseJobDescription(value: unknown): JobDescription {
  const d = asRecord(value, 'job description');
  return {
    id: asString(d.id),
    company_id: asString(d.company_id),
    title: asString(d.title),
    extracted: parseSignals(d.extracted),
    extraction_source: asString(d.extraction_source),
    created_at: asString(d.created_at),
  };
}

export function parseHiringProfile(value: unknown): HiringProfile {
  const d = asRecord(value, 'hiring profile');
  return {
    company_id: asString(d.company_id),
    company_name: asString(d.company_name),
    jd_count: asNumber(d.jd_count),
    skills: Array.isArray(d.skills) ? d.skills.map(parseKeyword) : [],
    tools: Array.isArray(d.tools) ? d.tools.map(parseKeyword) : [],
    seniority_signals: Array.isArray(d.seniority_signals) ? d.seniority_signals.map(parseKeyword) : [],
    updated_at: asString(d.updated_at),
  };
}

export function parseFacts(value: unknown): { facts: ConfirmedFact[] } {
  const d = asRecord(value, 'facts');
  if (!Array.isArray(d.facts)) throw new ContractError('facts array');
  return { facts: d.facts.map(parseFact) };
}

export function parseFact(value: unknown): ConfirmedFact {
  const d = asRecord(value, 'fact');
  return {
    id: asString(d.id),
    action: asString(d.action),
    impact: asString(d.impact),
    metric: typeof d.metric === 'string' ? d.metric : null,
    skills: asStringArray(d.skills),
    confirmed: Boolean(d.confirmed),
    created_at: asString(d.created_at),
  };
}

export function parseMatchResult(value: unknown): MatchResult {
  const d = asRecord(value, 'match result');
  const result: MatchResult = {
    score: asNumber(d.score),
    matched_keywords: Array.isArray(d.matched_keywords) ? d.matched_keywords.map(parseKeyword) : [],
    missing_keywords: Array.isArray(d.missing_keywords) ? d.missing_keywords.map(parseKeyword) : [],
    suggested_bullets: Array.isArray(d.suggested_bullets)
      ? d.suggested_bullets.map((b) => {
          const item = asRecord(b, 'bullet');
          const bullet: BulletSuggestion = {
            fact_id: asString(item.fact_id),
            text: asString(item.text),
            missing_metric: Boolean(item.missing_metric),
            matched_keywords: asStringArray(item.matched_keywords),
            source_only: Boolean(item.source_only),
          };
          if (typeof item.metric_placeholder === 'string') bullet.metric_placeholder = item.metric_placeholder;
          return bullet;
        })
      : [],
    extraction_source: asString(d.extraction_source),
    jd_keywords: parseSignals(d.jd_keywords),
  };
  if (typeof d.track_id === 'string') result.track_id = d.track_id;
  if (typeof d.company_id === 'string') result.company_id = d.company_id;
  return result;
}

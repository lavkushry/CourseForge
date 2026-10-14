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

export interface ResumeExperience {
  company: string;
  role: string;
  location?: string;
  start: string;
  end: string;
  bullets: string[];
}

export interface ResumeEducation {
  institution: string;
  degree: string;
  year: string;
  details?: string;
}

export interface ResumeProject {
  name: string;
  description: string;
  bullets?: string[];
  url?: string;
}

export interface ResumeDocument {
  full_name: string;
  email: string;
  phone?: string;
  location?: string;
  title: string;
  summary?: string;
  skills: string[];
  experience: ResumeExperience[];
  education: ResumeEducation[];
  projects?: ResumeProject[];
}

export interface Application {
  id: string;
  company_id?: string;
  company_name?: string;
  track_id?: string;
  title: string;
  notes: string;
  target_skills: string[];
  resume_draft: ResumeDocument;
  created_at: string;
  updated_at: string;
}

export interface SkimFeedback {
  code: string;
  ok: boolean;
  message: string;
}

export interface SkimScore {
  score: number;
  feedback: SkimFeedback[];
}

export interface ResumeVersion {
  id: string;
  application_id: string;
  template_id: string;
  snapshot: ResumeDocument;
  status: string;
  error_message?: string;
  compiler?: string;
  skim_score?: SkimScore;
  verified_fields: string[];
  has_pdf: boolean;
  created_at: string;
  updated_at: string;
  latex_source?: string;
}

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
}

export function emptyResumeDraft(title = ''): ResumeDocument {
  return {
    full_name: '',
    email: '',
    title,
    skills: [],
    experience: [],
    education: [],
    projects: [],
  };
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

export function parseResumeDocument(value: unknown): ResumeDocument {
  const d = asRecord(value || {}, 'resume document');
  const doc: ResumeDocument = {
    full_name: asString(d.full_name),
    email: asString(d.email),
    title: asString(d.title),
    skills: asStringArray(d.skills),
    experience: Array.isArray(d.experience)
      ? d.experience.map((item) => {
          const e = asRecord(item, 'experience');
          const exp: ResumeExperience = {
            company: asString(e.company),
            role: asString(e.role),
            start: asString(e.start),
            end: asString(e.end),
            bullets: asStringArray(e.bullets),
          };
          if (typeof e.location === 'string') exp.location = e.location;
          return exp;
        })
      : [],
    education: Array.isArray(d.education)
      ? d.education.map((item) => {
          const e = asRecord(item, 'education');
          const ed: ResumeEducation = {
            institution: asString(e.institution),
            degree: asString(e.degree),
            year: asString(e.year),
          };
          if (typeof e.details === 'string') ed.details = e.details;
          return ed;
        })
      : [],
  };
  if (typeof d.phone === 'string') doc.phone = d.phone;
  if (typeof d.location === 'string') doc.location = d.location;
  if (typeof d.summary === 'string') doc.summary = d.summary;
  if (Array.isArray(d.projects)) {
    doc.projects = d.projects.map((item) => {
      const p = asRecord(item, 'project');
      const project: ResumeProject = {
        name: asString(p.name),
        description: asString(p.description),
      };
      if (Array.isArray(p.bullets)) project.bullets = asStringArray(p.bullets);
      if (typeof p.url === 'string') project.url = p.url;
      return project;
    });
  }
  return doc;
}

export function parseApplication(value: unknown): Application {
  const d = asRecord(value, 'application');
  const app: Application = {
    id: asString(d.id),
    title: asString(d.title),
    notes: asString(d.notes),
    target_skills: asStringArray(d.target_skills),
    resume_draft: parseResumeDocument(d.resume_draft),
    created_at: asString(d.created_at),
    updated_at: asString(d.updated_at),
  };
  if (typeof d.company_id === 'string') app.company_id = d.company_id;
  if (typeof d.company_name === 'string') app.company_name = d.company_name;
  if (typeof d.track_id === 'string') app.track_id = d.track_id;
  return app;
}

export function parseApplications(value: unknown): { applications: Application[] } {
  const d = asRecord(value, 'applications');
  if (!Array.isArray(d.applications)) throw new ContractError('applications array');
  return { applications: d.applications.map(parseApplication) };
}

export function parseSkimScore(value: unknown): SkimScore | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const d = asRecord(value, 'skim score');
  return {
    score: asNumber(d.score),
    feedback: Array.isArray(d.feedback)
      ? d.feedback.map((item) => {
          const f = asRecord(item, 'skim feedback');
          return { code: asString(f.code), ok: Boolean(f.ok), message: asString(f.message) };
        })
      : [],
  };
}

export function parseResumeVersion(value: unknown): ResumeVersion {
  const d = asRecord(value, 'resume version');
  const version: ResumeVersion = {
    id: asString(d.id),
    application_id: asString(d.application_id),
    template_id: asString(d.template_id),
    snapshot: parseResumeDocument(d.snapshot),
    status: asString(d.status),
    verified_fields: asStringArray(d.verified_fields),
    has_pdf: Boolean(d.has_pdf),
    created_at: asString(d.created_at),
    updated_at: asString(d.updated_at),
  };
  if (typeof d.error_message === 'string') version.error_message = d.error_message;
  if (typeof d.compiler === 'string') version.compiler = d.compiler;
  if (typeof d.latex_source === 'string') version.latex_source = d.latex_source;
  const skim = parseSkimScore(d.skim_score);
  if (skim) version.skim_score = skim;
  return version;
}

export function parseResumeVersions(value: unknown): { versions: ResumeVersion[] } {
  const d = asRecord(value, 'resume versions');
  if (!Array.isArray(d.versions)) throw new ContractError('versions array');
  return { versions: d.versions.map(parseResumeVersion) };
}

export function parseTemplates(value: unknown): { templates: TemplateInfo[] } {
  const d = asRecord(value, 'templates');
  if (!Array.isArray(d.templates)) throw new ContractError('templates array');
  return {
    templates: d.templates.map((item) => {
      const t = asRecord(item, 'template');
      return { id: asString(t.id), name: asString(t.name), description: asString(t.description) };
    }),
  };
}

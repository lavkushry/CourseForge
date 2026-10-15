import { ContractError } from '../validation';
import { asNumber, asRecord, asString, asStringArray } from './contract-helpers';
import type {
  Application,
  ApplicationStatus,
  ResumeDocument,
  ResumeEducation,
  ResumeExperience,
  ResumeProject,
  ResumeVersion,
  ResumeVersionType,
  RejectionReason,
  SkimScore,
  TemplateInfo,
} from './contracts-types';

export function parseResumeDocument(value: unknown): ResumeDocument {
  const d = asRecord(value || {}, 'resume document');
  const doc: ResumeDocument = {
    full_name: asString(d.full_name),
    email: asString(d.email),
    title: asString(d.title),
    skills: asStringArray(d.skills),
    experience: Array.isArray(d.experience)
      ? d.experience.map(item => {
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
      ? d.education.map(item => {
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
    doc.projects = d.projects.map(item => {
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
  const statusRaw = asString(d.status, 'applied');
  const status = (
    ['applied', 'callback', 'interview', 'offer', 'rejected'].includes(statusRaw) ? statusRaw : 'applied'
  ) as ApplicationStatus;
  const versionRaw = asString(d.resume_version_type, 'original');
  const resume_version_type = (versionRaw === 'tailored' ? 'tailored' : 'original') as ResumeVersionType;
  const app: Application = {
    id: asString(d.id),
    title: asString(d.title),
    notes: asString(d.notes),
    target_skills: asStringArray(d.target_skills),
    resume_draft: parseResumeDocument(d.resume_draft),
    status,
    applied_at: asString(d.applied_at, asString(d.created_at)),
    resume_version_type,
    created_at: asString(d.created_at),
    updated_at: asString(d.updated_at),
  };
  if (typeof d.company_id === 'string') app.company_id = d.company_id;
  if (typeof d.company_name === 'string') app.company_name = d.company_name;
  if (typeof d.track_id === 'string') app.track_id = d.track_id;
  if (typeof d.callback_at === 'string') app.callback_at = d.callback_at;
  if (typeof d.interview_at === 'string') app.interview_at = d.interview_at;
  if (typeof d.offer_at === 'string') app.offer_at = d.offer_at;
  if (typeof d.rejected_at === 'string') app.rejected_at = d.rejected_at;
  if (typeof d.resume_version_id === 'string') app.resume_version_id = d.resume_version_id;
  if (typeof d.rejection_reason === 'string') app.rejection_reason = d.rejection_reason as RejectionReason;
  if (typeof d.posting_date === 'string') app.posting_date = d.posting_date;
  if (typeof d.applied_days_after_posting === 'number') app.applied_days_after_posting = d.applied_days_after_posting;
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
      ? d.feedback.map(item => {
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
    templates: d.templates.map(item => {
      const t = asRecord(item, 'template');
      return { id: asString(t.id), name: asString(t.name), description: asString(t.description) };
    }),
  };
}

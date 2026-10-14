import type { ApiClient } from '../api';
import {
  parseApplications,
  parseApplication,
  parseCompanies,
  parseCompany,
  parseFact,
  parseFacts,
  parseHiringProfile,
  parseJobDescription,
  parseJobDescriptions,
  parseMatchResult,
  parseResumeVersion,
  parseResumeVersions,
  parseRoleTrack,
  parseRoleTracks,
  parseTemplates,
  type Application,
  type Company,
  type ConfirmedFact,
  type HiringProfile,
  type JobDescription,
  type MatchResult,
  type ResumeDocument,
  type ResumeVersion,
  type RoleTrack,
  type TemplateInfo,
} from './contracts';

export class CareerApi {
  constructor(private readonly api: ApiClient) {}

  roleTracks(signal?: AbortSignal): Promise<{ tracks: RoleTrack[] }> {
    return this.api.request('/career/role-tracks', { signal }).then(parseRoleTracks);
  }

  roleTrack(id: string, signal?: AbortSignal): Promise<RoleTrack> {
    return this.api.request(`/career/role-tracks/${encodeURIComponent(id)}`, { signal }).then(parseRoleTrack);
  }

  companies(signal?: AbortSignal): Promise<{ companies: Company[] }> {
    return this.api.request('/career/companies', { signal }).then(parseCompanies);
  }

  createCompany(name: string, notes: string, signal?: AbortSignal): Promise<Company> {
    return this.api.request('/career/companies', { method: 'POST', body: { name, notes }, signal }).then(parseCompany);
  }

  company(id: string, signal?: AbortSignal): Promise<Company> {
    return this.api.request(`/career/companies/${encodeURIComponent(id)}`, { signal }).then(parseCompany);
  }

  deleteCompany(id: string, signal?: AbortSignal): Promise<void> {
    return this.api.request(`/career/companies/${encodeURIComponent(id)}`, { method: 'DELETE', signal }).then(() => undefined);
  }

  jobDescriptions(companyId: string, signal?: AbortSignal): Promise<{ job_descriptions: JobDescription[] }> {
    return this.api
      .request(`/career/companies/${encodeURIComponent(companyId)}/job-descriptions`, { signal })
      .then(parseJobDescriptions);
  }

  addJobDescription(companyId: string, title: string, rawText: string, signal?: AbortSignal): Promise<JobDescription> {
    return this.api
      .request(`/career/companies/${encodeURIComponent(companyId)}/job-descriptions`, {
        method: 'POST',
        body: { title, raw_text: rawText },
        signal,
      })
      .then(parseJobDescription);
  }

  hiringProfile(companyId: string, signal?: AbortSignal): Promise<HiringProfile> {
    return this.api
      .request(`/career/companies/${encodeURIComponent(companyId)}/hiring-profile`, { signal })
      .then(parseHiringProfile);
  }

  facts(signal?: AbortSignal): Promise<{ facts: ConfirmedFact[] }> {
    return this.api.request('/career/facts', { signal }).then(parseFacts);
  }

  createFact(input: { action: string; impact: string; metric?: string; skills: string[] }, signal?: AbortSignal): Promise<ConfirmedFact> {
    return this.api.request('/career/facts', { method: 'POST', body: input, signal }).then(parseFact);
  }

  deleteFact(id: string, signal?: AbortSignal): Promise<void> {
    return this.api.request(`/career/facts/${encodeURIComponent(id)}`, { method: 'DELETE', signal }).then(() => undefined);
  }

  match(input: { track_id: string; company_id?: string; jd_text?: string }, signal?: AbortSignal): Promise<MatchResult> {
    return this.api.request('/career/match', { method: 'POST', body: input, signal }).then(parseMatchResult);
  }

  templates(signal?: AbortSignal): Promise<{ templates: TemplateInfo[] }> {
    return this.api.request('/career/templates', { signal }).then(parseTemplates);
  }

  applications(signal?: AbortSignal): Promise<{ applications: Application[] }> {
    return this.api.request('/career/applications', { signal }).then(parseApplications);
  }

  createApplication(
    input: {
      company_id?: string;
      track_id?: string;
      title: string;
      notes?: string;
      target_skills?: string[];
      resume_draft?: ResumeDocument;
    },
    signal?: AbortSignal,
  ): Promise<Application> {
    return this.api.request('/career/applications', { method: 'POST', body: input, signal }).then(parseApplication);
  }

  application(id: string, signal?: AbortSignal): Promise<Application> {
    return this.api.request(`/career/applications/${encodeURIComponent(id)}`, { signal }).then(parseApplication);
  }

  updateApplication(
    id: string,
    input: {
      title?: string;
      notes?: string;
      target_skills?: string[];
      resume_draft?: ResumeDocument;
      company_id?: string;
      track_id?: string;
    },
    signal?: AbortSignal,
  ): Promise<Application> {
    return this.api
      .request(`/career/applications/${encodeURIComponent(id)}`, { method: 'PUT', body: input, signal })
      .then(parseApplication);
  }

  deleteApplication(id: string, signal?: AbortSignal): Promise<void> {
    return this.api.request(`/career/applications/${encodeURIComponent(id)}`, { method: 'DELETE', signal }).then(() => undefined);
  }

  versions(applicationId: string, signal?: AbortSignal): Promise<{ versions: ResumeVersion[] }> {
    return this.api
      .request(`/career/applications/${encodeURIComponent(applicationId)}/versions`, { signal })
      .then(parseResumeVersions);
  }

  generateVersion(applicationId: string, templateId: string, signal?: AbortSignal): Promise<ResumeVersion> {
    return this.api
      .request(`/career/applications/${encodeURIComponent(applicationId)}/versions`, {
        method: 'POST',
        body: { template_id: templateId },
        signal,
      })
      .then(parseResumeVersion);
  }

  version(id: string, signal?: AbortSignal): Promise<ResumeVersion> {
    return this.api.request(`/career/versions/${encodeURIComponent(id)}`, { signal }).then(parseResumeVersion);
  }

  async downloadPdf(versionId: string, signal?: AbortSignal): Promise<Blob> {
    const init: RequestInit = {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/pdf' },
    };
    if (signal) init.signal = signal;
    const response = await this.api.rawFetch(`/api/v1/career/versions/${encodeURIComponent(versionId)}/pdf`, init);
    if (!response.ok) {
      throw new Error(`PDF download failed (${response.status})`);
    }
    return response.blob();
  }
}

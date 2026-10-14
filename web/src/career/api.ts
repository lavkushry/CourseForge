import type { ApiClient } from '../api';
import {
  parseCompanies,
  parseCompany,
  parseFact,
  parseFacts,
  parseHiringProfile,
  parseJobDescription,
  parseJobDescriptions,
  parseMatchResult,
  parseRoleTrack,
  parseRoleTracks,
  type Company,
  type ConfirmedFact,
  type HiringProfile,
  type JobDescription,
  type MatchResult,
  type RoleTrack,
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
}

import type { ApiClient } from '../api';
import {
  parseAlertSource,
  parseAlertSources,
  parseAnalyticsReport,
  parseApplications,
  parseApplication,
  parseCompanies,
  parseCompany,
  parseCSVImportReport,
  parseFact,
  parseFacts,
  parseHiringProfile,
  parseJobDescription,
  parseJobDescriptions,
  parseMatchResult,
  parseNotifications,
  parseReferralContact,
  parseReferralContacts,
  parseReferralDraft,
  parseResumeVersion,
  parseResumeVersions,
  parseRoleTrack,
  parseRoleTracks,
  parseTemplates,
  type AlertProvider,
  type AlertSource,
  type AnalyticsReport,
  type Application,
  type ApplicationStatus,
  type CareerNotification,
  type Company,
  type ConfirmedFact,
  type ContactRelation,
  type CSVImportReport,
  type HiringProfile,
  type JobDescription,
  type MatchResult,
  type ReferralContact,
  type ReferralDraft,
  type RejectionReason,
  type ResumeDocument,
  type ResumeVersion,
  type ResumeVersionType,
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
    return this.api
      .request(`/career/companies/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
      .then(() => undefined);
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

  createFact(
    input: { action: string; impact: string; metric?: string; skills: string[] },
    signal?: AbortSignal,
  ): Promise<ConfirmedFact> {
    return this.api.request('/career/facts', { method: 'POST', body: input, signal }).then(parseFact);
  }

  deleteFact(id: string, signal?: AbortSignal): Promise<void> {
    return this.api
      .request(`/career/facts/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
      .then(() => undefined);
  }

  match(
    input: { track_id: string; company_id?: string; jd_text?: string },
    signal?: AbortSignal,
  ): Promise<MatchResult> {
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
      status?: ApplicationStatus;
      resume_version_type?: ResumeVersionType;
      resume_version_id?: string;
      rejection_reason?: RejectionReason;
      posting_date?: string;
      applied_at?: string;
      applied_days_after_posting?: number;
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
      status?: ApplicationStatus;
      resume_version_type?: ResumeVersionType;
      resume_version_id?: string;
      rejection_reason?: RejectionReason | '';
      posting_date?: string;
      applied_at?: string;
      applied_days_after_posting?: number;
    },
    signal?: AbortSignal,
  ): Promise<Application> {
    return this.api
      .request(`/career/applications/${encodeURIComponent(id)}`, { method: 'PUT', body: input, signal })
      .then(parseApplication);
  }

  deleteApplication(id: string, signal?: AbortSignal): Promise<void> {
    return this.api
      .request(`/career/applications/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
      .then(() => undefined);
  }

  importApplications(csv: string, dryRun: boolean, signal?: AbortSignal): Promise<CSVImportReport> {
    return this.api
      .request('/career/applications/import', { method: 'POST', body: { csv, dry_run: dryRun }, signal })
      .then(parseCSVImportReport);
  }

  analytics(signal?: AbortSignal): Promise<AnalyticsReport> {
    return this.api.request('/career/analytics', { signal }).then(parseAnalyticsReport);
  }

  contacts(signal?: AbortSignal): Promise<{ contacts: ReferralContact[] }> {
    return this.api.request('/career/contacts', { signal }).then(parseReferralContacts);
  }

  createContact(
    input: { name: string; company: string; relation: ContactRelation; link?: string },
    signal?: AbortSignal,
  ): Promise<ReferralContact> {
    return this.api.request('/career/contacts', { method: 'POST', body: input, signal }).then(parseReferralContact);
  }

  deleteContact(id: string, signal?: AbortSignal): Promise<void> {
    return this.api
      .request(`/career/contacts/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
      .then(() => undefined);
  }

  importContacts(csv: string, dryRun: boolean, signal?: AbortSignal): Promise<CSVImportReport> {
    return this.api
      .request('/career/contacts/import', { method: 'POST', body: { csv, dry_run: dryRun }, signal })
      .then(parseCSVImportReport);
  }

  referralMatches(
    input: { company?: string; company_id?: string },
    signal?: AbortSignal,
  ): Promise<{ company: string; contacts: ReferralContact[] }> {
    const params = new URLSearchParams();
    if (input.company) params.set('company', input.company);
    if (input.company_id) params.set('company_id', input.company_id);
    return this.api.request(`/career/referrals/matches?${params.toString()}`, { signal }).then(raw => {
      const parsed = parseReferralContacts(raw);
      const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      const company = typeof record.company === 'string' ? record.company : '';
      return { company, contacts: parsed.contacts };
    });
  }

  draftReferral(
    input: { contact_id: string; company: string; role: string },
    signal?: AbortSignal,
  ): Promise<ReferralDraft> {
    return this.api
      .request('/career/referrals/draft', { method: 'POST', body: input, signal })
      .then(parseReferralDraft);
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

  alertSources(signal?: AbortSignal): Promise<{ sources: AlertSource[] }> {
    return this.api.request('/career/alert-sources', { signal }).then(parseAlertSources);
  }

  createAlertSource(
    input: {
      provider: AlertProvider | string;
      board_token: string;
      label?: string;
      company_id?: string;
      track_id?: string;
      keywords?: string[];
      poll_interval_seconds?: number;
    },
    signal?: AbortSignal,
  ): Promise<AlertSource> {
    return this.api.request('/career/alert-sources', { method: 'POST', body: input, signal }).then(parseAlertSource);
  }

  deleteAlertSource(id: string, signal?: AbortSignal): Promise<void> {
    return this.api
      .request(`/career/alert-sources/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
      .then(() => undefined);
  }

  notifications(unreadOnly = false, signal?: AbortSignal): Promise<{ notifications: CareerNotification[] }> {
    const q = unreadOnly ? '?unread=1' : '';
    return this.api.request(`/career/notifications${q}`, { signal }).then(parseNotifications);
  }

  markNotificationRead(id: string, signal?: AbortSignal): Promise<void> {
    return this.api
      .request(`/career/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', body: {}, signal })
      .then(() => undefined);
  }

  markAllNotificationsRead(signal?: AbortSignal): Promise<void> {
    return this.api
      .request('/career/notifications/read-all', { method: 'POST', body: {}, signal })
      .then(() => undefined);
  }
}

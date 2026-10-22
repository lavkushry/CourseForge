import { el } from '../components';
import { errorMessage, isAbort } from '../api';
import { CareerApi } from './api';
import { emptyResumeDraft } from './contracts';
import type {
  AlertSource,
  AnalyticsReport,
  Application,
  CareerNotification,
  Company,
  ConfirmedFact,
  CSVImportReport,
  HiringProfile,
  MatchResult,
  ReferralContact,
  ReferralDraft,
  ResumeDocument,
  ResumeVersion,
  RoleTrack,
  TemplateInfo,
} from './contracts';
import { renderAlerts } from './panel-alerts';
import { renderAnalytics } from './panel-analytics';
import { renderCompanies } from './panel-companies';
import { renderFacts } from './panel-facts';
import { renderMatch } from './panel-match';
import { renderReferrals } from './panel-referrals';
import { renderResumeStudio } from './panel-resume';
import { renderTracker } from './panel-tracker';
import { renderTracks } from './panel-tracks';
import type { CareerStudioHost, CareerViewOptions } from './view-host';

export type { CareerViewOptions } from './view-host';

export class CareerView implements CareerStudioHost {
  readonly career: CareerApi;
  tracks: RoleTrack[] = [];
  companies: Company[] = [];
  facts: ConfirmedFact[] = [];
  applications: Application[] = [];
  templates: TemplateInfo[] = [];
  versions: ResumeVersion[] = [];
  contacts: ReferralContact[] = [];
  analytics: AnalyticsReport | null = null;
  appImportReport: CSVImportReport | null = null;
  contactImportReport: CSVImportReport | null = null;
  referralMatches: ReferralContact[] = [];
  referralDraft: ReferralDraft | null = null;
  alertSources: AlertSource[] = [];
  notifications: CareerNotification[] = [];
  selectedTrackId = '';
  selectedCompanyId = '';
  selectedAppId = '';
  selectedTemplateId = 'ats_classic';
  draft: ResumeDocument = emptyResumeDraft();
  targetSkillsRaw = '';
  profile: HiringProfile | null = null;
  match: MatchResult | null = null;
  latestVersion: ResumeVersion | null = null;
  signal: AbortSignal | null = null;
  busy = false;

  constructor(readonly options: CareerViewOptions) {
    this.career = new CareerApi(options.api);
  }

  activate(signal?: AbortSignal): void {
    this.options.root.hidden = false;
    this.signal = signal ?? null;
    void this.reload();
  }

  deactivate(): void {
    this.options.root.hidden = true;
    this.options.root.replaceChildren();
    this.signal = null;
  }

  async reload(): Promise<void> {
    try {
      const [tracks, companies, facts, applications, templates, contacts, analytics, sources, notifications] =
        await Promise.all([
          this.career.roleTracks(this.signal ?? undefined),
          this.career.companies(this.signal ?? undefined),
          this.career.facts(this.signal ?? undefined),
          this.career.applications(this.signal ?? undefined),
          this.career.templates(this.signal ?? undefined),
          this.career.contacts(this.signal ?? undefined),
          this.career.analytics(this.signal ?? undefined),
          this.career.alertSources(this.signal ?? undefined),
          this.career.notifications(false, this.signal ?? undefined),
        ]);
      this.tracks = tracks.tracks;
      this.companies = companies.companies;
      this.facts = facts.facts;
      this.applications = applications.applications;
      this.templates = templates.templates;
      this.contacts = contacts.contacts;
      this.analytics = analytics;
      this.alertSources = sources.sources;
      this.notifications = notifications.notifications;
      if (!this.selectedTrackId && this.tracks[0]) this.selectedTrackId = this.tracks[0].id;
      if (!this.selectedCompanyId && this.companies[0]) this.selectedCompanyId = this.companies[0].id;
      if (!this.selectedAppId && this.applications[0]) this.selectedAppId = this.applications[0].id;
      if (!this.selectedTemplateId && this.templates[0]) this.selectedTemplateId = this.templates[0].id;
      if (this.selectedCompanyId) {
        this.profile = await this.career.hiringProfile(this.selectedCompanyId, this.signal ?? undefined);
      } else {
        this.profile = null;
      }
      await this.loadSelectedApplication();
      this.render();
    } catch (err) {
      if (!isAbort(err)) {
        this.options.feedback(errorMessage(err), true);
        this.render();
      }
    }
  }

  async loadSelectedApplication(): Promise<void> {
    const app = this.applications.find(a => a.id === this.selectedAppId);
    if (!app) {
      this.draft = emptyResumeDraft(this.tracks.find(t => t.id === this.selectedTrackId)?.title ?? '');
      this.targetSkillsRaw = '';
      this.versions = [];
      this.latestVersion = null;
      return;
    }
    this.draft = {
      ...emptyResumeDraft(),
      ...app.resume_draft,
      skills: [...app.resume_draft.skills],
      experience: [...app.resume_draft.experience],
      education: [...app.resume_draft.education],
    };
    this.targetSkillsRaw = app.target_skills.join(', ');
    if (!this.draft.title) this.draft.title = app.title;
    const versions = await this.career.versions(app.id, this.signal ?? undefined);
    this.versions = versions.versions;
    this.latestVersion = this.versions[0] ?? null;
  }

  render(): void {
    const root = this.options.root;
    root.replaceChildren();

    const head = el('div', 'page-heading');
    head.append(
      el('span', 'eyebrow', 'CAREER STUDIO'),
      el('h1', '', 'Role Tracks & Hiring Fit'),
      el(
        'p',
        'muted',
        'Build company hiring profiles from pasted JDs, score matches against role tracks, rewrite bullets only from confirmed facts, generate ATS-safe LaTeX resumes, and watch careers boards for apply-early openings.',
      ),
    );
    root.append(head);

    const layout = el('div', 'career-layout');
    layout.append(renderTracks(this), renderCompanies(this), renderFacts(this), renderMatch(this));
    root.append(layout);
    root.append(renderResumeStudio(this));
    const trackerLayout = el('div', 'career-layout career-tracker-layout');
    trackerLayout.append(renderTracker(this), renderAnalytics(this), renderReferrals(this));
    root.append(trackerLayout);
    root.append(renderAlerts(this));
  }
}

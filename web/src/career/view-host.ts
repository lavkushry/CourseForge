import type { ApiClient } from '../api';
import type { CareerApi } from './api';
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

export interface CareerViewOptions {
  root: HTMLElement;
  api: ApiClient;
  feedback: (message: string, error?: boolean) => void;
}

/** Shared mutable studio state + lifecycle hooks used by panel modules. */
export interface CareerStudioHost {
  readonly career: CareerApi;
  readonly options: CareerViewOptions;
  tracks: RoleTrack[];
  companies: Company[];
  facts: ConfirmedFact[];
  applications: Application[];
  templates: TemplateInfo[];
  versions: ResumeVersion[];
  contacts: ReferralContact[];
  analytics: AnalyticsReport | null;
  appImportReport: CSVImportReport | null;
  contactImportReport: CSVImportReport | null;
  referralMatches: ReferralContact[];
  referralDraft: ReferralDraft | null;
  alertSources: AlertSource[];
  notifications: CareerNotification[];
  selectedTrackId: string;
  selectedCompanyId: string;
  selectedAppId: string;
  selectedTemplateId: string;
  draft: ResumeDocument;
  targetSkillsRaw: string;
  profile: HiringProfile | null;
  match: MatchResult | null;
  latestVersion: ResumeVersion | null;
  signal: AbortSignal | null;
  busy: boolean;
  render(): void;
  reload(): Promise<void>;
  loadSelectedApplication(): Promise<void>;
}

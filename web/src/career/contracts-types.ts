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

export interface SkillBridgeLink {
  id: string;
  title: string;
  course_id?: string;
  href: string;
}

export interface SkillBridge {
  skill: string;
  courses: SkillBridgeLink[];
  lessons: SkillBridgeLink[];
}

export interface MatchResult {
  track_id?: string;
  company_id?: string;
  score: number;
  matched_keywords: KeywordWeight[];
  missing_keywords: KeywordWeight[];
  suggested_bullets: BulletSuggestion[];
  skill_bridges: SkillBridge[];
  extraction_source: string;
  jd_keywords: ExtractedSignals;
}

export type AlertProvider = 'greenhouse' | 'lever' | 'ashby';

export interface AlertSource {
  id: string;
  company_id?: string;
  provider: AlertProvider | string;
  board_token: string;
  label: string;
  track_id?: string;
  keywords: string[];
  enabled: boolean;
  last_polled_at?: string;
  next_poll_at: string;
  poll_interval_seconds: number;
  backoff_seconds: number;
  consecutive_failures: number;
  last_error: string;
  created_at: string;
  updated_at: string;
}

export interface CareerNotification {
  id: string;
  kind: 'new_opening' | string;
  title: string;
  body: string;
  opening_id?: string;
  source_id?: string;
  href: string;
  read_at?: string | null;
  created_at: string;
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

export type ApplicationStatus = 'applied' | 'callback' | 'interview' | 'offer' | 'rejected';
export type ResumeVersionType = 'original' | 'tailored';
export type RejectionReason = 'underqualified' | 'late' | 'no_referral' | 'unknown';
export type ContactRelation = 'alumni' | 'cohort' | 'colleague';

export interface Application {
  id: string;
  company_id?: string;
  company_name?: string;
  track_id?: string;
  title: string;
  notes: string;
  target_skills: string[];
  resume_draft: ResumeDocument;
  status: ApplicationStatus;
  applied_at: string;
  callback_at?: string;
  interview_at?: string;
  offer_at?: string;
  rejected_at?: string;
  resume_version_id?: string;
  resume_version_type: ResumeVersionType;
  rejection_reason?: RejectionReason;
  posting_date?: string;
  applied_days_after_posting?: number;
  created_at: string;
  updated_at: string;
}

export interface ReferralContact {
  id: string;
  name: string;
  company: string;
  relation: ContactRelation;
  link: string;
  created_at: string;
}

export interface RateStats {
  label: string;
  n: number;
  successes: number;
  rate: number;
  wilson_low: number;
  wilson_high: number;
  wilson_ok: boolean;
  unreliable: boolean;
  unreliable_note?: string;
}

export interface RateGroup {
  key: string;
  label: string;
  callback: RateStats;
  interview: RateStats;
}

export interface MatchedPairCompare {
  company_id: string;
  company_name: string;
  track_id: string;
  original_callback: RateStats;
  tailored_callback: RateStats;
  original_interview: RateStats;
  tailored_interview: RateStats;
}

export interface AnalyticsReport {
  total_applications: number;
  by_resume_version: RateGroup[];
  by_version_type: RateGroup[];
  by_role_track: RateGroup[];
  by_company: RateGroup[];
  by_rejection_reason: RateGroup[];
  by_applied_days: RateGroup[];
  matched_pairs: MatchedPairCompare[];
  min_reliable_n: number;
  warning?: string;
}

export interface CSVRowError {
  row: number;
  field?: string;
  message: string;
}

export interface CSVImportReport {
  columns: string[];
  dry_run: boolean;
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  created: number;
  errors: CSVRowError[];
  preview: Record<string, unknown>[];
  format_docs: string;
}

export interface ReferralDraft {
  contact_id: string;
  contact_name: string;
  company: string;
  role: string;
  message: string;
  delivery: 'clipboard_only' | string;
}

/** Documented application CSV columns for baseline import. */
export const APPLICATION_CSV_COLUMNS = [
  'company',
  'role',
  'status',
  'resume_version_type',
  'rejection_reason',
  'applied_at',
  'posting_date',
  'track_id',
  'notes',
  'callback_at',
  'interview_at',
  'offer_at',
  'rejected_at',
] as const;

export const APPLICATION_CSV_FORMAT_DOCS =
  'Required: company, role, status. Optional: resume_version_type (original|tailored), rejection_reason, applied_at, posting_date, track_id, notes, callback_at, interview_at, offer_at, rejected_at. applied_days_after_posting is derived from posting_date and applied_at.';

export const CONTACT_CSV_COLUMNS = ['name', 'company', 'relation', 'link'] as const;

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

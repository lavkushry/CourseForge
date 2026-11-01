export type {
  KeywordWeight,
  RoleTrack,
  Company,
  ExtractedSignals,
  JobDescription,
  HiringProfile,
  ConfirmedFact,
  BulletSuggestion,
  SkillBridgeLink,
  SkillBridge,
  MatchResult,
  AlertProvider,
  AlertSource,
  CareerNotification,
  ResumeExperience,
  ResumeEducation,
  ResumeProject,
  ResumeDocument,
  ApplicationStatus,
  ResumeVersionType,
  RejectionReason,
  ContactRelation,
  Application,
  ReferralContact,
  RateStats,
  RateGroup,
  MatchedPairCompare,
  AnalyticsReport,
  CSVRowError,
  CSVImportReport,
  ReferralDraft,
  SkimFeedback,
  SkimScore,
  ResumeVersion,
  TemplateInfo,
} from './contracts-types';

export {
  APPLICATION_CSV_COLUMNS,
  APPLICATION_CSV_FORMAT_DOCS,
  CONTACT_CSV_COLUMNS,
  emptyResumeDraft,
} from './contracts-types';

export {
  parseRoleTracks,
  parseRoleTrack,
  parseCompanies,
  parseCompany,
  parseJobDescriptions,
  parseJobDescription,
  parseHiringProfile,
  parseFacts,
  parseFact,
  parseMatchResult,
  parseAlertSources,
  parseAlertSource,
  parseNotifications,
  parseNotification,
} from './contracts-profile';

export {
  parseResumeDocument,
  parseApplication,
  parseApplications,
  parseSkimScore,
  parseResumeVersion,
  parseResumeVersions,
  parseTemplates,
} from './contracts-resume';

export {
  parseAnalyticsReport,
  parseCSVImportReport,
  parseReferralContact,
  parseReferralContacts,
  parseReferralDraft,
  validateApplicationCSVHeader,
} from './contracts-tracker';

export interface AppliedJob {
  id: string;
  user_id: string;
  job_id: string;
  platform: string;
  company: string;
  title: string;
  location: string;
  experience_req: string;
  match_score: number;
  status: string;
  application_type: string;
  job_url: string;
  applied_at: string;
  applicant_email: string;
  evidence_path?: string;
  outcome_label?: string;
  policy_version: string;
  is_dry_run: boolean;
}

export interface ProfileMutation {
  id: string;
  platform: string;
  field: string;
  old_value: string;
  new_value: string;
  old_hash: string;
  new_hash: string;
  is_keyword_mutation: boolean;
  mutation_type: string;
  rationale: string;
  expected_effect: string;
  approved_by: string;
  status: string;
  applied_at: string;
}

export interface RecruiterLead {
  id: string;
  lead_id: string;
  recruiter_name: string;
  company: string;
  target_role: string;
  platform: string;
  profile_url?: string;
  status: string;
  message_type: string;
  pitch_text: string;
  connection_note_300chars: string;
  day_3_followup_date?: string;
  day_3_followup_note?: string;
  day_7_followup_date?: string;
  day_7_followup_note?: string;
  notes?: string;
  call_scheduled_at?: string;
  updated_at: string;
}

export interface BottleneckAlert {
  code: string;
  stage: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  description: string;
  action_required: string;
}

export interface DailyPacing {
  id?: string;
  user_id: string;
  pacing_date: string;
  applications_count: number;
  outreaches_count: number;
  followups_count: number;
  calls_scheduled_count: number;
  pacing_ratio: number;
  search_appearances: number;
  profile_views: number;
  contact_views: number;
  active_bottlenecks: BottleneckAlert[];
  updated_at: string;
}

export interface KeywordUtility {
  token: string;
  demand_frequency: number;
  saturation_count: number;
  utility_score: number;
  claimable: boolean;
  updated_at: string;
}

export interface BoostStatus {
  last_bump_at?: string;
  active_today: boolean;
  cooldown_remaining_seconds: number;
  policy_decisions_count: number;
  policy_mode: string;
  policy_version: string;
  keyword_utilities: KeywordUtility[];
  recent_mutations: ProfileMutation[];
}

export interface BumpResult {
  success: boolean;
  message: string;
  platform: string;
  bumped_at: string;
  next_allowed_at: string;
}

export interface DailyRoutineBlock {
  block_id: number;
  title: string;
  time_window: string;
  tasks: string[];
  status: string;
  is_active: boolean;
}

export interface PlanTodayResponse {
  date: string;
  blocks: DailyRoutineBlock[];
}

export interface BlockExecutionResult {
  block: number;
  status: string;
  tasks_completed: string[];
  dry_run: boolean;
  message: string;
}

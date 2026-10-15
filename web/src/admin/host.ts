import type { ApiClient } from '../api';
import type { Course } from '../contracts';
import type { IconName } from '../icons';
import type { AdminOverview, AdminUser } from './contracts';
import type { AdminTab, StudentModalTab } from './helpers';

export interface AdminHost {
  root: HTMLElement;
  api: ApiClient;
  notice: (msg: string, error?: boolean) => void;
  activeTab: AdminTab;
  overviewData: AdminOverview | null;
  users: AdminUser[];
  catalogCourses: Course[];
  loading: boolean;
  learnerSearch: string;
  learnerRoleFilter: 'all' | 'student' | 'admin';
  learnerStatusFilter: 'all' | 'verified' | 'pending' | 'suspended';
  showFixtures: boolean;
  lastInviteResult: { email: string; activation_url: string; expires_at: string } | null;
  render(): void;
  refreshAll(signal?: AbortSignal): Promise<void>;
  openStudentAccessModal(user: AdminUser, initialTab?: StudentModalTab): Promise<void>;
  metricCard(title: string, value: string, subtitle: string, icon: IconName): HTMLElement;
  miniKpi(label: string, value: string, icon: IconName): HTMLElement;
  downloadCSV(type: 'player-activity' | 'playback'): Promise<void>;
}

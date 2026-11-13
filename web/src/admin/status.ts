import type { AdminOverview, AdminSystemReport } from './contracts';

export function adminOverviewEmptyCopy(): { title: string; description: string } {
  return {
    title: 'No overview data available',
    description: 'Overview metrics appear after the administrator API responds. Nothing is fabricated while loading fails.',
  };
}

export function adminOverviewFailureCopy(message?: string): { title: string; description: string } {
  return {
    title: 'Could not load administrator overview',
    description: message || 'Administrator metrics temporarily unavailable.',
  };
}

export function adminCatalogCount(catalogLength: number, overview: AdminOverview | null): number {
  if (catalogLength > 0) return catalogLength;
  if (overview?.summary.courses) return overview.summary.courses;
  return 0;
}

export function adminAiOfflineLabel(ollamaOnline: boolean, pgvectorActive: boolean): string {
  if (!ollamaOnline) return 'Offline';
  if (!pgvectorActive) return 'Online · vectors inactive';
  return 'Online';
}

export function adminSystemUnavailableList(report: AdminSystemReport | null): string[] {
  if (!report) return ['system_report_unavailable'];
  return Array.isArray(report.unavailable) ? report.unavailable.map(String) : [];
}

export function adminTaskCountLabel(tasks: Record<string, unknown> | undefined): string {
  if (!tasks || typeof tasks !== 'object') return 'No job counts measured';
  const parts = Object.entries(tasks)
    .filter(([, n]) => typeof n === 'number')
    .map(([state, n]) => `${state}: ${n}`);
  return parts.length ? parts.join(' · ') : 'No jobs recorded';
}

export function adminCourseMappingRows(
  courses: AdminSystemReport['courses'] | undefined,
): Array<{
  course_id: string;
  published: boolean;
  lessons: number;
  mapped: number;
  measured_durations: number;
}> {
  if (!Array.isArray(courses)) return [];
  return courses
    .map(row => {
      if (!row || typeof row !== 'object') return null;
      const r = row as Record<string, unknown>;
      const courseId = typeof r.course_id === 'string' ? r.course_id : '';
      if (!courseId) return null;
      return {
        course_id: courseId,
        published: Boolean(r.published),
        lessons: Number(r.lessons || 0),
        mapped: Number(r.mapped || 0),
        measured_durations: Number(r.measured_durations || 0),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
}

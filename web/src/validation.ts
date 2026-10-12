import type { AuthResponse, ClaimResponse, Course, Lesson, Note, PlaybackSession, PlayerPreferences, Progress, PulseAck } from './contracts';

export class ContractError extends Error {
  constructor(field: string) { super(`The server returned invalid ${field}. Please try again.`); this.name = 'ContractError'; }
}

export function isGatewayPath(path: string): boolean {
  return path.startsWith('/media/') || /^\/api\/v1\/playback\/sessions\/[A-Za-z0-9_-]+\/media$/.test(path);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError(field);
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new ContractError(field);
  return value;
}

function finite(value: unknown, field: string, min = 0, max = 1e9): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new ContractError(field);
  return value;
}

function sequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ContractError('progress sequence');
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new ContractError(field);
  return value;
}

function cursor(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return string(value, 'pagination cursor', 4096);
}

export function parsePreferences(value: unknown): PlayerPreferences {
  const data = record(value, 'player preferences');
  return { autoplay: boolean(data.autoplay, 'autoplay preference'), speed: finite(data.speed, 'playback speed', 0.5, 3) };
}

export function parseAuth(value: unknown): AuthResponse {
  const data = record(value, 'sign-in response');
  const user = record(data.user, 'account');
  return {
    user: {
      id: string(user.id, 'account ID'), email: string(user.email, 'account email'),
      ...(typeof user.name === 'string' ? { name: user.name } : {}),
      ...(typeof user.role === 'string' ? { role: user.role } : {}),
    },
    csrf_token: string(data.csrf_token, 'CSRF token', 4096),
  };
}

export function parsePlaybackSession(value: unknown): PlaybackSession {
  const data = record(value, 'playback session');
  const mediaUrl = string(data.media_url, 'media gateway URL', 8192);
  // The public application exposes relative gateway paths. A public provider URL
  // is not a compatible authentication boundary, even if it points at a video.
  if (!mediaUrl.startsWith('/') || mediaUrl.startsWith('//') || mediaUrl.includes('\\') || !isGatewayPath(new URL(mediaUrl, 'https://courseforge.invalid').pathname)) throw new ContractError('media gateway URL');
  return {
    id: string(data.id, 'playback session ID'), media_url: mediaUrl,
    position: finite(data.position, 'saved position'), sequence: sequence(data.sequence),
    preferences: parsePreferences(data.preferences), owner: boolean(data.owner, 'playback ownership'),
    ...(typeof data.watermark === 'string' ? { watermark: data.watermark } : {}),
  };
}

export function parsePulseAck(value: unknown): PulseAck {
  const data = record(value, 'progress acknowledgement');
  return {
    sequence: sequence(data.sequence), position: finite(data.position, 'saved position'),
    watched_seconds: finite(data.watched_seconds, 'watched time', 0, 1e12),
    coverage: finite(data.coverage, 'watched coverage', 0, 100),
    owner: boolean(data.owner, 'playback ownership'), completed: boolean(data.completed, 'completion state'),
  };
}

export function parseClaim(value: unknown): ClaimResponse {
  const data = record(value, 'playback claim');
  return { owner: boolean(data.owner, 'playback ownership'), position: finite(data.position, 'saved position'), sequence: sequence(data.sequence) };
}

export function parseCourse(value: unknown): Course {
  const data = record(value, 'course');
  return {
    id: string(data.id, 'course ID'), title: string(data.title, 'course title', 4096),
    ...(typeof data.description === 'string' ? { description: data.description } : {}),
    ...(typeof data.enrolled === 'boolean' ? { enrolled: data.enrolled } : {}),
    ...(typeof data.cover_url === 'string' ? { cover_url: data.cover_url } : {}),
    ...(typeof data.category === 'string' ? { category: data.category } : {}),
    ...(typeof data.instructor === 'string' ? { instructor: data.instructor } : {}),
    ...(typeof data.duration_seconds === 'number' ? { duration_seconds: finite(data.duration_seconds, 'course duration', 0, 1e9) } : {}),
    ...(Array.isArray(data.tags) && data.tags.every(tag => typeof tag === 'string') ? { tags: data.tags.slice(0, 30) as string[] } : {}),
    ...(typeof data.lesson_count === 'number' ? { lesson_count: finite(data.lesson_count, 'lesson count', 0, 1e6) } : {}),
  };
}

export function parseLesson(value: unknown): Lesson {
  const data = record(value, 'lesson');
  const lesson: Lesson = {
    id: string(data.id, 'lesson ID'), course_id: string(data.course_id, 'course ID'),
    title: string(data.title, 'lesson title', 4096), duration_seconds: finite(data.duration_seconds, 'lesson duration'),
    ...(typeof data.section_title === 'string' ? { section_title: data.section_title } : {}),
    ...(typeof data.description === 'string' ? { description: data.description } : {}),
  };
  if (data.materials !== undefined) lesson.materials = list(data.materials, 'materials', 100).map(item => {
    const material = record(item, 'material');
    return { id: string(material.id, 'material ID'), title: string(material.title, 'material title'), download_url: string(material.download_url, 'material URL', 8192) };
  });
  if (data.captions !== undefined) lesson.captions = list(data.captions, 'captions', 100).map(item => {
    const caption = record(item, 'caption');
    return { url: string(caption.url, 'caption URL', 8192), language: string(caption.language, 'caption language', 64), label: string(caption.label, 'caption label') };
  });
  return lesson;
}

export function parseProgress(value: unknown): Progress {
  const data = record(value, 'lesson progress');
  return {
    position: finite(data.position, 'saved position'),
    ...(data.percent !== undefined ? { percent: finite(data.percent, 'progress percentage', 0, 100) } : {}),
    ...(data.revision !== undefined ? { revision: sequence(data.revision) } : {}),
    ...(data.coverage !== undefined ? { coverage: finite(data.coverage, 'watched coverage', 0, 100) } : {}),
    ...(data.watched_seconds !== undefined ? { watched_seconds: finite(data.watched_seconds, 'watched time', 0, 1e12) } : {}),
    ...(data.completed !== undefined ? { completed: boolean(data.completed, 'completion state') } : {}),
    ...(data.explicit_completed !== undefined ? { explicit_completed: boolean(data.explicit_completed, 'explicit completion state') } : {}),
  };
}

function list(value: unknown, field: string, max = 100): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new ContractError(field);
  return value as unknown[];
}

export function parseCourses(value: unknown): { courses: Course[]; next_cursor: string | null } {
  const data = record(value, 'course list');
  return { courses: list(data.courses, 'course list').map(parseCourse), next_cursor: cursor(data.next_cursor) };
}

export function parseCourseDetail(value: unknown): { course: Course; lessons: Lesson[]; next_cursor: string | null } {
  const data = record(value, 'course detail');
  return { course: parseCourse(data.course), lessons: list(data.lessons, 'lesson list').map(parseLesson), next_cursor: cursor(data.next_cursor) };
}

export function parseLessonDetail(value: unknown): { lesson: Lesson; progress: Progress | null } {
  const data = record(value, 'lesson detail');
  return { lesson: parseLesson(data.lesson), progress: data.progress === null ? null : parseProgress(data.progress) };
}

export function parseNote(value: unknown): Note {
  const data = record(value, 'lesson note');
  return {
    id: string(data.id, 'note ID'), lesson_id: string(data.lesson_id, 'lesson ID'),
    content: string(data.content, 'note content', 12_000), position: finite(data.position, 'note timestamp'),
    created_at: string(data.created_at, 'note date'),
  };
}

export function parseNotes(value: unknown): { notes: Note[]; next_cursor: string | null } {
  const data = record(value, 'notes list');
  return { notes: list(data.notes, 'notes list').map(parseNote), next_cursor: cursor(data.next_cursor) };
}

export interface FocusLink {
  courseId: string;
  lessonId: string;
  t: number;
}

/** `#classroom?course=&lesson=&t=` deep link. Invalid hashes return null. */
export function readFocusLink(hash = location.hash): FocusLink | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw.startsWith('classroom')) return null;
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
  const params = new URLSearchParams(query);
  const courseId = params.get('course')?.trim() ?? '';
  const lessonId = params.get('lesson')?.trim() ?? '';
  const t = Number(params.get('t') ?? '0');
  if (!courseId || !lessonId || courseId.length > 200 || lessonId.length > 200) return null;
  return { courseId, lessonId, t: Number.isFinite(t) && t >= 0 ? Math.floor(t) : 0 };
}

export function writeFocusLink(courseId: string, lessonId: string, seconds: number): void {
  const t = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const next = `#classroom?course=${encodeURIComponent(courseId)}&lesson=${encodeURIComponent(lessonId)}&t=${t}`;
  if (location.hash !== next) history.replaceState(null, '', next);
}

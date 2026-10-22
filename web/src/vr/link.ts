import type { LectureTimestampLink, VrArtifact, VrEntryState } from './types';

const MAX_ID_LENGTH = 200;

export const VR_TIMESTAMP_WINDOW_SECONDS = 3;

export function encodeLectureSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= 1e7) {
    throw new Error('timestamp must be a non-negative finite second count');
  }
  return String(Math.round(seconds * 1000) / 1000);
}

export function lectureClock(seconds: number): string {
  const whole = Math.floor(Math.max(0, Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function playbackStartSeconds(link: LectureTimestampLink): number {
  return Number(encodeLectureSeconds(link.seconds));
}

export function lectureLink(artifact: VrArtifact): LectureTimestampLink {
  return {
    courseId: artifact.courseId,
    lessonId: artifact.lessonId,
    seconds: artifact.timestampSeconds,
  };
}

export function classroomReturnHref(link: LectureTimestampLink): string {
  const params = new URLSearchParams({
    course: link.courseId,
    lesson: link.lessonId,
    t: encodeLectureSeconds(link.seconds),
  });
  return `/?${params.toString()}#classroom`;
}

export function vrEntryHref(link: LectureTimestampLink): string {
  const params = new URLSearchParams({
    course: link.courseId,
    lesson: link.lessonId,
    t: encodeLectureSeconds(link.seconds),
  });
  return `/vr.html?${params.toString()}`;
}

export function parseLectureReturn(search: string, hash: string): LectureTimestampLink | null {
  const rawHash = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!rawHash.startsWith('classroom')) return null;
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const courseId = params.get('course')?.trim() ?? '';
  const lessonId = params.get('lesson')?.trim() ?? '';
  const rawSeconds = params.get('t');
  if (!courseId || !lessonId || courseId.length > MAX_ID_LENGTH || lessonId.length > MAX_ID_LENGTH) return null;
  if (rawSeconds === null || rawSeconds.trim() === '') return null;
  const seconds = Number(rawSeconds);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= 1e7) return null;
  return { courseId, lessonId, seconds: Number(encodeLectureSeconds(seconds)) };
}

export function playheadAtSource(
  positionSeconds: number,
  sourceSeconds: number,
  windowSeconds = VR_TIMESTAMP_WINDOW_SECONDS,
): boolean {
  if (!Number.isFinite(positionSeconds) || !Number.isFinite(sourceSeconds) || windowSeconds < 0) return false;
  return Math.abs(positionSeconds - sourceSeconds) <= windowSeconds;
}

export function vrEntryState(
  artifact: VrArtifact | null,
  lessonId: string | null,
  positionSeconds: number,
): VrEntryState {
  if (!artifact || lessonId !== artifact.lessonId || !playheadAtSource(positionSeconds, artifact.timestampSeconds)) {
    return { kind: 'hidden' };
  }
  const clock = lectureClock(artifact.timestampSeconds);
  return {
    kind: 'ready',
    href: vrEntryHref(lectureLink(artifact)),
    label: `View in VR · ${clock}`,
    title: `Enter ${artifact.concept} in VR at ${clock}`,
    seconds: playbackStartSeconds(lectureLink(artifact)),
  };
}

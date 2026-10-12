export interface User {
  id: string;
  email: string;
  name?: string;
  role?: string;
}

export interface AuthResponse {
  user: User;
  csrf_token: string;
}

export interface Course {
  id: string;
  title: string;
  description?: string;
  lesson_count?: number;
  enrolled?: boolean;
  cover_url?: string;
  category?: string;
  instructor?: string;
  duration_seconds?: number;
  tags?: string[];
}

export interface Material {
  id: string;
  title: string;
  download_url: string;
}

export interface Caption {
  url: string;
  label: string;
  language: string;
}

export interface Lesson {
  id: string;
  course_id: string;
  title: string;
  duration_seconds: number;
  description?: string;
  section_title?: string;
  materials?: Material[];
  captions?: Caption[];
}

export interface Progress {
  position: number;
  percent?: number;
  revision?: number;
  explicit_completed?: boolean;
  watched_seconds?: number;
  coverage?: number;
  completed?: boolean;
}

export interface Note {
  id: string;
  lesson_id: string;
  position: number;
  content: string;
  created_at: string;
}

export interface PlayerPreferences {
  autoplay: boolean;
  speed: number;
}

export interface PlaybackSession {
  id: string;
  media_url: string;
  position: number;
  sequence: number;
  preferences: PlayerPreferences;
  owner: boolean;
  watermark?: string;
}

export type PulseKind = 'playing' | 'pause' | 'seek' | 'ended' | 'heartbeat' | 'hidden' | 'close';

export interface Pulse {
  sequence: number;
  kind: PulseKind;
  position: number;
  playing: boolean;
  visible: boolean;
  elapsed_seconds: number;
  playback_rate: number;
}

export interface PulseAck {
  sequence: number;
  position: number;
  watched_seconds: number;
  coverage: number;
  owner: boolean;
  completed: boolean;
}

export interface ClaimResponse {
  owner: boolean;
  position: number;
  sequence: number;
}

export interface PlaybackTransport {
  create(lessonId: string, takeOver: boolean, startPosition: number | undefined, signal: AbortSignal): Promise<PlaybackSession>;
  pulse(sessionId: string, pulse: Pulse, signal: AbortSignal): Promise<PulseAck>;
  release(sessionId: string, options?: { keepalive?: boolean }): Promise<void>;
  claim(sessionId: string, takeOver: boolean, signal: AbortSignal): Promise<ClaimResponse>;
  preferences(signal: AbortSignal): Promise<PlayerPreferences>;
  savePreferences(preferences: PlayerPreferences, signal: AbortSignal): Promise<PlayerPreferences>;
}

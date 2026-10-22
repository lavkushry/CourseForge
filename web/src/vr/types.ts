export type VrEvidenceSource = 'ocr' | 'transcript' | 'vision' | 'concept';

export interface VrLabel {
  text: string;
  source: VrEvidenceSource;
  quote: string;
  node: string;
}

export interface VrArtifact {
  courseId: string;
  lessonId: string;
  timestampSeconds: number;
  keyframeId: string;
  keyframeTimeMs: number;
  conceptId: string;
  concept: string;
  glbUrl: string;
  ocrText: string;
  transcriptQuote: string;
  visionQuote: string;
  evidence: string;
  meshNote: string;
  labels: VrLabel[];
}

export interface LectureTimestampLink {
  courseId: string;
  lessonId: string;
  seconds: number;
}

export type VrEntryState =
  | { kind: 'hidden' }
  | { kind: 'ready'; href: string; label: string; title: string; seconds: number };

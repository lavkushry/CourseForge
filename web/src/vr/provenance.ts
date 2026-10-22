import type { VrArtifact, VrEvidenceSource, VrLabel } from './types';

export class VrProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VrProvenanceError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new VrProvenanceError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(source: Record<string, unknown>, key: string, label: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new VrProvenanceError(`${label} is required`);
  }
  return value.trim();
}

function finiteNumber(source: Record<string, unknown>, key: string, label: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new VrProvenanceError(`${label} must be a finite number`);
  }
  return value;
}

export function evidenceSource(value: unknown): VrEvidenceSource {
  switch (value) {
    case 'ocr':
    case 'transcript':
    case 'vision':
    case 'concept':
      return value;
    default:
      throw new VrProvenanceError('evidence source must be ocr, transcript, vision, or concept');
  }
}

export function describeSource(source: VrEvidenceSource): string {
  switch (source) {
    case 'ocr':
      return 'On-screen text';
    case 'transcript':
      return 'Transcript';
    case 'vision':
      return 'Vision caption';
    case 'concept':
      return 'Concept';
    default: {
      const unexpected: never = source;
      return unexpected;
    }
  }
}

function staticGlbUrl(value: string): string {
  if (!/^\/vr\/[a-z0-9._-]+\.glb$/.test(value)) {
    throw new VrProvenanceError('model URL must be a static /vr GLB');
  }
  return value;
}

function parseLabel(value: unknown, index: number, ocrText: string): VrLabel {
  const source = record(value, `label ${index}`);
  const text = requiredString(source, 'text', `label ${index} text`);
  const quote = requiredString(source, 'quote', `label ${index} quote`);
  const node = requiredString(source, 'node', `label ${index} node`);
  const kind = evidenceSource(source.source);
  const lines = ocrText.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  if (!lines.includes(text)) {
    throw new VrProvenanceError(`label ${index} is not an OCR line`);
  }
  if (quote !== text || node !== text) {
    throw new VrProvenanceError(`label ${index} quote and node must match its OCR text`);
  }
  if (kind !== 'ocr') {
    throw new VrProvenanceError(`label ${index} must cite on-screen text`);
  }
  return { text, source: kind, quote, node };
}

export function parseVrArtifact(value: unknown): VrArtifact {
  const source = record(value, 'artifact');
  const ocrText = requiredString(source, 'ocrText', 'OCR text');
  const labels = source.labels;
  if (!Array.isArray(labels) || labels.length === 0) {
    throw new VrProvenanceError('artifact needs at least one OCR label');
  }
  const parsed = labels.map((label, index) => parseLabel(label, index, ocrText));
  const seen = new Set<string>();
  for (const label of parsed) {
    if (seen.has(label.node)) throw new VrProvenanceError(`duplicate label ${label.node}`);
    seen.add(label.node);
  }
  const timestampSeconds = finiteNumber(source, 'timestampSeconds', 'timestamp');
  const keyframeTimeMs = finiteNumber(source, 'keyframeTimeMs', 'keyframe time');
  if (timestampSeconds < 0 || keyframeTimeMs < 0) {
    throw new VrProvenanceError('timestamp cannot be negative');
  }
  if (Math.abs(timestampSeconds * 1000 - keyframeTimeMs) > 0.5) {
    throw new VrProvenanceError('timestamp and keyframe time do not match');
  }
  const courseId = requiredString(source, 'courseId', 'course id');
  const lessonId = requiredString(source, 'lessonId', 'lesson id');
  if (courseId.length > 200 || lessonId.length > 200) {
    throw new VrProvenanceError('course or lesson id is too long');
  }
  return {
    courseId,
    lessonId,
    timestampSeconds,
    keyframeId: requiredString(source, 'keyframeId', 'keyframe id'),
    keyframeTimeMs,
    conceptId: requiredString(source, 'conceptId', 'concept id'),
    concept: requiredString(source, 'concept', 'concept'),
    glbUrl: staticGlbUrl(requiredString(source, 'glbUrl', 'model URL')),
    ocrText,
    transcriptQuote: requiredString(source, 'transcriptQuote', 'transcript quote'),
    visionQuote: requiredString(source, 'visionQuote', 'vision quote'),
    evidence: requiredString(source, 'evidence', 'evidence'),
    meshNote: requiredString(source, 'meshNote', 'mesh note'),
    labels: parsed,
  };
}

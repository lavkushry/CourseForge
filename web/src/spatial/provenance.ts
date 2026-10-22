import type { ArPlacement, CitationStamp, EvidenceSource, SpatialArtifact, SpatialContext, SpatialNode } from './types';

export const SPATIAL_ENTRY_WINDOW_SECONDS = 2;

export class SpatialProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpatialProvenanceError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SpatialProvenanceError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(source: Record<string, unknown>, key: string, label: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SpatialProvenanceError(`${label} is required`);
  }
  return value;
}

function finiteNumber(source: Record<string, unknown>, key: string, label: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SpatialProvenanceError(`${label} must be a finite number`);
  }
  return value;
}

export function evidenceSource(value: unknown): EvidenceSource {
  if (value === 'ocr' || value === 'transcript') return value;
  throw new SpatialProvenanceError('evidence source must be ocr or transcript');
}

export function describeSource(source: EvidenceSource): string {
  switch (source) {
    case 'ocr':
      return 'On-screen text';
    case 'transcript':
      return 'Transcript';
    default: {
      const unexpected: never = source;
      return unexpected;
    }
  }
}

export function arPlacement(value: unknown): ArPlacement {
  if (value === 'floor' || value === 'wall') return value;
  throw new SpatialProvenanceError('placement must be floor or wall');
}

export function placementAttribute(placement: ArPlacement): 'floor' | 'wall' {
  switch (placement) {
    case 'floor':
      return 'floor';
    case 'wall':
      return 'wall';
    default: {
      const unexpected: never = placement;
      return unexpected;
    }
  }
}

function staticModelUrl(value: string): string {
  if (!/^\/spatial\/[a-z0-9._-]+\.(gltf|glb)$/.test(value)) {
    throw new SpatialProvenanceError('model URL must be a static /spatial glTF or GLB');
  }
  return value;
}

function parseNode(value: unknown, index: number): SpatialNode {
  const source = record(value, `node ${index}`);
  const quote = requiredString(source, 'quote', `node ${index} quote`);
  const label = requiredString(source, 'label', `node ${index} label`);
  if (!quote.includes(label)) {
    throw new SpatialProvenanceError(`node ${index} label is not in its source quote`);
  }
  return {
    id: requiredString(source, 'id', `node ${index} id`),
    label,
    source: evidenceSource(source.source),
    quote,
    evidence: requiredString(source, 'evidence', `node ${index} evidence`),
  };
}

function parseContext(value: unknown, index: number): SpatialContext {
  const source = record(value, `context ${index}`);
  const startMs = finiteNumber(source, 'startMs', `context ${index} start`);
  const endMs = finiteNumber(source, 'endMs', `context ${index} end`);
  if (startMs < 0 || endMs < startMs) {
    throw new SpatialProvenanceError(`context ${index} has an invalid time range`);
  }
  return {
    source: evidenceSource(source.source),
    quote: requiredString(source, 'quote', `context ${index} quote`),
    startMs,
    endMs,
    evidence: requiredString(source, 'evidence', `context ${index} evidence`),
  };
}

export function parseArtifact(value: unknown): SpatialArtifact {
  const source = record(value, 'artifact');
  const nodes = source.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new SpatialProvenanceError('artifact needs at least one sourced node');
  }
  const parsedNodes = nodes.map((node, index) => parseNode(node, index));
  const ids = new Set<string>();
  for (const node of parsedNodes) {
    if (ids.has(node.id)) throw new SpatialProvenanceError(`duplicate node id ${node.id}`);
    ids.add(node.id);
  }
  const context = source.context;
  const parsedContext = Array.isArray(context) ? context.map((item, index) => parseContext(item, index)) : [];
  const timestampSeconds = finiteNumber(source, 'timestampSeconds', 'timestamp');
  const keyframeTimeMs = finiteNumber(source, 'keyframeTimeMs', 'keyframe time');
  if (timestampSeconds < 0 || keyframeTimeMs < 0) {
    throw new SpatialProvenanceError('timestamp cannot be negative');
  }
  if (Math.abs(timestampSeconds * 1000 - keyframeTimeMs) > 0.5) {
    throw new SpatialProvenanceError('timestamp and keyframe time do not match');
  }
  return {
    lectureId: requiredString(source, 'lectureId', 'lecture id'),
    timestampSeconds,
    keyframeTimeMs,
    title: requiredString(source, 'title', 'title'),
    modelUrl: staticModelUrl(requiredString(source, 'modelUrl', 'model URL')),
    placement: arPlacement(source.placement),
    nodes: parsedNodes,
    context: parsedContext,
  };
}

export function formatExactTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.000';
  const totalMs = Math.round(seconds * 1000);
  const minutes = Math.floor(totalMs / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${minutes}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export function returnSeekSeconds(artifact: SpatialArtifact): number {
  return artifact.timestampSeconds;
}

export function artifactEntryRange(artifact: SpatialArtifact): { start: number; end: number } {
  const timestamp = artifact.timestampSeconds;
  const covering = artifact.context.find(item => item.startMs / 1000 <= timestamp && timestamp <= item.endMs / 1000);
  if (covering) return { start: covering.startMs / 1000, end: covering.endMs / 1000 };
  return {
    start: Math.max(0, timestamp - SPATIAL_ENTRY_WINDOW_SECONDS),
    end: timestamp + SPATIAL_ENTRY_WINDOW_SECONDS,
  };
}

export function playheadShowsArtifact(lessonId: string, positionSeconds: number, artifact: SpatialArtifact): boolean {
  if (lessonId !== artifact.lectureId || !Number.isFinite(positionSeconds)) return false;
  const range = artifactEntryRange(artifact);
  return positionSeconds >= range.start && positionSeconds <= range.end;
}

function timestampCovered(start: number, end: number, timestamp: number): boolean {
  if (!Number.isFinite(start) || !Number.isFinite(timestamp)) return false;
  if (Number.isFinite(end) && end > start) return start <= timestamp && timestamp <= end;
  return Math.abs(start - timestamp) <= SPATIAL_ENTRY_WINDOW_SECONDS;
}

export function citationIncludesArtifact(citation: CitationStamp, artifact: SpatialArtifact): boolean {
  if (!timestampCovered(citation.start_seconds, citation.end_seconds, artifact.timestampSeconds)) return false;
  if (citation.lesson_id === artifact.lectureId) return true;
  return artifact.nodes.some(node => citation.text.includes(node.label));
}

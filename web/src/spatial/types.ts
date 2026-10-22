export type EvidenceSource = 'ocr' | 'transcript';

export type ArPlacement = 'floor' | 'wall';

export interface SpatialNode {
  id: string;
  label: string;
  source: EvidenceSource;
  quote: string;
  evidence: string;
}

export interface SpatialContext {
  source: EvidenceSource;
  quote: string;
  startMs: number;
  endMs: number;
  evidence: string;
}

export interface SpatialArtifact {
  lectureId: string;
  timestampSeconds: number;
  keyframeTimeMs: number;
  title: string;
  modelUrl: string;
  placement: ArPlacement;
  nodes: SpatialNode[];
  context: SpatialContext[];
}

export interface CitationStamp {
  lesson_id: string;
  start_seconds: number;
  end_seconds: number;
  text: string;
}

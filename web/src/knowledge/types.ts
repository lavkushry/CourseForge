/** Living Video Knowledge types (ingest + retrieval for the player side panel). */

export type KnowledgeStatus = 'pending' | 'ready' | 'failed';

export interface KnowledgeDocument {
  lesson_id: string;
  job_id?: string | null;
  status: KnowledgeStatus;
  asr_engine: string;
  scene_engine: string;
  ocr_engine: string;
  word_count: number;
  segment_count: number;
  keyframe_count: number;
  chapter_count?: number;
  chunk_count?: number;
  embedder?: string;
  created_at?: string;
  updated_at?: string;
}

export interface KnowledgeWord {
  id: string;
  ordinal: number;
  start_ms: number;
  end_ms: number;
  text: string;
  confidence?: number | null;
}

export interface KnowledgeSegment {
  id: string;
  ordinal: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface KnowledgeOCR {
  id: string;
  text: string;
  tags: string[];
  confidence?: number | null;
}

export interface KnowledgeKeyframe {
  id: string;
  ordinal: number;
  time_ms: number;
  path: string;
  width: number;
  height: number;
  ocr?: KnowledgeOCR | null;
}

export interface KnowledgeChapter {
  id: string;
  ordinal: number;
  start_ms: number;
  end_ms: number;
  title: string;
  summary: string;
}

export interface LessonKnowledge {
  document: KnowledgeDocument;
  words: KnowledgeWord[];
  segments: KnowledgeSegment[];
  keyframes: KnowledgeKeyframe[];
  chapters?: KnowledgeChapter[];
}

export interface AskCitation {
  chunk_id: string;
  start_ms: number;
  end_ms: number;
  label: string;
  text: string;
  score?: number;
}

export interface AskResponse {
  answer: string;
  abstained: boolean;
  support: 'supported' | 'not_covered' | string;
  citations: AskCitation[];
  broadened?: boolean;
}

export const QDRANT_COLLECTION = 'courseforge_knowledge';

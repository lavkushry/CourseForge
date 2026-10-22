export {
  askLessonKnowledge,
  clockToMs,
  fetchLessonChapters,
  fetchLessonConcepts,
  fetchLessonFlashcards,
  fetchLessonHotspots,
  fetchLessonKnowledge,
  fetchLessonRecall,
  fetchReviewQueue,
  formatKnowledgeClock,
  parseCitationLabels,
  submitReview,
} from './api';
export { renderKnowledgePanel } from './panel';
export { gateSpatialAsset, scoreSpatialConfidence } from './spatialGate';
export type { SpatialDecision, SpatialGateResult, SpatialGateSignals } from './spatialGate';
export type { KnowledgePanelOptions } from './panel';
export { QDRANT_COLLECTION } from './types';
export type {
  AskCitation,
  AskResponse,
  ConfusionHotspot,
  FreshnessFlag,
  HotspotAnnotation,
  KnowledgeChapter,
  KnowledgeConcept,
  KnowledgeConceptPrereq,
  KnowledgeDocument,
  KnowledgeFlashcard,
  KnowledgeKeyframe,
  KnowledgeOCR,
  KnowledgeSegment,
  KnowledgeStatus,
  KnowledgeWord,
  LessonKnowledge,
  RecallQuestion,
  ReviewQueueItem,
} from './types';

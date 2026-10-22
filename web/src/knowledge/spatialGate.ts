/**
 * Pure confidence gate the player calls before showing a 3D, AR, or VR asset.
 *
 * Keep this formula aligned with `knowledge_worker/spatial_confidence.py`.
 *
 *     score = 0.35 * ocr
 *           + 0.30 * caption_transcript
 *           + 0.20 * concept_support
 *           + 0.15 * keyframe
 *
 * Each component is in [0, 1]. A missing signal is 0 and does not throw.
 * score >= 0.75 releases. 0.45 <= score < 0.75 labels. Below 0.45, or a
 * missing lecture id or source second, holds the asset.
 */

export const OCR_WEIGHT = 0.35;
export const CAPTION_WEIGHT = 0.3;
export const CONCEPT_WEIGHT = 0.2;
export const KEYFRAME_WEIGHT = 0.15;
export const RELEASE_THRESHOLD = 0.75;
export const LABEL_THRESHOLD = 0.45;

const STOP = new Set(
  `a an the of and or to in on for with is are was were this that these those
    from by as at into it its be we you your our their them then than not can
    will just about over under after before out off all any some such how what
    where which who but also more most when`.split(/\s+/),
);

export type SpatialDecision = 'release' | 'label' | 'hold';

export interface SpatialGateSignals {
  ocr: number;
  captionTranscript: number;
  conceptSupport: number;
  keyframe: number;
}

export interface SpatialGateResult {
  assetId: string;
  kind: string;
  score: number;
  decision: SpatialDecision;
  showAsset: boolean;
  warningRequired: boolean;
  dismissible: false;
  studentText: string;
  lectureId: string;
  sourceSecond: number | null;
  timestamp: string;
  sourceHref: string;
  sourceLinkText: string;
  signals: SpatialGateSignals;
}

export function scoreSpatialConfidence(input: unknown): number {
  const parts = signalComponents(input);
  const raw =
    OCR_WEIGHT * parts.ocr +
    CAPTION_WEIGHT * parts.captionTranscript +
    CONCEPT_WEIGHT * parts.conceptSupport +
    KEYFRAME_WEIGHT * parts.keyframe;
  return round4(clamp01(raw));
}

export function signalComponents(input: unknown): SpatialGateSignals {
  const data = mapping(input);
  return {
    ocr: round4(ocrComponent(data.ocr_confidence)),
    captionTranscript: round4(overlap(text(data.vision_caption), text(data.transcript))),
    conceptSupport: round4(conceptComponent(data)),
    keyframe: round4(keyframeComponent(data.keyframe_path, data.keyframe_time_ms, data.width, data.height)),
  };
}

/** Gate one spatial asset. Pass indexed segments, keyframes, and concepts when the asset omits them. */
export function gateSpatialAsset(
  asset: unknown,
  context: {
    lectureId?: string;
    segments?: unknown;
    keyframes?: unknown;
    concepts?: unknown;
  } = {},
): SpatialGateResult {
  const resolved = resolveSignals(asset, context);
  const signals = signalComponents(resolved);
  const score = scoreSpatialConfidence(resolved);
  const lectureId = text(resolved.lecture_id);
  const sourceSecond = sourceSecondOf(resolved.source_second);
  const decision = decide(score, lectureId, sourceSecond);
  const timestamp = sourceSecond === null ? '' : formatSourceTimestamp(sourceSecond);
  const sourceLinkText = timestamp ? `Original lecture at ${timestamp}` : '';
  const sourceHref =
    lectureId && sourceSecond !== null ? `#learning/${encodeURIComponent(lectureId)}?t=${sourceSecond}` : '';
  const presentation = present(decision, timestamp);
  return {
    assetId: text(resolved.asset_id),
    kind: text(resolved.kind),
    score,
    decision,
    showAsset: presentation.showAsset,
    warningRequired: presentation.warningRequired,
    dismissible: false,
    studentText: presentation.studentText,
    lectureId,
    sourceSecond,
    timestamp,
    sourceHref,
    sourceLinkText,
    signals,
  };
}

function present(
  decision: SpatialDecision,
  timestamp: string,
): { showAsset: boolean; warningRequired: boolean; studentText: string } {
  switch (decision) {
    case 'release':
      return {
        showAsset: true,
        warningRequired: false,
        studentText: timestamp ? `Original lecture at ${timestamp}` : '',
      };
    case 'label':
      return {
        showAsset: true,
        warningRequired: true,
        studentText: `AI-generated — verify against original lecture at ${timestamp}`,
      };
    case 'hold':
      return {
        showAsset: false,
        warningRequired: false,
        studentText: timestamp
          ? `Withheld — this spatial asset is not part of the lecture. Original lecture at ${timestamp}.`
          : 'Withheld — this spatial asset is not part of the lecture.',
      };
    default: {
      const unreachable: never = decision;
      return unreachable;
    }
  }
}

function decide(score: number, lectureId: string, sourceSecond: number | null): SpatialDecision {
  if (!lectureId || sourceSecond === null) return 'hold';
  if (score >= RELEASE_THRESHOLD) return 'release';
  if (score >= LABEL_THRESHOLD) return 'label';
  return 'hold';
}

export function formatSourceTimestamp(second: number): string {
  const total = Math.max(0, Math.floor(second));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function resolveSignals(
  asset: unknown,
  context: { lectureId?: string; segments?: unknown; keyframes?: unknown; concepts?: unknown },
): Record<string, unknown> {
  const data = mapping(asset);
  const frame = matchedKeyframe(data, context.keyframes);
  const lectureId = firstText(data.lecture_id, data.lesson_id, data.video_id, context.lectureId);
  let sourceSecond = explicitSecond(data);
  if (sourceSecond === null && frame) {
    sourceSecond = secondsFromMs(frame.time_ms);
    if (sourceSecond === null) sourceSecond = sourceSecondOf(frame.start);
  }
  const ocrConfidence = has(data, 'ocr_confidence') ? data.ocr_confidence : frameOcrConfidence(frame);
  const caption = explicitText(data, 'vision_caption', 'vision_snippet', 'caption') ?? frameCaption(frame);
  const ocrText = explicitText(data, 'ocr_text', 'ocr_snippet') ?? frameOcrText(frame);
  const transcript = has(data, 'transcript') ? text(data.transcript) : transcriptFor(context.segments, data, frame);
  const conceptSource = has(data, 'concepts') ? data.concepts : context.concepts;
  const path = has(data, 'keyframe_path') ? text(data.keyframe_path) : text(frame?.path) || text(frame?.frame_path);
  let frameTime: unknown = null;
  if (has(data, 'keyframe_time_ms')) frameTime = data.keyframe_time_ms;
  else if (frame && frame.time_ms !== undefined) frameTime = frame.time_ms;
  else if (frame && frame.start !== undefined) {
    const secs = numberOf(frame.start);
    frameTime = secs === null ? null : secs * 1000;
  }
  const width = has(data, 'width') ? data.width : (frame?.width ?? null);
  const height = has(data, 'height') ? data.height : (frame?.height ?? null);
  const assetId = typeof data.id === 'string' ? data.id : data.asset_id;
  return {
    lecture_id: lectureId,
    source_second: sourceSecond,
    ocr_confidence: ocrConfidence,
    vision_caption: caption,
    ocr_text: ocrText,
    transcript,
    concepts: conceptNodes(conceptSource, data.concept_ids),
    keyframe_path: path,
    keyframe_time_ms: frameTime,
    width,
    height,
    kind: typeof data.kind === 'string' ? data.kind : '',
    asset_id: typeof assetId === 'string' ? assetId : '',
  };
}

function matchedKeyframe(asset: Record<string, unknown>, keyframes: unknown): Record<string, unknown> | null {
  const frames = sequence(keyframes).filter(isRecord);
  if (!frames.length) return null;
  if (asset.keyframe_ordinal !== undefined) {
    const found = frames.find(frame => frame.ordinal === asset.keyframe_ordinal);
    if (found) return found;
  }
  if (typeof asset.keyframe_id === 'string' && asset.keyframe_id) {
    const found = frames.find(frame => frame.id === asset.keyframe_id || frame.keyframe_id === asset.keyframe_id);
    if (found) return found;
  }
  if (typeof asset.keyframe_path === 'string' && asset.keyframe_path) {
    const found = frames.find(frame => frame.path === asset.keyframe_path || frame.frame_path === asset.keyframe_path);
    if (found) return found;
  }
  return null;
}

function frameOcrConfidence(frame: Record<string, unknown> | null): unknown {
  const ocr = frame?.ocr;
  if (isRecord(ocr) && has(ocr, 'confidence')) return ocr.confidence;
  return null;
}

function frameOcrText(frame: Record<string, unknown> | null): string | null {
  if (!frame) return null;
  const ocr = frame.ocr;
  if (isRecord(ocr) && text(ocr.text)) return splitScreen(text(ocr.text)).ocr || null;
  const raw = text(frame.text);
  if (!raw) return null;
  return splitScreen(raw).ocr || null;
}

function frameCaption(frame: Record<string, unknown> | null): string | null {
  if (!frame) return null;
  for (const key of ['vision_caption', 'vision_snippet', 'caption']) {
    if (text(frame[key])) return text(frame[key]);
  }
  const raw = text(frame.text);
  if (raw && raw.toLowerCase().includes('visual explanation:')) return splitScreen(raw).caption || null;
  const ocr = frame.ocr;
  if (isRecord(ocr) && text(ocr.text).toLowerCase().includes('visual explanation:')) {
    return splitScreen(text(ocr.text)).caption || null;
  }
  return null;
}

function splitScreen(raw: string): { ocr: string; caption: string } {
  const parts = raw.split(/\n+Visual explanation:\s*/i);
  const ocr = (parts[0] ?? '').replace(/^On-screen OCR:\s*/i, '').trim();
  const caption = (parts[1] ?? '').trim();
  return { ocr, caption };
}

function transcriptFor(
  segments: unknown,
  asset: Record<string, unknown>,
  frame: Record<string, unknown> | null,
): string | null {
  const rows = sequence(segments).filter(isRecord);
  if (!rows.length) return null;
  let startMs = numberOf(asset.start_ms);
  let endMs = numberOf(asset.end_ms);
  if (startMs === null) startMs = secondsToMs(asset.start);
  if (endMs === null) endMs = secondsToMs(asset.end);
  if (startMs === null && frame) {
    startMs = numberOf(frame.time_ms);
    if (startMs === null) startMs = secondsToMs(frame.start);
  }
  if (startMs === null) {
    const second = explicitSecond(asset);
    if (second !== null) startMs = second * 1000;
  }
  if (startMs === null) return null;
  if (endMs === null) endMs = startMs;
  const parts: string[] = [];
  for (const row of rows) {
    let rowStart = numberOf(row.start_ms);
    let rowEnd = numberOf(row.end_ms);
    if (rowStart === null) rowStart = secondsToMs(row.start);
    if (rowEnd === null) rowEnd = secondsToMs(row.end);
    if (rowStart === null || rowEnd === null) continue;
    if (rowEnd < startMs - 15000 || rowStart > endMs + 15000) continue;
    const rowText = text(row.text);
    if (rowText) parts.push(rowText);
  }
  return parts.length ? parts.join(' ') : null;
}

function conceptComponent(data: Record<string, unknown>): number {
  let claim = text(data.vision_caption);
  if (!tokens(claim).size) claim = text(data.ocr_text);
  if (!tokens(claim).size) return 0;
  const nodes = flattenConcepts(data.concepts);
  if (!nodes.length) return 0;
  const corpus = nodes.map(node => `${node.title} ${node.summary}`).join(' ');
  return overlap(claim, corpus);
}

function conceptNodes(concepts: unknown, conceptIds: unknown): { id: string; title: string; summary: string }[] {
  const nodes = flattenConcepts(concepts);
  if (!Array.isArray(conceptIds)) return nodes;
  const ids = new Set(conceptIds.map(item => String(item)).filter(item => item.trim()));
  if (!ids.size) return nodes;
  return nodes.filter(node => ids.has(node.id));
}

function flattenConcepts(concepts: unknown): { id: string; title: string; summary: string }[] {
  if (concepts == null) return [];
  if (typeof concepts === 'string') {
    const title = concepts.trim();
    return title ? [{ id: '', title, summary: '' }] : [];
  }
  if (Array.isArray(concepts)) return concepts.flatMap(item => flattenConcepts(item));
  if (!isRecord(concepts)) return [];
  const nested = concepts.nodes !== undefined ? concepts.nodes : concepts.concepts;
  const nodes = nested !== undefined ? flattenConcepts(nested) : [];
  const title = text(concepts.title);
  const summary = text(concepts.summary);
  if (title || summary) {
    nodes.push({ id: typeof concepts.id === 'string' ? concepts.id : '', title, summary });
  }
  return nodes;
}

function overlap(claim: string, support: string): number {
  const claimTokens = tokens(claim);
  const supportTokens = tokens(support);
  if (!claimTokens.size || !supportTokens.size) return 0;
  let shared = 0;
  for (const token of claimTokens) {
    if (supportTokens.has(token)) shared += 1;
  }
  return shared / claimTokens.size;
}

function tokens(value: string): Set<string> {
  if (!value) return new Set();
  const found = value.toLowerCase().replace(/-/g, '').match(/[a-z0-9]{3,}/g) ?? [];
  return new Set(found.filter(token => !STOP.has(token)));
}

function ocrComponent(value: unknown): number {
  const number = numberOf(value);
  if (number === null || number < 0) return 0;
  if (number <= 1) return number;
  if (number <= 100) return number / 100;
  return 0;
}

function keyframeComponent(path: unknown, timeMs: unknown, width: unknown, height: unknown): number {
  if (typeof path !== 'string' || !path.trim()) return 0;
  const moment = numberOf(timeMs);
  if (moment === null || moment < 0) return 0;
  if (width !== null && width !== undefined) {
    const parsed = numberOf(width);
    if (parsed === null || parsed <= 0) return 0;
  }
  if (height !== null && height !== undefined) {
    const parsed = numberOf(height);
    if (parsed === null || parsed <= 0) return 0;
  }
  return 1;
}

function explicitSecond(data: Record<string, unknown>): number | null {
  if (has(data, 'source_second') || has(data, 'sourceSecond')) {
    return sourceSecondOf(has(data, 'source_second') ? data.source_second : data.sourceSecond);
  }
  if (has(data, 'time_ms')) return secondsFromMs(data.time_ms);
  if (has(data, 'start_ms')) return secondsFromMs(data.start_ms);
  if (has(data, 'start')) return sourceSecondOf(data.start);
  return null;
}

function explicitText(data: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    if (has(data, key)) return text(data[key]) || null;
  }
  return null;
}

function sourceSecondOf(value: unknown): number | null {
  const number = numberOf(value);
  if (number === null || number < 0) return null;
  return Math.floor(number);
}

function secondsFromMs(value: unknown): number | null {
  const number = numberOf(value);
  if (number === null || number < 0) return null;
  return Math.floor(number / 1000);
}

function secondsToMs(value: unknown): number | null {
  const number = numberOf(value);
  if (number === null) return null;
  return number * 1000;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const parsed = text(value);
    if (parsed) return parsed;
  }
  return '';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberOf(value: unknown): number | null {
  if (typeof value === 'boolean' || value == null) return null;
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(number)) return null;
  return number;
}

function mapping(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function sequence(value: unknown): unknown[] {
  if (value == null || isRecord(value) || typeof value === 'string') return [];
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function has(data: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(data, key);
}

function round4(value: number): number {
  return Math.round((value + 1e-12) * 10000) / 10000;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

import { describe, expect, it } from 'vitest';
import lectureSource from '../../../services/knowledge-worker/tests/fixtures/spatial_lecture.json?raw';
import publishedSource from '../../public/spatial/artifact.json?raw';
import sceneSource from '../../public/spatial/scene.gltf?raw';
import { FIXTURE_ARTIFACT } from '../../src/spatial/fixture';
import {
  citationIncludesArtifact,
  formatExactTimestamp,
  parseArtifact,
  playheadShowsArtifact,
  returnSeekSeconds,
  SpatialProvenanceError,
} from '../../src/spatial/provenance';

describe('spatial artifact provenance', () => {
  it('uses only the stored keyframe OCR lines', () => {
    const lecture = JSON.parse(lectureSource) as {
      lesson_id: string;
      keyframes: Array<{ id: string; time_ms: number; ocr?: { text?: string } }>;
      segments: Array<{ start_ms: number; end_ms: number; text: string }>;
    };
    const frame = lecture.keyframes.find(item => item.id === 'kf_request');
    const segment = lecture.segments.find(item => item.start_ms === 20000);
    expect(lecture.lesson_id).toBe(FIXTURE_ARTIFACT.lectureId);
    expect(frame?.time_ms).toBe(FIXTURE_ARTIFACT.keyframeTimeMs);
    expect(frame?.ocr?.text).toBe('API Gateway\nAuth\nOrders\nQueue');
    expect(FIXTURE_ARTIFACT.nodes.map(node => node.label)).toEqual(['API Gateway', 'Auth', 'Orders', 'Queue']);
    for (const node of FIXTURE_ARTIFACT.nodes) {
      expect(frame?.ocr?.text?.split('\n')).toContain(node.label);
    }
    expect(segment?.text).toBe(FIXTURE_ARTIFACT.context[0]?.quote);
    expect(returnSeekSeconds(FIXTURE_ARTIFACT)).toBe(24);
    expect(formatExactTimestamp(24)).toBe('0:24.000');
  });

  it('keeps the public artifact and glTF nodes on those labels', () => {
    expect(parseArtifact(JSON.parse(publishedSource))).toEqual(FIXTURE_ARTIFACT);
    const scene = JSON.parse(sceneSource) as { nodes?: Array<{ name?: string }> };
    expect(scene.nodes?.map(node => node.name)).toEqual(FIXTURE_ARTIFACT.nodes.map(node => node.label));
  });

  it('rejects a label that is not in the source quote', () => {
    expect(() =>
      parseArtifact({
        ...FIXTURE_ARTIFACT,
        nodes: [{ ...FIXTURE_ARTIFACT.nodes[0], label: 'presentation layer' }],
      }),
    ).toThrow(SpatialProvenanceError);
  });

  it('shows the player entry during the source segment on this lecture', () => {
    expect(playheadShowsArtifact('fixture-request-path', 24, FIXTURE_ARTIFACT)).toBe(true);
    expect(playheadShowsArtifact('fixture-request-path', 20, FIXTURE_ARTIFACT)).toBe(true);
    expect(playheadShowsArtifact('fixture-request-path', 2, FIXTURE_ARTIFACT)).toBe(false);
    expect(playheadShowsArtifact('other-lecture', 24, FIXTURE_ARTIFACT)).toBe(false);
  });

  it('opens from a citation that includes the keyframe time', () => {
    expect(
      citationIncludesArtifact(
        {
          lesson_id: 'fixture-request-path',
          start_seconds: 20,
          end_seconds: 36,
          text: 'The request path consists of an API gateway that flows into auth, then orders, then the queue.',
        },
        FIXTURE_ARTIFACT,
      ),
    ).toBe(true);
    expect(
      citationIncludesArtifact(
        { lesson_id: 'other-lecture', start_seconds: 20, end_seconds: 36, text: 'See API Gateway on the slide' },
        FIXTURE_ARTIFACT,
      ),
    ).toBe(true);
    expect(
      citationIncludesArtifact(
        { lesson_id: 'fixture-request-path', start_seconds: 60, end_seconds: 72, text: 'API Gateway' },
        FIXTURE_ARTIFACT,
      ),
    ).toBe(false);
  });
});

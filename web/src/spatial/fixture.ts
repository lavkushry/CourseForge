import { parseArtifact } from './provenance';
import type { SpatialArtifact } from './types';

// spatial-3d-artifact-dcaa had no committed mesh. These nodes are the OCR lines
// on keyframe kf_request at 24000 ms in the stored spatial lecture fixture.
const ocrQuote = 'API Gateway\nAuth\nOrders\nQueue';
const evidence = 'services/knowledge-worker/tests/fixtures/spatial_lecture.json';

const stored: SpatialArtifact = {
  lectureId: 'fixture-request-path',
  timestampSeconds: 24,
  keyframeTimeMs: 24000,
  title: 'Request path',
  modelUrl: '/spatial/scene.gltf',
  placement: 'floor',
  nodes: [
    { id: 'ocr-api-gateway', label: 'API Gateway', source: 'ocr', quote: ocrQuote, evidence },
    { id: 'ocr-auth', label: 'Auth', source: 'ocr', quote: ocrQuote, evidence },
    { id: 'ocr-orders', label: 'Orders', source: 'ocr', quote: ocrQuote, evidence },
    { id: 'ocr-queue', label: 'Queue', source: 'ocr', quote: ocrQuote, evidence },
  ],
  context: [
    {
      source: 'transcript',
      quote: 'The request path consists of an API gateway that flows into auth, then orders, then the queue.',
      startMs: 20000,
      endMs: 36000,
      evidence,
    },
  ],
};

export const FIXTURE_ARTIFACT: SpatialArtifact = parseArtifact(stored);

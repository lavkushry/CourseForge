import { describe, expect, it } from 'vitest';
import { parseSpatialAsset, visibleAssets } from '../../src/spatial/model';
import { boxesFromGlb } from '../../src/spatial/vr-session';

function glb(document: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(document));
  const padded = json.length + ((4 - (json.length % 4)) % 4);
  const bytes = new Uint8Array(20 + padded);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x676c5446, false);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, padded, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(json, 20);
  return bytes;
}

describe('spatial read model', () => {
  it('keeps source labels and drops a held asset from the explore list', () => {
    const asset = parseSpatialAsset({
      lecture_id: 'lec-1',
      concept_ids: ['kco_gateway'],
      start_seconds: 18,
      end_seconds: 36,
      asset_url: '/api/v1/lessons/lec-1/spatial/scene?kind=ar',
      kind: 'ar',
      decision: 'label',
      labels: ['API Gateway', 'Auth'],
    });
    expect(asset?.labels).toEqual(['API Gateway', 'Auth']);
    const held = parseSpatialAsset({
      lecture_id: 'lec-1',
      concept_ids: ['kco_gateway'],
      start_seconds: 18,
      end_seconds: 36,
      asset_url: '/api/v1/lessons/lec-1/spatial/scene?kind=vr',
      kind: 'vr',
      decision: 'hold',
    });
    expect(visibleAssets([asset, held].filter(item => item !== null))).toEqual([asset]);
  });

  it('reads only the labeled boxes from the generated glb', () => {
    const boxes = boxesFromGlb(
      glb({
        nodes: [
          { name: 'API Gateway', mesh: 0, translation: [0, 0, 0], scale: [2, 1, 1] },
          { name: 'Auth', mesh: 1, translation: [3, 0, 0], scale: [1, 1, 1] },
        ],
        materials: [
          { pbrMetallicRoughness: { baseColorFactor: [0.1, 0.2, 0.3, 0.4] } },
          { pbrMetallicRoughness: { baseColorFactor: [0.5, 0.6, 0.7, 0.8] } },
        ],
      }),
    );
    expect(boxes.map(box => box.label)).toEqual(['API Gateway', 'Auth']);
    expect(boxes[0]?.translation).toEqual([0, 0, 0]);
    expect(boxes[1]?.color).toEqual([0.5, 0.6, 0.7, 0.8]);
    expect(boxesFromGlb(new Uint8Array([1, 2, 3, 4]))).toEqual([]);
  });
});

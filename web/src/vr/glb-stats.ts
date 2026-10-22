export interface GlbStats {
  bytes: number;
  triangles: number;
  nodeNames: string[];
}

interface GlbAccessor {
  count?: number;
  type?: string;
}

interface GlbPrimitive {
  indices?: number;
}

interface GlbMesh {
  primitives?: GlbPrimitive[];
}

interface GlbNode {
  name?: string;
}

interface GlbJson {
  accessors?: GlbAccessor[];
  meshes?: GlbMesh[];
  nodes?: GlbNode[];
}

function jsonChunk(bytes: Uint8Array): GlbJson {
  if (bytes.byteLength < 20) throw new Error('GLB is too small');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== 0x46546c67) throw new Error('not a GLB');
  const chunkLength = view.getUint32(12, true);
  const chunkType = view.getUint32(16, true);
  if (chunkType !== 0x4e4f534a) throw new Error('GLB JSON chunk is missing');
  const jsonBytes = bytes.subarray(20, 20 + chunkLength);
  const text = new TextDecoder().decode(jsonBytes).replace(/\u0000|\s+$/g, '');
  return JSON.parse(text) as GlbJson;
}

export function readGlbStats(bytes: Uint8Array): GlbStats {
  const json = jsonChunk(bytes);
  let triangles = 0;
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.indices === undefined) continue;
      const accessor = json.accessors?.[primitive.indices];
      if (!accessor || accessor.type !== 'SCALAR' || typeof accessor.count !== 'number') continue;
      triangles += accessor.count / 3;
    }
  }
  return {
    bytes: bytes.byteLength,
    triangles,
    nodeNames: (json.nodes ?? []).map(node => node.name ?? ''),
  };
}

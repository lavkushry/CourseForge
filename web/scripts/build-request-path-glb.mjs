import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const provenance = JSON.parse(readFileSync(resolve(root, 'public/vr/provenance.json'), 'utf8'));
const labels = provenance.labels.map(label => label.text);
if (labels.length < 2) throw new Error('request-path GLB needs at least two OCR labels');

const COLORS = [
  [0.24, 0.49, 0.65, 1],
  [0.18, 0.44, 0.31, 1],
  [0.54, 0.35, 0.16, 1],
  [0.36, 0.3, 0.48, 1],
];

function box(width, height, depth) {
  const x = width / 2;
  const y = height / 2;
  const z = depth / 2;
  const faces = [
    [x, -y, -z, x, -y, z, x, y, z, x, y, -z, 1, 0, 0],
    [-x, -y, z, -x, -y, -z, -x, y, -z, -x, y, z, -1, 0, 0],
    [-x, y, -z, x, y, -z, x, y, z, -x, y, z, 0, 1, 0],
    [-x, -y, z, x, -y, z, x, -y, -z, -x, -y, -z, 0, -1, 0],
    [x, -y, z, -x, -y, z, -x, y, z, x, y, z, 0, 0, 1],
    [-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, 0, 0, -1],
  ];
  const positions = [];
  const normals = [];
  const indices = [];
  for (const face of faces) {
    const base = positions.length / 3;
    const normal = face.slice(12);
    for (let vertex = 0; vertex < 4; vertex += 1) {
      positions.push(face[vertex * 3], face[vertex * 3 + 1], face[vertex * 3 + 2]);
      normals.push(normal[0], normal[1], normal[2]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, indices };
}

function arrow() {
  const shaft = box(0.18, 0.05, 0.05);
  const headPositions = [];
  const headNormals = [];
  const headIndices = [];
  const tip = [0.16, 0, 0];
  const base = [
    [0.04, 0.07, 0.07],
    [0.04, -0.07, 0.07],
    [0.04, -0.07, -0.07],
    [0.04, 0.07, -0.07],
  ];
  const push = (point, normal) => {
    headPositions.push(point[0], point[1], point[2]);
    headNormals.push(normal[0], normal[1], normal[2]);
  };
  for (let side = 0; side < 4; side += 1) {
    const a = base[side];
    const b = base[(side + 1) % 4];
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = tip[0] - a[0];
    const vy = tip[1] - a[1];
    const vz = tip[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    const start = headPositions.length / 3;
    push(a, [nx, ny, nz]);
    push(b, [nx, ny, nz]);
    push(tip, [nx, ny, nz]);
    headIndices.push(start, start + 1, start + 2);
  }
  const start = headPositions.length / 3;
  for (const point of base) push(point, [-1, 0, 0]);
  headIndices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  return {
    positions: shaft.positions.concat(headPositions.map((value, index) => value + (index % 3 === 0 ? 0.09 : 0))),
    normals: shaft.normals.concat(headNormals),
    indices: shaft.indices.concat(headIndices.map(index => index + shaft.positions.length / 3)),
  };
}

function concatGeometry(parts) {
  const positions = [];
  const normals = [];
  const indices = [];
  for (const part of parts) {
    const offset = positions.length / 3;
    positions.push(...part.positions);
    normals.push(...part.normals);
    indices.push(...part.indices.map(index => index + offset));
  }
  return { positions, normals, indices };
}

const parts = [box(0.62, 0.36, 0.28), arrow()];
const geometry = parts.map(part => part);
const bufferParts = [];
const bufferViews = [];
const accessors = [];
let byteOffset = 0;

function align(value) {
  return (value + 3) & ~3;
}

function pushArray(array, componentType, type, target) {
  const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  const padding = align(byteOffset) - byteOffset;
  if (padding) bufferParts.push(Buffer.alloc(padding));
  byteOffset += padding;
  const viewIndex = bufferViews.length;
  bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length, target });
  byteOffset += bytes.length;
  bufferParts.push(bytes);
  const accessor = { bufferView: viewIndex, componentType, count: array.length / (type === 'VEC3' ? 3 : 1), type };
  if (type === 'VEC3') {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < array.length; index += 3) {
      min[0] = Math.min(min[0], array[index]);
      min[1] = Math.min(min[1], array[index + 1]);
      min[2] = Math.min(min[2], array[index + 2]);
      max[0] = Math.max(max[0], array[index]);
      max[1] = Math.max(max[1], array[index + 1]);
      max[2] = Math.max(max[2], array[index + 2]);
    }
    accessor.min = min;
    accessor.max = max;
  }
  accessors.push(accessor);
  return accessors.length - 1;
}

const meshes = geometry.map(part => {
  const position = pushArray(Float32Array.from(part.positions), 5126, 'VEC3', 34962);
  const normal = pushArray(Float32Array.from(part.normals), 5126, 'VEC3', 34962);
  const indices = pushArray(Uint16Array.from(part.indices), 5123, 'SCALAR', 34963);
  return { primitives: [{ attributes: { POSITION: position, NORMAL: normal }, indices, material: 0 }] };
});

const bin = Buffer.concat(bufferParts);
const spacing = 0.9;
const origin = -((labels.length - 1) * spacing) / 2;
const nodes = [];
const sceneNodes = [];
labels.forEach((label, index) => {
  nodes.push({
    name: label,
    mesh: 0,
    translation: [origin + index * spacing, 0.9, 0],
    extras: { source: 'ocr', quote: label },
  });
  sceneNodes.push(nodes.length - 1);
  if (index < labels.length - 1) {
    nodes.push({
      name: `flow-${index + 1}`,
      mesh: 1,
      translation: [origin + index * spacing + spacing / 2, 0.9, 0],
    });
    sceneNodes.push(nodes.length - 1);
  }
});

const materials = [
  {
    name: 'request-path',
    pbrMetallicRoughness: { baseColorFactor: COLORS[0], metallicFactor: 0.04, roughnessFactor: 0.62 },
    doubleSided: true,
  },
];
meshes[0].primitives[0].material = 0;
meshes[1].primitives[0].material = 0;

const json = {
  asset: { version: '2.0', generator: 'courseforge-spatial-vr' },
  scene: 0,
  scenes: [{ name: provenance.concept, nodes: sceneNodes }],
  nodes,
  meshes,
  materials,
  buffers: [{ byteLength: bin.length }],
  bufferViews,
  accessors,
};
const jsonText = JSON.stringify(json);
const jsonBuffer = Buffer.from(jsonText);
const jsonPadding = Buffer.alloc(align(jsonBuffer.length) - jsonBuffer.length, 0x20);
const jsonChunk = Buffer.concat([jsonBuffer, jsonPadding]);
const binPadding = Buffer.alloc(align(bin.length) - bin.length);
const binChunk = Buffer.concat([bin, binPadding]);
const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(total, 8);
const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(jsonChunk.length, 0);
jsonHeader.writeUInt32LE(0x4e4f534a, 4);
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(binChunk.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4);
const glb = Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
const output = resolve(root, 'public/vr/request-path.glb');
writeFileSync(output, glb);
console.log(`wrote ${output} (${glb.length} bytes, labels ${labels.join(' | ')})`);

export interface SceneBox {
  label: string;
  translation: [number, number, number];
  scale: [number, number, number];
  color: [number, number, number, number];
}

export interface VrHandle {
  end(): Promise<void>;
  readonly ended: Promise<void>;
}

const MODEL_URL = /^\/api\/v1\/lessons\/[A-Za-z0-9_-]{1,200}\/spatial\/model\?kind=(3d|ar|vr)$/;

function finiteTriple(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) return fallback;
  const next = value.slice(0, 3).map(item => (typeof item === 'number' && Number.isFinite(item) ? item : Number.NaN));
  if (next.some(item => Number.isNaN(item))) return fallback;
  return [next[0] ?? 0, next[1] ?? 0, next[2] ?? 0];
}

function finiteColor(value: unknown): [number, number, number, number] {
  if (!Array.isArray(value) || value.length < 4) return [0.2, 0.4, 0.6, 0.7];
  const next = value.slice(0, 4).map(item => (typeof item === 'number' && Number.isFinite(item) ? item : Number.NaN));
  if (next.some(item => Number.isNaN(item))) return [0.2, 0.4, 0.6, 0.7];
  return [next[0] ?? 0.2, next[1] ?? 0.4, next[2] ?? 0.6, next[3] ?? 0.7];
}

/** Read labeled boxes from a GLB this pipeline wrote. A foreign file yields no boxes. */
export function boxesFromGlb(data: Uint8Array): SceneBox[] {
  if (data.byteLength < 20) return [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, false) !== 0x676c5446) return [];
  if (view.getUint32(8, true) !== data.byteLength) return [];
  const chunkLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a) return [];
  if (chunkLength < 2 || 20 + chunkLength > data.byteLength) return [];
  const jsonBytes = data.subarray(20, 20 + chunkLength);
  let end = jsonBytes.length;
  while (end > 0 && jsonBytes[end - 1] === 0x20) end -= 1;
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder().decode(jsonBytes.subarray(0, end)));
  } catch {
    return [];
  }
  if (!document || typeof document !== 'object') return [];
  const record = document as { nodes?: unknown; materials?: unknown };
  if (!Array.isArray(record.nodes)) return [];
  const materials = Array.isArray(record.materials) ? record.materials : [];
  const boxes: SceneBox[] = [];
  for (const node of record.nodes) {
    if (!node || typeof node !== 'object') continue;
    const item = node as { name?: unknown; mesh?: unknown; translation?: unknown; scale?: unknown };
    if (typeof item.name !== 'string' || item.name.trim() === '') continue;
    const mesh = typeof item.mesh === 'number' ? item.mesh : -1;
    const material = materials[mesh] as { pbrMetallicRoughness?: { baseColorFactor?: unknown } } | undefined;
    boxes.push({
      label: item.name,
      translation: finiteTriple(item.translation, [0, 0, 0]),
      scale: finiteTriple(item.scale, [1, 1, 1]),
      color: finiteColor(material?.pbrMetallicRoughness?.baseColorFactor),
    });
  }
  return boxes;
}

function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[column * 4 + row] =
        (a[row] ?? 0) * (b[column * 4] ?? 0) +
        (a[4 + row] ?? 0) * (b[column * 4 + 1] ?? 0) +
        (a[8 + row] ?? 0) * (b[column * 4 + 2] ?? 0) +
        (a[12 + row] ?? 0) * (b[column * 4 + 3] ?? 0);
    }
  }
  return out;
}

function modelMatrix(box: SceneBox, fit: { scale: number; center: [number, number, number] }): Float32Array {
  const matrix = new Float32Array(16);
  matrix[0] = box.scale[0] * fit.scale;
  matrix[5] = box.scale[1] * fit.scale;
  matrix[10] = box.scale[2] * fit.scale;
  matrix[15] = 1;
  matrix[12] = (box.translation[0] - fit.center[0]) * fit.scale;
  matrix[13] = (box.translation[1] - fit.center[1]) * fit.scale + 1.2;
  matrix[14] = (box.translation[2] - fit.center[2]) * fit.scale - 1.6;
  return matrix;
}

function fitBoxes(boxes: readonly SceneBox[]): { scale: number; center: [number, number, number] } {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.translation[0] - box.scale[0] / 2);
    minY = Math.min(minY, box.translation[1] - box.scale[1] / 2);
    minZ = Math.min(minZ, box.translation[2] - box.scale[2] / 2);
    maxX = Math.max(maxX, box.translation[0] + box.scale[0] / 2);
    maxY = Math.max(maxY, box.translation[1] + box.scale[1] / 2);
    maxZ = Math.max(maxZ, box.translation[2] + box.scale[2] / 2);
  }
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 0.001);
  return {
    scale: 0.9 / span,
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
  };
}

const CUBE = new Float32Array([
  -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5,
  0.5, -0.5, 0.5, 0.5,
]);
const CUBE_INDEX = new Uint16Array([
  0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 2, 6, 7, 2, 7, 3, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
]);

interface XrView {
  projectionMatrix: Float32Array;
  transform: { inverse: { matrix: Float32Array } };
}

interface XrViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface XrLayer {
  framebuffer: WebGLFramebuffer | null;
  getViewport(view: XrView): XrViewport | undefined;
}

type XrReferenceSpace = object;

interface XrFrame {
  getViewerPose(space: XrReferenceSpace): { views: readonly XrView[] } | undefined;
}

interface XrSession {
  updateRenderState(state: { baseLayer: XrLayer }): void;
  requestReferenceSpace(kind: 'local'): Promise<XrReferenceSpace>;
  requestAnimationFrame(callback: (time: number, frame: XrFrame) => void): number;
  addEventListener(type: 'end', listener: () => void): void;
  end(): Promise<void>;
}

interface XrSystem {
  requestSession(mode: 'immersive-vr'): Promise<XrSession>;
}

function headset(): XrSystem | null {
  const xr = (navigator as Navigator & { xr?: XrSystem }).xr;
  return xr ?? null;
}

function webGlLayer(session: XrSession, gl: WebGLRenderingContext): XrLayer | null {
  const ctor = (globalThis as { XRWebGLLayer?: new (session: XrSession, context: WebGLRenderingContext) => XrLayer })
    .XRWebGLLayer;
  if (!ctor) return null;
  return new ctor(session, gl);
}

function startRenderer(
  session: XrSession,
  gl: WebGLRenderingContext,
  layer: XrLayer,
  space: XrReferenceSpace,
  boxes: readonly SceneBox[],
): void {
  const fit = fitBoxes(boxes);
  const program = gl.createProgram();
  const vertex = gl.createShader(gl.VERTEX_SHADER);
  const fragment = gl.createShader(gl.FRAGMENT_SHADER);
  if (!program || !vertex || !fragment) return;
  gl.shaderSource(
    vertex,
    'attribute vec3 position; uniform mat4 mvp; void main() { gl_Position = mvp * vec4(position, 1.0); }',
  );
  gl.shaderSource(fragment, 'precision mediump float; uniform vec4 color; void main() { gl_FragColor = color; }');
  gl.compileShader(vertex);
  gl.compileShader(fragment);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  const buffer = gl.createBuffer();
  const index = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, CUBE, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, CUBE_INDEX, gl.STATIC_DRAW);
  const mvpLocation = gl.getUniformLocation(program, 'mvp');
  const colorLocation = gl.getUniformLocation(program, 'color');
  gl.enable(gl.DEPTH_TEST);
  let running = true;
  session.addEventListener('end', () => {
    running = false;
  });
  const draw = (_time: number, frame: XrFrame) => {
    if (!running) return;
    session.requestAnimationFrame(draw);
    const pose = frame.getViewerPose(space);
    if (!pose) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0.04, 0.06, 0.1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0);
    for (const view of pose.views) {
      const viewport = layer.getViewport(view);
      if (!viewport) continue;
      gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
      const viewMatrix = view.transform.inverse.matrix;
      for (const box of boxes) {
        const mvp = multiply(view.projectionMatrix, multiply(viewMatrix, modelMatrix(box, fit)));
        gl.uniformMatrix4fv(mvpLocation, false, mvp);
        gl.uniform4f(colorLocation, box.color[0], box.color[1], box.color[2], box.color[3]);
        gl.drawElements(gl.TRIANGLES, CUBE_INDEX.length, gl.UNSIGNED_SHORT, 0);
      }
    }
  };
  session.requestAnimationFrame(draw);
}

/**
 * Enter immersive VR for one generated model.
 * The session request is the first await so the click gesture still counts.
 * Returns null when this browser has no headset. The caller keeps the rotatable model.
 */
export async function enterSpatialVr(modelUrl: string): Promise<VrHandle | null> {
  const xr = headset();
  if (!xr || !MODEL_URL.test(modelUrl)) return null;
  let session: XrSession;
  try {
    session = await xr.requestSession('immersive-vr');
  } catch {
    return null;
  }
  let ended = false;
  const finished = new Promise<void>(resolve => {
    session.addEventListener('end', () => {
      ended = true;
      resolve();
    });
  });
  const handle: VrHandle = {
    ended: finished,
    end: () => (ended ? Promise.resolve() : session.end()),
  };
  try {
    const response = await fetch(modelUrl, { credentials: 'same-origin' });
    if (!response.ok) {
      await handle.end();
      return null;
    }
    const boxes = boxesFromGlb(new Uint8Array(await response.arrayBuffer()));
    if (boxes.length === 0) {
      await handle.end();
      return null;
    }
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', { xrCompatible: true }) as
      | (WebGLRenderingContext & { makeXRCompatible?: () => Promise<void> })
      | null;
    if (!gl?.makeXRCompatible) {
      await handle.end();
      return null;
    }
    await gl.makeXRCompatible();
    const layer = webGlLayer(session, gl);
    if (!layer) {
      await handle.end();
      return null;
    }
    session.updateRenderState({ baseLayer: layer });
    const space = await session.requestReferenceSpace('local');
    startRenderer(session, gl, layer, space, boxes);
    return handle;
  } catch {
    await handle.end();
    return null;
  }
}

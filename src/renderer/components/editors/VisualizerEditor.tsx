import { useRef, useState, useEffect, useCallback } from 'react';
import Editor, { BeforeMount, OnMount, Monaco } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { useAppDispatch, useAppSelector } from '../../store';
import { entityLoaded, entityUpdated } from '../../store/uiSlice';
import { invoke } from '../../ipc/client';
import { VisualizerData, BufferData, EntityData, DataType } from '../../../shared/types';

// ---- Types ----

type BufferLike = Int32Array | Uint32Array | BigInt64Array | BigUint64Array | Float32Array | Float64Array;
type Tab = 0 | 1 | 2 | 3;

// ---- Tessellator ----

/** Accumulates per-vertex geometry data for upload to a WebGL VAO. */
class Tessellator {
  private pos: number[] = [];
  private uv: number[] = [];
  private norm: number[] = [];
  private col: number[] = [];

  push(
    position: [number, number, number],
    texCoord: [number, number] = [0, 0],
    normal: [number, number, number] = [0, 0, 1],
    color: [number, number, number, number] = [1, 1, 1, 1]
  ): void {
    this.pos.push(...position);
    this.uv.push(...texCoord);
    this.norm.push(...normal);
    this.col.push(...color);
  }

  get vertexCount() { return this.pos.length / 3; }
  get positionData() { return new Float32Array(this.pos); }
  get uvData()       { return new Float32Array(this.uv); }
  get normalData()   { return new Float32Array(this.norm); }
  get colorData()    { return new Float32Array(this.col); }
}

// ---- OrbitCamera ----

/** Orbit (arcball) camera with WASD panning, mouse drag orbit, scroll zoom. */
class OrbitCamera {
  yaw = 0;
  pitch = 0.3;
  radius = 5;
  target: [number, number, number] = [0, 0, 0];

  private static ORBIT_SPEED = 0.005;
  private static ZOOM_FACTOR = 0.001;

  onMouseMove(dx: number, dy: number): void {
    this.yaw += dx * OrbitCamera.ORBIT_SPEED;
    this.pitch = Math.max(-Math.PI / 2 + 0.01,
      Math.min(Math.PI / 2 - 0.01, this.pitch - dy * OrbitCamera.ORBIT_SPEED));
  }

  onWheel(delta: number): void {
    this.radius = Math.max(0.01, this.radius * (1 + delta * OrbitCamera.ZOOM_FACTOR));
  }

  /** Move the orbit target in camera-local horizontal directions. dt is seconds. */
  onKeys(keys: Set<string>, dt: number): void {
    const speed = 2 * this.radius * dt;
    const fwdX = -Math.sin(this.yaw);
    const fwdZ = -Math.cos(this.yaw);
    const rightX = Math.cos(this.yaw);
    const rightZ = -Math.sin(this.yaw);

    if (keys.has('w') || keys.has('W')) { this.target[0] += fwdX * speed; this.target[2] += fwdZ * speed; }
    if (keys.has('s') || keys.has('S')) { this.target[0] -= fwdX * speed; this.target[2] -= fwdZ * speed; }
    if (keys.has('a') || keys.has('A')) { this.target[0] -= rightX * speed; this.target[2] -= rightZ * speed; }
    if (keys.has('d') || keys.has('D')) { this.target[0] += rightX * speed; this.target[2] += rightZ * speed; }
  }

  get position(): [number, number, number] {
    const cosP = Math.cos(this.pitch);
    return [
      this.target[0] + this.radius * cosP * Math.sin(this.yaw),
      this.target[1] + this.radius * Math.sin(this.pitch),
      this.target[2] + this.radius * cosP * Math.cos(this.yaw),
    ];
  }

  get viewMatrix(): Float32Array {
    return mat4LookAt(this.position, this.target);
  }
}

// ---- Math (column-major, WebGL convention) ----

function mat4LookAt(eye: [number, number, number], center: [number, number, number]): Float32Array {
  let fx = center[0] - eye[0];
  let fy = center[1] - eye[1];
  let fz = center[2] - eye[2];
  const fLen = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
  fx /= fLen; fy /= fLen; fz /= fLen;

  // right = cross(forward, worldUp=(0,1,0))
  let rx = -fz, ry = 0, rz = fx;
  const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
  rx /= rLen; ry /= rLen; rz /= rLen;

  // up = cross(right, forward)
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;

  return new Float32Array([
    rx, ux, -fx, 0,
    ry, uy, -fy, 0,
    rz, uz, -fz, 0,
    -(rx * eye[0] + ry * eye[1] + rz * eye[2]),
    -(ux * eye[0] + uy * eye[1] + uz * eye[2]),
     (fx * eye[0] + fy * eye[1] + fz * eye[2]),
    1,
  ]);
}

function mat4Perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0,          f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

// ---- WebGL ----

type CompileResult =
  | { ok: true; program: WebGLProgram }
  | { ok: false; vertErrors: string[]; fragErrors: string[] };

function compileWebGLProgram(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): CompileResult {
  const vertErrors = getShaderErrors(gl, gl.VERTEX_SHADER, vertSrc);
  const fragErrors = getShaderErrors(gl, gl.FRAGMENT_SHADER, fragSrc);
  if (vertErrors || fragErrors) {
    return { ok: false, vertErrors: vertErrors ?? [], fragErrors: fragErrors ?? [] };
  }

  const vert = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(vert, vertSrc);
  gl.compileShader(vert);

  const frag = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(frag, fragSrc);
  gl.compileShader(frag);

  const program = gl.createProgram()!;
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  gl.deleteShader(vert);
  gl.deleteShader(frag);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'Link failed';
    gl.deleteProgram(program);
    return { ok: false, vertErrors: [], fragErrors: [log] };
  }

  return { ok: true, program };
}

/** Returns error lines if compilation failed, null if success. */
function getShaderErrors(gl: WebGL2RenderingContext, type: number, src: string): string[] | null {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? '';
    gl.deleteShader(sh);
    return log.split('\n').filter(Boolean);
  }
  gl.deleteShader(sh);
  return null;
}

function uploadGeometry(gl: WebGL2RenderingContext, tess: Tessellator): { vao: WebGLVertexArrayObject; vbos: WebGLBuffer[] } {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);

  const attribs = [
    { data: tess.positionData, loc: 0, size: 3 },
    { data: tess.uvData,       loc: 1, size: 2 },
    { data: tess.normalData,   loc: 2, size: 3 },
    { data: tess.colorData,    loc: 3, size: 4 },
  ];

  const vbos: WebGLBuffer[] = [];
  for (const { data, loc, size } of attribs) {
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    vbos.push(vbo);
  }

  gl.bindVertexArray(null);
  return { vao, vbos };
}

// ---- GLSL Monaco helpers ----

let glslRegistered = false;

function registerGlsl(monaco: Monaco): void {
  if (glslRegistered) return;
  glslRegistered = true;
  monaco.languages.register({ id: 'glsl' });
  monaco.languages.setMonarchTokensProvider('glsl', {
    keywords: [
      'void', 'layout', 'uniform', 'buffer', 'readonly', 'writeonly',
      'in', 'out', 'inout', 'flat', 'smooth', 'centroid', 'invariant',
      'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
      'break', 'continue', 'return', 'discard',
      'struct', 'const', 'precision', 'highp', 'mediump', 'lowp',
      'shared', 'coherent', 'volatile', 'restrict', 'binding', 'location',
      'std430', 'std140', 'set', 'local_size_x', 'local_size_y', 'local_size_z',
    ],
    types: [
      'float', 'double', 'int', 'uint', 'bool',
      'vec2', 'vec3', 'vec4', 'dvec2', 'dvec3', 'dvec4',
      'ivec2', 'ivec3', 'ivec4', 'uvec2', 'uvec3', 'uvec4',
      'bvec2', 'bvec3', 'bvec4', 'mat2', 'mat3', 'mat4',
      'mat2x2', 'mat2x3', 'mat2x4', 'mat3x2', 'mat3x3', 'mat3x4',
      'mat4x2', 'mat4x3', 'mat4x4',
      'sampler2D', 'sampler3D', 'samplerCube', 'sampler2DArray',
      'usampler2D', 'isampler2D', 'image2D', 'uimage2D', 'iimage2D',
    ],
    tokenizer: {
      root: [
        [/#version\b.*$/, 'keyword'],
        [/#\w+/, 'keyword'],
        [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@types': 'type', '@default': 'identifier' } }],
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@block'],
        [/\d+\.\d*([eE][+-]?\d+)?[fF]?/, 'number.float'],
        [/\.\d+([eE][+-]?\d+)?[fF]?/, 'number.float'],
        [/\d+[uU]?/, 'number'],
        [/[{}()[\]]/, 'delimiter.bracket'],
        [/[;,.]/, 'delimiter'],
      ],
      block: [[/[^/*]+/, 'comment'], [/\*\//, 'comment', '@pop'], [/[/*]/, 'comment']],
    },
  });
}

function parseErrorToMarker(err: string, model: editor.ITextModel, monaco: Monaco): editor.IMarkerData {
  const nv = err.match(/ERROR:\s*\d+:(\d+):\s*(.*)/i);
  if (nv) return glslMarker(parseInt(nv[1], 10), nv[2].trim(), model, monaco);
  const amd = err.match(/\d+:(\d+)\(\d+\):\s*(?:error:\s*)?(.*)/i);
  if (amd) return glslMarker(parseInt(amd[1], 10), amd[2].trim(), model, monaco);
  const nvalt = err.match(/\d+\((\d+)\)\s*:\s*(.*)/);
  if (nvalt) return glslMarker(parseInt(nvalt[1], 10), nvalt[2].trim(), model, monaco);
  return glslMarker(1, err, model, monaco);
}

function glslMarker(line: number, message: string, model: editor.ITextModel, monaco: Monaco): editor.IMarkerData {
  return {
    startLineNumber: line, startColumn: 1,
    endLineNumber: line, endColumn: model.getLineMaxColumn(line),
    message, severity: monaco.MarkerSeverity.Error,
  };
}

// ---- Data helpers ----

function toTypedArray(data: number[], dt: DataType): BufferLike {
  switch (dt) {
    case 'f32': return new Float32Array(data);
    case 'f64': return new Float64Array(data);
    case 'i32': return new Int32Array(data);
    case 'u32': return new Uint32Array(data);
    case 'i64': return BigInt64Array.from(data, BigInt);
    case 'u64': return BigUint64Array.from(data, BigInt);
  }
}

// ---- Background (sky + grid) ----

const SKY_VERT = `#version 300 es
out vec2 vNDC;
void main() {
  vec2 pos = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(pos, 0.9999, 1.0);
  vNDC = pos;
}`;

const SKY_FRAG = `#version 300 es
precision highp float;
in vec2 vNDC;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uForward;
uniform float uTanHalfFovY;
uniform float uAspect;
out vec4 fragColor;
void main() {
  vec3 rayDir = normalize(
    vNDC.x * uAspect * uTanHalfFovY * uRight +
    vNDC.y * uTanHalfFovY * uUp +
    uForward
  );
  float h = clamp(rayDir.y * 2.0, -1.0, 1.0);
  vec3 top     = vec3(0.12, 0.24, 0.50);
  vec3 horizon = vec3(0.50, 0.65, 0.80);
  vec3 ground  = vec3(0.16, 0.16, 0.18);
  vec3 col = h > 0.0 ? mix(horizon, top, h) : mix(horizon, ground, -h);
  fragColor = vec4(col, 1.0);
}`;

const GRID_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPosition;
uniform mat4 uView;
uniform mat4 uProjection;
out vec3 vWorldPos;
void main() {
  gl_Position = uProjection * uView * vec4(aPosition, 1.0);
  vWorldPos = aPosition;
}`;

const GRID_FRAG = `#version 300 es
precision highp float;
in vec3 vWorldPos;
out vec4 fragColor;
void main() {
  float dist  = length(vWorldPos.xz);
  float alpha = 1.0 - smoothstep(8.0, 12.0, dist);
  vec3 col;
  if (abs(vWorldPos.z) < 0.01) {
    col = vec3(0.75, 0.20, 0.20); // X axis — red
  } else if (abs(vWorldPos.x) < 0.01) {
    col = vec3(0.20, 0.20, 0.75); // Z axis — blue
  } else {
    col = vec3(0.38, 0.38, 0.38);
  }
  fragColor = vec4(col, alpha);
}`;

function buildSkyProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
  const r = compileWebGLProgram(gl, SKY_VERT, SKY_FRAG);
  if (!r.ok) { console.error('Sky shader failed', r); return null; }
  return r.program;
}

function buildGridProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
  const r = compileWebGLProgram(gl, GRID_VERT, GRID_FRAG);
  if (!r.ok) { console.error('Grid shader failed', r); return null; }
  return r.program;
}

function buildGridGeometry(gl: WebGL2RenderingContext, range: number): { vao: WebGLVertexArrayObject; count: number } {
  const verts: number[] = [];
  for (let i = -range; i <= range; i++) {
    verts.push(-range, 0, i,  range, 0, i); // lines parallel to X axis
    verts.push(i, 0, -range,  i, 0, range); // lines parallel to Z axis
  }
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { vao, count: verts.length / 3 };
}

// ---- Component ----

const DEBOUNCE_MS = 500;

export default function VisualizerEditor({ id }: { id: string }) {
  const dispatch = useAppDispatch();
  const data = useAppSelector(state => state.ui.openEntities[id]) as VisualizerData;
  const entityRef = useAppSelector(state => state.project.entities.find(e => e.id === id));
  const bufferEntities = useAppSelector(state => state.project.entities.filter(e => e.type === 'buffer'));
  const openEntities = useAppSelector(state => state.ui.openEntities);
  const executionResults = useAppSelector(state => state.ui.executionResults);

  const [activeTab, setActiveTab] = useState<Tab>(0);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [vertErrors, setVertErrors] = useState<string[]>([]);
  const [fragErrors, setFragErrors] = useState<string[]>([]);

  // WebGL GPU resources
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<WebGL2RenderingContext | null>(null);
  const programRef = useRef<WebGLProgram | null>(null);
  const vaoRef = useRef<WebGLVertexArrayObject | null>(null);
  const vboListRef = useRef<WebGLBuffer[]>([]);
  const vertCountRef = useRef(0);

  // Background resources (compiled once on init)
  const skyProgramRef = useRef<WebGLProgram | null>(null);
  const gridProgramRef = useRef<WebGLProgram | null>(null);
  const gridVaoRef = useRef<WebGLVertexArrayObject | null>(null);
  const gridCountRef = useRef(0);

  // Camera and input
  const cameraRef = useRef(new OrbitCamera());
  const keysRef = useRef(new Set<string>());
  const isDraggingRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef(0);

  // Monaco
  const vertEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const fragEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep latest Redux state accessible from stable callbacks without stale closures.
  const dataRef = useRef(data);
  dataRef.current = data;
  const bufferEntitiesRef = useRef(bufferEntities);
  bufferEntitiesRef.current = bufferEntities;
  const openEntitiesRef = useRef(openEntities);
  openEntitiesRef.current = openEntities;
  const executionResultsRef = useRef(executionResults);
  executionResultsRef.current = executionResults;
  const entityFilePathRef = useRef(entityRef?.filePath);
  entityFilePathRef.current = entityRef?.filePath;

  // Load buffer entities that aren't in openEntities yet
  useEffect(() => {
    for (const bufRef of bufferEntitiesRef.current) {
      if (!openEntitiesRef.current[bufRef.id]) {
        invoke<EntityData>('entity:load', { filePath: bufRef.filePath }).then(bufData => {
          dispatch(entityLoaded({ id: bufRef.id, data: bufData }));
        });
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function buildBufferMap(): Record<string, BufferLike> {
    const map: Record<string, BufferLike> = {};
    for (const bufRef of bufferEntitiesRef.current) {
      const bufData = openEntitiesRef.current[bufRef.id] as BufferData | undefined;
      if (!bufData) continue;
      const results = executionResultsRef.current?.[bufRef.id];
      if (results !== undefined) {
        map[bufRef.name] = toTypedArray(results, bufData.dataType);
      } else if (bufData.predefinedData?.source === 'inline') {
        map[bufRef.name] = toTypedArray(bufData.predefinedData.data, bufData.dataType);
      }
    }
    return map;
  }

  function rebuildGeometry(): void {
    const gl = glRef.current;
    if (!gl) return;

    if (vaoRef.current) {
      gl.deleteVertexArray(vaoRef.current);
      for (const vbo of vboListRef.current) gl.deleteBuffer(vbo);
      vaoRef.current = null;
      vboListRef.current = [];
    }

    const tess = new Tessellator();
    try {
      const fn = new Function('return (' + dataRef.current.script + ')')();
      fn(tess, buildBufferMap());
      setScriptError(null);
    } catch (e) {
      setScriptError(e instanceof Error ? e.message : String(e));
    }

    if (tess.vertexCount > 0) {
      const { vao, vbos } = uploadGeometry(gl, tess);
      vaoRef.current = vao;
      vboListRef.current = vbos;
    }
    vertCountRef.current = tess.vertexCount;
  }

  function rebuildProgram(): void {
    const gl = glRef.current;
    if (!gl) return;

    if (programRef.current) {
      gl.deleteProgram(programRef.current);
      programRef.current = null;
    }

    const result = compileWebGLProgram(gl, dataRef.current.vertexShader, dataRef.current.fragmentShader);
    const monaco = monacoRef.current;

    if (!result.ok) {
      setVertErrors(result.vertErrors);
      setFragErrors(result.fragErrors);
      if (monaco) {
        applyMarkers(vertEditorRef.current, result.vertErrors, monaco);
        applyMarkers(fragEditorRef.current, result.fragErrors, monaco);
      }
      return;
    }

    setVertErrors([]);
    setFragErrors([]);
    programRef.current = result.program;
    if (monaco) {
      applyMarkers(vertEditorRef.current, [], monaco);
      applyMarkers(fragEditorRef.current, [], monaco);
    }
  }

  function applyMarkers(ed: editor.IStandaloneCodeEditor | null, errors: string[], monaco: Monaco): void {
    if (!ed) return;
    const model = ed.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(model, 'glsl',
      errors.map(e => parseErrorToMarker(e, model, monaco)));
  }

  // Initialize WebGL once the canvas is in the DOM.
  // Canvas is always rendered (just hidden when not on render tab), so this fires once on mount.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl2');
    if (!gl) return;
    glRef.current = gl;
    gl.enable(gl.DEPTH_TEST);

    skyProgramRef.current = buildSkyProgram(gl);
    gridProgramRef.current = buildGridProgram(gl);
    const gridGeo = buildGridGeometry(gl, 10);
    gridVaoRef.current = gridGeo.vao;
    gridCountRef.current = gridGeo.count;

    rebuildProgram();
    rebuildGeometry();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // RAF loop — only runs when render tab is visible
  useEffect(() => {
    if (activeTab !== 3) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }

    lastTimeRef.current = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - lastTimeRef.current) / 1000, 0.1);
      lastTimeRef.current = now;
      cameraRef.current.onKeys(keysRef.current, dt);
      renderFrame();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep canvas resolution matched to its CSS display size
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // Rebuild geometry when pipeline execution results arrive
  useEffect(() => {
    rebuildGeometry();
  }, [executionResults]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderFrame = useCallback(() => {
    const gl = glRef.current;
    const canvas = canvasRef.current;
    if (!gl || !canvas) return;

    const aspect = canvas.width / canvas.height;
    const view = cameraRef.current.viewMatrix;
    const proj = mat4Perspective(Math.PI / 4, aspect, 0.01, 1000);

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Sky — fullscreen triangle via gl_VertexID, no depth test/write so it stays as background
    if (skyProgramRef.current) {
      // Extract camera basis from column-major view matrix: col0=right, col1=up, col2=-forward
      const right   = [view[0],  view[4],  view[8] ];
      const up      = [view[1],  view[5],  view[9] ];
      const forward = [-view[2], -view[6], -view[10]];
      const tanHalfFovY = Math.tan(Math.PI / 8); // half of PI/4 fov

      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.useProgram(skyProgramRef.current);
      gl.uniform3fv(gl.getUniformLocation(skyProgramRef.current, 'uRight'),       right);
      gl.uniform3fv(gl.getUniformLocation(skyProgramRef.current, 'uUp'),          up);
      gl.uniform3fv(gl.getUniformLocation(skyProgramRef.current, 'uForward'),     forward);
      gl.uniform1f(gl.getUniformLocation(skyProgramRef.current,  'uTanHalfFovY'), tanHalfFovY);
      gl.uniform1f(gl.getUniformLocation(skyProgramRef.current,  'uAspect'),      aspect);
      gl.bindVertexArray(null);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
    }

    // Grid — alpha-blended lines on the XZ plane (red X axis, blue Z axis)
    if (gridProgramRef.current && gridVaoRef.current) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(gridProgramRef.current);
      gl.uniformMatrix4fv(gl.getUniformLocation(gridProgramRef.current, 'uView'), false, view);
      gl.uniformMatrix4fv(gl.getUniformLocation(gridProgramRef.current, 'uProjection'), false, proj);
      gl.bindVertexArray(gridVaoRef.current);
      gl.drawArrays(gl.LINES, 0, gridCountRef.current);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }

    // User geometry
    if (programRef.current && vaoRef.current && vertCountRef.current > 0) {
      gl.useProgram(programRef.current);
      gl.uniformMatrix4fv(gl.getUniformLocation(programRef.current, 'uView'), false, view);
      gl.uniformMatrix4fv(gl.getUniformLocation(programRef.current, 'uProjection'), false, proj);
      gl.bindVertexArray(vaoRef.current);
      gl.drawArrays(gl.TRIANGLES, 0, vertCountRef.current);
      gl.bindVertexArray(null);
    }
  }, []);

  function scheduleRebuild() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      rebuildProgram();
      rebuildGeometry();
    }, DEBOUNCE_MS);
  }

  function handleScriptChange(value: string | undefined) {
    const script = value ?? '';
    const next = { ...dataRef.current, script };
    dispatch(entityUpdated({ id, data: next }));
    invoke('entity:save', { filePath: entityFilePathRef.current, data: next });
    scheduleRebuild();
  }

  function handleVertChange(value: string | undefined) {
    const vertexShader = value ?? '';
    const next = { ...dataRef.current, vertexShader };
    dispatch(entityUpdated({ id, data: next }));
    invoke('entity:save', { filePath: entityFilePathRef.current, data: next });
    scheduleRebuild();
  }

  function handleFragChange(value: string | undefined) {
    const fragmentShader = value ?? '';
    const next = { ...dataRef.current, fragmentShader };
    dispatch(entityUpdated({ id, data: next }));
    invoke('entity:save', { filePath: entityFilePathRef.current, data: next });
    scheduleRebuild();
  }

  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    isDraggingRef.current = true;
    lastMouseRef.current = { x: e.clientX, y: e.clientY };
    canvasRef.current?.focus();
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!isDraggingRef.current) return;
    cameraRef.current.onMouseMove(
      lastMouseRef.current.x - e.clientX,
      lastMouseRef.current.y - e.clientY
    );
    lastMouseRef.current = { x: e.clientX, y: e.clientY };
  }

  function handleMouseUp() { isDraggingRef.current = false; }

  function handleWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    e.preventDefault();
    cameraRef.current.onWheel(e.deltaY);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLCanvasElement>) {
    keysRef.current.add(e.key);
    if (['w', 'a', 's', 'd', 'W', 'A', 'S', 'D'].includes(e.key)) e.preventDefault();
  }

  function handleKeyUp(e: React.KeyboardEvent<HTMLCanvasElement>) {
    keysRef.current.delete(e.key);
  }

  const handleBeforeMount: BeforeMount = (monaco) => {
    registerGlsl(monaco);
    monacoRef.current = monaco;
  };

  const handleScriptMount: OnMount = (_ed, monaco) => {
    monacoRef.current = monaco;
  };

  const handleVertMount: OnMount = (ed) => {
    vertEditorRef.current = ed;
    rebuildProgram();
  };

  const handleFragMount: OnMount = (ed) => {
    fragEditorRef.current = ed;
    rebuildProgram();
  };

  if (!data) return null;

  const MONACO_OPTS: editor.IStandaloneEditorConstructionOptions = {
    minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false,
    automaticLayout: true, tabSize: 2,
  };

  const tabs = ['Script', 'Vertex', 'Fragment', 'Render'];

  return (
    <div className="visualizer-editor">
      <div className="editor-header">
        <span className="editor-title">{entityRef?.name}</span>
      </div>

      <div className="visualizer-tabs">
        {tabs.map((label, i) => (
          <button
            key={i}
            className={`visualizer-tab${activeTab === i ? ' active' : ''}`}
            onClick={() => setActiveTab(i as Tab)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="visualizer-tab-content">
        {activeTab === 0 && (
          <div className="visualizer-monaco-wrap">
            <Editor
              key="script"
              defaultValue={data.script}
              language="javascript"
              theme="vs-dark"
              onChange={handleScriptChange}
              onMount={handleScriptMount}
              options={MONACO_OPTS}
            />
            {scriptError && (
              <div className="compile-error-panel">
                <div className="compile-error">● {scriptError}</div>
              </div>
            )}
          </div>
        )}

        {activeTab === 1 && (
          <div className="visualizer-monaco-wrap">
            <Editor
              key="vert"
              defaultValue={data.vertexShader}
              language="glsl"
              theme="vs-dark"
              onChange={handleVertChange}
              onMount={handleVertMount}
              beforeMount={handleBeforeMount}
              options={MONACO_OPTS}
            />
            {vertErrors.length > 0 && (
              <div className="compile-error-panel">
                {vertErrors.map((e, i) => <div key={i} className="compile-error">● {e}</div>)}
              </div>
            )}
          </div>
        )}

        {activeTab === 2 && (
          <div className="visualizer-monaco-wrap">
            <Editor
              key="frag"
              defaultValue={data.fragmentShader}
              language="glsl"
              theme="vs-dark"
              onChange={handleFragChange}
              onMount={handleFragMount}
              beforeMount={handleBeforeMount}
              options={MONACO_OPTS}
            />
            {fragErrors.length > 0 && (
              <div className="compile-error-panel">
                {fragErrors.map((e, i) => <div key={i} className="compile-error">● {e}</div>)}
              </div>
            )}
          </div>
        )}

        {/* Canvas always in DOM so WebGL context persists across tab switches. */}
        <div className="visualizer-render-wrap" style={{ display: activeTab === 3 ? 'flex' : 'none' }}>
          <canvas
            ref={canvasRef}
            className="visualizer-render-canvas"
            tabIndex={0}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onWheel={handleWheel}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
          />
          <div className="visualizer-render-hint">
            Drag to orbit · Scroll to zoom · WASD to pan
          </div>
        </div>
      </div>
    </div>
  );
}

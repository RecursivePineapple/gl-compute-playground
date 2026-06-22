import { readFileSync } from 'fs';
import { join } from 'path';
import GL from 'node-native-gl';
import { PipelineData, PipelineNode, ShaderNode, BufferNode, BufferData, ShaderData, EntityRef, DataType } from '../../shared/types';
import { parseBindings, parseUniforms } from '../../shared/parseShader';
import { compileProgram } from './compiler';
import { loadEntity } from '../project/io';

export interface ExecuteResult {
  bufferResults: Record<string, number[]>;
  errors: string[];
}

// Validates, compiles, and executes a pipeline via GL compute shaders.
// Requires GL context to be initialised (context.ts).
export async function executePipeline(
  pipeline: PipelineData,
  projectPath: string,
  entities: EntityRef[]
): Promise<ExecuteResult> {
  const ssbos: number[] = [];
  const programs: number[] = [];
  const errors: string[] = [];

  try {
    // Step 1 — Validation
    const validationErrors = validate(pipeline, entities, projectPath);
    if (validationErrors.length > 0) return { bufferResults: {}, errors: validationErrors };

    // Step 2 & 3 — Dependency graph + topological sort
    const graph = buildDependencyGraph(pipeline);
    const order = topologicalSort(graph);
    if (!order) return { bufferResults: {}, errors: ['Pipeline contains a cycle.'] };

    // Step 4 — Load entity data
    const entityCache = new Map<string, BufferData | ShaderData>();

    function loadCached(id: string): BufferData | ShaderData {
      if (!entityCache.has(id)) {
        const ref = entities.find(e => e.id === id)!;
        entityCache.set(id, loadEntity(ref.filePath) as BufferData | ShaderData);
      }
      return entityCache.get(id)!;
    }

    // Step 5 — SSBO allocation
    const bufferIds = [...new Set(
      pipeline.nodes.filter(n => n.type === 'buffer').map(n => (n as BufferNode).bufferId)
    )];

    const ssboMap = new Map<string, number>(); // bufferId → ssbo

    for (const bufferId of bufferIds) {
      const bufferData = loadCached(bufferId) as BufferData;
      const ssbo = allocateSSBO(bufferData, projectPath);
      ssbos.push(ssbo);
      ssboMap.set(bufferId, ssbo);
    }

    // Step 6 — Shader program compilation
    const shaderIds = [...new Set(
      pipeline.nodes.filter(n => n.type === 'shader').map(n => (n as ShaderNode).shaderId)
    )];

    const programMap = new Map<string, number>(); // shaderId → program

    for (const shaderId of shaderIds) {
      const shaderData = loadCached(shaderId) as ShaderData;
      const result = compileProgram(shaderData.source);
      if ('error' in result) {
        const ref = entities.find(e => e.id === shaderId);
        return { bufferResults: {}, errors: [`Shader '${ref?.name ?? shaderId}': ${result.error}`] };
      }
      programs.push(result.program);
      programMap.set(shaderId, result.program);
    }

    // Step 7 — Dispatch loop
    for (const shaderNodeId of order) {
      const shaderNode = pipeline.nodes.find(n => n.id === shaderNodeId) as ShaderNode;
      const program = programMap.get(shaderNode.shaderId)!;
      const shaderData = loadCached(shaderNode.shaderId) as ShaderData;

      GL.useProgram(program);

      // Bind SSBOs for edges targeting this shader node (readonly bindings)
      for (const edge of pipeline.edges.filter(e => e.target === shaderNodeId && e.targetHandle.startsWith('binding-'))) {
        const idx = parseInt(edge.targetHandle.replace('binding-', ''), 10);
        const bufNode = pipeline.nodes.find(n => n.id === edge.source) as BufferNode;
        GL.bindBufferBase(GL.SHADER_STORAGE_BUFFER, idx, ssboMap.get(bufNode.bufferId)!);
      }

      // Bind SSBOs for edges sourced from this shader node (writeonly bindings)
      for (const edge of pipeline.edges.filter(e => e.source === shaderNodeId && e.sourceHandle.startsWith('binding-'))) {
        const idx = parseInt(edge.sourceHandle.replace('binding-', ''), 10);
        const bufNode = pipeline.nodes.find(n => n.id === edge.target) as BufferNode;
        GL.bindBufferBase(GL.SHADER_STORAGE_BUFFER, idx, ssboMap.get(bufNode.bufferId)!);
      }

      // Set uniforms
      const uniforms = parseUniforms(shaderData.source);
      for (const u of uniforms) {
        const loc = GL.getUniformLocation(program, u.name);
        const value = shaderNode.uniforms[u.name] ?? 0;
        const uniformError = setUniform(loc, u.glslType, value);
        if (uniformError) errors.push(`Shader '${shaderNode.shaderId}' uniform '${u.name}': ${uniformError}`);
      }

      GL.dispatchCompute(shaderNode.dispatch.x, shaderNode.dispatch.y, shaderNode.dispatch.z);
      GL.memoryBarrier(GL.SHADER_STORAGE_BARRIER_BIT);
    }

    // Step 8 — Readback
    const bufferResults: Record<string, number[]> = {};

    for (const bufNode of pipeline.nodes.filter(n => n.type === 'buffer') as BufferNode[]) {
      const bufferData = loadCached(bufNode.bufferId) as BufferData;
      if (bufferData.predefinedData !== null) continue;

      const byteSize = elementCount(bufferData) * bytesPerElement(bufferData.dataType);
      const rawBuffer = readbackSSBO(ssboMap.get(bufNode.bufferId)!, byteSize);
      bufferResults[bufNode.bufferId] = toNumberArray(rawBuffer, bufferData.dataType);
    }

    return { bufferResults, errors };

  } finally {
    // Step 9 — Cleanup (always runs)
    if (ssbos.length > 0) GL.deleteBuffers(ssbos.length, ssbos);
    for (const p of programs) GL.deleteProgram(p);
  }
}

// ---- Step 1: Validation ----

function validate(pipeline: PipelineData, entities: EntityRef[], projectPath: string): string[] {
  const errors: string[] = [];

  // Missing entity refs
  for (const node of pipeline.nodes) {
    if (node.type === 'buffer') {
      if (!entities.find(e => e.id === (node as BufferNode).bufferId))
        errors.push(`Buffer entity '${(node as BufferNode).bufferId}' not found.`);
    } else {
      if (!entities.find(e => e.id === (node as ShaderNode).shaderId))
        errors.push(`Shader entity '${(node as ShaderNode).shaderId}' not found.`);
    }
  }
  if (errors.length > 0) return errors;

  // Unconnected bindings: every binding on every shader node must have an edge
  for (const node of pipeline.nodes.filter(n => n.type === 'shader') as ShaderNode[]) {
    const ref = entities.find(e => e.id === node.shaderId)!;
    const shaderData = loadEntity(ref.filePath) as ShaderData;
    const bindings = parseBindings(shaderData.source);

    for (const b of bindings) {
      const handle = `binding-${b.index}`;
      const hasEdge = b.direction === 'read'
        ? pipeline.edges.some(e => e.target === node.id && e.targetHandle === handle)
        : pipeline.edges.some(e => e.source === node.id && e.sourceHandle === handle);
      if (!hasEdge)
        errors.push(`Shader '${ref.name}' binding ${b.index} (${b.name}) is not connected.`);
    }
  }

  // Write-write conflicts: each buffer input must have at most one edge
  for (const node of pipeline.nodes.filter(n => n.type === 'buffer') as BufferNode[]) {
    const writeCount = pipeline.edges.filter(e => e.target === node.id && e.targetHandle === 'input').length;
    if (writeCount > 1) {
      const ref = entities.find(e => e.id === node.bufferId);
      errors.push(`Buffer '${ref?.name ?? node.bufferId}' has ${writeCount} write connections (write-once).`);
    }
  }

  // Cycle detection is deferred to topologicalSort
  return errors;
}

// ---- Step 2: Dependency graph ----

function buildDependencyGraph(pipeline: PipelineData): Map<string, string[]> {
  const shaderNodes = pipeline.nodes.filter(n => n.type === 'shader') as ShaderNode[];
  const graph = new Map<string, string[]>(shaderNodes.map(n => [n.id, []]));

  // For each buffer that has a writer shader and reader shaders, add reader → writer edges
  for (const bufNode of pipeline.nodes.filter(n => n.type === 'buffer') as BufferNode[]) {
    const writers = pipeline.edges
      .filter(e => e.target === bufNode.id && e.targetHandle === 'input')
      .map(e => e.source);
    const readers = pipeline.edges
      .filter(e => e.source === bufNode.id && e.sourceHandle === 'output')
      .map(e => e.target);

    for (const reader of readers) {
      for (const writer of writers) {
        if (reader !== writer && !graph.get(reader)!.includes(writer)) {
          graph.get(reader)!.push(writer);
        }
      }
    }
  }

  return graph;
}

// ---- Step 3: Topological sort (Kahn's algorithm) ----

// graph maps nodeId → [prerequisite nodeIds]. In-degree = number of prerequisites.
function topologicalSort(graph: Map<string, string[]>): string[] | null {
  const inDegree = new Map<string, number>(
    [...graph.entries()].map(([id, deps]) => [id, deps.length])
  );

  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const result: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    result.push(id);

    // Decrement in-degree of all nodes that listed this node as a prerequisite
    for (const [nodeId, deps] of graph.entries()) {
      if (deps.includes(id)) {
        const newDegree = inDegree.get(nodeId)! - 1;
        inDegree.set(nodeId, newDegree);
        if (newDegree === 0) queue.push(nodeId);
      }
    }
  }

  return result.length === graph.size ? result : null;
}

// ---- Step 5: SSBO allocation ----

function allocateSSBO(bufferData: BufferData, projectPath: string): number {
  const ssbo = GL.genBuffers(1);
  GL.bindBuffer(GL.SHADER_STORAGE_BUFFER, ssbo);

  const byteSize = elementCount(bufferData) * bytesPerElement(bufferData.dataType);
  const pd = bufferData.predefinedData;

  if (!pd) {
    GL.bufferData(GL.SHADER_STORAGE_BUFFER, byteSize, null, GL.DYNAMIC_DRAW);
    return ssbo;
  }

  let typedArray: ArrayBufferView;

  if (pd.source === 'binary') {
    if (!pd.path) {
      GL.bufferData(GL.SHADER_STORAGE_BUFFER, byteSize, null, GL.DYNAMIC_DRAW);
      return ssbo;
    }
    const raw = readFileSync(join(projectPath, pd.path));
    typedArray = toTypedArray(raw.buffer, bufferData.dataType);
  } else if (pd.source === 'csv') {
    if (!pd.path) {
      GL.bufferData(GL.SHADER_STORAGE_BUFFER, byteSize, null, GL.DYNAMIC_DRAW);
      return ssbo;
    }
    const text = readFileSync(join(projectPath, pd.path), 'utf-8');
    const values = text.trim().split(/[\s,\n]+/).filter(Boolean).map(Number);
    typedArray = toTypedArrayFromNumbers(values, bufferData.dataType);
  } else {
    typedArray = toTypedArrayFromNumbers(pd.data, bufferData.dataType);
  }

  GL.bufferData(GL.SHADER_STORAGE_BUFFER, byteSize, typedArray, GL.DYNAMIC_DRAW);
  return ssbo;
}

// ---- Step 8: Readback ----

function readbackSSBO(ssbo: number, byteSize: number): Buffer {
  GL.bindBuffer(GL.SHADER_STORAGE_BUFFER, ssbo);
  const buf = Buffer.alloc(byteSize);
  GL.getBufferSubData(GL.SHADER_STORAGE_BUFFER, 0, byteSize, buf);
  return buf;
}

function toNumberArray(raw: Buffer, dataType: DataType): number[] {
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  switch (dataType) {
    case 'f32': return Array.from(new Float32Array(ab));
    case 'f64': return Array.from(new Float64Array(ab));
    case 'i32': return Array.from(new Int32Array(ab));
    case 'u32': return Array.from(new Uint32Array(ab));
    case 'i64': return Array.from(new BigInt64Array(ab)).map(Number);
    case 'u64': return Array.from(new BigUint64Array(ab)).map(Number);
  }
}

// ---- Uniform dispatch ----

function setUniform(loc: number, glslType: string, value: number): string | null {
  switch (glslType) {
    case 'float':
    case 'double':
      GL.uniform1f(loc, value);
      return null;
    case 'int':
      GL.uniform1i(loc, value | 0);
      return null;
    case 'uint':
      GL.uniform1ui(loc, value >>> 0);
      return null;
    default:
      return `unsupported type '${glslType}' (only float/double/int/uint scalars supported)`;
  }
}

// ---- Helpers ----

function elementCount(bd: BufferData): number {
  return bd.dimensions.x * bd.dimensions.y * bd.dimensions.z;
}

function bytesPerElement(dt: DataType): number {
  return dt === 'f64' || dt === 'i64' || dt === 'u64' ? 8 : 4;
}

function toTypedArray(ab: ArrayBufferLike, dt: DataType): ArrayBufferView {
  switch (dt) {
    case 'f32': return new Float32Array(ab);
    case 'f64': return new Float64Array(ab);
    case 'i32': return new Int32Array(ab);
    case 'u32': return new Uint32Array(ab);
    case 'i64': return new BigInt64Array(ab);
    case 'u64': return new BigUint64Array(ab);
  }
}

function toTypedArrayFromNumbers(values: number[], dt: DataType): ArrayBufferView {
  switch (dt) {
    case 'f32': return new Float32Array(values);
    case 'f64': return new Float64Array(values);
    case 'i32': return new Int32Array(values);
    case 'u32': return new Uint32Array(values);
    case 'i64': return BigInt64Array.from(values, BigInt);
    case 'u64': return BigUint64Array.from(values, BigInt);
  }
}

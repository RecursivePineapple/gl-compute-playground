# Pipeline Executor SDD

## Responsibility
Validate a `PipelineData` graph, compile its shaders, allocate GL SSBOs, dispatch compute shaders in topological order with barriers, read back results, and return them to the renderer.

Runs entirely in the main process. GL context must already be current (initialised by `context.ts` on startup).

## Entry Point

`executor.ts` exports one function:

```typescript
async function executePipeline(
  pipeline: PipelineData,
  projectPath: string,
  entities: EntityRef[]
): Promise<{ bufferResults: Record<string, ArrayBuffer>; errors: string[] }>
```

Called by the `pipeline:execute` IPC handler in `handlers.ts`. The handler passes the stored project state (`projectPath`, `entities`) alongside the `PipelineData` sent from the renderer.

`bufferResults` is keyed by buffer entity id. Only non-predefined buffers are included.

On any fatal error, `bufferResults` is `{}` and `errors` is non-empty. GL objects allocated before the error are always cleaned up (see Cleanup).

## Step 1 — Validation

All checks are pure (no GL calls). Returns `string[]` of error messages. If non-empty, abort immediately.

1. **Missing entity refs** — every `bufferId` and `shaderId` in the graph must exist in `entities`.
2. **Unconnected bindings** — every binding slot on every shader node must have an edge. Parse each shader's source to get its binding count; compare against edges.
3. **Write-write conflict** — count edges whose `targetHandle === "input"` per buffer node. If any buffer has > 1 such edge, error.
4. **Circular dependency** — build the dependency graph (Step 2) and run topological sort (Step 3). If sort fails, error.

## Step 2 — Dependency Graph

Nodes: shader node ids only (buffer nodes are data, not dispatch steps).

Edge `A → B` (B depends on A): exists when shader A has a `writeonly` binding connected to a buffer, and shader B has a `readonly` binding connected to the same buffer node.

```typescript
function buildDependencyGraph(pipeline: PipelineData): Map<string, string[]>
// returns Map<shaderId, shaderId[]> — each shader maps to the shaders it must wait for
```

## Step 3 — Topological Sort

Kahn's algorithm on the dependency graph.

```typescript
// Returns ordered shader node ids, or null if a cycle exists.
function topologicalSort(graph: Map<string, string[]>): string[] | null
```

## Step 4 — Load Entity Data

For each unique buffer and shader referenced in the graph, read and JSON-parse the corresponding file from disk:

```typescript
function loadEntityData(id: string, entities: EntityRef[], projectPath: string): BufferData | ShaderData
```

Results cached in a local `Map<string, BufferData | ShaderData>` for the duration of this execution.

## Step 5 — SSBO Allocation and Upload

For each buffer node in the graph (deduplicated by `bufferId`):

```typescript
function allocateSSBO(bufferData: BufferData, projectPath: string): GLuint
```

1. `GL.genBuffers(1)` → `ssbo`
2. `GL.bindBuffer(GL_SHADER_STORAGE_BUFFER, ssbo)`
3. Determine byte size: `elementCount × bytesPerElement`
   - `elementCount` = `x × y × z`
   - `bytesPerElement`: f32/i32/u32 → 4, f64/i64/u64 → 8
4. Build upload data:
   - `null` (no predefined data) → `GL.bufferData(GL_SHADER_STORAGE_BUFFER, byteSize, null, GL_DYNAMIC_DRAW)` — zero-initialised
   - `source: 'binary'` → read file as `Buffer`, pass as-is
   - `source: 'csv'` → read file, split tokens, parse numbers, convert to typed array
   - `source: 'inline'` → convert `number[]` to typed array
   - For binary/csv/inline: `GL.bufferData(GL_SHADER_STORAGE_BUFFER, byteSize, typedArray, GL_DYNAMIC_DRAW)`
5. Return `ssbo`

Typed array selection by `dataType`:

| dataType | TypedArray |
|---|---|
| f32 | Float32Array |
| f64 | Float64Array |
| i32 | Int32Array |
| i64 | BigInt64Array |
| u32 | Uint32Array |
| u64 | BigUint64Array |

## Step 6 — Shader Program Compilation

For each unique `shaderId` referenced by shader nodes:

```typescript
function compileProgram(source: string): { program: GLuint } | { error: string }
```

1. `GL.createShader(GL_COMPUTE_SHADER)` → `shader`
2. `GL.shaderSource(shader, source)`
3. `GL.compileShader(shader)`
4. `GL.getShaderiv(shader, GL.COMPILE_STATUS)` — if `0`, read `getShaderInfoLog`, return error
5. `GL.createProgram()` → `program`
6. `GL.attachShader(program, shader)`
7. `GL.linkProgram(program)`
8. `GL.getProgramiv(program, GL.LINK_STATUS)` — if `0`, read `getProgramInfoLog`, return error
9. `GL.deleteShader(shader)` — no longer needed after link
10. Return `{ program }`

Compilation is cached per `shaderId` within one execution run. Same shader appearing as multiple nodes compiles only once.

If any shader fails, abort and return the error immediately (before any dispatch).

## Step 7 — Dispatch Loop

Iterate shader node ids in topological order:

```typescript
for (const shaderNodeId of orderedShaderNodeIds) {
  const shaderNode = /* ShaderNode from pipeline */;
  const program = compiledPrograms.get(shaderNode.shaderId);

  GL.useProgram(program);

  // Bind SSBOs
  for (const edge of edgesTargetingShaderNode(shaderNodeId)) {
    const bindingIndex = parseBindingIndex(edge.targetHandle);  // "binding-<N>" → N
    const ssbo = ssbos.get(bufferIdForEdge(edge));
    GL.bindBufferBase(GL_SHADER_STORAGE_BUFFER, bindingIndex, ssbo);
  }
  for (const edge of edgesSourcedFromShaderNode(shaderNodeId)) {
    const bindingIndex = parseBindingIndex(edge.sourceHandle);
    const ssbo = ssbos.get(bufferIdForEdge(edge));
    GL.bindBufferBase(GL_SHADER_STORAGE_BUFFER, bindingIndex, ssbo);
  }

  // Set uniforms
  const shaderData = loadedShaderData.get(shaderNode.shaderId);
  const uniforms = parseUniforms(shaderData.source);  // reuse renderer parser logic, duplicated in main
  for (const uniform of uniforms) {
    const loc = GL.getUniformLocation(program, uniform.name);
    const value = shaderNode.uniforms[uniform.name] ?? 0;
    setUniform(loc, uniform.glslType, value);
  }

  GL.dispatchCompute(shaderNode.dispatch.x, shaderNode.dispatch.y, shaderNode.dispatch.z);
  GL.memoryBarrier(GL_SHADER_STORAGE_BARRIER_BIT);
}
```

**Uniform dispatch** (`setUniform`): maps GLSL scalar type to the correct `glUniform*` call.

| glslType | GL call |
|---|---|
| `float` / `double` | `uniform1f(loc, value)` |
| `int` | `uniform1i(loc, value)` |
| `uint` | `uniform1ui(loc, value)` |
| other | skip with a warning in errors[] |

Non-scalar uniform types (vec*, mat*) are not supported in this version.

## Step 8 — Buffer Readback

After the dispatch loop completes, for each buffer that has **no** `predefinedData`:

```typescript
function readbackSSBO(ssbo: GLuint, byteSize: number): ArrayBuffer
```

1. `GL.bindBuffer(GL_SHADER_STORAGE_BUFFER, ssbo)`
2. Allocate a Node.js `Buffer` of `byteSize`
3. `GL.getBufferSubData(GL_SHADER_STORAGE_BUFFER, 0, byteSize, nodeBuffer)`
4. Return `nodeBuffer.buffer` (the underlying `ArrayBuffer`)

Keyed into `bufferResults` by buffer entity id.

## Step 9 — Cleanup

Always runs, even on error. Tracks all allocated GL names:

```typescript
GL.deleteBuffers(ssbos.length, [...ssbos.values()]);
for (const program of compiledPrograms.values()) GL.deleteProgram(program);
```

## GLSL Uniform Parsing in Main

`parseUniforms` from the renderer (`renderer/pipeline/parseShader.ts`) is duplicated or moved to `shared/parseShader.ts` so the executor can use it without importing renderer code.

## GL Gaps — Additions Required in node-native-gl

Six items must be added to both `src/gl.cc` (N-API binding) and `src/types/index.d.ts` before the executor can function:

| Addition | Type | Value / Signature |
|---|---|---|
| `GL_COMPUTE_SHADER` | constant | `0x91B9` |
| `GL_SHADER_STORAGE_BUFFER` | constant | `0x90D2` |
| `GL_SHADER_STORAGE_BARRIER_BIT` | constant | `0x00002000` |
| `glDispatchCompute` | function | `(x: GLuint, y: GLuint, z: GLuint): void` |
| `glMemoryBarrier` | function | `(barriers: GLbitfield): void` |
| `glBindBufferBase` | function | `(target: GLenum, index: GLuint, buffer: GLuint): void` |

These should be added to the submodule before executor implementation begins.

# Project Data Structure SDD

## On-Disk Layout

A project is a directory with four subdirectories, one per entity type. Each entity is a single `.json` file. The filename (without extension) is the entity name.

```
project/
├── buffers/
│   └── <name>.json
├── shaders/
│   └── <name>.json
├── pipelines/
│   └── <name>.json
└── visualizers/
    └── <name>.json
```

## Entity Identification

Entity id = `<subdirectory>/<name>` (e.g., `buffers/myBuffer`). Derived purely from file path — no separate id tracking. Cross-references between entities (e.g., pipeline → buffer) use this id. If a file is renamed externally, references break; this is acceptable for an experimental tool.

The `type` field is inferred from the subdirectory, not stored in the JSON.

## EntityRef (shared/types.ts)

```typescript
type EntityType = 'buffer' | 'shader' | 'pipeline' | 'visualizer';

interface EntityRef {
  id: string;        // e.g. "buffers/myBuffer"
  name: string;      // e.g. "myBuffer"
  type: EntityType;
  filePath: string;  // absolute path to the .json file
}
```

## Entity JSON Schemas

### Buffer

```typescript
type DataType = 'f32' | 'f64' | 'i32' | 'i64' | 'u32' | 'u64';

interface BufferData {
  dataType: DataType;
  dimensions: { x: number; y: number; z: number };  // all default to 1
  predefinedData: PredefinedData | null;
}

type PredefinedData =
  | { source: 'binary'; path: string }   // path relative to project root
  | { source: 'csv';    path: string }   // path relative to project root
  | { source: 'inline'; data: number[] } // clipboard data stored inline
```

Buffers with `predefinedData !== null` are read-only; their contents are not overwritten after pipeline execution.

### Shader

```typescript
interface ShaderData {
  source: string;  // full GLSL compute shader source
}
```

### Pipeline

Nodes and edges map directly to React Flow's data model and are persisted as-is.

```typescript
interface PipelineData {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}

type PipelineNode = BufferNode | ShaderNode;

interface BufferNode {
  id: string;
  type: 'buffer';
  bufferId: string;        // EntityRef id, e.g. "buffers/myBuffer"
  position: { x: number; y: number };
}

interface ShaderNode {
  id: string;
  type: 'shader';
  shaderId: string;        // EntityRef id, e.g. "shaders/myShader"
  position: { x: number; y: number };
  dispatch: { x: number; y: number; z: number };  // workgroup counts, default 1
  uniforms: Record<string, number>;               // keyed by uniform name
}

interface PipelineEdge {
  id: string;
  source: string;        // node id
  sourceHandle: string;  // "output" for buffer nodes
  target: string;        // node id
  targetHandle: string;  // "input" for buffer nodes, "binding-<N>" for shader nodes
}
```

Binding direction (read/write) is not stored in the pipeline — it is parsed live from the shader source.

### Visualizer

Stubbed. File contains `{}`.

## io.ts — Project Scanning

`scanProject(projectPath: string): EntityRef[]`

Reads the four subdirectories. For each `.json` file found, constructs an `EntityRef`. Non-`.json` files are ignored. Missing subdirectories are treated as empty (not an error).

## io.ts — Auto-Save

`saveEntity(filePath: string, data: object): void`

Writes `JSON.stringify(data, null, 2)` to `filePath`. Called by the `entity:save` IPC handler on every edit from the renderer.

## Entity Creation

Entities are created by adding `.json` files to the appropriate subdirectory (externally or via a "new" button in the tree section header — UI detail covered in individual editor SDDs). The project tree re-scans when the app opens a project; live file-watching is out of scope.

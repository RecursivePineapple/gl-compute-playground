# Pipeline Editor SDD

## Responsibility
Display and edit a single `PipelineData` entity as an interactive node graph. Provide an execute button that dispatches the pipeline and surfaces errors.

## UI Layout

```
┌────────────────────────────────────────────────────────┐
│ [+ Buffer] [+ Shader]          (node-add toolbar, top) │
├────────────────────────────────────────────────────────┤
│                                                        │
│   ┌──────────┐          ┌─────────────────────────┐  │
│   │ ● bufA   │          │ ▣ myShader              │  │
│   │          │          │                         │  │
│  [W]        [R]────────►│[b0] inData   (readonly) │  │
│   └──────────┘          │     outData (writeonly) │[b1]─► [W] bufB
│                         │                         │  │
│                         │ X [64] Y [1 ] Z [1 ]   │  │
│                         │ speed: [1.0]            │  │
│                         └─────────────────────────┘  │
│                                                        │
│                              ┌──────────────────────┐ │
│                              │ [Execute]            │ │  ← bottom-right overlay
│                              │ ● error text here    │ │
│                              └──────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

## Component Structure

```
PipelineEditor
├── NodeToolbar                      "Add Buffer" / "Add Shader" buttons + entity picker
├── ReactFlow
│   ├── BufferNodeComponent          custom node
│   └── ShaderNodeComponent          custom node
│       ├── BindingSlot[]            one per parsed binding; handle + label
│       ├── DispatchInputs           X / Y / Z number inputs
│       └── UniformInput[]           one per parsed uniform
└── ExecuteOverlay                   fixed bottom-right
    ├── ExecuteButton
    └── ErrorList                    errors from pipeline:result
```

## Node Types

### BufferNode

Displays the buffer name. Has two handles:

| Handle | RF type | id | Description |
|---|---|---|---|
| Write-in | target | `"input"` | Receives write connection from a shader |
| Read-out | source | `"output"` | Provides read connections to shaders (multiple allowed) |

Write-in may have at most one connection; enforced in `isValidConnection`.

### ShaderNode

Displays the shader name. Binding slots and uniform inputs are derived by parsing the shader source from `ui.openEntities[shaderId]` each render. If the shader entity is not yet loaded, the node shows a loading indicator and has no handles until loaded.

**Binding slots** — one per binding parsed from GLSL:

| Binding direction | Handle RF type | Handle id | Visual side |
|---|---|---|---|
| `readonly` (shader reads) | target | `"binding-<N>"` | Left |
| `writeonly` (shader writes) | source | `"binding-<N>"` | Right |

**Dispatch inputs** — three number inputs (X, Y, Z), min 1, stored in `ShaderNode.dispatch`.

**Uniform inputs** — one number input per uniform, stored in `ShaderNode.uniforms[name]`.

## GLSL Parsing (renderer/pipeline/parseShader.ts)

Two pure functions, called in the renderer — no IPC required.

```typescript
interface BindingInfo {
  index: number;
  name: string;
  direction: 'read' | 'write';  // readonly → read, writeonly → write
}

interface UniformInfo {
  name: string;
  glslType: string;  // e.g. 'float', 'int', 'uint'
}

function parseBindings(source: string): BindingInfo[]
function parseUniforms(source: string): UniformInfo[]
```

**Binding regex:** matches `layout(...binding = N...) readonly|writeonly buffer Name`

**Uniform regex:** matches `uniform <type> <name>;`

Parsing is re-run whenever the shader's source changes in `openEntities`. Existing edges whose `targetHandle` / `sourceHandle` no longer matches a parsed binding are removed from the graph and the pipeline is re-saved.

## Connection Validation (isValidConnection)

Enforced live in React Flow's `isValidConnection` callback:

1. Buffer `"output"` → ShaderNode `"binding-<N>"` where binding direction is `read` — **allowed**
2. ShaderNode `"binding-<N>"` where binding direction is `write` → Buffer `"input"` — **allowed**
3. Any other combination — **rejected**
4. Buffer `"input"` already has a connection — **rejected** (write-once)

Cycles are not detected at connect time; they produce an error at execute time.

## Adding Nodes

**NodeToolbar** has two buttons: "Add Buffer" and "Add Shader". Each opens an inline dropdown listing all entities of that type from `project.entities`. Selecting one appends a node to `PipelineData.nodes` with a position offset from the current viewport center. If the same entity is already present in the graph, a second node for it is still allowed (same entity can appear multiple times — useful for reuse across sub-graphs).

## Auto-Save

React Flow `onNodesChange` and `onEdgesChange` → rebuild full `PipelineData` from current nodes/edges → dispatch `entity:save` immediately. Node position changes during drag fire on every move; this is acceptable for a local file write.

## Entity Loading

When PipelineEditor mounts and when a new ShaderNode is added, the shader entity's data must be in `ui.openEntities` for binding parsing. If not present, the renderer invokes `entity:load` IPC to fetch it.

### New IPC Channel

| Channel | Direction | Payload |
|---|---|---|
| `entity:load` | R→M (invoke) | `{ filePath: string }` |
| *(response)* | M→R | `EntityData` |

Main process reads and JSON-parses the file; returns the parsed object. Result is stored in `ui.openEntities[id]`. Used by both the pipeline editor (for shader parsing) and the project tree (on entity click).

## ExecuteOverlay

- **Execute button:** calls `ipcRenderer.invoke('pipeline:execute', { pipeline: PipelineData })`. Disabled while a result is pending. On click, clears `ui.executionResults` (set to `null`).
- **Result handling:** `pipeline:result` response populates `ui.executionResults` (per buffer editor SDD) and any `errors` string array is shown in the ErrorList below the button.
- **Error display:** each error on its own line in red. Errors cleared on next execute.

## Interaction With Other SDDs

- `ui.executionResults` — defined in buffer editor SDD; cleared here on execute start, populated on result
- `entity:load` IPC — also used by ProjectTree when user clicks an entity
- `dialog:openFile` IPC — defined in buffer editor SDD; not used here

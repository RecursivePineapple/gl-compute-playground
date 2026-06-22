# Global Architecture SDD

## Overview
Desktop app for experimenting with OpenGL compute shaders. Electron runtime: React/Redux UI in renderer, native GL bindings in main process.

## Tech Stack
- **Runtime**: Electron
- **UI**: React + Redux Toolkit
- **Shader editor**: Monaco Editor (`@monaco-editor/react`)
- **Pipeline graph**: React Flow (`@xyflow/react`)
- **GL bindings**: `node-native-gl` (local submodule)
- **GL context**: `glfw-n-api` (hidden GLFW window)
- **Language**: TypeScript throughout

## Process Architecture

### Main Process
Owns the GL context and all file I/O. Responsibilities:
- Open/scan project directory; entity file read and write (auto-save on every edit)
- Shader compilation via GL for real-time error feedback
- Pipeline execution (topological dispatch)

GL context is created on app startup via a hidden GLFW window, not lazily.

### Renderer Process
React/Redux SPA. No direct file system or GL access — communicates with main exclusively via IPC.

## IPC Channels

| Channel | Direction | Payload |
|---|---|---|
| `project:open` | R→M | — |
| `project:opened` | M→R | `{ path: string, entities: EntityRef[] }` |
| `entity:save` | R→M | `{ filePath: string, data: object }` |
| `shader:compile` | R→M | `{ source: string }` |
| `shader:errors` | M→R | `{ errors: string[] }` |
| `pipeline:execute` | R→M | `{ pipeline: PipelineData }` |
| `pipeline:result` | M→R | `{ bufferResults: Record<string, ArrayBuffer>, errors: string[] }` |

`EntityRef` = `{ id: string, name: string, type: EntityType, filePath: string }`

## Redux Store Shape

```typescript
{
  project: {
    path: string | null,
    entities: EntityRef[]
  },
  ui: {
    selectedEntityId: string | null,
    openEntities: Record<string, EntityData>  // keyed by id
  }
}
```

Entity data shape is defined in per-entity SDDs.

## React Component Hierarchy

```
App
├── Header                        (File menu bar)
└── Workspace
    ├── ProjectTree               (left panel)
    │   ├── TreeSection[Buffers]
    │   ├── TreeSection[Shaders]
    │   ├── TreeSection[Pipelines]
    │   └── TreeSection[Visualizers]  (stubbed)
    └── EntityEditor              (right panel — switches on selected type)
        ├── BufferEditor          (detail in buffer SDD)
        ├── ShaderEditor          (detail in shader SDD)
        ├── PipelineEditor        (detail in pipeline SDD)
        └── VisualizerEditor      (stubbed)
```

## Source Layout

```
src/
├── main/
│   ├── index.ts              # Electron entry, BrowserWindow creation
│   ├── gl/
│   │   ├── context.ts        # GLFW hidden window + GL context init
│   │   ├── compiler.ts       # Shader compile + error extraction
│   │   └── executor.ts       # Pipeline execution (see executor SDD)
│   ├── project/
│   │   └── io.ts             # Directory scan, entity file read/write
│   └── ipc/
│       └── handlers.ts       # IPC channel registration
├── renderer/
│   ├── index.tsx             # React entry point
│   ├── store/
│   │   ├── index.ts          # Redux store config
│   │   ├── projectSlice.ts   # project state
│   │   └── uiSlice.ts        # ui state
│   ├── ipc/
│   │   └── client.ts         # Typed invoke/on wrappers
│   └── components/
│       ├── App.tsx
│       ├── Header.tsx
│       ├── ProjectTree.tsx
│       ├── EntityEditor.tsx
│       └── editors/
│           ├── BufferEditor.tsx
│           ├── ShaderEditor.tsx
│           ├── PipelineEditor.tsx
│           └── VisualizerEditor.tsx  (stubbed)
└── shared/
    └── types.ts              # EntityRef, EntityType, EntityData — shared across processes
```

## Dependency Gap

`glDispatchCompute` and `glMemoryBarrier` are absent from node-native-gl (both C++ bindings and TypeScript types). These must be added to the submodule before executor work begins.

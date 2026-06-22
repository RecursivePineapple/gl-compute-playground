# Visualizer SDD

## Status

**Stubbed.** Implementation is deferred. This document records intent and known interface constraints so the stub fits cleanly into the existing architecture.

## Intent (from spec)

A visualizer renders a mesh using simple OpenGL. The rendering logic is defined by a user-editable JavaScript file. Buffers from a pipeline execution can be loaded into a visualizer to inspect results visually.

## Known Constraints

- Visualizer entity file on disk contains `{}` (per project SDD).
- `VisualizerEditor.tsx` is mounted by `EntityEditor` when a visualizer entity is selected; it renders a placeholder.
- The tree section for visualizers is present and functional (clicking opens the placeholder).
- The JS rendering script will likely be edited via Monaco (same setup as shader editor) and executed in the main process against a separate GLFW window or an offscreen GL context.
- Buffer loading into a visualizer implies a UI affordance in the buffer editor or pipeline result panel — deferred.

## Stub Implementation

`VisualizerEditor.tsx` renders:

```
┌──────────────────────────────┐
│  <visualizer name>           │
│                              │
��  Visualizers not yet         │
│  implemented.                │
└──────────────────────────────┘
```

No IPC channels, Redux state, or GL work required for the stub.

## Deferred Design Decisions

- How the JS rendering script is sandboxed and executed
- How buffer data is passed into the rendering script
- Whether the visualizer renders into a separate GLFW window or an embedded surface
- Script editor integration (Monaco, language, API surface exposed to the script)
- Buffer selection UI (which buffers are bound as inputs to the visualizer)

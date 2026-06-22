# Shader Editor SDD

## Responsibility
Display and edit a single `ShaderData` entity using Monaco. Debounce auto-save and real-time GL compilation for error feedback. Show parsed bindings and uniforms as a read-only reference panel.

## UI Layout

```
┌──────────────────────────────────────────────┐
│  <shader name>                               │  ← header
├──────────────────────────────────────────────┤
│                                              │
│   Monaco Editor (GLSL, fills available       │
│   height, red squiggles on error lines)      │
│                                              │
├──────────────────────────────────────────────┤
│  Bindings                                    │  ← parsed info panel; always shown
│    [0] readonly  inData                      │
│    [1] writeonly outData                     │
│  Uniforms                                    │
│    float speed                               │
├──────────────────────────────────────────────┤
│  Errors                (hidden when none)    │
│  ● 5: 'foo' undeclared identifier            │
└──────────────────────────────────────────────┘
```

## Component Structure

```
ShaderEditor
├── MonacoEditor         controlled; value = openEntities[id].source
├── ParsedInfoPanel      read-only; derived from source via parseBindings + parseUniforms
└── CompileErrorPanel    hidden when errors = []; local component state, not Redux
```

## Auto-Save and Compile Check

Both triggered by the same 500ms debounce on Monaco `onChange`. On debounce fire:

1. Dispatch `entity:save` IPC with the current source.
2. Invoke `shader:compile` IPC with the current source; receive `{ errors: string[] }`.
3. Update local `errors` state; apply Monaco markers (see below).

The 500ms debounce is reset on every keystroke. Auto-save and compile always happen together — no separate timers.

The Redux `openEntities[id].source` is updated **immediately** on every keystroke (not debounced), so the pipeline editor's binding parser always sees the latest source. The file write and GL compile are debounced.

## compiler.ts (main process)

```typescript
function compileShader(source: string): { errors: string[] }
```

1. `GL.createShader(GL_COMPUTE_SHADER)` — requires `GL_COMPUTE_SHADER` (see GL Gaps below)
2. `GL.shaderSource(shader, source)`
3. `GL.compileShader(shader)`
4. Check `GL.getShaderiv(shader, GL.COMPILE_STATUS)`
5. If failed: `GL.getShaderInfoLog(shader)` → split into lines → filter non-empty → return as `errors`
6. `GL.deleteShader(shader)` — always; compile check must not leak GL objects
7. Return `{ errors: [] }` on success

## IPC

`shader:compile` is invoke-style (request/response). Replaces the separate send/receive pair listed in the global SDD:

| Channel | Direction | Payload |
|---|---|---|
| `shader:compile` (invoke) | R→M | `{ source: string }` |
| *(response)* | M→R | `{ errors: string[] }` |

## Monaco Setup

Monaco has no built-in GLSL language. Register a minimal GLSL language definition on app startup in the renderer (`renderer/index.tsx`):

- **Language id:** `"glsl"`
- **Tokenizer:** keyword highlighting (`void`, `layout`, `uniform`, `buffer`, `readonly`, `writeonly`, `in`, `out`, built-in types) plus line comment `//` and block comment `/* */`
- **Theme:** use the existing Monaco theme; no custom colours required

Registered once via `monaco.languages.register` and `monaco.languages.setMonarchTokensProvider` before any editor is mounted.

## Monaco Error Markers

After each compile response, replace all markers on the model:

```typescript
monaco.editor.setModelMarkers(model, 'glsl', parsedMarkers);
```

**Error string parsing** — GL info log format varies by driver. Parse with two patterns:

| Pattern | Example |
|---|---|
| `ERROR: 0:LINE: message` | NVIDIA |
| `0:LINE(COL): error: message` | AMD / Intel Mesa |

Extract `LINE` as an integer; the rest of the line is the message. If a line number cannot be parsed, attach the error to line 1.

Each marker:
```typescript
{
  startLineNumber: line,
  startColumn: 1,
  endLineNumber: line,
  endColumn: model.getLineMaxColumn(line),
  message,
  severity: monaco.MarkerSeverity.Error
}
```

On compile success, call `setModelMarkers` with `[]` to clear all markers.

## ParsedInfoPanel

Calls `parseBindings(source)` and `parseUniforms(source)` from `shared/parseShader.ts` on every render (source comes from Redux, already up-to-date on every keystroke). Result is a pure derivation — no memoisation needed unless profiling shows cost.

Displays:

- **Bindings** section: one row per binding — index, direction (`readonly` / `writeonly`), name
- **Uniforms** section: one row per uniform — GLSL type, name
- Both sections hidden (not just empty) when the respective list is empty

## GL Gap

`GL_COMPUTE_SHADER` constant (`0x91B9`) is required by `compiler.ts`. This is also flagged in the executor SDD. It must be added to node-native-gl before shader compilation can be tested.

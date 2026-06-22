# Buffer Editor SDD

## Responsibility
Display and edit a single `BufferData` entity. Show post-execution buffer contents when available.

## UI Layout

```
┌─────────────────────────────────────────┐
│  <buffer name>          [read-only badge]│  ← header; badge shown when predefinedData != null
├─────────────────────────────────────────┤
│  Data Type   [f32 ▾]                    │
│  Dimensions  X [256] Y [1  ] Z [1  ]   │
├─────────────────────────────────────────┤
│  Predefined Data                        │
│  ○ None  ○ Binary File  ○ CSV  ○ Clipboard │
│  [path input or paste button]           │
├─────────────────────────────────────────┤
│  Contents           (shown post-execute)│
│  ┌──────────────────────────────────┐  │
│  │  <value grid / list>             │  │
│  └──────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

## Component Structure

```
BufferEditor
├── DataTypeSelector       dropdown — f32 | f64 | i32 | i64 | u32 | u64
├── DimensionsEditor       three number inputs (x, y, z); min value 1
├── PredefinedDataEditor
│   ├── SourceSelector     radio: none / binary / csv / clipboard
│   ├── PathInput          shown for binary and csv; text field, path relative to project root
│   └── ClipboardImporter  shown for clipboard; "Paste" button + validation feedback
└── BufferContentsViewer   shown only when executionResults[id] exists
    ├── BufferGrid1D       y=1, z=1 — flat indexed list
    ├── BufferGrid2D       z=1 — grid: y rows × x cols, with slice selector hidden
    └── BufferGrid3D       full 3D — grid: y rows × x cols + z-slice number input
```

## Redux State

Adds `executionResults` to the `ui` slice (defined in `uiSlice.ts`):

```typescript
ui: {
  selectedEntityId: string | null,
  openEntities: Record<string, EntityData>,
  executionResults: Record<string, number[]> | null  // keyed by buffer entity id; null = no execution yet
}
```

Set to `null` when a new pipeline execution starts. Populated when `pipeline:result` IPC event arrives. Conversion from raw `ArrayBuffer` to `number[]` is done in the IPC client (`client.ts`) using the appropriate typed array view for the buffer's `dataType`:

| dataType | TypedArray |
|---|---|
| f32 | Float32Array |
| f64 | Float64Array |
| i32 | Int32Array |
| i64 | BigInt64Array → convert each BigInt to number |
| u32 | Uint32Array |
| u64 | BigUint64Array → convert each BigInt to number |

## Auto-Save

Any change to `dataType`, `dimensions`, or `predefinedData` immediately dispatches `entity:save` via IPC. No debounce — fields are discrete (dropdowns, validated number inputs), not free-text.

## PredefinedDataEditor Behaviour

**None:** `predefinedData` set to `null`.

**Binary / CSV:** path text field. On change, saves `{ source: 'binary'|'csv', path }`. The path is not validated in the editor — errors surface at pipeline execution time.

**Clipboard:** "Paste" button reads `navigator.clipboard.readText()`. Parses the text by splitting on whitespace, commas, and newlines; each token parsed as a float. Validates that token count equals `x * y * z`. On success, saves `{ source: 'inline', data: number[] }`. On failure, shows inline error; does not save.

## BufferContentsViewer Behaviour

Receives `values: number[]` (length = x × y × z) and `dimensions`.

**1D** (y=1, z=1): renders a single-column table — row index and value.

**2D** (z=1): renders a table — y rows, x columns. Cell (row, col) = `values[row * x + col]`.

**3D**: renders the same 2D table for the selected z-slice. Z-slice selector is a number input (0 to z−1). Cell (row, col) = `values[slice * x * y + row * x + col]`.

Values are formatted with `toPrecision(6)` for floats; plain integer string for integer types.

**Large buffers:** if total element count exceeds 10,000, the viewer shows only the first 10,000 values with a notice. No virtualisation — out of scope for this tool.

## Additional IPC Channel

| Channel | Direction | Payload |
|---|---|---|
| `dialog:openFile` | R→M | `{ filters?: FileFilter[] }` |
| `dialog:openFile:result` | M→R | `{ filePath: string \| null }` |

Used by PathInput's "Browse" button to open a native file dialog. Filters to `.bin` for binary, `.csv` for CSV.

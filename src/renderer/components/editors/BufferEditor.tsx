import { useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../store';
import { entityUpdated } from '../../store/uiSlice';
import { invoke } from '../../ipc/client';
import { BufferData, DataType } from '../../../shared/types';

const DATA_TYPES: DataType[] = ['f32', 'f64', 'i32', 'i64', 'u32', 'u64'];
const FLOAT_TYPES = new Set<DataType>(['f32', 'f64']);
const DISPLAY_LIMIT = 10_000;

function formatValue(value: number, dataType: DataType): string {
  return FLOAT_TYPES.has(dataType) ? value.toPrecision(6) : String(value);
}

export default function BufferEditor({ id }: { id: string }) {
  const dispatch = useAppDispatch();
  const data = useAppSelector(state => state.ui.openEntities[id]) as BufferData;
  const ref = useAppSelector(state => state.project.entities.find(e => e.id === id));
  const results = useAppSelector(state => state.ui.executionResults?.[id]);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [zSlice, setZSlice] = useState(0);

  function save(updated: BufferData) {
    dispatch(entityUpdated({ id, data: updated }));
    invoke('entity:save', { filePath: ref!.filePath, data: updated });
  }

  function setDataType(dataType: DataType) {
    save({ ...data, dataType });
  }

  function setDimension(axis: 'x' | 'y' | 'z', raw: string) {
    const v = Math.max(1, parseInt(raw, 10) || 1);
    save({ ...data, dimensions: { ...data.dimensions, [axis]: v } });
  }

  function setSource(source: 'none' | 'binary' | 'csv' | 'clipboard') {
    if (source === 'none')         save({ ...data, predefinedData: null });
    else if (source === 'binary')  save({ ...data, predefinedData: { source: 'binary', path: '' } });
    else if (source === 'csv')     save({ ...data, predefinedData: { source: 'csv', path: '' } });
    else                           save({ ...data, predefinedData: { source: 'inline', data: [] } });
  }

  function setPath(path: string) {
    const pd = data.predefinedData;
    if (!pd || pd.source === 'inline') return;
    save({ ...data, predefinedData: { ...pd, path } });
  }

  async function browse() {
    const pd = data.predefinedData;
    if (!pd || pd.source === 'inline') return;
    const isBinary = pd.source === 'binary';
    const result = await invoke<{ filePath: string | null }>('dialog:openFile', {
      filters: [{ name: isBinary ? 'Binary' : 'CSV', extensions: [isBinary ? 'bin' : 'csv'] }]
    });
    if (result.filePath) setPath(result.filePath);
  }

  async function pasteClipboard() {
    setClipboardError(null);
    const text = await navigator.clipboard.readText();
    const tokens = text.trim().split(/[\s,\n]+/).filter(Boolean);
    const values = tokens.map(t => parseFloat(t));

    if (values.some(isNaN)) {
      setClipboardError('Clipboard contains non-numeric values.');
      return;
    }

    const expected = data.dimensions.x * data.dimensions.y * data.dimensions.z;
    if (values.length !== expected) {
      setClipboardError(`Expected ${expected} values, got ${values.length}.`);
      return;
    }

    save({ ...data, predefinedData: { source: 'inline', data: values } });
  }

  const pd = data.predefinedData;
  const sourceValue: 'none' | 'binary' | 'csv' | 'clipboard' =
    !pd ? 'none' :
    pd.source === 'inline' ? 'clipboard' :
    pd.source;

  return (
    <div className="buffer-editor">
      <div className="editor-header">
        <span className="editor-title">{ref?.name}</span>
        {pd && <span className="badge">read-only</span>}
      </div>

      <section className="editor-section">
        <label className="field-row">
          <span className="field-label">Data Type</span>
          <select value={data.dataType} onChange={e => setDataType(e.target.value as DataType)}>
            {DATA_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>

        <div className="field-row">
          <span className="field-label">Dimensions</span>
          <div className="dim-inputs">
            {(['x', 'y', 'z'] as const).map(axis => (
              <label key={axis} className="dim-input">
                <span>{axis.toUpperCase()}</span>
                <input
                  type="number"
                  min={1}
                  value={data.dimensions[axis]}
                  onChange={e => setDimension(axis, e.target.value)}
                />
              </label>
            ))}
          </div>
        </div>
      </section>

      <section className="editor-section">
        <div className="section-title">Predefined Data</div>
        <div className="radio-group">
          {([
            ['none',      'None'],
            ['binary',    'Binary File'],
            ['csv',       'CSV File'],
            ['clipboard', 'Clipboard'],
          ] as const).map(([value, label]) => (
            <label key={value} className="radio-label">
              <input
                type="radio"
                name={`pd-source-${id}`}
                value={value}
                checked={sourceValue === value}
                onChange={() => setSource(value)}
              />
              {label}
            </label>
          ))}
        </div>

        {(sourceValue === 'binary' || sourceValue === 'csv') && (
          <div className="path-row">
            <input
              key={`${id}-${sourceValue}`}
              type="text"
              className="path-input"
              placeholder="Path relative to project root"
              defaultValue={(pd as { path: string } | null)?.path ?? ''}
              onBlur={e => setPath(e.target.value)}
            />
            <button onClick={browse}>Browse</button>
          </div>
        )}

        {sourceValue === 'clipboard' && (
          <div className="clipboard-row">
            <button onClick={pasteClipboard}>Paste from Clipboard</button>
            {clipboardError && <span className="error-text">{clipboardError}</span>}
            {pd?.source === 'inline' && pd.data.length > 0 && (
              <span className="muted-text">{pd.data.length} values loaded</span>
            )}
          </div>
        )}
      </section>

      {results && (
        <section className="editor-section">
          <div className="section-title">Contents</div>
          <BufferContentsViewer
            values={results}
            dimensions={data.dimensions}
            dataType={data.dataType}
            zSlice={zSlice}
            onZSliceChange={setZSlice}
          />
        </section>
      )}
    </div>
  );
}

function BufferContentsViewer({ values, dimensions, dataType, zSlice, onZSliceChange }: {
  values: number[];
  dimensions: { x: number; y: number; z: number };
  dataType: DataType;
  zSlice: number;
  onZSliceChange: (z: number) => void;
}) {
  const { x, y, z } = dimensions;

  if (y === 1 && z === 1) {
    const capped = x > DISPLAY_LIMIT;
    return (
      <div className="buffer-table-wrap">
        {capped && <div className="cap-notice">Showing first {DISPLAY_LIMIT.toLocaleString()} of {x.toLocaleString()} values.</div>}
        <table className="buffer-table">
          <tbody>
            {values.slice(0, DISPLAY_LIMIT).map((v, i) => (
              <tr key={i}>
                <td className="idx">{i}</td>
                <td>{formatValue(v, dataType)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const slice = Math.min(zSlice, z - 1);
  const sliceData = values.slice(slice * x * y, (slice + 1) * x * y);
  const sliceCells = x * y;
  const capped = sliceCells > DISPLAY_LIMIT;
  const visibleRows = capped ? Math.ceil(DISPLAY_LIMIT / x) : y;

  return (
    <div className="buffer-table-wrap">
      {z > 1 && (
        <div className="slice-selector">
          <label>
            Z Slice
            <input
              type="number"
              min={0}
              max={z - 1}
              value={slice}
              onChange={e => onZSliceChange(Math.max(0, Math.min(z - 1, parseInt(e.target.value) || 0)))}
            />
          </label>
          <span className="muted-text">of {z}</span>
        </div>
      )}
      {capped && <div className="cap-notice">Showing first {DISPLAY_LIMIT.toLocaleString()} of {sliceCells.toLocaleString()} cells.</div>}
      <div className="buffer-grid-scroll">
        <table className="buffer-table grid">
          <tbody>
            {Array.from({ length: visibleRows }, (_, row) => (
              <tr key={row}>
                {Array.from({ length: x }, (_, col) => (
                  <td key={col}>{formatValue(sliceData[row * x + col], dataType)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

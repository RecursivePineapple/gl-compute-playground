import { useRef, useState } from 'react';
import Editor, { BeforeMount, Monaco, OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { useAppDispatch, useAppSelector } from '../../store';
import { entityUpdated } from '../../store/uiSlice';
import { invoke } from '../../ipc/client';
import { ShaderData } from '../../../shared/types';
import { parseBindings, parseUniforms } from '../../../shared/parseShader';

const DEBOUNCE_MS = 500;

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
      'std430', 'std140', 'set', 'local_size_x', 'local_size_y', 'local_size_z'
    ],
    types: [
      'float', 'double', 'int', 'uint', 'bool',
      'vec2', 'vec3', 'vec4', 'dvec2', 'dvec3', 'dvec4',
      'ivec2', 'ivec3', 'ivec4', 'uvec2', 'uvec3', 'uvec4',
      'bvec2', 'bvec3', 'bvec4',
      'mat2', 'mat3', 'mat4',
      'mat2x2', 'mat2x3', 'mat2x4', 'mat3x2', 'mat3x3', 'mat3x4',
      'mat4x2', 'mat4x3', 'mat4x4',
      'sampler2D', 'sampler3D', 'samplerCube', 'sampler2DArray',
      'usampler2D', 'isampler2D', 'image2D', 'uimage2D', 'iimage2D'
    ],
    tokenizer: {
      root: [
        [/#version\b.*$/, 'keyword'],
        [/#\w+/, 'keyword'],
        [/[a-zA-Z_]\w*/, {
          cases: {
            '@keywords': 'keyword',
            '@types': 'type',
            '@default': 'identifier'
          }
        }],
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@block'],
        [/\d+\.\d*([eE][+-]?\d+)?[fF]?/, 'number.float'],
        [/\.\d+([eE][+-]?\d+)?[fF]?/, 'number.float'],
        [/\d+[uU]?/, 'number'],
        [/[{}()\[\]]/, 'delimiter.bracket'],
        [/[;,.]/, 'delimiter']
      ],
      block: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment']
      ]
    }
  });
}

function parseErrorToMarker(
  err: string,
  model: editor.ITextModel,
  monaco: Monaco
): editor.IMarkerData {
  // NVIDIA:    ERROR: 0:LINE: message
  const nv = err.match(/ERROR:\s*\d+:(\d+):\s*(.*)/i);
  if (nv) return marker(parseInt(nv[1], 10), nv[2].trim(), model, monaco);

  // AMD/Mesa:  0:LINE(COL): error: message
  const amd = err.match(/\d+:(\d+)\(\d+\):\s*(?:error:\s*)?(.*)/i);
  if (amd) return marker(parseInt(amd[1], 10), amd[2].trim(), model, monaco);

  // NVIDIA alt: 0(LINE) : error CODE: message
  const nvalt = err.match(/\d+\((\d+)\)\s*:\s*(.*)/);
  if (nvalt) return marker(parseInt(nvalt[1], 10), nvalt[2].trim(), model, monaco);

  return marker(1, err, model, monaco);
}

function marker(
  line: number,
  message: string,
  model: editor.ITextModel,
  monaco: Monaco
): editor.IMarkerData {
  return {
    startLineNumber: line,
    startColumn: 1,
    endLineNumber: line,
    endColumn: model.getLineMaxColumn(line),
    message,
    severity: monaco.MarkerSeverity.Error
  };
}

export default function ShaderEditor({ id }: { id: string }) {
  const dispatch = useAppDispatch();
  const data = useAppSelector(state => state.ui.openEntities[id]) as ShaderData;
  const ref = useAppSelector(state => state.project.entities.find(e => e.id === id));
  const [errors, setErrors] = useState<string[]>([]);

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleBeforeMount: BeforeMount = (monaco) => registerGlsl(monaco);

  const handleMount: OnMount = (ed, monaco) => {
    editorRef.current = ed;
    monacoRef.current = monaco;
  };

  function handleChange(value: string | undefined) {
    const source = value ?? '';

    dispatch(entityUpdated({ id, data: { source } }));

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => saveAndCompile(source), DEBOUNCE_MS);
  }

  async function saveAndCompile(source: string) {
    invoke('entity:save', { filePath: ref!.filePath, data: { source } });

    const result = await invoke<{ errors: string[] }>('shader:compile', { source });
    setErrors(result.errors);

    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco) return;
    const model = ed.getModel();
    if (!model) return;

    monaco.editor.setModelMarkers(
      model,
      'glsl',
      result.errors.map(e => parseErrorToMarker(e, model, monaco))
    );
  }

  const source = data?.source ?? '';
  const bindings = parseBindings(source);
  const uniforms = parseUniforms(source);

  return (
    <div className="shader-editor">
      <div className="editor-header">
        <span className="editor-title">{ref?.name}</span>
      </div>

      <div className="shader-monaco-wrap">
        <Editor
          key={id}
          defaultValue={source}
          language="glsl"
          theme="vs-dark"
          onChange={handleChange}
          onMount={handleMount}
          beforeMount={handleBeforeMount}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 4
          }}
        />
      </div>

      {(bindings.length > 0 || uniforms.length > 0) && (
        <div className="parsed-info-panel">
          {bindings.length > 0 && (
            <div className="parsed-section">
              <span className="parsed-title">Bindings</span>
              {bindings.map(b => (
                <div key={b.index} className="parsed-row">
                  <span className="parsed-index">[{b.index}]</span>
                  <span className={`parsed-dir ${b.direction}`}>
                    {b.direction === 'read' ? 'readonly' : 'writeonly'}
                  </span>
                  <span>{b.name}</span>
                </div>
              ))}
            </div>
          )}
          {uniforms.length > 0 && (
            <div className="parsed-section">
              <span className="parsed-title">Uniforms</span>
              {uniforms.map(u => (
                <div key={u.name} className="parsed-row">
                  <span className="parsed-type">{u.glslType}</span>
                  <span>{u.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {errors.length > 0 && (
        <div className="compile-error-panel">
          {errors.map((err, i) => (
            <div key={i} className="compile-error">● {err}</div>
          ))}
        </div>
      )}
    </div>
  );
}

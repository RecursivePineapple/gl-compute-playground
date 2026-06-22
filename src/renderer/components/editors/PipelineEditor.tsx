import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  Panel,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
  type IsValidConnection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useAppDispatch, useAppSelector } from '../../store';
import { entityUpdated, entityLoaded, executionStarted, executionCompleted } from '../../store/uiSlice';
import { invoke } from '../../ipc/client';
import { PipelineData, PipelineNode as PipelineNodeDatum, ShaderData } from '../../../shared/types';
import { parseBindings, parseUniforms } from '../../../shared/parseShader';

type BufferNodeData = { bufferId: string; label: string };

type ShaderNodeData = {
  shaderId: string;
  label: string;
  dispatch: { x: number; y: number; z: number };
  uniforms: Record<string, number>;
  onDispatchChange: (axis: 'x' | 'y' | 'z', value: number) => void;
  onUniformChange: (name: string, value: number) => void;
};

// ---- custom node components ----

function BufferNodeComponent({ data }: { data: BufferNodeData }) {
  return (
    <div className="pipeline-node buffer-node">
      <Handle type="target" position={Position.Left} id="input" />
      <div className="pipeline-node-title">
        <span className="pipeline-node-icon">●</span>
        {data.label}
      </div>
      <Handle type="source" position={Position.Right} id="output" />
    </div>
  );
}

function ShaderNodeComponent({ data }: { data: ShaderNodeData }) {
  const shaderData = useAppSelector(
    state => state.ui.openEntities[data.shaderId]
  ) as ShaderData | undefined;

  if (!shaderData) {
    return (
      <div className="pipeline-node shader-node">
        <div className="pipeline-node-title">
          <span className="pipeline-node-icon">▣</span>
          {data.label}
        </div>
        <div className="pipeline-node-loading">Loading…</div>
      </div>
    );
  }

  const bindings = parseBindings(shaderData.source);
  const uniforms = parseUniforms(shaderData.source);

  return (
    <div className="pipeline-node shader-node">
      <div className="pipeline-node-title">
        <span className="pipeline-node-icon">▣</span>
        {data.label}
      </div>

      {bindings.map(b => (
        <div key={b.index} className={`pipeline-binding ${b.direction}`}>
          {b.direction === 'read' && (
            <Handle type="target" position={Position.Left} id={`binding-${b.index}`} />
          )}
          <span className="binding-index">[b{b.index}]</span>
          <span className="binding-name">{b.name}</span>
          <span className="binding-dir">({b.direction === 'read' ? 'readonly' : 'writeonly'})</span>
          {b.direction === 'write' && (
            <Handle type="source" position={Position.Right} id={`binding-${b.index}`} />
          )}
        </div>
      ))}

      <div className="pipeline-dispatch">
        {(['x', 'y', 'z'] as const).map(axis => (
          <label key={axis} className="dispatch-input">
            <span>{axis.toUpperCase()}</span>
            <input
              type="number"
              min={1}
              value={data.dispatch[axis]}
              onChange={e => data.onDispatchChange(axis, Math.max(1, parseInt(e.target.value) || 1))}
              className="nodrag"
            />
          </label>
        ))}
      </div>

      {uniforms.map(u => (
        <div key={u.name} className="pipeline-uniform">
          <span className="uniform-type">{u.glslType}</span>
          <span className="uniform-name">{u.name}</span>
          <input
            type="number"
            value={data.uniforms[u.name] ?? 0}
            onChange={e => data.onUniformChange(u.name, parseFloat(e.target.value) || 0)}
            className="nodrag"
          />
        </div>
      ))}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NODE_TYPES = { buffer: BufferNodeComponent as any, shader: ShaderNodeComponent as any };

// ---- helpers ----

function toPipelineData(rfNodes: Node[], rfEdges: Edge[]): PipelineData {
  const nodes: PipelineNodeDatum[] = rfNodes.map(n => {
    if (n.type === 'buffer') {
      const d = n.data as unknown as BufferNodeData;
      return { id: n.id, type: 'buffer', bufferId: d.bufferId, position: n.position };
    }
    const d = n.data as unknown as ShaderNodeData;
    return { id: n.id, type: 'shader', shaderId: d.shaderId, position: n.position, dispatch: d.dispatch, uniforms: d.uniforms };
  });
  return {
    nodes,
    edges: rfEdges.map(e => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? '',
      target: e.target,
      targetHandle: e.targetHandle ?? '',
    })),
  };
}

function buildRFNode(
  pn: PipelineNodeDatum,
  entities: { id: string; name: string }[],
  onDispatch: (nodeId: string, axis: 'x' | 'y' | 'z', value: number) => void,
  onUniform: (nodeId: string, name: string, value: number) => void
): Node {
  if (pn.type === 'buffer') {
    const label = entities.find(e => e.id === pn.bufferId)?.name ?? pn.bufferId;
    return { id: pn.id, type: 'buffer', position: pn.position, data: { bufferId: pn.bufferId, label } as unknown as Record<string, unknown> };
  }
  const label = entities.find(e => e.id === pn.shaderId)?.name ?? pn.shaderId;
  return {
    id: pn.id, type: 'shader', position: pn.position,
    data: {
      shaderId: pn.shaderId, label,
      dispatch: pn.dispatch, uniforms: pn.uniforms,
      onDispatchChange: (axis: 'x' | 'y' | 'z', value: number) => onDispatch(pn.id, axis, value),
      onUniformChange: (name: string, value: number) => onUniform(pn.id, name, value),
    } as unknown as Record<string, unknown>,
  };
}

// ---- main component ----

export default function PipelineEditor({ id }: { id: string }) {
  const dispatch = useAppDispatch();
  const data = useAppSelector(state => state.ui.openEntities[id]) as PipelineData;
  const ref = useAppSelector(state => state.project.entities.find(e => e.id === id));
  const entities = useAppSelector(state => state.project.entities);
  const openEntities = useAppSelector(state => state.ui.openEntities);

  const [executing, setExecuting] = useState(false);
  const [execErrors, setExecErrors] = useState<string[]>([]);
  const [addingType, setAddingType] = useState<'buffer' | 'shader' | null>(null);

  // Mutable refs so stable callbacks always have latest state
  const nodesRef = useRef<Node[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const saveRef = useRef<(n: Node[], e: Edge[]) => void>(() => {});
  const cbRef = useRef({
    onDispatch: (_id: string, _a: 'x' | 'y' | 'z', _v: number) => {},
    onUniform: (_id: string, _n: string, _v: number) => {},
  });
  const hasMounted = useRef(false);
  const nodeCounter = useRef(0);

  // Update saveRef every render so callbacks have fresh dispatch/ref
  saveRef.current = (rfNodes, rfEdges) => {
    const pd = toPipelineData(rfNodes, rfEdges);
    dispatch(entityUpdated({ id, data: pd }));
    if (ref) invoke('entity:save', { filePath: ref.filePath, data: pd });
  };

  // Initialize RF nodes/edges from pipeline data once
  const [nodes, setNodes] = useState<Node[]>(() =>
    data.nodes.map(n => buildRFNode(
      n, entities,
      (nodeId, axis, value) => cbRef.current.onDispatch(nodeId, axis, value),
      (nodeId, name, value) => cbRef.current.onUniform(nodeId, name, value),
    ))
  );
  const [edges, setEdges] = useState<Edge[]>(() => data.edges);

  // Keep refs in sync (before any effects run this render)
  nodesRef.current = nodes;
  edgesRef.current = edges;

  // Update cbRef with current implementations that close over setNodes/refs
  cbRef.current = {
    onDispatch(nodeId, axis, value) {
      setNodes(prev => {
        const next = prev.map(n => {
          if (n.id !== nodeId) return n;
          const d = n.data as unknown as ShaderNodeData;
          return { ...n, data: { ...d, dispatch: { ...d.dispatch, [axis]: value } } };
        });
        nodesRef.current = next;
        saveRef.current(next, edgesRef.current);
        return next;
      });
    },
    onUniform(nodeId, name, value) {
      setNodes(prev => {
        const next = prev.map(n => {
          if (n.id !== nodeId) return n;
          const d = n.data as unknown as ShaderNodeData;
          return { ...n, data: { ...d, uniforms: { ...d.uniforms, [name]: value } } };
        });
        nodesRef.current = next;
        saveRef.current(next, edgesRef.current);
        return next;
      });
    },
  };

  // Load shader entities referenced in pipeline that aren't in Redux store
  useEffect(() => {
    for (const pn of data.nodes) {
      if (pn.type !== 'shader' || openEntities[pn.shaderId]) continue;
      const entityRef = entities.find(e => e.id === pn.shaderId);
      if (!entityRef) continue;
      invoke<ShaderData>('entity:load', { filePath: entityRef.filePath }).then(loaded => {
        dispatch(entityLoaded({ id: pn.shaderId, data: loaded }));
      });
    }
  }, []);

  // Remove edges whose binding handles no longer exist in the parsed shader source
  useEffect(() => {
    if (!hasMounted.current) { hasMounted.current = true; return; }

    setEdges(prev => {
      const filtered = prev.filter(edge => {
        const src = nodesRef.current.find(n => n.id === edge.source);
        const tgt = nodesRef.current.find(n => n.id === edge.target);

        if (src?.type === 'shader' && edge.sourceHandle.startsWith('binding-')) {
          const sd = openEntities[(src.data as unknown as ShaderNodeData).shaderId] as ShaderData | undefined;
          if (!sd) return true;
          const idx = parseInt(edge.sourceHandle.replace('binding-', ''), 10);
          return parseBindings(sd.source).some(b => b.index === idx && b.direction === 'write');
        }
        if (tgt?.type === 'shader' && edge.targetHandle.startsWith('binding-')) {
          const sd = openEntities[(tgt.data as unknown as ShaderNodeData).shaderId] as ShaderData | undefined;
          if (!sd) return true;
          const idx = parseInt(edge.targetHandle.replace('binding-', ''), 10);
          return parseBindings(sd.source).some(b => b.index === idx && b.direction === 'read');
        }
        return true;
      });

      if (filtered.length !== prev.length) {
        edgesRef.current = filtered;
        saveRef.current(nodesRef.current, filtered);
      }
      return filtered;
    });
  }, [openEntities]);

  // ---- RF event handlers ----

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes(prev => {
      const next = applyNodeChanges(changes, prev);
      nodesRef.current = next;
      if (changes.some(c => c.type !== 'select')) saveRef.current(next, edgesRef.current);
      return next;
    });
  }, []);

  const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges(prev => {
      const next = applyEdgeChanges(changes, prev);
      edgesRef.current = next;
      saveRef.current(nodesRef.current, next);
      return next;
    });
  }, []);

  const handleConnect = useCallback((connection: Connection) => {
    const edge: Edge = {
      id: `e-${Date.now()}`,
      source: connection.source,
      sourceHandle: connection.sourceHandle ?? '',
      target: connection.target,
      targetHandle: connection.targetHandle ?? '',
    };
    setEdges(prev => {
      const next = [...prev, edge];
      edgesRef.current = next;
      saveRef.current(nodesRef.current, next);
      return next;
    });
  }, []);

  const isValidConnection: IsValidConnection = useCallback((connection) => {
    const { source, sourceHandle, target, targetHandle } = connection as Connection;
    const rfNodes = nodesRef.current;
    const rfEdges = edgesRef.current;
    const src = rfNodes.find(n => n.id === source);
    const tgt = rfNodes.find(n => n.id === target);

    // Buffer output → shader readonly binding
    if (src?.type === 'buffer' && sourceHandle === 'output' && tgt?.type === 'shader' && targetHandle?.startsWith('binding-')) {
      const sd = openEntities[(tgt.data as unknown as ShaderNodeData).shaderId] as ShaderData | undefined;
      if (!sd) return false;
      const idx = parseInt(targetHandle.replace('binding-', ''), 10);
      return parseBindings(sd.source).some(b => b.index === idx && b.direction === 'read');
    }

    // Shader writeonly binding → buffer input (write-once)
    if (src?.type === 'shader' && sourceHandle?.startsWith('binding-') && tgt?.type === 'buffer' && targetHandle === 'input') {
      const sd = openEntities[(src.data as unknown as ShaderNodeData).shaderId] as ShaderData | undefined;
      if (!sd) return false;
      const idx = parseInt(sourceHandle.replace('binding-', ''), 10);
      if (!parseBindings(sd.source).some(b => b.index === idx && b.direction === 'write')) return false;
      return !rfEdges.some(e => e.target === target && e.targetHandle === 'input');
    }

    return false;
  }, [openEntities]);

  // ---- add node ----

  function addNode(entityId: string, type: 'buffer' | 'shader') {
    const entityRef = entities.find(e => e.id === entityId);
    if (!entityRef) return;

    const nodeId = `${type}-${Date.now()}-${nodeCounter.current++}`;
    const offset = nodesRef.current.length;
    const position = { x: 150 + offset * 25, y: 80 + offset * 20 };

    let newNode: Node;
    if (type === 'buffer') {
      newNode = {
        id: nodeId, type: 'buffer', position,
        data: { bufferId: entityId, label: entityRef.name } as unknown as Record<string, unknown>,
      };
    } else {
      newNode = {
        id: nodeId, type: 'shader', position,
        data: {
          shaderId: entityId, label: entityRef.name,
          dispatch: { x: 1, y: 1, z: 1 }, uniforms: {},
          onDispatchChange: (axis: 'x' | 'y' | 'z', value: number) => cbRef.current.onDispatch(nodeId, axis, value),
          onUniformChange: (name: string, value: number) => cbRef.current.onUniform(nodeId, name, value),
        } as unknown as Record<string, unknown>,
      };
      if (!openEntities[entityId]) {
        invoke<ShaderData>('entity:load', { filePath: entityRef.filePath }).then(loaded => {
          dispatch(entityLoaded({ id: entityId, data: loaded }));
        });
      }
    }

    setNodes(prev => {
      const next = [...prev, newNode];
      nodesRef.current = next;
      saveRef.current(next, edgesRef.current);
      return next;
    });
    setAddingType(null);
  }

  // ---- execute ----

  async function execute() {
    setExecuting(true);
    setExecErrors([]);
    dispatch(executionStarted());
    try {
      const result = await invoke<{ bufferResults: Record<string, number[]>; errors: string[] }>(
        'pipeline:execute',
        { pipeline: toPipelineData(nodesRef.current, edgesRef.current) }
      );
      if (result.errors?.length) setExecErrors(result.errors);
      dispatch(executionCompleted(result.bufferResults ?? {}));
    } finally {
      setExecuting(false);
    }
  }

  const bufferEntities = entities.filter(e => e.type === 'buffer');
  const shaderEntities = entities.filter(e => e.type === 'shader');

  return (
    <div className="pipeline-editor">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        isValidConnection={isValidConnection}
        fitView
      >
        <Background />
        <Controls />

        <Panel position="top-left" className="pipeline-toolbar">
          <div className="toolbar-btn-group">
            <button onClick={() => setAddingType(prev => prev === 'buffer' ? null : 'buffer')}>
              + Buffer
            </button>
            {addingType === 'buffer' && (
              <div className="node-picker">
                {bufferEntities.length === 0
                  ? <span className="picker-empty">No buffers</span>
                  : bufferEntities.map(e => (
                      <button key={e.id} onClick={() => addNode(e.id, 'buffer')}>{e.name}</button>
                    ))
                }
              </div>
            )}
          </div>

          <div className="toolbar-btn-group">
            <button onClick={() => setAddingType(prev => prev === 'shader' ? null : 'shader')}>
              + Shader
            </button>
            {addingType === 'shader' && (
              <div className="node-picker">
                {shaderEntities.length === 0
                  ? <span className="picker-empty">No shaders</span>
                  : shaderEntities.map(e => (
                      <button key={e.id} onClick={() => addNode(e.id, 'shader')}>{e.name}</button>
                    ))
                }
              </div>
            )}
          </div>
        </Panel>

        <Panel position="bottom-right" className="execute-overlay">
          <button onClick={execute} disabled={executing} className="execute-btn">
            {executing ? 'Running…' : 'Execute'}
          </button>
          {execErrors.map((err, i) => (
            <div key={i} className="exec-error">● {err}</div>
          ))}
        </Panel>
      </ReactFlow>
    </div>
  );
}

export type EntityType = 'buffer' | 'shader' | 'pipeline' | 'visualizer';
export type DataType = 'f32' | 'f64' | 'i32' | 'i64' | 'u32' | 'u64';

export interface EntityRef {
  id: string;
  name: string;
  type: EntityType;
  filePath: string;
}

export interface BufferData {
  dataType: DataType;
  dimensions: { x: number; y: number; z: number };
  predefinedData: PredefinedData | null;
}

export type PredefinedData =
  | { source: 'binary'; path: string }
  | { source: 'csv'; path: string }
  | { source: 'inline'; data: number[] };

export interface ShaderData {
  source: string;
}

export interface PipelineData {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}

export type PipelineNode = BufferNode | ShaderNode;

export interface BufferNode {
  id: string;
  type: 'buffer';
  bufferId: string;
  position: { x: number; y: number };
}

export interface ShaderNode {
  id: string;
  type: 'shader';
  shaderId: string;
  position: { x: number; y: number };
  dispatch: { x: number; y: number; z: number };
  uniforms: Record<string, number>;
}

export interface PipelineEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export interface VisualizerData {
  script: string;
  vertexShader: string;
  fragmentShader: string;
}

export type EntityData = BufferData | ShaderData | PipelineData | VisualizerData;

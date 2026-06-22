import { readdirSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, basename, extname } from 'path';
import { EntityRef, EntityType, VisualizerData } from '../../shared/types';

const DEFAULT_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec2 aUV;
layout(location = 2) in vec3 aNormal;
layout(location = 3) in vec4 aColor;
uniform mat4 uView;
uniform mat4 uProjection;
out vec4 vColor;
void main() {
  gl_Position = uProjection * uView * vec4(aPosition, 1.0);
  vColor = aColor;
}`;

const DEFAULT_FRAG = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 fragColor;
void main() { fragColor = vColor; }`;

const DEFAULT_SCRIPT =
  `function(tessellator, buffers) {\n` +
  `  tessellator.push([ 0.0,  0.5, 0.0], [0.5, 1.0], [0, 0, 1], [1, 0, 0, 1]);\n` +
  `  tessellator.push([-0.5, -0.5, 0.0], [0.0, 0.0], [0, 0, 1], [0, 1, 0, 1]);\n` +
  `  tessellator.push([ 0.5, -0.5, 0.0], [1.0, 0.0], [0, 0, 1], [0, 0, 1, 1]);\n` +
  `}`;

const ENTITY_DIRS: Array<{ type: EntityType; subdir: string }> = [
  { type: 'buffer',     subdir: 'buffers' },
  { type: 'shader',     subdir: 'shaders' },
  { type: 'pipeline',   subdir: 'pipelines' },
  { type: 'visualizer', subdir: 'visualizers' }
];

export function scanProject(projectPath: string): EntityRef[] {
  const refs: EntityRef[] = [];

  for (const { type, subdir } of ENTITY_DIRS) {
    const dir = join(projectPath, subdir);
    if (!existsSync(dir)) continue;

    for (const file of readdirSync(dir)) {
      if (extname(file) !== '.json') continue;
      const name = basename(file, '.json');
      refs.push({
        id: `${subdir}/${name}`,
        name,
        type,
        filePath: join(dir, file)
      });
    }
  }

  return refs;
}

const DEFAULT_CONTENT: Record<string, object> = {
  buffer:     { dataType: 'f32', dimensions: { x: 1, y: 1, z: 1 }, predefinedData: null },
  shader:     { source: '' },
  pipeline:   { nodes: [], edges: [] },
  visualizer: { script: DEFAULT_SCRIPT, vertexShader: DEFAULT_VERT, fragmentShader: DEFAULT_FRAG } as VisualizerData
};

/** Creates a new entity file and returns its EntityRef. Throws if name already exists. */
export function createEntity(projectPath: string, type: EntityType, name: string): EntityRef {
  const entry = ENTITY_DIRS.find(e => e.type === type)!;
  const dir = join(projectPath, entry.subdir);
  mkdirSync(dir, { recursive: true });

  const filePath = join(dir, `${name}.json`);
  if (existsSync(filePath)) throw new Error(`'${name}' already exists.`);

  writeFileSync(filePath, JSON.stringify(DEFAULT_CONTENT[type], null, 2), 'utf-8');
  return { id: `${entry.subdir}/${name}`, name, type, filePath };
}

export function saveEntity(filePath: string, data: object): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export function loadEntity(filePath: string): object {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

export interface BindingInfo {
  index: number;
  name: string;
  direction: 'read' | 'write';
}

export interface UniformInfo {
  name: string;
  glslType: string;
}

/** Parses `layout(...binding=N...) readonly|writeonly buffer Name` declarations. */
export function parseBindings(source: string): BindingInfo[] {
  const results: BindingInfo[] = [];
  const re = /layout\s*\([^)]*binding\s*=\s*(\d+)[^)]*\)\s*(readonly|writeonly)\s+buffer\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    results.push({
      index: parseInt(m[1], 10),
      direction: m[2] === 'readonly' ? 'read' : 'write',
      name: m[3]
    });
  }
  return results;
}

/** Parses `uniform <type> <name>;` declarations. */
export function parseUniforms(source: string): UniformInfo[] {
  const results: UniformInfo[] = [];
  const re = /uniform\s+(\w+)\s+(\w+)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    results.push({ glslType: m[1], name: m[2] });
  }
  return results;
}
